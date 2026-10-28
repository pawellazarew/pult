// Состояние окна как свёртка потока событий: по сессиям (статус, активность, лента), Inbox,
// лимиты, отказы стража. ЧИСТАЯ функция — вся логика «событие → вид» здесь и в соседних
// модулях, компоненты только рисуют.
//
// Статус сессии считает ТА ЖЕ функция, что и демон (`reduceStatusEvent` из src/sessions/status.ts):
// одинаковые события обязаны давать одинаковый ответ в CLI и в окне. Поверх неё окно
// периодически накладывает `agent.list` (`syncStatuses`): после рестарта демона реестр
// «остужает» сессии в `cold` без события, и журнал этого не скажет.
//
// СТАРТ БЕЗ ДОИГРЫВАНИЯ (0.2.19). Раньше окно сворачивало журнал с нуля — 18,6 МБ на 14.10.2026 и
// +1,7 МБ в день. Теперь: снимок `events.snapshot` (последние фон, контекст, лимиты и отказы по
// сессиям + время активности) → `bootState`, живой поток с его курсора, а ленту сессии — только
// когда её открывают: `beginHydrate` → `events.history` (лёгкая история, src/core/history.ts) →
// `finishHydrate`. События сессии, пришедшие, пока история в пути, копятся в `inflight` и
// доигрываются поверх неё — иначе ответ истории затёр бы их. Старая оболочка, не знающая новых
// методов, остаётся на полном доигрывании (`lazy: false`).

import { reduceStatusEvent } from '../../../src/sessions/status.js'
import { applyContext } from './context.js'
import type { SessionContext } from './context.js'
import { applyConversation, EMPTY_CONVERSATION, expirePermissions, expirePermissionsBefore } from './conversation.js'
import type { ConvItem } from './conversation.js'
import type { Conversation } from './conversation.js'
import { guardFromEvent } from './health.js'
import type { GuardCheck } from './health.js'
import { applyInbox, EMPTY_INBOX } from './inbox.js'
import type { InboxState } from './inbox.js'
import { applyUsage, EMPTY_USAGE } from './usage.js'
import type { UsageState } from './usage.js'
import type { AgentRecord, PultEvent, SessionStatus } from './types.js'
import { str } from './types.js'

export interface SessionLive {
  status: SessionStatus
  /** id события, которое последним сменило статус в свёртке (0 — статус из реестра). */
  statusId: number
  lastTs: string
  /** Начало последнего хода по живому потоку (`message.user`): строка встаёт наверх сразу, до `agent.list`. */
  lastTurnTs?: string
  conv: Conversation
  /** Фоновые задачи (`background.changed`): процесс сессии жив ради них и после ответа. */
  background?: { count: number; tasks: readonly string[] }
  /** Контекстное окно по последнему `context.updated` (журнал доигрывается с нуля — оно точное). */
  context?: SessionContext
}

export interface UiState {
  lastId: number
  sessions: Readonly<Record<string, SessionLive>>
  inbox: InboxState
  usage: UsageState
  /** Отказы стража из журнала — последние по провайдеру. */
  guard: readonly GuardCheck[]
  /** Старт по снимку: ленты сессий собираются по требованию (`hydration`). false — полное доигрывание. */
  lazy: boolean
  /** Номер последнего `daemon.started`: неотвеченные карточки ленты старше него гаснут. */
  bootId: number
  /** Лента сессии: грузится или собрана из истории. Нет записи — ещё не открывали. */
  hydration: Readonly<Record<string, 'loading' | 'done'>>
  /** События сессии, пришедшие живьём, пока её история в пути. */
  inflight: Readonly<Record<string, readonly PultEvent[]>>
  /**
   * «Пол» ленты: курсор истории, из которой она собрана. Событие сессии с номером не выше него в
   * ленте уже есть — оно могло ждать отрисовки в очереди окна, пока шла история (ревью M1: текст
   * идущей реплики двоился).
   */
  floors: Readonly<Record<string, number>>
  /** Ранние страницы истории (`events.history` с `before`) — встают в ленту перед собранной. */
  earlier: Readonly<Record<string, EarlierPages>>
}

export interface EarlierPages {
  items: readonly ConvItem[]
  /** Есть ещё раньше. */
  more: boolean
  /** `before` следующего запроса. */
  oldest: number | null
  loading: boolean
}

export const EMPTY_STATE: UiState = {
  lastId: 0, sessions: {}, inbox: EMPTY_INBOX, usage: EMPTY_USAGE, guard: [], lazy: false, bootId: 0,
  hydration: {}, inflight: {}, floors: {}, earlier: {},
}

/** Ответ `events.snapshot` (src/core/store.ts StoreSnapshot). */
export interface EventsSnapshot {
  events: readonly PultEvent[]
  activity: Readonly<Record<string, string>>
  cursor: number
}

