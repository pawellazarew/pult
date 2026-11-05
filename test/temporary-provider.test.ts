import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, lstatSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createTemporaryProviderFactory, readTemporaryProviderCapabilities } from '../dist/temporary/providers.js'
import { temporaryClaudeArgv, temporaryClaudeInitIsPrivate } from '../dist/temporary/claude.js'
import { createTemporaryWorkspace } from '../dist/temporary/workspaces.js'
import type { TemporaryTransport } from '../dist/temporary/types.js'

const bin = fileURLToPath(new URL('../test/fakes/fake-temporary-claude.mjs', import.meta.url))
const signal = () => new AbortController().signal
const readySignal = () => { let ready!: () => void; const promise = new Promise<void>((resolve) => { ready = resolve }); return { promise, ready } }
const code = (wanted: string) => (error: unknown): boolean => !!error && typeof error === 'object' && (error as { code?: string }).code === wanted && (error as Error).message === wanted
async function fixture(scenario: string, run: (transport: TemporaryTransport, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pt-temp-provider-'))
  const cwd = createTemporaryWorkspace(root)
  writeFileSync(join(cwd, '.pult-temporary-fake.json'), JSON.stringify({ scenario }))
  const factory = createTemporaryProviderFactory({ claudeBin: bin, workspaceRoot: root, workspaceFor: () => cwd, startupTimeoutMs: 1000, interruptTimeoutMs: 80 })
  let transport: TemporaryTransport | null = null
  try { transport = await factory({ provider: 'claude' }, 'private-chat-id'); await run(transport, root) }
  finally { await transport?.close(); rmSync(root, { recursive: true, force: true }) }
}

describe('temporary provider boundary', () => {
  it('requires the audited version and privacy flags; Codex remains explicitly unavailable', async () => {
    assert.deepEqual(await readTemporaryProviderCapabilities({ claudeBin: bin, capabilityTimeoutMs: 15_000 }), [{ provider: 'claude', available: true }, { provider: 'codex', available: false, reason: 'privacy_unverified' }])
    assert.equal((await readTemporaryProviderCapabilities({ claudeBin: null }))[0]?.reason, 'not_installed')
    const root = mkdtempSync(join(tmpdir(), 'pt-temp-version-'))
    try {
      const cli = join(root, 'unverified-cli')
      writeFileSync(cli, '#!/usr/bin/env node\nconsole.log("9.0.0 (Claude Code)")\n', { mode: 0o700 })
      assert.equal((await readTemporaryProviderCapabilities({ claudeBin: cli, capabilityTimeoutMs: 15_000 }))[0]?.reason, 'unsupported_version')
      const factory = createTemporaryProviderFactory({ claudeBin: bin, workspaceRoot: root, workspaceFor: () => { throw Error('must not run') } })
      await assert.rejects(factory({ provider: 'codex' }, 'chat'), code('unsupported_provider'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('creates only private flags and never a saved-session resume or host tool bridge', () => {
    const args = temporaryClaudeArgv({ provider: 'claude', model: 'haiku', effort: 'low' })
    for (const flag of ['--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(args.includes(flag))
    assert.equal(args[args.indexOf('--tools') + 1], '')
    assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')
    assert.equal(args[args.indexOf('--setting-sources') + 1], '')
    for (const flag of ['--resume', '--continue', '--add-dir', '--permission-prompt-tool', '--bare']) assert.equal(args.includes(flag), false)
    assert.throws(() => temporaryClaudeArgv({ provider: 'claude', serviceTier: 'fast' }), code('unsupported_provider'))
    assert.throws(() => temporaryClaudeArgv({ provider: 'claude', model: '--resume' }), code('invalid_params'))
    assert.equal(temporaryClaudeInitIsPrivate({ tools: [], mcp_servers: [], skills: [], slash_commands: [], plugins: [{ path: 'builtin', source: 'security@builtin' }] }), true)
    assert.equal(temporaryClaudeInitIsPrivate({ tools: [], mcp_servers: [], skills: [], slash_commands: [], plugins: [{ path: '/external', source: 'security@builtin' }] }), false)
  })
  it('keeps two turns in one live process without duplicate deltas or on-disk prompt text', async () => fixture('normal', async (transport, root) => {
    const marker = 'private-canary-54f65f0d'
    const first: string[] = [], second: string[] = []
    await transport.run(marker, (part) => first.push(part), signal())
    await transport.run('remember the first message', (part) => second.push(part), signal())
    assert.equal(first.join(''), `Temporary reply: ${marker}`)
    assert.equal(second.join(''), `First message: ${marker}; reply: remember the first message`)
    const scan = (dir: string): void => { for (const name of readdirSync(dir)) { const file = join(dir, name), st = lstatSync(file); if (st.isDirectory()) scan(file); else assert.equal(readFileSync(file).includes(Buffer.from(marker)), false) } }
    scan(root)
    assert.equal(transport.alive, true)
  }))
  for (const scenario of ['unsafe-tools', 'unsafe-mcp', 'unsafe-skills', 'unsafe-plugin', 'no-init', 'malformed']) it(`fails closed before exposing content: ${scenario}`, async () => fixture(scenario, async (transport) => {
    const shown: string[] = []
    await assert.rejects(transport.run('PRIVATE_CONTENT', (part) => shown.push(part), signal()), code('provider_unavailable'))
    assert.deepEqual(shown, [])
    assert.equal(transport.alive, false)
  }))
  it('never exposes raw CLI result errors or stderr', async () => fixture('error', async (transport) => {
    const shown: string[] = []
    await assert.rejects(transport.run('PRIVATE_CANARY', (part) => shown.push(part), signal()), code('provider_unavailable'))
    assert.deepEqual(shown, [])
  }))
  it('interrupts the current live turn and can close idempotently', async () => fixture('hang', async (transport) => {
    const controller = new AbortController()
    const started = readySignal()
    const turn = transport.run('sensitive input', () => started.ready(), controller.signal)
    await started.promise
    controller.abort()
    await assert.rejects(turn, code('interrupted'))
    await transport.close(); await transport.close()
    assert.equal(transport.alive, false)
    await assert.rejects(transport.run('after close', () => {}, signal()), code('transport_closed'))
  }))
  it('preserves the live process after a responsive interrupt', async () => fixture('hang-once', async (transport) => {
    const controller = new AbortController()
    const started = readySignal()
    const turn = transport.run('first private message', () => started.ready(), controller.signal)
    await started.promise
    controller.abort()
    await assert.rejects(turn, code('interrupted'))
    assert.equal(transport.alive, true)
    let reply = ''
    await transport.run('continue', (part) => { reply += part }, signal())
    assert.equal(reply, 'First message: first private message; reply: continue')
  }))
  it('strips inherited provider credentials/customization while applying the explicitly selected route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pt-temp-env-'))
    const cwd = createTemporaryWorkspace(root)
    writeFileSync(join(cwd, '.pult-temporary-fake.json'), JSON.stringify({ scenario: 'environment' }))
    let transport: TemporaryTransport | null = null
    try {
      const factory = createTemporaryProviderFactory({ claudeBin: bin, workspaceRoot: root, workspaceFor: () => cwd,
        parentEnv: { ...process.env, ANTHROPIC_API_KEY: 'private-token', ANTHROPIC_BASE_URL: 'https://untrusted.invalid', CLAUDE_CODE_MESSAGING_SOCKET: '/private/other-chat' },
        networkEnvFor: () => ({ HTTPS_PROXY: 'http://127.0.0.1:9876' }),
      })
      transport = await factory({ provider: 'claude' }, 'chat')
      let reply = ''
      await transport.run('private', (part) => { reply += part }, signal())
      assert.deepEqual(JSON.parse(reply), { unsafeEnvironment: false, safeMode: true, proxy: true })
    } finally { await transport?.close(); rmSync(root, { recursive: true, force: true }) }
  })
  it('kills an unresponsive interrupt instead of silently resuming a saved chat', async () => fixture('ignore-interrupt', async (transport) => {
    const controller = new AbortController()
    const started = readySignal()
    const turn = transport.run('private input', () => started.ready(), controller.signal)
    await started.promise
    controller.abort()
    await assert.rejects(turn, code('interrupted'))
    assert.equal(transport.alive, false)
  }))
})
