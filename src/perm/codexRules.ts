// Правила «Всегда» у Codex (план 16, № 11): список и «Отозвать».
//
// ЧТО ЭТО ТАКОЕ. Кнопка «Всегда …» на карточке Codex отвечает серверу поправкой (`acceptWithExecpolicyAmendment` или
// `applyNetworkPolicyAmendment`), и САМ codex дописывает строку в `~/.codex/rules/default.rules`
// (`prefix_rule(pattern=[…], decision="allow")` или `network_rule(host="…", …)`) — во все сессии Codex. Пульт строку не
// пишет: он ставит над ней комментарий-метку `# pult: rule=<id> sha=<8 hex> at=<время> session=<имя> cwd=<папка>`, где
// `sha` — начало sha256 самой строки правила. По метке правило видно в «Настройках» и в `pult perm rules`, и только такое
// Пульт отзывает (убирает метку и строку под ней).
//
// ПРАВИЛА:
//   1. Чужое не трогаем. Строка без метки (её завёл человек, codex CLI или Пульт до меток) не показывается списком и не
//      отзывается — только счётчиком «без метки». Метка пары с правилом образует, только если `sha` совпал со строкой
//      под ней: метка, оставшаяся без своей строки (её убрали руками), не «усыновит» соседнюю строку человека или
//      следующую запись codex. Две метки с одним id — обе не в счёт. Строка, которая уже была в файле ДО «Всегда»
//      (codex её не дублирует), метку не получает: метим только НОВУЮ строку, появившуюся после ответа.
//   2. Остальной файл — байт в байт. Правка идёт по байтам (строки режутся по \n, кодировка не пересобирается).
//   3. Под тем же замком, что у codex. Codex дописывает правило под advisory flock (execpolicy `amend.rs`), и Пульт
//      берёт тот же замок (macOS: `O_EXLOCK`, он совместим с flock) и переписывает файл НА МЕСТЕ — не rename: запись
//      codex в дескриптор, открытый до rename, ушла бы в отвязанную копию и пропала. Перед перезаписью — копия
//      `default.rules.pult.bak` (fsync файла и папки); после — копия удаляется. Осталась `.pult.bak` — запись
//      оборвалась, её видно в списке (`backup`). Linux: `O_EXLOCK` нет — без замка, со сверкой «файл не изменился».
//
// Codex читает правила при старте app-server и в памяти их не перечитывает — поэтому после отзыва демон перезапускает
// общий процесс Codex (src/adapters/codex/adapter.ts, `reloadPolicy`), а не просто правит файл.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, constants as fsc, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readdirSync, readFileSync, readSync, realpathSync,
  unlinkSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { shellJoin } from '../adapters/codex/adapter.js'
import { redactString } from '../core/log.js'
import { buildChildEnv } from '../env/allowlist.js'
import type { CodexReload } from './rulesText.js'

/** Где Codex держит правила: `$CODEX_HOME/rules/default.rules`, иначе `~/.codex/rules/default.rules` (по env процесса codex). */
export function codexRulesPath(env: NodeJS.ProcessEnv | Record<string, string> = process.env, home = homedir()): string {
  const ch = env['CODEX_HOME']
  const h = env['HOME'] && env['HOME'].trim() ? env['HOME'] : home
  return join(ch && ch.trim() ? ch : join(h, '.codex'), 'rules', 'default.rules')
}

/**
 * Файл, куда пишет ИМЕННО app-server Пульта: он запускается с окружением по белому списку (`buildChildEnv`), где
 * `CODEX_HOME` нет, — значит, `$HOME/.codex` ребёнка, а не `CODEX_HOME` демона.
 */
export function codexChildRulesPath(parent: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return codexRulesPath(buildChildEnv(parent), home)
}

/** Что разрешает строка правила: префикс команды или хост сети. */
export type RuleTarget = { kind: 'execpolicy'; argv: string[] } | { kind: 'network'; host: string }

/** «Всегда» нажато: адаптер Codex зовёт это ДО ответа серверу — до того, как codex допишет строку. */
export type RuleGrant = RuleTarget & { sessionId: string; cwd?: string }

export interface CodexRule {
  id: string
  /** Когда Пульт поставил метку (ISO). */
  at: string
  /** Сессия Пульта, из которой нажато «Всегда». */
  session: string
  cwd?: string
  kind: 'execpolicy' | 'network'
  /** Префикс команды строкой (как на карточке) или хост. */
  label: string
}

