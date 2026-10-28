// «Внимание» сессии (О2, docs/14 «Непрочитанное и значок на доке»): что последнее случилось с сессией
// такого, ради чего человеку стоит её открыть, — и видел ли он это. ЧИСТЫЕ функции: их зовут демон
// (хранилище копит последнее событие внимания по сессии), окно (точка в дереве, Inbox, ⌘⌥L) и оболочка
// (значок на доке). Одна классификация на троих — иначе окно и док разойдутся в счёте.
//
// ПОЧЕМУ номер события, а не время. «Прочитано» — это `lastSeenEventId` в реестре: номер журнала
// растёт монотонно и переживает рестарт, а часы окна и демона могут разойтись. Непрочитано ровно то,
// у чего номер события внимания больше отметки «видел» (или сессию явно пометили непрочитанной ⌥⌘U).

import type { PultEvent } from '../core/events.js'

/**
 * done — ход закончился; failed — ход упал; ask — разрешение или вопрос; limit — лимит провайдера
 * исчерпан (настоящий, не предупреждение); blocked — страж сети или провайдер остановлен целиком;
 * stalled — сторож тишины: ход давно молчит (`turn.stalled`), «похоже, завис».
 */
export type AttentionKind = 'done' | 'failed' | 'ask' | 'limit' | 'blocked' | 'stalled'

export interface Attention {
  /** Номер события в общем журнале. */
  id: number
  kind: AttentionKind
  /** Время события (ISO). */
  at: string
  /** Короткая причина для карточки Inbox: текст ошибки, причина лимита или стража. */
  text?: string
  /**
   * Ход, на котором случилась ошибка (`turnId` из события). Есть — ошибку можно «Повторить»
   * (`agent.retry` ищет реплику именно этого хода); нет — ошибка вне хода (лимит аккаунта на простаивающей
   * сессии, фоновый ход, страж до хода) и повторять нечего.
   */
  turnId?: string
}

/** Предел причины в знаках: `agent.list` уходит окну одной строкой NDJSON, простыни ей не нужны. */
export const ATTENTION_TEXT_MAX = 300

/** Виды, которые значат «что-то сломалось»: карточка-ошибка в Inbox и значок на доке. */
export const ERROR_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>(['failed', 'limit', 'blocked', 'stalled'])

const KINDS: ReadonlySet<string> = new Set(['done', 'failed', 'ask', 'limit', 'blocked', 'stalled'])

const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function clip(text: string | undefined): { text?: string } {
  if (!text) return {}
  const one = text.replace(/\s+/g, ' ').trim()
  const chars = [...one]
  return { text: chars.length > ATTENTION_TEXT_MAX ? `${chars.slice(0, ATTENTION_TEXT_MAX - 1).join('')}…` : one }
}

/**
 * Событие → внимание или `null` (событие внимания не требует). Предупреждение о лимите
 * (`allowed_warning`) — не лимит: работать можно (src/sessions/status.ts, `warningOnly`).
 */
