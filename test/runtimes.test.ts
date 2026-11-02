import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRuntimeService } from '../dist/runtimes/service.js'
import { runtimeToolResult } from '../dist/runtimes/mcp.js'
import type { RuntimeDeps } from '../dist/runtimes/service.js'
import type { RuntimeResult } from '../dist/runtimes/types.js'
import { connectClient } from '../dist/cli/client.js'
import { startTestDaemon, tempHome, workIn } from './helpers.js'

const device = { id: 'android:emulator-5554', kind: 'android' as const, name: 'Phone', state: 'ready' as const, capabilities: ['screenshot', 'tap'] }
function fixture(overrides: Partial<RuntimeDeps> = {}) {
  const events: unknown[] = []; const actions: string[] = []
  const deps: RuntimeDeps = {
    mobile: async () => ({ targets: [device], setup: [{ id: 'helper', kind: 'ios', title: 'Helper', detail: 'Download helper only', command: 'fixed installer', installable: true }] }),
    performMobile: async (_, action) => { actions.push(action); return { text: 'done' } },
    session: (id) => ['one', 'two'].includes(id) ? { approval: 'full' } : null,
    authorize: async () => false,
    changed: (id, data) => { events.push({ id, data }) },
    ...overrides,
  }
  return { service: createRuntimeService(deps), events, actions }
}
const perform = (action: string, sessionId = 'one') => ({ sessionId, targetId: device.id, action })