export interface CodexRulesList {
  path: string
  exists: boolean
  rules: CodexRule[]
  /** Строк `decision="allow"` без (действительной) метки Пульта — их Пульт не показывает и не трогает. */
  unmarked: number
  /** Осталась копия прерванной записи — сверь файл с ней. */
  backup?: string
  /** Файл не прочитался. */
  error?: string
}

export class RulesError extends Error {
  constructor(readonly code: 'not_found' | 'internal', message: string) { super(message) }
}

const MARKER_RE = /^# pult: rule=([A-Za-z0-9-]+) sha=([0-9a-f]{8}) at=(\S+) session=(\S*)(?: cwd=(\S*))?\s*$/

/** Отпечаток строки правила для метки: 8 hex sha256 строки без `\r` в конце. */
export function ruleSha(line: string): string {
  return createHash('sha256').update(line.replace(/\r$/, ''), 'utf8').digest('hex').slice(0, 8)
}

export function formatMarker(m: { id: string; sha: string; at: string; session: string; cwd?: string }): string {
  return `# pult: rule=${m.id} sha=${m.sha} at=${m.at} session=${encodeURIComponent(m.session)}${m.cwd ? ` cwd=${encodeURIComponent(m.cwd)}` : ''}`
}

export function parseMarker(line: string): { id: string; sha: string; at: string; session: string; cwd?: string } | null {
  const m = MARKER_RE.exec(line.replace(/\r$/, ''))
  if (!m) return null
  const dec = (s: string): string => { try { return decodeURIComponent(s) } catch { return s } }
  return { id: m[1] as string, sha: m[2] as string, at: m[3] as string, session: dec(m[4] ?? ''), ...(m[5] ? { cwd: dec(m[5]) } : {}) }
}

/** JSON-литерал (строка или массив), начинающийся с `text[start]`. */
function scanLiteral(text: string, start: number): { value: unknown; end: number } | null {
  const open = text[start]
  if (open !== '[' && open !== '"') return null
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === '"') { inStr = false; if (open === '"') return parse(i + 1) }
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '[') depth++
    if (c === ']' && --depth === 0) return parse(i + 1)
  }
  return null
  function parse(end: number): { value: unknown; end: number } | null {
    try { return { value: JSON.parse(text.slice(start, end)) as unknown, end } } catch { return null }
  }
}

/** Строка правила «разрешить» (для счётчика «без метки»): `prefix_rule(`/`network_rule(` и `decision="allow"`. */
function isAllowLine(line: string): boolean {
  return /^\s*(prefix_rule|network_rule)\(/.test(line) && /decision\s*=\s*"allow"/.test(line)
}

/**
 * Хост сети так, как его сравнивает codex (`normalize_network_rule_host`): нижний регистр, без скобок IPv6, без порта
 * и без точки в конце.
 */
export function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase()
  if (h.startsWith('[')) {
    const close = h.indexOf(']')
    h = close > 0 ? h.slice(1, close) : h.slice(1)
  } else if ((h.match(/:/g) ?? []).length === 1) {
    h = h.slice(0, h.indexOf(':'))
  }
  return h.replace(/\.+$/, '')
}

/**
 * Строка правила «разрешить» → что она разрешает. Формат — как пишет codex 0.163 (`prefix_rule(pattern=[…],
 * decision="allow")`, строки — JSON-литералами); альтернативы в шаблоне, `deny`, чужой синтаксис — null.
 */
export function parseRuleLine(raw: string): RuleTarget | null {
  const line = raw.replace(/\r$/, '').trim()
  if (!/decision\s*=\s*"allow"/.test(line)) return null
  if (line.startsWith('prefix_rule(')) {
    const at = line.indexOf('pattern=')
    if (at < 0) return null
    const v = scanLiteral(line, at + 'pattern='.length)?.value
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string')) return null
    return { kind: 'execpolicy', argv: v as string[] }
  }
  if (line.startsWith('network_rule(')) {
    const m = /\bhost\s*=\s*/.exec(line)
    if (!m) return null
    const v = scanLiteral(line, m.index + m[0].length)?.value
    return typeof v === 'string' && v ? { kind: 'network', host: v } : null
  }
  return null
}

function sameTarget(a: RuleTarget, b: RuleTarget): boolean {
  if (a.kind === 'network' || b.kind === 'network') {
    return a.kind === 'network' && b.kind === 'network' && normalizeHost(a.host) === normalizeHost(b.host)
  }
  return a.argv.length === b.argv.length && a.argv.every((x, i) => x === b.argv[i])
}