export function attentionOf(ev: PultEvent): Attention | null {
  const d = (ev.data ?? {}) as Record<string, unknown>
  const base = { id: ev.id, at: ev.ts }
  const turn = s(d['turnId'])
  const withTurn = turn ? { turnId: turn } : {}
  // Итог фонового хода (фоновые субагенты Claude доделали работу после ответа) или хода, начатого сервером Codex
  // (его разбудил субагент): «готово» или «упал», но без номера хода — реплики, которую можно повторить, у него нет.
  const background = d['reason'] === 'background_turn_done' || d['reason'] === 'server_turn_done'
  switch (ev.kind) {
    case 'status.changed': {
      if (d['rateLimitStatus'] === 'allowed_warning') return null
      // Возврат к статусу до вопроса, заданного вне хода (менеджер): о той ошибке или стопе уже сказали.
      if (d['reason'] === 'permission_outside_turn') return null
      // «Готово» — конец хода (`turnId` есть у idle после хода) или фонового хода. Без них idle пишут
      // остывание, конец фонового процесса и прочая служба — они человека не зовут.
      if (d['status'] === 'idle' && (turn || background)) return { ...base, kind: 'done' }
      if (d['status'] === 'failed') {
        // Страж сети пишет `net.blocked` с причиной и следом `failed {reason: net_blocked}`: второе
        // затёрло бы понятную причину («blocked_country») служебным словом.
        if (d['reason'] === 'net_blocked') return null
        return { ...base, kind: 'failed', ...clip(s(d['message']) ?? s(d['error']) ?? s(d['errorCode']) ?? s(d['reason'])), ...withTurn }
      }
      // `limited` без хода — эхо `limit.hit`, причину уже несёт он; с ходом — лимит оборвал именно этот ход.
      if (d['status'] === 'limited' && turn) return { ...base, kind: 'limit', ...clip(s(d['message']) ?? s(d['reason'])), ...withTurn }
      return null
    }
    case 'permission.requested':
    case 'question.asked':
      return { ...base, kind: 'ask', ...clip(s(d['toolName'])) }
    case 'limit.hit':
      if (d['status'] === 'allowed_warning') return null
      return { ...base, kind: 'limit', ...clip(s(d['message']) ?? s(d['reason']) ?? s(d['rateLimitType']) ?? s(d['status'])) }
    case 'net.blocked': {
      const why = s(d['message']) ?? s(d['reason'])
      const loc = s(d['loc'])
      return { ...base, kind: 'blocked', ...clip(why && loc ? `${why} (выход ${loc})` : why), ...withTurn }
    }
    case 'provider.blocked':
      return { ...base, kind: 'blocked', ...clip(s(d['text']) ?? s(d['reason'])) }
    case 'turn.stalled': {
      // Ход ещё идёт: «Повторить» тут не к месту (`isRetryable` молчит), а номер хода нужен «Прервать».
      const ms = typeof d['silentForMs'] === 'number' && Number.isFinite(d['silentForMs']) ? d['silentForMs'] : null
      return { ...base, kind: 'stalled', ...clip(ms !== null ? `ход молчит ${Math.max(1, Math.round(ms / 60_000))} мин` : undefined), ...withTurn }
    }
    default:
      return null
  }
}

