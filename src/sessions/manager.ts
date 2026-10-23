// Менеджер сессий: всё, что демон умеет делать с агентами.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЛОЙ между сокетом и адаптером. Сервер демона знает про кадры и токены,
// адаптер — про дочерний процесс и поток событий. Между ними остаётся третье: реестр на диске,
// статус сессии, кто сейчас делает ход, что ответить на `agent.wait`. Если размазать это по
// обоим соседям, «статус» посчитается двумя разными способами и разойдётся.
//
// ОДНА ТОЧКА ЗАПИСИ. Каждое событие адаптера и брокера проходит через `emit` менеджера: он
// кладёт его в журнал И тут же прогоняет через ЧИСТУЮ свёртку `reduceStatusEvent`. Поэтому
// статус в `agent list`, в `agent wait` и на будущей доске Ф2 не может разойтись — он один.
//
// ХОД ИДЁТ В ФОНЕ. `agent.prompt` возвращает id хода СРАЗУ: клиент, который не просил `--wait`,
// не должен держать сокет открытым, пока модель думает. Ожидание — отдельный метод
// `agent.wait`, и его можно позвать хоть из другого процесса.

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { PultConfig } from '../core/config.js'
import type { EventDraft, PultEvent } from '../core/events.js'
import type { Logger } from '../core/log.js'
import { redactString } from '../core/log.js'
import type { PultPaths } from '../core/paths.js'
import type { EventStore } from '../core/store.js'
import type { ApprovalMode, ProviderAdapter, SessionSettingsPatch, TurnOutcome, TurnSettings } from '../adapters/types.js'
import type { PermBroker } from '../perm/broker.js'
import { mergeContext, parseContextData } from './context.js'
import type { SessionContext } from './context.js'
import { createRegistry, isSessionName, normalizeTitle, QUEUE_MAX, SESSION_TITLE_MAX, titleLength } from './registry.js'
import type { QueueItem, SessionBrowser, SessionMode, SessionRecord, SessionRegistry, SessionStatus, SessionWorktree } from './registry.js'
import { approvalBrowserRefusal, removeBrowserProfile, resetBrowserDirs } from '../mcp/browser.js'
import { createPhaseTracker } from './phaseTracker.js'
import type { LiveSignal } from './phaseTracker.js'
import type { TurnPhase } from './turnPhase.js'
import { claudeChoices, ConfigureError, hasChanges, modelWindows, planConfigure } from './settings.js'
import type { ConfigureChanges, ConfigureRequest, ConfigureWhen, ModelChoice } from './settings.js'
import { HUMAN_STATUSES, reduceStatusEvent, TERMINAL_STATUSES } from './status.js'
import { attentionOf, retryPrompt } from './attention.js'
import type { Attention } from './attention.js'
import { buildTree } from './tree.js'
import type { AgentTree } from './tree.js'
import { prepareWorktree, removeWorktree, WorktreeError } from './worktree.js'
import type { PreparedWorktree } from './worktree.js'
import type { ExternalMessage } from './external.js'

export class ManagerError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ManagerError'
  }
}

export interface StartParams {
  name: string
  /** Название для людей; его же потом меняет `rename`. */
  title?: string
  kind: 'claude' | 'codex'
  cwd: string
  model?: string
  effort?: string
  mode?: SessionMode
  settingSources?: string
  /** `--worktree <ветка>`: завести агента в отдельном git worktree (docs/08 §6). */
  worktree?: string
  /** `--base <ref>`: от чего завести НОВУЮ ветку worktree. */
  base?: string
  /** О3: браузер для агента с первого хода (`headed` — окно видно). */
  browser?: SessionBrowser
  /** M8d: как подтверждать действия; нет — `ask`. Живёт в записи и переживает resume. */
  approval?: ApprovalMode
}

/** Ответ `agent.start`: запись реестра и — для `--worktree` — что сделано с папкой. */
export type StartedRecord = SessionRecord & {
  worktreeAction?: PreparedWorktree['action']
  baseIgnored?: boolean
}

export interface RmOptions {
  /** `agent rm --worktree`: вдобавок `git worktree remove` без `--force`. */
  worktree?: boolean
}

export interface RmResult {
  /** Worktree агента, если был: CLI печатает путь — папка остаётся, пока не просили убрать. */
  worktree?: SessionWorktree
  worktreeRemoved: boolean
}

export interface WaitParams {
  name: string
  /** Чего ждём: idle · blocked · done. Пусто = idle,blocked,done. */
  until?: readonly string[]
  timeoutMs?: number
}

export interface WaitResult {
  name: string
  status: SessionStatus
  reason: 'matched' | 'timeout'
  turnId?: string
  ok?: boolean
  errorCode?: string
  text?: string
  /**
   * Текст ОШИБКИ хода — то, что сказал провайдер, когда ход не удался.
   *
   * Отдельно от `text` (ответ модели) и появился по ревью В3: `pult agent prompt --wait`
   * печатал `ход не удался: limited — ` с пустым хвостом, потому что у проваленного хода
   * `text` пуст, а `message` наружу не выходил вовсе. Инвариант «текст ошибки не теряется»
   * (контракт 6) обрывался ровно на последнем шаге — у человека перед глазами.
   */
  message?: string
}

/** M8f: `agent.configure` — что сменить у живой сессии. */
export interface ConfigureParams extends ConfigureRequest {
  name: string
}

/** Ответ `agent.configure`: запись после смены, что поменялось и когда вступит. */
export interface ConfigureResult {
  record: SessionRecord
  changes: ConfigureChanges
  when: ConfigureWhen
}

/** Ответ `agent.prompt`: ход начат или реплика встала в очередь (`queue: true` при занятой сессии). */
export type SayResult = { turnId: string } | { queued: true; id: string }

export interface SayOptions {
  /** Сессия занята ходом — реплика встаёт в очередь и уйдёт сама, когда ход кончится `idle`. */
  queue?: boolean
  /** «Прервать и сказать»: стоп текущего хода, ждём, пока он осядет, затем реплика. */
  interrupt?: boolean
}

/** Очередь сессии наружу: превью реплик и пауза. */
export interface QueueState {
  name: string
  queue: QueueItem[]
  queuePaused: boolean
}

/** Превью реплики очереди в ответах демона: строка NDJSON больше 1 МиБ рвёт соединение окна. */
export const QUEUE_PREVIEW_CHARS = 200
/** Предел одной реплики в очереди (знаки): очередь живёт в sessions.json, а он пишется целиком на каждую правку. */
export const QUEUE_TEXT_MAX = 50_000
/** Предел всей очереди одной сессии в байтах (сумма реплик). */
export const QUEUE_TOTAL_BYTES = 256 * 1024
/**
 * Правка реплики в очереди держит очередь на этой реплике (и за ней) не дольше этого: окно закрыли без
 * отключения или человек ушёл — реплика уйдёт с прежним текстом, окно скажет, что время правки вышло.
 */
export const QUEUE_EDIT_HOLD_MS = 10 * 60_000
/** Сколько последних ушедших реплик сессии помнится — чтобы отказ правки различал «ушла» и «удалена». */
const QUEUE_SENT_MEMORY = 50

/** Ответ на взятие реплики в правку: очередь, полный текст реплики (в очереди — превью) и срок удержания. */
export interface QueueEditHold extends QueueState {
  edit: { id: string; text: string; holdMs: number }
}

/** Сколько «прервать и сказать» ждёт, пока прерванный ход осядет. */
export const INTERRUPT_SETTLE_MS = 10_000

/** Очередь в ответе: реплики урезаны до превью. */
export function publicQueue(q: readonly QueueItem[] | undefined): QueueItem[] {
  return (q ?? []).map((it) => {
    const chars = [...it.text]
    return chars.length > QUEUE_PREVIEW_CHARS ? { ...it, text: `${chars.slice(0, QUEUE_PREVIEW_CHARS - 1).join('')}…` } : it
  })
}

/** Запись реестра наружу: очередь — превью (rename, archive, seen и прочие отдают запись целиком). */
export function publicRecord<T extends SessionRecord>(rec: T): T {
  return rec.queue ? { ...rec, queue: publicQueue(rec.queue) } : rec
}

export interface UsageRow {
  session: string
  provider: string
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  turns: number
  rateLimit: unknown
}

