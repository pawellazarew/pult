import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RESULTS } from './harness.js'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import type { RuntimeResult } from '../../../src/runtimes/types.js'

// Actual Electron + private daemon/fake provider. No account, external page or profile.
for (const dpr of [1, 2]) describe(`fixed viewport, actual Electron display DPR ${dpr}`, () => {
  let h: Harness
  let url: string
  let loads = 0
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return }
    ++loads
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html><meta charset="utf-8"><title>Fixed viewport qualification</title><style>
      body{margin:0;height:2200px;background:#f3f3e9;color:#192b26;font:16px sans-serif}
      button{position:fixed;width:64px;height:44px}#tl{left:0;top:0}#tr{right:0;top:0}#bl{left:0;bottom:0}#br{right:0;bottom:0}
      input{position:fixed;left:100px;top:100px}h1{padding:140px 100px}p{padding:0 100px}
      @media(max-width:1000px){body{background:red}}
      </style><h1>A fixed 1280 × 800 page</h1><p>Readable text at full size. The page stays here while the preview changes.</p><input aria-label="Unsaved form" value="keep this form">
      ${['tl', 'tr', 'bl', 'br'].map(id => `<button id="${id}" onclick="window.hit='${id}'">${id}</button>`).join('')}
      <script>window.nonce=Math.random();document.cookie='viewport=kept;path=/';localStorage.setItem('viewport','kept')</script>`)
  })
  const perform = async (action: string, input: Record<string, unknown> = {}): Promise<RuntimeResult> =>
    (await h.client()).request('runtime.perform', { sessionId: 'fixed', targetId: 'web:fixed', action, input }) as Promise<RuntimeResult>
  const probe = (): Promise<{ id: number; target: string; width: number; height: number; nonce: number; scroll: number; value: string; hit: string | null; cookie: string }> =>
    h.app.evaluate(async ({ webContents }, base) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith(base))!
      const target = await wc.debugger.sendCommand('Target.getTargetInfo')
      return { id: wc.id, target: target.targetInfo.targetId, ...await wc.executeJavaScript('({width:innerWidth,height:innerHeight,nonce,scroll:scrollY,value:document.querySelector("input").value,hit:window.hit??null,cookie:document.cookie})') }
    }, url)
  before(async () => {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    h = await launch({ name: `fixed-viewport-${dpr}`, args: [`--force-device-scale-factor=${dpr}`] })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    const c = await h.client()
    await c.request('agent.start', { name: 'fixed', kind: 'claude', cwd: h.workDir('fixed') })
    assert.ok(await waitFor(async () => {
      const discovery = await c.request('runtime.discover', { sessionId: 'fixed' }) as { targets: Array<{ kind: string; state: string }> }
      return discovery.targets.some(t => t.kind === 'web' && t.state === 'ready')
    }))
    await perform('attach', { url })
    await h.win.getByTestId('runtime-expand').waitFor()
  })
  after(async () => { await h?.close(); await new Promise<void>(r => server.close(() => r())) })

  it('retains the same target, form, scroll, cookies and breakpoint through thumbnail/expanded/native/collapse', async () => {
    assert.equal(await h.win.evaluate(() => devicePixelRatio), dpr)
    await h.app.evaluate(async ({ webContents }, base) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL() === base)!
      await wc.executeJavaScript('document.querySelector("input").value="unsaved native form";scrollTo(0,350)')
    }, url)
    const before = await probe()
    assert.equal(before.width, 1280); assert.equal(before.height, 800)
    const loadCount = loads
    await h.win.getByTestId('runtime-expand').click()
    await h.win.locator('.runtime-expanded').waitFor()
    assert.deepEqual(await probe(), before)
    const c = await h.client()
    await c.request('runtime.takeover', { sessionId: 'fixed', targetId: 'web:fixed' })
    assert.ok(await waitFor(async () => (await h.win.getByTestId('runtime-control').textContent())?.includes('Вернуть агенту') === true))
    assert.ok(await waitFor(() => h.app.evaluate(({ BrowserWindow }, base) => BrowserWindow.getAllWindows()[0]!.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === base && v.getVisible()), url)))
    assert.deepEqual(await probe(), before)
    assert.ok(await waitFor(async () => await h.win.getByLabel('Адрес страницы', { exact: true }).inputValue() === url))
    await h.screen(`fixed-viewport-${dpr}-expanded-native-renderer-only`)
    const windowPage = await h.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'))
    writeFileSync(path.join(RESULTS, 'screens', `fixed-viewport-${dpr}-window-api.png`), Buffer.from(windowPage, 'base64'))
    if (process.platform === 'darwin') {
      const source = await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getMediaSourceId())
      const id = /^window:(\d+):/.exec(source)?.[1]
      assert.ok(id)
      const dir = path.join(RESULTS, 'screens')
      mkdirSync(dir, { recursive: true })
      try {
        execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-l', id, path.join(dir, `fixed-viewport-${dpr}-native-composited.png`)], { timeout: 5000 })
        console.log(`[own-window-capture] dpr=${dpr} captured=true`)
      } catch {
        console.log(`[own-window-capture] dpr=${dpr} captured=false; OS access not changed`)
      }
    }
    await h.win.evaluate(() => window.dispatchEvent(new CustomEvent('pult:settings', { detail: 'voice' })))
    assert.ok(await waitFor(() => h.app.evaluate(({ BrowserWindow }, base) => !BrowserWindow.getAllWindows()[0]!.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === base && v.getVisible()), url)))
    await h.win.keyboard.press('Escape')
    assert.ok(await waitFor(() => h.app.evaluate(({ BrowserWindow }, base) => BrowserWindow.getAllWindows()[0]!.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === base && v.getVisible()), url)))
    // Own scratch daemon only: null-hide cannot wait for any daemon RPC.
    const daemon = h.daemonPid()
    assert.ok(daemon)
    process.kill(daemon, 'SIGSTOP')
    let hidden: Promise<void> | undefined
    try {
      hidden = h.win.evaluate(async () => window.pult!.runtimeView!('fixed', null))
      assert.ok(await waitFor(() => h.app.evaluate(({ BrowserWindow }, base) => !BrowserWindow.getAllWindows()[0]!.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === base && v.getVisible()), url)), 'hide must not wait for the paused owned daemon')
    } finally { process.kill(daemon, 'SIGCONT') }
    await hidden
    await h.win.getByTestId('runtime-expand').click()
    await h.win.getByTestId('runtime-expand').click()
    assert.ok(await waitFor(() => h.app.evaluate(({ BrowserWindow }, base) => BrowserWindow.getAllWindows()[0]!.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === base && v.getVisible()), url)))
    // Native Escape must fold, even when focus belongs to the guest page.
    await h.app.evaluate(({ webContents }, base) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL() === base)!
      wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    }, url)
    assert.ok(await waitFor(async () => await h.win.locator('.runtime-expanded').count() === 0))
    assert.deepEqual(await probe(), before)
    assert.equal(loads, loadCount)
    await h.screen(`fixed-viewport-${dpr}-thumbnail`)
  })

  it('hits all four corners through native and transformed CDP after fit/resize and does not add document scroll', async () => {
    await h.win.getByTestId('runtime-expand').click()
    for (const size of [{ width: 1050, height: 800 }, { width: 1450, height: 1000 }]) {
      await h.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), size)
      assert.ok(await waitFor(async () => {
        const r = await probe(); return r.width === 1280 && r.height === 800
      }))
      for (const [id, x, y] of [['tl', 20, 20], ['tr', 1260, 20], ['bl', 20, 780], ['br', 1260, 780]] as const) {
        assert.ok(await waitFor(() => h.app.evaluate(({ BrowserWindow }, base) => BrowserWindow.getAllWindows()[0]!.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === base && v.getVisible()), url)))
        const native = await h.app.evaluate(async ({ BrowserWindow }, args) => {
          const win = BrowserWindow.getAllWindows()[0]!
          const view = win.contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === args.url) as import('electron').WebContentsView
          const wc = view.webContents
          await wc.executeJavaScript('window.hit=null')
          win.focus(); wc.focus()
          const deadline = Date.now() + 10_000
          while (!view.getVisible()) {
            if (Date.now() > deadline) throw new Error('Native presentation did not become visible')
            await new Promise(r => setTimeout(r, 10))
          }
          const bounds = view.getBounds()
          const scale = bounds.width / 1280
          wc.sendInputEvent({ type: 'mouseDown', x: Math.round(args.x * scale), y: Math.round(args.y * scale), button: 'left', clickCount: 1 })
          wc.sendInputEvent({ type: 'mouseUp', x: Math.round(args.x * scale), y: Math.round(args.y * scale), button: 'left', clickCount: 1 })
          return true
        }, { url, x, y })
        assert.ok(native)
        assert.ok(await waitFor(async () => (await probe()).hit === id), `native ${id}`)
        await h.app.evaluate(async ({ webContents }, base) => { await webContents.getAllWebContents().find(w => w.getURL() === base)!.executeJavaScript('window.hit=null') }, url)
        await perform('tap', { x, y })
        assert.equal((await probe()).hit, id, `CDP ${id}`)
      }
      const frame = await perform('screenshot')
      assert.equal(frame.coordinateWidth, 1280); assert.equal(frame.coordinateHeight, 800)
      assert.ok((frame.image?.data.length ?? 0) <= 530_000)
      assert.equal((await probe()).scroll, 350)
      await perform('swipe', { x: 500, y: 500, deltaY: 80 })
      assert.ok(await waitFor(async () => (await probe()).scroll === 430), 'wheel uses CSS distance exactly once')
      await h.app.evaluate(async ({ webContents }, base) => { await webContents.getAllWebContents().find(w => w.getURL() === base)!.executeJavaScript('scrollTo(0,350)') }, url)
    }
    const inspect = await perform('inspect')
    const ref = (inspect.nodes as Array<{ ref: string; name: string }>).find(n => n.name === 'br')!.ref
    await perform('tap', { ref })
    assert.equal((await probe()).hit, 'br')
    await h.win.getByTestId('runtime-expand').click()
  })

  it('keeps explicit viewport ownership and never changes controller on expand', async () => {
    await perform('viewport', { width: 1100, height: 700 })
    assert.ok(await waitFor(async () => (await probe()).width === 1100))
    await perform('navigate', { url: `${url}next` })
    assert.equal((await probe()).width, 1100)
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1680, 1050))
    if (await h.win.locator('.runtime-expanded').count() === 0) await h.win.getByTestId('runtime-expand').click()
    const nativeActual = h.win.getByTestId('runtime-actual')
    assert.ok(await waitFor(async () => await nativeActual.isEnabled()))
    for (const mode of ['100%', 'Fit']) {
      await h.win.getByTestId(mode === 'Fit' ? 'runtime-fit' : 'runtime-actual').click()
      assert.ok(await waitFor(() => h.app.evaluate(({ BrowserWindow }, args) => {
        const v = BrowserWindow.getAllWindows()[0]!.contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL().startsWith(args.url))!
        return v.getVisible() && (args.mode === '100%' ? v.getBounds().width === 1100 : v.getBounds().width > 1100)
      }, { url, mode })))
      await h.app.evaluate(async ({ BrowserWindow }, base) => {
        const win = BrowserWindow.getAllWindows()[0]!
        const v = win.contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL().startsWith(base)) as import('electron').WebContentsView
        await v.webContents.executeJavaScript('window.hit=null')
        const scale = v.getBounds().width / 1100
        win.focus(); v.webContents.focus()
        v.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(1080 * scale), y: Math.round(680 * scale), button: 'left', clickCount: 1 })
        v.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(1080 * scale), y: Math.round(680 * scale), button: 'left', clickCount: 1 })
      }, url)
      assert.ok(await waitFor(async () => (await probe()).hit === 'br'), `native ${mode}`)
      await h.app.evaluate(async ({ webContents }, base) => { await webContents.getAllWebContents().find(w => w.getURL().startsWith(base))!.executeJavaScript('window.hit=null') }, url)
      await perform('tap', { x: 1080, y: 680 })
      assert.equal((await probe()).hit, 'br', `CDP ${mode}`)
    }
    const c = await h.client()
    await c.request('runtime.release', { sessionId: 'fixed', targetId: 'web:fixed' })
    if (await h.win.locator('.runtime-expanded').count() === 0) await h.win.getByTestId('runtime-expand').click()
    assert.ok(await waitFor(async () => (await h.win.getByTestId('runtime-control').textContent())?.includes('Взять управление') === true))
    const discovery = await c.request('runtime.discover', { sessionId: 'fixed' }) as { controllers: Record<string, string> }
    assert.equal(discovery.controllers['web:fixed'], 'agent')
    const local = await h.win.evaluate(async () => window.pult!.runtimePreview!('fixed'))
    assert.equal(local.coordinateWidth, 1100)
    assert.ok((local.image?.data.length ?? 0) <= 2_800_000)
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1680, 1050))
    const actual = h.win.getByTestId('runtime-actual')
    assert.ok(await waitFor(async () => await actual.isEnabled()))
    await actual.click()
    const img = h.win.getByTestId('runtime-screen').locator('img')
    assert.ok(await waitFor(async () => { const box = await img.boundingBox(); return box?.width === 1100 && box?.height === 700 }))
    await h.screen(`fixed-viewport-${dpr}-observer-100`)
    await h.win.getByTestId('runtime-fit').click()
    assert.ok(await waitFor(async () => { const box = await img.boundingBox(); return !!box && (box.width !== 1100 || box.height !== 700) }))
    await assert.rejects(perform('tap', { x: 20, y: 20 }), /управление|управляет/)
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.locator('.runtime-expanded').count(), 0)
  })
})
