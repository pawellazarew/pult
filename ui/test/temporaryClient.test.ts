import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PultBridge } from '../../shell/src/contract.js'
import type { TemporaryListReply, TemporarySnapshot } from '../../src/temporary/types.js'
import { TemporaryChatsClient } from '../src/useTemporaryChats.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(fn: () => boolean, timeout = 4500): Promise<void> {
  const deadline = Date.now() + timeout
  while (!fn() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(fn(), 'condition did not settle')
}
const a = 'temporary:00000000-0000-0000-0000-000000000001'
const b = 'temporary:00000000-0000-0000-0000-000000000002'
function snapshot(id = a, epoch = 'epoch-a'): TemporarySnapshot {
  return { id, epoch, title: 'Временный чат', settings: { provider: 'claude' }, status: 'idle', revision: 2,
    draft: { revision: 1, text: 'PRIVATE_CLIENT_DRAFT' },
    messages: [{ id: 'u', turnId: 'turn', role: 'user', text: 'PRIVATE_CLIENT_PROMPT', at: '2026-11-05T00:00:00.000Z', state: 'done' }] }
}
type Call = PultBridge['call']
function fixture(initial: TemporarySnapshot[] = [snapshot()]) {
  let epoch = initial[0]?.epoch ?? 'epoch-a'
  const server = new Map(initial.map((s) => [s.id, s]))
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  const listing = (): TemporaryListReply => ({ epoch, capabilities: [{ provider: 'claude', available: true }],
    chats: [...server.values()].map(({ id, title, settings, status, revision }) => ({ id, title, settings, status, revision })) })
  const base: Call = async (method, params) => {
    if (method === 'temporary.list') return listing()
    if (method === 'temporary.read') {
      const found = server.get(String(params?.['id']))
      if (!found) throw { code: 'not_found' }
      return { epoch, id: found.id, revision: found.revision, unchanged: false, snapshot: structuredClone(found) }
    }
    if (method === 'temporary.remove') { server.delete(String(params?.['id'])); return { removed: true } }
    throw { code: 'internal' }
  }
  let handler: Call = base
  const bridge: Pick<PultBridge, 'call'> = { call: async (method, params) => { calls.push({ method, params }); return handler(method, params) } }
  const client = new TemporaryChatsClient(bridge)
  return { client, server, calls, listing, base, setHandler(value: Call) { handler = value }, setEpoch(value: string) { epoch = value },
    async load(id = a) { client.setOnline(true); await until(() => client.getSnapshot().listing !== null); client.activate(id); await until(() => !!client.getSnapshot().snapshots[id]) },
    close() { client.setOnline(false) } }
}
const who = { epoch: 'epoch-a', id: a }
const isCode = (code: string) => (value: unknown): boolean => !!value && typeof value === 'object' && (value as { code?: string }).code === code

