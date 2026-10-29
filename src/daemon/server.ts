// Сервер демона: unix-сокет, рукопожатие, диспетчер методов. Протокол — план Ф1 §3.
// Основа перенесена из spike/env/sock-server.mjs (проверка S9f): каталог 0700 и файлы 0600
// явным chmod, lock с проверкой живости pid, старый сокет удаляется ТОЛЬКО после взятия lock.

import { withLanguage } from '../i18n/context.js'
import { getLanguage, isLanguageSetting, resolveLanguage } from '../i18n/core.js'
import type { LanguageSetting } from '../i18n/core.js'
import { existsSync, chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ProviderName, PultConfig } from '../core/config.js'
import type { EventDraft, PultEvent } from '../core/events.js'
import { DAEMON_SESSION, isEventKind } from '../core/events.js'
import type { Logger } from '../core/log.js'
import { redactString } from '../core/log.js'
import { acquireLock } from '../core/lock.js'
import type { LockHandle } from '../core/lock.js'
import { createLineSplitter, encodeLine, NdjsonError } from '../core/ndjson.js'
import type { PultPaths } from '../core/paths.js'
import { checkSockPath, ensureLayout } from '../core/paths.js'
import type { DaemonStatus, RpcRequest } from '../core/rpc.js'
import { ERROR_CODES, PROTOCOL_VERSION } from '../core/rpc.js'
import { createStore, GET_LIMIT } from '../core/store.js'
import { clipEvent, compactHistory, fitEvent, HISTORY_PAGE_BYTES, LIVE_LINE_BYTES, pageHistory } from '../core/history.js'
import { normalizeQuery, QUERY_MAX_CHARS, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, searchEvents } from '../core/search.js'
import { exportSession } from '../core/exportMd.js'
import { ATTACHMENTS_SWEEP_MS, sweepAttachments } from '../core/attachments.js'

/** Строка события в `events.get` — до этой длины: окно показывает вывод до 4000 знаков, вход — целиком. */
const GET_STRING_CHARS = 100_000
import type { EventStore } from '../core/store.js'
import { rotateToken, tokenEquals } from '../core/token.js'
import { VERSION } from '../core/version.js'
import { createClaudeAdapter } from '../adapters/claude/adapter.js'
import { codexNetworkEnv, createCodexAdapter, shellJoin } from '../adapters/codex/adapter.js'
import { claudeNetworkEnv } from '../adapters/claude/adapter.js'
import type { ProviderAdapter } from '../adapters/types.js'
import { runDoctor } from '../env/doctor.js'
import { codexConfigPath } from '../env/codexConfig.js'
import type { DoctorDeps, DoctorReport } from '../env/doctor.js'
import { serviceDoctorItemsAsync } from '../service/doctor.js'
import { versionDoctorItems } from '../update/doctor.js'
import { checkNetwork, clearNetCache, lastNetExits, netGeneration, recordNetCheck } from '../env/net.js'
import type { NetCheck } from '../env/net.js'
import { locateToolPath, testLocate } from '../env/locate.js'
import { buildChildEnv } from '../env/allowlist.js'
import { daemonNodeInfo, fileId } from '../env/nodeBin.js'
import { execAsync } from '../env/exec.js'
import { createAutoTitler } from '../sessions/autotitle.js'
import { createProviderCatalog, codexMetadataRequest, fetchCodexModels } from '../env/providers.js'
import type { ProviderModel } from '../env/providers.js'
import { nextLastUsed, parseLastUsed, parseNewSession, ConfigureError } from '../sessions/settings.js'
import type { LastUsed, ModelChoice, NewSessionSettings } from '../sessions/settings.js'
import { atomicWrite } from '../service/fsutil.js'
import { createExternalSessions } from '../sessions/external.js'
import { createProjectStore, ProjectError } from '../projects/store.js'
import type { ApprovalMode, PermissionDecision, PermissionScope } from '../adapters/types.js'
import { isApprovalMode, PERMISSION_SCOPES } from '../adapters/types.js'
import { createBroker, ScopeError } from '../perm/broker.js'
import { createAskKeys } from '../perm/askKeys.js'
import { codexChildRulesPath, createCodexRules, RulesError } from '../perm/codexRules.js'
import { revokeSummary, ruleWords } from '../perm/rulesText.js'
import type { RevokeOutcome } from '../perm/rulesText.js'
import type { CodexRule } from '../perm/codexRules.js'
import type { AskKeys } from '../perm/askKeys.js'
import type { PermBroker } from '../perm/broker.js'
import { createManager, ManagerError, publicRecord } from '../sessions/manager.js'
import { createNotifyRunner, notifyJobFor } from './notifyCommand.js'
import type { SessionManager } from '../sessions/manager.js'
import { formatTree } from '../sessions/tree.js'
import type { EventBus, SubscriptionManager } from './subscriptions.js'
import { createBus, createSubscriptions } from './subscriptions.js'
import { createLiveChannel } from './live.js'
import type { LiveChannel } from './live.js'
import { LIVE_CURSOR_BASE } from '../sessions/turnPhase.js'
import {
  approvalBrowserRefusal, browserDirs, bypassRefusal, claudeDefaultMode, createBrowserInstaller, ensureBrowserDirs, findChrome, PLAYWRIGHT_MCP_VERSION, sweepDeadBrowserDirs,
} from '../mcp/browser.js'
import type { BrowserInstaller, InstallResult } from '../mcp/browser.js'
import { browserDoctorItems, bypassDoctorItems, mcpDoctorItems } from '../mcp/doctor.js'
import { createMcpExtras } from '../mcp/session.js'
import { listServers, RESERVED_MCP_NAMES } from '../mcp/servers.js'
import { MCP_SERVER_NAME_RE, MCP_SERVERS_MAX, writeMcpSelection, writeNetworkGuard, writeLanguage, writeNewSession, writeUpdatesCheck } from '../core/config.js'
import { GuardError, guardLine, guardVerdict, parseGuardShape, parseGuardStrict, sameGuard } from '../core/guard.js'
import type { GuardRule } from '../core/guard.js'
import type { SessionBrowser, SessionRecord, SessionStatus } from '../sessions/registry.js'
import { ApplyError, createUpdateChecker } from '../update/checker.js'
import type { CheckerOptions, UpdateChecker } from '../update/checker.js'
import { AppUpdateError, createAppUpdater, shellHelloOf } from '../update/appUpdate.js'
import { APPLY_SHELLS_WAIT_MS, dropApplyJournal, journalApplies, readApplyJournal, waitPackageProbe, writeApplyJournal } from '../update/applyJournal.js'
import type { AppTools, AppUpdater, ShellHello } from '../update/appUpdate.js'
import { bundleOf, insideApp } from '../update/appUpdate.js'
import type { UpdateStatus } from '../core/rpc.js'

export const HANDSHAKE_TIMEOUT_MS = 2000
/** Сколько байт ответа разрешено копить медленному клиенту, прежде чем его отцепят. */
export const WRITE_BACKLOG_LIMIT = 8 * 1024 * 1024
/** Доигрывание прошлого ждёт клиента, когда буфер сокета больше этого (src/daemon/subscriptions.ts). */
export const REPLAY_HIGH_WATER = 1024 * 1024
/** Клиент не выписал буфер за столько во время доигрывания — он не читает, его отцепляют. */
export const REPLAY_STALL_MS = 30_000

/** Методы следующих вех: отвечаем честным «ещё не реализовано», а не «метод не найден». */
const LATER_METHODS = new Set<string>([])

export interface DaemonOptions {
  paths: PultPaths
  config: PultConfig
  logger: Logger
  /**
   * Файл правил Codex (план 16, № 11). Нет — `$CODEX_HOME/rules/default.rules`, а в testMode —
   * `PULT_CODEX_RULES` или `PULT_HOME/codex-rules/default.rules`: тест никогда не читает и не правит настоящий.
   */
  codexRulesPath?: string
  /** PULT_TEST=1: открывает служебный метод `events.emit`. */
  testMode?: boolean
  /** Предел буфера на соединение. Тест ставит его крошечным, чтобы не гонять мегабайты. */
  writeBacklogLimit?: number
  /**
   * Путь к бинарю `claude`. Тест подсовывает сюда test/fakes/fake-claude.mjs через
   * PULT_CLAUDE_BIN — production-поиск (env/locate.ts) от этого не слабеет: переменная лишь
   * ПЕРЕБИВАЕТ найденный путь, а её отсутствие оставляет всё как было.
   */
  claudeBin?: string
  /** Путь к бинарю `codex`; тест подсовывает фальшивый app-server через PULT_CODEX_BIN. */
  codexBin?: string
  /** Путь к dist/cli/main.js для заглушки разрешений; тест ставит свой. */
  cliEntry?: string
  /**
   * Страж страны выхода для ОБОИХ адаптеров. В бою не задаётся (адаптеры ходят в сеть сами),
   * тест инъецирует — иначе сквозной прогон CLI дёргает настоящий `curl` и зависит от того,
   * где сейчас выход VPN у хозяина машины.
   */
  netCheck?: (provider: ProviderName) => Promise<NetCheck>
  /**
   * Подмена поиска и запуска CLI в `doctor.run` — только для тестов, которые меряют, что доктор
   * не останавливает демона: им нужны МЕДЛЕННЫЕ фальшивые CLI, а тестовый режим CLI не ищет вовсе.
   */
  doctor?: Pick<DoctorDeps, 'locate' | 'pathEntries' | 'run' | 'codexSchema'>
  /** Генератор названия сессии (тест подставляет свой; в тестовом режиме по умолчанию выключен). */
  titler?: (text: string) => Promise<string | null>
  /** О3: подмена установки Playwright MCP (тест не зовёт npm). */
  browserInstall?: (paths: PultPaths) => Promise<InstallResult>
  /** О3: подмена поиска Chrome (тест не смотрит на диск машины). */
  findChrome?: () => string | null
  /**
   * M8c: швы канала обновлений — запрос, ключи, запуск `pult update`, расписание. Без них тестовый демон
   * расписания не заводит (сеть в тестах закрыта), кроме сквозных прогонов с PULT_TEST_UPDATE_DIR.
   */
  updates?: Pick<CheckerOptions, 'http' | 'keys' | 'spawnApply' | 'spawnStage' | 'stage' | 'schedule' | 'firstDelayMs' | 'intervalMs' | 'jitterMs' | 'tickMs' | 'now' | 'random'>
  /** 0.3.4: швы обновления окна — утилиты macOS, сроки ожидания. Тест не трогает настоящий Pult.app никогда. */
  appUpdate?: { tools?: Partial<AppTools>; quitWaitMs?: number; helloWaitMs?: number; killWaitMs?: number; pollMs?: number; stopWaitMs?: number }
  /** M8f: подмена живого списка моделей Codex для `agent.configure` (`null` — списка нет). */
  codexModels?: () => Promise<ProviderModel[] | null>
  /** Срок, на который открытая правка держит очередь реплик (мс). Тест ставит короче; по умолчанию 10 мин. */
  queueEditHoldMs?: number
}

/** M8f: сколько живёт список моделей Codex для проверки `agent.configure` (`model/list` поднимает app-server). */
const CODEX_MODELS_TTL_MS = 10 * 60_000

/** Ход идёт: процесс работает или ждёт человека. Рестарт демона (обновление) оборвал бы его. */
const RUNNING_TURN: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['working', 'blocked_permission', 'blocked_question'])

export interface DaemonHandle {
  readonly token: string
  readonly paths: PultPaths
  readonly bus: EventBus
  readonly store: EventStore
  readonly broker: PermBroker
  /** 0.3.7: ключи вопросов `pult mcp-ask` (в памяти демона; тесты выдают их сами). */
  readonly askKeys: AskKeys
  readonly manager: SessionManager
  readonly startedAt: string
  status(): DaemonStatus
  emit(draft: EventDraft): PultEvent
  stop(reason: string): Promise<void>
  onStopped(fn: () => void): void
}

export type StartResult =
  | { ok: true; daemon: DaemonHandle }
  | { ok: false; reason: 'locked'; holderPid: number | null; holderCmd: string | null }

interface Connection {
  id: number
  socket: net.Socket
  authed: boolean
  client: string
  /**
   * 0.3.7: право соединения — от того, ЧЕМ прошло рукопожатие, а не от самоназвания `client`. `owner` — токен хозяина
   * (всё, кроме `perm.request`); `ask` — ключ вопросов (только `perm.request` сессии `askSession`); `none` — до hello.
   */
  role: 'none' | 'owner' | 'ask'
  /** Ключ вопросов соединения `ask`: сверяется на каждом `perm.request` — снятый ключ (процесс claude вышел) не спросит. */
  askKey?: string
  askSession?: string
  subs: SubscriptionManager
  /** Номер последнего `events.search` соединения: новый запрос отменяет прежний (окно ищет на каждый ввод). */
  searchGen: number
  /** 0.3.4: оболочка — чем запущена (hello `app`): pid, путь, версия окна. */
  app?: ShellHello
  /** Интерфейс этой оболочки уже сделал первый вызов — окно готово (обновление окна ждёт этого). */
  rendererSeen?: boolean
  /**
   * Срабатывает на закрытии соединения. Вопрос `perm.request` от `pult mcp-ask` ждёт решения на ЭТОМ соединении:
   * оно закрылось — заглушка умерла вместе со своим `claude`, отвечать некому, вопрос снимается отказом.
   */
  closed: AbortController
}

