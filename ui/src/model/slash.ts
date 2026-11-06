// «/» в поле ввода (docs/19): где в тексте стоит набираемая команда, какие строки каталога ей подходят и что
// получится после выбора. Чистые функции — их проверяет ui/test без окна.

export type SlashSource = 'skill' | 'command' | 'plugin' | 'builtin'

/** Строка каталога — ответ демона `agent.commands` (src/commands/catalog.ts `SlashCommand`). */
export interface SlashItem {
  name: string
  description: string
  argumentHint?: string
  source: SlashSource
  provider: string
  /** Что вставить: `/name ` у Claude, `$name ` у Codex. */
  insert: string
}

export interface SlashListing {
  provider: string
  cwd: string
  commands: SlashItem[]
  at: number
  error?: string
}

/** Набираемая команда: `/` с `start` по каретку `end`; `query` — что после `/`. */
export interface SlashToken {
  start: number
  end: number
  query: string
  /** `start` — `/` в начале поля (видны все команды); `inline` — после пробела посреди текста (только скиллы). */
  position: 'start' | 'inline'
}

/** Знаки, которые обрывают имя команды: пробелы, кавычки, второй `/`, `$`. */
const STOP = /[\s/"'`$]/u

/**
 * `/` в начале поля или после пробела, от него до каретки — без пробела и кавычек. Иначе `null`: `a/b`, путь
 * `/Users/x`, уже набранный `/name ` с пробелом за ним. Выделение (а не каретка) — тоже `null`.
 */
export function findSlashToken(text: string, caret: number, selectionEnd: number = caret): SlashToken | null {
  if (caret !== selectionEnd) return null
  const end = Math.max(0, Math.min(caret, text.length))
  const head = text.slice(0, end)
  const start = head.lastIndexOf('/')
  if (start < 0) return null
  const before = start > 0 ? head[start - 1] ?? '' : ''
  if (before && !/\s/u.test(before)) return null
  const query = head.slice(start + 1)
  if (STOP.test(query) || query.length > 120) return null
  // Каретка внутри слова: `/fo|o` — тоже команда, но `end` тянется до конца слова, чтобы выбор заменил его целиком.
  let tail = end
  while (tail < text.length && !/\s/u.test(text[tail] ?? '')) tail++
  if (/[/"'`$]/u.test(text.slice(end, tail))) return null
  return { start, end: tail, query, position: text.slice(0, start).trim() === '' ? 'start' : 'inline' }
}

/** Ступени совпадения: меньше — выше в списке. */
const Tier = { Exact: 0, Prefix: 1, SegmentPrefix: 2, Substring: 3, Subsequence: 4, DescriptionWord: 5, Description: 6 } as const

function subsequence(q: string, s: string): boolean {
  let i = 0
  for (const ch of s) if (ch === q[i]) i++
  return i === q.length
}

/** Ступень совпадения строки с запросом (`null` — не подходит). Регистр не важен. */
export function matchTier(item: Pick<SlashItem, 'name' | 'description'>, query: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return Tier.Exact
  const name = item.name.toLowerCase()
  if (name === q) return Tier.Exact
  if (name.startsWith(q)) return Tier.Prefix
  if (name.split(/[:\-_.]/u).some((part, i) => i > 0 && part.startsWith(q))) return Tier.SegmentPrefix
  if (name.includes(q)) return Tier.Substring
  if (q.length >= 2 && subsequence(q, name)) return Tier.Subsequence
  const description = item.description.toLowerCase()
  if (q.length >= 2 && description.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q))) return Tier.DescriptionWord
  if (q.length >= 3 && description.includes(q)) return Tier.Description
  return null
}

/** Отбор и порядок: ступень совпадения, при равной — порядок провайдера. В середине текста — только скиллы. */
export function rankSlash(items: readonly SlashItem[], query: string, position: SlashToken['position'] = 'start'): SlashItem[] {
  const pool = position === 'inline' ? items.filter((it) => it.source === 'skill' || it.source === 'plugin') : items
  return pool
    .map((item, index) => ({ item, index, tier: matchTier(item, query) }))
    .filter((x): x is { item: SlashItem; index: number; tier: number } => x.tier !== null)
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((x) => x.item)
}

/** Подставить выбранную команду вместо набранной: `insert` уже с пробелом; второго пробела перед текстом не будет. */
export function applySlash(text: string, token: SlashToken, insert: string): { text: string; caret: number } {
  const after = text.slice(token.end)
  const ins = /^\s/u.test(after) ? insert.trimEnd() : insert
  const head = text.slice(0, token.start) + ins
  return { text: head + after, caret: head.length + (ins === insert ? 0 : 1) }
}
