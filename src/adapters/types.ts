// Интерфейс адаптера провайдера. Один на всех: В2 даёт Claude, В3 даст Codex, Ф1.5 — opencode.
//
// КАК СЮДА ЛЯЖЕТ CODEX (В3), и почему интерфейс не придётся менять.
// Claude — процесс НА СЕССИЮ: `startSession` порождает (или готовит к порождению) свой
// дочерний процесс, `send` пишет ему в stdin, `close` его гасит. Codex устроен наоборот —
// ОДИН процесс `codex app-server` на всех, а сессии внутри него это треды (`threadId`).
// Интерфейс этого не замечает, потому что он говорит про СЕССИЮ, а не про процесс:
//   * `startSession` у Codex не спавнит ничего, если app-server уже поднят, — он заводит тред
//     и запоминает `threadId` в `providerSessionId`;
//   * `send` уходит в общий stdin с `threadId` в теле, а не в stdin «своего» процесса;
//   * демультиплексор адаптера разбирает уведомления по `threadId` и зовёт `onEvent` нужной
//     сессии — снаружи это тот же поток событий, что у Claude;
//   * `respondPermission` у Claude идёт через брокер и MCP-заглушку, у Codex — ответом на
//     JSON-RPC-запрос по его id; поэтому в подписи не «id брокера», а непрозрачный `requestId`;
//   * `close` у Codex закрывает тред и НЕ гасит общий процесс — его гасит `shutdown()`.
// Единственное, что пришлось заложить заранее, — `shutdown()` уровня адаптера и то, что
// `startSession` возвращает `providerSessionId` как строку без обещаний о её смысле.

import type { EventDraft } from '../core/events.js'
import type { SessionMode, SessionProvider, SessionRecord } from '../sessions/registry.js'
import type { LiveSignal } from '../sessions/phaseTracker.js'
import type { RuleGrant } from '../perm/codexRules.js'
import type { CodexReload } from '../perm/rulesText.js'

/**
 * M8d (решение владельца 19.10.2026, пересмотр инварианта 5 Ф1): насколько широко «да».
 *   * `once` — ровно это действие (по умолчанию; ⌘Enter и голое `pult perm approve` — всегда оно);
 *   * `session` — это и такие же до конца сессии провайдера (`acceptForSession` у Codex);
 *   * `rule` — постоянное правило в настройках САМОГО провайдера (`acceptWithExecpolicyAmendment`,
 *     `applyNetworkPolicyAmendment` у Codex). С плана 16 (№ 11) Пульт метит такую строку и умеет её отозвать
 *     (src/perm/codexRules.ts, «Настройки» → «Правила „Всегда“», `pult perm rules`).
 * Шире `once` — только если провайдер ЭТОТ запрос так предложил (`PermissionOffers`); иначе отказ на входе.
 */
export type PermissionScope = 'once' | 'session' | 'rule'

export const PERMISSION_SCOPES: readonly PermissionScope[] = ['once', 'session', 'rule']

/** Что провайдер предложил сверх «один раз» на конкретный запрос. Нет поля — нет и кнопки. */
export interface PermissionOffers {
  session?: true
  /**
   * Постоянное правило: `execpolicy` — префикс команды (`label` — он же строкой), `network` — хост, куда
   * пускать (`label` — хост). `note` — где правило будет жить: карточка говорит это словами.
   */
  rule?: { kind: 'execpolicy' | 'network'; label: string; note: string }
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny'
  /** Только у `allow`; нет — `once`. */
  scope?: PermissionScope
  message?: string
  updatedInput?: Record<string, unknown>
  answers?: Record<string, { answers: string[] }>
}

/**
 * M8d: как подтверждать действия — выбирается при заведении сессии и живёт в её записи.
 *   * `read-only` — только читать (Codex: песочница read-only; Claude: `--permission-mode plan`);
 *   * `ask` — по умолчанию, как было до M8d: всё шире рабочей папки — через Inbox;
 *   * `workspace` — правки в рабочей папке без вопросов (Codex: workspace-write + never; Claude: acceptEdits);
 *   * `full` — что угодно без вопросов и без песочницы (Codex: danger-full-access + never; Claude: bypassPermissions).
 */
export type ApprovalMode = 'read-only' | 'ask' | 'workspace' | 'full'

export const APPROVAL_MODES: readonly ApprovalMode[] = ['read-only', 'ask', 'workspace', 'full']

export function isApprovalMode(x: unknown): x is ApprovalMode {
  return typeof x === 'string' && (APPROVAL_MODES as readonly string[]).includes(x)
}

/** M8f: то, что меняет `agent.configure` у живой сессии. */
export interface SessionSettingsPatch {
  model?: string
  effort?: string
  approval?: ApprovalMode
}