describe('RAM-only temporary chat client', () => {
  it('erases before End ACK, ignores late draft/read replies and keeps the unconfirmed banner until every ACK', async () => {
    const f = fixture([snapshot(), snapshot(b)])
    const endA = deferred<unknown>(), endB = deferred<unknown>(), draft = deferred<unknown>(), read = deferred<unknown>()
    try {
      await f.load()
      let blockRead = false
      f.setHandler(async (method, params) => {
        if (method === 'temporary.remove') return params?.['id'] === a ? endA.promise : endB.promise
        if (method === 'temporary.draft') return draft.promise
        if (method === 'temporary.read' && blockRead) return read.promise
        return f.base(method, params)
      })
      const writing = f.client.draft({ ...who, text: 'PRIVATE_LATE_ACK', baseDraftRevision: 1 })
      blockRead = true
      const polling = f.client.refresh()
      await until(() => f.calls.filter((call) => call.method === 'temporary.read').length >= 2)
      const removingA = f.client.remove(who), removingB = f.client.remove({ ...who, id: b })
      assert.deepEqual(f.client.getSnapshot().snapshots, {})
      assert.equal(f.client.getSnapshot().activeId, null)
      assert.equal(f.client.getSnapshot().error?.code, 'delete_unconfirmed')
      assert.doesNotMatch(JSON.stringify(f.client.getSnapshot()), /PRIVATE_/)
      f.client.clearError()
      assert.equal(f.client.getSnapshot().error?.code, 'delete_unconfirmed')
      draft.resolve({ ...snapshot(), revision: 9, draft: { revision: 2, text: 'PRIVATE_LATE_ACK' } })
      read.resolve({ epoch: 'epoch-a', id: a, revision: 9, unchanged: false, snapshot: snapshot() })
      await assert.rejects(writing, isCode('temporary_expired'))
      await assert.rejects(polling, isCode('temporary_expired'))
      assert.deepEqual(f.client.getSnapshot().snapshots, {})
      endA.resolve({ removed: true })
      await removingA
      assert.equal(f.client.getSnapshot().error?.code, 'delete_unconfirmed')
      endB.resolve({ removed: true })
      await removingB
      assert.equal(f.client.getSnapshot().error, null)
      assert.deepEqual(f.client.getSnapshot().listing?.chats, [])
    } finally { endA.resolve({}); endB.resolve({}); draft.resolve(snapshot()); read.resolve({}); f.close() }
  })

  it('keeps only a pending deletion identity after an RPC failure and retries it on reconnect', async () => {
    const f = fixture()
    let attempts = 0
    try {
      await f.load()
      f.setHandler(async (method, params) => {
        if (method === 'temporary.remove' && ++attempts === 1) throw { code: 'timeout', message: 'PRIVATE_EXCEPTION_PAYLOAD' }
        return f.base(method, params)
      })
      await assert.rejects(f.client.remove(who), isCode('delete_unconfirmed'))
      assert.equal(f.client.getSnapshot().error?.code, 'delete_unconfirmed')
      assert.doesNotMatch(JSON.stringify(f.client.getSnapshot()), /PRIVATE_/)
      f.client.setOnline(false)
      f.client.setOnline(true)
      await until(() => attempts === 2 && f.client.getSnapshot().error === null)
      assert.equal(f.server.has(a), false)
      assert.deepEqual(f.client.getSnapshot().snapshots, {})
      assert.deepEqual(f.client.getSnapshot().listing?.chats, [])
    } finally { f.close() }
  })

  it('forgets pending old-epoch deletions and rejects all late old-epoch ACKs', async () => {
    const f = fixture(), end = deferred<unknown>(), draft = deferred<unknown>()
    try {
      await f.load()
      f.setHandler(async (method, params) => method === 'temporary.remove' ? end.promise : method === 'temporary.draft' ? draft.promise : f.base(method, params))
      const writing = f.client.draft({ ...who, text: 'PRIVATE_OLD_EPOCH', baseDraftRevision: 1 })
      const removing = f.client.remove(who)
      f.setEpoch('epoch-b'); f.server.clear(); f.server.set(b, snapshot(b, 'epoch-b'))
      await f.client.refresh()
      f.client.activate(b)
      await until(() => !!f.client.getSnapshot().snapshots[b])
      draft.resolve(snapshot())
      await assert.rejects(writing, isCode('temporary_expired'))
      end.resolve({ removed: true })
      await removing
      assert.equal(f.client.getSnapshot().activeId, b)
      assert.deepEqual(Object.keys(f.client.getSnapshot().snapshots), [b])
      assert.equal(f.client.getSnapshot().error, null)
      assert.equal(f.calls.filter((call) => call.method === 'temporary.remove').length, 1, 'new daemon data cannot be targeted by old deletion retries')
    } finally { end.resolve({}); draft.resolve(snapshot()); f.close() }
  })

  it('a read not_found after a stale list clears private state and automatic polling continues', async () => {
    const f = fixture()
    try {
      await f.load()
      let stale = true
      const old = f.listing()
      f.server.delete(a)
      f.setHandler(async (method, params) => {
        if (method === 'temporary.list' && stale) { stale = false; return old }
        return f.base(method, params)
      })
      await until(() => f.client.getSnapshot().activeId === null)
      assert.deepEqual(f.client.getSnapshot().snapshots, {})
      assert.doesNotMatch(JSON.stringify(f.client.getSnapshot()), /PRIVATE_/)
      f.server.set(b, snapshot(b))
      await until(() => !!f.client.getSnapshot().listing?.chats.some((chat) => chat.id === b))
      assert.ok(f.calls.filter((call) => call.method === 'temporary.list').length >= 3, 'read not_found must not disable the list method')
    } finally { f.close() }
  })

  it('only a missing list method disables polling and does not retain raw errors', async () => {
    const f = fixture([])
    try {
      f.setHandler(async () => { throw { code: 'not_found', message: 'PRIVATE_UNKNOWN_METHOD_ERROR' } })
      f.client.setOnline(true)
      await until(() => f.client.getSnapshot().error?.code === 'provider_unavailable')
      await new Promise((resolve) => setTimeout(resolve, 1900))
      assert.equal(f.calls.length, 1)
      assert.doesNotMatch(JSON.stringify(f.client.getSnapshot()), /PRIVATE_/)
    } finally { f.close() }
  })

  it('retries a lost start ACK with one request id and canonical settings without browser storage', async () => {
    const f = fixture([])
    let attempts = 0
    const requestIds: unknown[] = []
    try {
      f.client.setOnline(true)
      await until(() => f.client.getSnapshot().listing !== null)
      f.setHandler(async (method, params) => {
        if (method !== 'temporary.start') return f.base(method, params)
        requestIds.push(params?.['requestId']); attempts++
        const created = snapshot()
        f.server.set(a, created)
        if (attempts === 1) throw { code: 'timeout', message: 'PRIVATE_START_EXCEPTION' }
        return { snapshot: created, duplicate: true }
      })
      await f.client.start({ provider: 'claude', model: 'haiku' })
      await f.client.start({ model: 'haiku', provider: 'claude' })
      assert.equal(requestIds.length, 2)
      assert.equal(requestIds[0], requestIds[1])
      assert.equal(f.client.getSnapshot().activeId, a)
      assert.equal(f.client.getSnapshot().listing?.chats.length, 1)
      assert.equal(f.client.getSnapshot().error, null)
    } finally { f.close() }
  })
})