/** Разбор чужого ответа (`agent.list` у окна и оболочки): кривое — нет внимания. */
export function parseAttention(x: unknown): Attention | null {
  if (x === null || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (typeof o['id'] !== 'number' || !Number.isSafeInteger(o['id']) || typeof o['kind'] !== 'string' || !KINDS.has(o['kind'])) return null
  return {
    id: o['id'],
    kind: o['kind'] as AttentionKind,
    at: typeof o['at'] === 'string' ? o['at'] : '',
    ...(typeof o['text'] === 'string' && o['text'] ? { text: o['text'] } : {}),
    ...(typeof o['turnId'] === 'string' && o['turnId'] ? { turnId: o['turnId'] } : {}),
  }
}

/**
 * Ошибку можно «Повторить»: она случилась в ходе (есть `turnId`). Занятость сессии проверяет вызывающий.
 * «Завис» — не повторяется: ход ещё идёт, у карточки свои кнопки «Прервать» и «Ждать».
 */
export function isRetryable(a: Attention | null | undefined): boolean {
  return isErrorKind(a) && !!a?.turnId && a?.kind !== 'stalled'
}

/** То, что нужно от строки `agent.list`, чтобы решить «непрочитано». */
export interface SeenFields {
  attention?: Attention | null | undefined
  lastSeenEventId?: number | undefined
  markedUnread?: boolean | undefined
}

/** Непрочитано: пометили руками (⌥⌘U) или событие внимания свежее отметки «видел». */
export function isUnread(rec: SeenFields): boolean {
  if (rec.markedUnread === true) return true
  const a = rec.attention
  return !!a && a.id > (rec.lastSeenEventId ?? 0)
}

/** Внимание — ошибка (ход упал, лимит, страж)? */
export function isErrorKind(a: Attention | null | undefined): boolean {
  return !!a && ERROR_KINDS.has(a.kind)
}

/** Ошибка, которую человек ещё не видел: карточка в Inbox, значок на доке, первая очередь ⌘⌥L. */
export function isUnreadError(rec: SeenFields): boolean {
  return isErrorKind(rec.attention) && isUnread(rec)
}

/**
 * Класс очереди «кто ждёт меня» (⌘⌥L): 0 — непрочитанная ошибка, 1 — ждёт разрешения или ответа,
 * 2 — прочее непрочитанное (готово, вопрос, на который уже ответили из Inbox), null — не ждёт.
 * Порядок классов — docs/14: ошибки, затем вопросы и разрешения, затем непрочитанные готовые.
 * `unread` — уже посчитанное `isUnread` (окно держит его в строке списка).
 */
export function waitClass(unread: boolean, attention: Attention | null | undefined, pending: number): 0 | 1 | 2 | null {
  if (unread && isErrorKind(attention)) return 0
  if (pending > 0) return 1
  if (unread) return 2
  return null
}

/**
 * Сколько сессий ждут человека — число на значке дока и в строке меню: разрешения и вопросы плюс
 * непрочитанные ошибки. Архивные не считаются: их убрали с глаз, и число не должно звать к ним.
 */
export function needsYouCount(
  list: ReadonlyArray<SeenFields & { name: string; archived?: boolean | undefined }>,
  pendingBySession: Readonly<Record<string, number>>,
): number {
  const archived = new Set(list.filter((r) => r.archived === true).map((r) => r.name))
  const names = new Set<string>()
  for (const r of list) if (!archived.has(r.name) && isUnreadError(r)) names.add(r.name)
  // Ждущий запрос считается и у архивной сессии: она работает и стоит, пока человек не ответит.
  // Архив прячет из счёта только «прочитать потом» — ошибки и непрочитанное (решение лида 14.10).
  for (const [name, n] of Object.entries(pendingBySession)) if (n > 0) names.add(name)
  return names.size
}

/**
 * Реплика, которую «Повторить» отправит заново (`agent.retry`), — ИМЕННО того хода, что упал, а не
 * просто последняя. События — файл сессии по порядку. Идём назад от события ошибки до ближайшего
 * `status.changed working` с тем же `turnId`: номера ходов (`t17`) повторяются после рестарта демона,
 * поэтому ближайший к ошибке и есть её ход. Реплика — ближайшая `message.user` перед ним. Граница —
 * `session.ended {reason: rm}`: до неё файл принадлежит удалённой сессии с тем же именем. После ошибки
 * не должно быть новой реплики — человек уже ответил иначе. Не вышло — `{reason}` по-русски.
 */
export function retryPrompt(events: readonly PultEvent[], att: Attention): { text: string } | { reason: string } {
  if (!isRetryable(att)) return { reason: 'ошибка случилась вне хода (лимит аккаунта, фоновый ход, страж до хода) — повторять нечего' }
  const at = events.findIndex((e) => e.id === att.id)
  if (at < 0) return { reason: 'событие ошибки не найдено в журнале сессии' }
  for (let i = at + 1; i < events.length; i++) {
    if ((events[i] as PultEvent).kind === 'message.user') return { reason: 'после ошибки уже была новая реплика' }
  }
  const removed = (e: PultEvent): boolean => e.kind === 'session.ended' && e.data?.['reason'] === 'rm'
  let working = -1
  for (let i = at; i >= 0; i--) {
    const e = events[i] as PultEvent
    if (removed(e)) break
    if (e.kind === 'status.changed' && e.data?.['status'] === 'working' && e.data?.['turnId'] === att.turnId) { working = i; break }
  }
  if (working < 0) return { reason: `начало хода ${att.turnId ?? ''} не найдено в журнале сессии` }
  for (let i = working - 1; i >= 0; i--) {
    const e = events[i] as PultEvent
    if (removed(e)) break
    const t = e.data?.['text']
    if (e.kind === 'message.user' && typeof t === 'string' && t.trim()) return { text: t }
  }
  return { reason: `реплика хода ${att.turnId ?? ''} не найдена в журнале сессии` }
}
