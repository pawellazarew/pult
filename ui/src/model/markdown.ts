// Маленький разбор Markdown (подмножество GFM) для реплик модели и человека (M8e). Блоки: код, заголовки h1–h6,
// черта, таблицы, списки с вложенностью и задачами, цитаты, абзацы. Внутри строки — дерево:
// `код`, **жирный**, *курсив*, ~~зачёркнутый~~, ссылки [текст](адрес), <автоссылки> и голые
// http(s)://. Выход — дерево, компонент рисует его элементами React (никакого innerHTML: текст
// модели — чужой текст). Чистые функции, без зависимостей.
//
// Изображения читает локальный мост оболочки, без сети. Чего нарочно нет: сырого HTML (кроме <br> — модели ставят
// его в ячейки таблиц), ссылок-сносок [x][ref], кода отступом в 4 пробела. Текст идёт дельтами,
// поэтому всё недописанное (таблица без строки-разделителя, `[текст](адр`) остаётся текстом, а
// незакрытый блок кода — блоком кода.
//
// Переводы строк внутри абзаца сохраняются (`\n` в тексте + `white-space: pre-wrap` в стилях) — как GFM
// с `breaks: true`.
//
// Реплика человека (`human`, M8e) — «лёгкий» Markdown: только блоки кода ```…```, а в остальном тексте —
// ссылки, `код`, жирный и курсив. Ни заголовков, ни списков, ни цитат, ни черт, ни таблиц, и строки не
// обрезаются: человек вставляет код, diff и логи — `# комментарий`, `- строка`/`+ строка` и отступы должны
// остаться как набраны.

import { fileCitation } from './fileReferences.js'

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  /** `href` — только http(s) и mailto; иная схема или относительный адрес — `null`: рисуется текстом. */
  | { t: 'link'; href: string | null; url: string; title?: string; c: Inline[] }
  | { t: 'image'; url: string; alt: string }
  | { t: 'file'; path: string }
  | { t: 'br' }

export type Align = 'left' | 'center' | 'right' | null

export interface ListItem {
  /** Пункт-задача `- [ ]` / `- [x]`; у обычного пункта поля нет. */
  task?: { checked: boolean }
  c: Block[]
}

export type Block =
  | { t: 'code'; lang: string; v: string }
  | { t: 'h'; level: 1 | 2 | 3 | 4 | 5 | 6; v: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }
  | { t: 'p'; v: Inline[] }

// --- адреса -------------------------------------------------------------------------------

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/**
 * Адрес, который можно сделать живой ссылкой, — или `null`. Только http(s) с хостом и mailto,
 * без логина-пароля в адресе (`https://bank.example.com@evil.example.org` ведёт не на bank.example.com). Та же проверка
 * стоит в оболочке (shell/src/externalUrl.ts) — здесь она решает, рисовать ли ссылку вовсе.
 */
export function safeHref(raw: string): string | null {
  const s = raw.trim()
  if (!s || s.length > 2048 || s.includes('\0')) return null
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (!SAFE_SCHEMES.has(u.protocol)) return null
  if (u.protocol === 'mailto:') return u.pathname ? u.href : null
  if (!u.hostname || u.username || u.password) return null
  return u.href
}

// --- внутри строки ------------------------------------------------------------------------

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch)
const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)

interface Opts {
  /** Внутри текста ссылки ссылок не бывает: `[см. https://a](https://b)` — одна ссылка. */
  noLinks: boolean
}

/** Длина серии одинаковых символов с позиции `i`. */
function runLen(s: string, i: number): number {
  let j = i
  while (s[j] === s[i]) j++
  return j - i
}

/** Конец `кода` (позиция за закрывающей серией) или -1: закрывает серия обратных кавычек той же длины. */
function codeEnd(s: string, i: number): number {
  const n = runLen(s, i)
  let j = i + n
  while (j < s.length) {
    if (s[j] === '`') {
      const m = runLen(s, j)
      if (m === n) return j + m
      j += m
    } else j++
  }
  return -1
}

/**
 * За серией `_` продолжается слово: буква/цифра или точка перед буквой. `__init__.py` и `my_file_.ts` —
 * имена файлов, а не выделение (CommonMark сделал бы из первого жирное `init`: точка — пунктуация).
 */
const wordGoesOn = (s: string, k: number): boolean => isWord(s[k]) || (s[k] === '.' && isWord(s[k + 1]))

