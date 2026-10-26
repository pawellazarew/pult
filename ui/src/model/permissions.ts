// Что просит агент — в человеческом виде: заголовок, цель (файл, команда, адрес), причина,
// варианты и, для правок файлов, дифф. Чистые функции: вход — имя инструмента и его вход
// (уже отредактированный брокером), выход — описание для карточки.
//
// Формы входа ИЗМЕРЕНЫ, а не придуманы:
//   Claude — вход инструмента как есть: Edit {file_path, old_string, new_string, replace_all},
//     MultiEdit {file_path, edits[]}, Write {file_path, content}, Bash {command, description?}
//     (фикстуры 04 и 05);
//   Codex — `approvalInput` адаптера: commandExecution {command, cwd, reason, commandActions,
//     availableDecisions}, fileChange {changes?, reason?}, execCommand {command[]}, applyPatch
//     {fileChanges}; `availableDecisions` — строковые варианты (фикстура 03).

import type { PermissionOffers, PermissionScope } from '../../../src/adapters/types.js'
import { obj, str } from './types.js'

export type PermKind = 'edit' | 'write' | 'command' | 'read' | 'net' | 'generic'

export type DiffOp = ' ' | '-' | '+'
export interface DiffLine { op: DiffOp; text: string; oldNo?: number; newNo?: number }
/** Строка диффа или пропуск неизменных строк. */
export type DiffRow = DiffLine | { op: 'gap'; count: number }

export interface DiffBlock { path?: string; rows: DiffRow[]; added: number; removed: number }

export interface PermView {
  kind: PermKind
  title: string
  /** Файл, команда или адрес — то, на что смотрит человек первым. */
  target?: string
  reason?: string
  cwd?: string
  diffs: DiffBlock[]
  /** Варианты решения, которые предлагает провайдер (codex `availableDecisions`). */
  options: string[]
  /** Остальные поля входа — «как есть», по строке. */
  fields: Array<[string, string]>
}

const MAX_DIFF_LINES = 600

function lines(s: string): string[] {
  if (s === '') return []
  const out = s.split('\n')
  if (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}

/**
 * Построчный дифф по наибольшей общей подпоследовательности. Для больших входов (дороже
 * MAX_DIFF_LINES² клеток) — честный «всё удалено, всё добавлено»: карточка разрешения не место,
 * где окно имеет право подвиснуть.
 */
export function lineDiff(before: string, after: string, context = 3): DiffBlock {
  const a = lines(before)
  const b = lines(after)
  const out: DiffLine[] = []
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    a.forEach((t, i) => out.push({ op: '-', text: t, oldNo: i + 1 }))
    b.forEach((t, i) => out.push({ op: '+', text: t, newNo: i + 1 }))
  } else {
    const n = a.length
    const m = b.length
    // lcs[i][j] — длина общей подпоследовательности хвостов a[i..], b[j..].
    const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { out.push({ op: ' ', text: a[i]!, oldNo: i + 1, newNo: j + 1 }); i++; j++ }
      // При равенстве сначала удаление: привычный порядок «было → стало».
      else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { out.push({ op: '-', text: a[i]!, oldNo: i + 1 }); i++ }
      else { out.push({ op: '+', text: b[j]!, newNo: j + 1 }); j++ }
    }
  }
  return { rows: withContext(out, context), added: out.filter((l) => l.op === '+').length, removed: out.filter((l) => l.op === '-').length }
}

/** Неизменные строки дальше `context` от правки сворачиваются в пропуск. */
function withContext(all: DiffLine[], context: number): DiffRow[] {
  const keep = all.map(() => false)
  all.forEach((l, i) => {
    if (l.op === ' ') return
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true
  })
  const rows: DiffRow[] = []
  let gap = 0
  all.forEach((l, i) => {
    if (keep[i]) {
      if (gap) { rows.push({ op: 'gap', count: gap }); gap = 0 }
      rows.push(l)
    } else gap++
  })
  if (gap) rows.push({ op: 'gap', count: gap })
  return rows
}

