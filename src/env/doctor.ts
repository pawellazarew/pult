import { t } from '../cli/i18n.js'
// `pult doctor` — свод состояния машины. Каждая строка: ok | warn | fail + ТОЧНАЯ команда,
// которой это чинят. Всё, что ходит наружу (запуск CLI, сеть, сокет демона), инъецируется:
// тест гоняет доктора на фальшивках и не трогает ни настоящие CLI, ни сеть.
//
// НИ ОДНОГО СИНХРОННОГО ЗАПУСКА. `doctor.run` идёт в процессе демона, а окно зовёт его при каждом
// открытии. КАК ЛОМАЛОСЬ (замер 30.09.2026, настоящий launchd): логин-шелл, семь `--version`,
// `claude auth status` и `codex login status` шли через `spawnSync` подряд — 19 с тишины на тестовой
// службе, 44–94 с на рабочей; четыре команды CLI подряд упали с «демон не ответил на hello».
// Теперь всё это — асинхронные запуски, идущие разом (env/exec.ts), а между ними демон отвечает.

import { lstatSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkCodexSchema } from '../adapters/codex/schema.js'
import type { CodexSchemaCheck } from '../adapters/codex/schema.js'
import type { PultConfig, ProviderName } from '../core/config.js'
import { PROVIDERS } from '../core/config.js'
import { redactString } from '../core/log.js'
import type { PultPaths } from '../core/paths.js'
import type { DaemonNode, DaemonStatus } from '../core/rpc.js'
import { buildChildEnv } from './allowlist.js'
import { codexNetworkItems } from './codexConfig.js'
import { execAsync } from './exec.js'
import { cmd } from './fixCmd.js'
import type { LocateDeps, LocatedTool, ToolName } from './locate.js'
import { codexInsideChatGPTApp, locateAllAsync } from './locate.js'
import { loginShellPath } from './loginShell.js'
import type { NetCheck } from './net.js'
import { checkNetwork, netLine } from './net.js'
import { guardLine, guardOff } from '../core/guard.js'

export type DoctorStatus = 'ok' | 'warn' | 'fail'

export interface DoctorItem {
  id: string
  title: string
  status: DoctorStatus
  detail: string
  /** Что сделать, чтобы починить: команда или совет словами (печатает `pult doctor`). */
  fix?: string
  /**
   * Команда, которую можно выполнить в терминале как есть, — только она идёт в окне в моноширинную
   * рамку с кнопкой «копировать». Совет словами («установи claude и…») в терминале бесполезен:
   * вставленный, он даёт `command not found`. Нет поля — починка только словами.
   */
  fixCmd?: string
  data?: Record<string, unknown>
}

export interface DoctorReport {
  ok: boolean
  generatedAt: string
  home: string
  items: DoctorItem[]
  counts: Record<DoctorStatus, number>
}

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Запуск CLI. Настоящий — асинхронный; синхронный ответ разрешён только ради фальшивок в тестах. */
export type RunFn = (file: string, args: string[], timeoutMs: number) => RunResult | Promise<RunResult>

