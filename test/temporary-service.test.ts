import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, it } from 'node:test'
import { createTemporaryChatService, TEMPORARY_LIMITS } from '../dist/temporary/service.js'
import { TemporaryChatError } from '../dist/temporary/types.js'
import type { TemporaryChatService, TemporaryServiceOptions, TemporarySnapshot, TemporaryTransport } from '../dist/temporary/types.js'
import { isSessionName } from '../dist/sessions/registry.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!fn() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(fn(), 'condition did not settle')
}
class FakeTransport implements TemporaryTransport {
  alive = true
  closes = 0
  calls: string[] = []
  action: TemporaryTransport['run'] = async (text, delta) => { delta(`reply:${text}`) }
  async run(text: string, delta: (text: string) => void, signal: AbortSignal): Promise<void> {
    this.calls.push(text)
    await this.action(text, delta, signal)
  }
  async close(): Promise<void> { this.closes++; this.alive = false }
}
function setup(patch: Partial<TemporaryServiceOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'temporary-service-'))
  const transport = new FakeTransport()
  let factories = 0
  const service = createTemporaryChatService({
    workspaceRoot: join(home, 'neutral'),
    capabilities: async () => [{ provider: 'claude', available: true }, { provider: 'codex', available: false, reason: 'privacy_unverified' }],
    factory: async () => { factories++; return transport }, beforeTurn: async () => {}, ...patch,
  })
  return { home, service, transport, factories: () => factories,
    async close() { await service.shutdown(); rmSync(home, { recursive: true, force: true }) } }
}
async function start(service: TemporaryChatService, requestId = 'start-1') {
  return (await service.start({ epoch: service.epoch, requestId, provider: 'claude' })).snapshot
}
function snap(service: TemporaryChatService, id: string): TemporarySnapshot {
  const reply = service.read({ epoch: service.epoch, id })
  assert.equal(reply.unchanged, false)
  if (reply.unchanged) throw new Error('expected snapshot')
  return reply.snapshot
}
const hasCode = (code: string) => (err: unknown): boolean => err instanceof TemporaryChatError && err.code === code && err.message === code
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