/**
 * Номер строки в желобке диффа — ОДИН сквозной столбец: у удалённой строки старый номер, у
 * добавленной и неизменной — новый. Раньше неизменная строка брала старый номер, и после
 * замены желобок читался «3−, 3+, 4+, 4»: два разных «4» подряд выглядели как сломанная нумерация.
 */
export function gutterNo(r: DiffLine): number | undefined {
  return r.op === '-' ? r.oldNo : r.newNo
}

/**
 * Унифицированный дифф (`@@`, `+`, `-`) → строки. Заголовки файла (`---`, `+++`, `diff `,
 * `index `) пропускаются ТОЛЬКО вне hunk: внутри него `---old` — это удалённая строка `--old`,
 * а `+++new` — добавленная `++new` (SQL/Lua-комментарий, разделитель YAML, `++i`). Где hunk
 * кончается, говорят счётчики его заголовка `@@ -a,N +b,M @@`: без них такие строки молча
 * выпадали из карточки, и человек разрешал правку, часть которой не видел.
 */
export function parseUnifiedDiff(text: string): DiffBlock {
  const rows: DiffRow[] = []
  let added = 0
  let removed = 0
  let oldNo = 0
  let newNo = 0
  // Сколько строк старого и нового файла ещё осталось в текущем hunk.
  let oldLeft = 0
  let newLeft = 0
  for (const line of lines(text)) {
    const inHunk = oldLeft > 0 || newLeft > 0
    if (!inHunk) {
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) continue
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (hunk) {
        if (rows.length) rows.push({ op: 'gap', count: 0 })
        oldNo = Number(hunk[1])
        oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
        newNo = Number(hunk[3])
        newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
        continue
      }
    }
    // «\ No newline at end of file» — пометка diff, а не строка файла.
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) { rows.push({ op: '+', text: line.slice(1), newNo: newNo++ }); added++; newLeft = Math.max(0, newLeft - 1) }
    else if (line.startsWith('-')) { rows.push({ op: '-', text: line.slice(1), oldNo: oldNo++ }); removed++; oldLeft = Math.max(0, oldLeft - 1) }
    else {
      rows.push({ op: ' ', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ })
      oldLeft = Math.max(0, oldLeft - 1)
      newLeft = Math.max(0, newLeft - 1)
    }
  }
  return { rows, added, removed }
}

const TITLES: Record<string, string> = {
  Edit: 'Правка файла',
  MultiEdit: 'Правка файла',
  Write: 'Запись файла',
  NotebookEdit: 'Правка блокнота',
  Bash: 'Команда в терминале',
  Read: 'Чтение файла',
  Glob: 'Поиск файлов',
  Grep: 'Поиск по файлам',
  WebFetch: 'Запрос в сеть',
  WebSearch: 'Поиск в сети',
  commandExecution: 'Команда в терминале',
  execCommand: 'Команда в терминале',
  fileChange: 'Правка файлов',
  applyPatch: 'Правка файлов',
}

