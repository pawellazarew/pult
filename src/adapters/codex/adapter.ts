// Адаптер Codex: ОДИН процесс `codex app-server` на все сессии, треды, разрешения, resume.
//
// ЧЕМ ОН УСТРОЕН ИНАЧЕ, ЧЕМ АДАПТЕР CLAUDE. У Claude процесс — на сессию (и даже на ход);
// у Codex процесс один на всех, а сессии внутри него — треды (`threadId`). Отсюда три правила,
// каждое оплачено измерением спайка (DELTA v0.4 §2, 20.09.2026):
//   1. КАЖДОЕ уведомление разбирается по `threadId`. Наивное «жду turn/completed» ломает
//      второй параллельный ход — в спайке это стоило двух сожжённых ходов. Уведомление с
//      незнакомым `threadId` логируется ОДИН раз и выбрасывается, не роняя ничего.
//   2. Текст хода собирается из `item/completed` (`agentMessage`), а НЕ из `turn/completed`:
//      там `itemsView` бывает `notLoaded` с пустым `items`.
//   3. Стоп одной сессии НЕ гасит общий процесс: ход снимается методом `turn/interrupt`.
//      Процесс гасит только `shutdown()`.
// Отсюда же следует, что `mode: 'warm'` у Codex ничего не значит и жнеца тут нет: процесс и так
// один на всех и живёт между ходами. Поле в записи сессии сохраняется (оно общее для
// провайдеров), но на поведение не влияет.
//
// ТРЕД ВОЗОБНОВЛЯЕМ НЕ СРАЗУ. ИЗМЕРЕНО пробой В3 21.09.2026: после `thread/start` файла
// `~/.codex/sessions/.../rollout-*.jsonl` НЕТ (проверено сразу, через 2 с и после выхода
// процесса), и свежий app-server отвечает на `thread/resume`
// `-32600 no rollout found for thread id <id>`. Поэтому `providerSessionId` уезжает в реестр
// не по `thread/start`, а по первому `turn/started` — ровно как у Claude по `system/init`.
// На случай, когда запись всё-таки не случилась, есть самолечение: ту же строку ошибки
// адаптер ловит и заводит новый тред ПРЯМО В ЭТОМ ЖЕ ХОДЕ. Здесь это бесплатно (в отличие от
// Claude): неудачный `thread/resume` не тратит ни токена, а реплика ещё не отправлена.
//
// ЧТО ЗАПРЕЩЕНО ЗДЕСЬ И ПОЧЕМУ:
//   * ход без проверки страны выхода — перед первым ходом сессии и после простоя > 60 с
//     (инвариант 2);
//   * `account/rateLimitResetCredit/consume` — НИКОГДА, даже за флагом: сброс лимита за кредит
//     это решение человека и деньги, у Пульта такой кнопки нет;
//   * попытка «разрешить» то, чего сервер не предлагал: решение выбирается ТОЛЬКО из того, что
//     метод предлагает по своей схеме (`availableDecisions` там, где схема это поле объявляет,
//     иначе — словарь решений самого метода), а при отсутствии подходящего берётся самое
//     строгое (инвариант 5). «В этой сессии» (`acceptForSession`) и «всегда» (поправка execpolicy или
//     правило сети) — M8d, решение владельца 19.10.2026: ТОЛЬКО по явной кнопке человека и только когда
//     сервер их на этот запрос предложил; ⌘Enter и голое `perm approve` — всегда один раз.

import { createImageCapture } from '../../core/images.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PultConfig } from '../../core/config.js'
import type { EventDraft } from '../../core/events.js'
import { DAEMON_SESSION } from '../../core/events.js'
import type { Logger } from '../../core/log.js'
import { redact, redactString } from '../../core/log.js'
import type { PultPaths } from '../../core/paths.js'
import { VERSION } from '../../core/version.js'
import { buildChildEnv } from '../../env/allowlist.js'
import { checkNetwork, netGeneration, netRefusal, noProxyValue } from '../../env/net.js'
import type { NetCheck } from '../../env/net.js'
import { readSavedNode, resolveChildNode } from '../../env/nodeBin.js'
import { BROWSER_SERVER_NAME, DENIED_BROWSER_TOOLS } from '../../mcp/browser.js'
import type { SessionRecord } from '../../sessions/registry.js'
import type {
  AdapterDeps, ApprovalMode, PermissionDecision, PermissionOffers, PermissionScope, ProviderAdapter, SessionSpec, StartedSession, TurnOutcome, TurnSettings, TurnStarted,
} from '../types.js'
import { createAppServerClient } from './client.js'
import type { AppServerClient, JsonRpcId } from './client.js'
import { createCodexMapper, NO_ROLLOUT_RE } from './mapper.js'
import type { CodexMapper, CodexSignal } from './mapper.js'
import { checkCodexSchema } from './schema.js'
import type { CodexSchemaCheck } from './schema.js'

/** Простой дольше этого — страж страны выхода проверяется заново (инвариант 2). */
export const IDLE_RECHECK_MS = 60_000
/** Столько подряд `error` с `willRetry: true` терпим, дальше ход снимаем (как у Claude). */
export const RETRY_CEILING = 3
/** Окно и потолок перезапусков app-server: чаще — провайдер останавливается целиком. */
export const RESTART_WINDOW_MS = 60_000
export const RESTART_CEILING = 3
/** Пауза перед перезапуском: растёт с каждым падением в окне. */
export const RESTART_BACKOFF_MS = 500
/** Сколько ждём `turn/completed` после `turn/interrupt`, прежде чем закрыть ход сами. */
export const INTERRUPT_SETTLE_MS = 5_000
/** Лестница гашения общего процесса в `shutdown()`. */
export const TERM_WAIT_MS = 3_000
export const KILL_WAIT_MS = 3_000

/**
 * Песочница тредов. `workspace-write` + `on-request`: агент работает в своей папке, а всё, что
 * шире, спрашивает через Inbox. Флага CLI на это в В3 нет намеренно — сначала должен появиться
 * человек, который его попросит.
 */
/**
 * Профиль сети ребёнка. Прямой путь не ставит НИ ОДНОЙ переменной.
 * `ALL_PROXY` — потому что Codex ходит к модели по WebSocket
 * (`wss://chatgpt.com/backend-api/codex/responses`), а его умеет `socks5h`, не HTTP-прокси.
 * `HTTPS_PROXY` рядом не лишний: ИЗМЕРЕНО спайком S5 — при обрыве WebSocket сервер сам
 * откатывается на HTTPS-транспорт («Falling back from WebSockets to HTTPS transport»).
 * Тот же профиль у служебных запросов демона (`model/list`, `thread/list`, `thread/fork`).
 */
export function codexNetworkEnv(check: NetCheck): Record<string, string> {
  return check.path === 'proxy' && check.proxy
    ? { ALL_PROXY: check.proxy, HTTPS_PROXY: check.proxy, NO_PROXY: noProxyValue(check.noProxy) }
    : {}
}

/** Песочница режима `ask` — та, с которой жили все треды до M8d. */
export const THREAD_SANDBOX = 'workspace-write'

/**
 * M8d: режим подтверждений сессии → песочница и политика треда (`thread/start` и `thread/resume`).
 *   read-only → `read-only` + `on-request` · ask → `workspace-write` + `on-request` (как до M8d)
 *   workspace → `workspace-write` + `never` · full → `danger-full-access` + `never`
 * Без брокера спросить некого: политика `never` при любом режиме (инвариант 5 — сессия без хозяина
 * разрешений выйти за песочницу не может, а то, что спросило бы, получает отказ).
 *
 * В `turn/start` НЕ повторяется: по схеме (0.163) поля хода — «override for this turn and subsequent turns»,
 * то есть переопределение, а не обязательный повтор; тред помнит своё, а resume каждый раз несёт их заново.
 */
/**
 * M8f: песочница треда (`SandboxMode` строкой, как в `thread/start`) → `SandboxPolicy` объектом для `turn/start`
 * (схема 0.163: `sandboxPolicy` хода — объект с `type`). Сетевой доступ и доп. корни записи — по умолчанию схемы
 * (`networkAccess: false`, `writableRoots: []`): настройки `sandbox_workspace_write` из config.toml владельца
 * перебиваются до перезапуска демона — тогда тред возобновится с режимом строкой и возьмёт их снова.
 */
export function codexSandboxPolicy(sandbox: string): Record<string, unknown> {
  return { type: sandboxType(sandbox) }
}

/** `SandboxMode` строкой → `type` объекта `SandboxPolicy`. */
export function sandboxType(sandbox: string): string {
  return sandbox === 'read-only' ? 'readOnly' : sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite'
}

/**
 * M8f (ревью, MED 5): `sandbox_workspace_write` из `config/read` (снейк-кейс config.toml) → объект `workspaceWrite`
 * хода (кэмел-кейс схемы 0.163). Поля, которых в конфиге нет, не пишутся — сервер возьмёт свои умолчания.
 */
export function workspaceWriteFromConfig(cfg: Record<string, unknown> | null): Record<string, unknown> {
  const w = cfg ? obj(cfg['sandbox_workspace_write']) : null
  if (!w) return { type: 'workspaceWrite' }
  return {
    type: 'workspaceWrite',
    ...(Array.isArray(w['writable_roots']) ? { writableRoots: (w['writable_roots'] as unknown[]).filter((x) => typeof x === 'string') } : {}),
    ...(typeof w['network_access'] === 'boolean' ? { networkAccess: w['network_access'] } : {}),
    ...(typeof w['exclude_slash_tmp'] === 'boolean' ? { excludeSlashTmp: w['exclude_slash_tmp'] } : {}),
    ...(typeof w['exclude_tmpdir_env_var'] === 'boolean' ? { excludeTmpdirEnvVar: w['exclude_tmpdir_env_var'] } : {}),
  }
}

export function codexThreadPolicy(approval: ApprovalMode | undefined, broker: boolean): { sandbox: string; approvalPolicy: 'on-request' | 'never' } {
  const mode = approval ?? 'ask'
  const sandbox = mode === 'read-only' ? 'read-only' : mode === 'full' ? 'danger-full-access' : THREAD_SANDBOX
  const asks = broker && (mode === 'read-only' || mode === 'ask')
  return { sandbox, approvalPolicy: asks ? 'on-request' : 'never' }
}

/**
 * Что на самом деле делает «всегда» у Codex — карточка Inbox говорит это словами (ревью M8d, живой codex 0.163):
 * поправка execpolicy — это правило-ПРЕФИКС (команда с любыми аргументами дальше идёт без песочницы и без вопроса),
 * и оно, как и правило сети, пишется в `$CODEX_HOME/rules/default.rules` — во все сессии Codex, Пульт его не снимет.
 */
export const CODEX_EXEC_RULE_NOTE = '(с любыми аргументами дальше) — без песочницы и без вопроса во всех сессиях Codex; правило в ~/.codex/rules/default.rules'
export const CODEX_NET_RULE_NOTE = '— без вопроса во всех сессиях Codex; правило в ~/.codex/rules/default.rules'

/** Префикс команды строкой для карточки: слова с пробелами и спецзнаками — в одинарных кавычках, как в sh. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

/**
 * M8d: что сервер предложил на ЭТОТ запрос сверх «один раз», и готовый ответ для «всегда».
 *   * session — строка «на сессию» метода (`acceptForSession`; у старых — `approved_for_session`) есть среди
 *     предложенного (`offeredDecisions`: `availableDecisions` там, где схема его объявляет, иначе словарь схемы);
 *   * rule — только у команды. Ответ — ОБЪЕКТ из `availableDecisions` как есть (ревью M8d: не собираем заново из
 *     `proposed*` — уходит ровно то, что сервер предложил):
 *       – `acceptWithExecpolicyAmendment`, чей `execpolicy_amendment` совпадает с `proposedExecpolicyAmendment`
 *         запроса (не совпал или предложения нет — кнопки нет: человек увидел бы одно, а записалось бы другое);
 *       – иначе `applyNetworkPolicyAmendment` с `action: "allow"`, и такой же хост в `proposedNetworkPolicyAmendments`.
 *     Ничего не предложено — кнопки нет (правило Пульт не выдумывает).
 */