/** Ответ `events.history` (src/core/history.ts HistoryPage + курсор журнала). */
export interface HistoryPageReply {
  events: readonly PultEvent[]
  more: boolean
  oldest: number | null
  cursor: number
}

/** Сессия самого демона: её события — не разговор агента. */
const DAEMON = 'daemon'

export function applyEvent(s: UiState, ev: PultEvent): UiState {
  if (!Number.isInteger(ev.id) || ev.id <= s.lastId) return s
  let sessions = s.sessions
  let bootId = s.bootId
  if (ev.kind === 'daemon.started') {
    bootId = ev.id
    // Новый запуск демона — новый брокер: неотвеченные карточки прошлого запуска гаснут.
    for (const [name, live] of Object.entries(sessions)) {
      const conv = expirePermissions(live.conv)
      // Процессы сессий ушли вместе с прошлым демоном — их фоновые задачи тоже.
      const background = live.background?.count ? { count: 0, tasks: [] } : live.background
      if (conv !== live.conv || background !== live.background) sessions = { ...sessions, [name]: { ...live, conv, ...(background ? { background } : {}) } }
    }
  }
  let inflight = s.inflight
  if (ev.sessionId !== DAEMON) {
    // «Пол» ленты гасит только ЛЕНТУ: реплика с номером не выше курсора истории в ней уже есть. Статус,
    // фон и контекст сессии собраны из живого потока (finishHydrate берёт их из текущего состояния), а
    // это событие в поток ещё не легло — оно ждало в очереди окна, пока шла история. Выбросить его
    // целиком — значит потерять смену статуса: окно залипало на «готов» посреди хода (e2e «Стоп» и
    // «⌘Enter посреди хода»: `status.changed working` ≤ курсора выброшен, `session.started` выше
    // курсора свернул `cold` в `idle`).
    const conv = ev.id > (s.floors[ev.sessionId] ?? 0)
    const prev = sessions[ev.sessionId]
    const next = foldSession(prev, ev, conv)
    if (next !== prev) {
      if (next) sessions = { ...sessions, [ev.sessionId]: next }
      else { const rest = { ...sessions }; delete rest[ev.sessionId]; sessions = rest }
    }
    if (conv && s.hydration[ev.sessionId] === 'loading') inflight = { ...inflight, [ev.sessionId]: [...(inflight[ev.sessionId] ?? []), ev] }
  }
  const inbox = applyInbox(s.inbox, ev)
  const usage = applyUsage(s.usage, ev)
  let guard = s.guard
  const g = guardFromEvent(ev)
  if (g) guard = [...s.guard.filter((c) => c.provider !== g.provider), g]
  return { ...s, lastId: ev.id, bootId, sessions, inbox, usage, guard, inflight }
}

/**
 * Одно событие в одну сессию — без общего `lastId`: ею же собирается лента из истории.
 * undefined — сессии нет (удалена: `session.ended` с reason `rm`). `withConv: false` — лента событие
 * уже видела (оно не выше «пола» истории): двигаются статус, фон, контекст и время, лента — нет.
 */
export function foldSession(prev: SessionLive | undefined, ev: PultEvent, withConv = true): SessionLive | undefined {
  // Агент удалён: имя свободно, и новый агент с тем же именем не должен унаследовать ленту.
  if (ev.kind === 'session.ended' && ev.data['reason'] === 'rm') return undefined
  const base: SessionLive = prev ?? { status: 'cold', statusId: 0, lastTs: ev.ts, conv: EMPTY_CONVERSATION }
  const status = reduceStatusEvent(base.status, ev)
  const statusId = status !== base.status ? ev.id : base.statusId
  const conv = withConv ? applyConversation(base.conv, ev) : base.conv
  const context = applyContext(base.context, ev)
  // Дельты не двигают «последнюю активность» строки: иначе список прыгал бы на каждом токене.
  // Замер контекста — тоже: это справка о разговоре, а не новая работа.
  // Событие из-под «пола» старше того, что история уже показала: время назад не идёт.
  const lastTs = ev.kind === 'message.delta' || ev.kind === 'context.updated' || (!withConv && Date.parse(ev.ts) <= Date.parse(base.lastTs)) ? base.lastTs : ev.ts
  const background = ev.kind === 'background.changed' ? backgroundOf(ev) : base.background
  // Порядок бесед двигает только начало хода — реплика человека; всё, что идёт внутри хода и после, — нет.
  const lastTurnTs = ev.kind === 'message.user' ? laterTs(base.lastTurnTs, ev.ts) : base.lastTurnTs
  if (prev && status === prev.status && conv === prev.conv && lastTs === prev.lastTs && background === prev.background && context === prev.context && lastTurnTs === prev.lastTurnTs) return prev
  return { status, statusId, lastTs, ...(lastTurnTs ? { lastTurnTs } : {}), conv, ...(background ? { background } : {}), ...(context ? { context } : {}) }
}

