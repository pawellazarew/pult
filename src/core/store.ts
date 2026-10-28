// Журнал событий. Append-only JSONL.
//
// ПОЧЕМУ два файла на одно событие. План требует и файл на сессию (`events/<session>.jsonl`),
// и СКВОЗНОЙ монотонный курсор, который переживает рестарт демона и по которому подписка
// доигрывает пропущенное. Порядок между сессиями по отдельным файлам не восстановить —
// поэтому порядок хранит один общий журнал `events/journal.jsonl`, а файл сессии остаётся
// удобным срезом для человека и для будущего `agent read`.
// Номер после рестарта берём из ПОСЛЕДНЕЙ строки общего журнала: ни отдельного счётчика,
// ни файла со счётчиком, который может разойтись с данными.
//
// ТРИ ПРАВИЛА, КУПЛЕННЫЕ РЕВЬЮ В1:
//   1. Оборванный хвост (демона убили посреди writeSync) ОБРЕЗАЕТСЯ при открытии. Иначе
//      следующая запись прилипает к огрызку, склеенная строка не разбирается никогда, и
//      курсор навсегда расходится с тем, что реально можно прочитать.
//   2. Номер события растёт ТОЛЬКО после успешной записи в общий журнал. Иначе после ENOSPC
//      демон раздаёт подписчикам номера, которых нет на диске, и после рестарта выдаёт их
//      заново.
//   3. Разбор чужого файла не верит ничему: строка `null` — валидный JSON, и `ev.id` на нём
//      роняет и чтение, и доигрывание.
//
// ДОЛГ В1, ЗАКРЫТЫЙ В В2: `readFrom` читал ВЕСЬ журнал на каждую подписку и на каждый
// `events.tail`. При десятках тысяч событий каждый новый клиент заставлял демона разобрать
// мегабайты ради трёх последних строк. Теперь при открытии строится индекс `id → смещение в
// байтах`, он же дополняется на каждой записи, а чтение начинается с найденного смещения.
// Формат файла на диске НЕ изменился: индекс живёт только в памяти и восстанавливается
// одним проходом при старте демона.
//
// ИЗВЕСТНЫЙ ПРЕДЕЛ ИНДЕКСА (осознанный, не забытый). Он растёт на одну пару `id → смещение`
// на КАЖДОЕ событие за всю жизнь процесса и ничем не подрезается: это два числа в двух
// массивах, десятки байт на событие. Личный демон на десятки тысяч событий в сутки стоит
// считанные мегабайты — для Ф1 это приемлемо. Подрезать индекс в отрыве от ротации самого
// журнала бессмысленно: выкинутые смещения пришлось бы искать заново тем же проходом по
// файлу. Поэтому компактизация появится вместе с ротацией журнала, а не раньше.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, truncateSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { EventDraft, PultEvent } from './events.js'
import type { PultPaths } from './paths.js'
import { attentionOf } from '../sessions/attention.js'
import type { Attention } from '../sessions/attention.js'

export interface StoreStats {
  /** Сколько байт журнала прочитано после открытия. Тест на 50к событий смотрит сюда. */
  bytesRead: number
  reads: number
  /** Сколько записей в индексе `id → смещение`. */
  indexed: number
}

export interface EventStore {
  readonly lastId: number
  append(draft: EventDraft): PultEvent
  /** События строго после `cursor`, при необходимости отфильтрованные по сессии. */
  readFrom(cursor: number, opts?: { sessionId?: string; limit?: number }): PultEvent[]
  /** Снимок для окна на старте (0.2.19): последние события SNAPSHOT_KINDS по сессиям и время активности. */
  snapshot(): StoreSnapshot
  /** Все события одной сессии из её файла `events/<session>.jsonl` — без прохода по общему журналу. */
  readSession(sessionId: string): PultEvent[]
  /** События по номерам (не больше GET_LIMIT), через индекс смещений. Неизвестные номера пропускаются. */
  readIds(ids: readonly number[]): PultEvent[]
  /**
   * Последнее событие «внимания» сессии (О2: готово, ошибка, вопрос, лимит, страж) — `null`, если не
   * было. Копится тем же проходом, что снимок, и на каждой записи (src/sessions/attention.ts).
   */
  attention(sessionId: string): Attention | null
  stats(): StoreStats
  close(): void
}

/**
 * Виды событий, последнее из которых по каждой сессии окну нужно на старте, чтобы не доигрывать
 * журнал целиком (0.2.19): фон процесса, контекстное окно, лимиты провайдера, отказы стража и
 * перезапуск демона (он гасит фон и карточки прошлого запуска). Статусы — из реестра (`agent.list`),
 * разрешения — из `perm.list`, ленты — по требованию (`events.history`).
 */
