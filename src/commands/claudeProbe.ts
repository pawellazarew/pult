// Снять список «/»-команд Claude без хода модели: `claude -p --input-format stream-json` и управляющий запрос
// `initialize` — CLI отвечает `control_response` со списком `commands` (имя, описание, `argumentHint`, `builtin`).
// ИЗМЕРЕНО (CLI 2.1.318, docs/19): 1,2–3,9 с, ни одного токена, файла разговора в ~/.claude/projects не заводится.
//
// Флаги — минимум, при котором процесс видит ТЕ ЖЕ скиллы, что и ход сессии: та же папка, тот же
// `--setting-sources`. MCP-серверы владельца не поднимаются (`--strict-mcp-config` без `--mcp-config`): списку
// команд они не нужны, а спавн чужих серверов ради подсказки — лишнее. Разрешений спрашивать некому —
// `--permission-prompts none` (ход и так не начинается).

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeCommandsFromInitialize, commandNamesFromFiles, type SlashCommand } from './catalog.js'

export interface ClaudeProbeOptions {
  bin: string
  cwd: string
  env: NodeJS.ProcessEnv
  settingSources?: string
  timeoutMs?: number
  /** Домашняя папка для `~/.claude/commands` (тест подменяет). */
  home?: string
}

export function claudeProbeArgv(settingSources?: string): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--permission-prompts', 'none',
    ...(settingSources ? ['--setting-sources', settingSources] : []),
  ]
}

export const INITIALIZE_REQUEST_ID = 'pult-commands'

export function initializeLine(): string {
  return JSON.stringify({ type: 'control_request', request_id: INITIALIZE_REQUEST_ID, request: { subtype: 'initialize' } }) + '\n'
}

/** Строка stdout → ответ на наш `initialize` (`response.response`), иначе `null`. Ошибка CLI — бросок. */
export function initializeResponseOf(line: string): unknown {
  let ev: Record<string, unknown>
  try { ev = JSON.parse(line) as Record<string, unknown> } catch { return null }
  if (ev['type'] !== 'control_response') return null
  const r = ev['response'] as Record<string, unknown> | undefined
  if (!r || r['request_id'] !== INITIALIZE_REQUEST_ID) return null
  if (r['subtype'] === 'error') throw new Error(`claude initialize: ${String(r['error'] ?? 'ошибка').slice(0, 200)}`)
  return r['response'] ?? {}
}

/** `.claude/commands/**.md` относительными путями (глубина 3, не больше 500 файлов): по ним видно, что это команда. */
export function listCommandFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string, depth: number): void => {
    if (depth > 3 || out.length >= 500) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), r, depth + 1)
      else if (e.name.endsWith('.md')) out.push(r)
    }
  }
  walk(dir, '', 0)
  return out
}

export async function probeClaudeCommands(o: ClaudeProbeOptions): Promise<SlashCommand[]> {
  const home = o.home ?? homedir()
  const commandFiles = commandNamesFromFiles([
    ...listCommandFiles(join(o.cwd, '.claude', 'commands')),
    ...listCommandFiles(join(home, '.claude', 'commands')),
  ])
  const response = await new Promise<unknown>((resolve, reject) => {
    const child = spawn(o.bin, claudeProbeArgv(o.settingSources), { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    let err = ''
    let done = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.stdin?.end() } catch { /* уже закрыт */ }
      // Ответ получен — процессу больше нечего делать; ход он не начинал.
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM') }, 200).unref()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('claude не ответил на initialize вовремя'))), o.timeoutMs ?? 20_000)
    child.on('error', (e) => finish(() => reject(new Error(`claude не запустился: ${e.message}`))))
    child.on('exit', (code) => finish(() => reject(new Error(`claude вышел (${code ?? 'сигнал'}) без списка команд${err ? `: ${err.trim().split('\n').pop()?.slice(0, 200)}` : ''}`))))
    child.stderr?.on('data', (d: Buffer) => { if (err.length < 4000) err += d.toString() })
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let n: number
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n)
        buf = buf.slice(n + 1)
        try {
          const r = initializeResponseOf(line)
          if (r !== null) { finish(() => resolve(r)); return }
        } catch (e) { finish(() => reject(e as Error)); return }
      }
      if (buf.length > 32 * 1024 * 1024) finish(() => reject(new Error('claude: слишком длинная строка ответа')))
    })
    child.stdin?.on('error', () => { /* процесс вышел раньше записи — скажет `exit` */ })
    child.stdin?.write(initializeLine())
  })
  return claudeCommandsFromInitialize(response, { commandFiles })
}
