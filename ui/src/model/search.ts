import { t as tr } from '../lib/i18n.js'
// Поиск ⌘⇧F, метки реплик человека и переход к событию в ленте (О2, docs/14 «Поиск, метки, экспорт»).
// ЧИСТЫЕ функции: компоненты только рисуют и меряют DOM.

import type { ConvItem } from './conversation.js'
import type { UiState } from './state.js'

/** Строка ответа `events.search` (src/core/search.ts SearchHit). */
export interface SearchHit {
  sessionId: string
  eventId: number
  kind: string
  ts: string
  snippet: string
  match?: [number, number]
  /** Событие субагента: id его вызова (демон 0.2.24+). */
  parentId?: string
}

export interface SearchReply {
  results: SearchHit[]
  truncated: boolean
  superseded?: boolean
}

export interface SearchGroup {
  sessionId: string
  label: string
  hits: SearchHit[]
}

/**
 * Результаты по сессиям — в порядке самого нового совпадения сессии; внутри — новые первыми (так их
 * отдаёт демон). Сессии, которой окно не знает (удалили, пока шёл поиск), в выдаче нет.
 */
export function groupHits(hits: readonly SearchHit[], labelOf: (name: string) => string | null): SearchGroup[] {
  const groups = new Map<string, SearchGroup>()
  for (const h of hits) {
    let g = groups.get(h.sessionId)
    if (!g) {
      const label = labelOf(h.sessionId)
      if (label === null) continue
      g = { sessionId: h.sessionId, label, hits: [] }
      groups.set(h.sessionId, g)
    }
    g.hits.push(h)
  }
  return [...groups.values()]
}

/** Плоский порядок результатов — для ↑/↓ в списке. */
export function flatHits(groups: readonly SearchGroup[]): SearchHit[] {
  return groups.flatMap((g) => g.hits)
}

/** Значок и подпись вида события в выдаче. */
export function kindView(kind: string): { icon: string; label: string } {
  switch (kind) {
    case 'message.user': return { icon: 'you', label: tr('ты') }
    case 'message.done': return { icon: 'model', label: tr('ответ') }
    case 'tool.called': return { icon: 'tool', label: tr('инструмент') }
    default: return { icon: 'info', label: kind }
  }
}

/**
 * Отрывок с выделенным совпадением: [до, совпадение, после]. Границы демона (`match`) — если они
 * осмысленны; иначе ищем запрос без регистра сами (старый демон); не нашли — без выделения.
 */
export function splitSnippet(hit: Pick<SearchHit, 'snippet' | 'match'>, query: string): [string, string, string] {
  const s = hit.snippet
  const m = hit.match
  if (m && m[0] >= 0 && m[1] > m[0] && m[1] <= s.length) return [s.slice(0, m[0]), s.slice(m[0], m[1]), s.slice(m[1])]
  const q = query.replace(/\s+/g, ' ').trim()
  if (q) {
    const re = new RegExp(q.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'iu')
    const f = re.exec(s)
    if (f) return [s.slice(0, f.index), f[0], s.slice(f.index + f[0].length)]
  }
  return [s, '', '']
}

/** Все элементы ленты в порядке показа, с субагентами внутри. */
function flatItems(items: readonly ConvItem[]): ConvItem[] {
  const out: ConvItem[] = []
  const walk = (list: readonly ConvItem[]): void => {
    for (const it of list) {
      out.push(it)
      if (it.type === 'agent') walk(it.items)
    }
  }
  walk(items)
  return out
}

/** Блок субагента с этим id вызова — в любой глубине. */
function findAgent(items: readonly ConvItem[], toolUseId: string): ConvItem[] | null {
  for (const it of items) {
    if (it.type !== 'agent') continue
    if (it.toolUseId === toolUseId) return it.items
    const inner = findAgent(it.items, toolUseId)
    if (inner) return inner
  }
  return null
}

const latestUpTo = (list: readonly ConvItem[], eventId: number, ok: (it: ConvItem) => boolean = () => true): ConvItem | null => {
  let best: ConvItem | null = null
  for (const it of list) if (it.id <= eventId && ok(it) && (!best || it.id > best.id)) best = it
  return best
}

/**
 * Элемент ленты, в котором живёт событие: заведённый им самим (реплика, инструмент) или ближайший
 * раньше него (итог модели живёт в реплике, заведённой первой дельтой). Ищем в области события — корень
 * или блок субагента по `parentId`, — и итог модели (`message.done`) — среди реплик модели: иначе рядом
 * стоящая строка субагента перехватила бы переход. Область не нашлась — по всей ленте. `null` — ленты
 * до него нет.
 */
export function itemForEvent(items: readonly ConvItem[], eventId: number, hint: { kind?: string; parentId?: string } = {}): ConvItem | null {
  if (hint.kind !== undefined || hint.parentId !== undefined) {
    const scope = (hint.parentId !== undefined ? findAgent(items, hint.parentId) : null) ?? items
    const hit = (hint.kind === 'message.done' ? latestUpTo(scope, eventId, (it) => it.type === 'model') : null) ?? latestUpTo(scope, eventId)
    if (hit) return hit
  }
  return latestUpTo(flatItems(items), eventId)
}

/**
 * Что нужно, чтобы показать событие сессии: `hydrate` — лента ещё не собрана (её соберёт открытие
 * сессии); `wait` — история или ранняя страница в пути; `earlier` — событие раньше загруженного, нужна
 * ещё страница («Показать раньше»); `ready` — можно листать.
 */
export function jumpStep(s: UiState, name: string, eventId: number): 'hydrate' | 'wait' | 'earlier' | 'ready' {
  if (!s.lazy) return 'ready'
  const h = s.hydration[name]
  if (h === undefined) return 'hydrate'
  if (h === 'loading') return 'wait'
  const e = s.earlier[name]
  if (!e) return 'ready'
  if (e.loading) return 'wait'
  if (e.more && e.oldest !== null && eventId < e.oldest) return 'earlier'
  return 'ready'
}

/** Реплики человека в корне ленты — метки на полосе слева. */
export function userMarks(items: readonly ConvItem[]): Array<{ id: number; key: string; text: string; ts: string }> {
  return items.flatMap((it) => (it.type === 'user' ? [{ id: it.id, key: it.key, text: it.text, ts: it.ts }] : []))
}

/**
 * Соседняя реплика человека для ⌥↑/⌥↓: `tops` — верх каждой реплики в координатах прокрутки ленты,
 * `at` — верх видимой части. Вверх — ближайшая, что начинается выше видимого края; вниз — ниже его.
 * Полпикселя запаса: после перехода реплика стоит ровно у края и не должна находиться снова.
 */
export function adjacentUser(tops: ReadonlyArray<{ id: number; top: number }>, at: number, dir: -1 | 1): number | null {
  const slack = 4
  if (dir < 0) {
    for (let i = tops.length - 1; i >= 0; i--) if ((tops[i] as { top: number }).top < at - slack) return (tops[i] as { id: number }).id
    return null
  }
  for (const t of tops) if (t.top > at + slack) return t.id
  return null
}