export function codexScopedOffers(
  method: string,
  params: Record<string, unknown>,
  offered: readonly string[],
): { offers: PermissionOffers; rule: Record<string, unknown> | null } {
  const offers: PermissionOffers = {}
  const session = APPROVAL_VOCAB[method]?.session
  if (session && offered.includes(session)) offers.session = true
  if (method !== 'item/commandExecution/requestApproval') return { offers, rule: null }
  const avail = Array.isArray(params['availableDecisions']) ? params['availableDecisions'] as unknown[] : []
  const objects = avail.map((d) => obj(d)).filter((d): d is Record<string, unknown> => d !== null)
  const strings = (x: unknown): string[] | null =>
    Array.isArray(x) && x.length > 0 && x.every((v) => typeof v === 'string' && v.length > 0) ? x as string[] : null
  const proposal = strings(params['proposedExecpolicyAmendment'])
  if (proposal) {
    const hit = objects.find((d) => {
      const got = strings(obj(d['acceptWithExecpolicyAmendment'])?.['execpolicy_amendment'])
      return got !== null && got.length === proposal.length && got.every((v, i) => v === proposal[i])
    })
    if (hit) {
      offers.rule = { kind: 'execpolicy', label: shellJoin(proposal), note: CODEX_EXEC_RULE_NOTE }
      return { offers, rule: hit }
    }
  }
  const proposedHosts = new Set((Array.isArray(params['proposedNetworkPolicyAmendments']) ? params['proposedNetworkPolicyAmendments'] as unknown[] : [])
    .map((n) => obj(n)).filter((n) => n !== null && n['action'] === 'allow' && typeof n['host'] === 'string').map((n) => (n as Record<string, unknown>)['host']))
  const net = objects.find((d) => {
    const a = obj(obj(d['applyNetworkPolicyAmendment'])?.['network_policy_amendment'])
    return a !== null && a['action'] === 'allow' && typeof a['host'] === 'string' && a['host'] !== '' && proposedHosts.has(a['host'])
  })
  if (net) {
    const host = obj(obj(net['applyNetworkPolicyAmendment'])?.['network_policy_amendment'])?.['host'] as string
    offers.rule = { kind: 'network', label: host, note: CODEX_NET_RULE_NOTE }
    return { offers, rule: net }
  }
  return { offers, rule: null }
}

/**
 * Шум, который мы гасим на уровне соединения. ИЗМЕРЕНО пробой В3 21.09.2026:
 * `capabilities.optOutNotificationMethods` РАБОТАЕТ — после `thread/start` осталось ровно
 * `thread/started x1` вместо 7–9 `mcpServer/startupStatus/updated` плюс `hook/*`,
 * `remoteControl/status/changed` и `account/updated`.
 */
export const MUTED_NOTIFICATIONS: readonly string[] = [
  'mcpServer/startupStatus/updated',
  'hook/started',
  'hook/completed',
  'remoteControl/status/changed',
  'account/updated',
  'thread/status/changed',
]

/**
 * Словарь решений на запрос разрешения: что считается «да», «да на сессию» и «нет» у каждого метода.
 * Значения взяты из СХЕМЫ протокола (`CommandExecutionApprovalDecision`,
 * `FileChangeApprovalDecision`, `ReviewDecision`), а не из `availableDecisions`: последний —
 * подсказка для рисования кнопок, и он неполон. ИЗМЕРЕНО спайком B2: сервер предложил
 * `["accept", {acceptWithExecpolicyAmendment…}, "cancel"]`, а принял `decline`, которого в
 * списке не было.
 *
 * Объектные варианты (`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`) сюда НЕ
 * входят: они шире одного действия — правят политику на будущее, и собираются отдельно
 * (`codexScopedOffers`) только по кнопке «Всегда …». `session` — строка «на сессию» метода; до M8d она не
 * выбиралась никогда (инвариант 5 Ф1), теперь — только по явной кнопке «В этой сессии» (решение 19.10.2026).
 *
 * `offersDecisions` — ЕСТЬ ЛИ у метода поле `availableDecisions` В СХЕМЕ ЕГО ПАРАМЕТРОВ, и это
 * не мелочь, а правка по разбору В3. Поле объявлено ровно у одного метода —
 * `CommandExecutionRequestApprovalParams`; у `FileChangeRequestApprovalParams` его НЕТ вовсе
 * (её поля: `grantRoot`, `itemId`, `reason`, `startedAtMs`, `threadId`, `turnId`), как нет и у
 * старых `ApplyPatchApprovalParams` / `ExecCommandApprovalParams`. Пока «предложенным»
 * считался только `params.availableDecisions`, у правки файла список выходил ПУСТЫМ, «да»
 * человека понижалось до `decline` — и файл через Пульт нельзя было разрешить НИКОГДА,
 * при том что `FileChangeApprovalDecision` это `accept | acceptForSession | decline | cancel`.
 * Наблюдаемо: `pult perm approve` отчитывался об успехе, а на провод уходил `decline`.
 * Поэтому у метода без этого поля «предложенным» считается его собственный словарь схемы.
 */
const APPROVAL_VOCAB: Record<string, { allow: readonly string[]; session?: string; deny: readonly string[]; offersDecisions: boolean }> = {
  'item/commandExecution/requestApproval': { allow: ['accept'], session: 'acceptForSession', deny: ['decline', 'cancel'], offersDecisions: true },
  'item/fileChange/requestApproval': { allow: ['accept'], session: 'acceptForSession', deny: ['decline', 'cancel'], offersDecisions: false },
  // Старый путь v1 (`codex exec`): Пульт ходы так не начинает, но ответить обязан.
  applyPatchApproval: { allow: ['approved'], session: 'approved_for_session', deny: ['denied', 'abort'], offersDecisions: false },
  execCommandApproval: { allow: ['approved'], session: 'approved_for_session', deny: ['denied', 'abort'], offersDecisions: false },
}

/**
 * Поля снимка лимитов, у которых ПРИШЕДШИЙ `null` означает «сбрось известное», а не «нет
 * данных». Список ровно из одного поля и таким и должен остаться: см. `mergeLimits`.
 */
const CLEARED_BY_NULL: ReadonlySet<string> = new Set(['rateLimitReachedType'])

/** Читаемое имя инструмента для Inbox. */
const APPROVAL_TOOL_NAME: Record<string, string> = {
  'item/commandExecution/requestApproval': 'commandExecution',
  'item/fileChange/requestApproval': 'fileChange',
  applyPatchApproval: 'applyPatch',
  execCommandApproval: 'execCommand',
}

export interface CodexAdapterOptions extends AdapterDeps {
  paths: PultPaths
  config: PultConfig
  logger: Logger
  /** Путь к бинарю `codex`. Тест подсовывает сюда фальшивый app-server. */
  bin: string
  /** Инъекция стража сети: тест не ходит в сеть вообще. */
  netCheck?: (provider: 'codex') => Promise<NetCheck>
  /** Инъекция сверки схемы: тест не спавнит настоящий `codex`. Может быть и асинхронной. */
  schemaCheck?: () => CodexSchemaCheck | Promise<CodexSchemaCheck>
  /**
   * Сколько ждать ответа на СЛУЖЕБНЫЙ запрос (`initialize`, `thread/*`, `turn/start`).
   * Не про длительность хода: ход ждут `turn/completed`, а не ответ на запрос.
   */
  controlTimeoutMs?: number
  now?: () => number
}

interface TurnCtx {
  turnId: string
  providerTurnId: string | null
  textParts: string[]
  retries: number
  tokens: { input: number; output: number; cached: number }
  startedAt: number
  settled: boolean
  done: Promise<TurnOutcome>
  finish(outcome: TurnOutcome): void
}

interface Live {
  spec: SessionSpec
  /** Тред провайдера. Живёт дольше процесса: его возобновляют через `thread/resume`. */
  threadId: string | null
  /** Тред заведён или возобновлён в ТЕКУЩЕМ процессе. Рестарт процесса сбрасывает флаг. */
  attached: boolean
  /**
   * На треде был хотя бы один начатый ход — только тогда он возобновляем (см. шапку).
   * `false` при живом `threadId` означает «этот id никому не нужен, заводим новый».
   */
  confirmed: boolean
  mapper: CodexMapper
  turn: TurnCtx | null
  /**
   * Ход ЗАВОДИТСЯ: сессия занята, но `turn` ещё не создан.
   *
   * НАХОДКА РАЗБОРА В3 (P1): проверка «сессия уже делает ход» смотрела на `turn`, а он
   * присваивался ПОСЛЕ трёх `await` (страж сети, общий процесс, тред). Две реплики подряд без
   * ожидания между ними обе проходили проверку, обе заводили ход, второй затирал контекст
   * первого — и `done` первого не резолвился НИКОГДА (`pult agent prompt --wait` висел до
   * таймаута). Флаг ставится СИНХРОННО, до первого `await`, и снимается на любом выходе.
   *
   * ЭТО НЕ «сессия занимает общий процесс»: в таком состоянии она его ещё не касалась — впереди
   * и страж сети, и сам `ensureClient`. Про процесс говорит `usingProcess`, и путать их нельзя.
   */
  starting: boolean
  /**
   * Сессия ДЕРЖИТ общий процесс: `ensureClient` уже выдал ей клиента, и с этого мгновения до
   * конца хода перезапускать процесс под ней нельзя.
   *
   * РЕГРЕССИЯ ПЕРВОГО КРУГА ПРАВОК, закрытая здесь: `anyBusy` считала занятыми сессии с
   * `starting`, а он ставится ДО проверки сети. Два агента, у которых страж одновременно
   * откатился с прокси на прямой путь (случай Ф0 «прокси лёг»), видели друг у друга `starting`,
   * каждый решал, что общий процесс занят ЧУЖИМ ходом, и ОБА получали `provider_unavailable` —
   * при том что процессом не пользовался никто и перезапуск был бесплатен.
   */
  usingProcess: boolean
  lastTurnAt: number
  closing: boolean
  /** Стоп пришёл, пока ход ещё не дошёл до `turn/start` (страж сети и спавн — это `await`). */
  stopRequested: boolean
  /** Профиль сети, выбранный последней проверкой стража. */
  netEnv: Record<string, string>
  /**
   * О3: MCP-серверы (браузер), с которыми тред заведён или возобновлён в текущем процессе, — строкой
   * JSON. Другой набор на следующем ходу — тред переподключается (`thread/unsubscribe` + `thread/resume`
   * с новым `config`): браузер, включённый посреди сессии, действует со следующего хода.
   */
  mcpKey: string
  /** Смена набора серверов, о которой лента уже сказала (см. `ensureThread`). */
  mcpNotedKey?: string
  /**
   * M8f (ревью): песочница (режим строкой) и политика, которые ДЕЙСТВУЮТ у загруженного треда — то, что ушло в
   * `thread/start|resume` или в последний `turn/start`. `null` — тред в этом процессе не загружен. Ход, чей снимок
   * режима отличается, несёт в `turn/start` только то, что отличается (политику и/или песочницу).
   */
  threadPolicy: { sandbox: string; approvalPolicy: string } | null
  /**
   * Объекты `SandboxPolicy` по типу, как их вернул сам сервер (`sandbox` в ответе `thread/start|resume`) или
   * собрал `config/read`: при возврате в режим шлём ИХ — `sandbox_workspace_write` из config.toml не теряется.
   */
  sandboxObjects: Record<string, Record<string, unknown>>
  /** Набор MCP треда, который заводится прямо сейчас (между сборкой и ответом `thread/start|resume`). */
  pendingMcpKey: string
}

interface PendingApproval {
  id: JsonRpcId
  session: string
  method: string
  /**
   * Что по этому методу вообще можно выбрать: `availableDecisions` там, где схема параметров
   * это поле объявляет, иначе словарь решений самого метода (см. `offeredDecisions`).
   * Из этого и только из этого выбирается ответ.
   */
  offered: string[]
  /** M8d: готовый ответ «всегда» (`codexScopedOffers`), если сервер его предложил; иначе `null`. */
  rule: Record<string, unknown> | null
  /**
   * Поколение процесса, которое задало вопрос. Ответ, вернувшийся от человека после падения
   * и перезапуска app-server, НЕ имеет права уехать в новый процесс: там по этому id живёт
   * уже чужой запрос (или ничего). Без поколения ключ `id` — это ключ на весь век адаптера.
   */
  generation: number
  answered: boolean
}

/** Ключ очереди разрешений: поколение процесса + id запроса, а не голый id. */
const approvalKey = (generation: number, id: JsonRpcId): string => `${generation}:${String(id)}`

/** Длина строки в отправленном человеку описании запроса: полотно в Inbox читать нельзя. */
const APPROVAL_FIELD_LIMIT = 2000
/** Столько элементов массива видно в карточке; хвост — строкой `…(ещё N)`, не молча. */
const APPROVAL_ARRAY_LIMIT = 40
/** Поля, которые в Inbox не нужны: это маршрутизация, а не то, что человек разрешает. */
const APPROVAL_SKIP_FIELDS: ReadonlySet<string> = new Set(['threadId', 'turnId', 'startedAtMs'])

let turnSeq = 0

/**
 * Вопрос Codex «вызвать ли инструмент MCP-сервера» (О3): `mcpServer/elicitation/request` в виде формы с
 * `_meta.codex_approval_kind = "mcp_tool_call"` (ключи — из бинаря codex 0.162; живым ходом не снято).
 * Форма, у которой есть ОБЯЗАТЕЛЬНЫЕ поля, сюда не идёт: заполнить их за человека Пульт не может, и такой
 * запрос получает обычный отказ «не поддерживается».
 */
/**
 * Какой инструмент и с какими аргументами спрашивает Codex. Сервер — `serverName`; инструмент и аргументы —
 * из `_meta` (ключи — из живого хода, см. docs/DEV.md О3), а нет их там — из последнего начатого, но не
 * законченного `mcpToolCall` этого треда (`item/started`): Codex объявляет вызов до вопроса о нём.
 * `args: null` — аргументов не нашлось: карточка Inbox говорит это прямо.
 */