/** Вызовы, которые делает только интерфейс окна (main оболочки их не шлёт): первый из них — окно готово. */
const RENDERER_METHODS: ReadonlySet<string> = new Set(['settings.get', 'events.snapshot', 'update.status', 'update.check', 'providers.check'])

/** Собственные поля параметров RPC в объекте без прототипа; не объект — пусто. */
export function ownParams(raw: unknown): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const k of Object.keys(raw)) out[k] = (raw as Record<string, unknown>)[k]
  return out
}

/** Background work follows this daemon's current settings, without changing another daemon's locale. */
export function startDaemon(opts: DaemonOptions): Promise<StartResult> {
  return withLanguage(() => resolveLanguage(opts.config.language, process.env['LC_ALL'] || process.env['LC_MESSAGES'] || process.env['LANG'] || Intl.DateTimeFormat().resolvedOptions().locale), () => startDaemonInContext(opts))
}

async function startDaemonInContext(opts: DaemonOptions): Promise<StartResult> {
  const { paths, config, logger } = opts
  const backlogLimit = opts.writeBacklogLimit ?? WRITE_BACKLOG_LIMIT
  ensureLayout(paths)
  checkSockPath(paths.sock)

  const locked = acquireLock(paths.lock)
  if (!locked.ok) {
    return { ok: false, reason: 'locked', holderPid: locked.holderPid, holderCmd: locked.holderCmd }
  }
  const lock: LockHandle = locked.lock

  // Lock наш — значит любой сокет на диске остался от МЁРТВОГО процесса. Раньше этой строки
  // удалять его нельзя: так убивают живого соседа.
  if (existsSync(paths.sock)) {
    let wasSocket: boolean | null = null
    try { wasSocket = statSync(paths.sock).isSocket() } catch { /* исчез сам */ }
    try { unlinkSync(paths.sock) } catch { /* исчез сам */ }
    logger.info('удалён осиротевший сокет', { path: paths.sock, wasSocket })
  }

  const token = rotateToken(paths.token)
  const askKeys = createAskKeys()
  const store = createStore(paths)
  const bus = createBus()
  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()
  const connections = new Map<number, Connection>()
  const stoppedHandlers: Array<() => void> = []
  let connSeq = 0
  let stopping = false

  let journalBroken: string | null = null
  const emit = (draft: EventDraft): PultEvent => {
    // Сломанный журнал — деградация ДЕМОНА, а не одного события: продолжать работу, теряя каждое
    // событие, нельзя (статусы, разрешения и очередь разъедутся с журналом). Первый же сбой записи
    // запускает мягкую остановку; сам `emit` продолжает бросать, чтобы вызывающий путь (RPC или
    // таймер) узнал, что события НЕТ, и не построил состояние вокруг фантома.
    try {
      const ev = store.append(draft)
      bus.emit(ev)
      return ev
    } catch (e) {
      if (journalBroken === null) {
        journalBroken = (e as Error).message
        logger.error('журнал событий не пишется — останавливаю демон', { error: journalBroken })
        // Через таймер, не сразу: `stop` объявлен ниже по файлу, а сюда можно попасть и из
        // синхронного участка сборки демона. Повторный вызов безвреден — `stop` идемпотентен.
        setTimeout(() => { void stop(`журнал событий не пишется: ${journalBroken}`).catch((stopErr) => { logger.error('мягкая остановка не удалась', { error: (stopErr as Error).message }) }) }, 0).unref?.()
      }
      throw e
    }
  }

  // --- разрешения, адаптеры, сессии -----------------------------------------
  // Порядок сборки важен: брокеру нужна запись в журнал, адаптеру — брокер, менеджеру — оба.
  const broker: PermBroker = createBroker({
    emit: (draft) => { manager.emit(draft) },
    timeoutMs: config.permTimeoutMs,
  })
  // PULT_CLAUDE_BIN лишь ПЕРЕБИВАЕТ результат обычного поиска — сам поиск не ослабляется.
  // Поиск — ТОЛЬКО путь (`locateToolPath`), без `--version`: до `listen` демон не запускает ни
  // одного CLI. КАК ЛОМАЛОСЬ (замер 30.09.2026, настоящий launchd): `locateTool` спрашивал версию
  // у `claude` и `codex` через spawnSync — под службой с фоновым приоритетом до 6 с на эти два
  // запуска; рабочая служба стартовала 11 с, проба `pult update` («hello_ok за 10 с») провалилась,
  // а SIGTERM от `bootout` ждал конца запуска.
  const claudeBin = opts.claudeBin
    ?? process.env['PULT_CLAUDE_BIN']
    ?? locateToolPath('claude').path
    ?? 'claude'
  /**
   * ГЕРМЕТИЧНОСТЬ СКВОЗНЫХ ТЕСТОВ. Демон сквозные тесты поднимают ОТДЕЛЬНЫМ процессом, и
   * инъекцию туда не передать никак, кроме окружения. Поэтому: только при `PULT_TEST=1` и
   * только при явной `PULT_TEST_NET=ok|blocked` страж отвечает заранее известным ответом, ни
   * разу не выходя наружу. Без этой калитки прогон `agent prompt` дёргал настоящий `curl` и
   * зависел от страны выхода машины — то есть мог упасть у человека с VPN в РФ и «починиться»
   * сам при переключении узла. Боевой путь остаётся прежним: переменной нет — идём в сеть.
   */
  const netFromEnv = ((): ((provider: ProviderName) => Promise<NetCheck>) | null => {
    if (!opts.testMode) return null
    const mode = process.env['PULT_TEST_NET']
    if (mode !== 'ok' && mode !== 'blocked') return null
    // 0.3.6: `ok` — выход `PULT_TEST_NET_LOC` (две буквы; по умолчанию XX — «страна, которой нет ни в одном списке»), и
    // решение принимает НАСТОЯЩЕЕ правило стража из конфига (режим allow с e2e окна отказывает так же, как в бою).
    // `blocked` — всегда отказ с выходом RU, какое бы правило ни стояло.
    const forced = mode === 'blocked'
    const envLoc = (process.env['PULT_TEST_NET_LOC'] ?? '').trim().toUpperCase()
    const testLoc = /^[A-Z]{2}$/.test(envLoc) ? envLoc : 'XX'
    // M8e: `PULT_TEST_NET_DELAY_MS` — страж «думает» столько, как настоящий curl до api.anthropic.com
    // (0,25–0,4 с, висящий прокси — до 8 с): e2e окна видит реплику «отправляется…», пока ход заводится.
    const delayMs = Math.min(30_000, Math.max(0, Number(process.env['PULT_TEST_NET_DELAY_MS']) || 0))
    return async (provider: ProviderName): Promise<NetCheck> => {
      if (delayMs) await new Promise<void>((r) => { const t = setTimeout(r, delayMs); t.unref?.() })
      const check = netResult(provider)
      recordNetCheck(check)
      return check
    }
    function netResult(provider: ProviderName): NetCheck {
      const loc = forced ? 'RU' : testLoc
      const v = forced ? { ok: false, reason: 'blocked_country' as const } : guardVerdict(config.guard, loc)
      return {
        provider,
        mode: 'auto',
        path: v.ok ? 'direct' : 'none',
        proxy: null,
        loc,
        ok: v.ok,
        reason: v.reason,
        fellBack: false,
        guard: [...config.guard.countries],
        guardMode: config.guard.mode,
        attempts: [],
        ms: 0,
        checkedAt: new Date().toISOString(),
        cached: false,
      }
    }
  })()
  const netCheck = opts.netCheck ?? netFromEnv
  if (netCheck && netFromEnv) logger.warn('страж сети подменён тестовым PULT_TEST_NET', { mode: process.env['PULT_TEST_NET'] })

  // --- О3: браузер агента и свои MCP-серверы ------------------------------------
  // `~/.claude.json` только читается. Тестовый демон смотрит в файл внутри PULT_HOME — как `claudeRoot`
  // внешних сессий: настоящий домашний каталог машины в тест не попадает.
  const claudeUserFile = opts.testMode ? join(paths.home, 'claude.json') : join(homedir(), '.claude.json')
  /** Настройки Claude, откуда берётся `permissions.defaultMode`: пользователь, затем проект (старшие перекрывают). */
  const claudeSettings = (cwd: string): string[] => [
    opts.testMode ? join(paths.home, 'claude-settings.json') : join(homedir(), '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ]
  /**
   * M8d (ревью): у Claude в режиме `ask` флага нет — действует `defaultMode` владельца. Окно показывает ДЕЙСТВУЮЩИЙ
   * режим («спрашивать — у Claude по твоим настройкам: auto»): тот же порядок файлов, что у `claudeSettings`, но
   * только из наборов, которые сессии разрешено читать (`settingSources`). Нет настройки — `default`.
   */
  const claudeEffectiveMode = (rec: SessionRecord): string => {
    const [user, project, local] = claudeSettings(rec.cwd) as [string, string, string]
    const allowed = rec.settingSources ? new Set(rec.settingSources.split(',').map((x) => x.trim())) : null
    const files = [['user', user], ['project', project], ['local', local]]
      .filter(([k]) => !allowed || allowed.has(k as string)).map(([, f]) => f as string)
    return claudeDefaultMode(files) ?? 'default'
  }
  /** О3: в режиме `bypassPermissions` браузер Claude не включается (src/mcp/browser.ts bypassRefusal). */
  const refuseBypass = (kind: string, cwd: string, approval?: ApprovalMode): void => {
    // M8d: и режим подтверждений самой сессии — «полный доступ» у Claude, «без вопросов» у Codex.
    const byMode = approvalBrowserRefusal(kind, approval)
    if (byMode) throw new ManagerError(ERROR_CODES.invalidParams, byMode)
    if (kind === 'claude' && claudeDefaultMode(claudeSettings(cwd)) === 'bypassPermissions') {
      throw new ManagerError(ERROR_CODES.invalidParams, bypassRefusal())
    }
  }
  // Старт: следы удалений прошлого демона (`*.dead-*`) — в фоне; файлы `--mcp-config` прошлых процессов —
  // сразу: в них env и заголовки своих серверов владельца.
  void sweepDeadBrowserDirs(paths).catch((e: unknown) => logger.warn('следы удалённых профилей браузера не убраны', { error: (e as Error).message }))
  try {
    for (const f of readdirSync(paths.run)) if (/^mcp-.*\.json$/.test(f)) unlinkSync(join(paths.run, f))
  } catch (e) { logger.warn('старые файлы --mcp-config не убраны', { error: (e as Error).message }) }
  const chromeOf = opts.findChrome ?? ((): string | null => (opts.testMode ? null : findChrome()))
  const installer: BrowserInstaller = createBrowserInstaller({
    paths, logger,
    emit: (draft) => { manager.emit(draft) },
    ...(opts.browserInstall ? { install: opts.browserInstall } : {}),
  })
  const mcpExtras = createMcpExtras({
    paths, logger, installer,
    record: (name) => manager.list().find((r) => r.name === name) ?? null,
    selected: () => config.mcp.servers,
    userFile: claudeUserFile,
    claudeSettings,
    emit: (draft) => { manager.emit(draft) },
    chrome: chromeOf,
  })
  /** Браузер включили (старт или `agent.browser`): каталоги сразу, установка — в фоне, ход её дождётся. */
  const browserOn = (name: string): void => {
    try { ensureBrowserDirs(paths, name) } catch (e) { logger.warn('каталоги браузера не заведены', { session: name, error: (e as Error).message }) }
    void installer.ensure(`браузер включён у сессии ${name}`)
  }
  /** Строка сессии наружу: у сессии с браузером — путь скачиваний (окно показывает его в подвале). */
  const withBrowser = <T extends SessionRecord>(rec: T): T & { browserDownloads?: string } =>
    rec.browser ? { ...rec, browserDownloads: browserDirs(paths, rec.name).downloads } : rec

  const claude: ProviderAdapter = createClaudeAdapter({
    paths, config, logger, bin: claudeBin,
    ...(opts.cliEntry !== undefined ? { cliEntry: opts.cliEntry } : {}),
    emit: (draft) => { manager.emit(draft) },
    live: (name, sig) => { manager.live(name, sig) },
    askPermission: (req) => broker.request(req),
    askKeys,
    ...(netCheck ? { netCheck } : {}),
    mcpExtras: (name, nodeBin, at) => mcpExtras(name, nodeBin, at),
  })
  const codexBin = opts.codexBin
    ?? process.env['PULT_CODEX_BIN']
    ?? locateToolPath('codex').path
    ?? 'codex'
  // План 16, № 11: правила «Всегда» Codex — метка над строкой, которую codex допишет, список и «Отозвать». Файл — тот,
  // куда пишет НАШ app-server: его окружение без CODEX_HOME (белый список), значит `$HOME/.codex` ребёнка.
  const rulesPath = opts.codexRulesPath
    ?? (opts.testMode ? process.env['PULT_CODEX_RULES'] ?? join(paths.home, 'codex-rules', 'default.rules') : codexChildRulesPath())
  const rules = createCodexRules({
    path: rulesPath,
    log: (level, msg, data) => { logger[level](msg, data) },
    // Метки не будет — человеку заметкой в ленте сессии, откуда нажато «Всегда», а не только строкой в журнале демона.
    onUnmarked: (g, reason) => {
      manager.emit({ sessionId: g.sessionId, provider: 'codex', kind: 'session.configured', data: {
        changes: {},
        notice: `Правило «Всегда» (${ruleWords({ kind: g.kind, label: g.kind === 'network' ? g.host : redactString(shellJoin(g.argv)) })}) не помечено: ${reason}. Пульт его не покажет и не отзовёт — убрать можно только руками в ${rulesPath}.`,
      } })
    },
  })
  const revokeRule = async (id: unknown, by: string): Promise<RevokeOutcome> => {
    if (typeof id !== 'string' || !id) throw new ManagerError(ERROR_CODES.invalidParams, 'нужен id правила из pult perm rules')
    let r: { rule: CodexRule; stillAllowedBy: number }
    try { r = await rules.revoke(id) } catch (e) {
      if (e instanceof RulesError) throw new ManagerError(e.code === 'not_found' ? ERROR_CODES.notFound : ERROR_CODES.internal, e.message)
      throw new ManagerError(ERROR_CODES.internal, (e as Error).message)
    }
    // Codex держит правила в памяти процесса — перезапустить его, как только ходов нет (идущие не рвутся).
    const reload = codex.reloadPolicy?.(`Правило «Всегда» отозвано (${ruleWords(r.rule)})`) ?? { codex: 'not_running' as const }
    const codexState = reload.codex
    const outcome: RevokeOutcome = {
      rule: { id: r.rule.id, kind: r.rule.kind, label: r.rule.label }, stillAllowedBy: r.stillAllowedBy, codex: codexState, ...(reload.busy ? { busy: reload.busy } : {}),
    }
    emit({ sessionId: DAEMON_SESSION, provider: 'pult', kind: 'rule.revoked', data: {
      id: r.rule.id, kind: r.rule.kind, label: r.rule.label, session: r.rule.session, at: r.rule.at, by, stillAllowedBy: r.stillAllowedBy, codex: codexState,
    } })
    return outcome
  }
  const codex: ProviderAdapter = createCodexAdapter({
    paths, config, logger, bin: codexBin,
    ruleGranted: (g) => { rules.granted(g) },
    emit: (draft) => { manager.emit(draft) },
    live: (name, sig) => { manager.live(name, sig) },
    askPermission: (req) => broker.request(req),
    // Разрешения Codex живут в ОБЩЕМ процессе app-server: когда он умирает, отвечать по их
    // id уже некому, и вопрос обязан уйти из Inbox отказом, а не висеть (инвариант 5).
    cancelPermissions: (sessionId, reason) => {
      let n = 0
      for (const p of broker.list(sessionId)) {
        if (broker.resolve(p.id, { behavior: 'deny', message: `pult: ${reason}` }, 'provider_gone')) n++
      }
      return n
    },
    ...(netCheck ? { netCheck } : {}),
    mcpExtras: (name, nodeBin, at) => mcpExtras(name, nodeBin, at),
  })
  // Автоназвание: одноразовый `claude -p` к haiku через тот же страж сети, что и ходы.
  const titler = opts.titler ?? (!opts.testMode && config.autoTitle ? createAutoTitler({
    bin: claudeBin,
    cwd: paths.home,
    env: async () => {
      const check = await (netCheck ?? ((p: 'claude') => checkNetwork(p, config.network[p], config.guard, {})))('claude')
      return check.ok ? buildChildEnv(process.env, { network: claudeNetworkEnv(check), extra: {} }) : null
    },
    run: (bin, args, o) => execAsync(bin, args, { env: o.env, cwd: o.cwd, timeoutMs: o.timeoutMs }),
    onError: (e) => logger.warn('автоназвание: claude -p не ответил — название из первых слов', { error: e }),
  }) : undefined)
  // О2: своя команда на событие внимания — работает и без окна (src/daemon/notifyCommand.ts).
  const notifyRunner = config.notifyCommand ? createNotifyRunner({ command: config.notifyCommand, logger }) : null
  // Канал обновлений заводится после менеджера (ему нужен список ходов), а менеджеру нужен ответ «ставится
  // ли обновление» — ссылка заполняется ниже, до первого запроса.
  let updaterRef: UpdateChecker | null = null
  let appUpdaterRef: AppUpdater | null = null
  // 0.3.5: живой канал фаз хода — кадры мимо журнала (src/daemon/live.ts). Заводится после менеджера: фазу знает он.
  let liveRef: LiveChannel | null = null
  const manager: SessionManager = createManager({
    paths, config, logger, store,
    publish: emit,
    onPhase: (name) => { liveRef?.touch(name) },
    holdTurns: () => updaterRef?.applying() ?? false,
    adapters: { claude, codex },
    broker,
    modelChoices: (provider) => (provider === 'codex' ? codexChoices() : Promise.resolve(null)),
    ...(opts.queueEditHoldMs !== undefined ? { queueEditHoldMs: opts.queueEditHoldMs } : {}),
    ...(titler ? { titler } : {}),
    ...(notifyRunner ? {
      onAttention: (ev: PultEvent, att, title: string) => {
        const job = notifyJobFor(ev, att, title, config.notify.minTurnSeconds)
        if (job) notifyRunner.fire(job)
      },
    } : {}),
  })
  // Ход идёт по статусу ИЛИ заводится прямо сейчас (resume/send — статуса `working` ещё нет). Один счёт на «Обновить»
  // в окне (checker ждёт, пока он не 0) и на `pult update` из CLI (`daemon.status.turns`).
  const runningTurns = (): number =>
    new Set([...manager.list().filter((r) => RUNNING_TURN.has(r.lastStatus)).map((r) => r.name), ...manager.startingTurns()]).size
  // M8c: канал обновлений. В тестовом демоне расписание — только по шву (`opts.updates`) или в сквозном
  // прогоне с PULT_TEST_UPDATE_DIR (первая проверка — через PULT_TEST_UPDATE_FIRST_MS): иначе каждый тест
  // заводил бы таймер, который через минуту честно сообщал бы «сеть в тестах не трогается».
  const testFirst = Number(process.env['PULT_TEST_UPDATE_FIRST_MS'])
  const updater: UpdateChecker = createUpdateChecker({
    paths, config, logger,
    current: VERSION,
    runningTurns,
    onApplyEnd: ({ ok }) => {
      manager.resumeQueues()
      // 0.3.16: `pult update` вышел, а демон жив — рестарта не было (провал или ставить оказалось нечего). Журнал
      // больше не нужен; удача без рестарта — окно доводится здесь же.
      if (readApplyJournal(paths)) {
        dropApplyJournal(paths)
        if (ok) void appUpdaterRef?.applyAll({}).catch((e: unknown) => { logger.warn('окно после обновления не обновилось', { error: (e as Error).message }) })
      }
    },
    // Какие окна были открыты при нажатии: новый демон дождётся, пока они переподключатся, прежде чем трогать окно.
    onLaunch: (to) => { writeApplyJournal(paths, { from: VERSION, to, at: new Date().toISOString(), windows: shellHellos().map((h) => h.execPath).filter((e): e is string => e !== null) }) },
    blocked: () => (appUpdaterRef?.busy() ? 'идёт обновление окна — пакет обновится после него' : null),
    // 0.3.16: окно готовится заранее вместе с пакетом (ссылка заполняется ниже, до первой проверки).
    app: {
      wanted: (v) => appUpdaterRef?.wanted(v) ?? false,
      ready: (v) => appUpdaterRef?.readyFor(v) ?? false,
      stage: async (m) => (await appUpdaterRef?.stage(m)) ?? false,
    },
    ...(opts.testMode && !opts.updates
      ? { schedule: !!process.env['PULT_TEST_UPDATE_DIR'], ...(Number.isFinite(testFirst) && testFirst >= 0 ? { firstDelayMs: testFirst } : {}) }
      : {}),
    // Тестовый демон готовит в фоне только со швом подготовки или в сквозном прогоне с «релизом» из папки.
    ...(opts.testMode && !opts.updates?.spawnStage && !process.env['PULT_TEST_UPDATE_DIR'] ? { stage: false } : {}),
    ...(opts.updates ?? {}),
  })
  updaterRef = updater
  const liveChannel: LiveChannel = createLiveChannel({ phase: (name) => manager.phase(name), names: () => manager.phaseNames() })
  liveRef = liveChannel
  // 0.3.4: окно обновляется само — демон качает, проверяет и меняет Pult.app, сессии не трогаются.
  const appUpdater: AppUpdater = createAppUpdater({
    paths, config, logger,
    testMode: opts.testMode === true,
    ...(opts.updates?.keys ? { keys: opts.updates.keys } : {}),
    tools: { ...(opts.updates?.http ? { http: opts.updates.http } : {}), ...(opts.appUpdate?.tools ?? {}) },
    latestApp: () => updater.status().latest?.app?.version ?? null,
    packageBusy: () => {
      const a = updater.status().apply
      if (a.state === 'applying') return `идёт обновление пакета до ${a.to} — окно обновится после него`
      if (a.state === 'waiting') return `обновление пакета до ${a.to} ждёт конца ходов — окно обновится после него`
      return null
    },
    ...(opts.appUpdate?.quitWaitMs !== undefined ? { quitWaitMs: opts.appUpdate.quitWaitMs } : {}),
    ...(opts.appUpdate?.helloWaitMs !== undefined ? { helloWaitMs: opts.appUpdate.helloWaitMs } : {}),
    ...(opts.appUpdate?.killWaitMs !== undefined ? { killWaitMs: opts.appUpdate.killWaitMs } : {}),
    ...(opts.appUpdate?.pollMs !== undefined ? { pollMs: opts.appUpdate.pollMs } : {}),
    ...(opts.appUpdate?.stopWaitMs !== undefined ? { stopWaitMs: opts.appUpdate.stopWaitMs } : {}),
    shells: shellHellos,
    packageVersion: VERSION,
    packageStaging: () => updater.staging(),
  })
  appUpdaterRef = appUpdater
  /** Окна (hello оболочек), подключённые сейчас. */
  function shellHellos(): ShellHello[] {
    return [...connections.values()].filter((c) => c.authed && c.client === 'shell' && c.app).map((c) => c.app as ShellHello)
  }
  /** Дождаться hello окон с этими путями (не дольше `ms`); вернуть те, что так и не подключились. */
  const waitShells = async (want: readonly string[], ms: number): Promise<string[]> => {
    const deadline = Date.now() + ms
    for (;;) {
      const have = new Set(shellHellos().map((h) => h.execPath))
      const missing = want.filter((e) => !have.has(e))
      if (!missing.length || Date.now() >= deadline || stopping) return missing
      await new Promise((r) => { setTimeout(r, 200) })
    }
  }
  /** 0.3.16: новый демон доводит «Перезапустить и обновить» по журналу — окно показывает «Перезапускаю…». */
  let continuing: { to: string } | null = null
  /** Статус канала вместе с окном: одним объектом в `update.*` и `daemon.status.update`. */
  const updateStatus = (u: UpdateStatus = updater.status(), conn?: Connection): UpdateStatus => {
    const app = appUpdater.status()
    const here = hereOf(conn, app.path)
    const stale = conn?.client === 'shell' && conn.app ? appUpdater.isStale(conn.app) : null
    return { ...u, continuing, app: { ...app, here, hereFrom: here === false && conn?.app?.execPath ? bundleOf(conn.app.execPath) : null, stale } }
  }
  /**
   * 0.3.16: старт после «Перезапустить и обновить». Журнал есть и версия сменилась — дождаться итога пробы
   * `pult update` (провал — нас откатят, окно не трогаем) и довести окно: замена бандла или перезапуск окна со старым
   * интерфейсом. Журнал удаляется до работы с окном: у замены свой журнал (apps/swap.json), повтор по кругу не нужен.
   */
  const continueApply = async (): Promise<void> => {
    const j = readApplyJournal(paths)
    if (!j) return
    if (!journalApplies(j, VERSION)) {
      dropApplyJournal(paths)
      logger.info('журнал обновления не к этому демону — убран', { from: j.from, to: j.to, version: VERSION })
      return
    }
    continuing = { to: VERSION }
    try {
      const ok = await waitPackageProbe(paths, VERSION, { stopped: () => stopping })
      dropApplyJournal(paths)
      if (!ok || stopping) { logger.warn('проба нового пакета не подтвердилась — окно не трогаю', { version: VERSION }); return }
      // Окна переподключаются к новому демону со своей паузой (до 5 с): без их hello не видно ни окна с прежним
      // интерфейсом (перезапуск), ни другого окна, которое помешало бы замене. Ждём тех, что были открыты при нажатии.
      const missing = await waitShells(j.windows, APPLY_SHELLS_WAIT_MS)
      if (missing.length) logger.warn('не все окна переподключились к новому демону', { missing })
      const r = await appUpdater.applyAll({ expect: VERSION, waitLockMs: 60_000, record: true, others: missing })
      logger.info('обновление окна после пакета', { started: r !== null, from: j.from, version: VERSION })
    } catch (e) {
      logger.warn('окно после обновления пакета не обновилось', { error: (e as Error).message })
    } finally {
      continuing = null
    }
  }
  void continueApply()
  /** Спрашивающее окно — из поставленного бандла? Только для оболочки с путём. */
  const hereOf = (conn: Connection | undefined, app: string | null): boolean | null =>
    conn?.client === 'shell' && conn.app?.execPath && app ? insideApp(conn.app.execPath, app) : null
  // Каждое событие журнала — повод проверить, не кончился ли последний ход, которого ждёт «Обновить».
  bus.on(() => { updater.poke() })

  const childEnv = buildChildEnv(process.env)
  // Служебные запросы Codex (`model/list`, `thread/list|read|fork`) поднимают свой `codex app-server`
  // и идут тем же стражем сети, что и ходы: `model/list` ходит в сеть, а прямой путь из страны под
  // запретом закрыт для него так же, как для реплики (инвариант 2).
  const codexEnv = async (): Promise<Record<string, string>> => {
    const check = await (netCheck ?? ((p: 'codex') => checkNetwork(p, config.network[p], config.guard, {})))('codex')
    if (!check.ok) throw new ManagerError('provider_unavailable', `страж сети не пускает Codex: ${check.reason}${check.loc ? ` (выход ${check.loc})` : ''}`)
    return buildChildEnv(process.env, { network: codexNetworkEnv(check), extra: {} })
  }
  // M8f: живой список моделей Codex для проверки смены модели — тот же `model/list`, что у «+ Сессия», с кэшем:
  // каждая проверка иначе поднимала бы свой app-server. Нет списка (офлайн, страж, тест без фальшивого codex) —
  // `null`, и смена проверяется только по форме имени.
  let codexModelCache: { at: number; list: ModelChoice[] } | null = null
  const toChoices = (models: readonly ProviderModel[]): ModelChoice[] =>
    models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts, defaultEffort: m.defaultEffort, isDefault: m.isDefault }))
  const codexChoices = async (): Promise<ModelChoice[] | null> => {
    if (opts.codexModels) { const m = await opts.codexModels(); return m ? toChoices(m) : null }
    if (codexModelCache && Date.now() - codexModelCache.at < CODEX_MODELS_TTL_MS) return codexModelCache.list
    // Тестовый демон в сеть не ходит: список — только от фальшивого codex и только при подменённом страже.
    if (opts.testMode && (!netCheck || (!opts.codexBin && !process.env['PULT_CODEX_BIN']))) return null
    try {
      const list = toChoices(await fetchCodexModels(codexBin, paths.home, await codexEnv()))
      if (!list.length) return null
      codexModelCache = { at: Date.now(), list }
      return list
    } catch (e) {
      logger.warn('список моделей Codex недоступен — смена модели проверяется только по форме имени', { error: (e as Error).message })
      return null
    }
  }
  // M8f: последний выбор «+ Сессия» окна — свой маленький файл (0600), не config.json: он меняется на каждом заведении.
  const readLastUsed = (): LastUsed => {
    try { return parseLastUsed(JSON.parse(readFileSync(paths.newSessionLast, 'utf8'))) } catch { return {} }
  }
  // `updates` — только флаг автопроверки: адрес канала окну не нужен и окном не пишется.
  // `network` — только правило стража и последние известные выходы (из кэша проверок, без новой пробы): прокси,
  // профили и noProxy окну не отдаются.
  const settingsReply = (): Record<string, unknown> => ({
    language: config.language,
    newSession: config.newSession, lastUsed: readLastUsed(), updates: { check: config.updates.check },
    network: { guard: { mode: config.guard.mode, countries: [...config.guard.countries] }, exits: lastNetExits() },
    codexRules: rules.list(),
  })
  const projects = createProjectStore(join(paths.home, 'projects.json'))
  // `PULT_TEST_PROVIDERS=run` (только вместе с PULT_TEST=1): проверка входа идёт по-настоящему — в фальшивые CLI
  // из PULT_CLAUDE_BIN / PULT_CODEX_BIN. Нужна кадрам README (shell/test/readme): шапка «готов», а не «ошибка».
  const catalog = createProviderCatalog({ bins: { claude: claudeBin, codex: codexBin }, cwd: paths.home, env: childEnv, codexEnv,
    testMode: opts.testMode && process.env['PULT_TEST_PROVIDERS'] !== 'run' })
  const external = createExternalSessions({
    claudeRoot: opts.testMode ? join(paths.home, 'claude-projects') : join(homedir(), '.claude', 'projects'),
    codexRequest: async (method, params) => {
      if (opts.testMode && !opts.codexBin && !process.env['PULT_CODEX_BIN']) throw new ManagerError('provider_unavailable', 'Codex CLI отключён в тестовом режиме')
      return codexMetadataRequest(codexBin, paths.home, await codexEnv(), method, params)
    },
  })

  // Бинарь node при старте: `daemon.status.node.alive` сверяет с ним inode (env/nodeBin.ts).
  const nodeAtStart = fileId(process.execPath)
  const status = (): DaemonStatus => ({
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    startedAt,
    uptimeMs: Date.now() - startedAtMs,
    home: paths.home,
    sock: paths.sock,
    clients: connections.size,
    subscriptions: [...connections.values()].reduce((n, c) => n + c.subs.count(), 0),
    lastEventId: store.lastId,
    mode: process.env['PULT_SERVICE'] === '1' ? 'service' : 'on-demand',
    // Остановлен ли провайдер целиком (`provider.blocked`). Окну (Ф2) нужен ответ «сейчас», а не
    // догадка по журналу: `provider.reset` события не пишет, и старое `provider.blocked` в
    // истории иначе рисовало бы красную плашку до конца жизни окна.
    providers: {
      claude: providerState(claude),
      codex: providerState(codex),
    },
    node: daemonNodeInfo(paths.runtime, process.execPath, process.version, nodeAtStart),
    // Правила уведомлений окна (О2): порог длительности хода и звук. Сама команда `notifyCommand` наружу не уходит.
    notify: { ...config.notify },
    browser: browserStatus(),
    update: updateStatus(),
    turns: runningTurns(),
  })
  function browserStatus(): NonNullable<DaemonStatus['browser']> {
    const st = installer.state()
    return {
      state: st.state,
      version: PLAYWRIGHT_MCP_VERSION,
      ...(st.state === 'failed' ? { error: st.error.slice(0, 500) } : {}),
      sessions: manager.list().filter((r) => r.browser).length,
      chrome: chromeOf(),
    }
  }
  function providerState(a: ProviderAdapter): { blocked: boolean; reason?: string } {
    const b = a.blocked()
    return b.blocked ? { blocked: true, ...(b.reason ? { reason: b.reason } : {}) } : { blocked: false }
  }

  /**
   * Один доктор за раз на каждый вид (с сетью и без): второй `doctor.run`, пришедший, пока идёт
   * первый, получает ТОТ ЖЕ отчёт. Окно зовёт доктора при каждом открытии и переподключении — у
   * владельца 30.09.2026 два прогона легли друг за другом, и каждый запускал свой десяток процессов
   * (семь `--version`, два входа, схема codex, curl на каждого провайдера).
   */
  // «Проверить сеть» из окна и `doctor.run {net: true}` не чаще раза в 15 с: проверка каждого провайдера — проба по его
  // пути. Свежее — прежний ответ (`cached: true`). Смена правила стража (поколение) делает прежний ответ негодным.
  const DOCTOR_NET_MIN_MS = 15_000
  const doctorNetLast = new Map<ProviderName, { at: number; gen: number; check: NetCheck }>()
  const doctorNet = async (provider: ProviderName): Promise<NetCheck> => {
    const hit = doctorNetLast.get(provider)
    if (hit && hit.gen === netGeneration() && Date.now() - hit.at < DOCTOR_NET_MIN_MS) return { ...hit.check, cached: true }
    const gen = netGeneration()
    const check = await (netCheck ? netCheck(provider) : checkNetwork(provider, config.network[provider], config.guard, { fresh: true }))
    doctorNetLast.set(provider, { at: Date.now(), gen, check })
    return check
  }
  const doctorRuns = new Map<string, Promise<DoctorReport>>()
  const doctorOnce = (skipNet: boolean): Promise<DoctorReport> => {
    const key = `${skipNet}:${getLanguage()}`
    const running = doctorRuns.get(key)
    if (running) return running
    const run = runDoctor({
      paths,
      config,
      skipNet,
      daemonStatus: async () => status(),
      // В тестовом демоне швы службы включаются всегда: без PULT_SERVICE_DIR и фальшивых
      // бинарей служба «не установлена», и ни настоящий каталог служб, ни launchctl не трогаются.
      // В ПОТОКЕ, а не на событийном цикле: spawnSync launchctl/systemctl (до 20 с на вызов)
      // здесь морозил весь демон для всех клиентов, пока менеджер служб думал.
      serviceItems: () => serviceDoctorItemsAsync(paths, opts.testMode ? { ...process.env, PULT_TEST: '1' } : process.env),
      versionItems: (st) => versionDoctorItems(paths, st),
      mcpItems: async () => {
        const b = browserStatus()
        return [
          ...browserDoctorItems({ paths, state: installer.state(), wanted: b.sessions, chrome: b.chrome }),
          ...(await mcpDoctorItems(claudeUserFile, config.mcp.servers)),
          ...bypassDoctorItems(claudeDefaultMode(claudeSettings(paths.home)), b.sessions),
        ]
      },
      // Тестовый демон, как и `pult doctor` при PULT_TEST=1, агентские CLI не запускает.
      ...(opts.testMode ? { locate: testLocate, pathEntries: (process.env['PATH'] ?? '').split(':').filter(Boolean) } : {}),
      // …и в сеть не ходит, если страж подменён (PULT_TEST_NET или инъекция теста): иначе
      // `doctor.run {net: true}` из окна дёргал настоящий curl посреди герметичного e2e.
      net: doctorNet,
      // 0.3.7: сеть в песочнице Codex; тестовый демон читает файл в PULT_HOME, а не config.toml машины.
      codexConfig: opts.testMode ? join(paths.home, 'codex-config.toml') : codexConfigPath(),
      ...(opts.doctor ?? {}),
    }).finally(() => { doctorRuns.delete(key) })
    doctorRuns.set(key, run)
    return run
  }

  const server = net.createServer()

  /**
   * ЕДИНСТВЕННАЯ дверь наружу для обычных ответов. Клиент, который шлёт запросы и не читает
   * ответы, иначе копит их в памяти демона без всякого предела — подписки лимит знали, а
   * ответы `daemon.status` и `events.tail` его обходили.
   */
  const writeFrame = (conn: Connection, payload: unknown): boolean => {
    if (conn.socket.destroyed) return false
    if (conn.socket.writableLength > backlogLimit) {
      logger.warn('клиент не читает ответы — отсоединяем', {
        conn: conn.id, client: conn.client, backlog: conn.socket.writableLength,
      })
      try { conn.socket.destroy() } catch { /* уже мёртв */ }
      return false
    }
    conn.socket.write(encodeLine(payload))
    return true
  }

  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  /** `browser` в параметрах: нет / false — без браузера, true — без окна, `{headed?: boolean}`; прочее — отказ. */
  const browserParam = (v: unknown, method: string): SessionBrowser | null => {
    if (v === undefined || v === false || v === null) return null
    if (v === true) return {}
    const o = v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
    if (!o || (o['headed'] !== undefined && typeof o['headed'] !== 'boolean')) {
      throw new ManagerError(ERROR_CODES.invalidParams, `${method}: browser — true или {headed: true|false}`)
    }
    return o['headed'] === true ? { headed: true } : {}
  }
  const int = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)

  /**
   * Методы вокруг агентов. Право на `perm.request` (только соединение с ключом вопросов, 0.3.7) проверяется здесь
   * и в начале `dispatch` (ключ вопросов — ничего, кроме `perm.request`).
   */
  const agentMethod = async (conn: Connection, method: string, p: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'providers.check': {
        const r = await catalog.check()
        // Список, который видел человек в «+ Сессия», годится и для проверки смены модели.
        if (r.codex.models.length) codexModelCache = { at: Date.now(), list: toChoices(r.codex.models) }
        return r
      }
      case 'agent.configure': {
        // M8f: модель, усилие, режим подтверждений живой сессии — со следующего хода.
        for (const k of ['model', 'effort'] as const) {
          if (p[k] !== undefined && (typeof p[k] !== 'string' || !p[k])) throw new ManagerError(ERROR_CODES.invalidParams, `agent.configure: ${k} — непустая строка`)
        }
        if (p['approval'] !== undefined && !isApprovalMode(p['approval'])) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'agent.configure: approval — read-only | ask | workspace | full')
        }
        if (p['confirm'] !== undefined && typeof p['confirm'] !== 'boolean') throw new ManagerError(ERROR_CODES.invalidParams, 'agent.configure: confirm — true | false')
        if (p['model'] === undefined && p['effort'] === undefined && p['approval'] === undefined) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'agent.configure: нечего менять — model, effort или approval')
        }
        const r = await manager.configure({
          name: String(p['name'] ?? ''),
          ...(p['model'] !== undefined ? { model: p['model'] as string } : {}),
          ...(p['effort'] !== undefined ? { effort: p['effort'] as string } : {}),
          ...(p['approval'] !== undefined ? { approval: p['approval'] as ApprovalMode } : {}),
          ...(p['confirm'] === true ? { confirm: true } : {}),
        })
        if (r.changes.browser === 'on') browserOn(r.record.name)
        return { ...withBrowser(publicRecord(r.record)), changes: r.changes, when: r.when }
      }
      case 'settings.get':
        return settingsReply()
      case 'settings.set': {
        // Окно пишет ТОЛЬКО раздел `newSession`, флаг `updates.check` (автопроверка обновлений) и правило стража
        // `network.guard` (0.3.6): профили сети, прокси, noProxy, команды, адрес канала (`updates.url`) и всё прочее
        // config.json отсюда не достать. Разбор строгий — кривое поле отказывает целиком, и тогда файл не трогается вовсе.
        const keys = Object.keys(p)
        if (!keys.length || keys.some((k) => k !== 'language' && k !== 'newSession' && k !== 'updates' && k !== 'network' && k !== 'codexRules')) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'settings.set: можно менять только language, newSession, updates.check, network.guard и codexRules.revoke')
        }
        // План 16, № 11: «Отозвать» из «Настроек» — через уже разрешённый оболочке метод (Pult.app не меняется).
        // Только `{revoke: id}` и только отдельным вызовом: отзыв — живая кнопка, а не часть черновика «Сохранить».
        if (p['codexRules'] !== undefined) {
          const r = p['codexRules']
          const rk = r !== null && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r) : null
          if (keys.length !== 1 || !rk || rk.length !== 1 || rk[0] !== 'revoke' || typeof (r as Record<string, unknown>)['revoke'] !== 'string') {
            throw new ManagerError(ERROR_CODES.invalidParams, 'settings.set: codexRules — только {revoke: id}, отдельным вызовом')
          }
          const outcome = await revokeRule((r as Record<string, unknown>)['revoke'], `${conn.client}#${conn.id}`)
          return { ...settingsReply(), codexRulesRevoked: { ...outcome, text: revokeSummary(outcome) } }
        }
        let language: LanguageSetting | undefined
        if (p['language'] !== undefined) {
          if (!isLanguageSetting(p['language'])) throw new ManagerError(ERROR_CODES.invalidParams, 'settings.set: language must be auto, ru or en')
          language = p['language']
        }
        let ns: NewSessionSettings | undefined
        if (p['newSession'] !== undefined) {
          try { ns = parseNewSession(p['newSession'], true).value } catch (e) {
            if (e instanceof ConfigureError) throw new ManagerError(ERROR_CODES.invalidParams, `settings.set: ${e.message}`)
            throw e
          }
        }
        let check: boolean | undefined
        if (p['updates'] !== undefined) {
          const u = p['updates']
          const uk = u !== null && typeof u === 'object' && !Array.isArray(u) ? Object.keys(u) : null
          if (!uk || uk.length !== 1 || uk[0] !== 'check' || typeof (u as Record<string, unknown>)['check'] !== 'boolean') {
            throw new ManagerError(ERROR_CODES.invalidParams, 'settings.set: updates — только {check: true|false}')
          }
          check = (u as { check: boolean }).check
        }
        let guard: GuardRule | undefined
        let expect: GuardRule | undefined
        if (p['network'] !== undefined) {
          const n = p['network']
          const nk = n !== null && typeof n === 'object' && !Array.isArray(n) ? Object.keys(n) : null
          if (!nk || !nk.includes('guard') || nk.some((k) => k !== 'guard' && k !== 'expect')) {
            throw new ManagerError(ERROR_CODES.invalidParams, 'settings.set: network — только {guard: {mode, countries}, expect?}; прокси и профили сети — в config.json руками')
          }
          try {
            guard = parseGuardStrict((n as Record<string, unknown>)['guard'])
            // `expect` — правило, которое видело окно (сравнить-и-записать): оно может быть и закрытым (allow без стран).
            if (nk.includes('expect')) expect = parseGuardShape((n as Record<string, unknown>)['expect'], 'network.expect')
          } catch (e) {
            if (e instanceof GuardError) throw new ManagerError(ERROR_CODES.invalidParams, `settings.set: ${e.message}`)
            throw e
          }
          if (expect && !sameGuard(expect, config.guard)) {
            throw new ManagerError(ERROR_CODES.guardChanged, `settings.set: правило стража изменилось снаружи (сейчас: ${guardLine(config.guard)}) — открой «Настройки» заново`)
          }
        }
        try {
          if (language !== undefined) writeLanguage(paths.config, language)
          if (ns !== undefined) writeNewSession(paths.config, ns)
          if (check !== undefined) writeUpdatesCheck(paths.config, check)
          if (guard !== undefined) writeNetworkGuard(paths.config, guard)
        } catch (e) { throw new ManagerError(ERROR_CODES.internal, (e as Error).message) }
        if (language !== undefined) config.language = language
        if (ns !== undefined) {
          config.newSession = ns
          logger.info('настройки новой сессии записаны', { newSession: ns })
        }
        if (check !== undefined) {
          config.updates.check = check
          updater.setEnabled(check)
        }
        if (guard !== undefined) {
          // Сразу, без рестарта демона: адаптеры читают `config.guard` на каждой проверке, а сброс кэша двигает
          // поколение правил — следующий ход КАЖДОЙ сессии проверит выход заново. Идущий ход не прерывается.
          config.guard = guard
          clearNetCache()
          logger.info('правило стража сети сменено', { guard: guardLine(guard) })
        }
        return settingsReply()
      }
      case 'project.list':
        return { projects: projects.list() }
      case 'project.add':
      case 'project.remove': {
        // M8d «Убрать из списка» для ЛЮБОГО проекта дерева: `sessions` — сессии этой группы (их считает окно:
        // раскладка по проектам живёт в ui/src/model/projects.ts). Они уходят в архив, закреплённая папка —
        // из списка проектов; группа исчезает сама (архивные в дереве не раскладываются), а новая сессия в этой
        // папке (или реплика в архивную) возвращает её. Отдельного «скрытого» списка нет — скрытость выводится
        // из архива. Файлы на диске не трогаются никогда.
        const names = p['sessions']
        if (method === 'project.remove' && names !== undefined) {
          if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
            throw new ManagerError(ERROR_CODES.invalidParams, 'project.remove: sessions — список имён сессий')
          }
          // Сначала проверка ВСЕХ имён, потом правки: на полпути не остаётся «половина в архиве».
          // Ревью M8d: сессия обязана лежать в этой папке (её корень — исходный репозиторий у worktree, как в окне),
          // и ни одна не должна быть занята — идёт ход, ждёт разрешения или вопроса, стоит очередь реплик:
          // спрятать в архив работающего агента — потерять его из виду посреди дела.
          const root = resolve(String(p['path'] ?? ''))
          const inRoot = (x: string): boolean => x === root || x.startsWith(root.endsWith('/') ? root : `${root}/`)
          const recs = manager.list()
          const busy: string[] = []
          for (const n of names as string[]) {
            const rec = recs.find((r) => r.name === n)
            if (!rec) throw new ManagerError(ERROR_CODES.notFound, `сессии ${n} нет`)
            if (!inRoot(resolve(rec.worktree?.repo ?? rec.cwd))) throw new ManagerError(ERROR_CODES.invalidParams, `сессия ${n} не из папки ${root}`)
            if (['working', 'blocked_permission', 'blocked_question'].includes(rec.lastStatus) || rec.pendingPermissions > 0 || (rec.queue?.length ?? 0) > 0) busy.push(n)
          }
          if (busy.length) throw new ManagerError(ERROR_CODES.invalidParams, `сначала останови: ${busy.join(', ')}`)
        }
        try {
          if (method === 'project.add') return projects.add(String(p['path'] ?? ''))
          const archived: string[] = []
          for (const n of (names ?? []) as string[]) {
            if (manager.list().find((r) => r.name === n)?.archived) continue
            manager.archive(n, true)
            archived.push(n)
          }
          return { removed: projects.remove(String(p['path'] ?? '')), ...(names !== undefined ? { archived } : {}) }
        } catch (e) {
          if (e instanceof ProjectError) throw new ManagerError(e.code === 'not_found' ? ERROR_CODES.notFound : ERROR_CODES.invalidParams, e.message)
          throw e
        }
      }
      case 'sessions.external.list': {
        if (p['provider'] !== 'claude' && p['provider'] !== 'codex') throw new ManagerError('invalid_params', 'Нужен провайдер claude или codex')
        return await external.list(p['provider'], str(p['cursor']))
      }
      case 'sessions.external.read': {
        if (p['provider'] !== 'claude' && p['provider'] !== 'codex') throw new ManagerError('invalid_params', 'Нужен провайдер claude или codex')
        return await external.read(p['provider'], String(p['id'] ?? ''))
      }
      case 'agent.import': {
        if (p['provider'] !== 'claude' && p['provider'] !== 'codex') throw new ManagerError('invalid_params', 'Нужен провайдер claude или codex')
        const source = await external.read(p['provider'], String(p['id'] ?? ''))
        let providerId = source.session.id
        if (source.session.provider === 'codex') {
          const fork = await codexMetadataRequest(codexBin, paths.home, await codexEnv(), 'thread/fork', {
            threadId: providerId, cwd: source.session.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', excludeTurns: true,
          })
          const t = fork['thread'] as Record<string, unknown> | undefined
          if (typeof t?.['id'] !== 'string') throw new ManagerError('internal', 'Codex не вернул копию разговора')
          providerId = t['id']
        }
        return publicRecord(await manager.importSession({ name: String(p['name'] ?? ''), kind: source.session.provider, cwd: source.session.cwd,
          title: [...source.session.title].slice(0, 60).join('') }, providerId, source.messages, source.session.provider === 'claude'))
      }
      case 'agent.start': {
        const kind = p['kind'] === 'codex' ? 'codex' : 'claude'
        // M8d: как подтверждать действия. Нет поля — `ask`; незнакомое значение — отказ, а не тихий `ask`:
        // человек, попросивший `full`, но опечатавшийся, иначе получил бы не то, что думает.
        if (p['approval'] !== undefined && !isApprovalMode(p['approval'])) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'agent.start: approval — read-only | ask | workspace | full')
        }
        const approval = (p['approval'] ?? 'ask') as ApprovalMode
        // Ревью M8d: «полный доступ» — только с явным подтверждением (окно шлёт его после красного предупреждения,
        // CLI — по `--yes`). Без него отказ ДО заведения чего-либо.
        if (approval === 'full' && p['confirm'] !== true) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'agent.start: approval full — агент делает что угодно без вопросов, песочницы нет; нужен confirm: true')
        }
        const browser = browserParam(p['browser'], 'agent.start')
        if (browser) refuseBypass(kind, String(p['cwd'] ?? ''), approval)
        const rec = publicRecord(await manager.start({
          name: String(p['name'] ?? ''),
          ...(str(p['title']) !== undefined ? { title: str(p['title']) as string } : {}),
          kind,
          cwd: String(p['cwd'] ?? ''),
          ...(str(p['model']) !== undefined ? { model: str(p['model']) as string } : {}),
          ...(str(p['effort']) !== undefined ? { effort: str(p['effort']) as string } : {}),
          ...(p['mode'] === 'warm' ? { mode: 'warm' as const } : {}),
          ...(str(p['settingSources']) !== undefined ? { settingSources: str(p['settingSources']) as string } : {}),
          ...(str(p['worktree']) !== undefined ? { worktree: str(p['worktree']) as string } : {}),
          ...(str(p['base']) !== undefined ? { base: str(p['base']) as string } : {}),
          ...(browser ? { browser } : {}),
          ...(approval !== 'ask' ? { approval } : {}),
        }))
        if (browser) browserOn(rec.name)
        // M8f: последний выбор «+ Сессия» — только с окна (клиент `shell`): CLI и скрипты его не трогают.
        // Папка — если форма не была открыта уже с папкой (`rememberCwd: false`). `full` не запоминается.
        if (conn.client === 'shell') {
          try {
            const next = nextLastUsed(readLastUsed(), {
              kind,
              ...(rec.model ? { model: rec.model } : {}),
              ...(rec.effort ? { effort: rec.effort } : {}),
              approval,
              mode: rec.mode,
              browser: !!browser,
              worktree: str(p['worktree']) !== undefined,
              cwd: String(p['cwd'] ?? ''),
            }, p['rememberCwd'] !== false, new Date().toISOString())
            atomicWrite(paths.newSessionLast, JSON.stringify(next, null, 2) + '\n', 0o600)
          } catch (e) { logger.warn('последний выбор «+ Сессия» не записан', { error: (e as Error).message }) }
        }
        return withBrowser(rec)
      }
      case 'agent.browser': {
        // О3: браузер для агента вкл/выкл — со следующего хода: идущий ход не трогается, тёплый процесс Claude сменится на
        // границе следующего хода (M8f: браузер — часть снимка хода).
        if (typeof p['on'] !== 'boolean') throw new ManagerError(ERROR_CODES.invalidParams, 'agent.browser: нужен on: true|false')
        if (p['headed'] !== undefined && typeof p['headed'] !== 'boolean') throw new ManagerError(ERROR_CODES.invalidParams, 'agent.browser: headed — true|false')
        const name = String(p['name'] ?? '')
        if (p['on']) {
          const cur = manager.list().find((r) => r.name === name)
          if (cur) refuseBypass(cur.provider, cur.cwd, cur.approval)
        }
        const rec = manager.setBrowser(name, p['on'] ? (p['headed'] === true ? { headed: true } : {}) : null)
        if (p['on']) browserOn(name)
        return withBrowser(publicRecord(rec))
      }
      case 'mcp.list':
        // Только ~/.claude.json: серверы проекта (.mcp.json) — позже (src/mcp/servers.ts).
        return await listServers(claudeUserFile, config.mcp.servers)
      case 'mcp.select': {
        const names = p['names']
        if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'mcp.select: names — список имён серверов')
        }
        const uniq = [...new Set(names as string[])]
        if (uniq.length > MCP_SERVERS_MAX) throw new ManagerError(ERROR_CODES.invalidParams, `mcp.select: не больше ${MCP_SERVERS_MAX} серверов`)
        for (const n of uniq) {
          if (!MCP_SERVER_NAME_RE.test(n)) throw new ManagerError(ERROR_CODES.invalidParams, `mcp.select: имя «${n.slice(0, 80)}» не годится`)
          if (RESERVED_MCP_NAMES.has(n)) throw new ManagerError(ERROR_CODES.invalidParams, `mcp.select: имя ${n} занято Пультом`)
        }
        try {
          writeMcpSelection(paths.config, uniq)
        } catch (e) {
          throw new ManagerError(ERROR_CODES.internal, (e as Error).message)
        }
        config.mcp.servers = uniq
        logger.info('свои MCP-серверы выбраны', { servers: uniq })
        return { selected: uniq }
      }
      case 'agent.archive':
        if (typeof p['archived'] !== 'boolean') throw new ManagerError(ERROR_CODES.invalidParams, 'agent.archive: нужен archived: true|false')
        return publicRecord(manager.archive(String(p['name'] ?? ''), p['archived']))
      case 'agent.rename':
        // `title` обязателен и строка: снять название — это явное '', а не забытый параметр.
        // Иначе кривой клиент (`{name}` или `title: null`) стирал бы название молча.
        if (typeof p['title'] !== 'string') {
          throw new ManagerError(ERROR_CODES.invalidParams, 'agent.rename: нужен строковый title (пустая строка — снять название)')
        }
        return publicRecord(manager.rename(String(p['name'] ?? ''), p['title']))
      case 'agent.prompt':
        // О2: `queue` — в очередь, если идёт ход; `interrupt` — прервать и сказать. Оба — только `true`.
        if (p['queue'] === true && p['interrupt'] === true) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'agent.prompt: queue и interrupt вместе не бывают — либо ждать хода, либо прервать его')
        }
        return await manager.say(String(p['name'] ?? ''), String(p['text'] ?? ''), {
          ...(p['queue'] === true ? { queue: true } : {}),
          ...(p['interrupt'] === true ? { interrupt: true } : {}),
        })
      case 'agent.queue.resume':
        return manager.queueResume(String(p['name'] ?? ''))
      case 'agent.queue.remove':
        return manager.queueRemove(String(p['name'] ?? ''), String(p['id'] ?? ''))
      case 'agent.queue.move': {
        // Правка реплики очереди (0.3.2) — тем же методом, что ↑/↓: он уже в белом списке моста окна, и новое окно
        // не нужно. Ровно одно из: `to` — переставить; `hold: true|false` — взять в правку (очередь стоит на
        // реплике, пока правка открыта) или бросить её; `text` — сохранить правку (место и id прежние).
        const name = String(p['name'] ?? '')
        const id = String(p['id'] ?? '')
        const given = ['to', 'hold', 'text'].filter((k) => p[k] !== undefined)
        if (given.length > 1) throw new ManagerError(ERROR_CODES.invalidParams, `agent.queue.move: ${given.join(' и ')} вместе не бывают`)
        if (p['hold'] !== undefined) {
          if (typeof p['hold'] !== 'boolean') throw new ManagerError(ERROR_CODES.invalidParams, 'agent.queue.move: hold — true|false')
          return p['hold'] ? manager.queueHold(name, id, conn.id) : manager.queueRelease(name, id)
        }
        if (p['text'] !== undefined) {
          if (typeof p['text'] !== 'string') throw new ManagerError(ERROR_CODES.invalidParams, 'agent.queue.move: text — строка')
          return manager.queueEdit(name, id, p['text'])
        }
        if (!Number.isSafeInteger(p['to'])) throw new ManagerError(ERROR_CODES.invalidParams, 'agent.queue.move: to — целый индекс')
        return manager.queueMove(name, id, p['to'] as number)
      }
      case 'agent.wait':
        return await manager.wait({
          name: String(p['name'] ?? ''),
          ...(Array.isArray(p['until']) ? { until: (p['until'] as unknown[]).map(String) } : {}),
          ...(typeof p['timeoutMs'] === 'number' ? { timeoutMs: p['timeoutMs'] } : {}),
        })
      case 'agent.read':
        return manager.read(
          String(p['name'] ?? ''),
          int(p['since'], 0),
          p['format'] === 'json' ? 'json' : 'text',
        )
      case 'agent.list':
        // О2: последнее событие внимания — из хранилища (копится на каждой записи, без прохода по журналу).
        // Очередь — превью реплик (`publicRecord`): ответ уходит окну одной строкой NDJSON.
        return { sessions: manager.list().map((rec) => {
          const attention = store.attention(rec.name)
          const pub = withBrowser(publicRecord(rec))
          // M8d: действующий режим Claude у `ask` (флага нет — решают настройки владельца).
          const eff = rec.provider === 'claude' && !rec.approval ? { claudeMode: claudeEffectiveMode(rec) } : {}
          return attention ? { ...pub, ...eff, attention } : { ...pub, ...eff }
        }) }
      case 'agent.seen':
        if (p['unread'] !== undefined && typeof p['unread'] !== 'boolean') {
          throw new ManagerError(ERROR_CODES.invalidParams, 'agent.seen: unread — true|false')
        }
        if (p['upTo'] !== undefined && !(Number.isSafeInteger(p['upTo']) && (p['upTo'] as number) >= 0)) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'agent.seen: upTo — номер события (целое ≥ 0)')
        }
        return publicRecord(manager.seen(String(p['name'] ?? ''), p['unread'] === true, p['upTo'] as number | undefined))
      case 'agent.retry':
        return await manager.retry(String(p['name'] ?? ''))
      case 'agent.stop': {
        // `turnId` (О2, карточка «завис»): стоп только этого хода — кончился, стопа нет.
        if (p['turnId'] !== undefined && typeof p['turnId'] !== 'string') throw new ManagerError(ERROR_CODES.invalidParams, 'agent.stop: turnId — строка')
        return { stopped: await manager.stop(String(p['name'] ?? ''), p['turnId'] as string | undefined) }
      }
      case 'agent.rm': {
        const r = await manager.rm(String(p['name'] ?? ''), { worktree: p['worktree'] === true })
        return { removed: true, ...r }
      }
      case 'agent.export': {
        // Полный файл сессии → PULT_HOME/exports/<имя>-<время>.md (src/core/exportMd.ts). Наружу — путь
        // и размер, не текст: разговор бывает больше строки NDJSON, которую клиент готов прочесть.
        const name = String(p['name'] ?? '')
        const rec = manager.list().find((r) => r.name === name)
        if (!rec) throw new ManagerError(ERROR_CODES.notFound, `сессии ${name} нет`)
        return await exportSession(paths, {
          name: rec.name, provider: rec.provider, cwd: rec.cwd, createdAt: rec.createdAt,
          ...(rec.title ? { title: rec.title } : {}),
          ...(rec.model ? { model: rec.model } : {}),
          ...(rec.effort ? { effort: rec.effort } : {}),
          ...(rec.worktree ? { worktree: { path: rec.worktree.path, branch: rec.worktree.branch } } : {}),
        }, { shouldStop: () => stopping })
      }
      case 'agent.tree': {
        const tree = manager.tree(String(p['name'] ?? ''))
        return { roots: tree.roots, orphans: tree.orphans, text: formatTree(tree) }
      }
      case 'perm.list':
        return { pending: broker.list(str(p['name'])) }
      case 'perm.rules':
        return rules.list()
      case 'perm.rules.revoke':
      {
        const outcome = await revokeRule(p['id'], `${conn.client}#${conn.id}`)
        return { revoked: outcome.rule, stillAllowedBy: outcome.stillAllowedBy, codex: outcome.codex, text: revokeSummary(outcome) }
      }
      case 'perm.resolve': {
        // 0.3.7: подмена входа запрещена. Раньше `updatedInput` разрешал «одно» и исполнял «другое» (одобрить карточку
        // `ls` и подставить `curl … | sh`). Единственный законный автор updatedInput — сам брокер (ответы AskUserQuestion
        // из `answers`); окно его и так вырезает. Отказ — до брокера: карточка остаётся ждать.
        if (Object.hasOwn(p, 'updatedInput')) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'perm.resolve: updatedInput не принимается — разрешается ровно показанный запрос')
        }
        const id = String(p['id'] ?? '')
        const decision = p['decision'] === 'allow' ? 'allow' as const : 'deny' as const
        // M8d: ширина «да». Нет поля — `once`, как до M8d; кривое значение — отказ, а не «один раз молча».
        const scope = p['scope'] === undefined ? 'once' : p['scope']
        if (!PERMISSION_SCOPES.includes(scope as PermissionScope)) {
          throw new ManagerError(ERROR_CODES.invalidParams, 'perm.resolve: scope — once | session | rule')
        }
        if (decision === 'deny' && scope !== 'once') {
          throw new ManagerError(ERROR_CODES.invalidParams, 'perm.resolve: scope бывает только у разрешения')
        }
        let ok: boolean
        try {
          ok = broker.resolve(id, {
            behavior: decision,
            ...(scope !== 'once' ? { scope: scope as PermissionScope } : {}),
            ...(p['answers'] !== undefined ? { answers: p['answers'] as PermissionDecision['answers'] } : {}),
            ...(str(p['message']) !== undefined ? { message: str(p['message']) as string } : {}),
          }, `${conn.client}#${conn.id}`)
        } catch (e) {
          if (e instanceof ScopeError) throw new ManagerError(ERROR_CODES.invalidParams, `perm.resolve: ${e.message}`)
          throw e
        }
        if (!ok) throw new ManagerError(ERROR_CODES.notFound, `запроса ${id} нет в очереди`)
        return { resolved: true, id, decision, ...(decision === 'allow' ? { scope } : {}) }
      }
      case 'perm.request': {
        // Внутренний метод заглушки `pult mcp-ask`. 0.3.7: право — ключ вопросов, а не самоназвание `client: mcp-ask`
        // (его мог назвать любой держатель токена). Токен хозяина вопросов не задаёт: иначе он повесил бы в Inbox
        // карточку от имени агента.
        if (conn.role !== 'ask' || !conn.askKey) {
          throw new ManagerError(ERROR_CODES.forbidden, 'perm.request: только по ключу вопросов сессии (pult mcp-ask)')
        }
        const bound = askKeys.lookup(conn.askKey)
        if (bound === null || bound !== conn.askSession) {
          throw new ManagerError(ERROR_CODES.forbidden, 'perm.request: ключ вопросов снят — процесс агента завершился')
        }
        // Сессия — та, к которой привязан ключ; чужое имя в параметрах — отказ, а не молчаливая подмена.
        if (p['sessionId'] !== undefined && p['sessionId'] !== bound) {
          throw new ManagerError(ERROR_CODES.forbidden, `perm.request: ключ выдан сессии ${bound}, не ${String(p['sessionId'])}`)
        }
        const sessionId = bound
        // Незаведённое имя (сессию удалили, пока жил процесс) повесило бы в Inbox запрос-призрак. Отказ на входе.
        if (!manager.has(sessionId)) {
          throw new ManagerError(ERROR_CODES.notFound, `perm.request: сессии ${sessionId} нет`)
        }
        return await broker.request({
          sessionId,
          toolName: String(p['toolName'] ?? 'tool'),
          ...(str(p['toolUseId']) !== undefined ? { toolUseId: str(p['toolUseId']) as string } : {}),
          input: (p['input'] && typeof p['input'] === 'object' ? p['input'] : {}) as Record<string, unknown>,
        }, { signal: conn.closed.signal })
      }
      case 'usage.get':
        return { usage: manager.usage() }
      case 'provider.reset': {
        const kind = p['provider'] === 'codex' ? 'codex' : 'claude'
        return { provider: kind, ...manager.providerReset(kind) }
      }
      default:
        throw new ManagerError(ERROR_CODES.notFound, `неизвестный метод ${method}`)
    }
  }

  const dispatch = async (conn: Connection, req: RpcRequest): Promise<void> => {
    const send = (payload: unknown): void => { writeFrame(conn, payload) }
    const fail = (code: string, message: string, data?: unknown): void =>
      send({ id: req.id, error: { code, message, ...(data !== undefined ? { data } : {}) } })
    // Параметры — объект БЕЗ прототипа, только собственные поля запроса (ревью #16): решения о правах (`approval ?? 'ask'`,
    // `confirm`, `'updatedInput' in p`, `scope`, `browser`) не должны зависеть от того, что лежит в Object.prototype.
    const params = ownParams(req.params)
    // 0.3.7: ключ вопросов — ничего, кроме `perm.request` (ни подписки, ни статуса, ни resolve).
    if (conn.role !== 'owner' && req.method !== 'perm.request') {
      fail(ERROR_CODES.forbidden, `${req.method}: ключ вопросов даёт только perm.request`)
      return
    }
    // 0.3.4: первый вызов интерфейса окна — окно готово (обновление окна ждёт этого, а не одного hello main).
    if (conn.client === 'shell' && conn.app && !conn.rendererSeen && RENDERER_METHODS.has(req.method)) {
      conn.rendererSeen = true
      appUpdater.onShellReady(conn.app)
    }

    switch (req.method) {
      case 'daemon.status': {
        const st = status()
        if (st.update?.app) st.update = updateStatus(st.update, conn)
        send({ id: req.id, result: st })
        return
      }

      case 'daemon.stop':
        send({ id: req.id, result: { stopping: true } })
        // Останавливаемся ПОСЛЕ ответа: клиент должен успеть его прочитать.
        setTimeout(() => {
          void stop('запрошено через daemon.stop').catch((e) => { logger.error('остановка по daemon.stop не удалась', { error: (e as Error).message }) })
        }, 20)
        return

      case 'doctor.run':
        send({ id: req.id, result: await withLanguage(params['locale'] === 'en' || params['locale'] === 'ru' ? params['locale'] : getLanguage(), () => doctorOnce(params['net'] === false)) })
        return

      // --- M8c: канал обновлений -------------------------------------------------------
      case 'update.status':
        send({ id: req.id, result: updateStatus(undefined, conn) })
        return

      case 'update.check': {
        // Без параметров — ручная «Проверить сейчас». `ifOlderThanMs` — просьба окна по фокусу: демон сам решает,
        // идти ли в сеть (автопроверка включена, последняя попытка старше, не чаще раза в 10 минут).
        const older = params['ifOlderThanMs']
        if (older !== undefined && (typeof older !== 'number' || !Number.isFinite(older) || older < 0)) {
          fail(ERROR_CODES.invalidParams, 'update.check: ifOlderThanMs — неотрицательное число')
          return
        }
        send({ id: req.id, result: updateStatus(await (older !== undefined ? updater.checkIfStale(older) : updater.check()), conn) })
        return
      }

      case 'update.apply': {
        if (params['force'] !== undefined && typeof params['force'] !== 'boolean') { fail(ERROR_CODES.invalidParams, 'update.apply: force — true или false'); return }
        const target = params['target']
        if (target !== undefined && target !== 'package' && target !== 'app' && target !== 'all') { fail(ERROR_CODES.invalidParams, "update.apply: target — 'all', 'package' или 'app'"); return }
        if (target === 'app') {
          // 0.3.4: окно. Тот же метод моста, что «Обновить» пакета, — окну 0.1.15 новая оболочка не нужна.
          const expect = params['expect']
          if (expect !== undefined && (typeof expect !== 'string' || !expect || expect.length > 40)) { fail(ERROR_CODES.invalidParams, 'update.apply: expect — версия окна'); return }
          if (params['allowBad'] !== undefined && typeof params['allowBad'] !== 'boolean') { fail(ERROR_CODES.invalidParams, 'update.apply: allowBad — true или false'); return }
          if (params['rollback'] !== undefined && typeof params['rollback'] !== 'boolean') { fail(ERROR_CODES.invalidParams, 'update.apply: rollback — true или false'); return }
          try {
            send({ id: req.id, result: await appUpdater.apply({ ...(typeof expect === 'string' ? { expect } : {}), allowBad: params['allowBad'] === true, rollback: params['rollback'] === true }) })
          } catch (e) {
            if (e instanceof AppUpdateError) { fail(ERROR_CODES.invalidParams, e.message); return }
            throw e
          }
          return
        }
        if (target === 'package') {
          try {
            send({ id: req.id, result: await updater.apply(params['force'] === true) })
          } catch (e) {
            if (e instanceof ApplyError) { fail(ERROR_CODES.invalidParams, e.message); return }
            throw e
          }
          return
        }
        // 0.3.16: без target (так зовёт и окно 0.3.15) или 'all' — одна кнопка «Перезапустить и обновить»: есть новый
        // пакет — он (ожидание ходов, `pult update`, рестарт), а окно доведёт новый демон по журналу; пакет последний —
        // сразу окно (замена бандла или перезапуск окна с интерфейсом другой версии).
        try {
          const st0 = updater.status()
          const pkg = st0.apply.state === 'waiting' || st0.apply.state === 'applying' || st0.available ? st0 : await updater.check()
          if (pkg.apply.state === 'waiting' || pkg.apply.state === 'applying' || pkg.available) {
            send({ id: req.id, result: await updater.apply(params['force'] === true, true) })
            return
          }
          const r = await appUpdater.applyAll({})
          if (r) { send({ id: req.id, result: r }); return }
          throw new ApplyError(pkg.error ? `проверить канал не вышло: ${pkg.error}` : `ставить нечего: ${VERSION} — последняя`)
        } catch (e) {
          if (e instanceof ApplyError || e instanceof AppUpdateError) { fail(ERROR_CODES.invalidParams, e.message); return }
          throw e
        }
      }

      case 'events.tail': {
        const since = typeof params['since'] === 'number' ? params['since'] : 0
        const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined
        const limit = typeof params['limit'] === 'number' ? params['limit'] : undefined
        const events = store.readFrom(since, {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(limit !== undefined ? { limit } : {}),
        })
        send({ id: req.id, result: { events, cursor: store.lastId } })
        return
      }

      // --- окно: снимок на старте, лента по требованию, полные события (0.2.19) ---------
      case 'events.snapshot':
        send({ id: req.id, result: store.snapshot() })
        return

      case 'events.history': {
        const sessionId = params['sessionId']
        if (typeof sessionId !== 'string' || !sessionId) { fail(ERROR_CODES.invalidParams, 'events.history: нужен sessionId'); return }
        const before = Number.isSafeInteger(params['before']) ? (params['before'] as number) : null
        // Бюджет страницы можно только уменьшить (тесты): больше — ответ перерастёт строку клиента.
        const budget = Number.isSafeInteger(params['budget']) ? Math.max(1024, Math.min(params['budget'] as number, HISTORY_PAGE_BYTES)) : HISTORY_PAGE_BYTES
        // Чтение файла и курсор — в одном синхронном куске: append между ними не вклинится.
        const page = pageHistory(compactHistory(store.readSession(sessionId)), before, budget)
        send({ id: req.id, result: { ...page, cursor: store.lastId } })
        return
      }

      case 'events.get': {
        const ids = Array.isArray(params['ids']) ? (params['ids'] as unknown[]).filter((x): x is number => Number.isSafeInteger(x)) : []
        if (!ids.length) { fail(ERROR_CODES.invalidParams, 'events.get: нужен непустой ids'); return }
        if (ids.length > GET_LIMIT) { fail(ERROR_CODES.invalidParams, `events.get: не больше ${GET_LIMIT} номеров за раз`); return }
        // Полный вход Write и вывод cat бывают по сотне килобайт: строки урезаются, а ответ целиком
        // держится в бюджете страницы — строка больше 1 МиБ порвала бы соединение окна.
        const events: PultEvent[] = []
        let bytes = 0
        let truncated = false
        for (const ev of store.readIds(ids)) {
          const clipped = clipEvent(ev, GET_STRING_CHARS)
          const size = Buffer.byteLength(JSON.stringify(clipped))
          if (bytes + size > HISTORY_PAGE_BYTES && events.length) { truncated = true; break }
          bytes += size
          events.push(clipped)
        }
        send({ id: req.id, result: { events, ...(truncated ? { truncated: true } : {}) } })
        return
      }

      case 'events.search': {
        // ⌘⇧F окна (src/core/search.ts): по файлам заведённых сессий, кусками, с уступками циклу.
        const raw = params['query']
        if (typeof raw !== 'string' || !normalizeQuery(raw)) { fail(ERROR_CODES.invalidParams, 'events.search: нужен непустой query'); return }
        if (raw.length > QUERY_MAX_CHARS) { fail(ERROR_CODES.invalidParams, `events.search: query не длиннее ${QUERY_MAX_CHARS} знаков`); return }
        if (params['sessionId'] !== undefined && typeof params['sessionId'] !== 'string') { fail(ERROR_CODES.invalidParams, 'events.search: sessionId — строка'); return }
        const one = str(params['sessionId'])
        const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(int(params['limit'], SEARCH_LIMIT_DEFAULT))))
        // Только заведённые сессии: файлы удалённых остаются на диске, но их в поиске нет.
        const sessionIds = one !== undefined ? (manager.has(one) ? [one] : []) : manager.list().map((r) => r.name)
        const gen = ++conn.searchGen
        const r = await searchEvents({
          eventsDir: paths.events, query: raw, sessionIds, limit,
          shouldStop: () => stopping || conn.socket.destroyed || conn.searchGen !== gen,
        })
        // Отрывки по 200 знаков × 200 результатов — около 100 КБ; страховка от строки больше 1 МиБ всё равно стоит.
        while (r.results.length && Buffer.byteLength(JSON.stringify(r)) > HISTORY_PAGE_BYTES) { r.results.pop(); r.truncated = true }
        send({ id: req.id, result: r })
        return
      }

      case 'events.subscribe': {
        const since = typeof params['since'] === 'number' ? params['since'] : 0
        const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined
        const sink = {
          write: (frame: unknown): boolean => {
            if (conn.socket.destroyed) return false
            if (conn.socket.writableLength > backlogLimit) return false
            // Строка больше 1 МиБ рвёт соединение окна: великанское событие уходит урезанным (`fitEvent`).
            let line = encodeLine(frame)
            const f = frame as { event?: PultEvent }
            if (f && f.event && line.length > LIVE_LINE_BYTES / 4 && Buffer.byteLength(line) > LIVE_LINE_BYTES) {
              line = encodeLine({ ...f, event: fitEvent(f.event) })
            }
            conn.socket.write(line)
            return true
          },
          // Прощальный кадр идёт МИМО лимита и закрывает соединение: клиент, которого отцепили
          // за медлительность, иначе не узнаёт об этом никогда — поток просто затихает.
          close: (frame: unknown): void => {
            if (conn.socket.destroyed) return
            try { conn.socket.write(encodeLine(frame)) } catch { /* уже мёртв */ }
            try { conn.socket.end() } catch { /* уже мёртв */ }
          },
          // Порог ниже лимита отцепления: доигрывание не доводит буфер до него, и обычные ответы
          // посреди доигрывания (окно шлёт `agent.list` сразу после подписки) проходят.
          backedUp: (): boolean => conn.socket.writableLength > Math.min(REPLAY_HIGH_WATER, backlogLimit / 2),
          drained: (): Promise<boolean> => new Promise<boolean>((resolve) => {
            const s = conn.socket
            if (s.destroyed) { resolve(false); return }
            if (!s.writableNeedDrain) { resolve(true); return }
            const done = (ok: boolean): void => {
              clearTimeout(timer)
              s.off('drain', onDrain)
              s.off('close', onClose)
              resolve(ok)
            }
            const onDrain = (): void => done(true)
            const onClose = (): void => done(false)
            const timer = setTimeout(() => done(false), REPLAY_STALL_MS)
            timer.unref?.()
            s.once('drain', onDrain)
            s.once('close', onClose)
          }),
        }
        // 0.3.5: курсор от LIVE_CURSOR_BASE — живой канал фаз хода (src/sessions/turnPhase.ts): так его открывает и
        // окно 0.1.15, у которого в подписке нет ничего, кроме `since`.
        const live = params['live'] === true || since >= LIVE_CURSOR_BASE
        const handle = conn.subs.subscribe(
          { since, ...(sessionId !== undefined ? { sessionId } : {}), ...(live ? { live: true } : {}) },
          sink,
        )
        // Сначала ответ с номером подписки, потом кадры: обратный порядок клиент не разберёт.
        send({ id: req.id, result: { sub: handle.sub, cursor: store.lastId } })
        handle.start().catch((e: Error) => {
          logger.error('доигрывание подписки упало', { conn: conn.id, sub: handle.sub, error: e.message })
        })
        return
      }

      case 'events.unsubscribe': {
        const sub = typeof params['sub'] === 'number' ? params['sub'] : null
        if (sub === null) { fail(ERROR_CODES.invalidParams, 'нужен числовой параметр sub'); return }
        send({ id: req.id, result: { removed: conn.subs.unsubscribe(sub) } })
        return
      }

      case 'events.emit': {
        // Служебный метод: только под PULT_TEST=1. В обычной сборке события порождает код
        // адаптеров, и давать клиенту право писать в журнал незачем.
        if (!opts.testMode) { fail(ERROR_CODES.notFound, 'метод events.emit доступен только при PULT_TEST=1'); return }
        const kind = params['kind']
        if (!isEventKind(kind)) { fail(ERROR_CODES.invalidParams, 'kind не из словаря событий'); return }
        const count = typeof params['count'] === 'number' ? Math.max(1, Math.min(1000, params['count'])) : 1
        const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : DAEMON_SESSION
        const provider = params['provider'] === 'claude' || params['provider'] === 'codex' ? params['provider'] : 'pult'
        const data = (params['data'] ?? {}) as Record<string, unknown>
        const ids: number[] = []
        for (let i = 0; i < count; i++) {
          ids.push(emit({ sessionId, provider, kind, data: { ...data, n: i } }).id)
        }
        send({ id: req.id, result: { ids, lastEventId: store.lastId } })
        return
      }

      // --- агенты, разрешения, расход ---------------------------------------
      case 'project.list':
      case 'project.add':
      case 'project.remove':
      case 'providers.check':
      case 'agent.configure':
      case 'settings.get':
      case 'settings.set':
      case 'sessions.external.list':
      case 'sessions.external.read':
      case 'agent.import':
      case 'agent.start':
      case 'agent.browser':
      case 'mcp.list':
      case 'mcp.select':
      case 'agent.rename':
      case 'agent.archive':
      case 'agent.prompt':
      case 'agent.read':
      case 'agent.wait':
      case 'agent.list':
      case 'agent.seen':
      case 'agent.retry':
      case 'agent.queue.resume':
      case 'agent.queue.remove':
      case 'agent.queue.move':
      case 'agent.stop':
      case 'agent.rm':
      case 'agent.tree':
      case 'agent.export':
      case 'perm.list':
      case 'perm.rules':
      case 'perm.rules.revoke':
      case 'perm.resolve':
      case 'perm.request':
      case 'usage.get':
      case 'provider.reset': {
        try {
          send({ id: req.id, result: await agentMethod(conn, req.method, params) })
        } catch (e) {
          if (e instanceof ManagerError) { fail(e.code, e.message); return }
          fail(ERROR_CODES.internal, (e as Error).message)
        }
        return
      }

      default:
        if (LATER_METHODS.has(req.method)) {
          fail(ERROR_CODES.notImplemented, `метод ${req.method} ещё не реализован в В1`)
          return
        }
        fail(ERROR_CODES.notFound, `неизвестный метод ${req.method}`)
    }
  }

  server.on('connection', (socket) => {
    const id = ++connSeq
    const conn: Connection = { id, socket, authed: false, client: 'unknown', role: 'none', subs: createSubscriptions(bus, store, liveChannel), searchGen: 0, closed: new AbortController() }
    connections.set(id, conn)
    const splitter = createLineSplitter()

    const bye = (code: string, message?: string): void => {
      try { socket.write(encodeLine({ type: 'error', code, ...(message ? { message } : {}) })) } catch { /* мёртв */ }
      socket.destroy()
    }

    const timer = setTimeout(() => {
      if (!conn.authed) {
        logger.warn('рукопожатие не состоялось', { conn: id, reason: 'handshake_timeout' })
        bye('handshake_timeout', 'первое сообщение hello не пришло за 2 с')
      }
    }, HANDSHAKE_TIMEOUT_MS)

    socket.on('data', (chunk: Buffer) => {
      let lines: string[]
      try {
        lines = splitter.push(chunk)
      } catch (e) {
        if (e instanceof NdjsonError) { bye(e.code, e.message); return }
        throw e
      }
      for (const line of lines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          bye('bad_json', 'строка не разбирается как JSON')
          return
        }
        // `null`, `42` и `[]` — валидный JSON. Без этой проверки первое же `null\n` от
        // неаутентифицированного клиента роняло весь демон на `msg['type']`.
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          bye('bad_json', 'сообщение должно быть объектом JSON')
          return
        }
        const msg = parsed as Record<string, unknown>

        if (!conn.authed) {
          if (msg['type'] !== 'hello') {
            logger.warn('первым сообщением не hello', { conn: id, got: String(msg['type']) })
            bye('handshake_required', 'первым сообщением должно быть hello')
            return
          }
          // Рукопожатие — в try: любой бросок на чужом вводе (до 0.3.7 — `timingSafeEqual` на ключе не той длины в байтах)
          // ронял бы весь демон, ведь это обработчик 'data' сокета. Отказ рукопожатия вместо этого.
          try {
            // 0.3.7: ровно одно — токен хозяина или ключ вопросов. Оба сразу — отказ: право не должно зависеть
            // от того, какое поле демон проверил первым.
            // Наличие поля, а не его непустота: `{token: "", ask: …}` — тоже «оба сразу».
            const given = typeof msg['token'] === 'string' ? msg['token'] : ''
            const askGiven = typeof msg['ask'] === 'string' ? msg['ask'] : ''
            let role: 'owner' | 'ask'
            let askSession: string | null = null
            if (msg['token'] !== undefined && msg['ask'] !== undefined) {
              logger.warn('рукопожатие с токеном и ключом вопросов сразу', { conn: id })
              bye('bad_token', 'токен или ключ вопросов — одно из двух')
              return
            } else if (msg['ask'] !== undefined) {
              askSession = askKeys.lookup(askGiven)
              if (askSession === null) {
                logger.warn('отвергнут неверный ключ вопросов', { conn: id, givenLength: askGiven.length })
                bye('bad_token', 'ключ вопросов не подходит')
                return
              }
              role = 'ask'
            } else {
              if (!tokenEquals(given, token)) {
                logger.warn('отвергнут неверный токен', { conn: id, givenLength: given.length })
                bye('bad_token', 'токен не подходит')
                return
              }
              role = 'owner'
            }
            const protocol = msg['protocol']
            if (protocol !== undefined && protocol !== PROTOCOL_VERSION) {
              bye('bad_protocol', `демон говорит на протоколе ${PROTOCOL_VERSION}`)
              return
            }
            conn.authed = true
            conn.role = role
            if (role === 'ask') { conn.askKey = askGiven; conn.askSession = askSession as string }
            // Самоназвание — только для журнала и `by`; режем до разумного, чтобы не тащить мусор в журнал.
            conn.client = typeof msg['client'] === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(msg['client']) ? msg['client'] : 'unknown'
            clearTimeout(timer)
            // 0.3.4: оболочка называет свою версию и путь — обновление окна ждёт hello НОВОЙ версии.
            if (conn.client === 'shell' && role === 'owner') {
              conn.app = shellHelloOf(msg['app'])
              appUpdater.onShellHello(conn.app)
            }
            socket.write(encodeLine({
              type: 'hello_ok',
              protocol: PROTOCOL_VERSION,
              daemon: { version: VERSION, pid: process.pid, startedAt },
            }))
            logger.info('клиент подключился', { conn: id, client: conn.client, role, ...(askSession ? { session: askSession } : {}) })
          } catch (e) {
            logger.warn('рукопожатие упало на вводе клиента', { conn: id, error: (e as Error).message })
            bye('bad_token', 'рукопожатие не разобрано')
            return
          }
          continue
        }

        const req = msg as unknown as RpcRequest
        if (req.id === undefined || typeof req.method !== 'string') {
          writeFrame(conn, { id: req.id ?? null, error: { code: ERROR_CODES.invalidParams, message: 'нужны поля id и method' } })
          continue
        }
        void withLanguage(req.locale === 'ru' || req.locale === 'en' ? req.locale : () => resolveLanguage(config.language, process.env['LC_ALL'] || process.env['LC_MESSAGES'] || process.env['LANG'] || Intl.DateTimeFormat().resolvedOptions().locale), () => dispatch(conn, req)).catch((e: unknown) => {
          logger.error('метод упал', { method: req.method, error: (e as Error).message })
          try {
            writeFrame(conn, { id: req.id, error: { code: ERROR_CODES.internal, message: String((e as Error).message) } })
          } catch { /* соединение уже закрыто */ }
        })
      }
    })

    socket.on('error', () => { /* клиент исчез — это не ошибка демона */ })
    socket.on('close', () => {
      clearTimeout(timer)
      conn.subs.dispose()
      connections.delete(id)
      // Окно, которое правило реплику очереди, ушло — очередь не ждёт его правки.
      manager.queueReleaseOwner(id)
      // Заглушка `pult mcp-ask` умерла посреди вопроса — её вопросы уходят из Inbox отказом.
      conn.closed.abort()
    })
  })

  // umask на время bind: между `listen` и `chmod` есть await-граница, и в этот зазор сокет
  // лежал бы с правами по умолчанию (обычно 0755). chmod ниже остаётся поясом к подтяжкам.
  const prevUmask = process.umask(0o077)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(paths.sock, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } finally {
    process.umask(prevUmask)
  }
  chmodSync(paths.sock, 0o600)

  // Картинки из буфера окна (PULT_HOME/attachments, окно 0.1.16): папка есть всегда (её отдают claude через --add-dir),
  // старше 30 дней — удаляются на старте и раз в сутки (src/core/attachments.ts: только внутри, симлинки не раскрываются).
  try {
    mkdirSync(paths.attachments, { recursive: true, mode: 0o700 })
    // Права — как у остальных папок PULT_HOME (mode у mkdir режет umask). Симлинк на месте папки не трогаем: chmod пошёл бы по нему.
    if (lstatSync(paths.attachments).isDirectory()) chmodSync(paths.attachments, 0o700)
  } catch (e) { logger.warn('attachments не создалась', { error: (e as Error).message }) }
  const sweepAttachmentsNow = (): void => {
    try {
      const r = sweepAttachments(paths.attachments)
      if (r.files || r.dirs || r.errors) logger.info('уборка attachments', { ...r })
    } catch (e) { logger.warn('уборка attachments не удалась', { error: (e as Error).message }) }
  }
  sweepAttachmentsNow()
  const attachmentsTimer = setInterval(sweepAttachmentsNow, ATTACHMENTS_SWEEP_MS)
  attachmentsTimer.unref?.()

  const stop = async (reason: string): Promise<void> => {
    if (stopping) return
    stopping = true
    logger.info('остановка демона', { reason })
    clearInterval(attachmentsTimer)
    updater.stop()
    // Сначала ОТКАЗ всем, кто ждёт решения, и только потом закрытие сокета: заглушка
    // `pult mcp-ask` иначе повисла бы на мёртвом сокете, а `claude` — на ней (инвариант 5).
    const denied = broker.shutdown('демон останавливается')
    if (denied) logger.warn('отказано ожидающим запросам разрешений', { count: denied })
    try { await manager.shutdown() } catch (e) { logger.error('адаптеры не погасились', { error: (e as Error).message }) }
    // Обновление окна, уже меняющее бандл, — после отказов и адаптеров и ненадолго (≤ 3 с): launchd добивает службу
    // SIGKILL через 5 с; оборванную замену доведёт или откатит следующий старт по журналу apps/swap.json.
    await appUpdater.stop()
    notifyRunner?.close()
    try { await rules.close() } catch (e) { logger.warn('правила codex: ожидания меток не закрыты', { error: (e as Error).message }) }
    // Журнал мог сломаться (диск кончился) — это не повод не доводить остановку до конца.
    try {
      emit({ sessionId: DAEMON_SESSION, provider: 'pult', kind: 'daemon.stopping', data: { reason } })
    } catch (e) {
      logger.error('daemon.stopping не записался', { error: (e as Error).message })
    }
    for (const conn of [...connections.values()]) {
      conn.subs.dispose({ code: 'daemon_stopping', message: 'демон останавливается' })
      try { conn.socket.end() } catch { /* уже закрыт */ }
      try { conn.socket.destroy() } catch { /* уже закрыт */ }
    }
    connections.clear()
    liveChannel.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
    // LOCK СНИМАЕТСЯ ПОСЛЕДНИМ. Он — единственный арбитр «демон здесь один», и пока он держан,
    // второй демон не начнёт занимать сокет и токен. Обратный порядок (сокет последним) я
    // однажды поставил ради удобства теста — и это была ошибка: между `lock.release()` и
    // `unlink(sock)` новый демон успевал взять lock и снести ЧУЖОЙ, уже свежий сокет.
    // Тест, который из-за этого моргал, теперь ждёт исчезновения САМОГО lock-файла.
    try { unlinkSync(paths.sock) } catch { /* уже нет */ }
    try { unlinkSync(paths.token) } catch { /* уже нет */ }
    lock.release()
    logger.info('демон остановлен', { home: paths.home })
    for (const fn of stoppedHandlers) { try { fn() } catch { /* неважно */ } }
  }

  emit({ sessionId: DAEMON_SESSION, provider: 'pult', kind: 'daemon.started', data: { version: VERSION, pid: process.pid } })
  logger.info('демон слушает', { sock: paths.sock, pid: process.pid, version: VERSION })

  return {
    ok: true,
    daemon: {
      token,
      paths,
      bus,
      store,
      broker,
      askKeys,
      manager,
      startedAt,
      status,
      emit,
      stop,
      onStopped: (fn) => { stoppedHandlers.push(fn) },
    },
  }
}
