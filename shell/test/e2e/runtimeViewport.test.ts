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

type NativeTracePhase = 'installed' | 'contents_created' | 'attach_ready' | 'visibility' | 'bounds' | 'cdp_enter' | 'cdp_settle' | 'window_event' | 'debugger_detach' | 'predicate'
type NativeTraceEvent = { ms: number; phase: NativeTracePhase } & Record<string, number | boolean | string>
type NativeTrace = {
  push(phase: NativeTracePhase, data?: Record<string, number | boolean | string>): void
  snapshot(): unknown
  owns(contents: import('electron').WebContents): boolean
}
type NativeTraceGlobal = typeof globalThis & { __pultNativeVisibilityTrace?: NativeTrace }

// Diagnostic reads never extend or turn a failed visibility assertion into a pass.
async function boundedProof(read: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = Promise.resolve().then(read).catch(() => ({ state: 'unavailable' }))
  try { return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'timeout' }), 150) })]) }
  finally { if (timer) clearTimeout(timer) }
}

// Actual Electron + private daemon/fake provider. No account, external page or profile.
for (const dpr of [1, 2]) describe(`fixed viewport, actual Electron display DPR ${dpr}`, () => {
  let h: Harness
  let owner: Awaited<ReturnType<Harness['client']>> | undefined
  let firstNativeFailure = false
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
  const setExpanded = async (wanted: boolean): Promise<void> => {
    if ((await h.win.locator('.runtime-expanded').count() > 0) !== wanted) await h.win.getByTestId('runtime-expand').click()
    assert.ok(await waitFor(async () => await h.win.locator('.runtime-expanded').count() === (wanted ? 1 : 0)))
  }
  const nativeProof = async (): Promise<string> => {
    const [dom, native, controller] = await Promise.all([
      boundedProof(() => h.win.evaluate(() => {
        const slot = document.querySelector<HTMLElement>('[data-testid="runtime-screen"]')
        const panel = slot?.closest<HTMLElement>('.runtime-panel')
        const box = slot?.getBoundingClientRect(), outer = panel?.getBoundingClientRect()
        const rect = (b: DOMRect | undefined): unknown => b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
        const label = document.querySelector('.runtime-viewport-label')?.textContent?.match(/^(\d+) × (\d+)$/)
        const control = document.querySelector('[data-testid="runtime-control"]')?.textContent ?? ''
        return { expanded: !!document.querySelector('.runtime-expanded'), ariaExpanded: document.querySelector('[data-testid="runtime-expand"]')?.getAttribute('aria-expanded') === 'true', visibility: document.visibilityState,
          width: innerWidth, height: innerHeight, dpr: devicePixelRatio, slot: rect(box), panel: rect(outer), client: slot ? { width: slot.clientWidth, height: slot.clientHeight } : null,
          fits: !!box && !!outer && box.top >= outer.top && box.bottom <= outer.bottom && box.left >= outer.left && box.right <= outer.right && box.top >= 0 && box.bottom <= innerHeight,
          frame: label ? { width: Number(label[1]), height: Number(label[2]) } : null, error: !!document.querySelector('.runtime-error'),
          uiController: control.includes('Вернуть агенту') ? 'human' : control.includes('Взять управление') ? 'agent' : 'missing', attachButton: !!document.querySelector('[data-testid="runtime-attach"]'), observerStatus: !!document.querySelector('.runtime-frame-status'),
          otherModal: Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')).some(el => el !== panel) }
      })),
      boundedProof(() => h.app.evaluate(({ BrowserWindow }, base) => {
        const win = BrowserWindow.getAllWindows()[0]!
        const view = win.contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === base)
        return { windowVisible: win.isVisible(), windowFocused: win.isFocused(), minimized: win.isMinimized(), content: win.getContentBounds(), exists: !!view, visible: view?.getVisible() ?? false, bounds: view?.getBounds() ?? null,
          phaseTrace: (globalThis as NativeTraceGlobal).__pultNativeVisibilityTrace?.snapshot() ?? null }
      }, url)),
      boundedProof(async () => {
        if (!owner) return { controller: 'missing' }
        const discovery = await owner.request('runtime.discover', { sessionId: 'fixed' }) as { controllers?: Record<string, string>; controller?: string; attached?: string[] }
        const value = discovery.controllers?.['web:fixed'] ?? discovery.controller
        return { controller: value === 'human' || value === 'agent' ? value : 'missing', attached: discovery.attached?.includes('web:fixed') === true }
      }),
    ])
    return JSON.stringify({ dom, native, controller })
  }
  const assertNativeVisibility = async (expected: boolean, phase: string): Promise<void> => {
    const satisfied = await waitFor(() => h.app.evaluate(({ BrowserWindow }, args) => {
      const trace = (globalThis as NativeTraceGlobal).__pultNativeVisibilityTrace
      try {
        const win = BrowserWindow.getAllWindows()[0]!
        const result = win.contentView.children.some(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === args.url && v.getVisible()) === args.expected
        trace?.push('predicate', { expected: args.expected, result, error: false, focused: win.isFocused() })
        return result
      } catch (error) { trace?.push('predicate', { expected: args.expected, error: true }); throw error }
    }, { url, expected }))
    if (!satisfied) {
      const proof = await nativeProof()
      if (!firstNativeFailure) {
        firstNativeFailure = true
        try {
          mkdirSync(RESULTS, { recursive: true })
          writeFileSync(path.join(RESULTS, `fixed-viewport-${dpr}-first-native-failure.json`), JSON.stringify({ phase, expected, waitForResult: false, proof: JSON.parse(proof) }, null, 2))
        } catch { console.error('[native-proof-artifact] write failed') }
      }
      assert.fail(`native visibility phase=${phase} expected=${expected} waitForResult=false ${proof}`)
    }
  }
  before(async () => {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    h = await launch({ name: `fixed-viewport-${dpr}`, args: [`--force-device-scale-factor=${dpr}`] })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    const c = await h.client()
    owner = c
    await c.request('agent.start', { name: 'fixed', kind: 'claude', cwd: h.workDir('fixed') })
    assert.ok(await waitFor(async () => {
      const discovery = await c.request('runtime.discover', { sessionId: 'fixed' }) as { targets: Array<{ kind: string; state: string }> }
      return discovery.targets.some(t => t.kind === 'web' && t.state === 'ready')
    }))
    // Install before attach can create the fixture contents or start a thumbnail capture.
    // Existing main UI is untouched; the next contents must later match the fixture view.
    await h.app.evaluate(({ app, BrowserWindow }) => {
      const started = performance.now()
      const first: NativeTraceEvent[] = [], last: NativeTraceEvent[] = []
      const counts: Record<NativeTracePhase, number> = { installed: 0, contents_created: 0, attach_ready: 0, visibility: 0, bounds: 0, cdp_enter: 0, cdp_settle: 0, window_event: 0, debugger_detach: 0, predicate: 0 }
      let total = 0, predicateErrors = 0
      let ownedContents: import('electron').WebContents | undefined
      let firstCapture: { enteredMs: number; settledMs?: number; ok?: boolean } | undefined
      const elapsed = (): number => Math.round((performance.now() - started) * 10) / 10
      const trace: NativeTrace = {
        push(phase, data = {}) {
          const event = { ms: elapsed(), phase, ...data }
          ++total; ++counts[phase]
          if (phase === 'predicate' && data['error'] === true) ++predicateErrors
          if (first.length < 32) first.push(event)
          else { last.push(event); if (last.length > 96) last.shift() }
        },
        snapshot: () => ({ total, counts: { ...counts }, predicateErrors, firstCapture: firstCapture ? { ...firstCapture } : null, first: [...first], last: [...last] }),
        owns: contents => ownedContents === contents,
      }
      ;(globalThis as NativeTraceGlobal).__pultNativeVisibilityTrace = trace
      app.once('web-contents-created', (_event, contents) => {
        ownedContents = contents
        trace.push('contents_created')
        const send = contents.debugger.sendCommand.bind(contents.debugger)
        contents.debugger.sendCommand = (method, ...args) => {
          const kind = method === 'Page.captureScreenshot' ? 'capture' : method === 'Emulation.setDeviceMetricsOverride' ? 'emulation' : 'other'
          trace.push('cdp_enter', { kind })
          const capture: { enteredMs: number; settledMs?: number; ok?: boolean } | undefined = kind === 'capture' && !firstCapture ? (firstCapture = { enteredMs: elapsed() }) : undefined
          const settled = (ok: boolean): void => { if (capture) { capture.settledMs = elapsed(); capture.ok = ok }; trace.push('cdp_settle', { kind, ok }) }
          try { return send(method, ...args).then(value => { settled(true); return value }, error => { settled(false); throw error }) }
          catch (error) { settled(false); throw error }
        }
        contents.debugger.on('detach', () => trace.push('debugger_detach'))
      })
      trace.push('installed', { focused: BrowserWindow.getAllWindows()[0]!.isFocused() })
    })
    await perform('attach', { url })
    await h.win.getByTestId('runtime-expand').waitFor()
    // No new polls, CDP requests, daemon calls, or payload retention.
    await h.app.evaluate(({ BrowserWindow }, base) => {
      const win = BrowserWindow.getAllWindows()[0]!
      const view = win.contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL() === base) as import('electron').WebContentsView | undefined
      const trace = (globalThis as NativeTraceGlobal).__pultNativeVisibilityTrace
      if (!view || !trace?.owns(view.webContents)) throw new Error('Observed contents do not match owned fixture view')
      trace.push('attach_ready', { visible: view.getVisible(), focused: win.isFocused() })
      const visible = view.setVisible.bind(view), bounds = view.setBounds.bind(view)
      view.setVisible = value => { trace.push('visibility', { value }); return visible(value) }
      view.setBounds = value => { trace.push('bounds', { x: value.x, y: value.y, width: value.width, height: value.height }); return bounds(value) }
      win.on('focus', () => trace.push('window_event', { event: 'focus' }))
      win.on('blur', () => trace.push('window_event', { event: 'blur' }))
      win.on('show', () => trace.push('window_event', { event: 'show' }))
      win.on('hide', () => trace.push('window_event', { event: 'hide' }))
      win.on('minimize', () => trace.push('window_event', { event: 'minimize' }))
      win.on('restore', () => trace.push('window_event', { event: 'restore' }))
    }, url)
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
    await setExpanded(true)
    assert.deepEqual(await probe(), before)
    const c = await h.client()
    await c.request('runtime.takeover', { sessionId: 'fixed', targetId: 'web:fixed' })
    assert.ok(await waitFor(async () => (await h.win.getByTestId('runtime-control').textContent())?.includes('Вернуть агенту') === true))
    await assertNativeVisibility(true, 'initial_takeover')
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
    await assertNativeVisibility(false, 'modal_hide')
    await h.win.keyboard.press('Escape')
    await assertNativeVisibility(true, 'modal_restore')
    // Own scratch daemon only: null-hide cannot wait for any daemon RPC.
    const daemon = h.daemonPid()
    assert.ok(daemon)
    process.kill(daemon, 'SIGSTOP')
    let hidden: Promise<void> | undefined
    try {
      hidden = h.win.evaluate(async () => window.pult!.runtimeView!('fixed', null))
      await assertNativeVisibility(false, 'paused_daemon_null_hide')
    } finally { process.kill(daemon, 'SIGCONT') }
    await hidden
    await setExpanded(false)
    await setExpanded(true)
    await assertNativeVisibility(true, 'reexpand_after_null_hide')
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
    await setExpanded(true)
    for (const size of [{ width: 1050, height: 800 }, { width: 1450, height: 1000 }]) {
      await h.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), size)
      assert.ok(await waitFor(async () => {
        const r = await probe(); return r.width === 1280 && r.height === 800
      }))
      for (const [id, x, y] of [['tl', 20, 20], ['tr', 1260, 20], ['bl', 20, 780], ['br', 1260, 780]] as const) {
        await assertNativeVisibility(true, 'corner_precondition')
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
    if (await h.win.locator('.runtime-expanded').count() === 0) await h.win.getByTestId('runtime-expand').click()
    const nativeActual = h.win.getByTestId('runtime-actual')
    const slotSize = (): Promise<{ width: number; height: number }> => h.win.getByTestId('runtime-screen').evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }))
    const resize = async (width: number, height: number): Promise<{ width: number; height: number }> => {
      const content = await h.app.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]!
        win.setContentSize(size.width, size.height)
        return win.getContentBounds()
      }, { width, height })
      assert.ok(await waitFor(() => h.win.evaluate(size => innerWidth === size.width && innerHeight === size.height, content)))
      return content
    }
    // Insufficient space must deny 100%, rather than clipping human input.
    await resize(900, 560)
    assert.ok(await waitFor(async () => await h.win.locator('.runtime-viewport-label').textContent() === '1100 × 700'))
    assert.ok(await waitFor(async () => await nativeActual.isDisabled()))
    const small = await slotSize()
    assert.ok(small.width < 1100 || small.height < 700, JSON.stringify({ small }))
    // macOS can clamp a requested window to its work area. Qualify 100% against
    // the measured slot, while retaining an explicit logical viewport owner.
    const content = await resize(1680, 1050)
    const available = await slotSize()
    const viewport = { width: Math.min(1100, Math.floor(available.width * .8)), height: Math.min(700, Math.floor(available.height * .8)) }
    assert.ok(viewport.width >= 240 && viewport.height >= 240, JSON.stringify({ content, available, viewport }))
    await perform('viewport', viewport)
    assert.ok(await waitFor(async () => { const current = await probe(); return current.width === viewport.width && current.height === viewport.height }))
    assert.ok(await waitFor(async () => await nativeActual.isEnabled()), JSON.stringify({ content, available, viewport }))
    for (const mode of ['100%', 'Fit']) {
      await h.win.getByTestId(mode === 'Fit' ? 'runtime-fit' : 'runtime-actual').click()
      assert.ok(await waitFor(() => h.app.evaluate(({ BrowserWindow }, args) => {
        const v = BrowserWindow.getAllWindows()[0]!.contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL().startsWith(args.url))!
        const bounds = v.getBounds()
        return v.getVisible() && (args.mode === '100%' ? bounds.width === args.viewport.width && bounds.height === args.viewport.height : bounds.width > args.viewport.width)
      }, { url, mode, viewport })))
      await h.app.evaluate(async ({ BrowserWindow }, args) => {
        const win = BrowserWindow.getAllWindows()[0]!
        const v = win.contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents.getURL().startsWith(args.url)) as import('electron').WebContentsView
        await v.webContents.executeJavaScript('window.hit=null')
        const scale = v.getBounds().width / args.viewport.width
        win.focus(); v.webContents.focus()
        v.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round((args.viewport.width - 20) * scale), y: Math.round((args.viewport.height - 20) * scale), button: 'left', clickCount: 1 })
        v.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round((args.viewport.width - 20) * scale), y: Math.round((args.viewport.height - 20) * scale), button: 'left', clickCount: 1 })
      }, { url, viewport })
      assert.ok(await waitFor(async () => (await probe()).hit === 'br'), `native ${mode}`)
      await h.app.evaluate(async ({ webContents }, base) => { await webContents.getAllWebContents().find(w => w.getURL().startsWith(base))!.executeJavaScript('window.hit=null') }, url)
      await perform('tap', { x: viewport.width - 20, y: viewport.height - 20 })
      assert.equal((await probe()).hit, 'br', `CDP ${mode}`)
    }
    const c = await h.client()
    await c.request('runtime.release', { sessionId: 'fixed', targetId: 'web:fixed' })
    if (await h.win.locator('.runtime-expanded').count() === 0) await h.win.getByTestId('runtime-expand').click()
    assert.ok(await waitFor(async () => (await h.win.getByTestId('runtime-control').textContent())?.includes('Взять управление') === true))
    const discovery = await c.request('runtime.discover', { sessionId: 'fixed' }) as { controllers: Record<string, string> }
    assert.equal(discovery.controllers['web:fixed'], 'agent')
    const local = await h.win.evaluate(async () => window.pult!.runtimePreview!('fixed'))
    assert.equal(local.coordinateWidth, viewport.width)
    assert.equal(local.coordinateHeight, viewport.height)
    assert.ok((local.image?.data.length ?? 0) <= 2_800_000)
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1680, 1050))
    const actual = h.win.getByTestId('runtime-actual')
    assert.ok(await waitFor(async () => await actual.isEnabled()))
    await actual.click()
    const img = h.win.getByTestId('runtime-screen').locator('img')
    assert.ok(await waitFor(async () => { const box = await img.boundingBox(); return box?.width === viewport.width && box?.height === viewport.height }))
    await h.screen(`fixed-viewport-${dpr}-observer-100`)
    await h.win.getByTestId('runtime-fit').click()
    assert.ok(await waitFor(async () => { const box = await img.boundingBox(); return !!box && (box.width !== viewport.width || box.height !== viewport.height) }))
    await assert.rejects(perform('tap', { x: 20, y: 20 }), /управление|управляет/)
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.locator('.runtime-expanded').count(), 0)
  })
})
