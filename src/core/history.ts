// «Лёгкая» история сессии для окна (0.2.19, `events.history`). ЧИСТЫЕ функции.
//
// ЗАЧЕМ: окно доигрывало весь журнал с нуля на каждом старте и переподключении — 18,6 МБ и
// 29 тыс. событий на 14.10.2026, +1,7 МБ в день; 08.10 оно уже не могло подключиться
// (`клиент не читает ответы — отсоединяем`, PR #34). Теперь ленту сессии окно берёт только
// когда её открывают, в лёгком виде и страницами. Замер на настоящем журнале: 15,5 МБ → 3,3 МБ по
// семи самым большим сессиям; самая большая — 4 МБ → 0,8 МБ. Состав журнала: выводы инструментов
// (`tool.finished`) — 61 %, вызовы — 14 %, дельты — 17 %.
//
// Что меняется (лента в окне выглядит так же — ui/test/hydrate.test.ts; сверено на 24 настоящих
// сессиях):
//   * дельты одной реплики склеиваются в одну — с номером и временем первой. Серия рвётся на ЛЮБОМ
//     не-дельта событии: смена статуса гасит идущие реплики во всех областях, а карточки и
//     уведомления окно кладёт в корень, какой бы ни был `parentId` (ревью M1). Рвать серию всегда
//     безопасно — окно само склеит соседние дельты; склеить лишнее — нет;
//   * серия, которую тут же закрывает `message.done` той же области с непустым текстом, несёт один
//     символ: окно заменит текст на итоговый, а реплика встанет на то же место (дельта заводит её
//     там, где серия началась). Без этого текст ехал дважды;
//   * пустые дельты выбрасываются: окно их и так пропускает;
//   * у `tool.finished` нет `content` — вывод виден только в раскрытой строке, окно догружает его
//     по `events.get` (флаг `elided`);
//   * строки входа инструмента — до TOOL_INPUT_CHARS (свёрнутой строке нужны путь и команда), флаг
//     `inputElided`; полный вход — тем же `events.get`;
//   * длинные строки остальных событий — до OTHER_CHARS. Реплики и запросы разрешений — целиком:
//     карточку ждущего разрешения из ленты человек читает перед ответом.
//
// Страницы (`pageHistory`): ответ демона окну — одна строка NDJSON, а клиент рвёт соединение на
// строке больше 1 МиБ (`MAX_LINE_BYTES`). История крупной сессии уже 0,8 МБ и растёт, поэтому
// отдаётся с конца кусками до HISTORY_PAGE_BYTES, по границе хода (`message.user`).

import type { PultEvent } from './events.js'
import type { EventStore } from './store.js'

export const TOOL_INPUT_CHARS = 300
export const OTHER_CHARS = 2000
/** Страница истории: вдвое ниже предела строки клиента (1 МиБ), с запасом на конверт ответа. */
export const HISTORY_PAGE_BYTES = 512 * 1024

const KEEP_WHOLE = new Set(['message.user', 'message.done', 'permission.requested', 'permission.resolved'])

function clip(v: unknown, limit: number, hit: { cut: boolean }): unknown {
  if (typeof v === 'string') {
    if (v.length <= limit) return v
    hit.cut = true
    return `${v.slice(0, limit)}…`
  }
  if (Array.isArray(v)) return v.map((x) => clip(x, limit, hit))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clip(x, limit, hit)
    return out
  }
  return v
}

/** Урезать длинные строки события (для `events.get`: защита от строки ответа больше 1 МиБ). */
export function clipEvent(ev: PultEvent, limit: number): PultEvent {
  return { ...ev, data: clip(ev.data ?? {}, limit, { cut: false }) as Record<string, unknown> }
}

/** Предел строки живого кадра подписки: ниже 1 МиБ клиента с запасом на конверт. */
export const LIVE_LINE_BYTES = 900 * 1024

/**
 * Страховочная сетка живой подписки (О3): событие, чья строка NDJSON вышла бы больше `maxBytes`, уходит с
 * урезанными строками (`clipEvent`), всё короче — пока не влезет. Журнал не трогается — полное событие
 * остаётся для `events.get`. Обычно сюда ничего не доходит: картинки заглушает маппер (core/blobs.ts).
 */
export function fitEvent(ev: PultEvent, maxBytes: number = LIVE_LINE_BYTES): PultEvent {
  if (Buffer.byteLength(JSON.stringify(ev)) <= maxBytes) return ev
  for (let limit = 20_000; limit >= 16; limit = Math.floor(limit / 4)) {
    const clipped = clipEvent(ev, limit)
    if (Buffer.byteLength(JSON.stringify(clipped)) <= maxBytes) return clipped
  }
  return { ...ev, data: { clipped: true } }
}

/**
 * Область события в ленте — как её найдёт свёртка окна: `parentId`, если это id уже заведённого
 * субагента, иначе корень (событие с неизвестным родителем окно кладёт в корень).
 */
function scopeOf(ev: PultEvent, agents: ReadonlySet<string>): string {
  return ev.parentId !== undefined && agents.has(ev.parentId) ? ev.parentId : ''
}

const itemIdOf = (d: Record<string, unknown>): string | undefined => (typeof d['itemId'] === 'string' ? d['itemId'] : undefined)
/** То же правило совпадения, что у окна: itemId нет с любой стороны — та же реплика. */
const sameItem = (a: string | undefined, b: string | undefined): boolean => a === undefined || b === undefined || a === b