export interface DoctorDeps {
  paths: PultPaths
  config: PultConfig
  /** Получает ровно те deps, что доктор собрал бы для настоящего поиска. */
  locate?: (deps: LocateDeps) => Record<ToolName, LocatedTool> | Promise<Record<ToolName, LocatedTool>>
  /** PATH, по которому ищутся и запускаются CLI. По умолчанию — PATH логин-шелла. */
  pathEntries?: string[]
  run?: RunFn
  net?: (provider: ProviderName) => Promise<NetCheck>
  daemonStatus?: () => Promise<DaemonStatus | null>
  nodeVersion?: string
  mode?: (path: string) => number | null
  /** Сеть стоит секунды; `pult doctor --no-net` и тесты её выключают. */
  skipNet?: boolean
  /** Инъекция сверки схемы codex: тест не запускает настоящий CLI и ничего не пишет на диск. */
  codexSchema?: (bin: string) => Promise<CodexSchemaCheck>
  /**
   * Пункты про службу (В4, src/service/doctor.ts). Инъекцией: тесты доктора не трогают ни файл
   * службы, ни менеджер служб; CLI и демон передают настоящие. Демон — асинхронные, из потока
   * (src/service/doctor.ts, serviceDoctorItemsAsync): синхронный опрос launchctl морозил весь демон.
   */
  serviceItems?: () => DoctorItem[] | Promise<DoctorItem[]>
  /**
   * Пункты про версии (В4, src/update/doctor.ts): `current` и расхождение с версией работающего
   * демона. Получают ответ `daemon.status`, который доктор уже спросил, — второй раз не ходим.
   */
  versionItems?: (daemon: DaemonStatus | null) => DoctorItem[]
  /**
   * О3: браузер агента и свои MCP-серверы (src/mcp/doctor.ts). Получают ответ `daemon.status`: у демона
   * в нём состояние установки браузера и число сессий, которым он нужен.
   */
  mcpItems?: (daemon: DaemonStatus | null) => DoctorItem[] | Promise<DoctorItem[]>
  /** Домашний каталог — где искать `~/.local/bin/codex` для совета `ln -sf`. По умолчанию homedir(). */
  home?: string
  /** Что лежит по пути симлинка (lstat, без перехода по ссылке). Инъекцией: тест не смотрит на диск машины. */
  linkState?: (path: string) => LinkState
  /**
   * 0.3.7: config.toml codex — доктор предупреждает о сети в песочнице (src/env/codexConfig.ts). Нет поля — пункта
   * нет: тесты доктора не читают файл машины; CLI и демон передают путь.
   */
  codexConfig?: string
}

export type LinkState = 'symlink' | 'missing' | 'other'

export const MIN_NODE_MAJOR = 22

const makeRun = (pathEntries: string[]): RunFn => (file, args, timeoutMs) => execAsync(file, args, {
  timeoutMs,
  // Тот же PATH, по которому CLI и нашли: иначе `claude`, найденный в PATH логин-шелла,
  // запускается с PATH, в котором нет его же node.
  env: buildChildEnv(process.env, pathEntries.length ? { path: pathEntries.join(':') } : {}),
})

const defaultLinkState = (p: string): LinkState => {
  try { return lstatSync(p).isSymbolicLink() ? 'symlink' : 'other' } catch { return 'missing' }
}

const defaultMode = (p: string): number | null => {
  try { return statSync(p).mode & 0o777 } catch { return null }
}

/**
 * ИЗМЕРЕНО спайком (DELTA v0.4 §5): при `loggedIn: false` команда печатает КОРРЕКТНЫЙ JSON и
 * выходит с кодом 1. Читаем stdout, код выхода игнорируем — иначе «не вошёл» неотличимо от
 * «команда сломалась».
 */
export function parseClaudeAuth(stdout: string): { loggedIn: boolean | null; raw: unknown } {
  const text = stdout.trim()
  if (!text) return { loggedIn: null, raw: null }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const v = parsed['loggedIn']
    return { loggedIn: typeof v === 'boolean' ? v : null, raw: parsed }
  } catch {
    // Иногда перед JSON идёт мусор из stdout — вытаскиваем первый объект.
    const i = text.indexOf('{')
    if (i >= 0) {
      try {
        const parsed = JSON.parse(text.slice(i)) as Record<string, unknown>
        const v = parsed['loggedIn']
        return { loggedIn: typeof v === 'boolean' ? v : null, raw: parsed }
      } catch { /* мусор */ }
    }
    return { loggedIn: null, raw: redactString(text.slice(0, 200)) }
  }
}

/**
 * Тип подписки из `claude auth status --json` (Claude Code 2.1.283, 28.09.2026:
 * `subscriptionType: "team"`, `authMethod: "claude.ai"`). Из ответа берутся РОВНО эти два поля:
 * рядом лежат почта и организация, а инвариант 7 не пускает их ни в отчёт, ни в журнал.
 * Значение принимается, только если похоже на короткий идентификатор: любое другое (вдруг CLI
 * положит туда адрес или имя организации) превращается в null, а не в строку отчёта.
 */
export function claudeSubscription(raw: unknown): { subscriptionType: string | null; authMethod: string | null } {
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const safe = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(v) ? v : null)
  return { subscriptionType: safe(obj['subscriptionType']), authMethod: safe(obj['authMethod']) }
}

