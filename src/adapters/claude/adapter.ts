// Адаптер Claude: процессы, ходы, сеть, разрешения, субагенты.
//
// ДВА РЕЖИМА НОДЫ (решение DELTA v0.5 §3):
//   `turn` (по умолчанию) — процесс НА ХОД. Спавн → одна реплика в stdin → `result` → stdin
//        закрывается → процесс уходит. Следующий ход поднимает новый процесс с `--resume <тот
//        же uuid>`. Проще, устойчивее к обрывам сети и не держит десятки процессов. Серверный
//        кэш промпта от этого не страдает: он живёт на стороне API, а не на процессе.
//   `warm` — процесс живёт между ходами, его снимает жнец через `warmTtlMs`. Выигрыш 1–2 с на
//        реплику; нужен интерактивному чату, не флоу.
//
// «ХОД ЗАВЕРШЁН» ≠ «РАБОТА ЗАВЕРШЕНА». Фоновый субагент живёт в процессе CLI и доделывает работу
// ПОСЛЕ ответа на реплику; его итог CLI сам отыгрывает отдельным ходом (`init` → `assistant` →
// `result`) в ту же открытую сессию. ИЗМЕРЕНО 21.09.2026 (фикстура 06) и 07.10.2026 (CLI 2.1.291).
// Как это устроено с 07.10.2026 (раньше ход держала отсрочка `subagentGraceMs`, а по её концу
// процесс снимали — вместе с ещё живыми субагентами и их работой):
//   * ход человека закрывается по СВОЕМУ `result` — сессия сразу принимает новые реплики
//     (живой процесс их берёт: замер — PONG за секунду при идущем субагенте);
//   * пока список `system/background_tasks_changed` не пуст (или ход запускал фоновую работу),
//     процесс живёт; его ходы-итоги слушает «фоновый слушатель» (`attachIdle`): статус `working`
//     с причиной `background_turn`, затем `idle`, всё содержимое — в журнал;
//   * задач не осталось и `subagentGraceMs` тишины — stdin закрывается, процесс уходит сам;
//   * потолок `backgroundMaxMs` — страховка от вечного процесса: по нему процесс снимается.
// `subagent_stats` НАКОПИТЕЛЬНЫЙ по процессу, поэтому «всё доделано» берётся из списка задач.
//
// ЧТО ЗАПРЕЩЕНО ЗДЕСЬ И ПОЧЕМУ:
//   * ход без проверки страны выхода — перед ПЕРВЫМ ходом сессии и перед любым ходом после
//     простоя дольше 60 с (инвариант 2). Блок → событие `net.blocked`, ошибка `blocked_network`;
//   * повторы после «disabled Claude subscription access» — провайдер останавливается ЦЕЛИКОМ
//     (инвариант 3), снимается только методом `provider.reset`;
//   * больше трёх подряд `system/api_retry` — `claude` сам не останавливается (10 повторов за
//     ~149 с), поэтому его прерываем мы.

import { createImageCapture } from '../../core/images.js'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PultConfig } from '../../core/config.js'
import type { EventDraft } from '../../core/events.js'
import type { Logger } from '../../core/log.js'
import { redactString } from '../../core/log.js'
import { createLineSplitter } from '../../core/ndjson.js'
import type { PultPaths } from '../../core/paths.js'
import { sessionAttachmentsDirs } from '../../core/attachments.js'
import { buildChildEnv } from '../../env/allowlist.js'
import { checkNetwork, netGeneration, netRefusal, noProxyValue } from '../../env/net.js'
import { readSavedNode, resolveChildNode } from '../../env/nodeBin.js'
import type { NetCheck } from '../../env/net.js'
import type { SessionRecord } from '../../sessions/registry.js'
import type {
  AdapterDeps, ApprovalMode, PermissionDecision, ProviderAdapter, SessionMcpExtras, SessionSpec, StartedSession, TurnOutcome, TurnSettings, TurnStarted,
} from '../types.js'
import { APPROVAL_WORDS } from '../../sessions/settings.js'
import { buildClaudeArgv, mcpConfigBody, userTurnLine } from './argv.js'
import { createAskKeys } from '../../perm/askKeys.js'
import type { AskKeys } from '../../perm/askKeys.js'
import { createClaudeMapper, NO_CONVERSATION_RE } from './mapper.js'
import type { ClaudeMapper, TurnSignal } from './mapper.js'

type ResultSignal = Extract<TurnSignal, { kind: 'result' }>

/** Простой дольше этого — страж проверяется заново (инвариант 2). */
export const IDLE_RECHECK_MS = 60_000
/** Сколько ждать после SIGINT, прежде чем послать SIGTERM. */
export const INTERRUPT_GRACE_MS = 2_000
/** Сколько ждать после SIGTERM, прежде чем послать SIGKILL. Дальше ждать нечего. */
export const INTERRUPT_KILL_MS = 3_000

export interface ClaudeAdapterOptions extends AdapterDeps {
  paths: PultPaths
  config: PultConfig
  logger: Logger
  /** Путь к бинарю `claude`. Тест подсовывает сюда фальшивый CLI. */
  bin: string
  /** Путь к `dist/cli/main.js` — его же запускает заглушка разрешений. */
  cliEntry?: string
  /** Node, на котором работает демон (по умолчанию process.execPath). Тест подсовывает удалённый. */
  nodeExec?: string
  /** Инъекция стража сети: тест не ходит в сеть вообще. */
  netCheck?: (provider: 'claude') => Promise<NetCheck>
  now?: () => number
  /**
   * 0.3.7: ключи вопросов демона — по ключу на процесс `claude` с брокером, снимается на его выходе. Нет — свои
   * (тест адаптера без демона): заглушка с таким ключом демону не нужна, её вопросы получат отказ.
   */
  askKeys?: AskKeys
}

interface Live {
  spec: SessionSpec
  providerSessionId: string
  /**
   * Заведён ли разговор на стороне CLI: он решает `--session-id` против `--resume`.
   *
   * ПОДНИМАЕТ ЕГО ТОЛЬКО `system/init`, и это не придирка. Ход, убитый раньше init (стоп
   * через секунду после `prompt`, отказ спавна, блок стража), не оставляет на диске
   * НИЧЕГО — папки `~/.claude/projects/<cwd>/` не появляется вовсе. Пока флаг поднимал
   * любой законченный ход, следующий уходил с `--resume <uuid>`, получал
   * `No conversation found with session ID`, и так КАЖДЫЙ следующий: агент был мёртв до
   * `agent rm`. ИЗМЕРЕНО 21.09.2026 на claude 2.1.278, фикстура 10.
   */
  started: boolean
  child: ChildProcess | null
  mapper: ClaudeMapper | null
  lastTurnAt: number
  mcpConfigPath: string | null
  /** 0.3.7: ключ вопросов последнего процесса (тот, что в файле --mcp-config). Снимается на выходе процесса. */
  askKey?: string | null
  /** Ход в работе: второй `send` по той же сессии обязан отказать, а не смешать потоки. */
  busy: boolean
  reaper: NodeJS.Timeout | null
  closing: boolean
  /**
   * Был `interrupt`, пока ход ещё не дошёл до спавна. Страж сети — это `await`, и ребёнок
   * может родиться уже ПОСЛЕ того, как `agent stop` отчитался об успехе: без этого флага
   * он остался бы жить никем не управляемым до жнеца или до остановки демона.
   */
  stopRequested: boolean
  /** Профиль сети, выбранный последней проверкой стража: он и уезжает ребёнку. */
  netEnv: Record<string, string>
  /** Живые фоновые задачи процесса — последний `background_tasks_changed`. */
  bgTasks: number
  /** Фоновый слушатель между ходами (процесс жив ради фоновых задач или тёплый). */
  idle: { detach(): void } | null
  /** Идёт ход, начатый самим CLI (итог фоновой задачи). */
  autoTurn: boolean
  /** Реплики, ждущие конца такого хода: писать в stdin посреди него — смешать два хода. */
  autoWaiters: Array<() => void>
  /**
   * M8f: с какими флагами (модель, усилие, режим, браузер) и каким путём в сеть запущен живой процесс. Ход со
   * снимком других флагов или после смены пути стражем меняет процесс на границе хода (ревью: HIGH 2, 3).
   */
  childFlags: TurnFlags | null
  childNetKey: string
  /**
   * Ход запустил фоновую работу, а `background_tasks_changed` ещё не пришёл (ревью M8f, LOW 13). Живёт не дольше
   * `subagentGraceMs` (`bgExpectedTimer`) и гаснет на любом сигнале о задачах (`background_tasks`, `task_notification`):
   * в фикстуре 06 список задач успевает стать пустым ДО `result`, и без этого флаг висел бы вечно.
   */
  bgExpected: boolean
  bgExpectedTimer: NodeJS.Timeout | null
  /** Закрыть идущий ход стопом, даже если его процесс уже закрылся (ревью M8f, HIGH 1). */
  turnAbort: ((message: string) => void) | null
}