export function compactHistory(events: readonly PultEvent[]): PultEvent[] {
  const out: PultEvent[] = []
  const agents = new Set<string>()
  /** Открытая серия дельт по области: индекс склеенной дельты в `out` и её itemId. */
  const open = new Map<string, { at: number; itemId: string | undefined }>()

  for (const ev of events) {
    const scope = scopeOf(ev, agents)
    const d = ev.data ?? {}

    if (ev.kind === 'message.delta') {
      const text = typeof d['text'] === 'string' ? d['text'] : ''
      if (!text) continue
      const itemId = itemIdOf(d)
      const run = open.get(scope)
      if (run && sameItem(itemId, run.itemId)) {
        const head = out[run.at] as PultEvent
        head.data = { ...head.data, text: `${String(head.data['text'] ?? '')}${text}` }
        continue
      }
      out.push({ ...ev, data: { ...d } })
      open.set(scope, { at: out.length - 1, itemId })
      continue
    }

    // Итог реплики сразу за её серией: окно возьмёт его текст — серии хватит одного символа.
    if (ev.kind === 'message.done' && typeof d['text'] === 'string' && d['text'].trim()) {
      const run = open.get(scope)
      if (run && sameItem(itemIdOf(d), run.itemId)) {
        const head = out[run.at] as PultEvent
        head.data = { ...head.data, text: String(head.data['text'] ?? '').slice(0, 1) }
      }
    }
    open.clear()
    if (ev.kind === 'agent.spawned' && typeof d['toolUseId'] === 'string') agents.add(d['toolUseId'])

    if (KEEP_WHOLE.has(ev.kind)) {
      out.push(ev)
    } else if (ev.kind === 'tool.finished') {
      const rest: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(d)) if (k !== 'content') rest[k] = v
      out.push({ ...ev, data: { ...(clip(rest, OTHER_CHARS, { cut: false }) as Record<string, unknown>), ...('content' in d ? { elided: true } : {}) } })
    } else if (ev.kind === 'tool.called') {
      const hit = { cut: false }
      const input = clip(d['input'], TOOL_INPUT_CHARS, hit)
      const rest = clip(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'input')), OTHER_CHARS, { cut: false }) as Record<string, unknown>
      out.push({ ...ev, data: { ...rest, ...(d['input'] !== undefined ? { input } : {}), ...(hit.cut ? { inputElided: true } : {}) } })
    } else {
      out.push({ ...ev, data: clip(d, OTHER_CHARS, { cut: false }) as Record<string, unknown> })
    }
  }
  return out
}

export interface HistoryPage {
  events: PultEvent[]
  /** Есть события раньше этой страницы. */
  more: boolean
  /** Номер первого события страницы: `before` следующего запроса. null — страница пуста. */
  oldest: number | null
}

/**
 * Страница лёгкой истории: события с номером меньше `before` (null — с конца), не больше `budget`
 * байт, по возможности с начала хода — чтобы ход не делился между страницами, и предыдущая
 * страница вставала в ленту целиком перед этой. Хотя бы одно событие — всегда.
 */
export function pageHistory(all: readonly PultEvent[], before: number | null, budget: number = HISTORY_PAGE_BYTES): HistoryPage {
  let upto = all.length
  if (before !== null) {
    upto = 0
    while (upto < all.length && (all[upto] as PultEvent).id < before) upto++
  }
  let start = upto
  let bytes = 0
  for (let i = upto - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(all[i])) + 1
    if (bytes + size > budget && start < upto) break
    bytes += size
    start = i
  }
  if (start > 0) {
    // Не дошли до начала — режем по первому ходу внутри взятого: его начало уйдёт в прошлую страницу.
    for (let i = start; i < upto; i++) {
      if ((all[i] as PultEvent).kind === 'message.user') {
        if (i > start) start = i
        break
      }
    }
  }
  const events = all.slice(start, upto)
  return { events, more: start > 0, oldest: events[0]?.id ?? null }
}

/** Первая страница из конца файла или null, если для неё нужен полный журнал. */
export function readLatestHistoryPage(store: Pick<EventStore, 'readSessionTail'>, sessionId: string, budget: number): HistoryPage | null {
  // Сырые события содержат дельты и полные выводы, поэтому берём с запасом к бюджету ответа.
  const tail = store.readSessionTail(sessionId, 4 * HISTORY_PAGE_BYTES)
  if (!tail) return null
  if (!tail.hasPrefix) return pageHistory(compactHistory(tail.events), null, budget)

  const start = tail.events.findIndex((ev) => ev.kind === 'message.user')
  if (start < 0) return null
  const events = tail.events.slice(start)
  const agents = new Set<string>()
  // Граница хода закрывает серии дельт. Субагент, запущенный до границы, всё ещё может
  // присылать дельты. Для такого хвоста нужен полный журнал, чтобы сохранить их область.
  for (const ev of events) {
    if (ev.kind === 'agent.spawned' && typeof ev.data['toolUseId'] === 'string') agents.add(ev.data['toolUseId'])
    if ((ev.kind === 'message.delta' || ev.kind === 'message.done') && ev.parentId !== undefined && !agents.has(ev.parentId)) return null
  }
  const page = pageHistory(compactHistory(events), null, budget)
  // Если страница забрала весь хвост, она могла бы вместить ещё более ранние события.
  return page.more ? page : null
}