/**
 * Что тратит Пульт. Дочерний `claude` живёт в том же HOME, что и терминальный, и берёт его вход —
 * отдельной учётки у Пульта нет. Поэтому строка доктора говорит не «какая у тебя подписка», а
 * «лимиты какой подписки съедят ходы агентов» (10-PLAN-hermes-ideas.md, «Попутно»).
 */
/**
 * На каком node работает демон (0.2.18). Удалённый бинарь — fail: это ровно поломка 14.10.2026,
 * когда brew upgrade node удалил node живого демона и macOS перестала пускать агентов в ~/Desktop.
 */
export function daemonNodeItem(node: DaemonNode): DoctorItem {
  if (!node.alive) {
    return {
      id: 'daemon.node',
      title: t('Node демона'),
      status: 'fail',
      detail: t`node демона ${node.path} (${node.version}) удалён или заменён обновлением (brew upgrade?) — macOS не пустит `
        + t('агентов в ~/Desktop, ходы claude там падают с «An unknown error occurred (Unexpected)». Перезапусти демона'),
      ...cmd('pult daemon stop && pult daemon start'),
    }
  }
  if (!node.own) {
    return {
      id: 'daemon.node',
      title: t('Node демона'),
      status: 'warn',
      detail: t`системный node ${node.path} (${node.version}) — его обновление (brew upgrade node) уронит доступ агентов к ~/Desktop. `
        + t('Свой node Пульта: pult runtime install, затем перезапуск демона'),
      ...cmd('pult runtime install && pult daemon stop && pult daemon start'),
    }
  }
  return { id: 'daemon.node', title: t('Node демона'), status: 'ok', detail: t`свой node Пульта ${node.version}: ${node.path}` }
}

function claudeSubscriptionItem(loggedIn: boolean | null, raw: unknown): DoctorItem {
  const { subscriptionType, authMethod } = claudeSubscription(raw)
  const how = authMethod ? t`, вход ${authMethod}` : ''
  // null — ответ `auth status` не разобран (CLI сменил формат, мусор в stdout). Это НЕ «не вошёл»:
  // строка входа выше так и пишет «ответ не разобран», и строка подписки не имеет права
  // противоречить ей советом `claude /login` — вход, скорее всего, есть, неизвестен только тип.
  if (loggedIn === null) {
    return {
      id: 'subscription.claude',
      title: t('Подписка claude'),
      status: 'warn',
      detail: t('вход не разобран — тип подписки неизвестен'),
      ...cmd('claude auth status'),
      data: { subscriptionType, authMethod },
    }
  }
  if (loggedIn === false) {
    return {
      id: 'subscription.claude',
      title: t('Подписка claude'),
      status: 'warn',
      detail: t('не вошёл — ходам агентов claude тратить нечего'),
      ...cmd('claude /login'),
      data: { subscriptionType, authMethod },
    }
  }
  return {
    id: 'subscription.claude',
    title: t('Подписка claude'),
    status: subscriptionType ? 'ok' : 'warn',
    detail: subscriptionType
      ? t`${subscriptionType}${how} — ходы агентов Пульта тратят лимиты ЭТОЙ подписки: той, в которую вошёл терминальный claude`
      : t`тип подписки не сообщён${how} — ходы Пульта тратят тот вход, что у терминального claude`,
    ...(subscriptionType ? {} : cmd('claude auth status')),
    data: { subscriptionType, authMethod },
  }
}

/**
 * Первая непустая строка `codex login status`. Текст входа codex печатает в stderr, а не в stdout
 * (вывод, не замер: так пишет `eprintln!` в codex-rs), поэтому смотрим оба потока — stdout первым.
 * Строка может нести ключ (`Logged in using an API key - sk-…`), поэтому только через redactString.
 */
export function codexLoginLine(r: RunResult): string {
  for (const text of [r.stdout, r.stderr]) {
    const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
    if (line) return redactString(line).slice(0, 160)
  }
  return ''
}

