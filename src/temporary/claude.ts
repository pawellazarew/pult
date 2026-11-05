import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { buildChildEnv } from '../env/allowlist.js'
import { TemporaryChatError } from './types.js'
import type { TemporarySettings, TemporaryTransport } from './types.js'

/** Audited with two live turns and a local transcript/log canary on this exact CLI version. */
export const TEMPORARY_CLAUDE_VERSION = '2.1.317'
export const TEMPORARY_CLAUDE_FLAGS = [
  '--safe-mode', '--no-session-persistence', '--system-prompt-snapshot', '--tools',
  '--disallowedTools', '--strict-mcp-config', '--mcp-config', '--setting-sources',
  '--disable-slash-commands', '--permission-prompts', '--input-format', '--output-format',
] as const

const SYSTEM_PROMPT = 'You are a helpful assistant in a temporary conversation. Answer the user\'s messages. No tools, project context, files, user extensions, or persistent memory are available.'
const MAX_LINE_BYTES = 2 * 1024 * 1024

export interface TemporaryClaudeOptions {
  bin: string
  cwd: string
  settings: TemporarySettings
  parentEnv?: NodeJS.ProcessEnv
  networkEnv?: Record<string, string>
  startupTimeoutMs?: number
  interruptTimeoutMs?: number
}

/** No resume, session file, host MCP, logger, or ordinary adapter is part of this path. */
export function temporaryClaudeArgv(settings: TemporarySettings): string[] {
  if (settings.provider !== 'claude' || settings.serviceTier === 'fast') throw new TemporaryChatError('unsupported_provider')
  if (settings.model !== undefined && (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(settings.model))) throw new TemporaryChatError('invalid_params')
  if (settings.effort !== undefined && !['low', 'medium', 'high', 'max'].includes(settings.effort)) throw new TemporaryChatError('invalid_params')
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--safe-mode', '--no-session-persistence', '--system-prompt-snapshot', 'off',
    '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--disable-slash-commands', '--permission-prompts', 'none',
    '--settings', '{"disableAllHooks":true,"autoMemoryEnabled":false}',
    '--system-prompt', SYSTEM_PROMPT,
    ...(settings.model ? ['--model', settings.model] : []), ...(settings.effort ? ['--effort', settings.effort] : []),
  ]
}

/** Safe-mode keeps provider-built-in modules; only those may remain in the plugin inventory. */
export function temporaryClaudeInitIsPrivate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const init = value as Record<string, unknown>
  if (!['tools', 'mcp_servers', 'skills', 'slash_commands'].every((key) => Array.isArray(init[key]) && init[key].length === 0)) return false
  return Array.isArray(init['plugins']) && init['plugins'].every((plugin: unknown) => {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) return false
    const p = plugin as Record<string, unknown>
    return p['path'] === 'builtin' && typeof p['source'] === 'string' && p['source'].endsWith('@builtin')
  })
}

interface ActiveTurn {
  resolve(): void
  reject(error: TemporaryChatError): void
  onDelta(text: string): void
  signal: AbortSignal
  abort(): void
  textSeen: boolean
  aborted: boolean
  initTimer: ReturnType<typeof setTimeout> | null
  interruptTimer: ReturnType<typeof setTimeout> | null
}