/** `rule` разрешает то же, что `target`, или шире: тот же хост, тот же или более короткий префикс. */
function covers(rule: RuleTarget, target: RuleTarget): boolean {
  if (rule.kind === 'network' || target.kind === 'network') return sameTarget(rule, target)
  return rule.argv.length <= target.argv.length && rule.argv.every((x, i) => x === target.argv[i])
}

function labelOf(t: RuleTarget): string {
  return redactString(t.kind === 'network' ? t.host : shellJoin(t.argv))
}

/** Файл строками-байтами: режем по \n, сам \n в строку не входит. Последний элемент — хвост после последнего \n. */
function splitLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let from = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { out.push(buf.subarray(from, i)); from = i + 1 }
  }
  out.push(buf.subarray(from))
  return out
}

const joinLines = (lines: Buffer[]): Buffer => Buffer.concat(lines.flatMap((l, i) => (i ? [Buffer.from('\n'), l] : [l])))

interface Pair { at: number; rule: CodexRule; target: RuleTarget }
interface Scanned { lines: Buffer[]; text: string[]; marked: Pair[]; unmarked: number }

function scan(buf: Buffer): Scanned {
  const lines = splitLines(buf)
  const text = lines.map((l) => l.toString('utf8'))
  const pairs: Pair[] = []
  const paired = new Set<number>()
  for (let i = 1; i < text.length; i++) {
    const m = parseMarker(text[i - 1] as string)
    if (!m) continue
    const line = text[i] as string
    const t = parseRuleLine(line)
    if (!t || ruleSha(line) !== m.sha) continue
    pairs.push({ at: i - 1, target: t, rule: { id: m.id, at: m.at, session: m.session, ...(m.cwd ? { cwd: m.cwd } : {}), kind: t.kind, label: labelOf(t) } })
  }
  const seen = new Map<string, number>()
  for (const p of pairs) seen.set(p.rule.id, (seen.get(p.rule.id) ?? 0) + 1)
  const marked = pairs.filter((p) => seen.get(p.rule.id) === 1)
  for (const p of marked) paired.add(p.at + 1)
  let unmarked = 0
  for (let i = 0; i < text.length; i++) if (!paired.has(i) && isAllowLine(text[i] as string)) unmarked++
  return { lines, text, marked, unmarked }
}

function readOrEmpty(path: string): Buffer {
  try { return readFileSync(path) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw e
  }
}

const backupOf = (real: string): string => `${real}.pult.bak`

export function listCodexRules(path: string): CodexRulesList {
  try {
    const exists = existsSync(path)
    const s = scan(readOrEmpty(path))
    const real = exists ? realpathSync(path) : path
    const backup = existsSync(backupOf(real)) ? backupOf(real) : undefined
    return { path, exists, rules: s.marked.map((m) => m.rule), unmarked: s.unmarked, ...(backup ? { backup } : {}) }
  } catch (e) {
    return { path, exists: true, rules: [], unmarked: 0, error: (e as Error).message }
  }
}

/** Сколько строк в файле разрешают ровно это (с меткой и без) — снимок ДО ответа серверу. */
export function countMatching(buf: Buffer, target: RuleTarget): number {
  return splitLines(buf).reduce((n, l) => {
    const t = parseRuleLine(l.toString('utf8'))
    return t && sameTarget(t, target) ? n + 1 : n
  }, 0)
}

// --- замок и запись на месте -------------------------------------------------------------------------------------

/** macOS: `O_EXLOCK` — тот же замок, что flock у codex. Linux такого флага у open нет. */
const O_EXLOCK = process.platform === 'darwin' ? 0x20 : 0
const LOCK_TRIES = 100
const LOCK_PAUSE_MS = 20
const nap = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Открыть файл на чтение-запись под замком codex; занят дольше ~2 с — отказ. */
export function openLocked(path: string): { fd: number; locked: boolean } {
  if (!O_EXLOCK) return { fd: openSync(path, fsc.O_RDWR), locked: false }
  for (let i = 0; i < LOCK_TRIES; i++) {
    try { return { fd: openSync(path, fsc.O_RDWR | O_EXLOCK | fsc.O_NONBLOCK), locked: true } } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw e
      nap(LOCK_PAUSE_MS)
    }
  }
  throw new RulesError('internal', `${path} держит другой процесс (codex пишет правило) — повтори`)
}

function readAllFd(fd: number): Buffer {
  const size = fstatSync(fd).size
  const buf = Buffer.alloc(size)
  let off = 0
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off)
    if (n <= 0) break
    off += n
  }
  return buf.subarray(0, off)
}

function writeAllFd(fd: number, buf: Buffer, position: number): void {
  let off = 0
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off, position + off)
    if (!(n > 0)) throw new Error(`запись вернула ${n} из ${buf.length - off} байт`)
    off += n
  }
}