export interface SessionManager {
  start(params: StartParams): Promise<StartedRecord>
  importSession(params: StartParams, providerSessionId: string, messages: ExternalMessage[], forkOnResume?: boolean): Promise<SessionRecord>
  /** Заведена ли такая сессия. Нужна `perm.request`: чужой sessionId туда не пройдёт. */
  has(name: string): boolean
  /** Сменить название агента; пустое — снять (в списках снова `name`). Ключ `name` не меняется. */
  rename(name: string, title: string): SessionRecord
  /** В архив и обратно: только пометка, процессы и журнал не трогаются. */
  archive(name: string, archived: boolean): SessionRecord
  /**
   * О3: браузер для агента вкл/выкл (`null` — выкл). Свойство записи, как название: событий не пишет, идущий
   * ход не трогает — новый MCP-конфиг соберётся на следующем запуске процесса, то есть со следующего хода
   * (с M8f тёплый процесс Claude сменяется на границе следующего хода: браузер — часть снимка хода; при фоновой
   * работе выключение браузера ждёт её конца, как режим строже).
   */
  setBrowser(name: string, browser: SessionBrowser | null): SessionRecord
  /**
   * M8f: сменить модель, усилие или режим подтверждений живой сессии — со следующего хода (идущий ход не
   * трогается, вопросы в Inbox тоже). Проверка — по живому списку провайдера (`modelChoices`); `full` и модель
   * с окном меньше занятого контекста — только с `confirm`. Запись в реестре переживает рестарт демона.
   * Режим, в котором браузер не включается, выключает его (и возвращает, когда режим снова позволяет).
   */
  configure(params: ConfigureParams): Promise<ConfigureResult>
  prompt(name: string, text: string): Promise<{ turnId: string }>
  /**
   * `agent.prompt` с флагами О2: `queue` — в очередь, если сессия занята; `interrupt` — прервать и сказать.
   * Без флагов — то же, что `prompt`.
   */
  say(name: string, text: string, opts?: SayOptions): Promise<SayResult>
  /**
   * M8c: сессии, у которых ход заводится (resume/send) или идёт по адаптеру, — даже если статус ещё не
   * `working`. Обновление ждёт и их: иначе ход, отправленный в эти секунды, умер бы на рестарте.
   */
  startingTurns(): string[]
  /**
   * M8c: обновление кончилось, не перезапустив демона (провал `pult update`) — пустить очереди, которые стояли
   * только из-за него: их `drain` тихо вышел по `holdTurns`, а конец хода, который бы их разбудил, уже прошёл.
   */
  resumeQueues(): void
  /** Очередь стоит после неудачного хода — пустить дальше (следующая реплика уходит сразу, если сессия свободна). */
  queueResume(name: string): QueueState
  queueRemove(name: string, id: string): QueueState
  /** Переставить реплику на место `to` (индекс; за краями — к краю). */
  queueMove(name: string, id: string, to: number): QueueState
  /**
   * Взять реплику в правку: пока правка открыта, очередь на этой реплике стоит (она и те, что за ней, не уходят;
   * идущий ход и другие сессии не трогаются). Снимается `queueEdit`, `queueRelease`, отключением `owner`
   * (`queueReleaseOwner`) или по сроку `QUEUE_EDIT_HOLD_MS`. Реплики нет — отказ `queue_item_sent` / `queue_item_removed`.
   */
  queueHold(name: string, id: string, owner?: number): QueueEditHold
  /** Бросить правку: очередь идёт дальше. Реплики или правки уже нет — ничего не делается. */
  queueRelease(name: string, id: string): QueueState
  /**
   * Сохранить правку: новый текст на том же месте и с тем же id, удержание снято, событие `queue.updated {id}`
   * (без текста). Реплики уже нет — отказ `queue_item_sent` (ушла) или `queue_item_removed` (убрана, сессии нет).
   */
  queueEdit(name: string, id: string, text: string): QueueState
  /** Клиент отключился — снять все его правки. */
  queueReleaseOwner(owner: number): void
  /**
   * О2: человек видел сессию — отметка «видел» встаёт на последний номер журнала; `unread` — наоборот,
   * пометить непрочитанной (⌥⌘U). Событий не пишет: это свойство записи, как название.
   */
  seen(name: string, unread: boolean, upTo?: number): SessionRecord
  /**
   * О2, «Повторить» в карточке ошибки: реплика УПАВШЕГО хода уходит заново тем же путём, что `prompt`
   * (`retryPrompt` в attention.ts). Ошибка вне хода, занятая сессия, новая реплика после ошибки — отказ.
   */
  retry(name: string): Promise<{ turnId: string }>
  wait(params: WaitParams): Promise<WaitResult>
  read(name: string, since: number, format: 'text' | 'json'): { cursor: number; text?: string; events?: PultEvent[]; worktree?: SessionWorktree }
  /**
   * Строки реестра с живым статусом, числом запросов в Inbox, последним известным контекстом и фазой хода (0.3.5,
   * без текста размышлений).
   */
  list(): Array<SessionRecord & { pendingPermissions: number; phase?: TurnPhase }>
  /**
   * Фаза хода сессии (0.3.5, src/sessions/phaseTracker.ts) — с текстом размышлений: её отдаёт живой канал окна.
   * `null` — хода нет.
   */
  phase(name: string): TurnPhase | null
  /** Сессии, у которых сейчас есть фаза. */
  phaseNames(): string[]
  /** Живой сигнал адаптера (провайдер отозвался, размышления): в журнал не пишется. */
  live(name: string, sig: LiveSignal): void
  /** Стоп хода. `turnId` — только если идёт именно этот ход (иначе `false`, ничего не делается). */
  stop(name: string, turnId?: string): Promise<boolean>
  rm(name: string, opts?: RmOptions): Promise<RmResult>
  tree(name: string): AgentTree
  usage(): UsageRow[]
  providerReset(kind: 'claude' | 'codex'): { was: boolean }
  /** Единственная дверь в журнал для адаптеров и брокера. */
  emit(draft: EventDraft): PultEvent
  shutdown(): Promise<void>
}

export interface ManagerOptions {
  paths: PultPaths
  config: PultConfig
  logger: Logger
  store: EventStore
  /** Запись в журнал и рассылка подписчикам — её делает демон. */
  publish(draft: EventDraft): PultEvent
  adapters: Partial<Record<'claude' | 'codex', ProviderAdapter>>
  broker: PermBroker
  /**
   * Реестр. В бою он всегда один — `createRegistry(paths)`; подмена нужна тесту, который
   * СЧИТАЕТ записи на диск: без счётчика усиление записи (fsync на каждую дельту) невидимо.
   */
  registry?: SessionRegistry
  /**
   * Автоназвание по первой реплике (sessions/autotitle.ts). Нет — сессии без названия так и
   * остаются под своим именем.
   */
  titler?: (text: string) => Promise<string | null>
  /**
   * Родительское окружение для git (`--worktree`): из него белый список берёт HOME и PATH.
   * В бою — окружение демона; тест подставляет временный HOME, чтобы глобальный ~/.gitconfig
   * машины (хуки, шаблоны) не участвовал в прогоне.
   */
  env?: NodeJS.ProcessEnv
  /**
   * О2: записано событие внимания (src/sessions/attention.ts) у заведённой сессии; `title` — её подпись
   * (название или имя). Демон вешает сюда `notifyCommand`. Вызывается синхронно из `emit` — обработчик не
   * имеет права ждать.
   */
  onAttention?(ev: PultEvent, att: Attention, title: string): void
  /**
   * M8c: идёт `pult update` — через секунды-минуты он перезапустит демона, и любой ход, начатый сейчас,
   * оборвётся. Пока это так, новый ход не заводится (`updating`), а очередь реплик стоит и уходит после рестарта.
   */
  holdTurns?(): boolean
  /**
   * M8f: модели провайдера с усилиями — для проверки `configure`. Нет функции или `null` — списка нет (Codex
   * офлайн): тогда только форма имени. У Claude по умолчанию — пресеты формы «+ Сессия».
   */
  modelChoices?(provider: 'claude' | 'codex'): Promise<ModelChoice[] | null>
  /** Срок удержания очереди открытой правкой (мс); по умолчанию `QUEUE_EDIT_HOLD_MS`. Тесты ставят короче. */
  queueEditHoldMs?: number
  /** 0.3.5: фаза хода сессии сменилась — демон шлёт кадр живого канала (src/daemon/live.ts). Синхронно. */
  onPhase?(name: string): void
}

/** Отказ хода, пока ставится обновление: окно оставляет текст в поле ввода. */
export const UPDATING_MESSAGE = 'Пульт обновляется — отправь после перезапуска'

/** Статусы, которыми ход кончается: на них считается его длительность (`turnMs`). */
const TURN_END: ReadonlySet<string> = new Set(['idle', 'failed', 'interrupted', 'done', 'cold'])

interface Inflight {
  turnId: string
  promise: Promise<TurnOutcome>
  outcome: TurnOutcome | null
}