/**
 * Совет для codex внутри ChatGPT.app. Зависит от того, КАК найден бинарь.
 *  - Через живой симлинк (`~/.local/bin/codex` → пакет): чинить нечего. `ln -sf <его цель> <он>`
 *    ничего не меняет, а после переезда внутри пакета цель уже неверна — такую команду не печатаем.
 *  - Напрямую в пакете (realpath = путь): так бывает, когда симлинк ПОВИС (случай 26.924 —
 *    `locate` не принимает висящую ссылку и проваливается к `CHATGPT_CODEX_PATHS`) или его нет.
 *    Тогда и только тогда нужна команда, и она указывает НАЙДЕННЫЙ путь → `~/.local/bin/codex`.
 *  - На месте симлинка обычный файл: не наш, не трогаем.
 */
function chatgptCodexFix(tool: LocatedTool, home: string, linkState: (p: string) => LinkState): { fix: string; fixCmd?: string } {
  if (tool.path && tool.realpath && tool.realpath !== tool.path) {
    return { fix: t('ничего не ломается; после обновления ChatGPT.app перезапусти pult doctor — если симлинк повиснет, здесь будет команда починки') }
  }
  const link = join(home, '.local/bin/codex')
  const state = tool.path && tool.path !== link ? linkState(link) : 'other'
  if (state === 'symlink') {
    const c = `ln -sf ${tool.path} ${link}`
    return { fix: t`симлинк ${link} повис (ChatGPT.app переложил codex) — перенаправь: ${c}`, fixCmd: c }
  }
  if (state === 'missing') {
    const c = `mkdir -p ${dirname(link)} && ln -sf ${tool.path} ${link}`
    return { fix: t`codex не виден в PATH терминала — положи симлинк: ${c}`, fixCmd: c }
  }
  return { fix: t('ничего не ломается; Пульт ищет codex внутри ChatGPT.app по обеим раскладкам (Resources/codex-cli/bin/codex и Resources/codex)') }
}

