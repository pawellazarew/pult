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
  let bounds = { x: 0, y: 0, width: 1280, height: 800 }
  const sent: string[] = []
  const captures: unknown[] = [], qualities: number[] = []
  type Frame = { isEmpty(): boolean; getSize(): { width: number; height: number }; resize(size: { width: number; height: number }): Frame; toJPEG(quality: number): Buffer }
  const image = (width = 1280, height = 800): Frame => ({
    isEmpty: () => false, getSize: () => ({ width, height }), resize: size => image(size.width, size.height),
    toJPEG: quality => { qualities.push(quality); const b = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 0, 0, 0, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]); b.writeUInt16BE(height, 7); b.writeUInt16BE(width, 9); return b },
  })
  const noop = (): void => {}
  const debuggerApi = Object.assign(new EventEmitter(), { isAttached: (): boolean => true, sendCommand: async (method: string, _params?: Record<string, unknown>): Promise<Record<string, unknown>> => { sent.push(method); return method === 'Page.captureScreenshot' ? { data: 'AA==' } : {} }, attach: noop, detach: noop })
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, close: noop, getURL: () => url, getTitle: () => '', setWindowOpenHandler: noop, setZoomMode: noop, setZoomFactor: noop, setVisualZoomLevelLimits: async () => {}, debugger: debuggerApi,
    loadURL: async (next: string) => { url = next },
    capturePage: async (_rect?: unknown, options?: unknown) => { captures.push(options); return image() },
    session: Object.assign(new EventEmitter(), { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop, setDevicePermissionHandler: noop, webRequest: { onBeforeRequest: noop } }),
  })
  const view = { webContents: wc, setBounds: (next: typeof bounds) => { bounds = { ...next } }, getBounds: () => ({ ...bounds }), setVisible: (next: boolean) => { visible = next }, getVisible: () => visible } as unknown as WebContentsView
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentBounds: () => ({ width: 1280, height: 900 }), contentView: { addChildView: noop, removeChildView: noop } }) as unknown as BrowserWindow
  const web = new RuntimeWeb({ window: () => win, createView: () => view })
  return { web, visible: () => visible, sent, debuggerApi, captures, qualities, wc, view, image }
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
  assert.equal(f.sent.filter(m => m === 'Page.captureScreenshot').length, 0)
  assert.deepEqual(f.captures, [{ stayHidden: true, stayAwake: true }])
  assert.deepEqual(f.qualities, [90])
  const metadata = await f.web.metadata('alpha', 'A')
  assert.equal(metadata.image, undefined)
  assert.equal(metadata.coordinateWidth, 1280)
  assert.equal(f.sent.filter(m => m === 'Page.captureScreenshot').length, 0)
  assert.equal(f.captures.length, 1)
  await assert.rejects(f.web.preview('alpha', 'B'), /Экземпляр/)
  f.web.close()
})

it('native presentation does not wait for an obsolete local CDP screenshot', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const captured = gate(), finish = gate()
  const send = f.debuggerApi.sendCommand
  f.debuggerApi.sendCommand = async method => {
    if (method === 'Page.captureScreenshot') { captured.release(); await finish.promise }
    return send(method)
  }
  const preview = f.web.preview('alpha', 'A')
  const presented = f.web.requestView('alpha', { x: 0, y: 0, width: 640, height: 400 }, async () => ({ instanceId: 'A', authorize: async () => true }))
  try {
    const ready = await Promise.race([captured.promise.then(() => false), presented.then(() => f.visible())])
    assert.equal(ready, true, 'a local observer capture must not prevent native presentation')
  } finally {
    finish.release()
    try { await Promise.all([preview, presented]) } finally { f.web.close() }
  }
})

it('a visible human view returns metadata without capture, geometry or debugger changes', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  await f.web.setView('alpha', { x: 10, y: 20, width: 640, height: 400 })
  const bounds = f.view.getBounds(), sent = [...f.sent]
  f.view.setBounds = () => { throw new Error('must not resize visible human view') }
  f.view.setVisible = () => { throw new Error('must not hide visible human view') }
  f.wc.capturePage = async () => { throw new Error('must not capture visible human view') }
  try {
    const result = await f.web.preview('alpha', 'A')
    assert.equal(result.image, undefined)
    assert.equal(result.coordinateWidth, 1280)
    assert.equal(f.visible(), true)
    assert.deepEqual(f.view.getBounds(), bounds)
    assert.deepEqual(f.sent, sent)
  } finally { f.web.close() }
})

