// Поиск CLI. Перенесено из spike/env/locate-cli.mjs (проверка S9b).
//
// ПОЧЕМУ вообще нужен поиск: 6 из 7 нужных CLI не видны в PATH службы launchd
// (DELTA v0.4 §4). Полагаться на `which` в окружении демона нельзя.
// ПОРЯДОК кандидатов у `claude`: `/opt/homebrew/bin/claude` стоит РАНЬШЕ
// `~/.claude/local/claude` — прямое требование DELTA v0.4 §4.
// У `codex` два пути ВНУТРИ ChatGPT.app: ChatGPT.app 26.924 (27.09.2026) перенёс бинарь из
// `Contents/Resources/codex` в `Contents/Resources/codex-cli/bin/codex`, и симлинк
// `~/.local/bin/codex` повис. Новый путь стоит раньше старого (старый остаётся ради прежних
// версий приложения): при повисшем симлинке Пульт находит бинарь напрямую, а не теряет codex.
// Файловая система и запуск процессов инъецируются: тест подсовывает фальшивое дерево и
// фальшивые версии, не трогая машину.
//
// ТРИ ВХОДА, И ВЫБОР МЕЖДУ НИМИ — НЕ ВКУС (замер 30.09.2026, настоящий launchd):
//   * `locateToolPath` — только путь, НИ ОДНОГО процесса. Им пользуется старт демона: ему нужен
//     бинарь, а не его версия. Прежний `locateTool('claude').path` запускал `claude --version` и
//     `codex --version` ДО `listen` — под службой с фоновым приоритетом эти два запуска занимали
//     до 6 с (рабочая служба стартовала 11 с), и на это время сокета не было вовсе.
//   * `locateToolAsync` / `locateAllAsync` — путь и версия без остановки событийного цикла,
//     версии спрашиваются разом. Это вход доктора: `doctor.run` идёт в процессе демона.
//   * `locateTool` / `locateAll` — синхронные, для CLI и скриптов. В демоне их звать нельзя.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildChildEnv } from './allowlist.js'
import { execAsync } from './exec.js'

export type ToolName = 'claude' | 'codex' | 'opencode' | 'zcode' | 'git' | 'gh' | 'node' | 'npm'

export const TOOLS: readonly ToolName[] = ['claude', 'codex', 'opencode', 'zcode', 'git', 'gh', 'node', 'npm']

export const VERSION_ARGV: Record<ToolName, string[]> = {
  claude: ['--version'],
  codex: ['--version'],
  opencode: ['--version'],
  zcode: ['--version'],
  git: ['--version'],
  gh: ['--version'],
  node: ['-v'],
  npm: ['-v'],
}

/**
 * Где лежит `codex` внутри ChatGPT.app: сначала раскладка 26.924+ (`codex-cli/bin/codex`),
 * потом прежняя. Порядок значим — см. шапку.
 */
export const CHATGPT_CODEX_PATHS = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex',
] as const

/**
 * Где лежит `zcode` внутри ZCode.app: это node-скрипт с shebang (`#!/usr/bin/env node`), так что
 * путь ЗАПУСКАЕТСЯ напрямую — без обёртки `node <bin>`. Путь плывёт за обновлениями ZCode.app
 * (грабля ChatGPT.app/codex повторяется), поэтому симлинк `~/.local/bin/zcode` стоит первым,
 * а прямой путь в .app — запасным: при повисшем симлинке Пульт находит бинарь сам.
 */