test('runtime key is session-scoped, revocable and never grants owner operations', () => {
  const { service: s } = fixture()
  const key = s.key('one')
  assert.equal(s.lookup(key), 'one'); assert.equal(s.key('one'), key)
  assert.equal(s.lookup('é'.repeat(64)), null)
  s.revoke('one'); assert.equal(s.lookup(key), null); assert.notEqual(s.key('one'), key)
})
test('existing target attaches without installing, another session cannot drive it', async () => {
  let installs = 0
  const { service: s, actions } = fixture({ install: async () => { installs++; return {} } })
  await s.perform(perform('attach'), 'agent')
  await assert.rejects(s.perform(perform('tap', 'two'), 'agent'), /занято/)
  assert.deepEqual((await s.discover('one')).attached, [device.id])
  assert.equal(installs, 0); assert.deepEqual(actions, ['screenshot'])
  s.stop()
})
test('takeover invalidates queued agent actions and screenshot never enters event log', async () => {
  let finish: ((r: RuntimeResult) => void) | undefined
  const { service: s, actions, events } = fixture({ performMobile: async (_, action) => {
    actions.push(action)
    if (action === 'screenshot') return { image: { data: 'VERY_SECRET_FRAME', mimeType: 'image/jpeg' } }
    return new Promise<RuntimeResult>((resolve) => { finish = resolve })
  } })
  await s.perform(perform('attach'), 'agent')
  const first = s.perform(perform('tap'), 'agent')
  const second = s.perform(perform('type'), 'agent')
  // Register rejection handlers before releasing the active native call.
  const checked = Promise.all([assert.rejects(first, /Управление/), assert.rejects(second, /Управление/)] )
  for (let n = 0; n < 20 && !finish; n++) await new Promise((r) => setImmediate(r))
  assert.ok(finish)
  s.takeover('one', device.id, 'human'); finish!({})
  await checked
  assert.deepEqual(actions, ['screenshot', 'tap'])
  assert.doesNotMatch(JSON.stringify(events), /VERY_SECRET_FRAME/)
  await assert.rejects(s.perform(perform('tap'), 'agent'), /управление/)
  s.stop()
})
test('setup is opt-in, cannot replace manifest and duplicate pending proposals coalesce', async () => {
  const installed: string[] = []
  const { service: s } = fixture({ install: async (id) => { installed.push(id); return {} } })
  const a = await s.requestSetup('one', 'helper')
  assert.equal((await s.requestSetup('one', 'helper')).id, a.id)
  assert.deepEqual(installed, [])
  await assert.rejects(s.resolveSetup('two', a.id, true), /обработан/)
  await s.resolveSetup('one', a.id, false); assert.deepEqual(installed, [])
  const b = await s.requestSetup('one', 'helper'); await s.resolveSetup('one', b.id, true)
  assert.deepEqual(installed, ['helper'])
  await assert.rejects(s.resolveSetup('one', b.id, true), /обработан/)
})
test('web host jobs belong to their shell and dead host releases requests', async () => {
  const { service: s } = fixture()
  s.poll(1)
  const attached = s.perform({ sessionId: 'one', targetId: 'web:one', action: 'attach' }, 'human')
  let jobs = s.poll(1).jobs
  for (let n = 0; n < 20 && !jobs.length; n++) { await new Promise((r) => setImmediate(r)); jobs = s.poll(1).jobs }
  assert.equal(jobs.length, 1)
  assert.throws(() => s.complete(2, jobs[0]!.id, {}), /принадлежит/)
  s.complete(1, jobs[0]!.id, { url: 'http://localhost:3000' }); await attached
  s.hostGone(99) // An unrelated CLI disconnect must not detach the browser.
  assert.deepEqual((await s.discover('one')).attached, ['web:one'])
  s.hostGone(1)
  assert.deepEqual((await s.discover('one')).attached, [])
  assert.equal((await s.discover('one')).targets[0]?.state, 'unavailable')
  s.stop()
})
test('MCP returns native image content instead of a base64 text dump', () => {
  assert.deepEqual(runtimeToolResult({ text: 'screen', width: 100, image: { data: 'aGVsbG8=', mimeType: 'image/png' } }), { content: [
    { type: 'text', text: '{"text":"screen","width":100}' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ] })
})

test('permission card receives exact immutable app path and URL', async () => {
  const inputs: unknown[] = []
  const { service: s } = fixture({ session: () => ({ approval: 'ask' }), authorize: async (_s, _t, action, input) => { inputs.push({ action, input }); return true } })
  await s.perform(perform('attach'), 'agent')
  await s.perform({ ...perform('install'), input: { path: '/work/Example.apk' } }, 'agent')
  assert.deepEqual(inputs[1], { action: 'install', input: { path: '/work/Example.apk' } })
  await s.perform({ ...perform('open_url'), input: { url: 'https://example.com/proof' } }, 'agent')
  assert.deepEqual(inputs[2], { action: 'open_url', input: { url: 'https://example.com/proof' } })
  s.stop()
})

test('already polled host job cannot begin after manual takeover', async () => {
  const { service: s } = fixture(); s.poll(1)
  const attaching = s.perform({ sessionId: 'one', targetId: 'web:one', action: 'attach' }, 'agent')
  let jobs = s.poll(1).jobs
  for (let n = 0; n < 20 && !jobs.length; n++) { await new Promise((r) => setImmediate(r)); jobs = s.poll(1).jobs }
  const j = jobs[0]!
  assert.deepEqual(s.begin(1, j.id), { active: true })
  s.complete(1, j.id, {}); await attaching
  const tap = s.perform({ sessionId: 'one', targetId: 'web:one', action: 'tap', input: { x: 10, y: 20 } }, 'agent')
  const rejected = assert.rejects(tap, /Пользователь/)
  jobs = s.poll(1).jobs
  for (let n = 0; n < 20 && !jobs.length; n++) { await new Promise((r) => setImmediate(r)); jobs = s.poll(1).jobs }
  s.takeover('one', 'web:one', 'human')
  assert.throws(() => s.begin(1, jobs[0]!.id), /отменена/)
  await rejected; s.stop()
})

test('Stop cancels an agent operation waiting on discovery before a lease exists', async () => {
  let found: ((v: { targets: typeof device[]; setup: [] }) => void) | undefined
  const { service: s, actions } = fixture({ mobile: () => new Promise((resolve) => { found = resolve }) })
  const pending = s.perform(perform('attach'), 'agent')
  const rejected = assert.rejects(pending, /остановлена/)
  s.revoke('one'); found!({ targets: [device], setup: [] })
  await rejected; assert.deepEqual(actions, []); s.stop()
})

test('runtime permissions use turn snapshot until the next turn', async () => {
  let asks = 0
  const { service: s } = fixture({ session: () => ({ approval: 'full' }), authorize: async () => { asks++; return false } })
  s.key('one', 'ask') // UI already shows full, but the current turn began in ask.
  await assert.rejects(s.perform(perform('attach'), 'agent'), /не разрешён/)
  assert.equal(asks, 1)
  s.key('one', 'full')
  await s.perform(perform('attach'), 'agent'); assert.equal(asks, 1); s.stop()
})

test('takeover and release while approval is pending does not revive the old operation', async () => {
  let allow: ((v: boolean) => void) | undefined
  const { service: s, actions } = fixture({ session: () => ({ approval: 'ask' }), authorize: async (_s, _t, action) => {
    if (action === 'attach') return true
    return new Promise((resolve) => { allow = resolve })
  } })
  await s.perform(perform('attach'), 'agent')
  const pending = s.perform({ ...perform('open_url'), input: { url: 'https://example.com' } }, 'agent')
  const rejected = assert.rejects(pending, /Управление изменилось/)
  for (let n = 0; n < 20 && !allow; n++) await new Promise((r) => setImmediate(r))
  assert.ok(allow)
  s.takeover('one', device.id, 'human'); s.takeover('one', device.id, 'agent'); allow!(true)
  await rejected; assert.deepEqual(actions, ['screenshot']); s.stop()
})

test('daemon runtime credential cannot approve setup, read another session or survive Stop', async () => {
  const home = tempHome()
  const d = await startTestDaemon(home)
  const owner = await connectClient(home.paths)
  let agent: Awaited<ReturnType<typeof connectClient>> | undefined
  try {
    await owner.request('agent.start', { name: 'one', kind: 'claude', cwd: workIn(home, 'a') })
    await owner.request('agent.start', { name: 'two', kind: 'claude', cwd: workIn(home, 'b') })
    const key = d.runtimes.key('one', 'ask')
    agent = await connectClient(home.paths, { runtimeKey: key, client: 'mcp-runtime' })
    const own = await agent.request('runtime.discover', { sessionId: 'one' }) as { targets: unknown[] }
    assert.equal(own.targets.length, 1)
    for (const [method, params] of [
      ['runtime.discover', { sessionId: 'two' }],
      ['runtime.setup.resolve', { sessionId: 'one', id: 'fake', approve: true }],
      ['runtime.takeover', { sessionId: 'one', targetId: 'web:one' }],
      ['runtime.host.poll', {}],
      ['agent.list', {}],
    ] as Array<[string, Record<string, unknown>]>) await assert.rejects(agent.request(method, params), (e: unknown) => (e as { code: string }).code === 'forbidden')
    assert.deepEqual(await owner.request('agent.stop', { name: 'one', turnId: 'old-turn' }), { stopped: false })
    await assert.rejects(owner.request('agent.stop', { name: 'one', turnId: 42 }), (e: unknown) => (e as { code: string }).code === 'invalid_params')
    assert.equal(d.runtimes.lookup(key), 'one', 'a stale/invalid Stop must not revoke the current session capability')
    await owner.request('agent.stop', { name: 'one' })
    await assert.rejects(agent.request('runtime.discover', { sessionId: 'one' }), (e: unknown) => (e as { code: string }).code === 'forbidden')
    assert.equal(d.runtimes.lookup(key), null)
  } finally { agent?.close(); owner.close(); await d.stop('test'); home.remove() }
})
