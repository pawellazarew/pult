// Свои MCP-серверы владельца в сессиях Пульта (О3, docs/14 «Свои MCP-серверы»).
//
// ОТКУДА. Только `~/.claude.json` → `mcpServers` — серверы уровня пользователя (`claude mcp add --scope user`).
// Файл только ЧИТАЕТСЯ: Пульт в него не пишет никогда. Нет файла, кривой JSON, не объект — серверов нет;
// сессия от этого не падает.
//
// ЧЕГО ПОКА НЕТ. Серверов проекта (`.mcp.json` в папке сессии) Пульт не читает вовсе (решение лида
// 15.10.2026): `.mcp.json` лежит в репозитории, это чужой код, а выбор в Пульте идёт по имени — клон с
// сервером `github` в `.mcp.json` запускал бы СВОЮ команду. Вернутся позже с отдельным подтверждением.
//
// ЧТО ПОДКЛЮЧАЕТСЯ. Только имена из `config.json` → `mcp.servers` (окно: «MCP-серверы», RPC `mcp.select`).
// Они кладутся в тот же `--mcp-config`, что и заглушка разрешений, а `--strict-mcp-config` остаётся: набор
// явный, а не «всё, что найдётся». Выбранного имени в файле нет — сервер пропускается (пункт доктора), без
// подстановок. Имена ищутся в словаре без прототипа: `__proto__`, `constructor` — обычные ключи, а не
// унаследованные свойства.
//
// Наружу (`mcp.list`) уходят имя, транспорт и краткое описание — без `env`, заголовков и аргументов: там
// живут токены.

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { MCP_SERVER_NAME_RE } from '../core/config.js'
import { redactString } from '../core/log.js'

export type McpTransport = 'stdio' | 'http' | 'sse'

/** Запись сервера как её понимает `--mcp-config` (тот же формат, что в `~/.claude.json`). */
export type McpServerSpec = Record<string, unknown>

/** Имена, которые заняты Пультом: заглушка разрешений и браузер агента. */
export const RESERVED_MCP_NAMES: ReadonlySet<string> = new Set(['pult', 'pult_browser', 'pult_runtime'])

export interface AvailableServer {
  name: string
  transport: McpTransport
  /** Чем запускается (имя команды) или куда ходит (схема и хост) — без аргументов и секретов. */
  detail: string
}

export interface McpListing {
  servers: AvailableServer[]
  selected: string[]
  /** Выбраны, но в ~/.claude.json их нет: не подключаются. */
  missing: string[]
  /** Что не прочиталось: человеку стоит знать, почему список пуст. */
  warnings: string[]
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * Файл с полем `mcpServers`. Нет файла — пусто без слов; не JSON или не объект — пусто и предупреждение.
 * Словарь — без прототипа, ключи переносятся только собственные (`Object.hasOwn`).
 */
export async function readServersFile(file: string): Promise<{ servers: Record<string, McpServerSpec>; warning?: string }> {
  const servers = Object.create(null) as Record<string, McpServerSpec>
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { servers } : { servers, warning: `${file}: не читается (${code ?? (e as Error).message})` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { servers, warning: `${file}: не разбирается как JSON — серверы оттуда не видны` }
  }
  const root = obj(parsed)
  if (!root) return { servers, warning: `${file}: корень не объект` }
  if (!Object.hasOwn(root, 'mcpServers')) return { servers }
  const map = obj(root['mcpServers'])
  if (!map) return { servers, warning: `${file}: mcpServers не объект` }
  for (const name of Object.keys(map)) {
    const s = obj(map[name])
    if (!s || !MCP_SERVER_NAME_RE.test(name)) continue
    if (transportOf(s) === null) continue
    servers[name] = s
  }
  return { servers }
}

/** Транспорт записи: `type`, а без него — по полям (`command` — stdio, `url` — http). null — запись не годна. */
export function transportOf(s: McpServerSpec): McpTransport | null {
  const type = s['type']
  if (type === 'stdio' || (type === undefined && typeof s['command'] === 'string')) {
    return typeof s['command'] === 'string' && s['command'] ? 'stdio' : null
  }
  if (type === 'http' || type === 'sse' || (type === undefined && typeof s['url'] === 'string')) {
    return typeof s['url'] === 'string' && s['url'] ? (type === 'sse' ? 'sse' : 'http') : null
  }
  return null
}

/** Краткое описание без секретов: имя команды или схема и хост адреса. */
export function describeServer(s: McpServerSpec): string {
  const t = transportOf(s)
  if (t === 'stdio') return redactString(basename(String(s['command'])))
  try {
    const u = new URL(String(s['url']))
    return `${u.protocol}//${u.host}`
  } catch {
    return 'адрес не разобран'
  }
}

/** `mcp.list`: что есть в ~/.claude.json, что выбрано, чего из выбранного там нет. */
export async function listServers(userFile: string, selected: readonly string[]): Promise<McpListing> {
  const r = await readServersFile(userFile)
  const servers: AvailableServer[] = Object.keys(r.servers)
    .filter((name) => !RESERVED_MCP_NAMES.has(name))
    .map((name) => {
      const spec = r.servers[name] as McpServerSpec
      return { name, transport: transportOf(spec) as McpTransport, detail: describeServer(spec) }
    })
  return {
    servers,
    selected: [...selected],
    missing: selected.filter((n) => RESERVED_MCP_NAMES.has(n) || !Object.hasOwn(r.servers, n)),
    warnings: r.warning ? [r.warning] : [],
  }
}

/**
 * Выбранные серверы для `--mcp-config` сессии: имя → запись как есть, только из ~/.claude.json. Имена
 * Пульта (`pult`, `pult_browser`) не подключаются никогда; выбранного имени нет в файле — оно в `missing`.
 */
export async function selectedServers(userFile: string, selected: readonly string[]): Promise<{ servers: Record<string, McpServerSpec>; missing: string[]; warnings: string[] }> {
  const servers = Object.create(null) as Record<string, McpServerSpec>
  if (!selected.length) return { servers, missing: [], warnings: [] }
  const r = await readServersFile(userFile)
  const missing: string[] = []
  for (const name of selected) {
    if (RESERVED_MCP_NAMES.has(name)) continue
    if (Object.hasOwn(r.servers, name)) servers[name] = r.servers[name] as McpServerSpec
    else missing.push(name)
  }
  return { servers, missing, warnings: r.warning ? [r.warning] : [] }
}
