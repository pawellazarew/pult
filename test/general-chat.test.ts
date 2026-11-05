import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { createGeneralWorkspace, validateGeneralWorkspace } from '../dist/sessions/generalWorkspace.js'
import { parseSessions } from '../dist/sessions/registry.js'
import { validateConfig, writeAttachmentRetention } from '../dist/core/config.js'
import { sweepAttachments } from '../dist/core/attachments.js'
import { startTestDaemon, tempHome } from './helpers.js'

type Rec = { name: string; cwd: string; scope?: string; approval?: string; phase?: string; promptSent?: boolean; promptDiffers?: boolean; promptError?: { code: string } }
const invalid = (e: { code?: string }): boolean => e.code === 'invalid_params'

describe('saved conversation without a project', () => {
  it('uses a fresh private neutral workspace; rejects substituted directories', () => {
    const home = tempHome()
    try {
      const a = createGeneralWorkspace(home.paths.home, 'chat')
      const b = createGeneralWorkspace(home.paths.home, 'chat')
      assert.notEqual(a, b, 'reusing a name never reuses previous files')
      assert.equal(statSync(a).mode & 0o777, 0o700)
      validateGeneralWorkspace(home.paths.home, 'chat', a)
      validateGeneralWorkspace(realpathSync(home.paths.home), 'chat', a)
      assert.throws(() => validateGeneralWorkspace(home.paths.home, 'other', a))
      renameSync(a, `${a}-old`)
      symlinkSync(b, a)
      assert.throws(() => validateGeneralWorkspace(home.paths.home, 'chat', a))
      assert.equal(existsSync(b), true)
    } finally { home.remove() }
  })

  it('creates idempotently without cwd, survives restart, never remembers the managed directory', async () => {
    const home = tempHome()
    let daemon = await startTestDaemon(home)
    let client = await connectClient(home.paths, { client: 'shell' })
    try {
      const params = { requestId: randomUUID(), scope: 'general', kind: 'claude', prompt: 'Обсудим идею', rememberAccess: true }
      const first = await client.request('agent.start', params) as Rec
      assert.equal(first.scope, 'general')
      assert.equal(first.approval ?? 'ask', 'ask')
      assert.ok(realpathSync(first.cwd).startsWith(join(realpathSync(home.paths.home), 'conversations') + '/'))
      await client.request('agent.wait', { name: first.name, timeoutMs: 10_000 })
      const again = await client.request('agent.start', params) as Rec
      assert.equal(again.name, first.name)
      assert.equal(again.cwd, first.cwd)
      const folders = await client.request('folders.list') as { folders: Array<{ path: string }> }
      assert.equal(folders.folders.some((f) => f.path === first.cwd), false)
      assert.equal(existsSync(home.paths.newSessionLast), false, 'general does not overwrite remembered project defaults')
      const records = parseSessions(JSON.parse(readFileSync(home.paths.sessions, 'utf8')))
      assert.equal(records[0]?.scope, 'general')
      client.close(); await daemon.stop('restart')
      daemon = await startTestDaemon(home)
      client = await connectClient(home.paths, { client: 'shell' })
      const resumed = await client.request('agent.list') as { sessions: Rec[] }
      assert.equal(resumed.sessions[0]?.cwd, first.cwd)
      await client.request('agent.prompt', { name: first.name, text: 'Продолжим' })
      await client.request('agent.wait', { name: first.name, timeoutMs: 10_000 })
      const history = await client.request('agent.read', { name: first.name, format: 'json' }) as { events: Array<{ kind: string; data: { text?: string } }> }
      assert.deepEqual(history.events.filter((e) => e.kind === 'message.user').map((e) => e.data.text), ['Обсудим идею', 'Продолжим'])
    } finally { client.close(); await daemon.stop('end'); home.remove() }
  })

  it('refuses ambiguous scope and refuses a symlink before a new user message', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home), client = await connectClient(home.paths, { client: 'shell' })
    try {
      for (const extra of [{ cwd: home.paths.home }, { worktree: true }, { scope: 'typo' }]) {
        await assert.rejects(client.request('agent.start', { name: 'chat', kind: 'claude', scope: 'general', ...extra }), invalid)
      }
      const rec = await client.request('agent.start', { name: 'chat', kind: 'claude', scope: 'general' }) as Rec
      renameSync(rec.cwd, `${rec.cwd}-old`)
      symlinkSync(`${rec.cwd}-old`, rec.cwd)
      await assert.rejects(client.request('agent.prompt', { name: 'chat', text: 'не отправлять' }), invalid)
      const history = await client.request('agent.read', { name: 'chat', format: 'json' }) as { events: Array<{ kind: string }> }
      assert.equal(history.events.some((e) => e.kind === 'message.user'), false)
    } finally { client.close(); await daemon.stop('end'); home.remove() }
  })

  it('preserves hashes of pre-upgrade registered project starts', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home), client = await connectClient(home.paths, { client: 'shell' })
    try {
      const cwd = join(home.paths.home, 'legacy-project')
      mkdirSync(cwd)
      const requestId = randomUUID(), params = { requestId, kind: 'claude', cwd }
      const rec = await client.request('agent.start', params) as Rec
      const file = join(home.paths.startJournal, `${requestId}.json`)
      const entry = JSON.parse(readFileSync(file, 'utf8')) as { shape: string }
      entry.shape = createHash('sha256').update(JSON.stringify(['claude', cwd, null, null, 'ask', null, null, null])).digest('hex')
      writeFileSync(file, JSON.stringify(entry))
      const repeated = await client.request('agent.start', { ...params, scope: 'project' }) as Rec
      assert.equal(repeated.name, rec.name)
    } finally { client.close(); await daemon.stop('end'); home.remove() }
  })

  it('keeps old registry records project-scoped', () => {
    const [record] = parseSessions({ sessions: [{ name: 'old', provider: 'claude', cwd: '/existing/project', mode: 'turn' }] })
    assert.equal(record?.scope ?? 'project', 'project')
  })
})

