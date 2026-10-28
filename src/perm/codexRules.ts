// Правила «Всегда» у Codex (план 16, № 11): список и «Отозвать».
//
// ЧТО ЭТО ТАКОЕ. Кнопка «Всегда …» на карточке Codex отвечает серверу поправкой (`acceptWithExecpolicyAmendment` или
// `applyNetworkPolicyAmendment`), и САМ codex дописывает строку в `$CODEX_HOME/rules/default.rules`
// (`prefix_rule(pattern=[…], decision="allow")` или `network_rule(host="…", …)`) — во все сессии Codex. Пульт строку не
// пишет: он ставит над ней комментарий-метку `# pult: rule=<id> at=<время> session=<имя> cwd=<папка>`. По метке
// правило видно в «Настройках» и в `pult perm rules`, и только такое Пульт отзывает (убирает метку и строку под ней).
//
// ТРИ ПРАВИЛА:
//   1. Чужое не трогаем. Строка без метки (её завёл человек, codex CLI или Пульт до этой версии) не показывается
//      списком и не отзывается — только счётчиком «без метки». Строка, которая уже была в файле ДО «Всегда»
//      (codex её не дублирует), метку не получает: метим только НОВУЮ строку, появившуюся после ответа.
//   2. Остальной файл — байт в байт. Правка идёт по байтам (строки режутся по \n, кодировка не пересобирается):
//      вставляется или удаляется ровно одна строка-метка и строка правила под ней.
//   3. Атомарно. Новое содержимое — во временный файл рядом, fsync, и только если исходник за это время не
//      изменился (codex мог дописать правило другой сессии) — rename поверх; изменился — заново, до 5 раз.
//      Симлинк на файл не заменяется файлом: пишем в его цель.
//
// Отзыв не трогает ходы и процесс app-server: файл правится, и всё. Уже открытые треды Codex могут помнить правило в
// памяти до перезапуска app-server — это сказано в окне и в README.

import { randomBytes } from 'node:crypto'
import { closeSync, chmodSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { shellJoin } from '../adapters/codex/adapter.js'
import { redactString } from '../core/log.js'

/** Где Codex держит правила: `$CODEX_HOME/rules/default.rules`, иначе `~/.codex/rules/default.rules`. */
export function codexRulesPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const ch = env['CODEX_HOME']
  return join(ch && ch.trim() ? ch : join(home, '.codex'), 'rules', 'default.rules')
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
  /** Строк правил без метки Пульта — их Пульт не показывает и не трогает. */
  unmarked: number
  /** Файл не прочитался. */
  error?: string
}

export class RulesError extends Error {
  constructor(readonly code: 'not_found' | 'internal', message: string) { super(message) }
}

const MARKER_RE = /^# pult: rule=([A-Za-z0-9-]+) at=(\S+) session=(\S*)(?: cwd=(\S*))?\s*$/

export function formatMarker(m: { id: string; at: string; session: string; cwd?: string }): string {
  return `# pult: rule=${m.id} at=${m.at} session=${encodeURIComponent(m.session)}${m.cwd ? ` cwd=${encodeURIComponent(m.cwd)}` : ''}`
}

export function parseMarker(line: string): { id: string; at: string; session: string; cwd?: string } | null {
  const m = MARKER_RE.exec(line.replace(/\r$/, ''))
  if (!m) return null
  const dec = (s: string): string => { try { return decodeURIComponent(s) } catch { return s } }
  return { id: m[1] as string, at: m[2] as string, session: dec(m[3] ?? ''), ...(m[4] ? { cwd: dec(m[4]) } : {}) }
}

/** JSON-литерал (строка или массив), начинающийся с `text[start]`; конец — индекс после него. */
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

