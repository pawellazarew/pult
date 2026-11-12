import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { it } from 'node:test'
import { createStore } from '../dist/core/store.js'
import { createBroker } from '../dist/perm/broker.js'
import { createManager } from '../dist/sessions/manager.js'
import { createRegistry, parseSessions } from '../dist/sessions/registry.js'
import { tempHome } from './helpers.js'

const unknown = [null, false, '', 42, { future: ['\ud800', 'a\nb'], nested: { marker: true } }]
for (const marker of unknown) it(`preserves and blocks opaque ZCode input reservation ${JSON.stringify(marker)}`, async () => {
  const home = tempHome()
  const raw = { version: 2, sessions: [{
    name: 'uncertain', provider: 'zcode', cwd: home.paths.home, approval: 'read-only', mode: 'turn',
    createdAt: '2026-11-12T00:00:00Z', lastStatus: 'cold', lastEventId: 0,
    zcodePendingInput: marker,
    queue: [{ id: 'queued', text: 'must not replay', at: '2026-11-12T00:00:00Z' }],
  }] }
  assert.deepEqual(parseSessions(raw)[0]!.zcodePendingInput, marker)
  writeFileSync(home.paths.sessions, JSON.stringify(raw, null, 2), { mode: 0o600 })
  const store = createStore(home.paths)
  const registry = createRegistry(home.paths)
  const manager = createManager({ paths: home.paths, config: home.config, logger: home.logger, store,
    publish: (draft) => store.append(draft), adapters: {}, broker: createBroker({ emit: () => {} }), registry })
  try {
    assert.equal(manager.list()[0]!.lastStatus, 'failed')
    assert.equal(registry.get('uncertain')!.queuePaused, true)
    const before = store.readSession('uncertain').filter((event) => event.kind === 'message.user').length
    for (const action of [
      () => manager.prompt('uncertain', 'do not resend'),
      () => manager.say('uncertain', 'do not resend', { interrupt: true }),
      () => manager.say('uncertain', 'do not resend', { steer: true }),
      () => manager.say('uncertain', 'do not enqueue', { queue: true }),
      () => Promise.resolve().then(() => manager.queueResume('uncertain')),
      () => manager.queueSend('uncertain', 'queued'),
    ]) await assert.rejects(action, (error: { code?: string; message?: string }) => error.code === 'start_unknown' && /дважды/.test(error.message ?? ''))
    assert.equal(store.readSession('uncertain').filter((event) => event.kind === 'message.user').length, before)
    assert.equal(registry.get('uncertain')!.queue!.length, 1)
    assert.deepEqual(registry.get('uncertain')!.zcodePendingInput, marker)
    registry.update('uncertain', { title: 'renamed without losing unknown evidence' })
    const disk = JSON.parse(readFileSync(home.paths.sessions, 'utf8')) as typeof raw
    assert.deepEqual(disk.sessions[0]!.zcodePendingInput, marker)
    assert.equal(disk.sessions[0]!.queue[0]!.text, 'must not replay')
    assert.ok(store.readSession('uncertain').some((event) => event.kind === 'status.changed' && event.data['errorCode'] === 'start_unknown'))
  } finally { await manager.shutdown(); store.close(); home.remove() }
})

it('hot marker updates preserve working status and user pause, known IDs are not unknown input', () => {
  const home = tempHome()
  writeFileSync(home.paths.sessions, JSON.stringify({version:2,sessions:[{name:'known',provider:'zcode',cwd:home.paths.home,approval:'read-only',mode:'turn',createdAt:'2026-11-12T00:00:00Z',lastStatus:'done',lastEventId:0,providerSessionId:'sess_known'}]}), {mode:0o600})
  try {
    const registry = createRegistry(home.paths)
    registry.update('known', {lastStatus:'working', queuePaused:false, zcodePendingInput:{version:1,opaque:true}})
    assert.equal(registry.get('known')!.lastStatus,'working')
    assert.equal(registry.get('known')!.queuePaused,false)
    registry.update('known', {zcodePendingInput:undefined})
    assert.equal(registry.get('known')!.providerSessionId,'sess_known')
    assert.equal(Object.hasOwn(registry.get('known')!,'zcodePendingInput'),false)
    assert.equal(createRegistry(home.paths).get('known')!.providerSessionId,'sess_known')
  } finally { home.remove() }
})
