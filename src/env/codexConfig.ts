// `pult doctor` (0.3.7): сеть в песочнице Codex.
//
// Пока у Codex `read-only` / `workspace-write` без сети, песочница (macOS Seatbelt) не даёт агенту даже `connect()` на
// unix-сокет демона — ни токен, ни ключ вопросов ему не помогут. Эту стену снимают настройки config.toml (Пульт их
// уважает, src/adapters/codex/adapter.ts):
//   * `sandbox_workspace_write.network_access = true` — верхний уровень или профиль `profile = "x"`
//     (`[profiles.x.sandbox_workspace_write]`, перекрывает верхний);
//   * профиль разрешений (codex 0.163+): `default_permissions = "x"` → `[permissions.x.network]` с `unix_sockets`,
//     `allow_unix_sockets` или `dangerously_allow_all_unix_sockets = true`.
// Доктор об этом предупреждает. Файл только читается. Разбор — маленький TOML без зависимостей (строки, в том числе
// многострочные, массивы, встроенные таблицы, комментарии): ровно чтобы не принять текст строки за настройку.
// Эффективный конфиг через `config/read` app-server доктор не спрашивает: это лишний процесс codex на каждый прогон.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DoctorItem } from './doctor.js'

/** Где Codex держит config.toml: `$CODEX_HOME/config.toml`, иначе `~/.codex/config.toml`. */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const ch = env['CODEX_HOME']
  return join(ch && ch.trim() ? ch : join(home, '.codex'), 'config.toml')
}

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue }
export type TomlTable = { [k: string]: TomlValue }

class TomlError extends Error {}

/**
 * Маленький разбор TOML 1.0 (+ перевод строки во встроенной таблице, как в 1.1). Значения, которые не нужны доктору
 * (числа, даты), — строкой как есть. Ошибка — `TomlError` с номером строки.
 */
