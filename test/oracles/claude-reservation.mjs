// Cross-backend rollback oracle: metadata-only, no adapter or provider process.
import assert from 'node:assert/strict'
import { layout } from '../../dist/core/paths.js'
import { createStore } from '../../dist/core/store.js'
import { defaultConfig } from '../../dist/core/config.js'
import { createLogger } from '../../dist/core/log.js'
import { createBroker } from '../../dist/perm/broker.js'
import { createRegistry } from '../../dist/sessions/registry.js'
import { createManager } from '../../dist/sessions/manager.js'
const paths=layout(process.argv[2]);const registry=createRegistry(paths);const store=createStore(paths)
const before=registry.get('chat')
assert.equal(before.title,'rust-title');assert.equal(before.lastStatus,'failed');assert.equal(before.queuePaused,true)
assert.equal(before.claudeReservedSessionId.future[0],'\ud800')
const manager=createManager({paths,config:defaultConfig(),logger:createLogger(paths.logFile),store,publish:d=>store.append(d),adapters:{},broker:createBroker({emit:()=>{}}),registry})
try {
  await assert.rejects(manager.say('chat','must not resend',{interrupt:true}),e=>e.code==='start_unknown')
  assert.throws(()=>manager.queueResume('chat'),e=>e.code==='start_unknown')
  registry.update('chat',{title:'node-title'})
  assert.equal(store.readSession('chat').filter(e=>e.kind==='message.user').length,0)
  assert.equal(registry.get('chat').queue.length,1)
  console.log(JSON.stringify({blocked:true,markerRetained:Object.hasOwn(registry.get('chat'),'claudeReservedSessionId'),title:registry.get('chat').title}))
} finally {await manager.shutdown();store.close()}