/**
 * M8f (ревью): настройки, с которыми идёт ЭТОТ ход, — снимок, сделанный менеджером в начале `prompt`, до первого
 * `await`. Процесс, тред, политика и набор MCP строятся только из него: `agent.configure`, пришедший, пока ход
 * заводится, — для следующего хода. `browser` — `null`/нет: браузера нет.
 */
export interface TurnSettings extends SessionSettingsPatch {
  browser?: { headed?: boolean } | null
}

export interface SessionSpec {
  name: string
  cwd: string
  model?: string
  effort?: string
  mode: SessionMode
  forkOnResume?: boolean
  /** Источники настроек CLI (`--setting-sources`); отсутствие = флаг не передаётся. */
  settingSources?: string
  /** Есть ли кому отвечать на запросы разрешений. Нет — нода идёт с запретом (инвариант 5). */
  broker: boolean
  /** M8d: как подтверждать действия; нет — `ask` (так жили все сессии до M8d). */
  approval?: ApprovalMode
}

/** Чем закончился ход. `turnId` совпадает с тем, что вернул `send`. */
export interface TurnOutcome {
  turnId: string
  ok: boolean
  /** Код ошибки протокола, если ход не удался: blocked_network | provider_unavailable | … */
  errorCode?: string
  message?: string
  /** Текст, который модель сказала за этот ход. */
  text?: string
}

/**
 * Ход НАЧАТ. `turnId` отдаётся сразу — `pult agent prompt` без `--wait` обязан вернуть его,
 * не дожидаясь модели. `done` резолвится, когда ход действительно закончен.
 */
export interface TurnStarted {
  turnId: string
  done: Promise<TurnOutcome>
}

export interface StartedSession {
  name: string
  providerSessionId: string
}

export interface AdapterDeps {
  /** Единственная дверь в журнал: адаптер сам не пишет файлы. */
  emit(draft: EventDraft): void
  /**
   * 0.3.5: живой сигнал хода — провайдер отозвался, новое обращение к модели, размышления (src/sessions/phaseTracker.ts).
   * МИМО журнала: по нему окно рисует строку «думает…», а текст размышлений эфемерен. Нет функции — сигналов нет.
   */
  live?(sessionId: string, sig: LiveSignal): void
  /** Спросить человека. Резолвится решением; таймаут и отказ — забота брокера. */
  askPermission(req: {
    sessionId: string
    toolName: string
    toolUseId?: string
    input: Record<string, unknown>
    /** M8d: что провайдер предложил сверх «один раз» (кнопки «В этой сессии» / «Всегда …»). */
    offers?: PermissionOffers
    /** Адаптер сам скрыл или подрезал часть входа до брокера (Codex) — карточка скажет «показано не всё». */
    concealed?: boolean
  }): Promise<PermissionDecision>
  /**
   * Снять ВСЕ ожидающие вопросы этой сессии ОТКАЗОМ; возвращает, сколько сняли.
   *
   * Понадобился в В3 и только там. У Claude вопрос задаёт заглушка `pult mcp-ask` — свой
   * процесс на сессию, и когда спрашивающий умирает, умирает и она. У Codex вопрос живёт в
   * ОБЩЕМ процессе app-server: если он упал, отвечать по его id уже некому, а вопрос в Inbox
   * остаётся — человек жмёт `pult perm approve`, и решение уходит в никуда. Поэтому адаптер
   * обязан уметь сказать брокеру «этих уже не спрашивают» (инвариант 5: молчание = отказ).
   * Необязательный: адаптер, которому это не нужно, его не получает.
   */
  cancelPermissions?(sessionId: string, reason: string): number
  /**
   * О3: MCP-серверы сессии СВЕРХ заглушки разрешений — браузер агента и выбранные владельцем
   * (src/mcp/session.ts). Зовётся перед КАЖДЫМ запуском процесса Claude и перед заведением треда
   * Codex: включённый посреди сессии браузер действует со следующего хода, без перезаведения.
   * `nodeBin` — node, которым адаптер и так запускает свои серверы. Не бросает: что не собралось —
   * того сервера просто нет (с заметкой в журнале). Нет функции — серверов сверх своих нет.
   * `at` (M8f) — снимок хода: режим и браузер берутся из него, а не из записи, которую мог сменить `configure`.
   */
  mcpExtras?(name: string, nodeBin: string, at?: TurnSettings): Promise<SessionMcpExtras>
  /**
   * План 16, № 11: человек нажал «Всегда …», и ответ-поправка сейчас уйдёт провайдеру. Зовётся ДО ответа — демон
   * снимает слепок файла правил и метит строку, которую codex допишет (src/perm/codexRules.ts). Не бросает.
   */
  ruleGranted?(grant: RuleGrant): void
}

