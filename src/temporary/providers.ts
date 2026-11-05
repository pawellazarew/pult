import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildChildEnv } from '../env/allowlist.js'
import { createTemporaryClaudeTransport, TEMPORARY_CLAUDE_FLAGS, TEMPORARY_CLAUDE_VERSION } from './claude.js'
import { TemporaryChatError } from './types.js'
import type { TemporaryCapability, TemporaryTransportFactory } from './types.js'
import { validateTemporaryWorkspace } from './workspaces.js'

const exec = promisify(execFile)
export interface TemporaryProviderOptions {
  claudeBin: string | null
  workspaceRoot: string
  workspaceFor(id: string): string
  parentEnv?: NodeJS.ProcessEnv
  networkEnv?: Record<string, string>
  networkEnvFor?(id: string): Record<string, string>
  capabilityTimeoutMs?: number
  startupTimeoutMs?: number
  interruptTimeoutMs?: number
}

/** Capability probes never include chat text and never load a saved conversation. */
export async function readTemporaryProviderCapabilities(options: Pick<TemporaryProviderOptions, 'claudeBin' | 'parentEnv' | 'capabilityTimeoutMs'>): Promise<TemporaryCapability[]> {
  const codex: TemporaryCapability = { provider: 'codex', available: false, reason: 'privacy_unverified' }
  if (!options.claudeBin) return [{ provider: 'claude', available: false, reason: 'not_installed' }, codex]
  const env = buildChildEnv(options.parentEnv ?? process.env, { extra: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  try {
    const { stdout: version } = await exec(options.claudeBin, ['--version'], { env, timeout: options.capabilityTimeoutMs ?? 5000, maxBuffer: 64 * 1024 })
    if (version.trim().split(/\s+/, 1)[0] !== TEMPORARY_CLAUDE_VERSION) return [{ provider: 'claude', available: false, reason: 'unsupported_version' }, codex]
    const { stdout: help } = await exec(options.claudeBin, ['--help'], { env, timeout: options.capabilityTimeoutMs ?? 5000, maxBuffer: 1024 * 1024 })
    const privateFlags = TEMPORARY_CLAUDE_FLAGS.every((flag) => help.includes(flag))
    return [{ provider: 'claude', available: privateFlags, ...(!privateFlags ? { reason: 'privacy_unverified' as const } : {}) }, codex]
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return [{ provider: 'claude', available: false, reason: code === 'ENOENT' ? 'not_installed' : 'temporarily_unavailable' }, codex]
  }
}

export function createTemporaryProviderFactory(options: TemporaryProviderOptions): TemporaryTransportFactory {
  return async (settings, id) => {
    if (settings.provider !== 'claude') throw new TemporaryChatError('unsupported_provider')
    // Re-check the binary before each new process: an update at the same path invalidates the audit.
    const capability = (await readTemporaryProviderCapabilities(options)).find((entry) => entry.provider === settings.provider)
    if (!capability?.available || !options.claudeBin) throw new TemporaryChatError('provider_unavailable')
    const cwd = options.workspaceFor(id)
    validateTemporaryWorkspace(options.workspaceRoot, cwd)
    const networkEnv = options.networkEnvFor?.(id) ?? options.networkEnv
    return createTemporaryClaudeTransport({
      bin: options.claudeBin, cwd, settings,
      ...(options.parentEnv ? { parentEnv: options.parentEnv } : {}), ...(networkEnv ? { networkEnv } : {}),
      ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
      ...(options.interruptTimeoutMs !== undefined ? { interruptTimeoutMs: options.interruptTimeoutMs } : {}),
    })
  }
}