function fsyncDir(dir: string): void {
  try { const d = openSync(dir, 'r'); try { fsyncSync(d) } finally { closeSync(d) } } catch { /* платформа не умеет — не повод падать */ }
}

/**
 * Правка файла правил НА МЕСТЕ под замком codex: `edit` получает байты и возвращает новые (null — править нечего).
 * Порядок: замок → чтение → копия `.pult.bak` (fsync, fsync папки) → усечение и запись → fsync → копия удаляется.
 * Без замка (Linux) — перед перезаписью сверка, что файл не изменился с чтения; изменился — заново, до 5 раз.
 * Файла нет — записи нет. Симлинк остаётся симлинком: правится цель, inode и режим те же.
 */
function editRules(path: string, edit: (buf: Buffer) => Buffer | null): boolean {
  if (!existsSync(path)) return false
  const real = realpathSync(path)
  for (let attempt = 0; attempt < 5; attempt++) {
    const { fd, locked } = openLocked(real)
    try {
      const before = readAllFd(fd)
      const next = edit(before)
      if (next === null) return false
      const bak = backupOf(real)
      // Копия прошлой оборванной записи — единственный след того, что было до обрыва: не затираем, ждём человека.
      if (existsSync(bak)) throw new RulesError('internal', `осталась копия прерванной записи ${bak} — сверь с ${real} и удали её`)
      const b = openSync(bak, 'wx', 0o600)
      try { writeAllFd(b, before, 0); fsyncSync(b) } finally { closeSync(b) }
      fsyncDir(dirname(real))
      if (!locked && !readFileSync(real).equals(before)) { unlinkSync(bak); continue }
      ftruncateSync(fd, 0)
      writeAllFd(fd, next, 0)
      fsyncSync(fd)
      unlinkSync(bak)
      fsyncDir(dirname(real))
      return true
    } finally {
      closeSync(fd)
    }
  }
  throw new RulesError('internal', `${path} меняется прямо сейчас — правка не записана, повтори`)
}

/**
 * Поставить метку над НОВОЙ строкой правила: строк, разрешающих это, стало больше, чем было до ответа (`baseline`), —
 * последняя из них (codex дописывает в конец) получает метку. Уже помеченная — не трогаем. Вернёт правило или null.
 */
export function markNewRule(path: string, grant: RuleGrant, baseline: number, meta: { id: string; at: string }): CodexRule | null {
  let marked: CodexRule | null = null
  editRules(path, (buf) => {
    marked = null
    const s = scan(buf)
    const hits: number[] = []
    s.text.forEach((l, i) => { const t = parseRuleLine(l); if (t && sameTarget(t, grant)) hits.push(i) })
    if (hits.length <= baseline) return null
    const i = hits[hits.length - 1] as number
    if (i > 0 && parseMarker(s.text[i - 1] as string)) return null
    const line = s.text[i] as string
    const t = parseRuleLine(line) as RuleTarget
    const marker = formatMarker({ id: meta.id, sha: ruleSha(line), at: meta.at, session: grant.sessionId, ...(grant.cwd ? { cwd: grant.cwd } : {}) })
    marked = { id: meta.id, at: meta.at, session: grant.sessionId, ...(grant.cwd ? { cwd: grant.cwd } : {}), kind: t.kind, label: labelOf(t) }
    return joinLines([...s.lines.slice(0, i), Buffer.from(marker, 'utf8'), ...s.lines.slice(i)])
  })
  return marked
}

/** Сколько строк в соседних `*.rules` той же папки разрешают `target` или шире. */
function coveredElsewhere(real: string, target: RuleTarget): number {
  let n = 0
  let names: string[] = []
  try { names = readdirSync(dirname(real)) } catch { return 0 }
  for (const name of names) {
    if (!name.endsWith('.rules') || name === basename(real)) continue
    try {
      for (const l of splitLines(readFileSync(join(dirname(real), name)))) {
        const t = parseRuleLine(l.toString('utf8'))
        if (t && covers(t, target)) n++
      }
    } catch { /* нечитаемый файл — не считаем */ }
  }
  return n
}

/**
 * Отозвать правило с меткой `id`: убрать метку и строку под ней. Нет такой пары — `not_found`. `stillAllowedBy` — сколько
 * других строк (этот файл и соседние `*.rules`) всё ещё разрешают то же самое или шире.
 */
