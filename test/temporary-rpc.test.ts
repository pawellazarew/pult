import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import type { Client } from '../dist/cli/client.js'
import { startDaemon } from '../dist/daemon/server.js'
import type { DaemonHandle, DaemonOptions } from '../dist/daemon/server.js'
import type { NetCheck } from '../dist/env/net.js'
import type { PultEvent } from '../dist/core/events.js'
import { PROTOCOL_VERSION } from '../dist/core/rpc.js'
import { refuseRunningTurns } from '../dist/update/update.js'
import { publicOf, signEnvelope } from '../dist/update/manifest.js'
import type { HttpGet } from '../dist/update/fetch.js'
import type { ApplyChild } from '../dist/update/checker.js'
import type { TemporaryCapability, TemporaryListReply, TemporaryReadReply, TemporarySnapshot, TemporaryStartReply, TemporaryTransport, TemporaryTransportFactory } from '../dist/temporary/types.js'
import { CLI_ENTRY, FAKE_CLAUDE, FAKE_CODEX, FAKE_ZCODE, rawConnect, tempHome, waitFor, workIn } from './helpers.js'
import type { TempHome } from './helpers.js'

const capabilities = async (): Promise<TemporaryCapability[]> => [{ provider: 'claude', available: true }, { provider: 'codex', available: false, reason: 'privacy_unverified' }]
const netResult = (ok = true, proxy: string | null = null): NetCheck => ({ provider: 'claude', mode: 'auto', path: proxy ? 'proxy' : 'direct', proxy, loc: 'FI', ok, reason: ok ? 'ok' : 'blocked_country', fellBack: false, guard: ['RU'], attempts: [], ms: 0, checkedAt: new Date().toISOString(), cached: false } as NetCheck)
const errorCode = (code: string) => (error: unknown): boolean => !!error && typeof error === 'object' && (error as { code?: unknown }).code === code
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }

function echoFactory(calls: { factories: number; turns: number }): TemporaryTransportFactory {
  return async () => {
    calls.factories++
    let alive = true
    const messages: string[] = []
    return { get alive() { return alive }, async run(text, onDelta) { calls.turns++; messages.push(text); onDelta(`memory:${messages.join('|')}`) }, async close() { alive = false } }
  }
}
async function daemonIn(home: TempHome, factory: TemporaryTransportFactory, netCheck: () => Promise<NetCheck> = async () => netResult(), updates?: DaemonOptions['updates']): Promise<DaemonHandle> {
  const result = await startDaemon({ paths: home.paths, config: home.config, logger: home.logger, testMode: true,
    claudeBin: FAKE_CLAUDE, codexBin: FAKE_CODEX, zcodeBin: FAKE_ZCODE, cliEntry: CLI_ENTRY,
    temporary: { factory, capabilities }, netCheck, ...(updates ? { updates } : {}),
  })
  assert.equal(result.ok, true)
  if (!result.ok) throw Error('test daemon did not start')
  return result.daemon
}
async function startChat(client: Client, requestId = randomUUID()): Promise<TemporarySnapshot> {
  const list = await client.request('temporary.list') as TemporaryListReply
  return ((await client.request('temporary.start', { epoch: list.epoch, requestId, provider: 'claude' })) as TemporaryStartReply).snapshot
}
async function readChat(client: Client, identity: { epoch: string; id: string }): Promise<TemporarySnapshot> {
  const read = await client.request('temporary.read', identity) as TemporaryReadReply
  assert.equal(read.unchanged, false)
  if (read.unchanged) throw Error('full read required')
  return read.snapshot
}
async function settled(client: Client, identity: { epoch: string; id: string }): Promise<TemporarySnapshot> {
  let snapshot: TemporarySnapshot | undefined
  assert.ok(await waitFor(async () => { snapshot = await readChat(client, identity); return !['starting', 'working', 'stopping'].includes(snapshot.status) }, 5000))
  return snapshot!
}
function assertNoFileText(home: TempHome, ...canaries: string[]): void {
  const scan = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) scan(path)
      else if (stat.isFile()) {
        const contents = readFileSync(path)
        for (const canary of canaries) assert.equal(contents.includes(Buffer.from(canary)), false, `private text leaked to ${path}`)
      }
    }
  }
  scan(home.paths.home)
}