export function createManager(opts: ManagerOptions): SessionManager {
  const registry: SessionRegistry = opts.registry ?? createRegistry(opts.paths)
  const statuses = new Map<string, SessionStatus>()
  const inflight = new Map<string, Inflight>()
  const usageBySession = new Map<string, UsageRow>()
  // Последнее известное контекстное окно сессии (`context.updated`) и сессии, чьё значение ещё
  // не записано в реестр. Запись — попутно со сменой статуса (см. `emit`), не отдельным fsync.
  const contexts = new Map<string, SessionContext>()
  const contextDirty = new Set<string>()
  // Очередь операций с worktree. `agent.start` асинхронный: два старта одной ветки подряд
  // иначе оба видели бы «папки ещё нет» и оба звали бы `worktree add`, а проверка «папка уже
  // занята агентом» смотрела бы на реестр, куда первый ещё не записался.
  let worktreeQueue: Promise<unknown> = Promise.resolve()
  const serialWorktree = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = worktreeQueue.then(fn, fn)
    worktreeQueue = run.catch(() => undefined)
    return run
  }
  // Имена агентов, которые заводятся прямо сейчас, и worktree, уже выданные им, но ещё не
  // записанные в реестр. Без второго два старта одной ветки подряд ОБА «переиспользовали» бы
  // одну папку: проверка занятости смотрит в реестр, а первый туда ещё не записан.
  const starting = new Set<string>()
  const pendingWorktrees = new Map<string, string>()
  // Бронь между `rm --worktree` и `prompt`. Проверка «агент не делает ход» в rm проходила ДО
  // `await git worktree remove`, а prompt в эти секунды спокойно заводил новый ход в папке,
  // которую git удалял (измерено: ход t2 стартовал за 1,4 с до конца git). И наоборот: prompt
  // виден в `inflight` только после resume+send, и rm, пришедший раньше, удалял папку из-под
  // заводящегося хода. `removing` — агенты под `rm --worktree`, `prompting` — счётчик prompt,
  // ещё не записавших ход в `inflight`. Обе брони ставятся синхронно, до первого await.
  const removing = new Set<string>()
  const prompting = new Map<string, number>()
  const releasePrompting = (name: string): void => {
    const n = (prompting.get(name) ?? 1) - 1
    if (n > 0) prompting.set(name, n)
    else prompting.delete(name)
  }
  const asManagerError = (e: unknown): unknown =>
    e instanceof WorktreeError ? new ManagerError(e.code, e.message) : e

  // Рестарт демона: ни один процесс провайдера не жив, поэтому всё незавершённое — `cold`.
  // Ни одного перезапуска отсюда не делается (шторм на старте — худшее, что может случиться).
  // 0.3.5: фаза хода — из событий, которые идут через `emit`, начала хода в `prompt` и живых сигналов адаптеров.
  const phases = createPhaseTracker({ ...(opts.onPhase ? { onChange: opts.onPhase } : {}) })

  const cooled = registry.coolDown()
  if (cooled) opts.logger.info('сессии остужены после рестарта', { count: cooled })
  // О2: записи до 0.2.21 отметки «видел» не знают — всё прошлое считается прочитанным (см. seedSeen).
  const seeded = registry.seedSeen(opts.store.lastId)
  if (seeded) opts.logger.info('отметка «видел» проставлена старым сессиям', { count: seeded, lastId: opts.store.lastId })
  for (const rec of registry.list()) {
    statuses.set(rec.name, rec.lastStatus)
    if (rec.context) contexts.set(rec.name, rec.context)
    // Очередь пережила рестарт, ход — нет: он умер вместе с прошлым демоном. Сама очередь не тронется —
    // её пускает человек («Продолжить»), иначе реплика, державшаяся на результате оборванного хода, ушла бы вслепую.
    if (rec.queue?.length && !rec.queuePaused) {
      registry.update(rec.name, { queuePaused: true })
      opts.logger.info('очередь реплик стоит после рестарта демона', { session: rec.name, count: rec.queue.length })
    }
  }

  // --- О2: длительность хода и сторож тишины -----------------------------------------------
  // Начало хода — первый `status.changed working` (у Codex он приходит дважды) — по часам демона. Конец
  // хода получает `turnMs` прямо в событие: по нему правило «короткий ход не уведомляет» одинаково у окна
  // и у `notifyCommand`. Последнее событие сессии (любое, и дельты) — для сторожа тишины.
  const turnStartedAt = new Map<string, number>()
  const lastEventAt = new Map<string, number>()
  // Ход, о молчании которого уже сказали (ключ — его начало): «завис» — один раз на ход.
  const stalledFor = new Map<string, number>()
  const withTurnTiming = (draft: EventDraft): EventDraft => {
    if (draft.kind !== 'status.changed' || !statuses.has(draft.sessionId)) return draft
    const d = draft.data ?? {}
    const st = d['status']
    const name = draft.sessionId
    if (st === 'working') {
      if (!turnStartedAt.has(name)) turnStartedAt.set(name, Date.now())
      return draft
    }
    // `limited` без хода — предупреждение или эхо `limit.hit` посреди хода: ход ещё не кончился.
    const end = typeof st === 'string' && (TURN_END.has(st) || (st === 'limited' && typeof d['turnId'] === 'string'))
    if (!end || d['rateLimitStatus'] === 'allowed_warning') return draft
    const t0 = turnStartedAt.get(name)
    turnStartedAt.delete(name)
    stalledFor.delete(name)
    return t0 === undefined ? draft : { ...draft, data: { ...d, turnMs: Date.now() - t0 } }
  }

  const adapterFor = (kind: 'claude' | 'codex'): ProviderAdapter => {
    const a = opts.adapters[kind]
    if (!a) throw new ManagerError('provider_unavailable', `адаптер ${kind} появится в следующей вехе`)
    return a
  }

  const needRec = (name: string): SessionRecord => {
    const rec = registry.get(name)
    if (!rec) throw new ManagerError('not_found', `сессии ${name} нет`)
    return rec
  }

  /** Название с входа: чистое или `null` (нет); длинное — отказ, а не тихая обрезка. */
  const cleanTitle = (raw: unknown): string | null => {
    if (raw !== undefined && typeof raw !== 'string') throw new ManagerError('invalid_params', 'название должно быть строкой')
    const title = normalizeTitle(raw)
    if (title !== null && titleLength(title) > SESSION_TITLE_MAX) {
      throw new ManagerError('invalid_params', `название длиннее ${SESSION_TITLE_MAX} знаков`)
    }
    return title
  }

  /**
   * ЗАПИСЬ В РЕЕСТР — ТОЛЬКО НА СМЕНЕ СТАТУСА. `registry.update` — это запись во временный
   * файл, `fsyncSync` и `rename` на КАЖДЫЙ вызов. Раньше он звался на каждое событие сессии,
   * а `--include-partial-messages` делает из одной реплики сотни `message.delta`: одна
   * словоохотливая реплика превращалась в сотни fsync-ов sessions.json.
   * Цена решения: `lastEventId` в реестре — не «последнее событие», а «событие последней
   * смены статуса». На диске он больше ни на что не влияет (его читает только человек), а
   * подписки и `agent read` живут на сквозном курсоре журнала, не на нём.
   */
  const emit = (draft: EventDraft): PultEvent => {
    const ev = opts.publish(withTurnTiming(draft.kind === 'context.updated' ? withKnownContext(draft) : draft))
    if (ev.kind === 'context.updated') trackContext(ev)
    const prev = statuses.get(ev.sessionId)
    if (prev !== undefined) {
      lastEventAt.set(ev.sessionId, Date.now())
      const next = reduceStatusEvent(prev, ev)
      if (next !== prev) {
        statuses.set(ev.sessionId, next)
        registry.update(ev.sessionId, { lastStatus: next, lastEventId: ev.id, ...unsavedContext(ev.sessionId) })
      }
      if (ev.kind === 'status.changed') {
        const st = ev.data['status']
        // Ход кончился `idle` — очередь реплик идёт дальше. Только настоящий конец хода: свой (`turnId`) или
        // фоновый (`background_turn_done`); служебные `idle` (конец фонового процесса, потолок фона, остывание)
        // очередь не будят. Не здесь же, а следующим тиком: мы внутри записи события, адаптер ещё не закрыл ход.
        if (st === 'idle' && (typeof ev.data['turnId'] === 'string' || ev.data['reason'] === 'background_turn_done')) {
          const rec = registry.get(ev.sessionId)
          if (rec?.queue?.length && !rec.queuePaused) scheduleDrain(ev.sessionId)
        }
        // Ход упал, прерван или упёрся в лимит — откуда бы ни пришло (фоновый ход, отказ на `send`, сервер
        // Codex сам прервал ход): очередь встаёт до «Продолжить».
        if (st === 'failed' || st === 'interrupted' || (st === 'limited' && typeof ev.data['turnId'] === 'string')) {
          pauseQueue(ev.sessionId, String(st))
        }
      }
      if (opts.onAttention) {
        const att = attentionOf(ev)
        if (att) {
          const rec = registry.get(ev.sessionId)
          if (rec) {
            try { opts.onAttention(ev, att, rec.title ?? rec.name) } catch (e) {
              opts.logger.warn('обработчик внимания упал', { session: ev.sessionId, error: (e as Error).message })
            }
          }
        }
      }
    }
    // Единственное место, где в реестр попадает providerSessionId. `session.started` — это
    // `system/init` от самого CLI, то есть доказательство, что разговор на диске есть и его
    // можно возобновлять после рестарта демона. Запись редкая (раз на сессию), на бюджет
    // fsync-ов не влияет.
    if (ev.kind === 'session.started') {
      const id = (ev.data as { providerSessionId?: unknown }).providerSessionId
      const rec = registry.get(ev.sessionId)
      if (typeof id === 'string' && id && rec && (rec.providerSessionId !== id || rec.forkOnResume)) {
        registry.update(ev.sessionId, { providerSessionId: id, forkOnResume: undefined })
      }
    }
    if (ev.kind === 'usage.updated') trackUsage(ev)
    if (statuses.has(ev.sessionId) || ev.kind === 'session.ended') phases.event(ev)
    return ev
  }

  /**
   * Окно и модель, которых переводчик не знает, — из прошлого значения сессии. У Claude размер
   * окна приходит только в `result` КОНЦА хода, а в режиме `turn` каждый ход — новый процесс со
   * свежим переводчиком: без подстановки каждая первая реплика хода писала бы `window: null`, и
   * доля в окне мигала бы до конца хода. Подставляем ДО записи — журнал (а по нему и окно
   * Пульта) видит уже полное значение. Модель сменилась — прошлое окно не подставляется.
   */
  function withKnownContext(draft: EventDraft): EventDraft {
    const d = parseContextData(draft.data)
    const prev = contexts.get(draft.sessionId)
    if (!d || !prev) return draft
    const merged = mergeContext(prev, d, '')
    if (merged.window === d.window && merged.model === d.model) return draft
    return { ...draft, data: { ...draft.data, window: merged.window, model: merged.model } }
  }

  function trackContext(ev: PultEvent): void {
    const d = parseContextData(ev.data)
    // Только заведённые сессии: чужой sessionId (тестовый `events.emit`) памяти не заводит.
    if (!d || !statuses.has(ev.sessionId)) return
    contexts.set(ev.sessionId, mergeContext(contexts.get(ev.sessionId), d, ev.ts))
    contextDirty.add(ev.sessionId)
  }

  /** Поле реестра с контекстом, если он менялся с прошлой записи (идёт попутно со статусом). */
  function unsavedContext(name: string): { context?: SessionContext } {
    const c = contexts.get(name)
    if (!c || !contextDirty.delete(name)) return {}
    return { context: c }
  }

  function trackUsage(ev: PultEvent): void {
    const rec = registry.get(ev.sessionId)
    const row = usageBySession.get(ev.sessionId) ?? {
      session: ev.sessionId,
      provider: rec?.provider ?? 'claude',
      totalCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0,
      rateLimit: null,
    }
    const d = ev.data as Record<string, unknown>
    if (d['source'] === 'result') {
      const u = (d['usage'] ?? null) as Record<string, number | null> | null
      row.totalCostUsd = typeof d['totalCostUsd'] === 'number' ? d['totalCostUsd'] : row.totalCostUsd
      row.turns += 1
      if (u) {
        row.inputTokens += u['input_tokens'] ?? 0
        row.outputTokens += u['output_tokens'] ?? 0
        row.cacheReadTokens += u['cache_read_input_tokens'] ?? 0
      }
    } else if (d['source'] === 'rate_limit_event') {
      row.rateLimit = { status: d['status'], windows: d['windows'], resetsAt: d['resetsAt'] }
    }
    usageBySession.set(ev.sessionId, row)
  }

  const currentStatus = (name: string): SessionStatus => {
    if (opts.broker.list(name).length > 0) return 'blocked_permission'
    return statuses.get(name) ?? 'cold'
  }


  // Автоназвание: один раз на сессию (флаг в реестре), в фоне — реплику не задерживает. Название,
  // заданное человеком за это время, не перетирается.
  const titling = new Set<string>()
  function maybeAutoTitle(name: string, text: string): void {
    const titler = opts.titler
    const rec = registry.get(name)
    if (!titler || !rec || rec.title || rec.autoTitled || titling.has(name)) return
    titling.add(name)
    registry.update(name, { autoTitled: true })
    titler(redactString(text)).then((t) => {
      const cur = registry.get(name)
      const title = t ? cleanTitle(t) : null
      if (!title || !cur || cur.title) return
      registry.update(name, { title })
      opts.logger.info('сессия названа по первой реплике', { session: name, title })
    }, (e: unknown) => {
      opts.logger.warn('автоназвание не вышло', { session: name, error: (e as Error).message })
    }).finally(() => { titling.delete(name) })
  }

  // --- О2: очередь реплик во время хода -------------------------------------------------------
  /** Ход идёт или реплика уходит: новая реплика сейчас не пройдёт `prompt`. */
  const busyNow = (name: string): boolean => {
    const live = inflight.get(name)
    const st = currentStatus(name)
    return (!!live && live.outcome === null) || prompting.has(name) || st === 'working' || HUMAN_STATUSES.has(st)
  }
  // Сессии, у которых идёт «прервать и сказать»: очередь ждёт, пока сказанное не уйдёт.
  const holdDrain = new Set<string>()
  // Стоп или закрытие попросил сам Пульт: `interrupted` в исходе хода — наш, событие пишет `stop`. Нет здесь —
  // ход прервал сервер (Codex), и событие пишет исход хода, иначе статус так и остался бы `working`.
  const stopRequested = new Set<string>()
  /** Общий объём очереди сессии в байтах: она живёт в sessions.json, а он пишется целиком на каждую правку. */
  const queueBytes = (q: readonly QueueItem[]): number => q.reduce((n, it) => n + Buffer.byteLength(it.text), 0)
  const queueState = (rec: SessionRecord): QueueState =>
    ({ name: rec.name, queue: publicQueue(rec.queue), queuePaused: rec.queuePaused === true })
  const pauseQueue = (name: string, why: string): void => {
    const rec = registry.get(name)
    if (!rec?.queue?.length || rec.queuePaused) return
    registry.update(name, { queuePaused: true })
    opts.logger.info('очередь реплик встала', { session: name, why, count: rec.queue.length })
  }
  function scheduleDrain(name: string): void {
    setImmediate(() => { void drain(name) })
  }
  /**
   * Следующая реплика очереди — тем же путём, что `agent.prompt` (брони, страж сети, журнал). Из очереди она
   * уходит ДО отправки и на диск: рестарт посреди хода её второй раз не пошлёт. Не ушла — обратно в голову
   * очереди, и очередь встаёт: решать человеку.
   */
  async function drain(name: string): Promise<void> {
    const rec = registry.get(name)
    if (!rec?.queue?.length || rec.queuePaused || holdDrain.has(name) || removing.has(name) || busyNow(name)) return
    if (opts.holdTurns?.()) return
    const [item, ...rest] = rec.queue as [QueueItem, ...QueueItem[]]
    // Голову правят — очередь стоит на ней: ни она, ни те, что за ней, не обгоняют правку.
    if (editHolds.get(name)?.has(item.id)) return
    registry.update(name, { queue: rest.length ? rest : undefined })
    rememberSent(name, item.id)
    try {
      const turn = await api.prompt(name, item.text)
      opts.logger.info('очередь: реплика ушла', { session: name, id: item.id, turnId: turn.turnId })
    } catch (e) {
      const cur = registry.get(name)
      // Та же сессия, а не новая с тем же именем (rm + start, пока реплика уходила): чужой очереди не трогаем.
      if (cur && cur.createdAt === rec.createdAt) registry.update(name, { queue: [item, ...(cur.queue ?? [])].slice(0, QUEUE_MAX), queuePaused: true })
      opts.logger.warn('очередь: реплика не ушла — очередь стоит', { session: name, id: item.id, error: (e as Error).message })
    }
  }
  /** Ход кончился: удачно и `idle` — дальше по очереди; упал, лимит, прерван — очередь встаёт. */
  function afterTurn(name: string, outcome: TurnOutcome): void {
    const rec = registry.get(name)
    if (!rec?.queue?.length) return
    const st = currentStatus(name)
    if (!outcome.ok || st === 'failed' || st === 'limited' || st === 'interrupted') {
      pauseQueue(name, outcome.errorCode ?? st)
      return
    }
    scheduleDrain(name)
  }
  const needQueueItem = (name: string, id: string): { rec: SessionRecord; at: number } => {
    const rec = needRec(name)
    const at = (rec.queue ?? []).findIndex((it) => it.id === id)
    if (at < 0) throw new ManagerError('not_found', `в очереди ${name} нет реплики ${id}`)
    return { rec, at }
  }

  // --- правка реплики в очереди: удержание ------------------------------------------------------
  // Удержания живут в памяти: рестарт демона и так ставит непустую очередь на паузу, а окно теряет связь.
  // Ключ — сессия, внутри — id реплики; владелец — номер соединения (отключился — правка снята).
  const editHolds = new Map<string, Map<string, { owner: number | null; timer: ReturnType<typeof setTimeout> }>>()
  // Последние ушедшие из очереди id — отказ правки говорит «уже ушла», а не «удалена».
  const sentIds = new Map<string, string[]>()
  const holdMs = opts.queueEditHoldMs ?? QUEUE_EDIT_HOLD_MS
  function rememberSent(name: string, id: string): void {
    const list = sentIds.get(name) ?? []
    list.push(id)
    if (list.length > QUEUE_SENT_MEMORY) list.splice(0, list.length - QUEUE_SENT_MEMORY)
    sentIds.set(name, list)
  }
  /** Снять удержание; `wake` — разбудить очередь (сессия могла простаивать, пока правка держала голову). */
  function dropHold(name: string, id: string, wake: boolean): boolean {
    const holds = editHolds.get(name)
    const h = holds?.get(id)
    if (!holds || !h) return false
    clearTimeout(h.timer)
    holds.delete(id)
    if (!holds.size) editHolds.delete(name)
    if (wake) {
      const rec = registry.get(name)
      if (rec?.queue?.length && !rec.queuePaused) scheduleDrain(name)
    }
    return true
  }
  function dropSessionHolds(name: string): void {
    for (const h of editHolds.get(name)?.values() ?? []) clearTimeout(h.timer)
    editHolds.delete(name)
    sentIds.delete(name)
  }
  /** Реплики в очереди нет: ушла (помним её id) или убрана; сессии нет — тоже «убрана». */
  const goneItem = (name: string, id: string): ManagerError => {
    if (!registry.get(name)) return new ManagerError('queue_item_removed', `сессии ${name} больше нет — реплика не сохранена`)
    if (sentIds.get(name)?.includes(id)) return new ManagerError('queue_item_sent', 'Реплика уже ушла — правка не сохранена')
    return new ManagerError('queue_item_removed', 'Реплика уже удалена из очереди — правка не сохранена')
  }
  const findQueueItem = (name: string, id: string): { rec: SessionRecord; at: number } => {
    const rec = registry.get(name)
    const at = rec ? (rec.queue ?? []).findIndex((it) => it.id === id) : -1
    if (!rec || at < 0) throw goneItem(name, id)
    return { rec, at }
  }

  // Сторож тишины: один таймер на демон, проход по статусам — дёшево и без таймера на событие.
  const silenceMs = Math.round(opts.config.watchdog.silenceMinutes * 60_000)
  const checkSilence = (): void => {
    const now = Date.now()
    for (const name of statuses.keys()) {
      if (currentStatus(name) !== 'working') continue
      const t0 = turnStartedAt.get(name)
      const last = lastEventAt.get(name) ?? t0
      if (last === undefined) continue
      const key = t0 ?? -1
      if (stalledFor.get(name) === key || now - last < silenceMs) continue
      const rec = registry.get(name)
      if (!rec) continue
      stalledFor.set(name, key)
      const live = inflight.get(name)
      const turnId = live && live.outcome === null ? live.turnId : undefined
      opts.logger.warn('сторож тишины: ход молчит', { session: name, turnId, silentForMs: now - last })
      emit({ sessionId: name, provider: rec.provider, kind: 'turn.stalled', data: { ...(turnId ? { turnId } : {}), silentForMs: now - last } })
    }
  }
  const watchdog = silenceMs > 0 ? setInterval(checkSilence, Math.max(50, Math.min(30_000, Math.floor(silenceMs / 4)))) : null
  watchdog?.unref?.()

  const api: SessionManager = {
    emit,

    has: (name) => registry.get(name) !== null,

    async start(params) {
      if (!isSessionName(params.name)) {
        throw new ManagerError('invalid_params', 'имя агента должно подходить под [a-z][a-z0-9_-]{0,31}')
      }
      if (registry.get(params.name)) {
        throw new ManagerError('invalid_params', `агент ${params.name} уже есть`)
      }
      const title = cleanTitle(params.title)
      // Имя резервируется СИНХРОННО, до первого `await`: старт с worktree ждёт git секундами,
      // и второй `agent start` с тем же именем проходил проверку реестра, заводил свою сессию в
      // адаптере поверх первой, а `registry.create` молча отдавал false.
      if (starting.has(params.name)) {
        throw new ManagerError('invalid_params', `агент ${params.name} уже заводится`)
      }
      starting.add(params.name)
      try {
        if (!params.cwd) throw new ManagerError('invalid_params', 'нужен --cwd')
        // Папку проверяем ЗДЕСЬ, а не у spawn: опечатка в `--cwd` иначе доходила до
        // `child_process.spawn`, и ошибка приезжала событием 'error' — то есть уже внутри хода.
        // Отказ на входе честнее и дешевле.
        let cwdOk = false
        try { cwdOk = statSync(params.cwd).isDirectory() } catch { cwdOk = false }
        if (!cwdOk) throw new ManagerError('invalid_params', `--cwd ${params.cwd}: такой папки нет`)
        const adapter = adapterFor(params.kind)
        const blocked = adapter.blocked()
        if (blocked.blocked) {
          throw new ManagerError('provider_unavailable', blocked.reason ?? `провайдер ${params.kind} остановлен`)
        }
        const mode: SessionMode = params.mode === 'warm' ? 'warm' : 'turn'
        if (params.base && !params.worktree) {
          throw new ManagerError('invalid_params', '--base имеет смысл только вместе с --worktree')
        }
        // Worktree заводится ДО адаптера и ДО записи в реестр: cwd сессии — это уже папка
        // worktree, и именно её запомнит реестр (ленивый resume после рестарта демона попадёт
        // туда же без особого случая). Проверка «провайдер остановлен» стоит выше — незачем
        // заводить ветку агенту, которого всё равно не пустят.
        let prepared: PreparedWorktree | null = null
        if (params.worktree) {
          const branch = params.worktree
          const wtOpts = {
            home: opts.paths.home,
            cwd: params.cwd,
            branch,
            ...(params.base ? { base: params.base } : {}),
            ...(opts.env ? { env: opts.env } : {}),
            inUseBy: (p: string): string | null =>
              registry.list().find((r) => r.worktree && r.worktree.path === p)?.name ?? pendingWorktrees.get(p) ?? null,
          }
          try {
            prepared = await serialWorktree(async () => {
              const got = await prepareWorktree(wtOpts)
              // Выдача фиксируется ВНУТРИ очереди: следующий в ней уже видит папку занятой.
              pendingWorktrees.set(got.worktree.path, params.name)
              return got
            })
          } catch (e) {
            throw asManagerError(e)
          }
        }
        const sessionCwd = prepared ? prepared.cwd : params.cwd
        // О3: имя переиспользуемо — профиль и скачивания браузера прежней сессии с этим именем новой не
        // достаются (куки входа чужие). Убирается до первого хода, с браузером или без.
        try { await resetBrowserDirs(opts.paths, params.name) } catch (e) {
          throw new ManagerError('internal', `каталог браузера прежней сессии ${params.name} не убран: ${(e as Error).message}`)
        }
        const started = await adapter.startSession({
          name: params.name,
          cwd: sessionCwd,
          ...(params.model ? { model: params.model } : {}),
          ...(params.effort ? { effort: params.effort } : {}),
          mode,
          ...(params.settingSources ? { settingSources: params.settingSources } : {}),
          broker: true,
          ...(params.approval && params.approval !== 'ask' ? { approval: params.approval } : {}),
        })
        const rec: SessionRecord = {
          name: params.name,
          ...(title ? { title } : {}),
          provider: params.kind,
          cwd: sessionCwd,
          ...(params.model ? { model: params.model } : {}),
          ...(params.effort ? { effort: params.effort } : {}),
          mode,
          // Граница доступа переживает рестарт вместе с сессией: без этой строки агент,
          // заведённый с урезанным `--setting-sources`, после перезапуска демона читал бы
          // ВСЕ наборы настроек — тише и шире, чем просил человек.
          ...(params.settingSources ? { settingSources: params.settingSources } : {}),
          // providerSessionId сюда НЕ пишется: на `agent start` он всего лишь выдуман
          // (`randomUUID`), разговора с таким id на диске ещё нет. Записанным он становится
          // по `session.started`, то есть по `system/init` от самого CLI, — см. `emit` выше.
          // Пока сюда попадал выдуманный, рестарт демона поднимал сессию с `started: true`,
          // первый же ход уходил с `--resume` и получал `No conversation found with session
          // ID`, и так навсегда.
          ...(prepared ? { worktree: prepared.worktree } : {}),
          ...(params.browser ? { browser: params.browser.headed ? { headed: true } : {} } : {}),
          // M8d: режим подтверждений — граница доступа, как settingSources: без этой строки resume после
          // рестарта демона поднимал бы сессию в `ask` (тише, чем просили) или — хуже — наоборот.
          ...(params.approval && params.approval !== 'ask' ? { approval: params.approval } : {}),
          createdAt: new Date().toISOString(),
          lastStatus: 'cold',
          lastEventId: 0,
          // Отметка «видел» — сразу: без неё рестарт демона до первого показа отдал бы новую сессию
          // миграции `seedSeen`, и её первый «готово» потерялся бы как прочитанный.
          lastSeenEventId: opts.store.lastId,
        }
        if (!registry.create(rec)) throw new ManagerError('invalid_params', `агент ${params.name} уже есть`)
        statuses.set(rec.name, 'cold')
        return prepared
          ? { ...rec, worktreeAction: prepared.action, ...(prepared.baseIgnored ? { baseIgnored: true } : {}) }
          : rec
      } finally {
        starting.delete(params.name)
        for (const [p, n] of pendingWorktrees) if (n === params.name) pendingWorktrees.delete(p)
      }
    },

    async importSession(params, providerSessionId, messages, forkOnResume = false) {
      await this.start(params)
      const adapter = adapterFor(params.kind)
      await adapter.close(params.name)
      const rec = registry.update(params.name, { providerSessionId, ...(forkOnResume ? { forkOnResume: true } : {}) })!
      for (const m of messages) {
        emit({ sessionId: rec.name, provider: rec.provider, kind: m.role === 'user' ? 'message.user' : 'message.done',
          data: { text: redactString(m.text), ...(m.role === 'assistant' ? { itemId: `import-${rec.name}-${Date.now()}-${Math.random()}` } : {}) } })
      }
      statuses.set(rec.name, 'cold')
      registry.update(rec.name, { lastStatus: 'cold' })
      return rec
    },

    // Событий не пишет: название — свойство записи реестра, а не хода; окно узнаёт его из
    // `agent.list`. Разрешено в любом статусе, в том числе посреди хода: адаптер и брокер
    // знают сессию по `name`, название до них не доходит.
    rename(name, title) {
      needRec(name)
      return registry.update(name, { title: cleanTitle(title) ?? undefined }) as SessionRecord
    },

    archive(name, archived) {
      needRec(name)
      return registry.update(name, { archived: archived ? true : undefined }) as SessionRecord
    },

    setBrowser(name, browser) {
      needRec(name)
      // Выбор человека сейчас перебивает то, что выключила смена режима (M8f): возвращать больше нечего.
      return registry.update(name, { browser: browser ? (browser.headed ? { headed: true } : {}) : undefined, browserSuspended: undefined }) as SessionRecord
    },

    async configure(p) {
      const name = p.name
      const first = needRec(name)
      if (removing.has(name)) throw new ManagerError('invalid_params', `агент ${name} удаляется — настройки не меняются`)
      // Список нужен только модели и усилию (ревью, LOW 9): смена одного режима не поднимает app-server Codex.
      const needList = p.model !== undefined || p.effort !== undefined
      const list = !needList ? null : first.provider === 'claude'
        ? (opts.modelChoices ? await opts.modelChoices('claude') : null) ?? claudeChoices()
        : (opts.modelChoices ? await opts.modelChoices('codex') : null)
      // Список мог идти секунды (Codex `model/list`): запись — свежая, а не та, что была до await.
      const cur = needRec(name)
      if (cur.createdAt !== first.createdAt) throw new ManagerError('not_found', `сессию ${name} пересоздали, пока шла проверка — повтори`)
      if (removing.has(name)) throw new ManagerError('invalid_params', `агент ${name} удаляется — настройки не меняются`)
      const windows = modelWindows(registry.list().map((r) => ({ ...(r.model ? { model: r.model } : {}), context: contexts.get(r.name) ?? r.context ?? null })))
      const used = (contexts.get(name) ?? cur.context)?.used ?? null
      let changes: ConfigureChanges
      try {
        changes = planConfigure({
          provider: cur.provider,
          ...(cur.model ? { model: cur.model } : {}),
          ...(cur.effort ? { effort: cur.effort } : {}),
          ...(cur.approval ? { approval: cur.approval } : {}),
          used,
        }, {
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.effort !== undefined ? { effort: p.effort } : {}),
          ...(p.approval !== undefined ? { approval: p.approval } : {}),
          ...(p.confirm === true ? { confirm: true } : {}),
        }, list, windows)
      } catch (e) {
        if (e instanceof ConfigureError) throw new ManagerError(e.code, e.message)
        throw e
      }
      if (!hasChanges(changes)) return { record: cur, changes, when: 'next_turn' }
      const next: SessionSettingsPatch = {
        ...((changes.model ? changes.model.to : cur.model) ? { model: (changes.model ? changes.model.to : cur.model) as string } : {}),
        ...((changes.effort ? changes.effort.to : cur.effort) ? { effort: (changes.effort ? changes.effort.to : cur.effort) as string } : {}),
        ...(((changes.approval ? changes.approval.to : cur.approval) ?? 'ask') !== 'ask'
          ? { approval: (changes.approval ? changes.approval.to : cur.approval) as ApprovalMode } : {}),
      }
      const patch: Partial<Omit<SessionRecord, 'name'>> = {
        model: next.model, effort: next.effort, approval: next.approval,
      }
      // Браузер — по правилу О3/M8d: в режиме без вопросов его вызовы шли бы мимо Inbox. Выключенный режимом
      // браузер помнится и возвращается, когда режим снова его позволяет.
      if (changes.approval) {
        const blocks = approvalBrowserRefusal(cur.provider, next.approval) !== null
        if (blocks && cur.browser) {
          patch.browser = undefined
          patch.browserSuspended = cur.browser
          changes.browser = 'off'
        } else if (!blocks && cur.browserSuspended) {
          patch.browser = cur.browserSuspended
          patch.browserSuspended = undefined
          changes.browser = 'on'
        }
      }
      // Адаптер — ДО записи: отказ (у Codex — браузер уже в загруженном треде) не оставляет полсмены в реестре.
      let when: ConfigureWhen = 'next_turn'
      const adapter = opts.adapters[cur.provider]
      if (adapter?.configure) {
        try {
          when = adapter.configure(name, next)
        } catch (e) {
          throw new ManagerError((e as { code?: string }).code ?? 'invalid_params', (e as Error).message)
        }
      }
      let record: SessionRecord
      try {
        record = registry.update(name, patch) as SessionRecord
      } catch (e) {
        // Запись на диск не вышла (ревью, LOW 8): адаптер возвращается к прежним настройкам — иначе ходы шли бы
        // с тем, чего в реестре нет и что рестарт демона молча отменил бы.
        // Прежние настройки были в силе — откат без отказов (`force`): у Codex иначе мог бы сработать отказ про браузер,
        // и адаптер остался бы на новых настройках, которых нет в реестре.
        try {
          adapter?.configure?.(name, {
            ...(cur.model ? { model: cur.model } : {}), ...(cur.effort ? { effort: cur.effort } : {}), ...(cur.approval ? { approval: cur.approval } : {}),
          }, true)
        } catch (re) { opts.logger.error('откат настроек в адаптере не удался', { session: name, error: (re as Error).message }) }
        throw e
      }
      emit({ sessionId: name, provider: cur.provider, kind: 'session.configured', data: { changes, when } })
      opts.logger.info('настройки сессии сменились', { session: name, changes, when })
      return { record, changes, when }
    },

    async prompt(name, text) {
      const rec = needRec(name)
      if (typeof text !== 'string' || !text.trim()) {
        throw new ManagerError('invalid_params', 'пустая реплика')
      }
      // Одна дверь на все пути хода: реплика, «Повторить», «прервать и сказать» и очередь идут через prompt.
      if (opts.holdTurns?.()) throw new ManagerError('updating', UPDATING_MESSAGE)
      const existing = inflight.get(name)
      if (existing && existing.outcome === null) {
        throw new ManagerError('invalid_params', `агент ${name} уже делает ход ${existing.turnId}`)
      }
      // Вторая реплика, пока первая ещё заводит ход (resume/send идут секунды): в `inflight` её ещё нет, и
      // без этой проверки обе уходили бы в адаптер одновременно.
      if (prompting.has(name)) {
        throw new ManagerError('invalid_params', `агент ${name} уже отправляет реплику — дождись начала хода`)
      }
      if (removing.has(name)) {
        throw new ManagerError('invalid_params', `агент ${name} удаляется (agent rm --worktree) — новый ход не заводится`)
      }
      const adapter = adapterFor(rec.provider)
      // M8f (ревью, HIGH 3): настройки ЭТОГО хода — снимок сейчас, до первого await. `agent.configure`, пришедший,
      // пока ход заводится (resume, страж сети, MCP), — для следующего хода: в ленте он стоит после реплики.
      const at: TurnSettings = {
        ...(rec.model ? { model: rec.model } : {}), ...(rec.effort ? { effort: rec.effort } : {}),
        ...(rec.approval ? { approval: rec.approval } : {}), browser: rec.browser ?? null,
      }
      // РЕПЛИКА ЧЕЛОВЕКА — В ЖУРНАЛ (Ф2, О1). Окну нужна лента разговора целиком, в том числе
      // после закрытия и повторного открытия, а до этого реплика жила только в stdin ребёнка.
      // Пишется ДО адаптера: ход, упавший на страже или на спавне, остаётся в ленте парой
      // «что сказал человек → почему не получилось». Отдельный вид, а не `message.done`:
      // статус сессии и текст ответа (`agent read`) реплика человека менять не должна.
      // Текст — через ту же редакцию, что и ответы модели (инвариант 7).
      emit({ sessionId: name, provider: rec.provider, kind: 'message.user', data: { text: redactString(text) } })
      phases.accepted(name)
      // Реплика в архивную сессию — она снова в работе: из архива её возвращает сама реплика.
      if (rec.archived) registry.update(name, { archived: undefined })
      maybeAutoTitle(name, text)
      prompting.set(name, (prompting.get(name) ?? 0) + 1)
      // ПОДЦЕПЛЕНИЕ ПОСЛЕ РЕСТАРТА. Реестр сессию пережил, а адаптер — нет: он живёт ровно
      // столько же, сколько процесс демона. Без этой строки первый же ход после
      // `daemon stop` + `daemon start` падал `сессия x не заведена в адаптере`, и агент был
      // мёртв до `agent rm` (ИЗМЕРЕНО 21.09.2026).
      //
      // ЛЕНИВО, а не при создании менеджера: `createManager` синхронный (его синхронно
      // строит `startDaemon`), и подцепление всех сессий заранее потребовало бы либо
      // асинхронного конструктора, либо промисов «в никуда» — ради работы, которая нужна
      // только `prompt`. `stop`, `rm`, `list`, `read` и `wait` обходятся без адаптера или
      // сами терпят неизвестную сессию.
      //
      // Звать можно безусловно: `resume` идемпотентен (знакомую сессию он не трогает) и
      // НИЧЕГО не запускает — процесс поднимет сам ход, разговор оживает через `--resume`.
      try {
        await adapter.resume(name, rec)
      } catch (e) {
        releasePrompting(name)
        // Ход не завёлся, а события конца нет: строка «запускается…» не должна висеть.
        phases.abandoned(name)
        throw e
      }
      // Пока шёл resume (секунды), могло начаться обновление (`update.apply {force}`): ход, отправленный
      // сейчас, оборвался бы на рестарте. Отказ тем же кодом; в ленте — ошибка, «Повторить» после рестарта.
      if (opts.holdTurns?.()) {
        releasePrompting(name)
        emit({ sessionId: name, provider: rec.provider, kind: 'status.changed', data: { status: 'failed', error: UPDATING_MESSAGE, errorCode: 'updating' } })
        throw new ManagerError('updating', UPDATING_MESSAGE)
      }
      // `send` резолвится, когда ход ЗАПУЩЕН, а не когда закончен: id уходит клиенту сразу,
      // конца ждут отдельным `agent.wait`.
      let started
      try {
        started = await adapter.send(name, text, at)
      } catch (e) {
        releasePrompting(name)
        const message = (e as Error).message
        emit({ sessionId: name, provider: rec.provider, kind: 'status.changed', data: { status: 'failed', error: message } })
        throw new ManagerError((e as { code?: string }).code ?? 'internal', message)
      }
      const entry: Inflight = { turnId: started.turnId, promise: started.done, outcome: null }
      inflight.set(name, entry)
      // Новый ход: стоп, попрошенный до него, к нему не относится.
      stopRequested.delete(name)
      releasePrompting(name)
      // Обработчик срабатывает ПОЗЖЕ — ход мог пережить `agent rm` и заведение сессии с тем
      // же именем. Сверка identity записи: чужому ходу нельзя помечать живую сессию failed.
      void started.done.then(
        (outcome) => {
          if (inflight.get(name) !== entry) return
          entry.outcome = outcome
          // Ход прервал не Пульт (сервер Codex сам): статус пишет менеджер — его хозяин (см. `interrupt`).
          if (outcome.errorCode === 'interrupted' && !stopRequested.has(name)) {
            emit({ sessionId: name, provider: rec.provider, kind: 'status.changed', data: { status: 'interrupted', turnId: entry.turnId, reason: 'provider_interrupted', ...(outcome.message ? { message: outcome.message } : {}) } })
          }
          stopRequested.delete(name)
          afterTurn(name, outcome)
        },
        (e: unknown) => {
          const outcome: TurnOutcome = {
            turnId: entry.turnId, ok: false,
            errorCode: (e as { code?: string }).code ?? 'internal',
            message: (e as Error).message,
          }
          if (inflight.get(name) !== entry) return
          entry.outcome = outcome
          emit({ sessionId: name, provider: rec.provider, kind: 'status.changed', data: { status: 'failed', error: outcome.message } })
          afterTurn(name, outcome)
        },
      )
      return { turnId: entry.turnId }
    },

    async say(name, text, sayOpts = {}) {
      const rec = needRec(name)
      if (typeof text !== 'string' || !text.trim()) throw new ManagerError('invalid_params', 'пустая реплика')
      // До «прервать»: иначе идущий ход остановился бы, а новый не завёлся. «В очередь» во время обновления
      // встаёт в очередь, только если реплика и так ждала бы (идёт ход или очередь не пуста): уйдёт после
      // рестарта или после провала обновления (`resumeQueues`). Свободной сессии — отказ: окно шлёт `queue`
      // на КАЖДЫЙ Enter («свободную демон пустит сразу»), и молча отложенная реплика вместо «Пульт обновляется»
      // стёрла бы черновик из поля.
      const held = opts.holdTurns?.() === true
      const wouldWait = busyNow(name) || ((rec.queue?.length ?? 0) > 0 && !rec.queuePaused)
      if (held && (sayOpts.interrupt || !sayOpts.queue || !wouldWait)) throw new ManagerError('updating', UPDATING_MESSAGE)
      if (sayOpts.interrupt) {
        if (removing.has(name)) throw new ManagerError('invalid_params', `агент ${name} удаляется — новый ход не заводится`)
        holdDrain.add(name)
        try {
          if (busyNow(name)) {
            await api.stop(name)
            // Ход осел: адаптер закрыл его исходом (`interrupted`), и вторая реплика не уходит.
            const deadline = Date.now() + INTERRUPT_SETTLE_MS
            for (;;) {
              const live = inflight.get(name)
              if ((!live || live.outcome !== null) && !prompting.has(name)) break
              if (Date.now() >= deadline) {
                throw new ManagerError('timeout', `ход ${name} не остановился за ${INTERRUPT_SETTLE_MS / 1000} с — реплика не отправлена`)
              }
              // `unref`: ожидание не держит остановку демона (см. `wait`).
              await new Promise<void>((r) => { const t = setTimeout(r, 40); t.unref?.() })
            }
          }
          return await api.prompt(name, text)
        } finally {
          holdDrain.delete(name)
        }
      }
      if (sayOpts.queue) {
        const q = rec.queue ?? []
        // Очередь, которая не стоит, — тоже «занято»: иначе новая реплика обогнала бы ждущие.
        if (busyNow(name) || (q.length > 0 && !rec.queuePaused)) {
          if (removing.has(name)) throw new ManagerError('invalid_params', `агент ${name} удаляется — очередь не принимает реплики`)
          if (q.length >= QUEUE_MAX) throw new ManagerError('invalid_params', `в очереди ${name} уже ${QUEUE_MAX} реплик — дождись хода или убери лишние`)
          if (queueBytes(q) + Buffer.byteLength(text) > QUEUE_TOTAL_BYTES) {
            throw new ManagerError('invalid_params', `очередь ${name} больше ${QUEUE_TOTAL_BYTES / 1024} КБ — дождись хода или убери лишние реплики`)
          }
          if ([...text].length > QUEUE_TEXT_MAX) throw new ManagerError('invalid_params', `реплика для очереди длиннее ${QUEUE_TEXT_MAX} знаков — отправь её, когда ход кончится`)
          let id = randomUUID().slice(0, 8)
          while (q.some((it) => it.id === id)) id = randomUUID().slice(0, 8)
          registry.update(name, { queue: [...q, { id, text, at: new Date().toISOString() }] })
          opts.logger.info('реплика встала в очередь', { session: name, id, count: q.length + 1 })
          // Ход мог кончиться, пока реплика вставала, — тогда она уйдёт сама, не дожидаясь следующего.
          scheduleDrain(name)
          return { queued: true, id }
        }
      }
      return await api.prompt(name, text)
    },

    startingTurns() {
      const out = new Set<string>(prompting.keys())
      for (const [name, live] of inflight) if (live.outcome === null) out.add(name)
      return [...out]
    },

    resumeQueues() {
      for (const rec of registry.list()) if (rec.queue?.length && !rec.queuePaused) scheduleDrain(rec.name)
    },

    queueResume(name) {
      const rec = needRec(name)
      const next = rec.queuePaused ? registry.update(name, { queuePaused: undefined }) as SessionRecord : rec
      if (next.queue?.length) scheduleDrain(name)
      return queueState(next)
    },

    queueRemove(name, id) {
      const { rec, at } = needQueueItem(name, id)
      const q = (rec.queue ?? []).filter((_, i) => i !== at)
      // Убрали реплику, которую правят, — правка держать больше нечего (сохранение получит «удалена»).
      dropHold(name, id, false)
      // Пустая очередь паузы не держит: следующая неудача поставит её заново.
      return queueState(registry.update(name, { queue: q.length ? q : undefined, ...(q.length ? {} : { queuePaused: undefined }) }) as SessionRecord)
    },

    queueMove(name, id, to) {
      const { rec, at } = needQueueItem(name, id)
      if (!Number.isSafeInteger(to)) throw new ManagerError('invalid_params', 'agent.queue.move: to — целый индекс')
      const q = [...(rec.queue ?? [])]
      const [item] = q.splice(at, 1) as [QueueItem]
      q.splice(Math.max(0, Math.min(to, q.length)), 0, item)
      const next = registry.update(name, { queue: q }) as SessionRecord
      // Правленую реплику увели с головы — новая голова может уйти, если сессия свободна.
      if (editHolds.has(name) && !next.queuePaused) scheduleDrain(name)
      return queueState(next)
    },

    queueHold(name, id, owner) {
      const { rec, at } = findQueueItem(name, id)
      let holds = editHolds.get(name)
      if (!holds) { holds = new Map(); editHolds.set(name, holds) }
      const prev = holds.get(id)
      if (prev) clearTimeout(prev.timer)
      const timer = setTimeout(() => {
        if (!dropHold(name, id, true)) return
        opts.logger.info('очередь: правка реплики не сохранена за срок — реплика уйдёт как была', { session: name, id })
      }, holdMs)
      timer.unref?.()
      holds.set(id, { owner: owner ?? null, timer })
      const item = (rec.queue ?? [])[at] as QueueItem
      return { ...queueState(rec), edit: { id, text: item.text, holdMs } }
    },

    queueRelease(name, id) {
      const rec = needRec(name)
      dropHold(name, id, true)
      return queueState(rec)
    },

    queueEdit(name, id, text) {
      if (typeof text !== 'string' || !text.trim()) throw new ManagerError('invalid_params', 'пустая реплика — убери её из очереди крестиком')
      const { rec, at } = findQueueItem(name, id)
      const q = [...(rec.queue ?? [])]
      const old = q[at] as QueueItem
      if ([...text].length > QUEUE_TEXT_MAX) throw new ManagerError('invalid_params', `реплика для очереди длиннее ${QUEUE_TEXT_MAX} знаков — отправь её, когда ход кончится`)
      if (queueBytes(q) - Buffer.byteLength(old.text) + Buffer.byteLength(text) > QUEUE_TOTAL_BYTES) {
        throw new ManagerError('invalid_params', `очередь ${name} больше ${QUEUE_TOTAL_BYTES / 1024} КБ — сократи реплику или убери лишние`)
      }
      q[at] = { ...old, text }
      const next = registry.update(name, { queue: q }) as SessionRecord
      // В журнал — только факт правки и id: текст реплики попадёт туда, как и прямая, отредактированным
      // `message.user` в момент отправки. Мимо `emit`: правка не активность хода (сторож тишины её не видит).
      opts.publish({ sessionId: name, provider: rec.provider, kind: 'queue.updated', data: { id } })
      opts.logger.info('очередь: реплика исправлена', { session: name, id })
      dropHold(name, id, true)
      return queueState(next)
    },

    queueReleaseOwner(owner) {
      for (const [name, holds] of [...editHolds]) {
        for (const [id, h] of [...holds]) if (h.owner === owner) dropHold(name, id, true)
      }
    },

    seen(name, unread, upTo) {
      const rec = needRec(name)
      if (unread) return rec.markedUnread ? rec : registry.update(name, { markedUnread: true }) as SessionRecord
      const lastId = opts.store.lastId
      // `upTo` — номер события, которое человек действительно видел (окно шлёт номер события внимания
      // открытой сессии): событие, пришедшее, пока запрос летел, остаётся непрочитанным. Без `upTo` (CLI)
      // — всё до конца журнала. Отметка назад не двигается.
      const prev = rec.lastSeenEventId ?? 0
      const next = Math.max(prev, upTo === undefined ? lastId : Math.min(upTo, lastId))
      // Окно зовёт это на каждом показе непрочитанной сессии: без перемен — без fsync реестра.
      if (next === rec.lastSeenEventId && !rec.markedUnread) return rec
      return registry.update(name, { lastSeenEventId: next, markedUnread: undefined }) as SessionRecord
    },

    async retry(name) {
      needRec(name)
      // Занятость — ДО всего: повтор посреди хода (или пока другая реплика уходит) не нужен никому.
      const live = inflight.get(name)
      const st = currentStatus(name)
      if ((live && live.outcome === null) || prompting.has(name) || removing.has(name) || st === 'working' || HUMAN_STATUSES.has(st)) {
        throw new ManagerError('invalid_params', `сессия ${name} занята — повторить можно, когда ход закончится`)
      }
      const att = opts.store.attention(name)
      if (!att) throw new ManagerError('invalid_params', `у сессии ${name} нет ошибки, которую можно повторить`)
      // Реплика упавшего хода — из файла сессии. Текст в журнале уже отредактирован (инвариант 7): секрет,
      // вырезанный из реплики, не вернётся и в повторе — это осознанно, журнал его не хранит.
      const found = retryPrompt(opts.store.readSession(name), att)
      if (!('text' in found)) throw new ManagerError('invalid_params', `повторить нельзя: ${found.reason}`)
      const turn = await this.prompt(name, found.text)
      // Повтор — ответ человека на ошибку: она прочитана, но только ПОСЛЕ того, как реплика ушла (отказ
      // `prompt` оставляет ошибку непрочитанной) и только до неё самой (новая ошибка останется видна).
      this.seen(name, false, att.id)
      return turn
    },

    async wait(params) {
      const name = params.name
      needRec(name)
      const until = new Set((params.until && params.until.length ? params.until : ['idle', 'blocked', 'done']).map(String))
      const timeoutMs = params.timeoutMs ?? 600_000
      const deadline = Date.now() + timeoutMs

      const matches = (s: SessionStatus): boolean => {
        if (until.has('blocked') && HUMAN_STATUSES.has(s)) return true
        if (until.has('done') && TERMINAL_STATUSES.has(s)) return true
        if (until.has('idle') && (s === 'idle' || s === 'limited' || s === 'interrupted')) return true
        return false
      }

      for (;;) {
        const entry = inflight.get(name)
        const s = currentStatus(name)
        // Блокировка на человеке важнее незавершённого хода: ход и не завершится, пока ждут.
        if (HUMAN_STATUSES.has(s) && until.has('blocked')) {
          return { name, status: s, reason: 'matched' }
        }
        if (entry && entry.outcome !== null) {
          const o = entry.outcome
          const after = currentStatus(name)
          if (matches(after) || !o.ok) {
            return {
              name, status: after, reason: 'matched', turnId: o.turnId, ok: o.ok,
              ...(o.errorCode ? { errorCode: o.errorCode } : {}),
              ...(o.text ? { text: o.text } : {}),
              ...(o.message ? { message: o.message } : {}),
            }
          }
        }
        if (!entry && matches(s)) return { name, status: s, reason: 'matched' }
        if (Date.now() >= deadline) return { name, status: s, reason: 'timeout' }
        // Таймер опроса `unref`-нут НАМЕРЕННО: ожидание длиной до десяти минут не имеет права
        // задерживать остановку демона. Цикл событий всё это время держит слушающий сокет —
        // он и есть причина, по которой `wait` доживает до ответа. ОБРАТНАЯ СТОРОНА: у
        // менеджера, позванного без демона (тест), держать цикл нечем, и `wait` там нужно
        // подпирать своим ref-нутым ожиданием — иначе node:test отменит тест посреди него.
        await new Promise<void>((r) => { const t = setTimeout(r, 40); t.unref?.() })
      }
    },

    read(name, since, format) {
      const rec = needRec(name)
      const events = opts.store.readFrom(since, { sessionId: name })
      const cursor = events.length ? (events[events.length - 1] as PultEvent).id : since
      const wt = rec.worktree ? { worktree: rec.worktree } : {}
      if (format === 'json') return { cursor, events, ...wt }
      const text = events
        .filter((e) => e.kind === 'message.done')
        .map((e) => String((e.data as { text?: unknown }).text ?? ''))
        .filter((t) => t.length > 0)
        .join('\n')
      return { cursor, text, ...wt }
    },

    list() {
      return registry.list().map((rec) => {
        // Живое значение свежее записанного: в реестр контекст попадает только со сменой статуса.
        const context = contexts.get(rec.name)
        const phase = phases.get(rec.name, { reasoning: false })
        return {
          ...rec,
          lastStatus: currentStatus(rec.name),
          pendingPermissions: opts.broker.list(rec.name).length,
          ...(context ? { context } : {}),
          ...(phase ? { phase } : {}),
        }
      })
    },

    phase(name) { return registry.get(name) ? phases.get(name) : null },

    phaseNames() { return phases.names().filter((n) => registry.get(n)) },

    live(name, sig) { if (statuses.has(name)) phases.live(name, sig) },

    async stop(name, turnId) {
      const rec = needRec(name)
      // «Прервать» из карточки «завис» — про конкретный ход: он уже кончился (или идёт другой) — ничего не делаем.
      if (turnId !== undefined) {
        const live = inflight.get(name)
        if (!live || live.outcome !== null || live.turnId !== turnId) return false
      }
      // Человек остановил ход — очередь встаёт: следующая реплика могла держаться на его результате.
      pauseQueue(name, 'stopped')
      stopRequested.add(name)
      await adapterFor(rec.provider).interrupt(name)
      for (const p of opts.broker.list(name)) {
        opts.broker.resolve(p.id, { behavior: 'deny', message: 'pult: агент остановлен' }, 'stop')
      }
      emit({ sessionId: name, provider: rec.provider, kind: 'status.changed', data: { status: 'interrupted' } })
      return true
    },

    async rm(name, rmOpts = {}) {
      const rec = needRec(name)
      let worktreeRemoved = false
      let reserved = false
      if (rmOpts.worktree) {
        if (!rec.worktree) {
          throw new ManagerError('invalid_params', `агент ${name} заведён без --worktree — убирать нечего`)
        }
        // Идущий ход ПИШЕТ в эту папку: «дерево чистое» сейчас ничего не значит через секунду,
        // а `worktree remove` посреди хода выдернул бы папку из-под работающего агента.
        const live = inflight.get(name)
        if ((live && live.outcome === null) || prompting.has(name) || currentStatus(name) === 'working') {
          throw new ManagerError('invalid_params', `агент ${name} делает ход — сначала pult agent stop ${name}`)
        }
        if (removing.has(name)) throw new ManagerError('invalid_params', `агент ${name} уже удаляется`)
        // Бронь — синхронно, до await: с этого момента prompt отказывает (см. `removing`).
        removing.add(name)
        reserved = true
        // Git — ДО удаления сессии: грязное дерево отказывает ВСЕЙ команде, и сессия остаётся
        // (docs/08 §6). Наоборот нельзя: удалённую сессию уже не вернуть, а правка в дереве жива.
        try {
          await serialWorktree(() => removeWorktree(rec.worktree as SessionWorktree, opts.env))
        } catch (e) {
          removing.delete(name)
          throw asManagerError(e)
        }
        worktreeRemoved = true
      }
      try {
        for (const p of opts.broker.list(name)) {
          opts.broker.resolve(p.id, { behavior: 'deny', message: 'pult: агент удалён' }, 'rm')
        }
        stopRequested.add(name)
        await adapterFor(rec.provider).close(name)
        emit({ sessionId: name, provider: rec.provider, kind: 'session.ended', data: { reason: 'rm' } })
        registry.remove(name)
        dropSessionHolds(name)
        statuses.delete(name)
        inflight.delete(name)
        usageBySession.delete(name)
        contexts.delete(name)
        contextDirty.delete(name)
        turnStartedAt.delete(name)
        lastEventAt.delete(name)
        stalledFor.delete(name)
        stopRequested.delete(name)
        phases.forget(name)
        // О3: профиль браузера сессии (куки входа) уходит вместе с ней — даже если браузер уже выключили:
        // после выхода Chrome (до 5 с), rename и удаление в фоне. Скачивания остаются до нового старта с этим именем.
        try { await removeBrowserProfile(opts.paths, name) } catch (e) { opts.logger.warn('профиль браузера не удалён', { session: name, error: (e as Error).message }) }
        return { ...(rec.worktree ? { worktree: rec.worktree } : {}), worktreeRemoved }
      } finally {
        if (reserved) removing.delete(name)
      }
    },

    tree(name) {
      needRec(name)
      return buildTree(opts.store.readFrom(0, { sessionId: name }))
    },

    usage() {
      const rows: UsageRow[] = []
      for (const rec of registry.list()) {
        rows.push(usageBySession.get(rec.name) ?? {
          session: rec.name, provider: rec.provider,
          totalCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0, rateLimit: null,
        })
      }
      return rows
    },

    providerReset(kind) {
      const adapter = adapterFor(kind)
      const was = adapter.blocked().blocked
      adapter.reset()
      return { was }
    },

    async shutdown() {
      if (watchdog) clearInterval(watchdog)
      for (const name of [...editHolds.keys()]) dropSessionHolds(name)
      for (const a of Object.values(opts.adapters)) {
        if (a) await a.shutdown()
      }
    },
  }
  return api
}