/**
 * Где закрывается выделение `delim` (`*`, `_`, `**`, `__`, `~~`), начатое до `from`, или -1.
 * Закрывающий стоит после не-пробела; `_` не закрывает посреди слова (snake_case, `__init__.py`).
 * Серия `***` закрывает своими последними символами: `***x***` — жирный курсив, а не обрывки звёзд.
 */
function findCloser(s: string, from: number, delim: string): number {
  const ch = delim[0] as string
  let j = from
  while (j < s.length) {
    const c = s[j]
    if (c === '\\') { j += 2; continue }
    if (c === '`') { const e = codeEnd(s, j); j = e < 0 ? j + runLen(s, j) : e; continue }
    if (c !== ch) { j++; continue }
    const r = runLen(s, j)
    const at = j + r - delim.length
    const fits = ch === '~' ? r === 2 : delim.length === 1 ? r === 1 || r === 3 : r >= 2
    if (fits && at > from && !isSpace(s[at - 1]) && (ch !== '_' || !wordGoesOn(s, j + r))) return at
    j += r
  }
  return -1
}

/** Ссылка `[текст](адрес "заголовок")` с позиции `[`: границы частей или null. */
function scanLink(s: string, i: number): { text: string; url: string; title?: string; end: number } | null {
  let depth = 0
  let j = i
  let close = -1
  while (j < s.length) {
    const c = s[j]
    if (c === '\\') { j += 2; continue }
    if (c === '`') { const e = codeEnd(s, j); j = e < 0 ? j + runLen(s, j) : e; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) { close = j; break } }
    j++
  }
  if (close < 0 || s[close + 1] !== '(') return null
  let k = close + 2
  while (s[k] === ' ') k++
  let url = ''
  if (s[k] === '<') {
    const e = s.indexOf('>', k)
    if (e < 0 || /[\n<]/.test(s.slice(k + 1, e))) return null
    url = s.slice(k + 1, e)
    k = e + 1
  } else {
    let par = 0
    const st = k
    while (k < s.length && !/\s/.test(s[k] as string)) {
      if (s[k] === '\\') { k += 2; continue }
      if (s[k] === '(') par++
      else if (s[k] === ')') { if (par === 0) break; par-- }
      k++
    }
    url = s.slice(st, k)
  }
  let title: string | undefined
  const sp = k
  while (s[k] === ' ') k++
  const q = s[k]
  if (k > sp && (q === '"' || q === "'")) {
    const e = s.indexOf(q, k + 1)
    if (e < 0) return null
    title = s.slice(k + 1, e)
    k = e + 1
    while (s[k] === ' ') k++
  }
  if (s[k] !== ')') return null
  return { text: s.slice(i + 1, close), url: url.replace(/\\(.)/g, '$1'), ...(title !== undefined ? { title } : {}), end: k + 1 }
}