/** Есть ли строка правила вообще (для счётчика «без метки»): `prefix_rule(` или `network_rule(` в начале. */
function isRuleLine(line: string): boolean {
  return /^\s*(prefix_rule|network_rule)\(/.test(line)
}

/**
 * Строка правила «разрешить» → что она разрешает. Формат — как пишет codex 0.163 (`prefix_rule(pattern=[…],
 * decision="allow")`, строки — JSON-литералами); альтернативы в шаблоне, `deny`, чужой синтаксис — null: такую строку
 * Пульт не сопоставит ни с одним «Всегда», и это правильно.
 */
export function parseRuleLine(raw: string): RuleTarget | null {
  const line = raw.replace(/\r$/, '').trim()
  if (!/decision\s*=\s*"allow"/.test(line)) return null
  if (line.startsWith('prefix_rule(')) {
    const at = line.indexOf('pattern=')
    if (at < 0) return null
    const lit = scanLiteral(line, at + 'pattern='.length)
    const v = lit?.value
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string')) return null
    return { kind: 'execpolicy', argv: v as string[] }
  }
  if (line.startsWith('network_rule(')) {
    const m = /\bhost\s*=\s*/.exec(line)
    if (!m) return null
    const lit = scanLiteral(line, m.index + m[0].length)
    return typeof lit?.value === 'string' && lit.value ? { kind: 'network', host: lit.value } : null
  }
  return null
}

function sameTarget(a: RuleTarget, b: RuleTarget): boolean {
  if (a.kind === 'network' || b.kind === 'network') return a.kind === b.kind && (a as { host: string }).host === (b as { host: string }).host
  return a.argv.length === b.argv.length && a.argv.every((x, i) => x === b.argv[i])
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

interface Scanned {
  lines: Buffer[]
  text: string[]
  /** Пары «метка + правило под ней»: индекс метки. */
  marked: Array<{ at: number; rule: CodexRule }>
  unmarked: number
}

function scan(buf: Buffer): Scanned {
  const lines = splitLines(buf)
  const text = lines.map((l) => l.toString('utf8'))
  const marked: Scanned['marked'] = []
  let unmarked = 0
  for (let i = 0; i < text.length; i++) {
    const line = text[i] as string
    if (!isRuleLine(line)) continue
    const m = i > 0 ? parseMarker(text[i - 1] as string) : null
    const t = parseRuleLine(line)
    if (m && t) marked.push({ at: i - 1, rule: { id: m.id, at: m.at, session: m.session, ...(m.cwd ? { cwd: m.cwd } : {}), kind: t.kind, label: labelOf(t) } })
    else unmarked++
  }
  return { lines, text, marked, unmarked }
}

function readOrEmpty(path: string): Buffer {
  try { return readFileSync(path) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw e
  }
}

export function listCodexRules(path: string): CodexRulesList {
  try {
    const exists = existsSync(path)
    const s = scan(readOrEmpty(path))
    return { path, exists, rules: s.marked.map((m) => m.rule), unmarked: s.unmarked }
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

/**
 * Правка файла правил: `edit` получает байты и возвращает новые (null — править нечего). Сравнить-и-записать: tmp
 * рядом с целью, fsync, и rename только если исходник не изменился с чтения. Файла нет — `edit` получает пустой буфер,
 * а записи не будет (метить нечего, отзывать нечего).
 */
function editRules(path: string, edit: (buf: Buffer) => Buffer | null): boolean {
  if (!existsSync(path)) return false
  const real = realpathSync(path)
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = readFileSync(real)
    const next = edit(before)
    if (next === null) return false
    const mode = statSync(real).mode & 0o7777
    const tmp = join(dirname(real), `.default.rules.pult-${process.pid}-${randomBytes(4).toString('hex')}`)
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      let off = 0
      while (off < next.length) {
        const n = writeSync(fd, next, off, next.length - off)
        if (!(n > 0)) throw new Error(`запись вернула ${n} из ${next.length - off} байт`)
        off += n
      }
      fsyncSync(fd)
    } catch (e) {
      closeSync(fd)
      try { unlinkSync(tmp) } catch { /* уже нет */ }
      throw e
    }
    closeSync(fd)
    try {
      if (!readFileSync(real).equals(before)) { unlinkSync(tmp); continue }
      chmodSync(tmp, mode)
      renameSync(tmp, real)
      return true
    } catch (e) {
      try { unlinkSync(tmp) } catch { /* уже нет */ }
      throw e
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
    const marker = formatMarker({ id: meta.id, at: meta.at, session: grant.sessionId, ...(grant.cwd ? { cwd: grant.cwd } : {}) })
    const lines = [...s.lines.slice(0, i), Buffer.from(marker, 'utf8'), ...s.lines.slice(i)]
    marked = { id: meta.id, at: meta.at, session: grant.sessionId, ...(grant.cwd ? { cwd: grant.cwd } : {}), kind: grant.kind, label: labelOf(grant) }
    return joinLines(lines)
  })
  return marked
}

/** Отозвать правило с меткой `id`: убрать метку и строку под ней. Нет такой пары — `not_found`. */
export function revokeCodexRule(path: string, id: string): CodexRule {
  let removed: CodexRule | null = null
  editRules(path, (buf) => {
    removed = null
    const s = scan(buf)
    const hit = s.marked.find((m) => m.rule.id === id)
    if (!hit) return null
    removed = hit.rule
    return joinLines([...s.lines.slice(0, hit.at), ...s.lines.slice(hit.at + 2)])
  })
  if (!removed) throw new RulesError('not_found', `правила ${id} с меткой Пульта в ${path} нет`)
  return removed
}

export interface CodexRulesOptions {
  path: string
  /** Отзыв — в журнал событий (`rule.revoked`). */
  onRevoked?(rule: CodexRule, by: string): void
  log?(level: 'info' | 'warn', msg: string, data: Record<string, unknown>): void
  /** Как часто смотреть, дописал ли codex строку, и сколько ждать. */
  pollMs?: number
  waitMs?: number
}

export interface CodexRules {
  readonly path: string
  /** «Всегда» нажато: снимок сейчас (до ответа серверу), метка — когда codex допишет строку. Не бросает. */
  granted(g: RuleGrant): void
  list(): CodexRulesList
  revoke(id: string, by: string): CodexRule
  /** Погасить ожидания меток (остановка демона). */
  close(): void
}

export function createCodexRules(opts: CodexRulesOptions): CodexRules {
  const pollMs = opts.pollMs ?? 100
  const waitMs = opts.waitMs ?? 15_000
  const timers = new Set<NodeJS.Timeout>()
  const log = opts.log ?? (() => {})
  return {
    path: opts.path,
    granted(g) {
      let baseline: number
      try { baseline = countMatching(readOrEmpty(opts.path), g) } catch (e) {
        log('warn', 'правила codex: файл не прочитан — метки не будет', { path: opts.path, error: (e as Error).message })
        return
      }
      const meta = { id: `r-${randomBytes(4).toString('hex')}`, at: new Date().toISOString() }
      const deadline = Date.now() + waitMs
      const tick = (): void => {
        let rule: CodexRule | null = null
        try { rule = markNewRule(opts.path, g, baseline, meta) } catch (e) {
          log('warn', 'правила codex: метка не записана', { path: opts.path, error: (e as Error).message })
          return
        }
        if (rule) { log('info', 'правила codex: метка поставлена', { id: meta.id, session: g.sessionId, kind: g.kind }); return }
        if (Date.now() >= deadline) {
          log('warn', 'правила codex: новой строки правила не появилось — метки нет (правило уже было в файле или codex его не записал)', { session: g.sessionId, kind: g.kind, baseline })
          return
        }
        const t = setTimeout(() => { timers.delete(t); tick() }, pollMs)
        t.unref()
        timers.add(t)
      }
      const t = setTimeout(() => { timers.delete(t); tick() }, pollMs)
      t.unref()
      timers.add(t)
    },
    list: () => listCodexRules(opts.path),
    revoke(id, by) {
      const rule = revokeCodexRule(opts.path, id)
      log('info', 'правила codex: правило отозвано', { id, kind: rule.kind, by })
      try { opts.onRevoked?.(rule, by) } catch { /* журнал сломан — файл уже исправлен */ }
      return rule
    },
    close() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    },
  }
}
