import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { it } from 'node:test'
import { join } from 'node:path'
import { createStore } from '../dist/core/store.js'
import { createBroker } from '../dist/perm/broker.js'
import { createManager } from '../dist/sessions/manager.js'
import { createRegistry, parseSessions } from '../dist/sessions/registry.js'
import { tempHome, CLI_ENTRY, FAKE_CLAUDE } from './helpers.js'
import { createClaudeAdapter } from '../dist/adapters/claude/adapter.js'

const unknown = [null, false, '', 42, { future: ['\ud800', 'a\nb'], nested: { marker: true } }]
for (const marker of unknown) it(`preserves and blocks opaque Claude reservation ${JSON.stringify(marker)}`, async () => {
  const home = tempHome()
  const raw = { version: 2, sessions: [{
    name: 'uncertain', provider: 'claude', cwd: home.paths.home, approval: 'read-only', mode: 'turn',
    createdAt: '2026-11-12T00:00:00Z', lastStatus: 'cold', lastEventId: 0,
    claudeReservedSessionId: marker,
    queue: [{ id: 'queued', text: 'must not replay', at: '2026-11-12T00:00:00Z' }],
  }] }
  assert.deepEqual(parseSessions(raw)[0]!.claudeReservedSessionId, marker)
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
    assert.deepEqual(registry.get('uncertain')!.claudeReservedSessionId, marker)
    registry.update('uncertain', { title: 'renamed without losing unknown evidence' })
    const disk = JSON.parse(readFileSync(home.paths.sessions, 'utf8')) as typeof raw
    assert.deepEqual(disk.sessions[0]!.claudeReservedSessionId, marker)
    assert.equal(disk.sessions[0]!.queue[0]!.text, 'must not replay')
    assert.ok(store.readSession('uncertain').some((event) => event.kind === 'status.changed' && event.data['errorCode'] === 'start_unknown'))
  } finally { await manager.shutdown(); store.close(); home.remove() }
})

it('explicit import uses a new chat and never clears the unresolved old history', async () => {
  const home=tempHome();const marker='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const cwd=join(home.paths.home,'project');mkdirSync(cwd)
  writeFileSync(home.paths.sessions,JSON.stringify({version:2,sessions:[{name:'uncertain',provider:'claude',cwd:home.paths.home,approval:'read-only',mode:'turn',createdAt:'2026-11-12T00:00:00Z',lastStatus:'cold',lastEventId:0,claudeReservedSessionId:marker}]}),{mode:0o600});
  const store=createStore(home.paths);const registry=createRegistry(home.paths);
  const claude=createClaudeAdapter({paths:home.paths,config:home.config,logger:home.logger,bin:FAKE_CLAUDE,cliEntry:CLI_ENTRY,emit:(event)=>manager.emit(event),askPermission:async()=>({behavior:'deny',message:'test'}),netCheck:async()=>{throw new Error('metadata import must not probe or run a model')}});
  const manager=createManager({paths:home.paths,config:home.config,logger:home.logger,store,publish:(event)=>store.append(event),adapters:{claude},broker:createBroker({emit:()=>{}}),registry});
  try {
    // The external-session host has already selected/validated this known ID.
    const recovered=await manager.importSession({name:'recovered',kind:'claude',cwd,approval:'read-only'},marker,[{role:'assistant',text:'known native history'}]);
    assert.equal(recovered.providerSessionId,marker);assert.equal(Object.hasOwn(recovered,'claudeReservedSessionId'),false);
    assert.equal(registry.get('uncertain')!.claudeReservedSessionId,marker);
    assert.ok(store.readSession('recovered').some(event=>event.kind==='message.done'));
    await assert.rejects(manager.prompt('uncertain','do not retry'),(error:{code?:string})=>error.code==='start_unknown');
    assert.equal(store.readSession('uncertain').filter(event=>event.kind==='message.user').length,0);
  } finally {await manager.shutdown();store.close();home.remove()}
})