/** Голый адрес с позиции `i`: хвостовая пунктуация и непарная `)` в адрес не входят. */
function scanBareUrl(s: string, i: number): number {
  const m = /^https?:\/\/[^\s<>]+/.exec(s.slice(i, i + 2100))
  if (!m) return -1
  let u = m[0]
  for (;;) {
    const last = u[u.length - 1] as string
    if ('.,;:!?*_~\'"'.includes(last)) { u = u.slice(0, -1); continue }
    if (last === ')') {
      const open = (u.match(/\(/g) ?? []).length
      const shut = (u.match(/\)/g) ?? []).length
      if (shut > open) { u = u.slice(0, -1); continue }
    }
    break
  }
  return /^https?:\/\/[^/?#]/.test(u) ? i + u.length : -1
}

function link(url: string, c: Inline[], title?: string): Inline {
  return { t: 'link', href: safeHref(url), url, ...(title ? { title } : {}), c }
}

function inline(s: string, o: Opts): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = (): void => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }
  const push = (x: Inline): void => { flush(); out.push(x) }
  // Выделение без пары с позиции p не закроется и с позиции дальше: не ищем повторно (иначе
  // абзац из тысячи `_a` разбирался бы за квадрат).
  const dead = new Map<string, number>()
  const closer = (from: number, d: string): number => {
    const k = dead.get(d)
    if (k !== undefined && from >= k) return -1
    const r = findCloser(s, from, d)
    if (r < 0) dead.set(d, Math.min(from, k ?? Infinity))
    return r
  }

  let i = 0
  while (i < s.length) {
    const c = s[i] as string
    if (c === '\\' && i + 1 < s.length && PUNCT.has(s[i + 1] as string)) { buf += s[i + 1]; i += 2; continue }
    if (!o.noLinks && c === ':' && s.startsWith(':codex-file-citation{', i)) {
      const citation = fileCitation(s.slice(i, i + 8400))
      if (citation) { push({ t: 'file', path: citation.path }); i += citation.length; continue }
    }
    if (c === '`') {
      const e = codeEnd(s, i)
      const n = runLen(s, i)
      if (e < 0) { buf += s.slice(i, i + n); i += n; continue }
      let v = s.slice(i + n, e - n).replace(/\n/g, ' ')
      if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1)
      push({ t: 'code', v })
      i = e
      continue
    }
    if (c === '<') {
      const br = /^<br\s*\/?>/i.exec(s.slice(i, i + 6))
      if (br) { push({ t: 'br' }); i += br[0].length; continue }
      if (!o.noLinks) {
        const m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(s.slice(i, i + 2100))
        if (m) { push(link(m[1] as string, [{ t: 'text', v: m[1] as string }])); i += m[0].length; continue }
        const em = /^<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/.exec(s.slice(i, i + 300))
        if (em) { push(link(`mailto:${em[1]}`, [{ t: 'text', v: em[1] as string }])); i += em[0].length; continue }
      }
    }
    if (!o.noLinks && (c === '[' || (c === '!' && s[i + 1] === '['))) {
      const at = c === '!' ? i + 1 : i
      const l = scanLink(s, at)
      if (l) {
        // Изображение загружает только проверяющий локальные файлы мост оболочки.
        push(c === '!' ? { t: 'image', url: l.url, alt: l.text } : link(l.url, inline(l.text || l.url, { noLinks: true }), l.title))
        i = l.end
        continue
      }
    }
    if (!o.noLinks && c === 'h' && !isWord(s[i - 1]) && s[i - 1] !== '/') {
      const e = scanBareUrl(s, i)
      if (e > 0) { const u = s.slice(i, e); push(link(u, [{ t: 'text', v: u }])); i = e; continue }
    }
    if (c === '*' || c === '_' || c === '~') {
      const r = runLen(s, i)
      const prev = s[i - 1]
      const next = s[i + r]
      // Открывает перед не-пробелом; `_` — не посреди слова и не после `/` или `.` (snake_case_name,
      // `src/_private_.ts`, `.__x__` остаются текстом).
      const canOpen = !isSpace(next) && (c !== '_' || (!isWord(prev) && prev !== '/' && prev !== '.'))
      if (canOpen) {
        const tries: Array<[string, 'bold' | 'em' | 'del']> =
          c === '~' ? (r === 2 ? [['~~', 'del']] : [])
            : r === 1 ? [[c, 'em']] : r === 2 ? [[c + c, 'bold']] : r === 3 ? [[c + c, 'bold'], [c, 'em']] : []
        let done = false
        for (const [d, t] of tries) {
          const from = i + d.length
          const e = closer(from, d)
          if (e > from) {
            // `***x***`: сначала жирный, внутри него — курсив из оставшейся звезды.
            push({ t, c: inline(s.slice(from, e), o) })
            i = e + d.length
            done = true
            break
          }
        }
        if (done) continue
      }
      buf += s.slice(i, i + r)
      i += r
      continue
    }
    buf += c
    i++
  }
  flush()
  return out
}

/** Разбор строки в дерево. Чистая функция. */
export function parseInline(s: string): Inline[] {
  return inline(s, { noLinks: false })
}

// --- блоки --------------------------------------------------------------------------------

const MAX_DEPTH = 12

/** Как разбирать. `human` — реплика человека: лёгкий Markdown (см. шапку файла, `parseHuman`). */
export interface ParseOpts {
  human?: boolean
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const SETEXT = /^ {0,3}(={3,}|-{3,})[ \t]*$/
const ITEM = /^([ \t]*)([-*+•]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*$)/
const QUOTE = /^ {0,3}>/
const SEP_CELL = /^:?-+:?$/

const indentOf = (line: string): number => {
  let n = 0
  for (const ch of line) { if (ch === ' ') n++; else if (ch === '\t') n += 4 - (n % 4); else break }
  return n
}

/** Убрать до `n` колонок отступа (табуляция — до следующего кратного 4). */
function dedent(line: string, n: number): string {
  let col = 0
  let i = 0
  while (i < line.length && col < n) {
    if (line[i] === ' ') col++
    else if (line[i] === '\t') col += 4 - (col % 4)
    else break
    i++
  }
  return line.slice(i)
}

function fenceOpen(line: string): { indent: number; mark: string; lang: string } | null {
  const m = FENCE.exec(line)
  if (!m) return null
  const mark = m[2] as string
  const info = (m[3] as string).trim()
  if (mark[0] === '`' && info.includes('`')) return null
  // ```ts title="x" → ts: язык — первое слово строки сведений.
  const lang = /^[\w#+.-]*/.exec(info)?.[0] ?? ''
  return { indent: (m[1] as string).length, mark, lang }
}

/** Ячейки строки таблицы: `\|` — символ, а не граница; `|` внутри `кода` — тоже. */
export function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  let i = 0
  while (i < s.length) {
    const c = s[i] as string
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i += 2; continue }
    if (c === '\\') { cur += s.slice(i, i + 2); i += 2; continue }
    if (c === '`') {
      const e = codeEnd(s, i)
      if (e > 0) { cur += s.slice(i, e).replace(/\\\|/g, '|'); i = e; continue }
      const n = runLen(s, i)
      cur += s.slice(i, i + n)
      i += n
      continue
    }
    if (c === '|') { cells.push(cur.trim()); cur = ''; i++; continue }
    cur += c
    i++
  }
  cells.push(cur.trim())
  return cells
}