describe('attachment retention setting', () => {
  it('validates strict choices, preserves unknown config, and forever disables sweeping', () => {
    const home = tempHome()
    try {
      assert.equal(validateConfig({}).config.attachments.retentionDays, 30)
      for (const retentionDays of [7, 30, 90, null]) assert.equal(validateConfig({ attachments: { retentionDays } }).config.attachments.retentionDays, retentionDays)
      for (const retentionDays of [0, 8, '7', Infinity, false]) {
        const parsed = validateConfig({ attachments: { retentionDays } })
        assert.equal(parsed.config.attachments.retentionDays, 30)
        assert.ok(parsed.warnings.some((x) => x.includes('retentionDays')))
      }
      writeFileSync(home.paths.config, JSON.stringify({ custom: true, attachments: { custom: 'keep' } }))
      writeAttachmentRetention(home.paths.config, null)
      assert.deepEqual(JSON.parse(readFileSync(home.paths.config, 'utf8')), { custom: true, attachments: { custom: 'keep', retentionDays: null } })
      mkdirSync(join(home.paths.attachments, 'chat'), { recursive: true })
      const file = join(home.paths.attachments, 'chat', 'old.txt')
      writeFileSync(file, 'keep')
      assert.deepEqual(sweepAttachments(home.paths.attachments, Date.now() + 1000 * 86400_000, null), { files: 0, dirs: 0, errors: 0 })
      assert.equal(existsSync(file), true)
    } finally { home.remove() }
  })

  it('settings RPC persists the choice and rejects malformed patches without changing it', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home), client = await connectClient(home.paths, { client: 'shell' })
    try {
      for (const retentionDays of [7, 90, null]) {
        const reply = await client.request('settings.set', { attachments: { retentionDays } }) as { attachments: { retentionDays: number | null } }
        assert.equal(reply.attachments.retentionDays, retentionDays)
      }
      for (const attachments of [{ retentionDays: 8 }, { retentionDays: 30, extra: true }, { wrong: 7 }, null]) await assert.rejects(client.request('settings.set', { attachments }), invalid)
      const reply = await client.request('settings.get') as { attachments: { retentionDays: number | null } }
      assert.equal(reply.attachments.retentionDays, null)
    } finally { client.close(); await daemon.stop('end'); home.remove() }
  })
})