export const SNAPSHOT_KINDS: ReadonlySet<string> = new Set([
  'daemon.started', 'background.changed', 'context.updated', 'usage.updated', 'limit.hit', 'net.blocked',
])

export const GET_LIMIT = 200

export interface StoreSnapshot {
  events: PultEvent[]
  /** Время последнего события сессии, кроме дельт и замеров контекста (как «последняя активность» окна). */
  activity: Record<string, string>
  cursor: number
}

export class StoreWriteError extends Error {
  readonly code = 'journal_write_failed'
  constructor(message: string) {
    super(message)
    this.name = 'StoreWriteError'
  }
}

/** Имя файла сессии: буквы, цифры, точка, дефис, подчёркивание; начинается НЕ с подчёркивания. */
const SAFE_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * `journal` — имя общего журнала. Сессия с таким id открыла бы journal.jsonl вторым
 * дескриптором и записала каждое своё событие дважды одним и тем же номером.
 * Подчёркивание в начале зарезервировано под служебные имена, поэтому `_journal` и `_other`
 * снаружи прийти не могут и столкнуться с ними не с чем.
 */
const RESERVED_SESSION_NAMES = new Set(['journal'])

/** Имя файла сессии не должно уметь ни выйти из каталога, ни попасть в общий журнал. */
export function sessionFileName(sessionId: string): string {
  if (!SAFE_SESSION_RE.test(sessionId)) return '_other.jsonl'
  if (RESERVED_SESSION_NAMES.has(sessionId)) return `_${sessionId}.jsonl`
  return `${sessionId}.jsonl`
}

/** Запись журнала, которой можно верить. Всё остальное — мусор от чужой руки или от обрыва. */
function asEvent(x: unknown): PultEvent | null {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return null
  const ev = x as Partial<PultEvent>
  if (typeof ev.id !== 'number' || !Number.isSafeInteger(ev.id) || ev.id <= 0) return null
  if (typeof ev.sessionId !== 'string') return null
  return x as PultEvent
}

function parseEventLine(line: string): PultEvent | null {
  try {
    return asEvent(JSON.parse(line))
  } catch {
    return null
  }
}

/**
 * Обрезает недописанную последнюю строку. Возвращает число выброшенных байт.
 * Полную строку это не тронет никогда: наш писатель всегда заканчивает записью `\n`.
 */
export function repairTail(file: string): number {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return 0
  }
  if (size === 0) return 0
  let buf: Buffer
  try {
    buf = readFileSync(file)
  } catch {
    return 0
  }
  if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return 0
  const cut = buf.lastIndexOf(0x0a) + 1
  try {
    truncateSync(file, cut)
  } catch {
    return 0
  }
  return buf.length - cut
}

/**
 * Индекс `id → смещение первой байты строки`. Строится ОДНИМ проходом при открытии и
 * дополняется на каждой записи. Хранится как две параллельные корзины, а не как Map:
 * поиск идёт по «первому id строго больше курсора», а это двоичный поиск по массиву.
 */
export interface JournalIndex {
  ids: number[]
  offsets: number[]
  /** Размер файла в байтах на момент последнего обновления индекса. */
  size: number
}

/** Смещение первой строки с `id > cursor`; `size`, если такой строки нет. */
export function offsetAfter(index: JournalIndex, cursor: number): number {
  const { ids, offsets } = index
  if (ids.length === 0) return index.size
  if (cursor < (ids[0] as number)) return offsets[0] as number
  // Двоичный поиск: первая позиция, где id > cursor.
  let lo = 0
  let hi = ids.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((ids[mid] as number) > cursor) hi = mid
    else lo = mid + 1
  }
  return lo < ids.length ? (offsets[lo] as number) : index.size
}

/** Позиция номера `id` в индексе или -1. */
export function positionOf(index: JournalIndex, id: number): number {
  let lo = 0
  let hi = index.ids.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = index.ids[mid] as number
    if (v === id) return mid
    if (v < id) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

function buildIndex(file: string, onEvent?: (ev: PultEvent) => void): { index: JournalIndex; lastId: number; bytes: number } {
  const index: JournalIndex = { ids: [], offsets: [], size: 0 }
  if (!existsSync(file)) return { index, lastId: 0, bytes: 0 }
  let buf: Buffer
  try {
    buf = readFileSync(file)
  } catch {
    return { index, lastId: 0, bytes: 0 }
  }
  index.size = buf.length
  let lastId = 0
  let start = 0
  while (start < buf.length) {
    let nl = buf.indexOf(0x0a, start)
    if (nl === -1) nl = buf.length
    if (nl > start) {
      const ev = parseEventLine(buf.toString('utf8', start, nl))
      // Строки вне порядка (чужая рука, склейка) в индекс не берём: двоичный поиск по
      // неотсортированному массиву врал бы молча.
      if (ev && ev.id > lastId) {
        index.ids.push(ev.id)
        index.offsets.push(start)
        lastId = ev.id
        onEvent?.(ev)
      }
    }
    start = nl + 1
  }
  return { index, lastId, bytes: buf.length }
}

/** writeSync имеет право записать меньше, чем просили: дописываем, пока буфер не кончится. */
function writeAllSync(fd: number, buf: Buffer): void {
  let off = 0
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off)
    if (!(n > 0)) throw new StoreWriteError(`запись в журнал вернула ${n} байт из ${buf.length - off}`)
    off += n
  }
}