/** Строка-разделитель таблицы → выравнивания, или null. Без `|` это не разделитель, а черта. */
function separator(line: string): Align[] | null {
  if (!line.includes('|') || !/^[\s|:-]+$/.test(line)) return null
  const cells = splitRow(line)
  if (!cells.length || !cells.every((c) => SEP_CELL.test(c))) return null
  return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
}

/** Начинает ли строка новый блок (прерывает абзац или ленивое продолжение пункта). */
function startsBlock(line: string, inPara: boolean): boolean {
  if (fenceOpen(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) return true
  const li = ITEM.exec(line)
  if (!li) return false
  // Пустой пункт и нумерованный не с 1 абзац не прерывают: «2024. год был…» — не список.
  if (inPara && (li[3] === undefined || !li[3].trim())) return false
  return !(inPara && /\d/.test(li[2] as string) && parseInt(li[2] as string, 10) !== 1)
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length) { out.push({ t: 'p', v: parseInline(para.join('\n')) }); para = [] }
  }
  // Слишком глубокая вложенность (`> > > …` из чужого текста) — дальше обычным текстом.
  if (depth > MAX_DEPTH) return lines.some((l) => l.trim()) ? [{ t: 'p', v: [{ t: 'text', v: lines.join('\n').trim() }] }] : []

  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string

    if (!line.trim()) { flush(); i++; continue }

    const fence = fenceOpen(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      const close = new RegExp(`^ {0,3}${fence.mark[0] === '`' ? '`' : '~'}{${fence.mark.length},}[ \\t]*$`)
      while (i < lines.length && !close.test(lines[i] as string)) { body.push(dedent(lines[i] as string, fence.indent)); i++ }
      i++ // закрывающая строка; нет её — блок идёт до конца (текст ещё течёт)
      out.push({ t: 'code', lang: fence.lang, v: body.join('\n') })
      continue
    }

    // Таблица: строка с `|`, под ней разделитель с тем же числом ячеек.
    const next = lines[i + 1]
    if (line.includes('|') && next !== undefined) {
      const align = separator(next)
      const head = align && splitRow(line)
      if (align && head && head.length === align.length) {
        flush()
        const width = head.length
        const fit = (cells: string[]): Inline[][] =>
          Array.from({ length: width }, (_, k) => parseInline(cells[k] ?? ''))
        const rows: Inline[][][] = []
        i += 2
        while (i < lines.length) {
          const row = lines[i] as string
          if (!row.trim() || !row.includes('|') || (startsBlock(row, false) && !row.trim().startsWith('|'))) break
          rows.push(fit(splitRow(row)))
          i++
        }
        out.push({ t: 'table', align, head: fit(head), rows })
        continue
      }
    }

    if (para.length && SETEXT.test(line)) {
      // Строка `===`/`---` под абзацем делает его заголовком (setext), а не чертой.
      const level = line.trim()[0] === '=' ? 1 : 2
      out.push({ t: 'h', level, v: parseInline(para.join('\n')) })
      para = []
      i++
      continue
    }

    if (HR.test(line)) { flush(); out.push({ t: 'hr' }); i++; continue }

    const h = HEADING.exec(line)
    if (h && (h[2] as string).trim()) {
      flush()
      out.push({ t: 'h', level: (h[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6, v: parseInline((h[2] as string).trim()) })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length) {
        const l = lines[i] as string
        if (QUOTE.test(l)) body.push(l.replace(/^ {0,3}> ?/, ''))
        // Ленивое продолжение: строка без `>` сразу за текстом цитаты.
        else if (l.trim() && body.length && (body[body.length - 1] as string).trim() && !startsBlock(l, true)) body.push(l)
        else break
        i++
      }
      out.push({ t: 'quote', c: parseBlocks(body, depth + 1) })
      continue
    }

    if (ITEM.test(line) && (!para.length || startsBlock(line, true))) {
      flush()
      i = parseList(lines, i, depth, out)
      continue
    }

    para.push(line.trim())
    i++
  }
  flush()
  return out
}