/** M8f: флаги хода — снимок (`TurnSettings`); `browser: undefined` — снимка нет, браузер решает запись. */
type TurnFlags = TurnSettings

/** Ключ флагов процесса: другой — процесс сменится на границе хода. */
function flagsKey(f: TurnFlags): string {
  return JSON.stringify([f.model ?? null, f.effort ?? null, f.approval ?? 'ask', f.browser === undefined ? '?' : f.browser ? (f.browser.headed ? 'headed' : 'on') : 'off'])
}

const APPROVAL_RANK: Readonly<Record<ApprovalMode, number>> = { 'read-only': 0, ask: 1, workspace: 2, full: 3 }
/** Режим `next` строже `prev` (full > workspace > ask > read-only по ширине). */
export function stricterMode(next: ApprovalMode | undefined, prev: ApprovalMode | undefined): boolean {
  return APPROVAL_RANK[next ?? 'ask'] < APPROVAL_RANK[prev ?? 'ask']
}

/**
 * Снимок хода строже флагов процесса: режим строже ИЛИ браузер выключен, а процесс запущен с ним (его MCP-сервер ещё в
 * старом процессе) — ревью M8f. Неизвестный браузер снимка (`undefined`) — не строже.
 */
export function stricterFlags(next: TurnFlags, prev: TurnFlags): boolean {
  return stricterMode(next.approval, prev.approval) || (!!prev.browser && next.browser === null)
}

const netKeyOf = (env: Record<string, string>): string => JSON.stringify(env)
const netLabel = (key: string): string => (key.includes('HTTPS_PROXY') ? 'прокси' : 'напрямую')

/** Процессы, чей `close` уже был (M8f, ревью HIGH 1). */
const closedChildren = new WeakSet<ChildProcess>()

/**
 * Профиль сети процесса claude: прокси — только HTTPS_PROXY (Claude Code не умеет SOCKS, docs
 * «Claude Code does not support SOCKS proxies»). Тот же профиль у служебного запроса названия.
 */
export function claudeNetworkEnv(check: NetCheck): Record<string, string> {
  return check.path === 'proxy' && check.proxy ? { HTTPS_PROXY: check.proxy, NO_PROXY: noProxyValue(check.noProxy) } : {}
}

let turnSeq = 0