export interface StoreDeps {
  /** Точка инъекции для теста на отказ диска. */
  writeAll?: (fd: number, buf: Buffer) => void
}

export function createStore(paths: PultPaths, deps: StoreDeps = {}): EventStore {
  const writeAll = deps.writeAll ?? writeAllSync
  // Снимок для окна копится в том же проходе, что и индекс: строки и так разбираются целиком.
  const latest = new Map<string, Map<string, PultEvent>>()
  const activity = new Map<string, string>()
  // Внимание (О2) — там же: «непрочитано» в `agent.list` иначе требовало бы прохода по журналу на
  // каждый вызов, а окно зовёт список раз в 4 с.
  const attention = new Map<string, Attention>()
  const note = (ev: PultEvent): void => {
    // Сессия удалена: имя свободно, и новая сессия с тем же именем не должна унаследовать фон,
    // контекст, активность и непрочитанное прежней (полное доигрывание окна сбрасывало их тем же событием).
    if (ev.kind === 'session.ended' && ev.data?.['reason'] === 'rm') {
      latest.delete(ev.sessionId)
      activity.delete(ev.sessionId)
      attention.delete(ev.sessionId)
      return
    }
    // Реплика человека — ответ на всё, что было до неё: старая ошибка не должна держать значок на доке,
    // карточку в Inbox и «Повторить» после того, как человек уже сказал что-то новое.
    if (ev.kind === 'message.user') attention.delete(ev.sessionId)
    // «Похоже, завис» живёт, пока идёт его ход: ход кончился (как угодно) — карточка и значок гаснут.
    if (ev.kind === 'status.changed' && attention.get(ev.sessionId)?.kind === 'stalled'
      && ['idle', 'failed', 'interrupted', 'limited', 'done', 'cold'].includes(String(ev.data?.['status']))) {
      attention.delete(ev.sessionId)
    }
    const att = attentionOf(ev)
    if (att) attention.set(ev.sessionId, att)
    if (SNAPSHOT_KINDS.has(ev.kind)) {
      let byKind = latest.get(ev.sessionId)
      if (!byKind) { byKind = new Map(); latest.set(ev.sessionId, byKind) }
      byKind.set(ev.kind, ev)
    }
    if (ev.kind !== 'message.delta' && ev.kind !== 'context.updated') activity.set(ev.sessionId, ev.ts)
  }
  // Сначала чиним хвост, и только потом строим индекс: иначе номер берётся из огрызка.
  repairTail(paths.journal)
  const built = buildIndex(paths.journal, note)
  const index = built.index
  let nextId = built.lastId + 1
  const journalFd = openSync(paths.journal, 'a', 0o600)
  const sessionFds = new Map<string, number>()
  let broken: string | null = null
  // Счётчики намеренно НЕ включают проход при открытии: тест меряет цену подписки, а не старта.
  let bytesRead = 0
  let reads = 0
  let readFd: number | null = null

  const openRead = (): number | null => {
    if (readFd !== null) return readFd
    try { readFd = openSync(paths.journal, 'r') } catch { readFd = null }
    return readFd
  }

  const sessionFd = (sessionId: string): number | null => {
    const name = sessionFileName(sessionId)
    const cached = sessionFds.get(name)
    if (cached !== undefined) return cached
    try {
      const file = join(paths.events, name)
      repairTail(file)
      const fd = openSync(file, 'a', 0o600)
      sessionFds.set(name, fd)
      return fd
    } catch {
      return null
    }
  }

  return {
    get lastId(): number {
      return nextId - 1
    },

    append(draft: EventDraft): PultEvent {
      if (broken !== null) throw new StoreWriteError(`журнал сломан и больше не пишется: ${broken}`)
      const ev: PultEvent = {
        id: nextId,
        ts: draft.ts ?? new Date().toISOString(),
        sessionId: draft.sessionId,
        ...(draft.parentId !== undefined ? { parentId: draft.parentId } : {}),
        provider: draft.provider,
        kind: draft.kind,
        data: draft.data ?? {},
      }
      const line = Buffer.from(JSON.stringify(ev) + '\n', 'utf8')
      // Синхронная запись намеренно: порядок строк в журнале — это и есть порядок курсора,
      // асинхронная очередь его бы перемешала.
      try {
        writeAll(journalFd, line)
      } catch (e) {
        // Номер НЕ израсходован: событие не существует ни для подписчиков, ни для курсора.
        broken = (e as Error).message
        throw e instanceof StoreWriteError ? e : new StoreWriteError((e as Error).message)
      }
      nextId = ev.id + 1
      // Индекс дополняется РОВНО тем смещением, по которому строка легла: конец файла до
      // записи. Пересчитывать его чтением файла нельзя — это вернуло бы ту самую цену.
      index.ids.push(ev.id)
      index.offsets.push(index.size)
      index.size += line.length
      // Файл сессии — срез для человека, курсор от него не зависит: его отказ не отменяет
      // уже записанное в общий журнал событие.
      const fd = sessionFd(ev.sessionId)
      if (fd !== null) { try { writeAll(fd, line) } catch { /* срез потерял строку */ } }
      note(ev)
      return ev
    },

    snapshot(): StoreSnapshot {
      const events: PultEvent[] = []
      for (const byKind of latest.values()) events.push(...byKind.values())
      events.sort((a, b) => a.id - b.id)
      return { events, activity: Object.fromEntries(activity), cursor: nextId - 1 }
    },

    attention(sessionId: string): Attention | null {
      const a = attention.get(sessionId)
      return a ? { ...a } : null
    },

    readSession(sessionId: string): PultEvent[] {
      // Файл сессии — срез, который пишется ПОСЛЕ общего журнала в том же синхронном append:
      // всё, что в нём есть, уже имеет номер. Чужие строки (`_other.jsonl` общий для «опасных»
      // имён) отсеиваются по sessionId.
      let buf: string
      try {
        buf = readFileSync(join(paths.events, sessionFileName(sessionId)), 'utf8')
      } catch {
        return []
      }
      reads += 1
      bytesRead += Buffer.byteLength(buf)
      const out: PultEvent[] = []
      let last = 0
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue
        const ev = parseEventLine(line)
        // Порядок — строго по номеру: склейка и чужая рука не должны перемешать ленту.
        if (!ev || ev.sessionId !== sessionId || ev.id <= last) continue
        out.push(ev)
        last = ev.id
      }
      return out
    },

    readIds(ids: readonly number[]): PultEvent[] {
      const fd = openRead()
      if (fd === null) return []
      const out: PultEvent[] = []
      for (const id of ids.slice(0, GET_LIMIT)) {
        const pos = positionOf(index, id)
        if (pos < 0) continue
        const from = index.offsets[pos] as number
        const to = pos + 1 < index.offsets.length ? (index.offsets[pos + 1] as number) : index.size
        const buf = Buffer.allocUnsafe(to - from)
        let got: number
        try { got = readSync(fd, buf, 0, to - from, from) } catch { continue }
        reads += 1
        bytesRead += got
        // До первого перевода строки: между индексированными строками может лежать мусор
        // (склейка, чужая рука), и разбор куска целиком молча терял бы событие.
        const text = buf.toString('utf8', 0, got)
        const nl = text.indexOf('\n')
        const ev = parseEventLine(nl === -1 ? text : text.slice(0, nl))
        if (ev && ev.id === id) out.push(ev)
      }
      return out
    },

    readFrom(cursor: number, opts: { sessionId?: string; limit?: number } = {}): PultEvent[] {
      const from = offsetAfter(index, cursor)
      const length = index.size - from
      if (length <= 0) return []
      const fd = openRead()
      if (fd === null) return []
      const buf = Buffer.allocUnsafe(length)
      let got = 0
      try {
        // `readSync` обычного файла почти всегда читает всё, но «почти» — не гарантия: короткое
        // чтение молча отдавало бы ОБРЕЗАННЫЙ хвост журнала. Дочитываем до конца диапазона.
        while (got < length) {
          const n = readSync(fd, buf, got, length - got, from + got)
          if (!(n > 0)) break
          got += n
        }
      } catch {
        return []
      }
      reads += 1
      bytesRead += got
      const out: PultEvent[] = []
      for (const line of buf.toString('utf8', 0, got).split('\n')) {
        if (!line.trim()) continue
        const ev = parseEventLine(line)
        if (!ev || ev.id <= cursor) continue
        if (opts.sessionId !== undefined && ev.sessionId !== opts.sessionId) continue
        out.push(ev)
        if (opts.limit !== undefined && out.length >= opts.limit) break
      }
      return out
    },

    stats(): StoreStats {
      return { bytesRead, reads, indexed: index.ids.length }
    },

    close(): void {
      try { closeSync(journalFd) } catch { /* уже закрыт */ }
      if (readFd !== null) { try { closeSync(readFd) } catch { /* уже закрыт */ } readFd = null }
      for (const fd of sessionFds.values()) { try { closeSync(fd) } catch { /* уже закрыт */ } }
      sessionFds.clear()
    },
  }
}