const oneLine = (v: unknown): string => {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

function codexChanges(changes: unknown): DiffBlock[] {
  const out: DiffBlock[] = []
  const add = (path: string | undefined, c: Record<string, unknown>): void => {
    const diff = str(c['unified_diff']) ?? str(c['diff']) ?? str(c['unifiedDiff'])
    const content = str(c['content'])
    if (diff) out.push({ ...parseUnifiedDiff(diff), ...(path ? { path } : {}) })
    else if (content !== undefined) out.push({ ...lineDiff('', content), ...(path ? { path } : {}) })
    else out.push({ rows: [], added: 0, removed: 0, ...(path ? { path } : {}) })
  }
  if (Array.isArray(changes)) {
    for (const c of changes) { const o = obj(c); if (o) add(str(o['path']), o) }
  } else {
    const o = obj(changes)
    if (o) for (const [path, c] of Object.entries(o)) { const co = obj(c); if (co) add(path, co) }
  }
  return out
}

export function describePermission(toolName: string, input: Record<string, unknown>): PermView {
  const title = TITLES[toolName] ?? `Инструмент ${toolName}`
  const options = Array.isArray(input['availableDecisions'])
    ? (input['availableDecisions'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const used = new Set<string>(['availableDecisions'])
  const take = (k: string): unknown => { used.add(k); return input[k] }
  const view: PermView = { kind: 'generic', title, diffs: [], options, fields: [] }

  switch (toolName) {
    case 'Edit': {
      view.kind = 'edit'
      view.target = str(take('file_path'))
      const d = lineDiff(String(take('old_string') ?? ''), String(take('new_string') ?? ''))
      view.diffs.push(view.target ? { ...d, path: view.target } : d)
      if (take('replace_all') === true) view.reason = 'заменить все вхождения'
      break
    }
    case 'MultiEdit': {
      view.kind = 'edit'
      view.target = str(take('file_path'))
      const edits = Array.isArray(take('edits')) ? (input['edits'] as unknown[]) : []
      for (const e of edits) {
        const o = obj(e)
        if (!o) continue
        view.diffs.push(lineDiff(String(o['old_string'] ?? ''), String(o['new_string'] ?? '')))
      }
      break
    }
    case 'Write': {
      view.kind = 'write'
      view.target = str(take('file_path'))
      const d = lineDiff('', String(take('content') ?? ''))
      view.diffs.push(view.target ? { ...d, path: view.target } : d)
      break
    }
    case 'NotebookEdit': {
      view.kind = 'edit'
      view.target = str(take('notebook_path'))
      view.diffs.push(lineDiff('', String(take('new_source') ?? '')))
      break
    }
    case 'Bash': {
      view.kind = 'command'
      view.target = str(take('command'))
      const why = str(take('description'))
      if (why) view.reason = why
      break
    }
    case 'commandExecution':
    case 'execCommand': {
      view.kind = 'command'
      const cmd = take('command')
      view.target = Array.isArray(cmd) ? cmd.filter((x) => typeof x === 'string').join(' ') : str(cmd)
      const why = str(take('reason'))
      if (why) view.reason = why
      const cwd = str(take('cwd'))
      if (cwd) view.cwd = cwd
      for (const k of ['kind', 'commandActions', 'proposedExecpolicyAmendment', 'startedAtMs', 'environmentId', 'itemId', 'approvalId']) used.add(k)
      break
    }
    case 'fileChange':
    case 'applyPatch': {
      view.kind = 'edit'
      view.diffs = codexChanges(take('changes') ?? take('fileChanges'))
      const why = str(take('reason'))
      if (why) view.reason = why
      const paths = view.diffs.map((d) => d.path).filter(Boolean)
      if (paths.length) view.target = paths.join(', ')
      break
    }
    case 'Read':
    case 'Glob':
    case 'Grep': {
      view.kind = 'read'
      view.target = str(take('file_path')) ?? str(take('pattern')) ?? str(take('path'))
      break
    }
    case 'WebFetch':
    case 'WebSearch': {
      view.kind = 'net'
      view.target = str(take('url')) ?? str(take('query'))
      break
    }
    default:
      break
  }
  for (const [k, v] of Object.entries(input)) {
    if (used.has(k) || v === undefined || v === null || v === '') continue
    const s = oneLine(v)
    view.fields.push([k, s.length > 400 ? `${s.slice(0, 400)}…` : s])
  }
  return view
}

const DECISIONS: Record<string, string> = {
  accept: 'разрешить',
  acceptForSession: 'разрешить до конца сессии',
  decline: 'отказать',
  cancel: 'отказать и прервать ход',
}
/** Варианты, которые и так покрывают кнопки «Разрешить», «В этой сессии» (M8d) и «Отказать». */
const PLAIN = new Set(['accept', 'acceptForSession', 'decline', 'cancel'])

/**
 * Строка «варианты провайдера» — только когда провайдер предлагает что-то сверх «да/нет»
 * (docs/12 §3 п.3: варианты видны), и по-русски. Раньше карточка печатала сырые `accept · cancel`
 * над кнопками «Разрешить/Отказать» — английский перечень того, что человек и так видит.
 */
export function optionsLine(options: readonly string[]): string | null {
  if (!options.length || options.every((o) => PLAIN.has(o))) return null
  return options.map((o) => DECISIONS[o] ?? o).join(' · ')
}

// --- M8d: «В этой сессии» и «Всегда …» ----------------------------------------------------------------

/**
 * `offers` из события или `perm.list` — не верим форме: кадр мог прийти от демона другой версии. Плохое поле —
 * нет и кнопки (шире «один раз» окно ничего не предлагает наугад).
 */
export function parseOffers(x: unknown): PermissionOffers | undefined {
  const o = obj(x)
  if (!o) return undefined
  const out: PermissionOffers = {}
  if (o['session'] === true) out.session = true
  const r = obj(o['rule'])
  const label = r ? str(r['label']) : undefined
  if (r && (r['kind'] === 'execpolicy' || r['kind'] === 'network') && label) {
    out.rule = { kind: r['kind'], label, note: str(r['note']) ?? 'правило останется в настройках провайдера' }
  }
  return out.session || out.rule ? out : undefined
}

export interface ScopeButton {
  scope: Exclude<PermissionScope, 'once'>
  label: string
  /** Префикс команды или хост — моноширинным, ровно как уйдёт в правило. */
  code?: string
  /** Где правило будет жить — под кнопкой мелким. */
  note?: string
}

/** Кнопки шире «один раз» — только предложенные провайдером на этот запрос. */
export function scopeButtons(offers: PermissionOffers | undefined): ScopeButton[] {
  const out: ScopeButton[] = []
  if (offers?.session) out.push({ scope: 'session', label: 'В этой сессии' })
  if (offers?.rule) {
    out.push(offers.rule.kind === 'network'
      ? { scope: 'rule', label: 'Всегда пускать в сеть к', code: offers.rule.label, note: offers.rule.note }
      // Правда о поправке execpolicy (ревью M8d): это ПРЕФИКС — с любыми аргументами дальше, во всех сессиях Codex.
      : { scope: 'rule', label: 'Всегда: команды, начинающиеся с', code: offers.rule.label, note: offers.rule.note })
  }
  return out
}

/** Хвост решённой карточки: с какой шириной разрешили (`permission.resolved` → scope, rule). */
export function scopeText(scope: unknown, rule: unknown): string | null {
  if (scope === 'session') return 'в этой сессии'
  if (scope !== 'rule') return null
  const r = obj(rule)
  const label = r ? str(r['label']) : undefined
  if (!label) return 'всегда (правило провайдера)'
  return r?.['kind'] === 'network' ? `всегда — сеть к ${label}` : `всегда: команды, начинающиеся с «${label}»`
}

/**
 * Строка «показано не всё» (`concealed`, src/perm/broker.ts) — словами под вид карточки. Команда исполнится исходной,
 * правка или вызов — с исходным вводом; у вопроса (AskUserQuestion, requestUserInput) ничего не исполняется — модель
 * просто знает вопрос целиком, и «команды» там нет.
 */
export function concealedNote(kind: PermKind | 'question'): { what: string; then: string } {
  if (kind === 'question') {
    return {
      what: 'часть вопроса или вариантов',
      then: 'Модель видит вопрос целиком — не уверен, о чём он, пропусти.',
    }
  }
  return {
    what: 'часть ввода',
    then: kind === 'command' ? 'Исполнится исходная команда — не уверен, отказывай.' : 'Исполнится исходный ввод — не уверен, отказывай.',
  }
}

/**
 * 0.3.7: кто ответил на вопрос. Ответ человека демон пишет как `<клиент>#<соединение>` (`shell#3`, `cli#7`, самоназвание
 * не по форме — `unknown#5`) — подпись ему не нужна, как и прежнему `human`. Прочее (`timeout`, `rm`, …) — подписывается.
 */
export function byHuman(by: string): boolean {
  return by === 'human' || /^[a-z][a-z0-9-]{0,31}#\d+$/.test(by)
}