export const ZCODE_APP_PATHS = [
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  join(homedir(), 'Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
] as const

export function candidates(home: string, npmPrefix: string | null): Record<ToolName, string[]> {
  const prefixBin = (name: string): string[] => (npmPrefix ? [join(npmPrefix, 'bin', name)] : [])
  return {
    claude: [
      '/opt/homebrew/bin/claude',
      join(home, '.claude/local/claude'),
      ...prefixBin('claude'),
      '/usr/local/bin/claude',
      join(home, '.local/bin/claude'),
    ],
    codex: [
      join(home, '.local/bin/codex'),
      ...CHATGPT_CODEX_PATHS,
      ...prefixBin('codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ],
    opencode: [
      '/opt/homebrew/bin/opencode',
      join(home, '.local/bin/opencode'),
      join(home, '.opencode/bin/opencode'),
      ...prefixBin('opencode'),
      '/usr/local/bin/opencode',
    ],
    zcode: [
      join(home, '.local/bin/zcode'),
      '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      join(home, 'Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
      '/opt/homebrew/bin/zcode',
      '/usr/local/bin/zcode',
    ],
    git: ['/opt/homebrew/bin/git', '/usr/bin/git', '/usr/local/bin/git'],
    gh: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', join(home, '.local/bin/gh')],
    node: ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
    npm: ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm'],
  }
}

export interface LocatedTool {
  name: ToolName
  path: string | null
  realpath: string | null
  version: string | null
  versionExitCode: number | null
  /** Кандидат нашёлся не в списке, а в PATH логин-шелла. */
  viaPath: boolean
  triedCount: number
}

export interface VersionRun {
  status: number | null
  stdout: string
  stderr: string
}

/** Потолок на `--version`: залипший CLI не держит ни доктора, ни (в синхронном входе) CLI. */
export const VERSION_TIMEOUT_MS = 30_000

export interface LocateDeps {
  isExec?: (p: string) => boolean
  realpath?: (p: string) => string
  run?: (file: string, args: string[]) => VersionRun
  /** Асинхронный запуск `--version` — для `locateToolAsync`; нет — берётся `run`, нет и его — настоящий. */
  runAsync?: (file: string, args: string[]) => Promise<VersionRun>
  home?: string
  pathEntries?: string[]
  npmPrefix?: string | null
}

const defaultIsExec = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const defaultRun = (file: string, args: string[]): VersionRun => {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
    env: buildChildEnv(process.env),
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const defaultRunAsync = (file: string, args: string[]): Promise<VersionRun> =>
  execAsync(file, args, { timeoutMs: VERSION_TIMEOUT_MS, env: buildChildEnv(process.env) })

export interface LocatedPath {
  name: ToolName
  path: string | null
  /** Кандидат нашёлся не в списке, а в PATH логин-шелла. */
  viaPath: boolean
  triedCount: number
}

/**
 * Где лежит CLI — по списку кандидатов, потом по PATH. Только файловая система: ни один
 * процесс не запускается (см. шапку — это вход старта демона).
 */
export function locateToolPath(name: ToolName, deps: LocateDeps = {}): LocatedPath {
  const isExec = deps.isExec ?? defaultIsExec
  const home = deps.home ?? homedir()
  const list = candidates(home, deps.npmPrefix ?? null)[name]
  for (const c of list) {
    if (isExec(c)) return { name, path: c, viaPath: false, triedCount: list.length }
  }
  for (const dir of deps.pathEntries ?? []) {
    const p = join(dir, name)
    if (isExec(p)) return { name, path: p, viaPath: true, triedCount: list.length }
  }
  return { name, path: null, viaPath: false, triedCount: list.length }
}

const notFound = (at: LocatedPath): LocatedTool =>
  ({ name: at.name, path: null, realpath: null, version: null, versionExitCode: null, viaPath: false, triedCount: at.triedCount })

function withVersion(at: LocatedPath & { path: string }, deps: LocateDeps, r: VersionRun): LocatedTool {
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p))
  let real: string | null = null
  try { real = realpath(at.path) } catch { real = null }
  const version = ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] ?? null
  return {
    name: at.name,
    path: at.path,
    realpath: real,
    version: version && version.length ? version : null,
    versionExitCode: r.status,
    viaPath: at.viaPath,
    triedCount: at.triedCount,
  }
}

export function locateTool(name: ToolName, deps: LocateDeps = {}): LocatedTool {
  const at = locateToolPath(name, deps)
  if (at.path === null) return notFound(at)
  return withVersion({ ...at, path: at.path }, deps, (deps.run ?? defaultRun)(at.path, VERSION_ARGV[name]))
}

export function locateAll(deps: LocateDeps = {}): Record<ToolName, LocatedTool> {
  const out = {} as Record<ToolName, LocatedTool>
  for (const name of TOOLS) out[name] = locateTool(name, deps)
  return out
}

/** Как `locateTool`, но `--version` не держит событийный цикл. */
export async function locateToolAsync(name: ToolName, deps: LocateDeps = {}): Promise<LocatedTool> {
  const at = locateToolPath(name, deps)
  if (at.path === null) return notFound(at)
  const run = deps.runAsync ?? deps.run ?? defaultRunAsync
  return withVersion({ ...at, path: at.path }, deps, await run(at.path, VERSION_ARGV[name]))
}

/** Все инструменты разом: семь `--version` идут одновременно, а не очередью. */
export async function locateAllAsync(deps: LocateDeps = {}): Promise<Record<ToolName, LocatedTool>> {
  const found = await Promise.all(TOOLS.map((name) => locateToolAsync(name, deps)))
  const out = {} as Record<ToolName, LocatedTool>
  for (const t of found) out[t.name] = t
  return out
}

/**
 * У владельца `~/.local/bin/codex` — симлинк внутрь ChatGPT.app: бинарь меняется с каждым
 * обновлением приложения (DELTA v0.4 §2), а в 26.924 он ещё и переехал внутри пакета.
 * `pult doctor` обязан про это предупреждать при ЛЮБОЙ раскладке. Проверяется и сам путь, и
 * раскрытый: бинарь из списка кандидатов найден напрямую (симлинк повис) — realpath тогда
 * совпадает с путём, а если realpath не раскрылся вовсе, остаётся только путь.
 */
export function codexInsideChatGPTApp(tool: LocatedTool): boolean {
  return [tool.realpath, tool.path].some((p) => typeof p === 'string' && p.includes('/ChatGPT.app/Contents/Resources/'))
}

/**
 * Бинарь zcode найден внутри ZCode.app: обновление приложения меняет его под ногами (а симлинк
 * `~/.local/bin/zcode` может повиснуть) — доктор предупреждает при любой раскладке, как у codex.
 */
export function zcodeInsideApp(tool: LocatedTool): boolean {
  return [tool.realpath, tool.path].some((p) => typeof p === 'string' && p.includes('/ZCode.app/Contents/Resources/'))
}

/**
 * PULT_TEST=1: агентские CLI в тестах НЕ запускаются никогда — ни `claude --version`, ни
 * `claude auth status`, ни генерация схемы codex. Сквозной `pult doctor` (его зовёт install.sh)
 * иначе дёргал бы настоящие CLI машины, на которой идут тесты. node, npm и git безобидны и
 * ищутся по-настоящему; PATH — из окружения, а не логин-шелла (тот читает чужие rc-файлы).
 * Общий для `pult doctor` и `doctor.run` тестового демона: у демона без него `claude --version`
 * и `claude auth status` уходили в настоящий CLI машины. Асинхронный — его зовёт и демон.
 */
export async function testLocate(deps: LocateDeps): Promise<Record<ToolName, LocatedTool>> {
  const found = await Promise.all(TOOLS.map((name): Promise<LocatedTool> => (name === 'node' || name === 'npm' || name === 'git'
    ? locateToolAsync(name, deps)
    : Promise.resolve({ name, path: null, realpath: null, version: null, versionExitCode: null, viaPath: false, triedCount: 0 }))))
  const out = {} as Record<ToolName, LocatedTool>
  for (const t of found) out[t.name] = t
  return out
}