/** Что добавить сессии: серверы и правила разрешений. */
export interface SessionMcpExtras {
  /** Имя → запись сервера (у Claude — `mcpServers` файла `--mcp-config`, у Codex — `mcp_servers` треда). */
  servers: Record<string, Record<string, unknown>>
  /**
   * Правила разрешений Claude (`--settings {"permissions": …}`), О3:
   *   * `ask` — браузер спрашивает ВСЕГДА, даже при `defaultMode: auto` у владельца (классификатор Claude
   *     иначе разрешает сам, и до Inbox вопрос не доходит);
   *   * `deny` — инструменты, исполняющие произвольный код (`browser_run_code_unsafe`, `browser_evaluate`);
   *   * `allow` — только `Read(//<скачивания>/**)`: снимок страницы `browser_navigate` кладёт файлом туда,
   *     агент читает его без вопроса; записи туда это правило не даёт.
   * Нет поля — флага нет.
   */
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] }
}

export interface ProviderAdapter {
  readonly provider: SessionProvider
  /** Готовит сессию: проверяет сеть, заводит идентификатор, при `warm` — поднимает процесс. */
  startSession(spec: SessionSpec): Promise<StartedSession>
  /**
   * Начать ход. Резолвится, когда ход ЗАПУЩЕН; конец ждут через `done`. `at` — снимок настроек хода (M8f); нет —
   * текущие настройки сессии в адаптере на момент вызова.
   */
  send(name: string, text: string, at?: TurnSettings): Promise<TurnStarted>
  /** Ответ на запрос разрешения по непрозрачному id провайдера (у Claude не используется). */
  respondPermission(name: string, requestId: string, decision: PermissionDecision): Promise<void>
  /**
   * SIGINT, затем SIGTERM после отсрочки.
   *
   * КОНТРАКТ (он же для адаптера Codex в В3): незакрытый ход обязан завершиться с
   * `errorCode: 'interrupted'` — не `internal`, — а `status.changed` адаптер по стопу НЕ
   * пишет вообще. Событие `interrupted` пишет менеджер: статус сессии вычисляется в одном
   * месте, и писали бы оба — в журнале было бы по два `interrupted` на каждый `agent stop`.
   */
  interrupt(name: string): Promise<void>
  /**
   * Поднять сессию заново после рестарта демона: процесс не оживает, оживает разговор.
   *
   * ОБЯЗАН БЫТЬ ИДЕМПОТЕНТНЫМ и не спавнить НИЧЕГО: менеджер зовёт его перед каждым ходом,
   * не спрашивая, знакома ли адаптеру сессия. Знакомую — оставить как есть, незнакомую —
   * восстановить из записи (cwd, model, effort, mode, settingSources), и только.
   */
  resume(name: string, rec: SessionRecord): Promise<void>
  /**
   * Закрыть сессию. Как и `interrupt`, НЕЗНАКОМУЮ сессию обязан принять молча: после
   * рестарта демона адаптер не знает ни одной, а `agent rm` и `agent stop` должны работать
   * и по такой — запись из реестра всё равно уходит, `session.ended` всё равно пишется.
   */
  close(name: string): Promise<void>
  /**
   * M8f: модель, усилие или режим подтверждений сессии сменили (`agent.configure`). `next` — НОВЫЕ значения
   * целиком (`undefined` — снять). Действует со следующего хода, идущий ход не трогается. Незнакомую сессию
   * (после рестарта демона, до первого хода) принять молча: `resume` возьмёт значения из записи. Бросает
   * (`code: 'invalid_params'`), если смену честно применить нельзя — запись тогда не меняется.
   * Отдаёт, когда смена вступит в силу. `force` — только откат к прежним (уже бывшим в силе) настройкам: без отказов.
   */
  configure?(name: string, next: SessionSettingsPatch, force?: boolean): 'next_turn' | 'after_background'
  /** Провайдер целиком остановлен (`provider.blocked`)? */
  blocked(): { blocked: boolean; reason?: string }
  /** Снять остановку провайдера — метод демона `provider.reset`. */
  reset(): void
  /**
   * План 16, № 11: правило «Всегда» отозвано — провайдер должен перечитать правила. Codex держит их в памяти процесса,
   * поэтому общий процесс перезапускается, как только ходов нет (`restarted`), иначе — после них (`deferred`); процесса
   * нет — `not_running`. Идущие ходы не рвутся. Живым сессиям — заметка в ленту. `why` — что отозвано, словами.
   */
  reloadPolicy?(why: string): CodexReload
  /** Погасить всё: тёплые процессы, общий процесс Codex, таймеры. */
  shutdown(): Promise<void>
}