export async function createTemporaryClaudeTransport(options: TemporaryClaudeOptions): Promise<TemporaryTransport> {
  const args = temporaryClaudeArgv(options.settings)
  const env = buildChildEnv(options.parentEnv ?? process.env, {
    ...(options.networkEnv ? { network: options.networkEnv } : {}),
    extra: {
      CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    },
  })
  let child: ChildProcessWithoutNullStreams
  try { child = spawn(options.bin, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }) }
  catch { throw new TemporaryChatError('provider_unavailable') }
  let ended = false
  let unusable = false
  let initialized = false
  let buffer = ''
  let active: ActiveTurn | null = null
  let closing: Promise<void> | null = null
  let killTimer: ReturnType<typeof setTimeout> | null = null
  const exit = new Promise<void>((resolve) => child.once('close', () => { ended = true; resolve() }))
  // Stderr is drained, never retained or forwarded. It may contain private prompts or auth details.
  child.stderr.resume()
  child.stdout.setEncoding('utf8')
  const settle = (failure?: TemporaryChatError): void => {
    const turn = active
    if (!turn) return
    active = null
    turn.signal.removeEventListener('abort', turn.abort)
    if (turn.initTimer) clearTimeout(turn.initTimer)
    if (turn.interruptTimer) clearTimeout(turn.interruptTimer)
    if (turn.aborted) turn.reject(new TemporaryChatError('interrupted'))
    else if (failure) turn.reject(failure)
    else turn.resolve()
  }
  const kill = (signal: NodeJS.Signals): void => {
    if (ended || !child.pid) return
    try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* already exited */ } }
  }
  const terminate = (): void => {
    unusable = true
    kill('SIGTERM')
    if (!ended && !killTimer) { killTimer = setTimeout(() => kill('SIGKILL'), 1000); killTimer.unref() }
  }
  const failClosed = (): void => { buffer = ''; settle(new TemporaryChatError('provider_unavailable')); terminate() }
  const delta = (text: unknown): void => {
    if (typeof text !== 'string' || !text || !active || active.aborted) return
    if (!initialized) { failClosed(); return }
    try { active.onDelta(text); active.textSeen = true } catch { failClosed() }
  }
  child.once('error', () => { ended = true; settle(new TemporaryChatError('transport_closed')) })
  child.once('close', () => { if (killTimer) clearTimeout(killTimer); settle(new TemporaryChatError('transport_closed')) })
  child.stdin.on('error', () => { settle(new TemporaryChatError('transport_closed')); terminate() })
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { buffer = ''; failClosed(); return }
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let row: Record<string, unknown>
      try {
        const raw: unknown = JSON.parse(line)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { failClosed(); return }
        row = raw as Record<string, unknown>
      } catch { failClosed(); return }
      if (row['type'] === 'system' && row['subtype'] === 'init') {
        if (!temporaryClaudeInitIsPrivate(row)) { failClosed(); return }
        initialized = true
        if (active?.initTimer) { clearTimeout(active.initTimer); active.initTimer = null }
      } else if (row['type'] === 'stream_event') {
        const event = row['event'] as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string; text?: string } } | undefined
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') { failClosed(); return }
        if (event?.type === 'content_block_start' && event.content_block?.type === 'text') delta(event.content_block.text)
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') delta(event.delta.text)
      } else if (row['type'] === 'assistant') {
        const message = row['message'] as { content?: unknown } | undefined
        if (!Array.isArray(message?.content) || message.content.some((part: unknown) => !part || typeof part !== 'object')) { failClosed(); return }
        const content = message.content as Array<{ type?: string; text?: string }>
        if (content.some((part) => part.type === 'tool_use')) { failClosed(); return }
        // Full assistant messages repeat streamed text. Only use them for CLIs without deltas.
        if (active && !active.textSeen) for (const part of content) if (part.type === 'text') delta(part.text)
      } else if (row['type'] === 'result') {
        if (!initialized) { failClosed(); return }
        if (row['is_error'] === true || row['subtype'] !== 'success') settle(new TemporaryChatError('provider_unavailable'))
        else { if (active && !active.textSeen) delta(row['result']); settle() }
      } else if (row['type'] === 'control_request') {
        // This transport exposes no host permission or tool bridge.
        failClosed(); return
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', () => reject(new TemporaryChatError('provider_unavailable')))
  })
  return {
    get alive() { return !ended && !unusable && !closing && child.exitCode === null && child.signalCode === null },
    run(text, onDelta, signal) {
      if (ended || unusable || closing || child.exitCode !== null || child.signalCode !== null) return Promise.reject(new TemporaryChatError('transport_closed'))
      if (active) return Promise.reject(new TemporaryChatError('busy'))
      if (signal.aborted) return Promise.reject(new TemporaryChatError('interrupted'))
      return new Promise<void>((resolve, reject) => {
        const turn: ActiveTurn = {
          resolve, reject, onDelta, signal, textSeen: false, aborted: false, initTimer: null, interruptTimer: null,
          abort() {
            if (active !== turn || turn.aborted) return
            turn.aborted = true
            try { child.stdin.write(JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }) + '\n') }
            catch { settle(new TemporaryChatError('interrupted')); terminate(); return }
            turn.interruptTimer = setTimeout(() => { settle(new TemporaryChatError('interrupted')); terminate() }, options.interruptTimeoutMs ?? 1500)
          },
        }
        active = turn
        signal.addEventListener('abort', turn.abort, { once: true })
        if (!initialized) turn.initTimer = setTimeout(failClosed, options.startupTimeoutMs ?? 15_000)
        try { child.stdin.write(JSON.stringify({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n') }
        catch { settle(new TemporaryChatError('transport_closed')); terminate() }
      })
    },
    close() {
      if (closing) return closing
      closing = (async () => {
        settle(new TemporaryChatError('transport_closed'))
        if (ended) return
        child.stdin.end()
        terminate()
        await exit
      })()
      return closing
    },
  }
}