describe('temporary RAM-only service', () => {
  it('starts idempotently, exposes fixed summaries, uses a lazy neutral workspace and one live transport', async () => {
    const t = setup()
    try {
      const request = { epoch: t.service.epoch, requestId: 'same-start', provider: 'claude' as const }
      const [a, b] = await Promise.all([t.service.start(request), t.service.start(request)])
      assert.equal(a.snapshot.id, b.snapshot.id)
      assert.deepEqual([a.duplicate, b.duplicate], [false, true])
      assert.equal(isSessionName(a.snapshot.id), false)
      assert.equal(t.factories(), 0)
      assert.throws(() => t.service.workspaceFor(a.snapshot.id), hasCode('not_found'))
      const first = t.service.prompt({ epoch: t.service.epoch, id: a.snapshot.id, clientMessageId: 'message-1', text: 'PRIVATE_CANARY_ONE' })
      assert.ok(first.turnId)
      assert.equal(t.service.runningCount(), 1)
      await until(() => t.service.runningCount() === 0)
      const cwd = t.service.workspaceFor(a.snapshot.id)
      assert.match(basename(cwd), /^work-[A-Za-z0-9]{6}$/)
      assert.equal(cwd.includes(a.snapshot.id.split(':')[1]!), false)
      assert.equal(statSync(cwd).mode & 0o777, 0o700)
      t.service.prompt({ epoch: t.service.epoch, id: a.snapshot.id, clientMessageId: 'message-2', text: 'PRIVATE_CANARY_TWO' })
      await until(() => t.service.runningCount() === 0)
      assert.equal(t.factories(), 1, 'a second turn must reuse the live ephemeral transport')
      assert.deepEqual(t.transport.calls, ['PRIVATE_CANARY_ONE', 'PRIVATE_CANARY_TWO'])
      const list = await t.service.list()
      assert.equal(JSON.stringify(list).includes('PRIVATE_CANARY'), false)
      assert.equal(list.chats[0]?.title, 'Временный чат')
      const current = snap(t.service, a.snapshot.id)
      assert.equal(current.messages.length, 4)
      current.messages[0]!.text = 'mutated by caller'
      assert.equal(snap(t.service, a.snapshot.id).messages[0]?.text, 'PRIVATE_CANARY_ONE')
      assert.deepEqual(t.service.read({ epoch: t.service.epoch, id: a.snapshot.id, ifRevision: current.revision }),
        { epoch: t.service.epoch, id: a.snapshot.id, revision: current.revision, unchanged: true })
      assert.deepEqual(files(t.home), [], 'service state and conversation canaries never reach any file')
    } finally { await t.close() }
  })

  it('keeps the authoritative draft with CAS and clears only the exact submitted draft', async () => {
    const gate = deferred<void>(), t = setup({ beforeTurn: () => gate.promise })
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      const saved = t.service.draft({ ...who, text: 'PRIVATE_DRAFT_A', baseDraftRevision: 0 })
      assert.equal(saved.draft.revision, 1)
      assert.throws(() => t.service.draft({ ...who, text: 'overwrite', baseDraftRevision: 0 }), (e) =>
        hasCode('draft_conflict')(e) && (e as TemporaryChatError).currentDraftRevision === 1)
      t.service.draft({ ...who, text: 'NEWER_DRAFT_B', baseDraftRevision: 1 })
      const request = { ...who, clientMessageId: 'send-a', text: 'PRIVATE_DRAFT_A' }
      t.service.prompt(request)
      assert.equal(snap(t.service, a.id).draft.text, 'NEWER_DRAFT_B')
      assert.equal(t.service.prompt(request).duplicate, true)
      assert.equal(snap(t.service, a.id).draft.text, 'NEWER_DRAFT_B')
      gate.resolve()
      await until(() => t.service.runningCount() === 0)
      t.service.prompt({ ...who, clientMessageId: 'send-b', text: 'NEWER_DRAFT_B' })
      assert.deepEqual(snap(t.service, a.id).draft, { text: '', revision: 3 })
      await until(() => t.service.runningCount() === 0)
      assert.deepEqual(files(t.home), [])
    } finally { gate.resolve(); await t.close() }
  })

  it('returns one receipt during a busy turn, refuses changed retries and overlapping new turns', async () => {
    const pending = deferred<void>(), t = setup()
    t.transport.action = async (_text, _delta, signal) => {
      signal.addEventListener('abort', () => pending.resolve(), { once: true })
      await pending.promise
    }
    try {
      const a = await start(t.service), request = { epoch: t.service.epoch, id: a.id, clientMessageId: 'm', text: 'PRIVATE_PROMPT' }
      const first = t.service.prompt(request)
      await until(() => t.transport.calls.length === 1)
      const second = t.service.prompt(request)
      assert.equal(second.duplicate, true)
      assert.equal(first.turnId, second.turnId)
      assert.throws(() => t.service.prompt({ ...request, text: 'different' }), hasCode('invalid_params'))
      assert.throws(() => t.service.prompt({ ...request, clientMessageId: 'new' }), hasCode('busy'))
      const stopped = await t.service.stop({ epoch: t.service.epoch, id: a.id })
      assert.equal(stopped.status, 'interrupted')
      assert.equal(t.service.runningCount(), 0)
      assert.deepEqual(t.transport.calls, ['PRIVATE_PROMPT'])
    } finally { pending.resolve(); await t.close() }
  })

  it('still stops safely when the snapshot has no ordinary growth budget left', async () => {
    const pending = deferred<void>(), t = setup({ limits: { maxSnapshotBytes: 1600 } })
    t.transport.action = async (_text, _delta, signal) => {
      signal.addEventListener('abort', () => pending.resolve(), { once: true })
      await pending.promise
    }
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'hello' })
      await until(() => t.transport.calls.length === 1)
      let revision = 0, text = ''
      for (;;) {
        try {
          const next = t.service.draft({ ...who, text: text + 'x', baseDraftRevision: revision })
          revision = next.draft.revision; text += 'x'
        } catch (e) { assert.ok(hasCode('memory_limit')(e)); break }
      }
      const stopped = await t.service.stop(who)
      assert.equal(stopped.status, 'interrupted')
      assert.ok(Buffer.byteLength(JSON.stringify(stopped)) <= 1600)
      assert.equal(t.service.runningCount(), 0)
    } finally { pending.resolve(); await t.close() }
  })

  it('runs the current guard before every turn and never forwards raw guard/provider exceptions', async () => {
    let checks = 0
    const t = setup({ beforeTurn: async (_provider, id) => {
      assert.match(id, /^temporary:/)
      checks++
      if (checks === 1) throw { code: 'blocked_network', message: 'PRIVATE_GUARD_ERROR' }
    } })
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      t.service.prompt({ ...who, clientMessageId: 'one', text: 'one' })
      await until(() => t.service.runningCount() === 0)
      assert.equal(t.factories(), 0)
      assert.deepEqual(snap(t.service, a.id).error, { code: 'blocked_network' })
      t.service.prompt({ ...who, clientMessageId: 'two', text: 'two' })
      await until(() => t.service.runningCount() === 0)
      assert.equal(checks, 3, 'new transport creation is followed by a second guard before private input')
      t.transport.action = async () => { throw new Error('PRIVATE_PROVIDER_STDERR') }
      t.service.prompt({ ...who, clientMessageId: 'three', text: 'three' })
      await until(() => t.service.runningCount() === 0)
      const result = snap(t.service, a.id)
      assert.deepEqual(result.error, { code: 'provider_unavailable' })
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_GUARD_ERROR|PRIVATE_PROVIDER_STDERR/)
      assert.deepEqual(files(t.home), [])
    } finally { await t.close() }
  })

  it('cancels during a slow guard without spawning and does not let the late check resume work', async () => {
    const check = deferred<void>(), t = setup({ beforeTurn: () => check.promise })
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'PRIVATE_CANCELLED' })
      await new Promise((resolve) => setImmediate(resolve))
      const stopped = await t.service.stop(who)
      assert.equal(stopped.status, 'interrupted')
      assert.equal(t.service.runningCount(), 0)
      check.resolve()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(t.factories(), 0)
      assert.equal(snap(t.service, a.id).messages[1]?.text, '')
    } finally { check.resolve(); await t.close() }
  })

  it('erases RAM before asynchronous close, ignores late output and makes remove idempotent', async () => {
    const running = deferred<void>(), closing = deferred<void>(), t = setup()
    let delta: ((text: string) => void) | undefined
    t.transport.action = async (_text, onDelta) => { delta = onDelta; await running.promise }
    t.transport.close = async () => { t.transport.closes++; t.transport.alive = false; await closing.promise }
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'PRIVATE_ERASE' })
      await until(() => delta !== undefined)
      const cwd = t.service.workspaceFor(a.id), removal = t.service.remove(who)
      assert.throws(() => snap(t.service, a.id), hasCode('not_found'))
      assert.equal(t.service.runningCount(), 0)
      assert.deepEqual((await t.service.list()).chats, [])
      delta!('PRIVATE_LATE_REPLY')
      closing.resolve()
      assert.deepEqual(await removal, { removed: true })
      running.resolve()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(existsSync(cwd), false)
      assert.deepEqual(await t.service.remove(who), { removed: false })
      assert.deepEqual(files(t.home), [])
      assert.throws(() => t.service.start({ epoch: t.service.epoch, requestId: 'start-1', provider: 'claude' }), hasCode('not_found'))
    } finally { closing.resolve(); running.resolve(); await t.close() }
  })

  it('closes a late-created transport after removal, without ever calling run', async () => {
    const opening = deferred<TemporaryTransport>(), transport = new FakeTransport()
    let called = false
    const t = setup({ factory: async () => { called = true; return opening.promise } })
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'PRIVATE_OPENING' })
      await until(() => called)
      const cwd = t.service.workspaceFor(a.id)
      await t.service.remove(who)
      opening.resolve(transport)
      await until(() => transport.closes > 0)
      assert.deepEqual(transport.calls, [])
      assert.equal(existsSync(cwd), false)
      assert.deepEqual((await t.service.list()).chats, [])
    } finally { opening.resolve(transport); await t.close() }
  })

  it('marks a dead transport closed and never recreates or resumes its provider context', async () => {
    const t = setup()
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'hello' })
      await until(() => t.service.runningCount() === 0)
      t.transport.alive = false
      assert.equal(snap(t.service, a.id).status, 'closed')
      assert.throws(() => t.service.prompt({ ...who, clientMessageId: 'm2', text: 'again' }), hasCode('transport_closed'))
      assert.throws(() => t.service.draft({ ...who, text: 'again', baseDraftRevision: 0 }), hasCode('transport_closed'))
      assert.equal(t.factories(), 1)
    } finally { await t.close() }
  })

  it('allows configuration only before the first prompt and rejects unsupported/extra capabilities', async () => {
    const t = setup()
    try {
      await assert.rejects(async () => t.service.start({ epoch: t.service.epoch, requestId: 'codex', provider: 'codex' }), hasCode('provider_unavailable'))
      assert.throws(() => t.service.start({ epoch: t.service.epoch, requestId: 'bad', provider: 'claude', cwd: '/project' } as never), hasCode('invalid_params'))
      assert.throws(() => t.service.start({ epoch: t.service.epoch, requestId: 'bad', provider: 'claude', model: 'haiku\nsecret' }), hasCode('invalid_params'))
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      const configured = await t.service.configure({ ...who, settings: { provider: 'claude', model: 'haiku', effort: 'low' } })
      assert.deepEqual(configured.settings, { provider: 'claude', model: 'haiku', effort: 'low' })
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'hello' })
      await assert.rejects(t.service.configure({ ...who, settings: { provider: 'claude', model: 'sonnet' } }), hasCode('configure_locked'))
      await until(() => t.service.runningCount() === 0)
    } finally { await t.close() }
  })

  it('does not apply a late configuration over settings captured by the first prompt', async () => {
    const capability = deferred<readonly [{ readonly provider: 'claude'; readonly available: true }]>()
    let gated = false
    const t = setup({ capabilities: async () => gated ? capability.promise : [{ provider: 'claude', available: true }] })
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      gated = true
      const configuring = t.service.configure({ ...who, settings: { provider: 'claude', model: 'sonnet' } })
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'hello' })
      capability.resolve([{ provider: 'claude', available: true }])
      await assert.rejects(configuring, hasCode('configure_locked'))
      await until(() => t.service.runningCount() === 0)
      assert.deepEqual(snap(t.service, a.id).settings, { provider: 'claude' })
    } finally { capability.resolve([{ provider: 'claude', available: true }]); await t.close() }
  })

  it('does not register a late start after shutdown', async () => {
    const capability = deferred<readonly [{ readonly provider: 'claude'; readonly available: true }]>()
    const t = setup({ capabilities: () => capability.promise })
    try {
      const pending = start(t.service)
      await t.service.shutdown()
      capability.resolve([{ provider: 'claude', available: true }])
      await assert.rejects(pending, hasCode('shutting_down'))
      assert.equal(t.service.runningCount(), 0)
      assert.deepEqual(files(t.home), [])
    } finally { capability.resolve([{ provider: 'claude', available: true }]); await t.close() }
  })

  it('bounds live/pending starts, all start receipts including deletion tombstones, and prompt receipts', async () => {
    const gate = deferred<readonly [{ readonly provider: 'claude'; readonly available: true }]>()
    const t = setup({ limits: { maxChats: 1, maxStartReceipts: 2, maxPromptReceipts: 1 }, capabilities: () => gate.promise })
    try {
      const pending = t.service.start({ epoch: t.service.epoch, requestId: 'first', provider: 'claude' })
      assert.throws(() => t.service.start({ epoch: t.service.epoch, requestId: 'second', provider: 'claude' }), hasCode('memory_limit'))
      gate.resolve([{ provider: 'claude', available: true }])
      const a = (await pending).snapshot, who = { epoch: t.service.epoch, id: a.id }
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'hello' })
      await until(() => t.service.runningCount() === 0)
      assert.throws(() => t.service.prompt({ ...who, clientMessageId: 'm2', text: 'hello' }), hasCode('memory_limit'))
      assert.equal(t.service.prompt({ ...who, clientMessageId: 'm', text: 'hello' }).duplicate, true)
      await t.service.remove(who)
      const b = await start(t.service, 'second')
      await t.service.remove({ epoch: t.service.epoch, id: b.id })
      assert.throws(() => t.service.start({ epoch: t.service.epoch, requestId: 'third', provider: 'claude' }), hasCode('memory_limit'))
    } finally { gate.resolve([{ provider: 'claude', available: true }]); await t.close() }
  })

  it('accounts serialized UTF-8/JSON budgets, aborts overflow, and refuses global growth without eviction', async () => {
    const t = setup({ limits: { maxSnapshotBytes: 1400, maxTotalBytes: 3500, maxTextBytes: 512 } })
    t.transport.action = async (_text, delta, signal) => {
      delta('PRIVATE_OVERFLOW'.repeat(1000))
      assert.equal(signal.aborted, true)
    }
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      assert.throws(() => t.service.draft({ ...who, text: '🧪'.repeat(129), baseDraftRevision: 0 }), hasCode('memory_limit'))
      assert.throws(() => t.service.draft({ ...who, text: '\u0000'.repeat(200), baseDraftRevision: 0 }), hasCode('memory_limit'), 'JSON escaping counts, not JS string.length')
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'allowed' })
      await until(() => t.service.runningCount() === 0)
      const result = snap(t.service, a.id)
      assert.equal(result.status, 'closed')
      assert.deepEqual(result.error, { code: 'memory_limit' })
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1400)
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OVERFLOW/)
      const b = await start(t.service, 'global-two'), bWho = { epoch: t.service.epoch, id: b.id }
      t.service.draft({ ...bWho, text: 'b'.repeat(400), baseDraftRevision: 0 })
      let refused = false
      for (let n = 3; n <= 8; n++) {
        try { await start(t.service, `global-${n}`) } catch (e) { assert.ok(hasCode('memory_limit')(e)); refused = true; break }
      }
      assert.equal(refused, true, 'global bytes refuse growth before the separate eight-chat limit')
      const list = await t.service.list()
      assert.ok(list.chats.length < 8)
      assert.deepEqual(list.chats.slice(0, 2).map((c) => c.id), [a.id, b.id], 'limits never evict older conversations')
    } finally { await t.close() }
  })

  it('loses all state on a new daemon epoch and closes all transports on shutdown', async () => {
    const t = setup()
    let replacement: TemporaryChatService | undefined
    try {
      const a = await start(t.service), who = { epoch: t.service.epoch, id: a.id }
      t.service.draft({ ...who, text: 'PRIVATE_RESTART_DRAFT', baseDraftRevision: 0 })
      t.service.prompt({ ...who, clientMessageId: 'm', text: 'PRIVATE_RESTART_PROMPT' })
      await until(() => t.service.runningCount() === 0)
      const cwd = t.service.workspaceFor(a.id)
      await t.service.shutdown()
      assert.equal(t.transport.alive, false)
      assert.equal(t.service.runningCount(), 0)
      assert.equal(existsSync(cwd), false)
      replacement = createTemporaryChatService({ workspaceRoot: join(t.home, 'neutral'), beforeTurn: async () => {},
        capabilities: async () => [], factory: async () => new FakeTransport() })
      assert.notEqual(replacement.epoch, t.service.epoch)
      assert.deepEqual((await replacement.list()).chats, [])
      assert.throws(() => replacement!.read(who), hasCode('temporary_expired'))
      assert.throws(() => replacement!.start({ epoch: who.epoch, requestId: 'start-1', provider: 'claude' }), hasCode('temporary_expired'))
      for (const file of files(t.home)) assert.doesNotMatch(readFileSync(file, 'utf8'), /PRIVATE_RESTART/)
      assert.equal(TEMPORARY_LIMITS.maxStartReceipts, 1024)
    } finally { await replacement?.shutdown(); await t.close() }
  })
})