function defaultCliEntry(): string {
  return fileURLToPath(new URL('../../cli/main.js', import.meta.url))
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions): ProviderAdapter {
  const { paths, config, logger } = opts
  const now = opts.now ?? Date.now
  const cliEntry = opts.cliEntry ?? defaultCliEntry()
  const nodeExec = opts.nodeExec ?? process.execPath
  const live = new Map<string, Live>()
  /**
   * Дети, которым уже закрыли stdin и назначили добивающий SIGTERM. Таймер добивания
   * `unref`-нут (он не обязан держать событийный цикл), поэтому быстрый `daemon.stop` может
   * выйти раньше, чем он сработает, а в `live` такого ребёнка уже нет — `l.child` обнулён
   * в `finish()`. Этот список и есть то, что `shutdown()` подметает дополнительно.
   */
  const pendingKills = new Set<ChildProcess>()
  let providerBlocked: string | null = null

  const emit = (draft: EventDraft): void => { opts.emit(draft) }
  const status = (sessionId: string, s: string, extra: Record<string, unknown> = {}): void =>
    emit({ sessionId, provider: 'claude', kind: 'status.changed', data: { status: s, ...extra } })

  const netProbe = opts.netCheck
    ?? ((provider: 'claude'): Promise<NetCheck> =>
      checkNetwork(provider, config.network[provider], config.guard, {}))
  /** Поколение правил сети (`netGeneration`), при котором сессия последний раз проходила стража. */
  const netSeen = new WeakMap<Live, number>()

  const need = (name: string): Live => {
    const l = live.get(name)
    if (!l) throw new Error(`сессия ${name} не заведена в адаптере`)
    return l
  }

  /** Профиль сети ребёнка. Прямой путь не ставит НИ ОДНОЙ прокси-переменной. */
  const networkEnv = claudeNetworkEnv

  /**
   * Файл --mcp-config переписывается на КАЖДОМ запуске `claude`: node для заглушки ищется заново,
   * потому что `brew upgrade node` удаляет node, на котором ещё работает демон (src/env/nodeBin.ts).
   * Живого node нет — null: ход откажет сам, а не через загадочное «Available MCP tools: none».
   */
  const childNode = (): string | null => resolveChildNode(nodeExec, readSavedNode(paths.nodePath))
  const askKeys = opts.askKeys ?? createAskKeys()
  const revokeAskKey = (l: Live): void => {
    if (l.askKey) { askKeys.revoke(l.askKey); l.askKey = null }
  }
  /**
   * 0.3.7: папки, закрытые агенту правилами `deny` (`claudeGuardPermissions`): `PULT_HOME/run` как есть и по realpath
   * (на macOS `/var/…` — это `/private/var/…`, правило Claude сверяет путь буквально).
   */
  const protectDirs = (): string[] => {
    let real = paths.run
    try { real = realpathSync(paths.run) } catch { /* папки ещё нет — хватит пути как есть */ }
    return [...new Set([paths.run, real])]
  }
  /**
   * 0.3.8: `PULT_HOME/attachments/<сессия>` (картинки из буфера окна, вставленные в ЭТУ сессию) — в `--add-dir`, чтобы
   * claude читал их без вопроса, как файлы cwd. Без флага Read вне cwd спрашивает (замер S13, CLI 2.1.310, haiku, `manual`
   * и `default`: отказ «outside the allowed working directories»; с `--add-dir` — прочитал). Папка своя у сессии: общая
   * открыла бы каждой сессии картинки всех. Симлинк или подмена по пути — флага нет (src/core/attachments.ts).
   */
  const addDirs = (name: string): string[] => (paths.home ? sessionAttachmentsDirs(paths.home, name) : [])
  const addDirRoots = (): string[] => {
    const out = [homedir(), paths.home]
    for (const p of [homedir(), paths.home]) { try { out.push(realpathSync(p)) } catch { /* нет — как есть */ } }
    return [...new Set(out.filter(Boolean))]
  }
  const writeMcpConfig = (l: Live, nodeBin: string, servers: Record<string, Record<string, unknown>>): { file: string; askKey: string } => {
    mkdirSync(paths.run, { recursive: true, mode: 0o700 })
    const file = join(paths.run, `mcp-${l.spec.name}.json`)
    // Ключ — на процесс. Прежний снимает выход ЕГО процесса (тот мог ещё доживать после закрытия stdin и спрашивать).
    const askKey = askKeys.mint(l.spec.name)
    l.askKey = askKey
    writeFileSync(file, mcpConfigBody({
      nodeBin,
      cliEntry,
      home: paths.home,
      sessionName: l.spec.name,
      askKey,
      servers,
    }), { mode: 0o600 })
    l.mcpConfigPath = file
    return { file, askKey }
  }

  /**
   * Процесс сессии ушёл (вышел, снят, заменён) — его фоновые задачи ушли вместе с ним. Счёт, о котором окно и фаза
   * хода узнали из `background.changed`, обнуляется тем же событием (28.10.2026): иначе после стопа простаивающей
   * сессии с фоновыми задачами или падения CLI строка навсегда оставалась «в фоне» — до рестарта демона.
   * Снятой сессии (`agent rm`, новая с тем же именем) не пишется: её обнуляет `close`.
   */
  const dropBackground = (l: Live, reason: string): void => {
    if (l.bgTasks > 0 && !l.closing && live.get(l.spec.name) === l) {
      emit({ sessionId: l.spec.name, provider: 'claude', kind: 'background.changed', data: { count: 0, tasks: [], reason } })
    }
    l.bgTasks = 0
  }

  const killChild = (l: Live, signal: NodeJS.Signals = 'SIGTERM'): void => {
    const child = l.child
    if (!child) return
    l.child = null
    try { child.stdin?.end() } catch { /* уже закрыт */ }
    try { child.kill(signal) } catch { /* уже мёртв */ }
  }

  /** Ждёт выхода ребёнка. false — не дождались за `ms`: значит сигнал не подействовал. */
  const waitExit = (child: ChildProcess, ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return }
      const onExit = (): void => { clearTimeout(timer); resolve(true) }
      const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, ms)
      timer.unref?.()
      child.once('exit', onExit)
    })

  const armReaper = (l: Live): void => {
    if (l.reaper) { clearTimeout(l.reaper); l.reaper = null }
    if (l.spec.mode !== 'warm' || !l.child) return
    l.reaper = setTimeout(() => {
      if (!l.child) return
      // Фоновые задачи и их ходы-итоги жнец не трогает: тёплый процесс доживёт до следующего круга.
      if (l.busy || l.bgTasks > 0 || l.autoTurn) { armReaper(l); return }
      logger.info('жнец снял тёплый процесс', { session: l.spec.name, ttlMs: config.warmTtlMs })
      killChild(l)
      status(l.spec.name, 'cold', { reason: 'warm_ttl' })
    }, config.warmTtlMs)
    l.reaper.unref?.()
  }

  /** Отпустить реплики, ждавшие конца хода-итога. */
  const releaseAuto = (l: Live): void => {
    const w = l.autoWaiters.splice(0)
    for (const f of w) f()
  }

  /** Ждать конца хода-итога, начатого самим CLI. false — не дождались за `ms`. */
  const waitAuto = (l: Live, ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (!l.autoTurn) { resolve(true); return }
      const t = setTimeout(() => { l.autoWaiters = l.autoWaiters.filter((f) => f !== done); resolve(false) }, ms)
      t.unref?.()
      const done = (): void => { clearTimeout(t); resolve(true) }
      l.autoWaiters.push(done)
    })

  /** Закрыть процесс, который жил ради фоновых задач: stdin закрыт — CLI уходит сам. */
  const releaseProcess = (l: Live): void => {
    l.idle?.detach()
    const child = l.child
    if (!child) return
    l.child = null
    l.mapper = null
    dropBackground(l, 'process_released')
    clearBgExpected(l)
    try { child.stdin?.end() } catch { /* закрыт */ }
    pendingKills.add(child)
    child.once('exit', () => { pendingKills.delete(child) })
    const backstop = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* уже ушёл */ } }, 1500)
    backstop.unref?.()
  }

  /**
   * Фоновый слушатель: процесс жив между ходами — ради фоновых задач (режим `turn`) или потому,
   * что тёплый (`warm`). Всё, что CLI присылает сам (ход-итог фоновой задачи), идёт в журнал, а
   * статус сессии — `working` (`background_turn`) на время такого хода. Снимается следующим
   * ходом человека (`runTurn`), закрытием процесса или потолком `backgroundMaxMs`.
   */
  const attachIdle = (l: Live, carry?: { splitter: ReturnType<typeof createLineSplitter>; lines: string[] }): void => {
    const child = l.child
    const mapper = l.mapper
    if (!child || !mapper || l.idle) return
    const name = l.spec.name
    const gone = (): boolean => l.closing || live.get(name) !== l
    // Разборщик хода вместе с недочитанным хвостом: строка, порванная между кусками stdout, не теряется.
    const splitter = carry?.splitter ?? createLineSplitter()
    let quiet: NodeJS.Timeout | null = null
    const clearQuiet = (): void => { if (quiet) { clearTimeout(quiet); quiet = null } }
    // Тёплый процесс закрывает жнец, а не тишина: здесь гасится только процесс «на ход».
    const armQuiet = (): void => {
      clearQuiet()
      if (l.spec.mode === 'warm' || l.bgTasks > 0 || l.autoTurn) return
      quiet = setTimeout(() => {
        logger.info('фоновые задачи доделаны — процесс закрыт', { session: name })
        releaseProcess(l)
      }, config.subagentGraceMs)
      quiet.unref?.()
    }
    const cap = setTimeout(() => {
      logger.warn('потолок фоновой работы — процесс снят', { session: name, backgroundMaxMs: config.backgroundMaxMs, tasks: l.bgTasks })
      if (!gone()) {
        emit({ sessionId: name, provider: 'claude', kind: 'background.changed', data: { count: 0, tasks: [], reason: 'background_cap' } })
        if (l.autoTurn) status(name, 'idle', { reason: 'background_cap' })
      }
      l.autoTurn = false
      releaseAuto(l)
      l.idle?.detach()
      killChild(l, 'SIGTERM')
      l.mapper = null
      l.bgTasks = 0
      clearBgExpected(l)
    }, config.backgroundMaxMs)
    cap.unref?.()

    const onSig = (sig: TurnSignal): void => {
      switch (sig.kind) {
        case 'background_tasks':
          l.bgTasks = sig.count
          clearBgExpected(l)
          armQuiet()
          return
        case 'task_notification':
          clearBgExpected(l)
          return
        case 'session_id':
          if (sig.id && sig.id !== l.providerSessionId) l.providerSessionId = sig.id
          l.started = true
          return
        case 'turn_started':
          l.started = true
          clearQuiet()
          if (!l.autoTurn) {
            l.autoTurn = true
            if (!gone()) status(name, 'working', { reason: 'background_turn' })
          }
          return
        case 'result':
          l.lastTurnAt = now()
          if (l.autoTurn) {
            l.autoTurn = false
            if (!gone()) status(name, sig.ok ? 'idle' : 'failed', { reason: 'background_turn_done' })
            releaseAuto(l)
          }
          armQuiet()
          return
        case 'limit':
          if (!gone()) status(name, 'limited', { rateLimitStatus: sig.status })
          return
        case 'provider_blocked':
          providerBlocked = sig.text.slice(0, 400)
          if (!gone()) emit({ sessionId: name, provider: 'claude', kind: 'provider.blocked', data: { provider: 'claude', text: providerBlocked } })
          return
        default:
          return
      }
    }
    const consume = (lines: readonly string[]): void => {
      for (const line of lines) {
        let native: unknown
        try { native = JSON.parse(line) } catch { continue }
        const mapped = mapper.push(native)
        for (const draft of mapped.drafts) if (!gone()) emit(draft)
        if (mapped.live && !gone()) for (const sig of mapped.live) opts.live?.(name, sig)
        for (const sig of mapped.signals) onSig(sig)
      }
    }
    const onData = (chunk: Buffer): void => {
      let lines: string[]
      try { lines = splitter.push(chunk) } catch { return }
      consume(lines)
    }
    const onClose = (): void => {
      detach()
      if (l.child === child) { l.child = null; l.mapper = null }
      dropBackground(l, 'background_process_exit')
      clearBgExpected(l)
      if (l.autoTurn) {
        l.autoTurn = false
        if (!gone()) status(name, 'idle', { reason: 'background_process_exit' })
      }
      releaseAuto(l)
      logger.info('процесс с фоновой работой вышел', { session: name })
    }
    const detach = (): void => {
      clearQuiet()
      clearTimeout(cap)
      child.stdout?.off('data', onData)
      child.off('close', onClose)
      if (l.idle === handle) l.idle = null
    }
    const handle = { detach }
    l.idle = handle
    child.stdout?.on('data', onData)
    child.on('close', onClose)
    armQuiet()
    // Строки того же куска stdout, что пришли следом за `result` хода (ход дочитывать их не стал).
    if (carry?.lines.length) consume(carry.lines)
  }

  /**
   * Один ход. Здесь собрано ВСЁ, что отличает Claude от «просто дочернего процесса»:
   * страж сети, выбор `--session-id` против `--resume`, разбор потока, потолок повторов,
   * отсрочка на фонового субагента и закрытие процесса в режиме «процесс на ход».
   */
  /** M8f (ревью): процесс ещё держит фоновую работу — задачи, ход-итог или запущенное в ходе, о чём CLI ещё не сказал. */
  const bgBusy = (l: Live): boolean => l.bgTasks > 0 || l.autoTurn || l.bgExpected

  /** Флаг «CLI ещё скажет о фоновых задачах» — снять (сигнал пришёл, процесс ушёл, срок вышел). */
  const clearBgExpected = (l: Live): void => {
    l.bgExpected = false
    if (l.bgExpectedTimer) { clearTimeout(l.bgExpectedTimer); l.bgExpectedTimer = null }
  }
  /** Поднять флаг на `subagentGraceMs`: дольше CLI с сигналом о задачах не тянет (замер 21.09: миллисекунды). */
  const armBgExpected = (l: Live): void => {
    clearBgExpected(l)
    l.bgExpected = true
    l.bgExpectedTimer = setTimeout(() => { l.bgExpected = false; l.bgExpectedTimer = null }, config.subagentGraceMs)
    l.bgExpectedTimer.unref?.()
  }

  /**
   * M8f (ревью, HIGH 1): ребёнок, который уже закрылся (умер между ходами, а слушателя не было), — всё равно что его
   * нет. Без этого ход писал бы в мёртвый stdin и ждал `close`, который уже был, — вечно.
   */
  const dropDeadChild = (l: Live): void => {
    const child = l.child
    // `close` бывает задержан внуком, держащим трубу: вышедший процесс — тоже мёртвый (ревью M8f).
    if (!child || (!closedChildren.has(child) && child.exitCode === null && child.signalCode === null)) return
    l.idle?.detach()
    l.child = null
    l.mapper = null
    dropBackground(l, 'process_exit')
    clearBgExpected(l)
    l.autoTurn = false
    releaseAuto(l)
    if (l.reaper) { clearTimeout(l.reaper); l.reaper = null }
  }

  /** Ждать конца фоновой работы процесса (M8f, строже режим). false — стоп, сессия ушла или потолок. */
  const waitBackground = (l: Live, gone: () => boolean): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const deadline = now() + config.backgroundMaxMs
      const tick = (): void => {
        dropDeadChild(l)
        if (l.stopRequested || gone()) { resolve(false); return }
        if (!l.child || !bgBusy(l)) { resolve(true); return }
        if (now() > deadline) { resolve(false); return }
        const t = setTimeout(tick, 100)
        t.unref?.()
      }
      tick()
    })

  /**
   * Один ход. Здесь собрано ВСЁ, что отличает Claude от «просто дочернего процесса»:
   * страж сети, выбор `--session-id` против `--resume`, разбор потока, потолок повторов,
   * отсрочка на фонового субагента и закрытие процесса в режиме «процесс на ход».
   *
   * M8f (ревью): флаги хода — СНИМОК на его начале (`at` от менеджера, иначе `spec` сейчас). Процесс и набор MCP
   * строятся только из него; `configure` после этого — для следующего хода. Живой процесс, запущенный с другими
   * флагами или другим путём в сеть, меняется на границе хода; пока он держит фоновую работу — см. ниже.
   */
  const runTurn = async (l: Live, text: string, at?: TurnSettings): Promise<TurnStarted> => {
    const name = l.spec.name
    const turnId = `t${++turnSeq}`
    const flags: TurnFlags = at
      ? { ...(at.model ? { model: at.model } : {}), ...(at.effort ? { effort: at.effort } : {}), ...(at.approval ? { approval: at.approval } : {}), browser: at.browser ?? null }
      : { ...(l.spec.model ? { model: l.spec.model } : {}), ...(l.spec.effort ? { effort: l.spec.effort } : {}), ...(l.spec.approval ? { approval: l.spec.approval } : {}) }
    const fail = (errorCode: string, message: string): TurnStarted =>
      ({ turnId, done: Promise.resolve({ turnId, ok: false, errorCode, message }) })

    if (providerBlocked !== null) return fail('provider_unavailable', providerBlocked)
    if (l.busy) return fail('invalid_params', `сессия ${name} уже делает ход`)

    /**
     * Сессия уехала из-под хода: её закрыли (`agent rm`) или завели заново с тем же именем.
     * Всё, что закрытый ход ещё захочет записать, обязано быть выброшено: имя переиспользуемо,
     * и чужое `status.changed failed` иначе приезжает в журнал СВЕЖЕЙ сессии уже после её
     * `session.ended` и помечает её проваленной.
     */
    const gone = (): boolean => l.closing || live.get(name) !== l
    const emitL = (draft: EventDraft): void => { if (!gone()) emit(draft) }
    const statusL = (s: string, extra: Record<string, unknown> = {}): void => { if (!gone()) status(name, s, extra) }
    const noteL = (notice: string): void => emitL({ sessionId: name, provider: 'claude', kind: 'session.configured', data: { changes: {}, notice } })

    // Считаем только те остановки, что пришли В ЭТОТ ход: прошлый уже закончился.
    l.stopRequested = false
    dropDeadChild(l)

    // Процесс жив ради фоновых задач и прямо сейчас отыгрывает ход-итог: реплика ждёт его конца —
    // вклинить её в stdin посреди хода значит смешать два хода в одном потоке.
    if (l.autoTurn) {
      l.busy = true
      const ok = await waitAuto(l, 10 * 60_000)
      l.busy = false
      if (!ok) return fail('invalid_params', `сессия ${name} доделывает итог фоновой задачи — повтори реплику позже`)
      dropDeadChild(l)
    }

    // M8f (ревью, MED 6): живой процесс запущен с другими флагами и держит фоновую работу. Режим СТРОЖЕ — реплика
    // ждёт конца фоновых задач (не отказ: она встаёт и уйдёт сама, уже в новом процессе): иначе ход человека шёл бы
    // с прежними, более широкими правами. Остальное (модель, усилие, режим шире) — ход идёт в прежний процесс, и
    // лента говорит, что эта реплика ещё на прежних настройках.
    if (l.child && l.childFlags && flagsKey(l.childFlags) !== flagsKey(flags) && bgBusy(l)) {
      if (stricterFlags(flags, l.childFlags)) {
        l.busy = true
        noteL(stricterMode(flags.approval, l.childFlags.approval)
          ? `жду окончания фоновых задач, чтобы включить режим «${APPROVAL_WORDS[flags.approval ?? 'ask']}»`
          : 'жду окончания фоновых задач, чтобы выключить браузер: его сервер ещё в прежнем процессе Claude')
        statusL('working', { turnId, reason: 'waiting_background' })
        logger.info('реплика ждёт конца фоновых задач: режим строже', { session: name, turnId, tasks: l.bgTasks })
        const done = (async (): Promise<TurnOutcome> => {
          const ok = await waitBackground(l, gone)
          l.busy = false
          if (!ok) {
            if (l.stopRequested || gone()) return { turnId, ok: false, errorCode: 'interrupted', message: `ход ${turnId} отменён: агент остановлен, пока ждал фоновых задач` }
            statusL('failed', { turnId, reason: 'background_wait' })
            return { turnId, ok: false, errorCode: 'internal', message: 'фоновые задачи не кончились за потолок фоновой работы — реплика не отправлена' }
          }
          return (await runBody(l, text, flags, turnId, gone, emitL, statusL)).done
        })()
        return { turnId, done }
      }
      noteL('эта реплика ещё на прежних настройках: идут фоновые задачи, процесс Claude сменится после них')
    }
    return runBody(l, text, flags, turnId, gone, emitL, statusL)
  }

  const runBody = async (
    l: Live, text: string, flags: TurnFlags, turnId: string, gone: () => boolean,
    emitL: (draft: EventDraft) => void, statusL: (s: string, extra?: Record<string, unknown>) => void,
  ): Promise<TurnStarted> => {
    const name = l.spec.name
    const fail = (errorCode: string, message: string): TurnStarted =>
      ({ turnId, done: Promise.resolve({ turnId, ok: false, errorCode, message }) })
    dropDeadChild(l)

    // M8f: процесс жив со старыми флагами и фоновой работы у него нет — граница хода: он уходит (stdin закрыт,
    // CLI выходит сам), ниже поднимется новый с `--resume` и флагами снимка.
    if (l.child && l.childFlags && flagsKey(l.childFlags) !== flagsKey(flags) && !bgBusy(l)) {
      logger.info('настройки сменились — процесс перезапускается на границе хода', { session: name, pid: l.child.pid })
      if (l.reaper) { clearTimeout(l.reaper); l.reaper = null }
      releaseProcess(l)
    }

    // --- страж страны выхода (инвариант 2) ------------------------------------
    const idleMs = now() - l.lastTurnAt
    if (!l.started || idleMs > IDLE_RECHECK_MS || !l.child || netSeen.get(l) !== netGeneration()) {
      // Правило стража сменилось (`settings.set`) — проверка перед этим ходом, даже без простоя. Поколение
      // запоминается только у ПРОЙДЕННОЙ проверки: после отказа следующий ход проверяется снова.
      const gen = netGeneration()
      const check = await netProbe('claude')
      if (!check.ok) {
        emitL({
          sessionId: name, provider: 'claude', kind: 'net.blocked',
          data: { reason: check.reason, loc: check.loc, mode: check.mode, guard: check.guard, ...(check.guardMode ? { guardMode: check.guardMode } : {}), turnId },
        })
        statusL('failed', { reason: 'net_blocked' })
        return fail('blocked_network', netRefusal(check))
      }
      netSeen.set(l, gen)
      // Профиль сети перечитывается ровно здесь — он мог поменяться с прошлого хода.
      l.netEnv = networkEnv(check)
      dropDeadChild(l)
      // M8f (ревью, HIGH 2): страж выбрал другой путь, а живой процесс ходит прежним (его окружение задано при
      // спавне). Инвариант 2: ход в старый путь не уходит. Фоновой работы нет — процесс сменится; есть — отказ.
      if (l.child && l.childNetKey !== netKeyOf(l.netEnv)) {
        if (bgBusy(l)) {
          const msg = `сеть сменилась (${netLabel(l.childNetKey)} → ${netLabel(netKeyOf(l.netEnv))}), а процесс claude с фоновыми задачами `
            + 'ходит прежним путём — реплика не отправлена: дождись конца фоновых задач или останови сессию'
          logger.warn('страж сменил путь, а процесс с фоновыми задачами живёт на прежнем — ход отклонён', { session: name, turnId })
          statusL('failed', { turnId, reason: 'net_changed', message: msg })
          return fail('blocked_network', msg)
        }
        logger.info('страж сменил путь в сеть — процесс перезапускается на границе хода', { session: name, pid: l.child.pid })
        if (l.reaper) { clearTimeout(l.reaper); l.reaper = null }
        releaseProcess(l)
      }
    }

    // Пока шла проверка стража, мог прийти `agent stop`. Убивать было нечего — процесса ещё
    // нет, — поэтому ход отменяем здесь, а не рождаем ребёнка, которого уже никто не снимет.
    if (l.stopRequested) {
      l.stopRequested = false
      logger.info('ход отменён: стоп пришёл во время проверки стража', { session: name, turnId })
      return fail('interrupted', `ход ${turnId} отменён: агент остановлен до запуска процесса`)
    }

    // Файл --mcp-config пишется ДО того, как ход займёт сессию: отказ здесь не оставляет её «занятой».
    let mcpConfigPath: string | null = null
    let askKey: string | null = null
    let permissions: SessionMcpExtras['permissions']
    if (!l.child && l.spec.broker) {
      const nodeBin = childNode()
      if (!nodeBin) {
        statusL('failed', { reason: 'no_node' })
        return fail('internal', `нечем запустить заглушку разрешений: node ${nodeExec} удалён (brew upgrade?), `
          + `в ${paths.nodePath} тоже нет живого node — перезапусти демона`)
      }
      // О3: браузер и свои серверы владельца. Сборка может ждать установку Playwright MCP (первый ход
      // с браузером) — событийный цикл при этом свободен, а стоп в это время снимает ход ниже.
      let servers: Record<string, Record<string, unknown>> = {}
      if (opts.mcpExtras) {
        try {
          // M8f: режим и браузер — из снимка хода (`flags.browser === undefined` — снимка нет, решает запись).
          const extras = await opts.mcpExtras(name, nodeBin, flags.browser === undefined ? undefined
            : { ...(flags.approval ? { approval: flags.approval } : {}), browser: flags.browser })
          servers = extras.servers
          permissions = extras.permissions
        } catch (e) {
          logger.warn('MCP-серверы сессии не собрались — ход только с заглушкой разрешений', { session: name, error: (e as Error).message })
        }
        if (l.stopRequested || gone()) {
          l.stopRequested = false
          return fail('interrupted', `ход ${turnId} отменён: агент остановлен до запуска процесса`)
        }
      }
      const written = writeMcpConfig(l, nodeBin, servers)
      mcpConfigPath = written.file
      askKey = written.askKey
    }

    l.busy = true
    // Ход забирает поток у фонового слушателя: дальше события процесса — этого хода.
    l.idle?.detach()
    statusL('working', { turnId })

    const netEnv = l.netEnv
    let mapper = l.mapper
    if (!l.child) {
      // 0.3.7 (ревью #16): от выдачи ключа до спавна — синхронный код, который может бросить (spawn отказывает сразу на
      // аргументе с нулевым байтом). Бросок не должен оставить живой ключ, файл с ним и сессию «занятой».
      let child: ChildProcess
      try {
        const argv = buildClaudeArgv({
          sessionId: l.providerSessionId,
          resume: l.started,
          forkOnResume: l.spec.forkOnResume,
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.effort ? { effort: flags.effort } : {}),
          ...(l.spec.settingSources ? { settingSources: l.spec.settingSources } : {}),
          ...(flags.approval ? { approval: flags.approval } : {}),
          ...(mcpConfigPath ? { mcpConfigPath } : {}),
          ...(mcpConfigPath && permissions ? { permissions } : {}),
          protectDirs: protectDirs(),
          addDirs: addDirs(l.spec.name),
          addDirRoots: addDirRoots(),
        })
        mapper = createClaudeMapper({
          sessionId: name,
          images: createImageCapture({ home: opts.paths.home, sessionId: name, cwd: l.spec.cwd, codexHome: process.env['CODEX_HOME'] }),
          onUnknown: (t) => logger.warn('незнакомое событие claude — пропущено', { session: name, type: t }),
        })
        l.mapper = mapper
        // Счёт фоновых задач — счёт ПРОЦЕССА. У нового процесса их нет, пока он сам не скажет
        // (`background_tasks_changed`); прежний счёт держал бы его живым ради чужих задач.
        dropBackground(l, 'process_replaced')
        clearBgExpected(l)
        child = spawn(opts.bin, argv, {
          cwd: l.spec.cwd,
          env: buildChildEnv(process.env, { network: netEnv, extra: {} }),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (e) {
        if (askKey) { askKeys.revoke(askKey); if (l.askKey === askKey) l.askKey = null }
        if (mcpConfigPath) {
          try { unlinkSync(mcpConfigPath) } catch { /* уже нет */ }
          if (l.mcpConfigPath === mcpConfigPath) l.mcpConfigPath = null
        }
        l.mapper = null
        l.busy = false
        logger.error('claude не запустился: spawn бросил', { session: name, error: (e as Error).message })
        statusL('failed', { reason: 'spawn' })
        return fail('internal', `claude не запустился: ${(e as Error).message.slice(0, 300)}`)
      }
      l.child = child
      // M8f: с чем процесс запущен — по этому граница хода решает, менять ли его.
      l.childFlags = { ...flags }
      l.childNetKey = netKeyOf(netEnv)
      child.once('close', () => { closedChildren.add(child) })
      // О3: файл --mcp-config нужен claude только при запуске, а в нём env и заголовки своих серверов
      // владельца — с выходом процесса он уходит (тот же файл мог уже переписать следующий процесс — тогда нет).
      if (mcpConfigPath) {
        const file = mcpConfigPath
        child.once('exit', () => {
          if (l.child && l.child !== child) return
          try { unlinkSync(file) } catch { /* уже нет */ }
          if (l.mcpConfigPath === file) l.mcpConfigPath = null
        })
      }
      // 0.3.7: ключ вопросов живёт, пока жив ЭТОТ процесс (его заглушка). `close` — и на случай, когда процесс не
      // родился вовсе (ENOENT): тогда `exit` не приходит. Снимается именно его ключ, даже если следующий уже выдан.
      if (askKey) {
        const key = askKey
        const drop = (): void => {
          askKeys.revoke(key)
          if (l.askKey === key) l.askKey = null
        }
        child.once('exit', drop)
        child.once('close', drop)
      }
      child.stdin?.on('error', () => { /* труба закрылась под нами */ })
      // ПОСТОЯННЫЙ слушатель 'error'. Node бросает это событие НЕОБРАБОТАННЫМ, если на нём
      // нет ни одного слушателя, — ENOENT на бинаре или несуществующий cwd роняли бы ВЕСЬ
      // демон со всеми чужими сессиями, а не один ход. Ход хоронит `onError` ниже.
      child.on('error', (e: Error) => {
        logger.error('дочерний процесс claude не запустился', { session: name, bin: opts.bin, error: e.message })
      })
      logger.info('claude запущен', { session: name, mode: l.spec.mode, resume: l.started, pid: child.pid })
    }
    const child = l.child

    // Стоп мог прийти ровно между проверкой выше и спавном. Ребёнок уже есть — снимаем его
    // сами: `interrupt` его не видел и второй раз не придёт.
    if (l.stopRequested) {
      l.stopRequested = false
      l.busy = false
      l.mapper = null
      logger.info('только что запущенный процесс снят: пришёл стоп', { session: name, turnId, pid: child.pid })
      killChild(l, 'SIGTERM')
      return fail('interrupted', `ход ${turnId} отменён: агент остановлен на запуске процесса`)
    }
    const theMapper = mapper as ClaudeMapper

    const done = new Promise<TurnOutcome>((resolve) => {
      let settled = false
      let graceTimer: NodeJS.Timeout | null = null
      let sawResult: ResultSignal | null = null
      // Уведомления о фоновых задачах, пришедшие в этом ходе и ещё не «разгруженные» пустым result.
      let pendingNotices = 0
      // Метка реплики (`uuid` в строке stdin): по ней CLI говорит, какой `result` отвечает
      // именно на неё (`result.user_message_uuids`). См. case 'result'.
      const userUuid = randomUUID()
      // CLI признал реплику (`command_lifecycle` с нашей меткой) — значит, ответы он метит, и
      // `result` без нашей метки — чужой.
      let acked = false
      // Последний чужой `result`. Страховка: CLI закрыл реплику (`completed`), а помеченного
      // ответа не прислал — тогда ответом считается он, а не вечное ожидание.
      let lastForeign: ResultSignal | null = null
      // Процесс остаётся жить после ответа: фоновые задачи ещё идут (решается по `result`).
      let keepForBackground = false
      // В этом ходе пришёл сигнал о фоновых задачах (`background_tasks` или `task_notification`).
      let sawBgSignal = false
      // Строки куска stdout после `result`, на котором закрылся ход: их дочитает attachIdle.
      let restLines: string[] = []
      const textParts: string[] = []
      const splitter = createLineSplitter()
      let stderr = ''

      const clearGrace = (): void => { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null } }

      const finish = (outcome: TurnOutcome): void => {
        if (settled) return
        settled = true
        clearGrace()
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onErr)
        child.off('close', onClose)
        child.off('error', onError)
        if (l.turnAbort === abort) l.turnAbort = null
        l.busy = false
        // `l.started` здесь НЕ трогаем. Его поднимает только `system/init` (см. onSignal):
        // «ход закончился» и «разговор существует» — разные вещи, и первая не доказывает
        // вторую. Ход, убитый до init, не оставляет на диске ничего.
        l.lastTurnAt = now()
        // Жив ли процесс после хода: тёплый — всегда (после удачного хода), «на ход» — только ради
        // фоновых задач. Его дальше слушает attachIdle — ходы-итоги не теряются ни в одном режиме.
        const keep = outcome.ok && l.child === child && (l.spec.mode === 'warm' || keepForBackground)
        if (l.spec.mode === 'warm' && l.child && outcome.ok) armReaper(l)
        // Процесс ждёт задачи, о которых CLI ещё не сказал (`startedInBackground` в result без
        // `background_tasks_changed`) — граница хода считает его занятым (M8f, ревью LOW 13).
        // Только если сигнала о задачах в этом ходе не было вовсе: был — CLI уже сказал, что их (не) осталось.
        if (keep && keepForBackground && l.bgTasks === 0 && !sawBgSignal) armBgExpected(l)
        // M8f (ревью, HIGH 1): НЕ удачный ход закрывает процесс и в тёплом режиме. Раньше тёплый процесс после
        // ошибки оставался без слушателя и без жнеца: если он потом умирал, следующий ход писал в мёртвый stdin
        // и ждал вечно, а `agent stop` его уже не видел.
        if (!keep) {
          try { child.stdin?.end() } catch { /* закрыт */ }
          if (l.child === child) {
            l.child = null
            l.mapper = null
            dropBackground(l, 'process_exit')
            clearBgExpected(l)
          }
          // Добивающий SIGTERM. Таймер `unref`-нут, поэтому ребёнка держит не он, а список
          // `pendingKills`: его подметает `shutdown()`, если демон ушёл раньше таймера.
          pendingKills.add(child)
          child.once('exit', () => { pendingKills.delete(child) })
          // ВАЖНО: из `pendingKills` ребёнка вычёркивает только его собственный 'exit'.
          // Вычеркнуть его здесь — значит поверить, что SIGTERM подействовал, и потерять
          // из виду того, кто сигнал проглотил: подметать в `shutdown` было бы уже нечего.
          const backstop = setTimeout(() => {
            try { child.kill('SIGTERM') } catch { /* уже ушёл */ }
          }, 1500)
          backstop.unref?.()
        }
        // Ход, снятый стопом, статус НЕ пишет: его пишет менеджер в `stop()` — единственное
        // место, где статус сессии вычисляется. Напиши мы здесь `failed`, в журнале сначала
        // появилась бы ложь («ход провалился сам»), а следом настоящий `interrupted`.
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
        if (keep && !gone()) attachIdle(l, { splitter, lines: restLines })
      }

      /**
       * Разгрузка уведомлений (см. case 'result'): CLI отыграл застрявшие уведомления и обязан
       * следом начать ход на реплику (`system/init` через миллисекунды, измерено). Не начал за
       * отсрочку — ход проваливается с объяснением, а не висит и не притворяется «готов».
       */
      const armDrainGuard = (): void => {
        clearGrace()
        graceTimer = setTimeout(() => {
          killChild(l, 'SIGTERM')
          finish({
            turnId, ok: false, errorCode: 'internal',
            message: `claude отыграл уведомления фоновых задач прошлого процесса, но за ${config.subagentGraceMs} мс не начал ответ на реплику — повтори её`,
          })
        }, config.subagentGraceMs)
        graceTimer.unref?.()
      }

      /** `result`, который отвечает на НАШУ реплику: он и закрывает ход. */
      const acceptResult = (sig: ResultSignal): void => {
        sawResult = sig
        if (sig.text) textParts.push(sig.text)
        // САМОЛЕЧЕНИЕ. `--resume` на несуществующий разговор (ход до него убили раньше,
        // чем пришёл `init`) отвечает ровно этим. Повторять ход ТУТ ЖЕ нельзя: реплика
        // уже ушла в мёртвый процесс, а второй спавн внутри одного хода — это второй
        // счёт за токены и второй набор событий. Поэтому просто забываем, что разговор
        // был: СЛЕДУЮЩИЙ ход уйдёт с `--session-id` и заведёт его заново.
        if (!sig.ok && sig.text && NO_CONVERSATION_RE.test(sig.text)) {
          logger.warn('разговора нет — следующий ход начнёт его заново', {
            session: name, providerSessionId: l.providerSessionId, turnId,
          })
          l.started = false
        }
        // Ход человека закрывается по СВОЕМУ ответу. Фоновая работа идёт (или ход её запускал,
        // и итог вот-вот придёт ходом-итогом) — процесс живёт дальше под attachIdle.
        keepForBackground = sig.ok && (l.bgTasks > 0 || sig.startedInBackground > 0)
        finish({
          turnId,
          ok: sig.ok,
          ...(sig.ok ? {} : { errorCode: sig.terminalReason === 'api_error' ? 'provider_unavailable' : 'internal' }),
          ...(sig.text ? { text: textParts.join('\n') } : {}),
          ...(sig.ok ? {} : { message: sig.text ?? `ход завершился ошибкой (${sig.terminalReason ?? '?'})` }),
        })
      }

      const onSignal = (sig: TurnSignal): void => {
        switch (sig.kind) {
          case 'session_id':
            if (sig.id && sig.id !== l.providerSessionId) l.providerSessionId = sig.id
            l.spec.forkOnResume = false
            // Оба сигнала приходят из `system/init`, и он — ЕДИНСТВЕННОЕ доказательство
            // того, что разговор на диске заведён и его можно возобновлять.
            l.started = true
            return
          case 'turn_started':
            l.started = true
            // Пришёл новый `init` внутри отсрочки — значит фоновая работа ожила.
            clearGrace()
            return
          case 'provider_blocked': {
            providerBlocked = sig.text.slice(0, 400)
            emitL({
              sessionId: name, provider: 'claude', kind: 'provider.blocked',
              data: { provider: 'claude', text: providerBlocked, hint: 'проверь VPN; снять — pult doctor или provider.reset' },
            })
            logger.error('провайдер claude остановлен целиком', { session: name })
            killChild(l, 'SIGTERM')
            finish({ turnId, ok: false, errorCode: 'provider_unavailable', message: providerBlocked })
            return
          }
          case 'retry_storm': {
            emitL({
              sessionId: name, provider: 'claude', kind: 'net.blocked',
              data: { reason: 'api_retry_storm', retries: sig.retries, turnId },
            })
            logger.warn('шторм api_retry — ход прерван', { session: name, retries: sig.retries })
            killChild(l, 'SIGTERM')
            finish({
              turnId, ok: false, errorCode: 'blocked_network',
              message: `${sig.retries} подряд system/api_retry — ход прерван`,
            })
            return
          }
          case 'limit':
            statusL('limited', { rateLimitStatus: sig.status })
            return
          case 'task_notification':
            pendingNotices += 1
            sawBgSignal = true
            clearBgExpected(l)
            return
          case 'background_tasks':
            l.bgTasks = sig.count
            sawBgSignal = true
            clearBgExpected(l)
            return
          case 'command':
            if (sig.uuid !== userUuid) return
            acked = true
            if (sig.state === 'started') clearGrace()
            // Реплика закрыта, а помеченного ответа не было (CLI метит `command_lifecycle`, но
            // не `result`): ответ — последний чужой `result`, если в нём есть текст или ошибка.
            // Пустой успешный — это разгрузка уведомлений: принять его — снова молча потерять
            // реплику. Тогда, как и без чужого `result`, ход падает, а не висит.
            if (sig.state === 'completed') {
              if (lastForeign && (!lastForeign.ok || lastForeign.text)) { acceptResult(lastForeign); return }
              killChild(l, 'SIGTERM')
              finish({ turnId, ok: false, errorCode: 'internal', message: 'claude закрыл реплику, не прислав result — повтори её' })
            }
            return
          case 'result': {
            // ЧЕЙ ЭТО ОТВЕТ. ИЗМЕРЕНО 08.10.2026 (CLI 2.1.294, фикстура 13): прошлый процесс сняли
            // при живых фоновых субагентах; на `--resume` CLI ДО нашей реплики отыгрывает их
            // уведомления — `task_notification` ×2 → `command_lifecycle queued` (наша реплика
            // в очереди) → `init` → `result` с `num_turns: 0`, БЕЗ `user_message_uuids` — и лишь
            // потом `command_lifecycle started`, `init` и ответ с `user_message_uuids: [наша
            // метка]`. Закрыть ход на первом `result` — снять процесс до ответа: реплика молча
            // пропадала (журналы 07–08.10.2026, в том числе ДВА пустых result подряд).
            // Метка решает однозначно, в отличие от «num_turns 0»: локальная команда (`/cost`,
            // фикстура 14) — тоже `num_turns: 0`, но помечена нашей меткой и ход закрывает.
            const tagged = sig.userMessageUuids
            const mine = tagged !== null && tagged.includes(userUuid)
            if (!mine && (acked || tagged !== null)) {
              lastForeign = sig
              pendingNotices = 0
              logger.info('claude закрыл чужой ход до ответа на реплику — ждём ответ', {
                session: name, turnId, numTurns: sig.numTurns,
              })
              armDrainGuard()
              return
            }
            // Меток нет вовсе (CLI старше 2.1.294) — прежняя примета.
            // РАЗГРУЗКА УВЕДОМЛЕНИЙ — НЕ ОТВЕТ. ИЗМЕРЕНО 07.10.2026 (CLI 2.1.291, фикстура 11):
            // `task_notification` → `init` → `result` с `num_turns: 0` и пустым текстом, потом
            // второй `init` и ответ на реплику. Ошибочный result сюда не попадает.
            if (!mine && sig.ok && sig.numTurns === 0 && !sig.text && pendingNotices > 0) {
              pendingNotices = 0
              logger.info('claude разгрузил уведомления фоновых задач — ждём ответ на реплику', { session: name, turnId })
              armDrainGuard()
              return
            }
            acceptResult(sig)
            return
          }
          default:
            return
        }
      }

      const onData = (chunk: Buffer): void => {
        let lines: string[]
        try { lines = splitter.push(chunk) } catch { return }
        for (let i = 0; i < lines.length; i++) {
          let native: unknown
          try { native = JSON.parse(lines[i]!) } catch { continue }
          // Ход может закрыться на этой строке: всё, что за ней в куске, дочитает attachIdle.
          restLines = lines.slice(i + 1)
          const mapped = theMapper.push(native)
          for (const draft of mapped.drafts) emitL(draft)
          if (mapped.live && !gone()) for (const sig of mapped.live) opts.live?.(name, sig)
          for (const sig of mapped.signals) {
            if (settled) break
            onSignal(sig)
          }
          if (settled) return
        }
        restLines = []
      }
      const onErr = (chunk: Buffer): void => { stderr += chunk.toString('utf8') }
      /**
       * Спавн не удался: ENOENT на бинаре, EACCES, несуществующий cwd. Раньше этот случай
       * убивал процесс демона целиком (у 'error' не было ни одного слушателя), теперь он
       * хоронит РОВНО ЭТОТ ход.
       */
      const onError = (e: Error): void => {
        if (l.child === child) l.child = null
        l.mapper = null
        finish({ turnId, ok: false, errorCode: 'internal', message: `claude не запустился: ${e.message}` })
      }
      const onClose = (): void => {
        l.child = null
        if (sawResult) {
          finish({ turnId, ok: sawResult.ok, ...(textParts.length ? { text: textParts.join('\n') } : {}) })
          return
        }
        // Ребёнка снял `interrupt` — это не «вышел без result», а стоп. Признак надёжен:
        // `runTurn` обнуляет `stopRequested` в начале КАЖДОГО хода и в обоих местах, где
        // стоп гасит ход до спавна, так что живым он бывает ровно в своём ходе. Без этой
        // ветки остановленный ход уезжал в журнал как `failed errorCode=internal`.
        if (l.stopRequested) {
          finish({
            turnId, ok: false, errorCode: 'interrupted',
            message: `ход ${turnId} прерван: агент остановлен`,
          })
          return
        }
        finish({
          turnId, ok: false, errorCode: 'internal',
          message: `claude вышел без result${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
        })
      }

      child.stdout?.on('data', onData)
      child.stderr?.on('data', onErr)
      child.on('close', onClose)
      child.on('error', onError)
      // M8f (ревью, HIGH 1): `agent stop` обязан закрыть ход, даже если `close` процесса уже был и второго не будет.
      const abort = (message: string): void => finish({ turnId, ok: false, errorCode: 'interrupted', message })
      l.turnAbort = abort
      // Процесс закрылся раньше, чем ход подписался на `close`, — ждать нечего.
      if (closedChildren.has(child)) { onClose(); return }
      const stdin = child.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded) {
        killChild(l, 'SIGTERM')
        finish({ turnId, ok: false, errorCode: 'internal', message: 'процесс claude не принимает реплику (stdin закрыт) — повтори её' })
        return
      }
      // Промпт идёт в stdin, НИКОГДА в argv. И stdin НЕ закрывается здесь даже в режиме
      // «процесс на ход»: закрой мы его сейчас — второй ход после фонового субагента не
      // пришёл бы. Закрытие делает finish().
      try { stdin.write(userTurnLine(text, userUuid)) } catch { /* обработает close */ }
    })
    return { turnId, done }
  }

  return {
    provider: 'claude',

    async startSession(spec) {
      if (providerBlocked !== null) throw Object.assign(new Error(providerBlocked), { code: 'provider_unavailable' })
      if (live.has(spec.name)) throw Object.assign(new Error(`сессия ${spec.name} уже есть`), { code: 'invalid_params' })
      const providerSessionId = randomUUID()
      live.set(spec.name, {
        spec, providerSessionId, started: false, child: null, mapper: null,
        lastTurnAt: 0, mcpConfigPath: null, busy: false, reaper: null, closing: false,
        stopRequested: false, netEnv: {}, bgTasks: 0, idle: null, autoTurn: false, autoWaiters: [], childFlags: null, childNetKey: '{}', bgExpected: false, bgExpectedTimer: null, turnAbort: null,
      })
      return { name: spec.name, providerSessionId } satisfies StartedSession
    },

    send(name, text, at) { return runTurn(need(name), text, at) },

    async respondPermission(_name, _requestId, _decision: PermissionDecision) {
      // У Claude решение возвращается заглушкой `pult mcp-ask` через брокер демона, а не
      // через адаптер: инструмент разрешений живёт в MCP, а не в протоколе CLI.
      throw Object.assign(new Error('у claude разрешения решает брокер, не адаптер'), { code: 'invalid_params' })
    },

    async interrupt(name) {
      const l = live.get(name)
      if (!l) return
      // Флаг ставится ВСЕГДА, даже когда ребёнка ещё нет: ход может сидеть на `await` стража
      // сети и родить процесс через мгновение. Тогда его снимет сам `runTurn` по этому флагу.
      l.stopRequested = true
      const child = l.child
      if (child) {
        // Лестница сигналов с ПРОВЕРКОЙ: SIGINT → SIGTERM → SIGKILL. Без ожидания выхода
        // ребёнок, застрявший в неубиваемом сисколле, оставался жив, а Пульт рапортовал стоп.
        try { child.kill('SIGINT') } catch { /* уже мёртв */ }
        if (!await waitExit(child, INTERRUPT_GRACE_MS)) {
          try { child.stdin?.end() } catch { /* закрыт */ }
          try { child.kill('SIGTERM') } catch { /* уже мёртв */ }
          if (!await waitExit(child, INTERRUPT_KILL_MS)) {
            logger.warn('процесс не ушёл по SIGTERM — SIGKILL', { session: name, pid: child.pid })
            try { child.kill('SIGKILL') } catch { /* уже мёртв */ }
            await waitExit(child, INTERRUPT_KILL_MS)
          }
        }
        if (l.child === child) l.child = null
        pendingKills.delete(child)
      }
      // M8f (ревью, HIGH 1): ход, чей процесс уже закрылся (его `close` был раньше подписки), сам не кончится —
      // закрываем его здесь. Если `close` дошёл, ход уже закрыт и это ничего не делает.
      l.turnAbort?.(`ход прерван: агент остановлен`)
      // `status.changed interrupted` здесь НЕ пишется. Хозяин этого события — менеджер
      // (`sessions/manager.ts`, `stop()`): статус сессии вычисляется в одном месте. Пока
      // писали оба, каждый `agent stop` давал в журнале два `interrupted` подряд.
      // Адаптеру остаётся его часть контракта: снять процесс и дать незакрытому ходу
      // завершиться с `errorCode: 'interrupted'` — это делает `onClose`.
    },

    async resume(name, rec) {
      // Процесс не оживает — оживает РАЗГОВОР: `--resume <uuid>` поднимет его на первом же
      // ходе. Поэтому здесь только восстановление записи, без единого спавна.
      //
      // ИДЕМПОТЕНТНО (M8f): знакомую сессию не трогаем. Менеджер зовёт `resume` перед КАЖДЫМ ходом, и
      // перезапись выбрасывала живой процесс — тёплый (`--warm` через демон поднимал процесс на каждую
      // реплику, а прежний жил до жнеца) и процесс с фоновыми задачами (их итог терялся: события шли от
      // объекта, которого уже нет в `live`). Смену настроек живой сессии несёт `configure`.
      if (live.has(name)) return
      //
      // `started: Boolean(rec.providerSessionId)` верно РОВНО ПОТОМУ, что реестр хранит
      // providerSessionId только подтверждённый — менеджер пишет его по `session.started`,
      // то есть по `system/init`, а не по тому uuid, что выдуман на `agent start`. Пока
      // писался выдуманный, рестарт демона воспроизводил кирпич: `--resume` на разговор,
      // которого никогда не было.
      live.set(name, {
        spec: {
          name,
          cwd: rec.cwd,
          ...(rec.model ? { model: rec.model } : {}),
          ...(rec.effort ? { effort: rec.effort } : {}),
          mode: rec.mode,
          // `settingSources` восстанавливается наравне с моделью: это граница доступа CLI
          // к наборам настроек, и потерять её при рестарте — значит молча её расширить.
          ...(rec.settingSources ? { settingSources: rec.settingSources } : {}),
          broker: true,
          // M8d: режим подтверждений — тоже граница доступа: после рестарта демона он тот же, что на старте.
          ...(rec.approval ? { approval: rec.approval } : {}),
          ...(rec.forkOnResume ? { forkOnResume: true } : {}),
        },
        providerSessionId: rec.providerSessionId ?? randomUUID(),
        started: Boolean(rec.providerSessionId),
        child: null, mapper: null, lastTurnAt: 0, mcpConfigPath: null,
        busy: false, reaper: null, closing: false, stopRequested: false, netEnv: {},
        bgTasks: 0, idle: null, autoTurn: false, autoWaiters: [], childFlags: null, childNetKey: '{}', bgExpected: false, bgExpectedTimer: null, turnAbort: null,
      })
    },

    configure(name, next) {
      const l = live.get(name)
      if (!l) return 'next_turn'
      // Флаги процесса читаются только при спавне (`buildClaudeArgv`): идущий ход их не видит, следующий спавн — да.
      const spec = l.spec as unknown as Record<string, unknown>
      for (const k of ['model', 'effort', 'approval'] as const) {
        if (next[k] === undefined) delete spec[k]
        else spec[k] = next[k]
      }
      // Живой процесс со старыми флагами сменится на границе хода (по снимку следующего хода — см. `runTurn`).
      return l.child && bgBusy(l) ? 'after_background' : 'next_turn'
    },

    async close(name) {
      const l = live.get(name)
      // 0.3.7: имя переиспользуемо (`agent rm` и новая сессия с тем же именем) — ключи прежней не должны к ней подойти.
      if (!l) { askKeys.revokeSession(name); return }
      // Фон сессии снимается вместе с ней — событием, пока сессия ещё своя (`dropBackground` молчит о закрытых).
      dropBackground(l, 'session_closed')
      l.closing = true
      if (l.reaper) { clearTimeout(l.reaper); l.reaper = null }
      const child = l.child
      killChild(l, 'SIGTERM')
      // Дождаться выхода (с потолком): `agent rm` дальше убирает профиль браузера, а Chrome гасит Playwright
      // MCP, когда claude закрывает ему stdin, — то есть после выхода claude.
      if (child) await waitExit(child, INTERRUPT_KILL_MS)
      if (l.mcpConfigPath) { try { unlinkSync(l.mcpConfigPath) } catch { /* уже нет */ } }
      revokeAskKey(l)
      askKeys.revokeSession(name)
      live.delete(name)
      status(name, 'done', {})
    },

    blocked: () => (providerBlocked === null ? { blocked: false } : { blocked: true, reason: providerBlocked }),

    reset() {
      if (providerBlocked === null) return
      logger.info('остановка провайдера claude снята', {})
      providerBlocked = null
    },

    async shutdown() {
      for (const l of [...live.values()]) {
        l.closing = true
        if (l.reaper) { clearTimeout(l.reaper); l.reaper = null }
        killChild(l, 'SIGTERM')
        if (l.mcpConfigPath) { try { unlinkSync(l.mcpConfigPath) } catch { /* уже нет */ } }
        revokeAskKey(l)
        askKeys.revokeSession(l.spec.name)
      }
      live.clear()
      // Дети, у которых ход уже закончился, а добивающий таймер ещё не сработал: в `live`
      // их нет, и без этого прохода быстрый `daemon.stop` оставлял бы их сиротами.
      // Здесь сразу SIGKILL, а не SIGTERM: ход закончен, сбрасывать нечего, ждать второй
      // ступени некогда — демон уходит, и второго шанса снять этого ребёнка не будет.
      for (const child of [...pendingKills]) {
        try { child.stdin?.end() } catch { /* закрыт */ }
        try { child.kill('SIGKILL') } catch { /* уже ушёл */ }
      }
      pendingKills.clear()
    },
  }
}