export function parseTomlLite(text: string): TomlTable {
  const root: TomlTable = {}
  let i = 0
  let line = 1
  const n = text.length
  const fail = (why: string): never => { throw new TomlError(`строка ${line}: ${why}`) }
  const peek = (k = 0): string => text[i + k] ?? ''
  const startsWith = (t: string): boolean => text.startsWith(t, i)
  const skipSpaces = (): void => { while (peek() === ' ' || peek() === '\t') i++ }
  const skipComment = (): void => { if (peek() === '#') while (i < n && peek() !== '\n') i++ }
  /** Пробелы, комментарии и переводы строки (внутри массивов и встроенных таблиц). */
  const skipAll = (): void => {
    for (;;) {
      skipSpaces(); skipComment()
      if (peek() === '\r' && peek(1) === '\n') { i += 2; line++; continue }
      if (peek() === '\n') { i++; line++; continue }
      return
    }
  }
  const basicString = (): string => {
    i++
    let out = ''
    while (i < n && peek() !== '"') {
      if (peek() === '\n') fail('перевод строки в строке')
      if (peek() === '\\') { out += text.slice(i, i + 2); i += 2; continue }
      out += peek(); i++
    }
    if (peek() !== '"') fail('строка не закрыта')
    i++
    return out
  }
  const literalString = (): string => {
    const end = text.indexOf("'", i + 1)
    const nl = text.indexOf('\n', i + 1)
    if (end < 0 || (nl >= 0 && nl < end)) fail('строка не закрыта')
    const out = text.slice(i + 1, end)
    i = end + 1
    return out
  }
  const multiline = (q: string): string => {
    i += 3
    let out = ''
    while (i < n) {
      if (q === '"""' && peek() === '\\') { out += text.slice(i, i + 2); if (peek(1) === '\n') line++; i += 2; continue }
      if (startsWith(q)) {
        // До двух кавычек перед закрывающими — часть строки.
        let k = 3
        while (k < 5 && text[i + k] === q[0]) k++
        out += q[0]!.repeat(k - 3)
        i += k
        return out
      }
      if (peek() === '\n') line++
      out += peek(); i++
    }
    return fail('многострочная строка не закрыта')
  }
  const key = (): string[] => {
    const parts: string[] = []
    for (;;) {
      skipSpaces()
      if (peek() === '"') parts.push(basicString())
      else if (peek() === "'") parts.push(literalString())
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256))
        if (!m) fail('ожидался ключ')
        parts.push(m![0]); i += m![0].length
      }
      skipSpaces()
      if (peek() !== '.') return parts
      i++
    }
  }
  const value = (): TomlValue => {
    skipSpaces()
    if (startsWith('"""')) return multiline('"""')
    if (startsWith("'''")) return multiline("'''")
    if (peek() === '"') return basicString()
    if (peek() === "'") return literalString()
    if (peek() === '[') {
      i++
      const arr: TomlValue[] = []
      for (;;) {
        skipAll()
        if (peek() === ']') { i++; return arr }
        arr.push(value())
        skipAll()
        if (peek() === ',') { i++; continue }
        if (peek() === ']') { i++; return arr }
        fail('ожидалась , или ] в массиве')
      }
    }
    if (peek() === '{') {
      i++
      const tbl: TomlTable = {}
      for (;;) {
        skipAll()
        if (peek() === '}') { i++; return tbl }
        const k = key()
        if (peek() !== '=') fail('ожидалось = во встроенной таблице')
        i++
        assign(tbl, k, value())
        skipAll()
        if (peek() === ',') { i++; continue }
        if (peek() === '}') { i++; return tbl }
        fail('ожидалась , или } во встроенной таблице')
      }
    }
    // true/false, числа, даты (в том числе «дата время» через пробел) — до конца значения.
    const m = /^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}[^\s,\]}#]*|[^\s,\]}#]+)/.exec(text.slice(i, i + 256))
    if (!m) fail('ожидалось значение')
    i += m![0].length
    return m![0] === 'true' ? true : m![0] === 'false' ? false : m![0]
  }
  const tableAt = (base: TomlTable, path: string[]): TomlTable => {
    let t = base
    for (const p of path) {
      const next = t[p]
      if (next === undefined) { const fresh: TomlTable = {}; t[p] = fresh; t = fresh; continue }
      if (Array.isArray(next)) {
        // Массив таблиц: ключи пишутся в последнюю.
        const last = next[next.length - 1]
        if (!last || typeof last !== 'object' || Array.isArray(last)) fail(`ключ ${p} — не таблица`)
        t = last as TomlTable
        continue
      }
      if (typeof next !== 'object') fail(`ключ ${p} — не таблица`)
      t = next as TomlTable
    }
    return t
  }
  const assign = (base: TomlTable, path: string[], v: TomlValue): void => {
    const t = tableAt(base, path.slice(0, -1))
    t[path[path.length - 1]!] = v
  }

  let current = root
  while (i < n) {
    skipAll()
    if (i >= n) break
    if (startsWith('[[')) {
      i += 2
      const path = key()
      if (!startsWith(']]')) fail('ожидалось ]]')
      i += 2
      const parent = tableAt(root, path.slice(0, -1))
      const last = path[path.length - 1]!
      const arr = Array.isArray(parent[last]) ? parent[last] as TomlValue[] : (parent[last] = [] as TomlValue[]) as TomlValue[]
      const fresh: TomlTable = {}
      arr.push(fresh)
      current = fresh
    } else if (peek() === '[') {
      i++
      const path = key()
      if (peek() !== ']') fail('ожидалось ]')
      i++
      current = tableAt(root, path)
    } else {
      const k = key()
      if (peek() !== '=') fail('ожидалось =')
      i++
      assign(current, k, value())
    }
    skipSpaces(); skipComment()
    if (i < n && peek() !== '\n' && !(peek() === '\r' && peek(1) === '\n')) fail('лишнее после значения')
  }
  return root
}

const tbl = (v: TomlValue | undefined): TomlTable | null => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)

