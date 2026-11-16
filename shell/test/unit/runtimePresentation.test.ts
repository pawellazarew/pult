import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { it } from 'node:test'
import type { BrowserWindow, WebContentsView } from 'electron'
import { RuntimeWeb } from '../../src/runtimeWeb.js'
import { runtimeViewAuthorized } from '../../src/runtimeWebPolicy.js'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(r => { release = r })
  return { promise, release }
}
function fixture() {
  let url = ''
  let visible = false
  const sent: string[] = []
  const noop = (): void => {}
  const debuggerApi = Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand: async (method: string) => { sent.push(method); return method === 'Page.captureScreenshot' ? { data: 'AA==' } : {} }, attach: noop, detach: noop })
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, close: noop, getURL: () => url, getTitle: () => '', setWindowOpenHandler: noop, setZoomMode: noop, setZoomFactor: noop, setVisualZoomLevelLimits: async () => {}, debugger: debuggerApi,
    loadURL: async (next: string) => { url = next },
    session: Object.assign(new EventEmitter(), { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop, setDevicePermissionHandler: noop, webRequest: { onBeforeRequest: noop } }),
  })
  const view = { webContents: wc, setBounds: noop, setVisible: (next: boolean) => { visible = next }, getVisible: () => visible } as unknown as WebContentsView
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentBounds: () => ({ width: 1280, height: 900 }), contentView: { addChildView: noop, removeChildView: noop } }) as unknown as BrowserWindow
  const web = new RuntimeWeb({ window: () => win, createView: () => view })
  return { web, visible: () => visible, sent, debuggerApi }
}
it('a missing page cannot authorize bounds inherited by a future incarnation', async () => {
  const f = fixture()
  let authorizations = 0
  await f.web.requestView('alpha', { x: 0, y: 0, width: 640, height: 400 }, async () => ({ instanceId: 'A', authorize: async () => { ++authorizations; return true } }))
  await f.web.perform({ id: 'attach-new', sessionId: 'alpha', instanceId: 'B', action: 'attach', input: {} })
  try { assert.deepEqual({ authorizations, visibleAfterNewPage: f.visible() }, { authorizations: 0, visibleAfterNewPage: false }) }
  finally { f.web.close() }
})
for (const layoutFails of [false, true]) it(`obsolete cleanup layout ${layoutFails ? 'failure' : 'completion'} cannot reject a newer intent`, async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const entered = gate(), finish = gate(), original = f.debuggerApi.sendCommand
  let held = false
  f.debuggerApi.sendCommand = async method => {
    if (method === 'Emulation.setDeviceMetricsOverride' && !held) {
      held = true; entered.release(); await finish.promise
      if (layoutFails) throw new Error('obsolete layout fixture')
    }
    return original(method)
  }
  const bounds = { x: 0, y: 0, width: 640, height: 400 }
  const old = f.web.requestView('alpha', bounds, async () => { throw new Error('obsolete lookup fixture') })
  await entered.promise
  const hide = f.web.setView('alpha', null)
  assert.equal(f.visible(), false)
  const fresh = f.web.requestView('alpha', bounds, async () => ({ instanceId: 'A', authorize: async () => true }))
  finish.release()
  const results = await Promise.allSettled([old, hide, fresh])
  try {
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled'])
    assert.equal(f.visible(), true)
  } finally { f.web.close() }
})
it('an obsolete shown-layout failure cannot reject a newer hide and show', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const entered = gate(), finish = gate(), original = f.debuggerApi.sendCommand
  let held = false
  f.debuggerApi.sendCommand = async method => {
    if (method === 'Emulation.setDeviceMetricsOverride' && !held) { held = true; entered.release(); await finish.promise; throw new Error('obsolete shown-layout fixture') }
    return original(method)
  }
  const bounds = { x: 0, y: 0, width: 640, height: 400 }
  const old = f.web.requestView('alpha', bounds, async () => ({ instanceId: 'A', authorize: async () => true }))
  await entered.promise
  const hide = f.web.setView('alpha', null)
  const fresh = f.web.requestView('alpha', bounds, async () => ({ instanceId: 'A', authorize: async () => true }))
  finish.release()
  const results = await Promise.allSettled([old, hide, fresh])
  try { assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled']); assert.equal(f.visible(), true) }
  finally { f.web.close() }
})
it('an initial lookup cannot reopen native contents after a newer modal hide', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const bounds = { x: 0, y: 0, width: 640, height: 400 }
  await f.web.setView('alpha', bounds, 'A')
  const entered = gate(), finish = gate()
  let authorizations = 0
  const show = f.web.requestView('alpha', bounds, async () => {
    entered.release(); await finish.promise
    return { instanceId: 'A', authorize: async () => { ++authorizations; return true } }
  })
  await entered.promise
  const hide = f.web.setView('alpha', null)
  assert.equal(f.visible(), false, 'hide does not wait for the initial lookup')
  finish.release()
  await Promise.all([show, hide])
  assert.equal(f.visible(), false)
  assert.equal(authorizations, 0)
  f.web.close()
})
for (const phase of ['lookup', 'authorize'] as const) it(`an obsolete ${phase} error cannot affect a newer show`, async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const bounds = { x: 0, y: 0, width: 640, height: 400 }
  const entered = gate(), finish = gate()
  const obsolete = async (): Promise<never> => { entered.release(); await finish.promise; throw new Error('obsolete fixture read') }
  const old = f.web.requestView('alpha', bounds, async () => {
    if (phase === 'lookup') return obsolete()
    return { instanceId: 'A', authorize: obsolete }
  })
  await entered.promise
  const fresh = f.web.requestView('alpha', bounds, async () => ({ instanceId: 'A', authorize: async () => true }))
  finish.release()
  await Promise.all([old, fresh])
  assert.equal(f.visible(), true)
  f.web.close()
})
it('a current lookup error fails closed on its own native contents', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const bounds = { x: 0, y: 0, width: 640, height: 400 }
  await f.web.setView('alpha', bounds, 'A')
  await assert.rejects(f.web.requestView('alpha', bounds, async () => { throw new Error('current fixture read') }), /current fixture read/)
  assert.equal(f.visible(), false)
  f.web.close()
})
it('the initial lookup must match the exact page incarnation before authorization', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  let authorizations = 0
  await f.web.requestView('alpha', { x: 0, y: 0, width: 640, height: 400 }, async () => ({ instanceId: 'B', authorize: async () => { ++authorizations; return true } }))
  assert.equal(f.visible(), false)
  assert.equal(authorizations, 0)
  f.web.close()
})
it('modal hide is immediate behind an owned action and supersedes a queued show', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const bounds = { x: 0, y: 0, width: 640, height: 400 }
  await f.web.setView('alpha', bounds, 'A')
  assert.ok(f.visible())
  const entered = gate(), hold = gate()
  const active = f.web.perform({ id: 'hold', sessionId: 'alpha', instanceId: 'A', action: 'logs', input: {} }, async () => { entered.release(); await hold.promise })
  await entered.promise
  const show = f.web.setView('alpha', bounds, 'A')
  const hide = f.web.setView('alpha', null, 'A')
  assert.equal(f.visible(), false, 'modal must not wait for the action/command queue')
  hold.release()
  await Promise.all([active, show, hide])
  assert.equal(f.visible(), false, 'the obsolete queued show cannot resurrect the surface')
  f.web.close()
})
it('queued native show cannot borrow a new incarnation human controller', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const discovered = gate(), finish = gate()
  const show = f.web.setView('alpha', { x: 0, y: 0, width: 640, height: 400 }, 'A', () => runtimeViewAuthorized('alpha', 'A',
    async () => { discovered.release(); await finish.promise; return { controllers: { 'web:alpha': 'human' } } },
    async () => ({ sessions: [{ name: 'alpha', createdAt: 'B' }] }),
  ))
  await discovered.promise
  finish.release()
  await assert.rejects(show, /управление|control/)
  assert.equal(f.visible(), false)
  f.web.close()
})
it('late host generation validation happens after queue wait and before any input command', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const entered = gate(), finish = gate()
  const first = f.web.perform({ id: 'hold', sessionId: 'alpha', instanceId: 'A', action: 'logs', input: {} }, async () => { entered.release(); await finish.promise })
  await entered.promise
  const stale = f.web.perform({ id: 'stale', sessionId: 'alpha', instanceId: 'A', action: 'type', input: { text: 'must not type' } }, async () => { throw new Error('generation revoked') })
  finish.release()
  await first
  await assert.rejects(stale, /generation revoked/)
  assert.ok(!f.sent.includes('Input.insertText'))
  f.web.close()
})

it('local full-quality capture has one outstanding job and metadata never encodes a frame', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const first = f.web.preview('alpha', 'A'), second = f.web.preview('alpha', 'A')
  assert.equal(first, second)
  await Promise.all([first, second])
  assert.equal(f.sent.filter(m => m === 'Page.captureScreenshot').length, 1)
  const metadata = await f.web.metadata('alpha', 'A')
  assert.equal(metadata.image, undefined)
  assert.equal(metadata.coordinateWidth, 1280)
  assert.equal(f.sent.filter(m => m === 'Page.captureScreenshot').length, 1)
  await assert.rejects(f.web.preview('alpha', 'B'), /Экземпляр/)
  f.web.close()
})
