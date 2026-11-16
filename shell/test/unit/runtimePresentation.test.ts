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
  return { web, visible: () => visible, sent }
}
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