/**
 * Состояние окна по снимку `events.snapshot`: последние фон, контекст, лимиты и отказы — как если
 * бы журнал доиграли, но без лент; время активности — из снимка. Живой поток идёт с `cursor`.
 *
 * `prev` — то, что окно успело узнать до снимка: Inbox из `perm.list` и статусы из `agent.list`
 * (их ответы обычно приходят раньше). Снимок их НЕ трогает: в нём нет разрешений, а статус по
 * последнему `limit.hit`/`net.blocked` после перезапуска демона залипал бы (ревью M1) — статус
 * решает реестр.
 */
export function bootState(snap: EventsSnapshot, prev: UiState = EMPTY_STATE): UiState {
  let s: UiState = { ...EMPTY_STATE, lazy: true }
  s = applyEvents(s, [...snap.events].sort((a, b) => a.id - b.id))
  const names = new Set([...Object.keys(s.sessions), ...Object.keys(snap.activity), ...Object.keys(prev.sessions)])
  names.delete(DAEMON)
  const sessions: Record<string, SessionLive> = {}
  for (const name of names) {
    const folded = s.sessions[name]
    const before = prev.sessions[name]
    const lastTs = snap.activity[name] ?? folded?.lastTs ?? before?.lastTs ?? new Date(0).toISOString()
    const background = folded?.background
    const context = folded?.context ?? before?.context
    const lastTurnTs = before?.lastTurnTs
    sessions[name] = {
      status: before?.status ?? 'cold',
      statusId: before?.statusId ?? 0,
      lastTs,
      ...(lastTurnTs ? { lastTurnTs } : {}),
      conv: EMPTY_CONVERSATION,
      ...(background ? { background } : {}),
      ...(context ? { context } : {}),
    }
  }
  return { ...s, sessions, inbox: prev.inbox, lastId: Math.max(s.lastId, snap.cursor) }
}

/** Ленту сессии нужно собрать из истории: старт по снимку и её ещё не грузили. */
export function needsHydrate(s: UiState, name: string): boolean {
  return s.lazy && s.hydration[name] === undefined
}

export function beginHydrate(s: UiState, name: string): UiState {
  return { ...s, hydration: { ...s.hydration, [name]: 'loading' }, inflight: { ...s.inflight, [name]: [] } }
}

/** История не пришла (демон перезапускался и т.п.): следующее открытие попробует снова. */
export function failHydrate(s: UiState, name: string): UiState {
  const hydration = { ...s.hydration }
  delete hydration[name]
  const inflight = { ...s.inflight }
  delete inflight[name]
  return { ...s, hydration, inflight }
}

/**
 * Лента из последней страницы истории (номера ≤ `page.cursor`) плюс то, что пришло живьём, пока
 * она была в пути (номера > курсора). Статус, фон и контекст — из текущего состояния, если сессия в
 * нём уже есть: реестр и живой поток знают «сейчас», история сессии не видит перезапусков демона.
 * Карточки разрешений старше последнего запуска демона гаснут. Курсор становится «полом» ленты.
 */
export function finishHydrate(s: UiState, name: string, page: HistoryPageReply): UiState {
  let live: SessionLive | undefined
  for (const ev of page.events) live = foldSession(live, ev)
  if (live) live = { ...live, conv: { ...live.conv, lastId: Math.max(live.conv.lastId, page.cursor) } }
  for (const ev of s.inflight[name] ?? []) if (ev.id > page.cursor) live = foldSession(live, ev)
  const cur = s.sessions[name]
  // Статуса сессии в окне ещё нет — он из истории, но только по то, что живой поток уже прошёл
  // (`s.lastId`): события выше него ждут в очереди окна и лягут поверх (applyEvent, мимо ленты).
  // Свернуть их здесь — значит применить дважды.
  let seen: SessionLive | undefined
  if (!cur) for (const ev of page.events) if (ev.id <= s.lastId) seen = foldSession(seen, ev, false)
  let sessions = s.sessions
  if (live) {
    const lastTs = cur && Date.parse(cur.lastTs) > Date.parse(live.lastTs) ? cur.lastTs : live.lastTs
    const background = cur ? cur.background : live.background
    const context = cur?.context ?? live.context
    // Начало хода — только из живого потока (оно уже в `cur`): реплика из истории старше того, что знает реестр, а у
    // записи без `lastTurnAt` подняла бы беседу в момент, когда её просто открыли.
    const lastTurnTs = cur?.lastTurnTs
    sessions = {
      ...sessions,
      [name]: {
        status: cur ? cur.status : seen?.status ?? 'cold',
        statusId: cur ? cur.statusId : seen?.statusId ?? 0,
        lastTs,
        ...(lastTurnTs ? { lastTurnTs } : {}),
        conv: expirePermissionsBefore(live.conv, s.bootId),
        ...(background ? { background } : {}),
        ...(context ? { context } : {}),
      },
    }
  }
  const inflight = { ...s.inflight }
  delete inflight[name]
  return {
    ...s,
    sessions,
    hydration: { ...s.hydration, [name]: 'done' },
    inflight,
    floors: { ...s.floors, [name]: page.cursor },
    earlier: { ...s.earlier, [name]: { items: [], more: page.more, oldest: page.oldest, loading: false } },
  }
}