export function revokeCodexRule(path: string, id: string): { rule: CodexRule; stillAllowedBy: number } {
  let removed: Pair | null = null
  let rest: Buffer | null = null
  editRules(path, (buf) => {
    removed = null
    const s = scan(buf)
    const hit = s.marked.find((m) => m.rule.id === id)
    if (!hit) return null
    removed = hit
    rest = joinLines([...s.lines.slice(0, hit.at), ...s.lines.slice(hit.at + 2)])
    return rest
  })
  const r = removed as Pair | null
  if (!r || !rest) throw new RulesError('not_found', `правила ${id} с меткой Пульта в ${path} нет`)
  const here = splitLines(rest).reduce((n, l) => { const t = parseRuleLine(l.toString('utf8')); return t && covers(t, r.target) ? n + 1 : n }, 0)
  return { rule: r.rule, stillAllowedBy: here + coveredElsewhere(realpathSync(path), r.target) }
}

// --- живой учёт в демоне ----------------------------------------------------------------------------------------

export interface CodexRulesOptions {
  path: string
  log?(level: 'info' | 'warn', msg: string, data: Record<string, unknown>): void
  /** Метки не будет: человеку — заметкой в ленте его сессии (`reason` словами). */
  onUnmarked?(grant: RuleGrant, reason: string): void
  /** Как часто смотреть, дописал ли codex строку, и сколько ждать. */
  pollMs?: number
  waitMs?: number
}

export interface CodexRules {
  readonly path: string
  /** «Всегда» нажато: снимок сейчас (до ответа серверу), метка — когда codex допишет строку. Не бросает. */
  granted(g: RuleGrant): void
  list(): CodexRulesList
  revoke(id: string): { rule: CodexRule; stillAllowedBy: number }
  /** Остановка демона: последняя попытка пометить ждущие правила, остальные — `onUnmarked`. */
  close(): void
}

export type { CodexReload }

export function createCodexRules(opts: CodexRulesOptions): CodexRules {
  const pollMs = opts.pollMs ?? 100
  const waitMs = opts.waitMs ?? 15_000
  const log = opts.log ?? (() => {})
  interface Wait { grant: RuleGrant; baseline: number; meta: { id: string; at: string }; deadline: number; timer: NodeJS.Timeout | null }
  const waits = new Set<Wait>()
  const unmarked = (w: Wait, reason: string): void => {
    waits.delete(w)
    log('warn', 'правила codex: метки нет', { session: w.grant.sessionId, kind: w.grant.kind, reason })
    try { opts.onUnmarked?.(w.grant, reason) } catch { /* журнал сломан — строка в журнале демона уже есть */ }
  }
  /** true — дело кончено (помечено или отказ), false — ждать дальше. */
  const attempt = (w: Wait): boolean => {
    let rule: CodexRule | null = null
    try { rule = markNewRule(opts.path, w.grant, w.baseline, w.meta) } catch (e) {
      unmarked(w, `файл правил не записан: ${(e as Error).message}`)
      return true
    }
    if (rule) {
      waits.delete(w)
      log('info', 'правила codex: метка поставлена', { id: w.meta.id, session: w.grant.sessionId, kind: w.grant.kind })
      return true
    }
    return false
  }
  return {
    path: opts.path,
    granted(g) {
      let baseline: number
      try { baseline = countMatching(readOrEmpty(opts.path), g) } catch (e) {
        try { opts.onUnmarked?.(g, `файл правил не прочитан: ${(e as Error).message}`) } catch { /* см. выше */ }
        return
      }
      const w: Wait = { grant: g, baseline, meta: { id: `r-${randomBytes(4).toString('hex')}`, at: new Date().toISOString() }, deadline: Date.now() + waitMs, timer: null }
      waits.add(w)
      const tick = (): void => {
        w.timer = null
        if (!waits.has(w) || attempt(w)) return
        if (Date.now() >= w.deadline) {
          unmarked(w, baseline > 0 ? 'такая строка уже была в файле правил до «Всегда»' : 'codex не дописал строку правила')
          return
        }
        w.timer = setTimeout(tick, pollMs)
        w.timer.unref()
      }
      w.timer = setTimeout(tick, pollMs)
      w.timer.unref()
    },
    list: () => listCodexRules(opts.path),
    revoke(id) {
      const r = revokeCodexRule(opts.path, id)
      log('info', 'правила codex: правило отозвано', { id, kind: r.rule.kind, stillAllowedBy: r.stillAllowedBy })
      return r
    },
    close() {
      for (const w of [...waits]) {
        if (w.timer) clearTimeout(w.timer)
        w.timer = null
        if (!attempt(w)) unmarked(w, 'демон остановлен раньше, чем codex дописал строку правила')
      }
    },
  }
}