function toolItem(tool: LocatedTool, required: boolean, home: string, linkState: (p: string) => LinkState): DoctorItem {
  if (!tool.path) {
    return {
      id: `cli.${tool.name}`,
      title: `CLI ${tool.name}`,
      status: required ? 'fail' : 'warn',
      detail: t`не найден (проверено ${tool.triedCount} кандидатов и PATH логин-шелла)`,
      fix: t`установи ${tool.name} и убедись, что он лежит в PATH логин-шелла`,
    }
  }
  const chatgpt = tool.name === 'codex' && codexInsideChatGPTApp(tool)
  // Версия — чужой текст: `--version` некоторых CLI печатает и путь, и учётку. Инвариант 7
  // требует фильтра на КАЖДОЙ границе, а не только на записи в журнал.
  const version = tool.version === null ? null : redactString(tool.version)
  return {
    id: `cli.${tool.name}`,
    title: `CLI ${tool.name}`,
    status: chatgpt ? 'warn' : 'ok',
    detail: `${tool.path}${tool.realpath && tool.realpath !== tool.path ? ` → ${tool.realpath}` : ''}`
      + t`, версия ${version ?? t('неизвестна')}`
      + (chatgpt ? t(' — бинарь внутри ChatGPT.app: меняется с каждым обновлением приложения') : '')
      + (tool.viaPath ? t(' (найден через PATH логин-шелла, не по списку кандидатов)') : ''),
    ...(chatgpt ? chatgptCodexFix(tool, home, linkState) : {}),
    data: { path: tool.path, realpath: tool.realpath, version },
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const items: DoctorItem[] = []
  const mode = deps.mode ?? defaultMode
  // ПОЧЕМУ здесь вообще берётся логин-шелл: 6 из 7 нужных CLI не видны в PATH службы launchd
  // (DELTA v0.4 §4), и модуль loginShell написан ровно ради этого. Пока его никто не звал,
  // PATH-ветка locateTool была мёртвым кодом, а CLI из nvm или npm-prefix доктор объявлял
  // пропавшими. Отдельный npmPrefix не нужен: `<prefix>/bin` и так лежит в этом PATH.
  const needsRealPath = deps.pathEntries === undefined && (deps.locate === undefined || deps.run === undefined)
  const pathEntries = deps.pathEntries ?? (needsRealPath ? await loginShellPath(deps.paths.envCache) : [])
  const run = deps.run ?? makeRun(pathEntries)
  const tools = await (deps.locate ?? locateAllAsync)({ pathEntries })

  // --- node ------------------------------------------------------------------
  const nodeVersion = deps.nodeVersion ?? process.version
  const major = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0] ?? '0', 10)
  items.push({
    id: 'node.version',
    title: 'Node',
    status: major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    detail: t`${nodeVersion} (нужен >= ${MIN_NODE_MAJOR})`,
    ...(major >= MIN_NODE_MAJOR ? {} : cmd('brew upgrade node')),
  })

  // --- CLI -------------------------------------------------------------------
  const requiredTools: ToolName[] = ['claude', 'codex', 'opencode', 'node']
  for (const name of Object.keys(tools) as ToolName[]) {
    const t = tools[name]
    if (t) items.push(toolItem(t, requiredTools.includes(name), deps.home ?? homedir(), deps.linkState ?? defaultLinkState))
  }

  // --- вход ------------------------------------------------------------------
  // Вход claude, вход codex и сверка схемы запускаются РАЗОМ и ждутся по очереди ниже: порядок
  // строк отчёта прежний, а время — самого долгого из трёх, не их сумма.
  const claude = tools.claude
  const codex = tools.codex
  const claudeAuth = claude?.path ? Promise.resolve(run(claude.path, ['auth', 'status', '--json'], 20_000)) : null
  const codexLogin = codex?.path ? Promise.resolve(run(codex.path, ['login', 'status'], 20_000)) : null
  // Асинхронно и во временный каталог ВНУТРИ PULT_HOME: синхронный запуск морозил бы демон
  // (у `doctor.run` тот же процесс), а `os.tmpdir()` нарушал бы инвариант 8.
  const codexSchema = codex?.path
    ? (deps.codexSchema
        ? deps.codexSchema(codex.path)
        : checkCodexSchema({ bin: codex.path, workDir: join(deps.paths.run, 'codex-schema') }))
    : null
  // Отказ одного из трёх не должен стать необработанным, пока ждём другие.
  for (const p of [claudeAuth, codexLogin, codexSchema]) p?.catch(() => { /* разберём на своём await */ })
  if (claudeAuth) {
    const r = await claudeAuth
    const parsed = parseClaudeAuth(r.stdout)
    items.push({
      id: 'login.claude',
      title: t('Вход claude'),
      status: parsed.loggedIn === true ? 'ok' : parsed.loggedIn === false ? 'fail' : 'warn',
      detail: parsed.loggedIn === null
        ? t`ответ не разобран (код выхода ${r.status}) — код выхода мы игнорируем намеренно`
        : t`loggedIn: ${parsed.loggedIn} (код выхода ${r.status} игнорируется — измерено спайком)`,
      // null — ответ не разобран, вход, скорее всего, есть: советовать `/login` значило бы
      // противоречить строке подписки ниже (там тот же случай чинится `claude auth status`).
      ...(parsed.loggedIn === true ? {} : cmd(parsed.loggedIn === false ? 'claude /login' : 'claude auth status')),
      data: { exitCode: r.status, loggedIn: parsed.loggedIn },
    })
    items.push(claudeSubscriptionItem(parsed.loggedIn, parsed.raw))
  }
  if (codexLogin) {
    const r = await codexLogin
    const line = codexLoginLine(r)
    items.push({
      id: 'login.codex',
      title: t('Вход codex'),
      status: r.status === 0 ? 'ok' : 'fail',
      // `codex login status` может напечатать учётку — в отчёт она идёт только через redactString.
      detail: t`код выхода ${r.status}${line ? `: ${line}` : ''}`,
      ...(r.status === 0 ? {} : cmd('codex login')),
      data: { exitCode: r.status },
    })
    // Пара к «Подписке claude»: плана codex не сообщает, зато первая строка говорит, КАКОЙ вход
    // (ChatGPT или API-ключ) — от этого зависит, лимиты подписки тратит Пульт или деньги с ключа.
    if (r.status === 0) {
      items.push({
        id: 'subscription.codex',
        title: t('Подписка codex'),
        status: 'ok',
        detail: t`${line || t('вход есть, способ не сообщён')} — ходы агентов Пульта тратят ту учётку, в которую вошёл терминальный codex`,
        data: { login: line },
      })
    }
  }
  // --- дрейф протокола codex -------------------------------------------------
  // Бинарь `codex` подменяется при каждом обновлении ChatGPT.app, а на его протоколе стоит
  // весь адаптер В3. Расхождение слепка — ПРЕДУПРЕЖДЕНИЕ: работать это не мешает, но именно
  // отсюда человек узнает, почему у ходов вдруг пропал текст.
  if (codexSchema) {
    const schema = await codexSchema
    items.push({
      id: 'codex.schema',
      title: t('Схема протокола codex'),
      status: schema.status === 'ok' ? 'ok' : 'warn',
      detail: schema.detail,
      ...(schema.status === 'drift'
        ? {
            fix: t`сверь изменения для адаптера (node scripts/diff-codex-schema.mjs <старая> <новая> по spike/codex/schema/) `
              + t`и обнови CODEX_SCHEMA_SHA256 в src/adapters/codex/schema.ts на ${schema.actual}`,
          }
        : {}),
      data: { expected: schema.expected, actual: schema.actual, files: schema.files, state: schema.status },
    })
  }

  if (deps.codexConfig) items.push(...codexNetworkItems(deps.codexConfig))

  const opencode = tools.opencode
  items.push({
    id: 'login.opencode',
    title: t('Вход opencode'),
    status: opencode?.path ? 'ok' : 'warn',
    detail: opencode?.path
      ? t('проверяется только наличие CLI: ключи opencode живут в его конфиге, отдельной команды входа Пульт не дёргает')
      : t('CLI не найден — проверять нечего'),
    ...(opencode?.path ? {} : cmd('brew install sst/tap/opencode')),
  })

  // --- сеть ------------------------------------------------------------------
  // Правило стража — из конфига, без сети: видно и при `--no-net`. allow без стран запрещает все ходы.
  const rule = deps.config.guard
  const emptyAllow = rule.mode === 'allow' && rule.countries.length === 0
  items.push({
    id: 'guard.rule',
    title: t('Страж сети'),
    status: emptyAllow ? 'fail' : guardOff(rule) ? 'warn' : 'ok',
    detail: emptyAllow
      ? t`${guardLine(rule)} — все ходы запрещены: в режиме allow нет ни одной страны (config.json → network.guard)`
      : guardOff(rule)
      ? t`${guardLine(rule)} — страж выключен: ходы идут из любой известной страны (неизвестная — по-прежнему отказ)`
      : t`${guardLine(rule)} — для claude, codex и opencode; неизвестная страна — отказ`,
    ...(emptyAllow ? { fix: t('добавь страну в «Настройки» (⌘,) → «Страж сети» или: pult net guard --allow DE') }
      : guardOff(rule) ? { fix: t('верни страны в «Настройки» (⌘,) → «Страж сети» или: pult net guard --deny RU,BY') } : {}),
    data: { mode: rule.mode, countries: [...rule.countries] },
  })
  if (!deps.skipNet) {
    // Провайдеры проверяются разом: у каждого своя проба (и свой прокси), ждать их очередью незачем.
    const checks = await Promise.all(PROVIDERS.map((provider) => (deps.net
      ? deps.net(provider)
      : checkNetwork(provider, deps.config.network[provider], deps.config.guard, { fresh: true }))))
    for (const [i, provider] of PROVIDERS.entries()) {
      const check = checks[i] as NetCheck
      items.push({
        id: `net.${provider}`,
        title: t`Сеть ${provider}`,
        status: check.ok ? (check.fellBack ? 'warn' : 'ok') : 'fail',
        // В строке есть адрес прокси — он может нести логин и пароль.
        detail: redactString(netLine(check)),
        ...(check.ok ? {} : {
          fix: check.reason === 'no_proxy'
            ? t`network.${provider}.mode = "required" без proxy — ходы запрещены: укажи network.${provider}.proxy или поставь mode = "off" в ${deps.paths.config}`
            : check.reason === 'proxy_dead'
            ? (check.proxy
              ? t`подними прокси ${redactString(check.proxy)} или поставь network.${provider}.mode = "auto" в ${deps.paths.config}`
              : t`укажи network.${provider}.proxy или поставь network.${provider}.mode = "off" в ${deps.paths.config}`)
            : check.reason === 'not_allowed_country'
            ? t`выход ${check.loc ?? t('неизвестен')} не в списке разрешённых (${check.guard.join(',')}): смени выход VPN или правило — «Настройки» → «Страж сети», pult net guard`
            : t`подними VPN: выход ${check.loc ?? t('неизвестен')}, список-страж ${check.guard.join(',')}`,
        }),
        data: { mode: check.mode, path: check.path, loc: check.loc, reason: check.reason, ms: check.ms, checkedAt: check.checkedAt },
      })
    }
  }

  // --- права PULT_HOME -------------------------------------------------------
  const dirProblems: string[] = []
  for (const dir of [deps.paths.home, deps.paths.run, deps.paths.events, deps.paths.logs]) {
    const m = mode(dir)
    if (m === null) continue
    if (m !== 0o700) dirProblems.push(`${dir} = ${m.toString(8)}`)
  }
  const fileProblems: string[] = []
  for (const f of [deps.paths.token, deps.paths.sock, deps.paths.journal, deps.paths.logFile, deps.paths.config]) {
    const m = mode(f)
    if (m === null) continue
    if (m !== 0o600) fileProblems.push(`${f} = ${m.toString(8)}`)
  }
  items.push({
    id: 'home.permissions',
    title: t('Права PULT_HOME'),
    status: dirProblems.length || fileProblems.length ? 'warn' : 'ok',
    detail: dirProblems.length || fileProblems.length
      ? t`ожидаются каталоги 0700 и файлы 0600; не так: ${[...dirProblems, ...fileProblems].join(', ')}`
      : t`каталоги 0700, файлы 0600 — ${deps.paths.home}`,
    ...(dirProblems.length || fileProblems.length
      ? cmd(`chmod 700 ${deps.paths.home} ${deps.paths.run} && chmod 600 ${deps.paths.token}`)
      : {}),
  })

  // --- демон -----------------------------------------------------------------
  const status = deps.daemonStatus ? await deps.daemonStatus() : null
  items.push({
    id: 'daemon',
    title: t('Демон pultd'),
    status: status ? 'ok' : 'warn',
    detail: status
      ? t`версия ${status.version}, pid ${status.pid}, аптайм ${Math.round(status.uptimeMs / 1000)} с, события до ${status.lastEventId}`
      : t('не отвечает (это нормально: демон поднимается по требованию)'),
    ...(status ? {} : cmd('pult daemon start')),
  })
  if (status?.node) items.push(daemonNodeItem(status.node))

  // --- версии ----------------------------------------------------------------
  if (deps.versionItems) {
    try {
      items.push(...deps.versionItems(status))
    } catch (e) {
      items.push({ id: 'version.current', title: t('Активная версия'), status: 'warn', detail: t`проверка не удалась: ${(e as Error).message}` })
    }
  }

  // --- браузер агента и свои MCP-серверы (О3) ---------------------------------
  if (deps.mcpItems) {
    try {
      items.push(...(await deps.mcpItems(status)))
    } catch (e) {
      items.push({ id: 'browser.mcp', title: t('Браузер агента'), status: 'warn', detail: t`проверка не удалась: ${(e as Error).message}` })
    }
  }

  // --- служба ----------------------------------------------------------------
  if (deps.serviceItems) {
    try {
      items.push(...(await deps.serviceItems()))
    } catch (e) {
      items.push({ id: 'service', title: t('Служба'), status: 'warn', detail: t`проверка не удалась: ${(e as Error).message}` })
    }
  }

  const counts: Record<DoctorStatus, number> = { ok: 0, warn: 0, fail: 0 }
  for (const it of items) counts[it.status]++
  return {
    ok: counts.fail === 0,
    generatedAt: new Date().toISOString(),
    home: deps.paths.home,
    items,
    counts,
  }
}

export function formatDoctor(report: DoctorReport): string {
  const sign = (s: DoctorStatus): string => (s === 'ok' ? 'ok  ' : s === 'warn' ? 'warn' : 'FAIL')
  const lines: string[] = [`pult doctor · ${report.home}`]
  for (const it of report.items) {
    lines.push(`[${sign(it.status)}] ${it.title}: ${it.detail}`)
    if (it.fix) lines.push(t`         почини: ${it.fix}`)
  }
  lines.push(t`итог: ok ${report.counts.ok} · warn ${report.counts.warn} · fail ${report.counts.fail}`)
  return lines.join('\n')
}