/** Список с позиции `i`; дописывает блок в `out`, возвращает индекс первой строки после списка. */
function parseList(lines: string[], i: number, depth: number, out: Block[]): number {
  const first = ITEM.exec(lines[i] as string) as RegExpExecArray
  const ordered = /\d/.test(first[2] as string)
  const base = indentOf(lines[i] as string)
  const list: Block & { t: 'list' } = { t: 'list', ordered, start: ordered ? parseInt(first[2] as string, 10) : 1, items: [] }

  while (i < lines.length) {
    const line = lines[i] as string
    const m = ITEM.exec(line)
    if (!m || HR.test(line) || /\d/.test(m[2] as string) !== ordered) break
    const ind = indentOf(line)
    if (ind >= base + 2) break // сюда не дойдёт: глубже — это тело предыдущего пункта
    const marker = m[2] as string
    const rest = m[3] ?? ''
    const gap = line.length - (m[1] as string).length - marker.length - rest.length
    // Колонка текста пункта: за маркером и пробелами (больше 4 пробелов — код, считаем один).
    const col = ind + marker.length + (gap >= 1 && gap <= 4 ? gap : 1)
    const body: string[] = [rest]
    let j = i + 1
    while (j < lines.length) {
      const l = lines[j] as string
      if (!l.trim()) {
        let k = j + 1
        while (k < lines.length && !(lines[k] as string).trim()) k++
        if (k < lines.length && indentOf(lines[k] as string) >= ind + 2) { for (; j < k; j++) body.push(''); continue }
        break
      }
      const li = indentOf(l)
      if (li >= ind + 2) { body.push(dedent(l, Math.min(col, li))); j++; continue }
      // Строка левее тела пункта: соседний пункт, новый блок или конец — список кончился.
      if (ITEM.test(l) || !(body[body.length - 1] as string).trim() || startsBlock(l, true)) break
      // Ленивое продолжение: строка без отступа сразу за текстом пункта — его же абзац.
      body.push(l.trimStart())
      j++
    }
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(rest)
    if (task) body[0] = rest.slice(task[0].length)
    const c = parseBlocks(body, depth + 1)
    list.items.push(task ? { task: { checked: task[1] !== ' ' }, c } : { c })
    i = j
    // Пустые строки между пунктами одного списка список не рвут.
    let k = i
    while (k < lines.length && !(lines[k] as string).trim()) k++
    const nx = k < lines.length ? ITEM.exec(lines[k] as string) : null
    if (k > i && nx && !HR.test(lines[k] as string) && indentOf(lines[k] as string) < base + 2 && /\d/.test(nx[2] as string) === ordered) i = k
  }
  out.push(list)
  return i
}

/**
 * Реплика человека: блоки кода ```…``` (как у модели) и текст между ними — абзацем как есть: строки с их
 * отступами, пустые строки внутри, `#`, `-`, `+`, `>`, `|` в начале строки — текстом. Внутри — ссылки, `код`,
 * жирный, курсив. Срезаются только пустые строки по краям куска.
 */
function parseHuman(lines: string[]): Block[] {
  const out: Block[] = []
  let text: string[] = []
  const flush = (): void => {
    let a = 0
    let b = text.length
    while (a < b && !(text[a] as string).trim()) a++
    while (b > a && !(text[b - 1] as string).trim()) b--
    if (b > a) out.push({ t: 'p', v: parseInline(text.slice(a, b).join('\n')) })
    text = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const fence = fenceOpen(line)
    if (!fence) { text.push(line); i++; continue }
    flush()
    const body: string[] = []
    i++
    const close = new RegExp(`^ {0,3}${fence.mark[0] === '`' ? '`' : '~'}{${fence.mark.length},}[ \\t]*$`)
    while (i < lines.length && !close.test(lines[i] as string)) { body.push(dedent(lines[i] as string, fence.indent)); i++ }
    i++
    out.push({ t: 'code', lang: fence.lang, v: body.join('\n') })
  }
  flush()
  return out
}

export function parseMarkdown(src: string, opts: ParseOpts = {}): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  return opts.human ? parseHuman(lines) : parseBlocks(lines, 0)
}