export function toolApprovalCall(
  params: Record<string, unknown>,
  pending: (threadId: string, server: string, tool: string | null) => { tool: string; args: unknown } | null,
): { server: string; tool: string; args: unknown } {
  const meta = obj(params['_meta']) ?? {}
  const server = str(params['serverName']) ?? 'mcp'
  // Живой ход 15.10.2026 (codex 0.162): `_meta = {codex_approval_kind, tool_description, tool_params,
  // tool_params_display}`, имени инструмента в `_meta` нет — оно в `message` («…to run tool "browser_navigate"?»)
  // и в предшествующем `item/started` mcpToolCall.
  const fromMessage = /run tool "([^"]+)"/.exec(str(params['message']) ?? '')?.[1] ?? null
  const metaTool = str(meta['tool_name']) ?? str(meta['toolName']) ?? str(meta['tool']) ?? fromMessage
  const metaArgs = meta['tool_params'] ?? meta['arguments'] ?? meta['tool_arguments']
  const found = pending(str(params['threadId']) ?? '', server, metaTool)
  const tool = metaTool ?? found?.tool ?? str(meta['tool_title']) ?? 'tool'
  const args = metaArgs !== undefined && metaArgs !== null ? metaArgs : found ? found.args : null
  return { server, tool, args }
}

/** Заметка ленты: Codex не меняет MCP-серверы загруженного треда (см. `ensureThread`). */
export const CODEX_BROWSER_PENDING = 'Codex подхватит смену браузера только в новом процессе app-server: перезапусти демона '
  + '(pult daemon stop && pult daemon start) — разговор сохранится'

export function isToolApproval(params: Record<string, unknown>): boolean {
  const meta = obj(params['_meta'])
  if (!meta || meta['codex_approval_kind'] !== 'mcp_tool_call') return false
  if (params['mode'] !== undefined && params['mode'] !== 'form') return false
  const schema = obj(params['requestedSchema'])
  const required = schema ? schema['required'] : undefined
  return !(Array.isArray(required) && required.length > 0)
}

