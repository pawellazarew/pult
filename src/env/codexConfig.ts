// `pult doctor` (0.3.7): сеть в песочнице Codex.
//
// Пока у Codex `workspace-write` без сети, песочница (macOS Seatbelt) не даёт агенту даже `connect()` на unix-сокет
// демона — ни токен, ни ключ вопросов ему не помогут. `sandbox_workspace_write.network_access = true` в
// ~/.codex/config.toml (Пульт его уважает, src/adapters/codex/adapter.ts) эту стену снимает: агент дотянется до сокета.
// Доктор об этом предупреждает. Файл только читается; разбор — ровно этого ключа, без TOML-зависимости.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DoctorItem } from './doctor.js'

/** Где Codex держит config.toml: `$CODEX_HOME/config.toml`, иначе `~/.codex/config.toml`. */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const ch = env['CODEX_HOME']
  return join(ch && ch.trim() ? ch : join(home, '.codex'), 'config.toml')
}

/** Строка без комментария `# …` (решётка внутри кавычек — не комментарий). */
function stripComment(line: string): string {
  let q: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (q) { if (c === '\\' && q === '"') { i++; continue } if (c === q) q = null; continue }
    if (c === '"' || c === "'") q = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}

/** Ключ TOML без кавычек и пробелов вокруг точек: `"a" . b` → `a.b`. */
function normKey(raw: string): string {
  return raw.split('.').map((p) => p.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')).join('.')
}

/**
 * Значение `sandbox_workspace_write.network_access` верхнего уровня: true / false / null (нет ключа или не булево).
 * Понимает три записи: таблицу `[sandbox_workspace_write]`, ключ с точкой и встроенную таблицу `{ network_access = … }`.
 * Профили (`[profiles.x.sandbox_workspace_write]`) не смотрит: Пульт запускает Codex без профиля.
 */
export function codexNetworkAccess(text: string): boolean | null {
  let table = ''
  let found: boolean | null = null
  const bool = (v: string): boolean | null => (v === 'true' ? true : v === 'false' ? false : null)
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue
    const head = /^\[\s*([^\[\]]+?)\s*\]$/.exec(line)
    if (head) { table = normKey(head[1]!); continue }
    if (/^\[\[/.test(line)) { table = '\u0000'; continue }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = normKey(line.slice(0, eq))
    const value = line.slice(eq + 1).trim()
    const full = table ? `${table}.${key}` : key
    if (full === 'sandbox_workspace_write.network_access') {
      const b = bool(value)
      if (b !== null) found = b
    } else if (full === 'sandbox_workspace_write' && value.startsWith('{')) {
      const m = /(?:^|[{,\s])["']?network_access["']?\s*=\s*(true|false)\b/.exec(value)
      if (m) found = m[1] === 'true'
    }
  }
  return found
}

export const CODEX_NETWORK_WARNING = 'песочница Codex с сетью: агент сможет обратиться к демону Пульта'

/** Пункт доктора; файла нет или не читается — пункта нет (Codex не настроен — говорить не о чем). */
export function codexNetworkItems(path: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): DoctorItem[] {
  let text: string
  try { text = read(path) } catch { return [] }
  const on = codexNetworkAccess(text) === true
  return [{
    id: 'codex.network',
    title: 'Песочница Codex и сеть',
    status: on ? 'warn' : 'ok',
    detail: on
      ? `${CODEX_NETWORK_WARNING} (sandbox_workspace_write.network_access = true в config.toml codex)`
      : 'сеть в песочнице workspace-write выключена: агент Codex не достанет сокет демона',
    ...(on ? { fix: 'убери sandbox_workspace_write.network_access = true из config.toml codex (или поставь false)' } : {}),
    data: { networkAccess: on },
  }]
}