/** Идёт запрос более ранней страницы: кнопка «Показать раньше» ждёт. */
export function beginEarlier(s: UiState, name: string): UiState {
  const e = s.earlier[name]
  if (!e || !e.more || e.loading) return s
  return { ...s, earlier: { ...s.earlier, [name]: { ...e, loading: true } } }
}

/**
 * Ранняя страница встаёт перед уже показанным. Страницы режутся по началу хода
 * (src/core/history.ts pageHistory), поэтому складываются целиком, без склейки на стыке.
 */
export function finishEarlier(s: UiState, name: string, page: HistoryPageReply): UiState {
  const e = s.earlier[name]
  if (!e) return s
  let live: SessionLive | undefined
  for (const ev of page.events) live = foldSession(live, ev)
  const items = live ? expirePermissionsBefore(live.conv, s.bootId).items : []
  return { ...s, earlier: { ...s.earlier, [name]: { items: [...items, ...e.items], more: page.more, oldest: page.oldest ?? e.oldest, loading: false } } }
}

export function failEarlier(s: UiState, name: string): UiState {
  const e = s.earlier[name]
  return e ? { ...s, earlier: { ...s.earlier, [name]: { ...e, loading: false } } } : s
}

/** Более позднее из двух ISO-времён; время начала хода назад не идёт (история приходит после живого потока). */
function laterTs(a: string | undefined, b: string | undefined): string | undefined {
  if (!a || !b) return a || b
  return Date.parse(b) > Date.parse(a) ? b : a
}

function backgroundOf(ev: PultEvent): { count: number; tasks: string[] } {
  const tasks = Array.isArray(ev.data['tasks'])
    ? (ev.data['tasks'] as unknown[]).flatMap((t) => { const d = t && typeof t === 'object' ? str((t as Record<string, unknown>)['description']) : null; return d ? [d] : [] })
    : []
  const count = typeof ev.data['count'] === 'number' ? ev.data['count'] : tasks.length
  return { count, tasks }
}

export function applyEvents(s: UiState, evs: readonly PultEvent[]): UiState {
  let out = s
  for (const ev of evs) out = applyEvent(out, ev)
  return out
}


/**
 * Наложить статусы реестра (`agent.list`) — правду «после рестарта». Ответ списка может
 * опоздать: если свёртка уже видела смену статуса НОВЕЕ той, что записана в реестре
 * (`lastEventId` — событие последней смены статуса), свежая свёртка остаётся.
 */
export function syncStatuses(s: UiState, records: readonly AgentRecord[]): UiState {
  let sessions = s.sessions
  for (const r of records) {
    const cur = sessions[r.name]
    if (cur && (cur.status === r.lastStatus || cur.statusId > r.lastEventId)) continue
    sessions = { ...sessions, [r.name]: { conv: cur?.conv ?? EMPTY_CONVERSATION, lastTs: cur?.lastTs ?? r.createdAt, ...(cur?.lastTurnTs ? { lastTurnTs: cur.lastTurnTs } : {}), status: r.lastStatus, statusId: cur?.statusId ?? 0, ...(cur?.background ? { background: cur.background } : {}), ...(cur?.context ? { context: cur.context } : {}) } }
  }
  return sessions === s.sessions ? s : { ...s, sessions }
}

/** Виды событий, после которых стоит перечитать `agent.list` (заведение, удаление, смена статуса). */
export function refreshesAgents(ev: PultEvent): boolean {
  return ev.kind === 'session.started' || ev.kind === 'session.ended' || ev.kind === 'status.changed'
    || ev.kind === 'daemon.started' || ev.kind === 'permission.requested' || ev.kind === 'permission.resolved'
    // О2: новое событие внимания — непрочитанное и карточка ошибки в Inbox живут в `agent.list`.
    || ev.kind === 'question.asked' || ev.kind === 'limit.hit' || ev.kind === 'net.blocked' || ev.kind === 'provider.blocked'
    || ev.kind === 'turn.stalled'
}

// Уведомления — ui/src/model/notify.ts (правила О2: порог хода, звук по виду, предел пачки).
export { notificationFor } from './notify.js'
export type { Notice } from './notify.js'