/** Ответ на такой вопрос: «да» — `accept` один раз (без `_meta.persist`), иначе `decline`. */
export function elicitationAnswer(behavior: 'allow' | 'deny'): Record<string, unknown> {
  return behavior === 'allow' ? { action: 'accept', content: {} } : { action: 'decline' }
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Пауза. Таймер НЕ `unref`-нут намеренно: отсрочка перед перезапуском — часть работы, и
 * процесс, который во время неё «нечем держать», обязан дожить до конца паузы, а не выйти.
 * Цена честная: паузы здесь короткие (сотни миллисекунд) и всегда доигрываются.
 */
const nap = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

export function createCodexAdapter(opts: CodexAdapterOptions): ProviderAdapter {
  const { paths, config, logger } = opts
  const now = opts.now ?? Date.now
  const live = new Map<string, Live>()
  /** Маршрутная таблица: тред → чья это сессия и под каким узлом дерева он висит. */
  const threadOwner = new Map<string, { name: string; parentNodeId?: string }>()
  const approvals = new Map<string, PendingApproval>()
  const unknownSeen = new Set<string>()

  let client: AppServerClient | null = null
  let clientNetKey = ''
  let starting: Promise<AppServerClient> | null = null
  let restarts: number[] = []
  let everSpawned = false
  /**
   * Адаптер гасится. Ставится ПЕРВЫМ делом в `shutdown()` и больше НИКОГДА не снимается:
   * спавн, выигравший гонку с остановкой демона, обязан увидеть этот флаг и убить своего
   * ребёнка сам. Пока флаг снимался в конце `shutdown()`, живой `codex app-server`
   * переживал `pult daemon stop` — его некому было отследить (правка по ревью В3).
   */
  let shuttingDown = false
  /** Поколение процесса: растёт на каждом спавне, им метятся ожидающие разрешения. */
  let generation = 0
  let providerBlocked: string | null = null
  let schemaChecked = false
  /** Итог фоновой сверки схемы: его читает журнал, а в Ф1 В4 прочтёт и доска. */
  let schemaState: CodexSchemaCheck | null = null
  const controlMs = opts.controlTimeoutMs ?? 60_000
  /** Последний известный снимок лимитов: `account/rateLimits/updated` РАЗРЕЖЕННЫЙ. */
  let limits: Record<string, unknown> | null = null
  /** Он же, пропущенный через `redact`: наружу (в события) уходит ТОЛЬКО эта копия. */
  let limitsSafe: Record<string, unknown> | null = null
  let wasLimited = false

  const emit = (draft: EventDraft): void => { opts.emit(draft) }
  const status = (sessionId: string, s: string, extra: Record<string, unknown> = {}): void =>
    emit({ sessionId, provider: 'codex', kind: 'status.changed', data: { status: s, ...extra } })

  const netProbe = opts.netCheck
    ?? ((provider: 'codex'): Promise<NetCheck> =>
      checkNetwork(provider, config.network[provider], config.guard, {}))
  /** Поколение правил сети (`netGeneration`), при котором сессия последний раз проходила стража. */
  const netSeen = new WeakMap<Live, number>()

  const once = (what: string, log: () => void): void => {
    if (unknownSeen.has(what)) return
    unknownSeen.add(what)
    log()
  }

  const need = (name: string): Live => {
    const l = live.get(name)
    if (!l) throw new Error(`сессия ${name} не заведена в адаптере`)
    return l
  }

  const networkEnv = codexNetworkEnv

  const netKeyOf = (env: Record<string, string>): string => JSON.stringify(env)

  /**
   * Занят ли общий процесс ЧУЖОЙ работой. «Чужой» — потому что себя считать нельзя: ход,
   * который сам же и сменил профиль сети, иначе отказывал бы сам себе.
   *
   * Занятость — это `turn` (ход идёт) ИЛИ `usingProcess` (клиента уже выдали, тред и реплика
   * впереди). `starting` СЮДА НЕ ВХОДИТ намеренно: он значит «сессия зарезервирована под ход»,
   * а сессия в этом состоянии процесса ещё не касалась. Считать его занятостью — регрессия:
   * два агента, у которых страж одновременно откатился на другой профиль, видели друг у друга
   * `starting` и ОБА уходили в `provider_unavailable` вместо одного бесплатного перезапуска.
   */
  const anyBusy = (except: string): boolean =>
    [...live.values()].some((l) => l.spec.name !== except && (l.turn !== null || l.usingProcess))

  /**
   * Сессия взяла общий процесс. Зовётся В САМОМ `ensureClient`, на каждом его успешном выходе,
   * а не у вызывающего: между резолвом обещания спавна и продолжением `runTurn` успевает
   * провернуться чужая микрозадача, и в это окно процесс выглядел бы ничьим.
   */
  const holdProcess = (sessionId: string): void => {
    const l = live.get(sessionId)
    if (l) l.usingProcess = true
  }

  // --- лимиты ----------------------------------------------------------------

  /**
   * Слияние РАЗРЕЖЕННОГО снимка. `null` значит РАЗНОЕ у разных полей, и это не придирка, а два
   * измерения:
   *   * `rateLimitReachedType: null` — СНЯТИЕ лимита. Иначе сессия висела бы `limited` до
   *     перезапуска демона. Схема подтверждает чтение: у `spendControlReached` отдельно
   *     оговорено «`None` — это недоступность, а НЕ восстановление», то есть у остальных
   *     полей `None` именно восстановление;
   *   * `primary: null, secondary: null` — «в этом сообщении цифр нет». ИЗМЕРЕНО 21.09.2026
   *     (запись `token_count` в rollout): при исчерпанном лимите пришёл снимок, где оба окна
   *     `null`. Обнули мы по нему известные проценты — человек увидел бы прочерк ровно тогда,
   *     когда цифры нужнее всего.
   * Поэтому стирать по `null` разрешено ТОЛЬКО полям из `CLEARED_BY_NULL`.
   *
   * Два уровня: сам снимок и окна `primary`/`secondary` — обновление приносит то одно окно,
   * то оба, и «забыть» второе значит показать человеку пустую строку вместо цифры.
   */
  const mergeLimits = (next: Record<string, unknown>): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...(limits ?? {}) }
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) continue
      if (v === null && !CLEARED_BY_NULL.has(k)) continue
      if ((k === 'primary' || k === 'secondary') && obj(v) && obj(merged[k])) {
        const old = obj(merged[k]) as Record<string, unknown>
        const fresh = obj(v) as Record<string, unknown>
        const win: Record<string, unknown> = { ...old }
        for (const [wk, wv] of Object.entries(fresh)) if (wv !== undefined) win[wk] = wv
        merged[k] = win
        continue
      }
      merged[k] = v
    }
    limits = merged
    // РЕДАКЦИЯ НА ГРАНИЦЕ (инвариант 7). Снимок лимитов — это чужой объект, который мы
    // копируем целиком, с любыми полями, какие пришлёт сервер (`limitName`,
    // `normalModelSlug`, `rateLimitUpsell`, …). Взломщик прислал в них адрес почты и ключ —
    // и они уехали в `events/*.jsonl` дословно, потому что этот путь был единственным в
    // файле, где чужой текст попадал в событие мимо `redact`. Теперь наружу отдаётся только
    // отредактированная копия; сырой `limits` живёт внутри и нужен лишь для слияния.
    limitsSafe = redact(merged) as Record<string, unknown>
    return limitsSafe
  }

  /**
   * Снимок лимитов Codex в тех же полях, в каких его показывает Claude, — чтобы `pult usage`
   * оставался одной таблицей на обоих провайдеров. Окна раскладываются по ИЗМЕРЕННОЙ
   * длительности: 300 мин → пятичасовое, 10080 мин → недельное; `usedPercent` (целые проценты)
   * превращается в долю, как `utilization` у Claude. Сырые `primary`/`secondary` рядом — чтобы
   * правда не терялась при этом переводе.
   */
  const usageData = (snapshot: Record<string, unknown>, ordinaryAllowed: boolean | null): Record<string, unknown> => {
    const window = (w: unknown): { utilization: number | null; resetsAt: number | null; windowDurationMins: number | null } | null => {
      const o = obj(w)
      if (!o) return null
      const pct = num(o['usedPercent'])
      return {
        utilization: pct === null ? null : pct / 100,
        resetsAt: num(o['resetsAt']),
        windowDurationMins: num(o['windowDurationMins']),
      }
    }
    const primary = window(snapshot['primary'])
    const secondary = window(snapshot['secondary'])
    const short = primary && primary.windowDurationMins !== null && primary.windowDurationMins > 1440 ? secondary : primary
    const long = short === primary ? secondary : primary
    const reached = str(snapshot['rateLimitReachedType'])
    return {
      source: 'rate_limit_event',
      status: reached !== null ? 'limited' : ordinaryAllowed === false ? 'blocked' : 'allowed',
      rateLimitType: reached,
      resetsAt: short?.resetsAt ?? null,
      isUsingOverage: false,
      windows: { five_hour: short, seven_day: long },
      codex: {
        primary: snapshot['primary'] ?? null,
        secondary: snapshot['secondary'] ?? null,
        planType: snapshot['planType'] ?? null,
        ordinaryUsageAllowed: ordinaryAllowed,
      },
    }
  }

  const applyLimits = (snapshot: Record<string, unknown>, ordinaryAllowed: boolean | null): void => {
    const merged = mergeLimits(snapshot)
    const data = usageData(merged, ordinaryAllowed)
    // Снимок относится к АККАУНТУ, а не к треду: `threadId` в этом уведомлении нет вовсе.
    // Поэтому он приписывается тем, кто прямо сейчас тратит, — сессиям с открытым ходом.
    for (const l of live.values()) {
      if (l.turn && !l.closing) emit({ sessionId: l.spec.name, provider: 'codex', kind: 'usage.updated', data })
    }
    const limited = data['status'] === 'limited' || data['status'] === 'blocked'
    if (limited && !wasLimited) {
      // Факт про аккаунт касается ВСЕХ сессий, не только занятых.
      for (const l of live.values()) {
        if (!l.closing) emit({ sessionId: l.spec.name, provider: 'codex', kind: 'limit.hit', data })
      }
      logger.warn('лимит codex достигнут', { rateLimitType: data['rateLimitType'], resetsAt: data['resetsAt'] })
    }
    wasLimited = limited
  }

  // --- процесс ---------------------------------------------------------------

  const detachAll = (): void => {
    for (const l of live.values()) { l.attached = false; l.threadPolicy = null }
    for (const [id, owner] of [...threadOwner]) {
      // Треды субагентов живут ровно столько, сколько процесс: у них нет своего resume.
      if (owner.parentNodeId !== undefined) threadOwner.delete(id)
    }
  }

  const onProcessGone = (code: number | null, signal: NodeJS.Signals | null): void => {
    const why = `app-server codex вышел (code=${code ?? '—'} signal=${signal ?? '—'})`
    const pid = client?.pid ?? null
    client = null
    detachAll()
    // СЛЕД В ЖУРНАЛЕ ОБЯЗАТЕЛЕН, даже когда процесс умер В ПРОСТОЕ. Лид убил его между
    // ходами — и в журнале между `idle` и следующим `working` не было ни строчки, объяснить
    // потерю контекста было нечем (ревью В3). Событие уходит в сессию демона: оно про
    // провайдера, а не про чью-то конкретную работу.
    emit({
      sessionId: DAEMON_SESSION,
      provider: 'codex',
      kind: 'provider.restarted',
      data: {
        provider: 'codex',
        event: 'exited',
        pid,
        code,
        signal,
        generation,
        restartsInWindow: restarts.length,
        intentional: shuttingDown,
        sessions: live.size,
      },
    })
    // Ожидающие разрешения мёртвого процесса — ОТКАЗ: отвечать некому, а висящий в Inbox
    // вопрос от покойника хуже отказа (инвариант 5).
    for (const [key, p] of [...approvals]) {
      approvals.delete(key)
      if (!p.answered) opts.cancelPermissions?.(p.session, `${why} — запрос отклонён`)
    }
    for (const l of live.values()) {
      // Держать УМЕРШИЙ процесс нельзя: иначе сессия, чей ход не дошёл до `turn`, навсегда
      // числилась бы занятой и блокировала соседям перезапуск под новый профиль сети.
      l.usingProcess = false
      const ctx = l.turn
      if (!ctx) continue
      ctx.finish({ turnId: ctx.turnId, ok: false, errorCode: 'provider_unavailable', message: why })
    }
    if (!shuttingDown) logger.error('общий процесс codex умер', { code, signal, sessions: live.size })
  }

  const killClient = async (c: AppServerClient): Promise<void> => {
    c.endStdin()
    c.kill('SIGTERM')
    if (await c.waitExit(TERM_WAIT_MS)) return
    logger.warn('app-server не ушёл по SIGTERM — SIGKILL', { pid: c.pid })
    c.kill('SIGKILL')
    await c.waitExit(KILL_WAIT_MS)
  }

  const blockProvider = (reason: string, sessionId: string): void => {
    providerBlocked = reason
    emit({
      sessionId,
      provider: 'codex',
      kind: 'provider.blocked',
      data: { provider: 'codex', text: reason, hint: 'снять — pult provider reset codex' },
    })
    logger.error('провайдер codex остановлен целиком', { reason })
  }

  const spawnClient = async (netEnv: Record<string, string>, sessionId: string): Promise<AppServerClient> => {
    const t = now()
    restarts = restarts.filter((x) => t - x < RESTART_WINDOW_MS)
    if (everSpawned) {
      if (restarts.length >= RESTART_CEILING) {
        const reason = `app-server codex перезапускался ${restarts.length} раза за минуту — провайдер остановлен`
        blockProvider(reason, sessionId)
        throw Object.assign(new Error(reason), { code: 'provider_unavailable' })
      }
      // Отсрочка растёт с каждым падением в окне: шторм перезапусков никому не помогает.
      if (restarts.length > 0) await nap(RESTART_BACKOFF_MS * restarts.length)
      restarts.push(t)
    }
    const everSpawnedBefore = everSpawned
    everSpawned = true
    // Новое поколение процесса: им метится каждый вопрос разрешения, заданный ЭТИМ процессом.
    generation += 1

    const c = createAppServerClient({
      bin: opts.bin,
      // cwd общего процесса — PULT_HOME: у тредов свой `cwd` в параметрах, а процессу нужна
      // просто существующая папка, которая точно наша.
      cwd: paths.home,
      env: buildChildEnv(process.env, { network: netEnv, extra: {} }),
      onNotification: (method, params) => { onNotification(method, params) },
      onServerRequest: (id, method, params) => { void onServerRequest(id, method, params) },
      onExit: (code, signal) => { onProcessGone(code, signal) },
      onSpawnError: (e) => { logger.error('codex app-server не запустился', { bin: opts.bin, error: e.message }) },
      onStderr: (line) => { logger.debug('codex stderr', { line: redactString(line.slice(0, 400)) }) },
      onBadLine: (reason, sample) => {
        once(`bad-line:${reason}`, () => logger.warn('нечитаемая строка от app-server', { reason, sample: redactString(sample) }))
      },
    })
    clientNetKey = netKeyOf(netEnv)
    emit({
      sessionId: DAEMON_SESSION,
      provider: 'codex',
      kind: 'provider.restarted',
      data: {
        provider: 'codex',
        event: everSpawnedBefore ? 'restarted' : 'started',
        pid: c.pid ?? null,
        generation,
        restartsInWindow: restarts.length,
        proxy: Object.keys(netEnv).length > 0,
      },
    })

    try {
      await c.request('initialize', {
        clientInfo: { name: 'pult', title: 'Pult', version: VERSION },
        capabilities: { optOutNotificationMethods: [...MUTED_NOTIFICATIONS] },
      }, controlMs)
    } catch (e) {
      // Рукопожатие не состоялось: молчащий или сломанный app-server. Процесс снимаем ЗДЕСЬ —
      // `client` ему присвоить ещё не успели, и без этого он остался бы сиротой навсегда.
      await killClient(c)
      throw e
    }
    c.notify('initialized', {})
    logger.info('codex app-server поднят', { pid: c.pid, proxy: Object.keys(netEnv).length > 0 })

    // Снимок лимитов — один раз на соединение (совет спайка S2): дальше их приносят
    // разреженные `account/rateLimits/updated`.
    void c.request('account/rateLimits/read', {}, 20_000).then(
      (r) => {
        const snapshot = obj(r['rateLimits'])
        if (snapshot) applyLimits(snapshot, typeof r['ordinaryUsageAllowed'] === 'boolean' ? r['ordinaryUsageAllowed'] : null)
      },
      () => { /* лимиты не обязательны для работы */ },
    )
    return c
  }

  /**
   * Сверка схемы протокола — ОДИН раз за жизнь адаптера, В ФОНЕ, после того как процесс уже
   * поднят. Ход её НЕ ЖДЁТ: она нужна человеку в `pult doctor` и в журнале, а не модели.
   * Первая версия звала синхронную проверку прямо на горячем пути и замораживала весь демон
   * (взломщик померил полторы секунды остановки пульса) — отсюда и `void`, и async.
   */
  const verifySchema = (): void => {
    if (schemaChecked) return
    schemaChecked = true
    const started = Date.now()
    const check = opts.schemaCheck
      ? opts.schemaCheck()
      : checkCodexSchema({ bin: opts.bin, workDir: join(paths.run, 'codex-schema') })
    void Promise.resolve(check).then(
      (r) => {
        schemaState = r
        const data = { sha256: r.actual, files: r.files, ms: Date.now() - started, detail: r.detail }
        if (r.status === 'ok') logger.info('схема протокола codex сверена', data)
        else if (r.status === 'drift') logger.warn('схема протокола codex разошлась', { expected: r.expected, ...data })
        else logger.warn('схему протокола codex проверить не удалось', data)
      },
      (e: unknown) => { logger.warn('сверка схемы codex не состоялась', { error: (e as Error).message }) },
    )
  }

  /**
   * Общий процесс под ПРОФИЛЬ СЕТИ ЭТОГО ХОДА.
   *
   * НАХОДКА РАЗБОРА В3 (P1): раньше здесь стояло `if (starting) return starting` — и ход
   * получал процесс, поднятый ЧУЖОЙ проверкой стража, ни разу не сверив профиль со своим.
   * Сценарий: сессия A мерит сеть, получает `direct` и начинает спавн; сессия B мерит следом,
   * получает `proxy` (прокси поднялся — или, наоборот, у A страж откатился на прямой путь),
   * видит спавн в полёте и уезжает в него. Наблюдаемо: в окружении общего процесса ни одной
   * переменной прокси, а ход B прошёл — то есть трафик ушёл маршрутом, который проверка B не
   * утверждала, а это ровно то, что запрещает инвариант 2.
   * Теперь профиль сверяется И на быстром пути, И НА ВЫХОДЕ из ожидания, а несовпадение
   * обрабатывается одинаково в обоих случаях: никто чужой не занят — перезапуск под новый
   * профиль (сериализованный тем же `starting`), занят — отказ `provider_unavailable`.
   */
  const ensureClient = async (netEnv: Record<string, string>, sessionId: string): Promise<AppServerClient> => {
    const key = netKeyOf(netEnv)
    const mismatch = (): Error => Object.assign(
      new Error('профиль сети сменился, а общий процесс codex занят чужими ходами — повтори, когда они закончатся'),
      { code: 'provider_unavailable' },
    )
    // Проходов ровно три: один на ожидание чужого спавна, один на свой перезапуск и один
    // запасной — на редкую цепочку из двух чужих спавнов подряд. Дальше крутиться незачем:
    // значит, профиль пляшет быстрее, чем поднимается процесс, и честнее отказать ходу, чем
    // молотить вечно.
    for (let pass = 0; pass < 3; pass++) {
      if (shuttingDown) throw Object.assign(new Error('адаптер codex останавливается'), { code: 'provider_unavailable' })
      if (providerBlocked !== null) throw Object.assign(new Error(providerBlocked), { code: 'provider_unavailable' })
      if (client && client.alive() && key === clientNetKey) { holdProcess(sessionId); return client }
      // Профиль сети сменился (прокси лёг и страж откатился на прямой путь — или наоборот), а
      // процесс ОДИН НА ВСЕХ: переменные окружения задаются при спавне и на лету не меняются.
      // Пока чужие ходы идут, мы не имеем права их обрывать — отказываем этому ходу.
      if (client && client.alive() && anyBusy(sessionId)) throw mismatch()
      const inflight = starting
      if (inflight) {
        // Чужой спавн в полёте: дождаться его и ПЕРЕПРОВЕРИТЬ профиль (проверка на следующем
        // проходе), а не отдать вслепую. Ошибка чужого спавна — и наша тоже: процесс один.
        const spawned = await inflight
        if (key === clientNetKey && spawned.alive()) { holdProcess(sessionId); return spawned }
        continue
      }
      // ВСЁ, что дальше, живёт ВНУТРИ `starting`, и это правка по ревью: раньше между
      // `client = null` и присвоением `starting` стоял `await killClient(old)`, и второй ход,
      // проскочивший в это окно, поднимал свой процесс со своим (возможно, устаревшим)
      // профилем сети. Теперь перезапуск сериализован тем же обещанием, что и спавн.
      starting = (async () => {
        if (client && !(client.alive() && key === clientNetKey)) {
          const old = client
          client = null
          if (old.alive()) logger.info('перезапуск app-server: сменился профиль сети', { from: clientNetKey, to: key })
          await killClient(old)
        }
        let c: AppServerClient
        try {
          c = await spawnClient(netEnv, sessionId)
        } catch (e) {
          client = null
          throw e
        }
        // Гонка с остановкой демона: пока шло рукопожатие, `shutdown()` уже мог снять всё, что
        // видел, и уйти. Тогда этого ребёнка не отследит никто — убиваем его сами, здесь.
        if (shuttingDown) {
          await killClient(c)
          throw Object.assign(new Error('адаптер codex останавливается'), { code: 'provider_unavailable' })
        }
        client = c
        verifySchema()
        return c
      })()
      try {
        // `holdProcess` — ДО выхода из этой микрозадачи: продолжение `runTurn` встанет в
        // очередь после чужого `await inflight`, и в этом промежутке процесс был бы ничьим.
        const c = await starting
        holdProcess(sessionId)
        return c
      } finally {
        starting = null
      }
    }
    throw mismatch()
  }

  // --- разрешения ------------------------------------------------------------

  /**
   * ЧТО СЕРВЕР ПРЕДЛАГАЕТ на этот запрос. Источник зависит от метода, и это правка по разбору
   * В3 (см. APPROVAL_VOCAB): у `item/commandExecution/requestApproval` поле
   * `availableDecisions` в схеме параметров ЕСТЬ, и список берётся из него (объекты вроде
   * `acceptWithExecpolicyAmendment` отбрасываются — Пульт их не выбирает). У правки файла и у
   * двух старых методов такого поля в схеме НЕТ, и пустой список там означал бы не «нечего
   * разрешать», а «мы не туда посмотрели»: для них предложенным считается словарь их
   * собственной схемы решений — с «на сессию» (M8d: у правки файла схема его объявляет).
   */
  const offeredDecisions = (method: string, params: Record<string, unknown>): string[] => {
    const vocab = APPROVAL_VOCAB[method]
    if (vocab && !vocab.offersDecisions) return [...vocab.allow, ...(vocab.session ? [vocab.session] : []), ...vocab.deny]
    return Array.isArray(params['availableDecisions'])
      ? (params['availableDecisions'] as unknown[]).filter((d): d is string => typeof d === 'string')
      : []
  }

  /**
   * Перевод решения Пульта в решение протокола. Два РАЗНЫХ правила, и это не небрежность:
   *
   *   deny  → `decline` ВСЕГДА, даже если его нет в `availableDecisions`: он валиден по схеме
   *           и измеренно принимается, а главное — отказывает РОВНО В ЭТОМ действии, не трогая
   *           ход. `cancel` из того же списка строже, но он обрывает весь ход, а человек,
   *           нажавший `pult perm deny`, просил не этого: для «останови» есть `agent stop`.
   *   allow → только то, что сервер ПРЕДЛОЖИЛ (`offeredDecisions`, а не голое поле параметров:
   *           у правки файла схема его не объявляет вовсе). Список важен: если «да» в нём нет,
   *           значит разрешать нечего, и мы отвечаем отказом (инвариант 5: никогда не по
   *           умолчанию «разрешить»), о чём пишем в журнал.
   *   scope (M8d) → `session` — строка «на сессию», только если она предложена; `rule` — готовый ответ
   *           «всегда» из `codexScopedOffers`, только если он есть. Не предложено — сужается до одного
   *           раза (`narrowed`), а не расширяется и не превращается в отказ: «да» человека было.
   */
  const chooseDecision = (
    method: string,
    behavior: 'allow' | 'deny',
    offered: string[],
    scope: PermissionScope = 'once',
    rule: Record<string, unknown> | null = null,
  ): { decision: string | Record<string, unknown>; downgraded: boolean; narrowed: boolean } => {
    const fallback = APPROVAL_VOCAB['item/commandExecution/requestApproval'] as { allow: readonly string[]; deny: readonly string[] }
    const vocab: { allow: readonly string[]; session?: string; deny: readonly string[] } = APPROVAL_VOCAB[method] ?? fallback
    const no = vocab.deny[0] as string
    if (behavior === 'deny') return { decision: no, downgraded: false, narrowed: false }
    if (scope === 'session' && vocab.session && offered.includes(vocab.session)) return { decision: vocab.session, downgraded: false, narrowed: false }
    if (scope === 'rule' && rule) return { decision: rule, downgraded: false, narrowed: false }
    const yes = vocab.allow.find((d) => offered.includes(d))
    return yes !== undefined ? { decision: yes, downgraded: false, narrowed: scope !== 'once' } : { decision: no, downgraded: true, narrowed: false }
  }

  /**
   * Что человек УВИДИТ в `pult perm list`. Раньше здесь был фиксированный набор
   * `{command, cwd, reason, kind}`, и на запросе о правке файла человек видел `command: null`
   * и ни слова о файле — то есть разрешал вслепую. Теперь пропускаются ВСЕ параметры запроса,
   * кроме маршрутных, включая незнакомые (протокол растёт, и поле, о котором мы не знаем,
   * человеку нужнее, чем нам): всё через `redact`, длинные строки подрезаны.
   *
   * `concealed` — показано не всё: брокер видит только уже подрезанный вход и сам этого не заметит. Длинный
   * массив тоже помечается (`…(ещё N)`): `command` старого `execCommandApproval` — массив, и молча
   * отрезанный хвост команды человек разрешил бы, не видя.
   */
  const approvalInput = (params: Record<string, unknown>, offered: string[]): { input: Record<string, unknown>; concealed?: true } => {
    let clipped = false
    const cap = (v: unknown): unknown => {
      if (typeof v === 'string') {
        if (v.length <= APPROVAL_FIELD_LIMIT) return v
        clipped = true
        return `${v.slice(0, APPROVAL_FIELD_LIMIT)}…(обрезано)`
      }
      if (Array.isArray(v)) {
        if (v.length <= APPROVAL_ARRAY_LIMIT) return v.map(cap)
        clipped = true
        return [...v.slice(0, APPROVAL_ARRAY_LIMIT).map(cap), `…(ещё ${v.length - APPROVAL_ARRAY_LIMIT})`]
      }
      const o = obj(v)
      if (!o) return v
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(o)) out[k] = cap(val)
      return out
    }
    const picked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(params)) {
      if (APPROVAL_SKIP_FIELDS.has(k)) continue
      picked[k] = cap(v)
    }
    // Отдельной строкой: из чего вообще можно выбирать — строковые варианты. Объектные (поправки execpolicy и
    // сети) сюда не идут: они приходят кнопкой «Всегда …» (`codexScopedOffers`, M8d). У методов, чья схема поля
    // `availableDecisions` не объявляет (правка файла и два старых), здесь стоит их словарь
    // решений — иначе человек видел бы пустой список там, где выбор на самом деле есть.
    picked['availableDecisions'] = offered
    const input = redact(picked) as Record<string, unknown>
    return clipped || JSON.stringify(input) !== JSON.stringify(picked) ? { input, concealed: true } : { input }
  }

  /**
   * Снять все ожидающие вопросы сессии: серверу — самый строгий ответ, человеку — пустой
   * Inbox. Второе делается через `cancelPermissions`, и без него вопрос закрытой сессии висел
   * бы в `pult perm list` до таймаута брокера (10 минут), а решение по нему уходило бы в
   * никуда. Зовётся из `close` и из `interrupt`: и «удалил», и «остановил» — оба значат, что
   * спрашивать больше некого.
   */
  const dropApprovals = (name: string, why: string): void => {
    let dropped = 0
    for (const [key, p] of [...approvals]) {
      if (p.session !== name) continue
      approvals.delete(key)
      if (p.answered) continue
      p.answered = true
      dropped += 1
      if (client && client.alive() && p.generation === generation) {
        client.respond(p.id, p.method === 'item/tool/requestUserInput' ? { answers: {} }
          : p.method === 'mcpServer/elicitation/request' ? elicitationAnswer('deny')
            : { decision: chooseDecision(p.method, 'deny', p.offered).decision })
      }
    }
    if (dropped > 0) {
      const cancelled = opts.cancelPermissions?.(name, `${why} — запрос отклонён`) ?? 0
      logger.info('вопросы разрешений сняты', { session: name, why, dropped, cancelled })
    }
  }

  /**
   * О3: начатые и ещё не законченные `mcpToolCall` по тредам — для карточки вопроса о вызове инструмента
   * (аргументы, если Codex не положил их в сам вопрос). Законченный вызов уходит; на тред — не больше 32.
   */
  const mcpCalls = new Map<string, Array<{ id: string; server: string; tool: string; args: unknown }>>()
  const trackMcpCall = (threadId: string, method: string, params: Record<string, unknown>): void => {
    if (method !== 'item/started' && method !== 'item/completed') return
    const item = obj(params['item'])
    if (!item || item['type'] !== 'mcpToolCall') return
    const itemId = str(item['id']) ?? ''
    const list = (mcpCalls.get(threadId) ?? []).filter((x) => x.id !== itemId)
    if (method === 'item/started') list.push({ id: itemId, server: str(item['server']) ?? '', tool: str(item['tool']) ?? '', args: item['arguments'] })
    if (list.length) mcpCalls.set(threadId, list.slice(-32)); else mcpCalls.delete(threadId)
  }
  const pendingMcpCall = (threadId: string, server: string, tool: string | null): { tool: string; args: unknown } | null => {
    const list = mcpCalls.get(threadId) ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i] as { server: string; tool: string; args: unknown }
      if (x.server === server && (tool === null || x.tool === tool)) return { tool: x.tool, args: x.args }
    }
    return null
  }

  const onServerRequest = async (id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> => {
    const c = client
    if (!c) return
    const gen = generation
    const key = approvalKey(gen, id)
    const vocab = APPROVAL_VOCAB[method]
    if (method === 'item/tool/requestUserInput') {
      const owner = threadOwner.get(str(params['threadId']) ?? '')
      const l = owner ? live.get(owner.name) : undefined
      if (!l || l.closing) { c.respondError(id, -32600, 'pult: вопрос по незнакомому треду'); return }
      if (!l.spec.broker) { c.respond(id, { answers: {} }); return }
      const previous = approvals.get(key)
      if (previous) {
        approvals.delete(key)
        previous.answered = true
        opts.cancelPermissions?.(previous.session, 'сервер переиспользовал id вопроса')
        c.respond(id, { answers: {} })
        return
      }
      const pending: PendingApproval = { id, session: l.spec.name, method, offered: [], rule: null, generation: gen, answered: false }
      approvals.set(key, pending)
      let answer: PermissionDecision
      try {
        answer = await opts.askPermission({ sessionId: l.spec.name, toolName: 'requestUserInput', toolUseId: str(params['itemId']) ?? undefined,
          input: { questions: params['questions'], isBlocking: params['isBlocking'] } })
      } catch { answer = { behavior: 'deny' } }
      if (pending.answered || approvals.get(key) !== pending) return
      approvals.delete(key)
      pending.answered = true
      if (client?.alive() && generation === gen) {
        client.respond(id, { answers: answer.behavior === 'allow' ? answer.answers ?? {} : {} })
      }
      return
    }
    if (method === 'mcpServer/elicitation/request' && isToolApproval(params)) {
      // О3: вопрос «можно ли вызвать инструмент MCP-сервера» — так Codex спрашивает про вызовы браузера
      // (`default_tools_approval_mode = "prompt"`). Это то же разрешение, что у команды: в Inbox, один раз,
      // молчание и любой сбой — отказ. «На сессию» и «всегда» (`_meta.persist`) Пульт не выбирает никогда.
      const owner = threadOwner.get(str(params['threadId']) ?? '')
      const l = owner ? live.get(owner.name) : undefined
      if (!l || l.closing) { c.respondError(id, -32600, 'pult: вопрос по незнакомому треду'); return }
      if (!l.spec.broker) { c.respond(id, { action: 'decline' }); return }
      const previous = approvals.get(key)
      if (previous) {
        approvals.delete(key)
        previous.answered = true
        opts.cancelPermissions?.(previous.session, 'сервер переиспользовал id вопроса')
        c.respond(id, { action: 'decline' })
        return
      }
      const pending: PendingApproval = { id, session: l.spec.name, method, offered: [], rule: null, generation: gen, answered: false }
      approvals.set(key, pending)
      const call = toolApprovalCall(params, (threadId, server, tool) => pendingMcpCall(threadId, server, tool))
      // Инструменты, исполняющие код (src/mcp/browser.ts DENIED_BROWSER_TOOLS), Codex прячет `disabled_tools`;
      // если всё же спросил — отказ, человека не спрашиваем.
      if (call.server === BROWSER_SERVER_NAME && DENIED_BROWSER_TOOLS.includes(call.tool)) {
        approvals.delete(key)
        pending.answered = true
        logger.warn('codex спросил запрещённый инструмент браузера — отказ', { session: l.spec.name, tool: call.tool })
        c.respond(id, elicitationAnswer('deny'))
        return
      }
      let answer: PermissionDecision
      try {
        answer = await opts.askPermission({
          sessionId: l.spec.name,
          toolName: `mcp__${call.server}__${call.tool}`,
          ...(str(params['turnId']) ? { toolUseId: `${str(params['turnId'])}:${String(id)}` } : {}),
          ...approvalInput({
            ...(call.args !== null ? { arguments: call.args } : { arguments: 'аргументы не пришли — Codex не прислал их ни в вопросе, ни в начале вызова' }),
            message: params['message'],
          }, ['accept', 'decline']),
        })
      } catch { answer = { behavior: 'deny' } }
      if (pending.answered || approvals.get(key) !== pending) return
      approvals.delete(key)
      pending.answered = true
      if (client?.alive() && generation === gen) client.respond(id, elicitationAnswer(answer.behavior))
      return
    }
    if (!vocab) {
      // Запрос, которого Пульт не умеет (`item/permissions/requestApproval`,
      // `item/tool/requestUserInput`, `mcpServer/elicitation/request`, …). Отвечаем ОШИБКОЙ,
      // а не молчанием: молчащий клиент подвесил бы ход навсегда. И тем более не выдумываем
      // разрешение: подделать «да» от человека нельзя (инвариант 5).
      once(`server-request:${method}`, () => logger.warn('запрос сервера, которого Пульт не умеет — отказ', { method }))
      c.respondError(id, -32601, `pult: запрос ${method} не поддерживается в Ф1 В3`)
      // В журнал сессии — чтобы человек, глядя на странный ход, увидел ПРИЧИНУ, а не гадал.
      const owner = str(params['threadId']) ? threadOwner.get(str(params['threadId']) as string) : undefined
      const l = owner ? live.get(owner.name) : undefined
      if (l && !l.closing) {
        emit({
          sessionId: l.spec.name,
          provider: 'codex',
          kind: 'permission.resolved',
          data: {
            id: `srv-${String(id)}`,
            toolName: method,
            decision: 'deny',
            by: 'unsupported_request',
            message: `pult: запрос ${method} не поддерживается в Ф1 В3 — отвечено ошибкой -32601`,
          },
        })
      }
      return
    }
    const threadId = str(params['threadId'])
    const owner = threadId ? threadOwner.get(threadId) : undefined
    const offered = offeredDecisions(method, params)
    const l = owner ? live.get(owner.name) : undefined
    if (!l || l.closing) {
      once(`approval-unknown-thread`, () => logger.warn('запрос разрешения по незнакомому треду — отказ', { method, threadId }))
      c.respondError(id, -32600, 'pult: запрос по незнакомому треду')
      return
    }
    // Сессия без хозяина разрешений спрашивать не должна вовсе (тред заводится с
    // `approvalPolicy: never`), но если спросила — ответ один: нет.
    if (!l.spec.broker) {
      c.respond(id, { decision: chooseDecision(method, 'deny', offered).decision })
      return
    }
    // ПОВТОРНЫЙ id при живом вопросе. Сервер так делать не должен, но если сделает — id
    // ОТРАВЛЕН для обоих: наш ответ сервер сопоставит с запросом сам, по этому же id, и
    // отличить, кому он адресован, уже нельзя. Поэтому:
    //   * новому отвечаем сразу и самым строгим вариантом (это то, что сервер точно примет
    //     на свой последний запрос);
    //   * старый признаём неотвечаемым: снимаем его из очереди и из Inbox отказом, ответ по
    //     нему НЕ шлём.
    // Затирать первую запись, как делала первая версия, нельзя было вдвойне: решение человека
    // по первому вопросу уходило на провод под вторым, с ЧУЖИМ словарём решений, а настоящее
    // решение по второму терялось молча — при этом брокер отчитывался «решено».
    const poisoned = approvals.get(key)
    if (poisoned && !poisoned.answered) {
      logger.warn('сервер переиспользовал id живого запроса разрешения — отвечаем отказом, старый вопрос снимаем', {
        id: String(id), generation: gen, first: poisoned.method, second: method, firstSession: poisoned.session,
      })
      approvals.delete(key)
      poisoned.answered = true
      opts.cancelPermissions?.(poisoned.session, `сервер переиспользовал id ${String(id)} — вопрос снят отказом`)
      c.respond(id, { decision: chooseDecision(method, 'deny', offered).decision })
      return
    }

    const itemId = str(params['itemId']) ?? randomUUID()
    const approvalId = str(params['approvalId'])
    const scoped = codexScopedOffers(method, params, offered)
    const pending: PendingApproval = { id, session: l.spec.name, method, offered, rule: scoped.rule, generation: gen, answered: false }
    approvals.set(key, pending)

    let decision: PermissionDecision
    try {
      decision = await opts.askPermission({
        sessionId: l.spec.name,
        toolName: APPROVAL_TOOL_NAME[method] ?? method,
        toolUseId: approvalId ? `${itemId}:${approvalId}` : itemId,
        ...approvalInput(params, offered),
        ...(scoped.offers.session || scoped.offers.rule ? { offers: scoped.offers } : {}),
      })
    } catch (e) {
      logger.error('брокер разрешений упал — считаем отказом', { error: (e as Error).message })
      decision = { behavior: 'deny', message: 'pult: брокер разрешений недоступен' }
    }
    // Сверяем ТОЖДЕСТВО записи, а не только наличие ключа: за время ожидания человека по
    // этому же ключу мог появиться другой запрос.
    if (pending.answered || approvals.get(key) !== pending) return
    approvals.delete(key)
    pending.answered = true
    const chosen = chooseDecision(method, decision.behavior, offered, decision.scope, pending.rule)
    if (chosen.downgraded) {
      logger.warn('разрешение понижено до отказа: сервер не предложил ни одного варианта «да»', {
        session: l.spec.name, method, offered,
      })
    }
    if (chosen.narrowed) {
      logger.warn('«да» сужено до одного раза: сервер не предлагал такой ширины', { session: l.spec.name, method, scope: decision.scope })
    }
    // Процесс мог умереть, пока ждали человека: отвечать уже некому. А если он ещё и
    // перезапустился — тем более: в НОВОМ процессе этот id принадлежит кому-то другому.
    if (!client || !client.alive() || generation !== pending.generation) {
      logger.info('решение человека опоздало: процесс сменился', {
        session: pending.session, id: String(id), asked: pending.generation, now: generation,
      })
      return
    }
    client.respond(id, { decision: chosen.decision })
  }

  // --- демультиплексор -------------------------------------------------------

  const applySignal = (l: Live, sig: CodexSignal, own: boolean): void => {
    const ctx = l.turn
    switch (sig.kind) {
      case 'turn_started': {
        if (!own) return
        if (ctx && ctx.providerTurnId === null) ctx.providerTurnId = sig.providerTurnId
        if (!l.confirmed && l.threadId) {
          l.confirmed = true
          // Только ТЕПЕРЬ тред возобновляем, и только теперь его id имеет смысл в реестре.
          emit({
            sessionId: l.spec.name,
            provider: 'codex',
            kind: 'session.started',
            data: { providerSessionId: l.threadId, model: l.spec.model ?? null, cwd: l.spec.cwd, sandbox: l.threadPolicy?.sandbox ?? codexThreadPolicy(l.spec.approval, l.spec.broker).sandbox },
          })
          // До Ф2 О1 `session.started` в свёртке сбрасывал статус в `idle`, а ход в это время ИДЁТ.
          // Свёртка теперь держит working сама; явное подтверждение оставлено — журнал, прочитанный
          // старым клиентом со старой свёрткой, тоже не лжёт посреди хода.
          if (ctx) status(l.spec.name, 'working', { turnId: ctx.turnId, reason: 'turn_started' })
        }
        return
      }
      case 'turn_completed': {
        if (!own || !ctx) return
        if (ctx.providerTurnId !== null && sig.providerTurnId && sig.providerTurnId !== ctx.providerTurnId) return
        if (sig.status === 'completed') {
          ctx.finish({ turnId: ctx.turnId, ok: true, ...(ctx.textParts.length ? { text: ctx.textParts.join('\n') } : {}) })
          return
        }
        if (sig.status === 'interrupted') {
          // С 0.162 (схема 14.10.2026) `Turn.error` бывает и у прерванного хода: прервал сервер, а
          // не человек, — его причина обязана дойти до ленты, а не потеряться за «агент остановлен».
          ctx.finish({
            turnId: ctx.turnId, ok: false, errorCode: 'interrupted',
            message: sig.errorMessage ? `ход ${ctx.turnId} прерван: ${sig.errorMessage}` : `ход ${ctx.turnId} прерван: агент остановлен`,
            ...(ctx.textParts.length ? { text: ctx.textParts.join('\n') } : {}),
          })
          return
        }
        // `failed` и всё незнакомое: текст ошибки сервера обязан дойти до человека целиком.
        ctx.finish({
          turnId: ctx.turnId,
          ok: false,
          errorCode: sig.errorInfo === 'unauthorized' ? 'provider_unavailable' : 'internal',
          message: sig.errorMessage || `ход завершился со статусом ${sig.status}`,
          ...(ctx.textParts.length ? { text: ctx.textParts.join('\n') } : {}),
        })
        return
      }
      case 'text': {
        if (!own || !ctx) return
        ctx.retries = 0
        if (sig.text) ctx.textParts.push(sig.text)
        return
      }
      case 'retry': {
        if (!ctx) return
        ctx.retries += 1
        logger.warn('codex переподключается', { session: l.spec.name, attempt: ctx.retries, message: sig.message })
        if (ctx.retries < RETRY_CEILING) return
        emit({
          sessionId: l.spec.name, provider: 'codex', kind: 'net.blocked',
          data: { reason: 'error_retry_storm', retries: ctx.retries, turnId: ctx.turnId, message: sig.message },
        })
        // Ход снимаем МЕТОДОМ, а не смертью процесса: он общий, и чужие ходы в нём живые.
        if (client && client.alive() && l.threadId && ctx.providerTurnId) {
          void client.request('turn/interrupt', { threadId: l.threadId, turnId: ctx.providerTurnId }, 10_000)
            .catch(() => { /* «no active turn to interrupt» — уже кончился */ })
        }
        ctx.finish({
          turnId: ctx.turnId, ok: false, errorCode: 'blocked_network',
          message: `${ctx.retries} подряд error/willRetry — ход прерван: ${sig.message}`,
        })
        return
      }
      case 'limit': {
        // Лимит — факт про аккаунт: он касается и этой сессии, и соседних.
        // В событие уезжает ТОЛЬКО отредактированная копия снимка (инвариант 7): поля
        // `limitName`/`normalModelSlug`/`rateLimitUpsell` — свободный текст сервера.
        const data = { source: 'limit', reason: sig.info, message: sig.message, ...(limitsSafe ? { snapshot: limitsSafe } : {}) }
        emit({ sessionId: l.spec.name, provider: 'codex', kind: 'limit.hit', data })
        wasLimited = true
        status(l.spec.name, 'limited', { reason: sig.info })
        if (ctx) {
          ctx.finish({ turnId: ctx.turnId, ok: false, errorCode: 'limited', message: sig.message })
        }
        return
      }
      case 'failed': {
        if (!own) { logger.warn('ошибка на треде субагента', { session: l.spec.name, message: sig.message }); return }
        if (!ctx) return
        ctx.finish({
          turnId: ctx.turnId,
          ok: false,
          errorCode: sig.info === 'unauthorized' ? 'provider_unavailable' : 'internal',
          message: sig.message || 'ход провален без текста',
        })
        return
      }
      case 'subagent_started': {
        // Тред ребёнка идёт по тому же соединению и БЕЗ своего `thread/started` (измерено):
        // узнать о нём можно только отсюда. Его события уедут в ту же сессию, но под узлом
        // родителя — так строится дерево `pult agent tree`.
        threadOwner.set(sig.agentThreadId, { name: l.spec.name, parentNodeId: sig.nodeId })
        return
      }
      case 'subagent_finished': {
        threadOwner.delete(sig.agentThreadId)
        return
      }
      case 'tokens': {
        if (!ctx) return
        ctx.tokens.input += sig.input ?? 0
        ctx.tokens.output += sig.output ?? 0
        ctx.tokens.cached += sig.cached ?? 0
        return
      }
      case 'warning': {
        logger.warn('предупреждение app-server', { session: l.spec.name, text: sig.text })
        return
      }
      default:
        return
    }
  }

  const onNotification = (method: string, params: Record<string, unknown>): void => {
    // Уведомления БЕЗ треда — про аккаунт и про протокол целиком.
    if (method === 'account/rateLimits/updated') {
      const snapshot = obj(params['rateLimits'])
      if (snapshot) applyLimits(snapshot, null)
      return
    }
    if (method === 'deprecationNotice') {
      logger.warn('протокол codex изменился (deprecationNotice)', { summary: redactString(str(params['summary']) ?? '') })
      return
    }
    const threadId = str(params['threadId'])
    if (threadId === null) return
    const owner = threadOwner.get(threadId)
    if (!owner) {
      // Тред, о котором мы не знаем: чужой клиент, поздний хвост закрытой сессии, ребёнок,
      // чей `subAgentActivity` мы не увидели. Роняться здесь не из-за чего.
      once(`unknown-thread:${method}`, () => logger.warn('уведомление по незнакомому треду — выброшено', { method, threadId }))
      return
    }
    const l = live.get(owner.name)
    if (!l || l.closing) return
    trackMcpCall(threadId, method, params)
    const own = owner.parentNodeId === undefined
    const mapped = l.mapper.push(method, params, own ? {} : { parentId: owner.parentNodeId as string })
    for (const draft of mapped.drafts) { if (!l.closing && live.get(owner.name) === l) emit(draft) }
    if (mapped.live && !l.closing && live.get(owner.name) === l) for (const sig of mapped.live) opts.live?.(owner.name, sig)
    for (const sig of mapped.signals) applySignal(l, sig, own)
  }

  // --- ход --------------------------------------------------------------------

  /**
   * О3: серверы треда сверх своих серверов Codex — только браузер агента (свои серверы владельца Codex
   * и так берёт из `~/.codex/config.toml`). ИЗМЕРЕНО 14.10.2026 на app-server 0.162: `config.mcp_servers`
   * в `thread/start` поднимает сервер (`mcpServerStatus/list` по треду: `browser` connected), неверное
   * значение `default_tools_approval_mode` — отказ `thread/start` со списком `auto|prompt|writes|approve`.
   * Без брокера браузера нет: спросить разрешение на вызов было бы некого.
   */
  const threadMcpServers = async (l: Live, flags: TurnSettings): Promise<Record<string, Record<string, unknown>>> => {
    if (!opts.mcpExtras || !l.spec.broker) return {}
    const nodeBin = resolveChildNode(process.execPath, readSavedNode(paths.nodePath))
    if (!nodeBin) return {}
    try {
      // M8f: браузер и режим — из снимка хода (`browser: undefined` — снимка нет, решает запись).
      return (await opts.mcpExtras(l.spec.name, nodeBin, flags.browser === undefined ? undefined
        : { ...(flags.approval ? { approval: flags.approval } : {}), browser: flags.browser })).servers
    } catch (e) {
      logger.warn('MCP-серверы треда не собрались — ход без них', { session: l.spec.name, error: (e as Error).message })
      return {}
    }
  }

  /** Запомнить объект песочницы, который вернул сервер (по его `type`). */
  const rememberSandbox = (l: Live, x: unknown): void => {
    const o = obj(x)
    const t = o ? str(o['type']) : null
    if (o && t) l.sandboxObjects[t] = o
  }

  /** Объект `SandboxPolicy` для хода: тот, что вернул сервер; для workspaceWrite — из `config/read`; иначе по схеме. */
  const sandboxObject = async (l: Live, c: AppServerClient, mode: string): Promise<Record<string, unknown>> => {
    const type = sandboxType(mode)
    const known = l.sandboxObjects[type]
    if (known) return known
    if (type !== 'workspaceWrite') return codexSandboxPolicy(mode)
    try {
      const res = await c.request('config/read', { cwd: l.spec.cwd }, controlMs)
      const built = workspaceWriteFromConfig(obj(res['config']))
      l.sandboxObjects[type] = built
      return built
    } catch (e) {
      logger.warn('config/read не удался — песочница хода по умолчаниям схемы', { session: l.spec.name, error: (e as Error).message })
      return { type: 'workspaceWrite' }
    }
  }

  const ensureThread = async (l: Live, c: AppServerClient, flags: TurnSettings): Promise<void> => {
    const servers = await threadMcpServers(l, flags)
    const mcpKey = Object.keys(servers).length ? JSON.stringify(servers) : ''
    if (l.attached && l.threadId) {
      // ИЗМЕРЕНО 15.10.2026 (scripts/smoke-browser.mjs --codex, app-server 0.162): `thread/unsubscribe` +
      // `thread/resume` с другим `config` на ЗАГРУЖЕННОМ треде набор MCP-серверов не меняет — сервер браузера
      // остаётся. Поэтому смена браузера у Codex действует, когда тред заводится заново в новом процессе
      // app-server (перезапуск демона), а лента говорит об этом заметкой — один раз на смену.
      if (l.mcpKey !== mcpKey && l.mcpNotedKey !== mcpKey) {
        l.mcpNotedKey = mcpKey
        logger.info('набор MCP-серверов треда поменялся — Codex применит его в новом процессе app-server', { session: l.spec.name })
        emit({ sessionId: l.spec.name, provider: 'codex', kind: 'browser.install', data: { state: 'pending', reason: CODEX_BROWSER_PENDING } })
      }
      return
    }
    // M8f (ревью): режим — из снимка хода; что ушло на провод, то и запоминается как действующее у треда.
    const policy = codexThreadPolicy(flags.approval, l.spec.broker)
    if (mcpKey) l.pendingMcpKey = mcpKey
    const common: Record<string, unknown> = {
      cwd: l.spec.cwd,
      // M8d: песочница и политика — из режима подтверждений сессии (`codexThreadPolicy`). Инвариант 5:
      // сессия без хозяина разрешений ничего не спрашивает — у неё `never` при любом режиме.
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
      ...(flags.model ? { model: flags.model } : {}),
      ...(mcpKey ? { config: { mcp_servers: servers } } : {}),
    }
    await attachThread(l, c, common, mcpKey, policy)
  }

  const attachThread = async (l: Live, c: AppServerClient, common: Record<string, unknown>, mcpKey: string, policy: { sandbox: string; approvalPolicy: string }): Promise<void> => {
    if (l.threadId && l.confirmed) {
      try {
        const resumed = await c.request('thread/resume', { threadId: l.threadId, excludeTurns: true, ...common }, controlMs)
        // Модель треда — для `context.updated`: поле `model` в ответе обязательное (схема 0.158).
        l.mapper.setModel(str(resumed['model']))
        l.attached = true
        l.mcpKey = mcpKey
        l.threadPolicy = { ...policy }
        rememberSandbox(l, resumed['sandbox'])
        threadOwner.set(l.threadId, { name: l.spec.name })
        logger.info('тред codex возобновлён', { session: l.spec.name, threadId: l.threadId })
        return
      } catch (e) {
        const message = (e as Error).message
        if (!NO_ROLLOUT_RE.test(message)) throw e
        // Разговора на диске нет — возобновлять нечего. Заводим новый тред ПРЯМО СЕЙЧАС:
        // реплика ещё не ушла, токены не потрачены, человеку это чинить незачем.
        logger.warn('тред codex не найден — начинаем новый', { session: l.spec.name, threadId: l.threadId })
        threadOwner.delete(l.threadId)
        l.threadId = null
        l.confirmed = false
      }
    }
    if (l.threadId && !l.confirmed) {
      // Тред завели, но ход на нём так и не начался: такой id возобновить нельзя (измерено).
      threadOwner.delete(l.threadId)
      l.threadId = null
    }
    const res = await c.request('thread/start', common, controlMs)
    const thread = obj(res['thread'])
    const id = thread ? str(thread['id']) : null
    if (id === null) throw new Error('thread/start не вернул threadId')
    l.mapper.setModel(str(res['model']))
    l.threadId = id
    l.attached = true
    l.mcpKey = mcpKey
    l.threadPolicy = { ...policy }
    rememberSandbox(l, res['sandbox'])
    l.confirmed = false
    threadOwner.set(id, { name: l.spec.name })
    logger.info('тред codex заведён', { session: l.spec.name, threadId: id, cwd: l.spec.cwd })
  }

  const runTurn = async (l: Live, text: string, at?: TurnSettings): Promise<TurnStarted> => {
    const name = l.spec.name
    const turnId = `t${++turnSeq}`
    // M8f (ревью, HIGH 3): снимок настроек хода — до первого `await`; `configure` после него — для следующего хода.
    const flags: TurnSettings = at
      ? { ...(at.model ? { model: at.model } : {}), ...(at.effort ? { effort: at.effort } : {}), ...(at.approval ? { approval: at.approval } : {}), browser: at.browser ?? null }
      : { ...(l.spec.model ? { model: l.spec.model } : {}), ...(l.spec.effort ? { effort: l.spec.effort } : {}), ...(l.spec.approval ? { approval: l.spec.approval } : {}) }
    const fail = (errorCode: string, message: string): TurnStarted =>
      ({ turnId, done: Promise.resolve({ turnId, ok: false, errorCode, message }) })

    if (providerBlocked !== null) return fail('provider_unavailable', providerBlocked)
    // ЗАНЯТОСТЬ ПРОВЕРЯЕТСЯ И РЕЗЕРВИРУЕТСЯ СИНХРОННО, до первого `await` (см. `Live.starting`):
    // между проверкой и присвоением `l.turn` стоят страж сети, общий процесс и тред, и раньше
    // в это окно проскакивала вторая реплика.
    if (l.turn || l.starting) return fail('invalid_params', `сессия ${name} уже делает ход`)
    l.starting = true
    // Ревью M8f: тред этого хода может завестись с браузером — знать это нужно СРАЗУ, а не после сборки MCP (установка
    // Playwright MCP — секунды-минуты): `configure` в «без вопросов» в это время отказывает, а не губит каждый ход потом.
    if (flags.browser) l.pendingMcpKey = BROWSER_SERVER_NAME
    try {
      return await startTurn(l, text, turnId, fail, flags)
    } finally {
      // Снимается НА ЛЮБОМ выходе — успех, отказ, исключение: дальше сессию сторожит `l.turn`,
      // который к этому мгновению уже присвоен (или хода нет вовсе).
      l.starting = false
      l.pendingMcpKey = ''
    }
  }

  const startTurn = async (
    l: Live,
    text: string,
    turnId: string,
    fail: (errorCode: string, message: string) => TurnStarted,
    flags: TurnSettings,
  ): Promise<TurnStarted> => {
    const name = l.spec.name
    /** Сессия уехала из-под хода: `agent rm` или заведение заново с тем же именем. */
    const gone = (): boolean => l.closing || live.get(name) !== l
    const emitL = (draft: EventDraft): void => { if (!gone()) emit(draft) }
    const statusL = (s: string, extra: Record<string, unknown> = {}): void => { if (!gone()) status(name, s, extra) }

    /**
     * КОНТРОЛЬНАЯ ТОЧКА ПОСЛЕ КАЖДОГО `await`. Раньше здесь смотрели только на
     * `stopRequested`, а `close()` ставит `closing` и вынимает сессию из `live` — ход,
     * проскочивший проверку занятости, этого не замечал и доходил до `thread/start` +
     * `turn/start` для УДАЛЁННОЙ сессии: `pult agent rm` возвращал управление, а агент
     * продолжал выполнять команды, и его `done` не резолвился никогда (уведомления по его
     * треду демультиплексор уже выбрасывал — хозяина нет).
     * Исход по контракту `interrupt` (`adapters/types.ts`): `errorCode: 'interrupted'`,
     * статус пишет менеджер, а не адаптер.
     */
    const abandoned = (): boolean => gone() || l.stopRequested
    const giveUp = (why: string): TurnStarted => {
      l.stopRequested = false
      // Процесс сессия больше не держит: хода не будет (на точке до `ensureClient` флага и не
      // было — снять его там просто нечего).
      l.usingProcess = false
      // Тред, заведённый уже для снятой сессии, забирает за собой и маршрутную запись:
      // `close()` подмёл `threadOwner` ДО того, как мы её туда положили.
      if (gone() && l.threadId) threadOwner.delete(l.threadId)
      return fail('interrupted', `ход ${turnId} отменён: ${why}`)
    }

    l.stopRequested = false

    // --- страж страны выхода (инвариант 2) ------------------------------------
    const idleMs = now() - l.lastTurnAt
    if (!l.confirmed || idleMs > IDLE_RECHECK_MS || client === null || !client.alive() || netSeen.get(l) !== netGeneration()) {
      // Правило стража сменилось (`settings.set`) — проверка перед этим ходом, даже без простоя. Поколение
      // запоминается только у ПРОЙДЕННОЙ проверки: после отказа следующий ход проверяется снова.
      const gen = netGeneration()
      const check = await netProbe('codex')
      if (!check.ok) {
        emitL({
          sessionId: name, provider: 'codex', kind: 'net.blocked',
          data: { reason: check.reason, loc: check.loc, mode: check.mode, guard: check.guard, ...(check.guardMode ? { guardMode: check.guardMode } : {}), turnId },
        })
        statusL('failed', { reason: 'net_blocked' })
        return fail('blocked_network', netRefusal(check))
      }
      netSeen.set(l, gen)
      l.netEnv = networkEnv(check)
    }
    if (abandoned()) return giveUp('агент остановлен или снят до запуска хода')

    // --- процесс и тред --------------------------------------------------------
    let c: AppServerClient
    try {
      c = await ensureClient(l.netEnv, name)
    } catch (e) {
      const message = (e as Error).message
      statusL('failed', { reason: 'provider_unavailable' })
      return fail((e as { code?: string }).code ?? 'provider_unavailable', message)
    }
    if (abandoned()) return giveUp('агент остановлен или снят до старта хода')
    try {
      await ensureThread(l, c, flags)
    } catch (e) {
      const message = redactString((e as Error).message)
      statusL('failed', { reason: 'thread_failed' })
      // Хода не будет — процесс отпускаем, иначе соседу он навсегда числился бы занятым.
      l.usingProcess = false
      return fail(c.alive() ? 'internal' : 'provider_unavailable', `тред codex не заведён: ${message}`)
    }
    // Тред уже есть, реплики ещё нет: снять ход здесь — бесплатно, дальше он уедет на провод.
    // M8f (ревью, MED-HIGH 4 и MED 5): режим снимка отличается от действующего у треда — ход несёт ровно отличие:
    // политику, если она другая, и песочницу, только если сменился её РЕЖИМ (ask ↔ workspace — одна политика);
    // объект песочницы — тот, что сервер сам вернул раньше, или из `config/read` (не умолчания схемы).
    const target = codexThreadPolicy(flags.approval, l.spec.broker)
    // Страховка (ревью, HIGH 3): загруженный тред уже с браузером, а ход — без вопросов. Набор MCP загруженного треда
    // не меняется, и вызовы браузера шли бы мимо Inbox: ход не уходит (закрыто), до перезапуска демона.
    if (l.spec.broker && target.approvalPolicy === 'never' && l.mcpKey.includes(BROWSER_SERVER_NAME)) {
      const msg = 'браузер подключён к треду Codex в этом процессе app-server, а режим без вопросов пропустил бы его вызовы '
        + 'мимо Inbox — ход не отправлен. Верни режим «спрашивать» или перезапусти демона (pult daemon stop)'
      l.usingProcess = false
      statusL('failed', { turnId, reason: 'browser_never', message: msg })
      return fail('invalid_params', msg)
    }
    const override: Record<string, unknown> = {}
    if (l.threadPolicy && l.threadPolicy.approvalPolicy !== target.approvalPolicy) override['approvalPolicy'] = target.approvalPolicy
    if (l.threadPolicy && l.threadPolicy.sandbox !== target.sandbox) override['sandboxPolicy'] = await sandboxObject(l, c, target.sandbox)
    if (abandoned()) return giveUp('агент остановлен или снят до отправки реплики')

    // --- ход -------------------------------------------------------------------
    let finishOuter: (o: TurnOutcome) => void = () => {}
    const done = new Promise<TurnOutcome>((resolve) => {
      finishOuter = (outcome: TurnOutcome): void => {
        if (ctx.settled) return
        ctx.settled = true
        if (l.turn === ctx) l.turn = null
        // Ход кончился — общий процесс под этой сессией снова свободен для перезапуска.
        l.usingProcess = false
        l.lastTurnAt = now()
        emitL({
          sessionId: name, provider: 'codex', kind: 'usage.updated',
          data: {
            source: 'result',
            totalCostUsd: null,
            durationMs: now() - ctx.startedAt,
            usage: {
              input_tokens: ctx.tokens.input,
              output_tokens: ctx.tokens.output,
              cache_read_input_tokens: ctx.tokens.cached,
            },
          },
        })
        // Ход, снятый стопом, статус НЕ пишет: его пишет менеджер (контракт `interrupt`).
        if (outcome.errorCode !== 'interrupted') {
          statusL(outcome.ok ? 'idle' : 'failed', {
            turnId,
            ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
            // Причина провала — в журнал (Ф2): окно показывает её текстом в ленте и после
            // повторного открытия, а до этого она жила только в ответе `agent.wait`.
            ...(!outcome.ok && outcome.message ? { message: redactString(outcome.message.slice(0, 2000)) } : {}),
          })
        }
        resolve(outcome)
      }
    })
    const ctx: TurnCtx = {
      turnId,
      providerTurnId: null,
      textParts: [],
      retries: 0,
      tokens: { input: 0, output: 0, cached: 0 },
      startedAt: now(),
      settled: false,
      done,
      finish: (o) => { finishOuter(o) },
    }
    l.turn = ctx
    statusL('working', { turnId })
    // Модель снимка — переводчику (`context.updated`), в момент хода, а не смены (ревью, LOW 7).
    if (flags.model) l.mapper.setModel(flags.model)

    try {
      const res = await c.request('turn/start', {
        threadId: l.threadId,
        // Реплика уходит В ТЕЛЕ ЗАПРОСА, никогда в argv (инвариант «промпт не в argv»).
        input: [{ type: 'text', text }],
        ...(flags.model ? { model: flags.model } : {}),
        ...(flags.effort ? { effort: flags.effort } : {}),
        // M8f: режим снимка отличается от действующего у треда — по схеме «для этого хода и следующих».
        ...override,
      }, controlMs)
      l.threadPolicy = { ...target }
      const turn = obj(res['turn'])
      const providerTurnId = turn ? str(turn['id']) : null
      if (providerTurnId && ctx.providerTurnId === null) ctx.providerTurnId = providerTurnId
    } catch (e) {
      const message = redactString((e as Error).message)
      ctx.finish({
        turnId, ok: false,
        errorCode: c.alive() ? 'internal' : 'provider_unavailable',
        message: `turn/start не удался: ${message}`,
      })
      return { turnId, done }
    }
    // Стоп ИЛИ снятие сессии могли прийти между `turn/start` и ответом на него: тогда ход уже
    // живой, и снять его надо здесь — `interrupt`/`close` его ещё не видели (у `close` на этот
    // миг не было даже `providerTurnId`, чтобы позвать `turn/interrupt`).
    if (abandoned() && !ctx.settled) {
      l.stopRequested = false
      void interruptTurn(l, ctx)
    }
    return { turnId, done }
  }

  const interruptTurn = async (l: Live, ctx: TurnCtx): Promise<void> => {
    const c = client
    if (c && c.alive() && l.threadId && ctx.providerTurnId) {
      try {
        await c.request('turn/interrupt', { threadId: l.threadId, turnId: ctx.providerTurnId }, 10_000)
      } catch (e) {
        // ИЗМЕРЕНО 21.09.2026: у сервера на это есть ответ `-32600 no active turn to
        // interrupt` — значит ход уже кончился сам. Это не ошибка.
        logger.info('turn/interrupt не понадобился', { session: l.spec.name, error: (e as Error).message })
      }
    }
    // Ждём подтверждения сервера (`turn/completed` со статусом `interrupted`), но не вечно.
    // Таймер гасится в любом исходе: незакрытое ожидание в пять секунд задерживало бы выход
    // процесса ровно на эти пять секунд после каждого стопа.
    let timer: NodeJS.Timeout | null = null
    const deadline = new Promise<boolean>((res) => { timer = setTimeout(() => res(false), INTERRUPT_SETTLE_MS) })
    const settled = await Promise.race([ctx.done.then(() => true, () => true), deadline])
    if (timer) clearTimeout(timer)
    if (!settled && !ctx.settled) {
      logger.warn('app-server не подтвердил остановку хода — закрываем сами', { session: l.spec.name, turnId: ctx.turnId })
      ctx.finish({
        turnId: ctx.turnId, ok: false, errorCode: 'interrupted',
        message: `ход ${ctx.turnId} прерван: агент остановлен (сервер не подтвердил)`,
      })
    }
  }

  return {
    provider: 'codex',

    async startSession(spec) {
      if (providerBlocked !== null) throw Object.assign(new Error(providerBlocked), { code: 'provider_unavailable' })
      if (live.has(spec.name)) throw Object.assign(new Error(`сессия ${spec.name} уже есть`), { code: 'invalid_params' })
      live.set(spec.name, {
        spec,
        threadId: null,
        attached: false,
        confirmed: false,
        mapper: createCodexMapper({
          sessionId: spec.name,
          images: createImageCapture({ home: opts.paths.home, sessionId: spec.name, cwd: spec.cwd, codexHome: process.env['CODEX_HOME'] }),
          model: spec.model ?? null,
          onUnknown: (what) => logger.warn('незнакомое событие codex — пропущено', { session: spec.name, what }),
        }),
        turn: null,
        starting: false,
        usingProcess: false,
        lastTurnAt: 0,
        closing: false,
        stopRequested: false,
        netEnv: {},
        mcpKey: '',
        threadPolicy: null,
        sandboxObjects: {},
        pendingMcpKey: '',
      })
      // Ни процесса, ни треда: тред без хода не возобновляется (измерено), поэтому заводить
      // его заранее незачем, а выдумывать `providerSessionId` — тем более. Пустая строка
      // честнее случайного uuid: провайдер ещё ничего не подтверждал.
      return { name: spec.name, providerSessionId: '' } satisfies StartedSession
    },

    send(name, text, at) { return runTurn(need(name), text, at) },

    /**
     * ПРЯМОЙ ответ по id запроса провайдера. В Ф1 этим путём НИКТО не ходит, и это не забытый
     * код, а разные двери: `pult perm approve` идёт в брокер, брокер резолвит обещание, а
     * ждёт его `onServerRequest` — то есть решение человека доезжает до провода ТАМ. Метод
     * остаётся частью интерфейса (у opencode в Ф1.5 ответ адресуется именно по id запроса) и
     * рабочим: он ищет запрос в очереди ТЕКУЩЕГО поколения процесса.
     */
    async respondPermission(_name, requestId, decision) {
      const raw: JsonRpcId = /^\d+$/.test(requestId) ? Number(requestId) : requestId
      const key = approvalKey(generation, raw)
      const pending = approvals.get(key)
      if (!pending || pending.answered) {
        throw Object.assign(new Error(`запроса разрешения ${requestId} нет в очереди codex`), { code: 'not_found' })
      }
      approvals.delete(key)
      pending.answered = true
      if (!client || !client.alive()) return
      client.respond(raw, pending.method === 'item/tool/requestUserInput'
        ? { answers: decision.behavior === 'allow' ? decision.answers ?? {} : {} }
        : pending.method === 'mcpServer/elicitation/request'
          ? elicitationAnswer(decision.behavior)
          : { decision: chooseDecision(pending.method, decision.behavior, pending.offered, decision.scope, pending.rule).decision })
    },

    async interrupt(name) {
      const l = live.get(name)
      if (!l) return
      // Флаг ставится ВСЕГДА, даже когда хода ещё нет: он может сидеть на `await` стража сети
      // или спавна и родиться мгновением позже — тогда его снимет сам `runTurn`.
      l.stopRequested = true
      // Остановленный агент не должен оставлять за собой вопрос в Inbox: человек нажал «стоп»,
      // а не «подумаю». Ответить на него всё равно будет нечему — ход снимается.
      dropApprovals(name, 'агент остановлен')
      const ctx = l.turn
      if (!ctx) return
      await interruptTurn(l, ctx)
      // `status.changed interrupted` здесь НЕ пишется: хозяин этого события — менеджер.
    },

    async resume(name, rec) {
      // Ничего не спавним: процесс поднимет сам ход. Оживает РАЗГОВОР, а не процесс.
      if (live.has(name)) return
      const threadId = rec.providerSessionId ?? null
      live.set(name, {
        spec: {
          name,
          cwd: rec.cwd,
          ...(rec.model ? { model: rec.model } : {}),
          ...(rec.effort ? { effort: rec.effort } : {}),
          mode: rec.mode,
          ...(rec.settingSources ? { settingSources: rec.settingSources } : {}),
          broker: true,
          // M8d: режим подтверждений переживает рестарт демона — тред возобновится с той же песочницей.
          ...(rec.approval ? { approval: rec.approval } : {}),
        },
        threadId,
        attached: false,
        // Реестр хранит `providerSessionId` только подтверждённый (его пишет менеджер по
        // `session.started`, а его — первый `turn/started`). Значит записанный тред точно
        // пережил хотя бы один ход и возобновляем.
        confirmed: threadId !== null,
        mapper: createCodexMapper({
          sessionId: name,
          images: createImageCapture({ home: opts.paths.home, sessionId: name, cwd: rec.cwd, codexHome: process.env['CODEX_HOME'] }),
          model: rec.model ?? null,
          onUnknown: (what) => logger.warn('незнакомое событие codex — пропущено', { session: name, what }),
        }),
        turn: null,
        starting: false,
        usingProcess: false,
        lastTurnAt: 0,
        closing: false,
        stopRequested: false,
        netEnv: {},
        mcpKey: '',
        threadPolicy: null,
        sandboxObjects: {},
        pendingMcpKey: '',
      })
      if (threadId) threadOwner.set(threadId, { name })
    },

    configure(name, next, force) {
      const l = live.get(name)
      if (!l) return 'next_turn'
      const before = l.spec.approval ?? 'ask'
      const after = next.approval ?? 'ask'
      // Браузер уже подключён к загруженному треду, а набор MCP у загруженного треда не меняется (замер О3):
      // в режиме без вопросов (`approvalPolicy: never`) его вызовы шли бы мимо Inbox. Отказ, а не тихий риск.
      // То же, если тред с браузером заводится прямо сейчас (ревью, MED-HIGH 4): через мгновение он будет загружен.
      const browserLoaded = (l.attached && l.mcpKey.includes(BROWSER_SERVER_NAME)) || l.pendingMcpKey.includes(BROWSER_SERVER_NAME)
      if (!force && before !== after && (after === 'workspace' || after === 'full') && browserLoaded) {
        throw Object.assign(new Error('браузер уже подключён к треду Codex в этом процессе app-server — режим без вопросов '
          + 'пропустил бы его вызовы мимо Inbox. Выключи браузер, перезапусти демона (pult daemon stop), потом смени режим'), { code: 'invalid_params' })
      }
      const spec = l.spec as unknown as Record<string, unknown>
      for (const k of ['model', 'effort', 'approval'] as const) {
        if (next[k] === undefined) delete spec[k]
        else spec[k] = next[k]
      }
      // Политику и песочницу треда следующий ход сравнит со снимком сам (`threadPolicy`) — флагов тут не нужно.
      return 'next_turn'
    },

    async close(name) {
      const l = live.get(name)
      if (!l) return
      l.closing = true
      // Закрытая сессия общий процесс не держит (её ещё и из `live` вынут — но флаг снимаем
      // явно: тот же объект может дожить в замыкании уже начатого `runTurn`).
      l.usingProcess = false
      dropApprovals(name, 'сессия закрыта')
      const ctx = l.turn
      if (ctx) {
        ctx.finish({ turnId: ctx.turnId, ok: false, errorCode: 'interrupted', message: `ход ${ctx.turnId} снят: сессия закрыта` })
      }
      const threadId = l.threadId
      if (threadId) {
        for (const [id, owner] of [...threadOwner]) if (owner.name === name) threadOwner.delete(id)
        // Закрываем ТРЕД, а не процесс: он общий. ИЗМЕРЕНО 21.09.2026 — ответ
        // `{status: "unsubscribed"}`, повторный вызов `{status: "notSubscribed"}`.
        if (client && client.alive() && l.attached) {
          try {
            if (ctx && ctx.providerTurnId) {
              await client.request('turn/interrupt', { threadId, turnId: ctx.providerTurnId }, 5_000).catch(() => undefined)
            }
            await client.request('thread/unsubscribe', { threadId }, 10_000)
          } catch (e) {
            logger.info('thread/unsubscribe не удался', { session: name, error: (e as Error).message })
          }
        }
      }
      live.delete(name)
      status(name, 'done', {})
    },

    blocked: () => (providerBlocked === null ? { blocked: false } : { blocked: true, reason: providerBlocked }),

    reset() {
      if (providerBlocked === null) return
      logger.info('остановка провайдера codex снята', {})
      providerBlocked = null
      restarts = []
    },

    async shutdown() {
      // Флаг ПЕРВЫМ и НАВСЕГДА: спавн, который сейчас в полёте, увидит его и убьёт своего
      // ребёнка сам. Снимать флаг в конце нельзя — тогда поздний спавн снова считал бы себя
      // законным, и `codex app-server` переживал бы `pult daemon stop` (правка по ревью В3).
      shuttingDown = true
      for (const l of live.values()) l.closing = true
      // Спавн в полёте дожидаем: его ребёнок ещё никому не известен, и снять его больше некому.
      const inflight = starting
      if (inflight) {
        try {
          const late = await inflight
          await killClient(late)
        } catch { /* спавн сам всё убрал: либо не удался, либо увидел флаг */ }
      }
      const c = client
      client = null
      if (c) {
        // Лестница с ПРОВЕРКОЙ выхода: сирот после остановки демона быть не должно.
        await killClient(c)
      }
      // Ходы, которые не успел закрыть `onExit` (например, процесса не было вовсе).
      for (const l of live.values()) {
        const ctx = l.turn
        if (ctx) ctx.finish({ turnId: ctx.turnId, ok: false, errorCode: 'provider_unavailable', message: 'демон останавливается' })
      }
      live.clear()
      threadOwner.clear()
      approvals.clear()
    },
  }
}