describe('temporary owner RPC privacy boundary', () => {
  it('supports draft CAS, idempotent two-turn memory and a second owner connection without durable traces', async () => {
    const home = tempHome(), calls = { factories: 0, turns: 0 }, daemon = await daemonIn(home, echoFactory(calls))
    let owner = await connectClient(home.paths, { client: 'shell' })
    let second: Client | null = null
    const events: PultEvent[] = []
    const canary = `TEMP_PRIVATE_${randomUUID()}`, draftCanary = `DRAFT_PRIVATE_${randomUUID()}`
    try {
      await owner.subscribe({ since: 0 }, (event) => events.push(event))
      const requestId = randomUUID(), chat = await startChat(owner, requestId), identity = { epoch: chat.epoch, id: chat.id }
      const repeated = await owner.request('temporary.start', { epoch: chat.epoch, requestId, provider: 'claude' }) as TemporaryStartReply
      assert.equal(repeated.duplicate, true); assert.equal(repeated.snapshot.id, chat.id)
      assert.equal(chat.title, 'Временный чат')
      const draft = await owner.request('temporary.draft', { ...identity, baseDraftRevision: 0, text: draftCanary }) as TemporarySnapshot
      assert.equal(draft.draft.revision, 1)
      await assert.rejects(owner.request('temporary.draft', { ...identity, baseDraftRevision: 0, text: 'stale' }), errorCode('draft_conflict'))
      const first = { ...identity, clientMessageId: 'first', text: canary }
      await owner.request('temporary.prompt', first)
      const duplicate = await owner.request('temporary.prompt', first) as { duplicate: boolean }
      assert.equal(duplicate.duplicate, true)
      await settled(owner, identity)
      await owner.request('temporary.prompt', { ...identity, clientMessageId: 'second', text: 'continue' })
      const finished = await settled(owner, identity)
      assert.deepEqual(finished.messages.filter((m) => m.role === 'assistant').map((m) => m.text), [`memory:${canary}`, `memory:${canary}|continue`])
      assert.equal(calls.factories, 1); assert.equal(calls.turns, 2)
      second = await connectClient(home.paths, { client: 'cli' })
      assert.deepEqual(await readChat(second, identity), finished)
      owner.close()
      owner = await connectClient(home.paths, { client: 'shell' })
      assert.equal((await readChat(owner, identity)).messages.length, 4)
      const unchanged = await owner.request('temporary.read', { ...identity, ifRevision: finished.revision }) as TemporaryReadReply
      assert.equal(unchanged.unchanged, true)
      const ordinary = await owner.request('agent.list') as { sessions: unknown[] }
      assert.deepEqual(ordinary.sessions, [])
      const snapshot = await owner.request('events.snapshot')
      const history = await owner.request('events.history', { sessionId: chat.id })
      const search = await owner.request('events.search', { query: canary }) as { results: unknown[] }
      assert.deepEqual(search.results, [])
      for (const value of [snapshot, history, events, daemon.store.readFrom(0)]) {
        assert.equal(JSON.stringify(value).includes(canary), false)
        assert.equal(JSON.stringify(value).includes(draftCanary), false)
        assert.equal(JSON.stringify(value).includes(chat.id), false)
      }
      await assert.rejects(owner.request('agent.export', { name: chat.id }), errorCode('not_found'))
      await assert.rejects(owner.request('agent.read', { name: chat.id, format: 'json' }), errorCode('not_found'))
      assertNoFileText(home, canary, draftCanary, chat.id)
      await owner.request('temporary.remove', identity)
      assert.deepEqual((await second.request('temporary.list') as TemporaryListReply).chats, [])
    } finally { owner.close(); second?.close(); await daemon.stop('temporary-rpc-test'); assertNoFileText(home, canary, draftCanary); home.remove() }
  })

  it('rejects unknown/private-session escape fields and malformed inputs without creating a saved session', async () => {
    const home = tempHome(), calls = { factories: 0, turns: 0 }, daemon = await daemonIn(home, echoFactory(calls)), owner = await connectClient(home.paths)
    try {
      const { epoch } = await owner.request('temporary.list') as TemporaryListReply
      for (const extra of [{ cwd: '/private/project' }, { tools: [] }, { attachments: [] }, { mcp: {} }, { browser: true }, { persist: true }]) {
        await assert.rejects(owner.request('temporary.start', { epoch, requestId: randomUUID(), provider: 'claude', ...extra }), errorCode('invalid_params'))
      }
      await assert.rejects(owner.request('temporary.list', { unexpected: 'secret' }), errorCode('invalid_params'))
      await assert.rejects(owner.request('temporary.unknown', {}), errorCode('invalid_params'))
      const raw = await rawConnect(home.paths)
      try {
        raw.send({ type: 'hello', token: daemon.token, client: 'cli', protocol: PROTOCOL_VERSION })
        assert.equal((await raw.next())['type'], 'hello_ok')
        for (const [index, params] of [null, [], 'not-an-object'].entries()) {
          raw.send({ id: 100 + index, method: 'temporary.list', params })
          const reply = await raw.next()
          assert.equal((reply['error'] as { code?: string }).code, 'invalid_params')
        }
      } finally { raw.end() }
      await assert.rejects(owner.request('temporary.start', { epoch, requestId: randomUUID(), provider: 'zcode' }), errorCode('unsupported_provider'))
      const chat = await startChat(owner), identity = { epoch: chat.epoch, id: chat.id }
      for (const extra of [{ cwd: '/somewhere' }, { attachments: [] }, { tools: ['shell'] }, { queue: true }]) await assert.rejects(owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: 'not sent', ...extra }), errorCode('invalid_params'))
      await assert.rejects(owner.request('temporary.configure', { ...identity, settings: { provider: 'claude', tools: [] } }), errorCode('invalid_params'))
      assert.equal(calls.factories, 0)
      assert.deepEqual((await owner.request('agent.list') as { sessions: unknown[] }).sessions, [])
    } finally { owner.close(); await daemon.stop('temporary-rpc-test'); home.remove() }
  })

  it('does not grant temporary access to permission keys or runtime keys', async () => {
    const home = tempHome(), daemon = await daemonIn(home, echoFactory({ factories: 0, turns: 0 })), owner = await connectClient(home.paths)
    const clients: Awaited<ReturnType<typeof rawConnect>>[] = []
    try {
      await owner.request('agent.start', { name: 'ordinary', kind: 'claude', cwd: workIn(home) })
      const credentials = [{ ask: daemon.askKeys.mint('ordinary') }, { runtime: daemon.runtimes.key('ordinary') }]
      for (const credential of credentials) {
        const raw = await rawConnect(home.paths); clients.push(raw)
        raw.send({ type: 'hello', protocol: PROTOCOL_VERSION, client: 'mcp-ask', ...credential })
        assert.equal((await raw.next())['type'], 'hello_ok')
        for (const [index, method] of ['temporary.list', 'temporary.start', 'temporary.read', 'temporary.prompt', 'temporary.remove'].entries()) {
          raw.send({ id: index + 1, method, params: {} })
          const reply = await raw.next()
          assert.equal((reply['error'] as { code?: string }).code, 'forbidden')
        }
      }
    } finally { for (const client of clients) client.end(); owner.close(); await daemon.stop('temporary-rpc-test'); home.remove() }
  })

  it('keeps factory error details out of RPC, the event bus and every daemon file', async () => {
    const home = tempHome(), canary = `FACTORY_PRIVATE_${randomUUID()}`
    const daemon = await daemonIn(home, async () => { throw Object.assign(Error(canary), { code: 'unsafe-custom-error' }) }), owner = await connectClient(home.paths)
    const events: PultEvent[] = []
    try {
      await owner.subscribe({ since: 0 }, (event) => events.push(event))
      const chat = await startChat(owner), identity = { epoch: chat.epoch, id: chat.id }
      const reply = await owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: 'harmless request' })
      const snapshot = await settled(owner, identity)
      assert.equal(snapshot.error?.code, 'provider_unavailable')
      for (const result of [reply, snapshot, events, await owner.request('events.snapshot')]) assert.equal(JSON.stringify(result).includes(canary), false)
      assertNoFileText(home, canary)
    } finally { owner.close(); await daemon.stop('temporary-rpc-test'); assertNoFileText(home, canary); home.remove() }
  })

  it('ends during streaming, discards late callbacks and removes private busy state from the update gate', async () => {
    const home = tempHome(), pending = deferred(), entered = deferred(), canary = `STREAM_PRIVATE_${randomUUID()}`
    let late: (text: string) => void = () => {}, closed = false
    const daemon = await daemonIn(home, async () => ({ get alive() { return !closed }, async run(_text, onDelta) { late = onDelta; onDelta(canary); entered.resolve(); await pending.promise }, async close() { closed = true } })), owner = await connectClient(home.paths)
    try {
      const chat = await startChat(owner), identity = { epoch: chat.epoch, id: chat.id }
      await owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: canary })
      await entered.promise
      const status = await owner.request('daemon.status') as { turns: number }
      assert.equal(status.turns, 1)
      assert.equal(JSON.stringify(status).includes(chat.id), false)
      const updateLines: string[] = []
      assert.equal(await refuseRunningTurns(home.paths, { out: (line) => updateLines.push(line), err: (line) => updateLines.push(line) }, { force: false }), true)
      assert.match(updateLines.join(''), /1/)
      assertNoFileText(home, canary)
      await owner.request('temporary.remove', identity)
      late(`${canary}_LATE`); pending.resolve()
      assert.equal(closed, true)
      assert.equal((await owner.request('daemon.status') as { turns: number }).turns, 0)
      assert.equal(await refuseRunningTurns(home.paths, { out() {}, err() {} }, { force: false }), false)
      assert.deepEqual((await owner.request('temporary.list') as TemporaryListReply).chats, [])
      await assert.rejects(owner.request('temporary.read', identity), errorCode('not_found'))
      assertNoFileText(home, canary)
    } finally { pending.resolve(); owner.close(); await daemon.stop('temporary-rpc-test'); home.remove() }
  })

  it('counts startup as private busy, then refuses a blocked network before opening any provider', async () => {
    const home = tempHome(), check = deferred(), entered = deferred(), calls = { factories: 0, turns: 0 }
    const daemon = await daemonIn(home, echoFactory(calls), async () => { entered.resolve(); await check.promise; return netResult(false) }), owner = await connectClient(home.paths)
    try {
      const chat = await startChat(owner), identity = { epoch: chat.epoch, id: chat.id }
      await owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: 'guarded private request' })
      await entered.promise
      assert.equal((await owner.request('daemon.status') as { turns: number }).turns, 1)
      assert.equal(calls.factories, 0)
      check.resolve()
      const snapshot = await settled(owner, identity)
      assert.equal(snapshot.error?.code, 'blocked_network')
      assert.equal(calls.factories, 0)
      assert.equal((await owner.request('daemon.status') as { turns: number }).turns, 0)
    } finally { check.resolve(); owner.close(); await daemon.stop('temporary-rpc-test'); home.remove() }
  })

  it('pins the initial route and refuses a later route change without another provider turn', async () => {
    const home = tempHome(), calls = { factories: 0, turns: 0 }; let proxy: string | null = null
    const daemon = await daemonIn(home, echoFactory(calls), async () => netResult(true, proxy)), owner = await connectClient(home.paths)
    try {
      const chat = await startChat(owner), identity = { epoch: chat.epoch, id: chat.id }
      await owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: 'first route' }); await settled(owner, identity)
      proxy = 'http://127.0.0.1:9876'
      await owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: 'changed route' })
      assert.equal((await settled(owner, identity)).error?.code, 'blocked_network')
      assert.equal(calls.factories, 1); assert.equal(calls.turns, 1)
    } finally { owner.close(); await daemon.stop('temporary-rpc-test'); home.remove() }
  })

  it('rejects a guard rule changed while the first network check is awaiting, before factory or run', async () => {
    const home = tempHome(), entered = deferred(), release = deferred(), calls = { factories: 0, turns: 0 }
    const canary = `GUARD_RACE_PRIVATE_${randomUUID()}`
    const daemon = await daemonIn(home, echoFactory(calls), async () => { entered.resolve(); await release.promise; return netResult() }), owner = await connectClient(home.paths)
    try {
      const chat = await startChat(owner), identity = { epoch: chat.epoch, id: chat.id }
      await owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: canary })
      await entered.promise
      await owner.request('settings.set', { network: { guard: { mode: 'allow', countries: ['FI'] } } })
      release.resolve()
      assert.equal((await settled(owner, identity)).error?.code, 'blocked_network')
      assert.equal(calls.factories, 0); assert.equal(calls.turns, 0)
      assertNoFileText(home, canary)
    } finally { release.resolve(); owner.close(); await daemon.stop('temporary-rpc-test'); home.remove() }
  })

  it('rechecks a newly opened transport after a guard generation change and never starts its first run', async () => {
    const home = tempHome(), entered = deferred(), release = deferred(), calls = { factories: 0, turns: 0 }
    const canary = `FACTORY_RACE_PRIVATE_${randomUUID()}`
    const echo = echoFactory(calls)
    const daemon = await daemonIn(home, async (settings, id) => { entered.resolve(); await release.promise; return echo(settings, id) }), owner = await connectClient(home.paths)
    try {
      const chat = await startChat(owner), identity = { epoch: chat.epoch, id: chat.id }
      await owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: canary })
      await entered.promise
      await owner.request('settings.set', { network: { guard: { mode: 'allow', countries: ['FI'] } } })
      release.resolve()
      assert.equal((await settled(owner, identity)).error?.code, 'blocked_network')
      assert.equal(calls.factories, 1); assert.equal(calls.turns, 0)
      assertNoFileText(home, canary)
    } finally { release.resolve(); owner.close(); await daemon.stop('temporary-rpc-test'); home.remove() }
  })

  it('refuses new starts and prompts while applying an update, including an update begun during an awaited guard', async () => {
    const home = tempHome(), calls = { factories: 0, turns: 0 }, entered = deferred(), release = deferred()
    home.config.updates = { check: true, url: 'https://example.invalid/latest.json' }
    const { privateKey } = generateKeyPairSync('ed25519'), pub = publicOf(privateKey)
    const payload = Buffer.from(JSON.stringify({ schema: 1, version: '99.0.0', released: '2026-10-19T10:00:00.000Z', notes: 'https://github.com/pawellazarew/pult/releases/tag/v99.0.0', package: { url: 'https://example.invalid/pult-99.0.0.tgz', sha256: 'c'.repeat(64), size: 10 } }))
    const latest = Buffer.from(signEnvelope(payload, privateKey))
    const http: HttpGet = async () => ({ status: 200, header: () => null, body: (async function* () { yield latest })() })
    class Child extends EventEmitter implements ApplyChild {}
    const children: Child[] = []
    const updates: DaemonOptions['updates'] = { http, keys: [{ id: pub.keyId, publicKey: pub.raw.toString('base64') }], schedule: false, spawnApply: () => { const child = new Child(); children.push(child); return child } }
    const daemon = await daemonIn(home, echoFactory(calls), async () => { entered.resolve(); await release.promise; return netResult() }, updates), owner = await connectClient(home.paths)
    try {
      const chat = await startChat(owner), identity = { epoch: chat.epoch, id: chat.id }
      await owner.request('update.apply', { target: 'package' })
      assert.ok(await waitFor(() => children.length === 1, 5000))
      await assert.rejects(owner.request('temporary.start', { epoch: chat.epoch, requestId: randomUUID(), provider: 'claude' }), errorCode('shutting_down'))
      await assert.rejects(owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: 'not started during update' }), errorCode('shutting_down'))
      assert.equal(calls.factories, 0)
      children[0]!.emit('exit', 1, null)
      await owner.request('temporary.prompt', { ...identity, clientMessageId: randomUUID(), text: 'awaiting guard' })
      await entered.promise
      await owner.request('update.apply', { target: 'package', force: true })
      assert.ok(await waitFor(() => children.length === 2, 5000))
      release.resolve()
      assert.equal((await settled(owner, identity)).error?.code, 'shutting_down')
      assert.equal(calls.factories, 0); assert.equal(calls.turns, 0)
      children[1]!.emit('exit', 1, null)
    } finally { release.resolve(); for (const child of children) child.emit('exit', 1, null); owner.close(); await daemon.stop('temporary-rpc-test'); home.remove() }
  })

  it('forgets every temporary chat on daemon restart and rejects the previous epoch', async () => {
    const home = tempHome(), calls = { factories: 0, turns: 0 }, canary = `RESTART_PRIVATE_${randomUUID()}`
    let daemon = await daemonIn(home, echoFactory(calls)), owner = await connectClient(home.paths)
    try {
      const chat = await startChat(owner), oldIdentity = { epoch: chat.epoch, id: chat.id }
      await owner.request('temporary.draft', { ...oldIdentity, baseDraftRevision: 0, text: canary })
      await owner.request('temporary.prompt', { ...oldIdentity, clientMessageId: randomUUID(), text: canary }); await settled(owner, oldIdentity)
      assertNoFileText(home, canary)
      owner.close(); await daemon.stop('temporary-rpc-restart')
      daemon = await daemonIn(home, echoFactory(calls)); owner = await connectClient(home.paths)
      const fresh = await owner.request('temporary.list') as TemporaryListReply
      assert.notEqual(fresh.epoch, oldIdentity.epoch); assert.deepEqual(fresh.chats, [])
      await assert.rejects(owner.request('temporary.read', oldIdentity), errorCode('temporary_expired'))
      await assert.rejects(owner.request('temporary.prompt', { ...oldIdentity, clientMessageId: randomUUID(), text: 'not restored' }), errorCode('temporary_expired'))
      assert.deepEqual((await owner.request('events.search', { query: canary }) as { results: unknown[] }).results, [])
      assertNoFileText(home, canary)
    } finally { owner.close(); await daemon.stop('temporary-rpc-test'); home.remove() }
  })
})
