// Inbox: запросы разрешений всех агентов (docs/12 §3 п.3). Чистые функции.
//
// Живёт на событиях (`permission.requested` добавляет, `permission.resolved` и `session.ended`
// убирают), а при каждом подключении сверяется с `perm.list` — он правда «прямо сейчас»: запрос,
// снятый, пока окна не было, иначе висел бы в Inbox вечно.

import { isErrorKind, isRetryable } from '../../../src/sessions/attention.js'
import type { AgentView } from './agents.js'
import { statusView } from './agents.js'
import type { AttentionKind, PendingPermission, PultEvent } from './types.js'
import { obj, str } from './types.js'
import { parseOffers } from './permissions.js'
import type { PermissionOffers } from '../../../src/adapters/types.js'

export interface InboxItem {
  id: string
  sessionId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** M8d: «В этой сессии» / «Всегда …» — что провайдер предложил на этот запрос. */
  offers?: PermissionOffers
  /** Показанный вход не равен исполняемому (src/perm/broker.ts). */
  concealed?: true
  createdAt: string
}

export type InboxState = Readonly<Record<string, InboxItem>>

export const EMPTY_INBOX: InboxState = {}

export function applyInbox(state: InboxState, ev: PultEvent): InboxState {
  switch (ev.kind) {
    case 'permission.requested': {
      const id = str(ev.data['id'])
      if (!id || state[id]) return state
      const toolUseId = str(ev.data['toolUseId'])
      const offers = parseOffers(ev.data['offers'])
      return {
        ...state,
        [id]: {
          id,
          sessionId: ev.sessionId,
          toolName: str(ev.data['toolName']) ?? 'tool',
          ...(toolUseId ? { toolUseId } : {}),
          input: obj(ev.data['input']) ?? {},
          ...(offers ? { offers } : {}),
          ...(ev.data['concealed'] === true ? { concealed: true as const } : {}),
          createdAt: ev.ts,
        },
      }
    }
    case 'permission.resolved': {
      const id = str(ev.data['id'])
      if (!id || !state[id]) return state
      const next = { ...state }
      delete next[id]
      return next
    }
    case 'session.ended':
    case 'daemon.stopping': {
      // Демон уходит — брокер откажет всем сам; сессия ушла — её запросы тоже.
      const drop = Object.values(state).filter((p) => ev.kind === 'daemon.stopping' || p.sessionId === ev.sessionId)
      if (!drop.length) return state
      const next = { ...state }
      for (const p of drop) delete next[p.id]
      return next
    }
    default:
      return state
  }
}

/**
 * Сверка с `perm.list`: остаётся ровно то, что демон считает ожидающим. `askedAt` — когда ушёл
 * запрос `perm.list`: запрос разрешения, пришедший событием ПОСЛЕ этого момента, ответ списка
 * мог не застать, и выкидывать его нельзя.
 */
export function reconcileInbox(state: InboxState, pending: readonly PendingPermission[], askedAt?: string): InboxState {
  const next: Record<string, InboxItem> = {}
  const after = askedAt ? Date.parse(askedAt) : Number.POSITIVE_INFINITY
  for (const p of Object.values(state)) if (Date.parse(p.createdAt) >= after) next[p.id] = p
  for (const p of pending) {
    const had = state[p.id]
    const offers = parseOffers(p.offers)
    next[p.id] = had ?? {
      id: p.id,
      sessionId: p.sessionId,
      toolName: p.toolName,
      ...(p.toolUseId ? { toolUseId: p.toolUseId } : {}),
      input: p.input,
      ...(offers ? { offers } : {}),
      ...(p.concealed === true ? { concealed: true as const } : {}),
      createdAt: p.createdAt,
    }
  }
  const same = Object.keys(next).length === Object.keys(state).length && Object.keys(next).every((k) => state[k] === next[k])
  return same ? state : next
}

/** Старые сверху: кто ждёт дольше, тот и первый. */
export function inboxList(state: InboxState): InboxItem[] {
  return Object.values(state).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
}

/** Сколько ждут по агентам — для строки списка. */
export function pendingBySession(state: InboxState): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of Object.values(state)) out[p.sessionId] = (out[p.sessionId] ?? 0) + 1
  return out
}

/**
 * Какой запрос «выделен» (⌘Enter разрешает его): выбранный человеком, если он ещё ждёт; иначе
 * первый запрос текущего агента; иначе самый старый.
 *
 * Выделить можно только запрос, карточку которого человек ВИДИТ: свой у текущего агента (карточка в
 * разговоре) или показанный в Inbox (`shown`; Inbox закрыт или отфильтрован — `[]`). КАК ЛОМАЛОСЬ:
 * при закрытом Inbox откат шёл на самый старый запрос ЛЮБОЙ сессии, и ⌘↵ в сессии A разрешал
 * команду сессии B, которой на экране не было.
 *
 * Это правило ⌘↵ ВНЕ поля ввода. В поле реплики сессии A действует более узкое — `composerApproves`.
 */