for (const detached of [false, true]) it(`a hidden fitted page normalizes itself before native capture, detached=${detached}`, async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  await f.web.setView('alpha', { x: 10, y: 20, width: 640, height: 400 })
  f.view.setVisible(false)
  f.debuggerApi.isAttached = () => !detached
  const send = f.debuggerApi.sendCommand, metrics: unknown[] = []
  f.debuggerApi.sendCommand = async (method, params) => { if (method === 'Emulation.setDeviceMetricsOverride') metrics.push(params); return send(method, params) }
  const capture = f.wc.capturePage
  f.wc.capturePage = async (...args) => { assert.deepEqual(f.view.getBounds(), { x: 0, y: 0, width: 1280, height: 800 }); assert.equal(f.visible(), false); return capture(...args) }
  try {
    const result = await f.web.preview('alpha', 'A')
    assert.equal(result.width, 1280)
    assert.equal(result.height, 800)
    assert.equal(f.visible(), false)
    assert.deepEqual(metrics, [{ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, scale: 1 }])
  } finally { f.web.close() }
})

it('native preview repairs hidden fitted geometry after a null-hide is rejected by the unchanged sixteen-job cap', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  await f.web.setView('alpha', { x: 0, y: 0, width: 640, height: 400 })
  const entered = gate(), finish = gate()
  const hold = f.web.perform({ id: 'hold', sessionId: 'alpha', instanceId: 'A', action: 'logs', input: {} }, async () => { entered.release(); await finish.promise })
  await entered.promise
  const queued = Array.from({ length: 15 }, () => f.web.metadata('alpha', 'A'))
  try {
    await assert.rejects(f.web.setView('alpha', null), /Браузер занят/)
    assert.equal(f.visible(), false)
    assert.equal(f.view.getBounds().width, 640)
    finish.release()
    await Promise.all([hold, ...queued])
    assert.equal(f.view.getBounds().width, 640, 'no admitted null-layout repaired this fixture')
    const result = await f.web.preview('alpha', 'A')
    assert.equal(result.width, 1280)
    assert.equal(result.height, 800)
    assert.equal(f.visible(), false)
    assert.deepEqual(f.view.getBounds(), { x: 0, y: 0, width: 1280, height: 800 })
  } finally { finish.release(); await Promise.allSettled([hold, ...queued]); f.web.close() }
})

for (const closed of [false, true]) it(`a pending native copy remains owned and cannot restore a stale show, closed=${closed}`, async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  const entered = gate(), finish = gate(), capture = f.wc.capturePage
  f.wc.capturePage = async (...args) => { entered.release(); await finish.promise; return capture(...args) }
  const preview = f.web.preview('alpha', 'A')
  await entered.promise
  if (closed) {
    f.web.close()
    finish.release()
    await assert.rejects(preview, /Сначала подключи/)
  } else {
    const staleShow = f.web.setView('alpha', { x: 0, y: 0, width: 640, height: 400 })
    const hide = f.web.setView('alpha', null)
    assert.equal(f.visible(), false)
    finish.release()
    await Promise.all([preview, staleShow, hide])
    assert.equal(f.visible(), false)
    f.web.close()
  }
})

it('native preview rejects an undersized surface instead of upsampling it', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  f.wc.capturePage = async () => f.image(640, 400)
  try { await assert.rejects(f.web.preview('alpha', 'A'), /Размер области/); assert.equal(f.qualities.length, 0) }
  finally { f.web.close() }
})

it('native preview rejects a JPEG whose pixels do not match the logical viewport', async () => {
  const f = fixture()
  await f.web.perform({ id: 'attach', sessionId: 'alpha', instanceId: 'A', action: 'attach', input: {} })
  f.wc.capturePage = async () => ({ ...f.image(), resize: () => f.image(640, 400) })
  try { await assert.rejects(f.web.preview('alpha', 'A'), /Крупный кадр/) }
  finally { f.web.close() }
})