export interface CodexSandboxNetwork {
  /** Сеть в песочнице workspace-write: true / false / null — не задана (по умолчанию выключена). */
  networkAccess: boolean | null
  /** Откуда значение: `sandbox_workspace_write` или `profiles.<x>.sandbox_workspace_write`. */
  networkFrom: string | null
  /** Профиль разрешений (`default_permissions`) открывает unix-сокеты — чем именно; пусто — нет. */
  unixSockets: string[]
}

/** Разбор config.toml codex: что открывает песочнице путь к сокету демона. Кривой TOML — `TomlError`. */
export function codexSandboxNetwork(text: string): CodexSandboxNetwork {
  const root = parseTomlLite(text)
  let networkAccess: boolean | null = null
  let networkFrom: string | null = null
  const top = tbl(root['sandbox_workspace_write'])
  if (top && typeof top['network_access'] === 'boolean') { networkAccess = top['network_access']; networkFrom = 'sandbox_workspace_write' }
  const profile = typeof root['profile'] === 'string' ? root['profile'] : null
  if (profile) {
    const ws = tbl(tbl(tbl(root['profiles'])?.[profile])?.['sandbox_workspace_write'])
    if (ws && typeof ws['network_access'] === 'boolean') {
      networkAccess = ws['network_access']
      networkFrom = `profiles.${profile}.sandbox_workspace_write`
    }
  }
  const unixSockets: string[] = []
  const perm = typeof root['default_permissions'] === 'string' ? root['default_permissions'] : null
  if (perm) {
    const net = tbl(tbl(tbl(root['permissions'])?.[perm])?.['network'])
    const at = `permissions.${perm}.network`
    if (net) {
      if (net['dangerously_allow_all_unix_sockets'] === true) unixSockets.push(`${at}.dangerously_allow_all_unix_sockets = true`)
      const allow = net['allow_unix_sockets']
      if (Array.isArray(allow) && allow.length) unixSockets.push(`${at}.allow_unix_sockets`)
      const map = net['unix_sockets']
      if ((Array.isArray(map) && map.length) || (tbl(map) && Object.keys(tbl(map)!).length)) unixSockets.push(`${at}.unix_sockets`)
    }
  }
  return { networkAccess, networkFrom, unixSockets }
}

/** Совместимость: только сеть workspace-write (с учётом профиля). Кривой TOML — null. */
export function codexNetworkAccess(text: string): boolean | null {
  try { return codexSandboxNetwork(text).networkAccess } catch { return null }
}

export const CODEX_NETWORK_WARNING = 'песочница Codex с сетью: агент сможет обратиться к демону Пульта'
const MODES = '«Только чтение», «Спрашивать» и «Правки в папке без вопросов»'

/** Пункт доктора; файла нет или не читается — пункта нет (Codex не настроен — говорить не о чем). */
export function codexNetworkItems(path: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): DoctorItem[] {
  let text: string
  try { text = read(path) } catch { return [] }
  const base = { id: 'codex.network', title: 'Песочница Codex и сеть' }
  let r: CodexSandboxNetwork
  try {
    r = codexSandboxNetwork(text)
  } catch (e) {
    return [{
      ...base, status: 'warn',
      detail: `config.toml codex не разобран (${(e as Error).message}) — доступ песочницы к сокету демона не проверен`,
      data: { parsed: false },
    }]
  }
  const reasons = [
    ...(r.networkAccess === true ? [`${r.networkFrom}.network_access = true`] : []),
    ...r.unixSockets,
  ]
  if (reasons.length) {
    return [{
      ...base, status: 'warn',
      detail: `${CODEX_NETWORK_WARNING} (${reasons.join('; ')} в config.toml codex)`,
      fix: 'убери эти настройки из config.toml codex (network_access = false; без unix-сокетов в профиле разрешений)',
      data: { networkAccess: r.networkAccess === true, unixSockets: r.unixSockets },
    }]
  }
  return [{
    ...base, status: 'ok',
    detail: `сеть и unix-сокеты в песочнице выключены: в режимах ${MODES} агент Codex не достанет сокет демона (в «Полном доступе» песочницы нет)`,
    data: { networkAccess: false, unixSockets: [] },
  }]
}