export function focusedRequest(list: readonly InboxItem[], chosen: string | null, currentAgent: string | null, shown: readonly InboxItem[] = list, ownShown = true): InboxItem | null {
  const shownIds = new Set(shown.map((p) => p.id))
  // Свой запрос виден в разговоре, только когда лента загрузилась (`ownShown`): пока она грузится, карточки на экране нет.
  const visible = list.filter((p) => (ownShown && p.sessionId === currentAgent) || shownIds.has(p.id))
  if (chosen) { const hit = visible.find((p) => p.id === chosen); if (hit) return hit }
  if (currentAgent) { const own = visible.find((p) => p.sessionId === currentAgent); if (own) return own }
  return visible[0] ?? null
}

/**
 * ⌘↵ в поле реплики разрешает только запрос ТЕКУЩЕЙ сессии: человек печатает сессии A, и карточка сессии B, пусть
 * видимая в открытом Inbox, не должна получить «да» от клавиши, нажатой в чужом поле. Возвращает запрос, который
 * ⌘↵ из поля разрешит, или null (тогда клавиша — «прервать и сказать» или ничего).
 */
export function composerApproves(focused: InboxItem | null, currentAgent: string | null): InboxItem | null {
  return focused && currentAgent !== null && focused.sessionId === currentAgent ? focused : null
}

// --- О2: ошибки и фильтры Inbox (docs/14 «Ошибки в Inbox и фильтры») ------------------------------
// Inbox — почтовый ящик всего, что требует человека: разрешения и вопросы — из `perm.list` и потока,
// ошибки и непрочитанное — из `agent.list` (демон держит последнее событие внимания и отметку «видел»).

/** Фильтр в шапке Inbox: «Все» (запросы + ошибки), «Непрочитанные» (все непрочитанные сессии), «Ошибки». */
export type InboxFilter = 'all' | 'unread' | 'errors'

export const INBOX_FILTERS: ReadonlyArray<readonly [InboxFilter, string]> = [
  ['all', 'Все'],
  ['unread', 'Непрочитанные'],
  ['errors', 'Ошибки'],
]

export function isInboxFilter(x: unknown): x is InboxFilter {
  return x === 'all' || x === 'unread' || x === 'errors'
}

/** Карточка сессии в Inbox: ошибка (с «Повторить») или непрочитанное «готово»/вопрос (с «Открыть»). */
export interface SessionCard {
  name: string
  kind: AttentionKind
  /** Номер события внимания — ключ карточки и порядок (старые сверху). */
  id: number
  at: string
  text?: string
  error: boolean
  /** «Повторить» доступно: ошибка случилась в ходе (`turnId`), и сессия сейчас не занята ходом. */
  retryable: boolean
  /** Ход события (у «завис» — тот, что молчит): «Прервать» стопит только его. */
  turnId?: string
}

/** Подпись вида события для карточки. */
export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  done: 'Готово',
  failed: 'Ход упал',
  ask: 'Вопрос или разрешение',
  limit: 'Лимит исчерпан',
  blocked: 'Страж не пустил',
  stalled: 'Похоже, завис',
}

function card(a: AgentView): SessionCard | null {
  // Архивные — убраны с глаз: ни карточек, ни чисел (как и в очереди ⌘⌥L и на доке).
  if (!a.unread || a.archived) return null
  const att = a.attention
  // Пометили непрочитанной без события внимания — карточка «готово» без причины.
  if (!att) return { name: a.name, kind: 'done', id: 0, at: a.lastActivity, error: false, retryable: false }
  return {
    name: a.name, kind: att.kind, id: att.id, at: att.at, ...(att.text ? { text: att.text } : {}), ...(att.turnId ? { turnId: att.turnId } : {}),
    error: isErrorKind(att), retryable: isRetryable(att) && !statusView(a.status).busy,
  }
}

export interface InboxView {
  /** Запросы разрешений и вопросы — карточки PermCard. */
  perms: InboxItem[]
  /** Карточки сессий: ошибки («Все», «Ошибки») или всё непрочитанное («Непрочитанные»). */
  sessions: SessionCard[]
}

/** Что показать в Inbox при фильтре. Порядок — старые сверху, как у запросов. */
export function inboxView(filter: InboxFilter, perms: readonly InboxItem[], agents: readonly AgentView[]): InboxView {
  const cards = agents.map(card).filter((c): c is SessionCard => c !== null).sort((a, b) => a.id - b.id || a.name.localeCompare(b.name))
  if (filter === 'unread') return { perms: [], sessions: cards }
  const errors = cards.filter((c) => c.error)
  return { perms: filter === 'all' ? [...perms] : [], sessions: errors }
}

/** Сколько карточек у каждого фильтра — числа на кнопках фильтра. */
export function inboxCounts(perms: readonly InboxItem[], agents: readonly AgentView[]): Record<InboxFilter, number> {
  const live = agents.filter((a) => a.unread && !a.archived)
  const unread = live.length
  const errors = live.filter((a) => isErrorKind(a.attention)).length
  return { all: perms.length + errors, unread, errors }
}
