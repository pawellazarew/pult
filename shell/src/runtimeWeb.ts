import { t as tr } from './i18n.js'
import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron'
import type { RuntimeBounds, RuntimeHostJob, RuntimeResult } from '../../src/runtimes/types.js'
import { imageHeaderSize } from './clipboardImage.js'
import { runtimeBounds, runtimeFit, runtimeInputPoint, runtimeNumber, runtimeSessionId, runtimeWebUrl } from './runtimeWebPolicy.js'

/** Creation is synchronous: only these contents skip the app:// renderer's navigation ban. */
let creatingRuntimeContents = false
export const isCreatingRuntimeWeb = (): boolean => creatingRuntimeContents
export function createRuntimeWebView(factory: () => WebContentsView): WebContentsView {
  creatingRuntimeContents = true
  try { return factory() } finally { creatingRuntimeContents = false }
}

type BrowserPage = {
  instanceId: string
  view: WebContentsView
  window: BrowserWindow
  logs: Array<{ kind: string; text: string }>
  refs: Map<string, number>
  snapshot: number
  invalidation: number
  viewport: { width: number; height: number }
  scale: number
}
interface AxNode {
  ignored?: boolean
  backendDOMNodeId?: number
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: unknown }
}
export interface RuntimeWebOptions {
  window(): BrowserWindow | null
  createView(sessionId: string, instanceId: string): WebContentsView
  onAttach?(sessionId: string): void
  onEscape?(sessionId: string): void
}

/** The web host accepts operations, never raw JavaScript, CDP commands or contents IDs. */
export class RuntimeWeb {
  private readonly pages = new Map<string, BrowserPage>()
  private readonly bounds = new Map<string, RuntimeBounds & { actualSize?: boolean }>()
  private readonly windows = new WeakSet<BrowserWindow>()
  private active: string | null = null
  private readonly presentationRevision = new Map<string, number>()

  private pending: Promise<unknown> = Promise.resolve()
  private queued = 0
  private readonly localFrames = new Map<string, Promise<RuntimeResult>>()
  private serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.queued >= 16) return Promise.reject(new Error(tr('Браузер занят; повтори действие')))
    ++this.queued
    const next = this.pending.catch(() => {}).then(run)
    this.pending = next
    return next.finally(() => { --this.queued })
  }

  constructor(private readonly options: RuntimeWebOptions) {}

  setView(sessionId: string, raw: unknown, instanceId?: string, authorize?: () => Promise<boolean>): Promise<void> {
    return this.present(sessionId, raw, async () => ({ instanceId, authorize }))
  }

  requestView(sessionId: string, raw: unknown, lookup: () => Promise<{ instanceId: string; authorize: () => Promise<boolean> }>): Promise<void> {
    return this.present(sessionId, raw, lookup)
  }

  private present(sessionId: string, raw: unknown, lookup: () => Promise<{ instanceId?: string; authorize?: () => Promise<boolean> }>): Promise<void> {
    runtimeSessionId(sessionId)
    // Reserve the intent before any lookup; newer restrictive UI always supersedes it.
    const revision = (this.presentationRevision.get(sessionId) ?? 0) + 1
    this.presentationRevision.set(sessionId, revision)
    // Modal/collapse must hide immediately, even while a navigation owns the queue.
    if (raw === null) {
      this.bounds.delete(sessionId)
      if (this.active === sessionId) this.active = null
      const page = this.pages.get(sessionId)
      if (page && !page.view.webContents.isDestroyed()) page.view.setVisible(false)
    }
    return this.serial(async () => {
      if (this.presentationRevision.get(sessionId) !== revision) return
      const win = this.options.window()
      if (!win || win.isDestroyed()) throw new Error('Окно Пульта закрыто')
      const page = this.pages.get(sessionId)
      const bounds = runtimeBounds(raw, win.getContentBounds())
      const current = (): boolean => this.presentationRevision.get(sessionId) === revision && this.pages.get(sessionId) === page
      if (bounds) {
        try {
          const ownership = await lookup()
          if (!current()) return
          if (ownership.instanceId !== undefined && (!page || page.instanceId !== ownership.instanceId)) {
            page?.view.setVisible(false)
            this.bounds.delete(sessionId)
            if (this.active === sessionId) this.active = null
            return
          }
          const allowed = !ownership.authorize || await ownership.authorize()
          if (!current()) return
          if (!allowed) throw new Error(tr('Сначала возьми управление браузером'))
        } catch (error) {
          if (!current()) return
          this.bounds.delete(sessionId)
          if (this.active === sessionId) this.active = null
          page?.view.setVisible(false)
          try { await this.layout() } catch (layoutError) { if (!current()) return; throw layoutError }
          if (!current()) return
          throw error
        }
      }
      if (!current()) return
      if (bounds) { this.bounds.set(sessionId, { ...bounds, actualSize: (raw as { actualSize?: unknown }).actualSize === true }); this.active = sessionId }
      else { this.bounds.delete(sessionId); if (this.active === sessionId) this.active = null }
      try { await this.layout() } catch (error) { if (!current()) return; throw error }
    })
  }

  /** Trusted local observer only: full-size bounded frame, never the MCP image budget. */
  metadata(sessionId: string, instanceId: string): Promise<RuntimeResult> {
    return this.serial(async () => { const page = this.get(runtimeSessionId(sessionId), instanceId); if (!page.view.webContents.debugger.isAttached()) await this.layout(); return { ...this.status(page), coordinateWidth: page.viewport.width, coordinateHeight: page.viewport.height } })
  }
  preview(sessionId: string, instanceId: string): Promise<RuntimeResult> {
    const key = JSON.stringify([sessionId, instanceId])
    const current = this.localFrames.get(key)
    if (current) return current
    const frame: Promise<RuntimeResult> = this.serial<RuntimeResult>(async () => {
      const page = this.get(runtimeSessionId(sessionId), instanceId)
      const wc = page.view.webContents
      const metadata = (): RuntimeResult => ({ ...this.status(page), coordinateWidth: page.viewport.width, coordinateHeight: page.viewport.height })
      // Human contents must never be hidden, resized, or captured by an observer poll.
      if (page.view.getVisible()) return metadata()
      const bounds = page.view.getBounds()
      if (bounds.width !== page.viewport.width || bounds.height !== page.viewport.height || page.scale !== 1 || !wc.debugger.isAttached()) {
        // A null-hide can precede a rejected/full queue. Repair only this hidden page;
        // a global layout would disturb another session's visible human contents.
        page.view.setBounds({ x: 0, y: 0, ...page.viewport })
        await this.command(page, 'Emulation.setDeviceMetricsOverride', { ...page.viewport, deviceScaleFactor: 1, mobile: false, scale: 1 })
        if (this.get(sessionId, instanceId) !== page) throw new Error(tr('Экземпляр сессии изменился; подключи браузер заново'))
        page.scale = 1
      }
      if (page.view.getVisible()) return metadata()
      // Electron 45.3.3 copies the available surface without waiting on the CDP
      // screenshot command that can hold this queue for its entire 10s timeout.
      const captured = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })
      if (this.get(sessionId, instanceId) !== page) throw new Error(tr('Экземпляр сессии изменился; подключи браузер заново'))
      const raw = captured.getSize()
      if (captured.isEmpty() || raw.width < page.viewport.width || raw.height < page.viewport.height) throw new Error(tr('Размер области страницы ещё недоступен'))
      const jpeg = captured.resize({ width: page.viewport.width, height: page.viewport.height }).toJPEG(90)
      const data = jpeg.toString('base64')
      const pixels = imageHeaderSize(jpeg)
      if (data.length > 2_800_000 || pixels?.width !== page.viewport.width || pixels.height !== page.viewport.height) throw new Error(tr('Крупный кадр превышает предел качества'))
      return { ...this.status(page), coordinateWidth: page.viewport.width, coordinateHeight: page.viewport.height,
        image: { data, mimeType: 'image/jpeg' }, width: pixels.width, height: pixels.height }
    }).finally(() => { if (this.localFrames.get(key) === frame) this.localFrames.delete(key) })
    this.localFrames.set(key, frame)
    return frame
  }

  available(): boolean {
    const win = this.options.window()
    return !!win && !win.isDestroyed()
  }

  private async layout(): Promise<void> {
    // No previous session may remain above the trusted UI during async CDP work.
    for (const page of this.pages.values()) if (!page.view.webContents.isDestroyed()) page.view.setVisible(false)
    for (const [id, page] of this.pages) {
      if (page.view.webContents.isDestroyed()) continue
      const bounds = this.bounds.get(id)
      const shown = id === this.active && !!bounds
      const draw = bounds ? runtimeFit(bounds, page.viewport, bounds.actualSize) : { x: 0, y: 0, ...page.viewport, scale: 1 }
      page.view.setVisible(false)
      page.view.setBounds({ x: draw.x, y: draw.y, width: draw.width, height: draw.height })
      if (page.view.webContents.getURL()) {
        await this.command(page, 'Emulation.setDeviceMetricsOverride', { ...page.viewport, deviceScaleFactor: 1, mobile: false, scale: draw.scale })
        page.scale = draw.scale
      }
      page.view.setVisible(shown && id === this.active && bounds === this.bounds.get(id))
    }
  }

  private get(sessionId: string, instanceId: string): BrowserPage {
    const page = this.pages.get(sessionId)
    if (!page || page.view.webContents.isDestroyed() || page.window.isDestroyed()) throw new Error('Сначала подключи встроенный браузер')
    if (page.instanceId !== instanceId) throw new Error('Экземпляр сессии изменился; подключи браузер заново')
    return page
  }

  private create(sessionId: string, instanceId: string): BrowserPage {
    const previous = this.pages.get(sessionId)
    if (previous?.instanceId === instanceId && !previous.view.webContents.isDestroyed() && !previous.window.isDestroyed()) return previous
    this.pages.delete(sessionId)
    if (previous) {
      if (!previous.window.isDestroyed()) previous.window.contentView.removeChildView(previous.view)
      if (!previous.view.webContents.isDestroyed()) previous.view.webContents.close({ waitForBeforeUnload: false })
    }
    const win = this.options.window()
    if (!win || win.isDestroyed()) throw new Error('Для встроенного браузера открой окно Пульта')
    const view = createRuntimeWebView(() => this.options.createView(sessionId, instanceId))
    const page: BrowserPage = { instanceId, view, window: win, logs: [], refs: new Map(), snapshot: 0, invalidation: 0, viewport: { width: 1280, height: 800 }, scale: 1 }
    const wc = view.webContents
    this.harden(wc, wc.session)
    wc.setZoomMode('isolated')
    wc.setZoomFactor(1)
    wc.debugger.on('detach', () => { page.view.setVisible(false); page.refs.clear(); ++page.invalidation })
    const push = (kind: string, text: string): void => {
      page.logs.push({ kind, text: text.slice(0, 2000) })
      if (page.logs.length > 100) page.logs.shift()
    }
    wc.on('console-message', (details) => push('console', details.message))
    wc.on('did-fail-load', (_e, code, description, _url, main) => { if (main) push('navigation', `${code}: ${description}`) })
    const invalidate = (): void => { page.refs.clear(); ++page.invalidation }
    wc.on('did-start-navigation', invalidate)
    wc.on('did-navigate-in-page', invalidate)
    wc.on('before-input-event', (event, input) => {
      invalidate()
      if ((input.control || input.meta) && ['+', '=', '-', '0'].includes(input.key)) { event.preventDefault(); return }
      // Layout hides the native surface while awaiting emulation; the current
      // presentation intent still owns Escape until a synchronous null-hide.
      if (input.type === 'keyDown' && input.key === 'Escape' && this.pages.get(sessionId) === page && this.active === sessionId && this.bounds.has(sessionId)) {
        event.preventDefault()
        this.options.onEscape?.(sessionId)
      }
    })
    wc.on('before-mouse-event', invalidate)
    wc.on('render-process-gone', (_e, details) => { invalidate(); push('crash', details.reason) })
    wc.once('destroyed', () => { if (this.pages.get(sessionId) === page) this.pages.delete(sessionId) })
    if (!this.windows.has(win)) {
      this.windows.add(win)
      win.once('closed', () => {
        for (const p of this.pages.values()) if (p.window === win && !p.view.webContents.isDestroyed()) p.view.webContents.close({ waitForBeforeUnload: false })
      })
    }
    wc.debugger.on('message', (_e, method, params: Record<string, unknown>) => {
      if (method === 'Network.loadingFailed') push('network', String(params['errorText'] ?? 'Запрос не выполнен'))
      if (method === 'Network.responseReceived') {
        const response = params['response'] as { status?: number; url?: string } | undefined
        if (response && typeof response.status === 'number' && response.status >= 400) push('network', `HTTP ${response.status} ${String(response.url ?? '').slice(0, 300)}`)
      }
    })
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
    view.setVisible(false)
    this.pages.set(sessionId, page)
    this.options.onAttach?.(sessionId)
    return page
  }

  private harden(wc: WebContents, ses: Session): void {
    const allowed = (url: string): boolean => { try { runtimeWebUrl(url); return true } catch { return false } }
    wc.on('will-navigate', (e, url) => { if (!allowed(url)) e.preventDefault() })
    wc.on('will-redirect', (e, url) => { if (!allowed(url)) e.preventDefault() })
    wc.on('will-frame-navigate', (e) => { if (!allowed(e.url)) e.preventDefault() })
    wc.on('will-attach-webview', (e) => e.preventDefault())
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-prevent-unload', (e) => e.preventDefault())
    wc.on('login', (e) => e.preventDefault())
    wc.on('select-bluetooth-device', (e, _devices, cb) => { e.preventDefault(); cb('') })
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.on('will-download', (event) => event.preventDefault())
    // Block all local/privileged schemes, including resource requests, not only top-level navigation.
    // data/blob resources are allowed for ordinary apps, but cannot be loaded as main documents.
    ses.webRequest.onBeforeRequest((details, cb) => {
      const url = details.url
      const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase()
      cb({ cancel: !['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'].includes(scheme) })
    })
  }

  private async command(page: BrowserPage, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const wc = page.view.webContents
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
      // The first navigation creates the renderer before any CDP request.
      // Network.enable is sent under the same bounded command timeout below.
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        wc.debugger.sendCommand(method, params),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
          try { wc.debugger.detach() } catch { /* crashed page */ }
          reject(new Error('Страница не отвечает на действие браузера'))
        }, 10_000) }),
      ]) as Record<string, unknown>
    } finally { if (timer) clearTimeout(timer) }
  }

  private async navigate(page: BrowserPage, url: string): Promise<void> {
    const wc = page.view.webContents
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([wc.loadURL(url), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { wc.stop(); reject(new Error('Страница не загрузилась за 15 секунд')) }, 15_000)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }

  private status(page: BrowserPage): RuntimeResult {
    return { url: page.view.webContents.getURL(), title: page.view.webContents.getTitle() }
  }

  perform(job: RuntimeHostJob, validate?: () => Promise<void>): Promise<RuntimeResult> {
    return this.serial(async () => { await validate?.(); return this.performNow(job) })
  }

  private async performNow(job: RuntimeHostJob): Promise<RuntimeResult> {
    const id = runtimeSessionId(job.sessionId)
    const instanceId = job.instanceId ?? ''
    if (typeof instanceId !== 'string' || instanceId.length > 256) throw new Error('Неверный экземпляр сессии')
    const { action, input } = job
    if (action === 'detach') {
      const page = this.pages.get(id)
      if (page) {
        if (page.instanceId !== instanceId) throw new Error('Экземпляр сессии изменился; устаревшее отключение отклонено')
        this.pages.delete(id)
        if (!page.window.isDestroyed()) page.window.contentView.removeChildView(page.view)
        if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false })
      }
      return { text: 'Браузер отключён' }
    }
    if (action === 'attach') {
      const url = input['url'] === undefined ? undefined : runtimeWebUrl(input['url'])
      const page = this.create(id, instanceId)
      // A newly created WebContentsView has no renderer until its first load.
      // Sending CDP before loadURL can wait forever on that missing renderer.
      if (!page.view.webContents.getURL()) await this.navigate(page, 'about:blank')
      await page.view.webContents.setVisualZoomLevelLimits(1, 1)
      await this.layout()
      if (url) await this.navigate(page, url)
      await this.command(page, 'Network.enable')
      return this.status(page)
    }
    const page = this.get(id, instanceId)
    const wc = page.view.webContents
    if (!wc.debugger.isAttached()) await this.layout()
    switch (action) {
      case 'navigate': await this.navigate(page, runtimeWebUrl(input['url'])); await this.layout(); break
      case 'reload': await this.command(page, 'Page.reload'); break
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break
      case 'viewport': {
        const width = Math.round(runtimeNumber(input['width'], 1280, 240, 2560))
        const height = Math.round(runtimeNumber(input['height'], 800, 240, 2560))
        page.viewport = { width, height }
        page.refs.clear(); ++page.invalidation
        await this.layout()
        return { ...this.status(page), width, height }
      }
      case 'inspect': {
        const version = page.invalidation
        const result = await this.command(page, 'Accessibility.getFullAXTree')
        if (version !== page.invalidation) throw new Error('Страница изменилась: повтори inspect')
        page.refs.clear()
        const snapshot = ++page.snapshot
        const nodes = ((result['nodes'] ?? []) as AxNode[]).filter((n) => !n.ignored).slice(0, 350).map((node, index) => {
          const ref = `${snapshot}:${index}`
          if (node.backendDOMNodeId) page.refs.set(ref, node.backendDOMNodeId)
          return { ref, role: node.role?.value ?? '', name: String(node.name?.value ?? '').slice(0, 700), value: String(node.value?.value ?? '').slice(0, 700) }
        })
        return { ...this.status(page), snapshot, nodes, text: nodes.map((n) => `[${n.ref}] ${n.role} ${n.name}${n.value ? ` = ${n.value}` : ''}`).join('\n').slice(0, 70_000) }
      }
      case 'screenshot': {
        const metrics = await this.command(page, 'Page.getLayoutMetrics')
        const viewport = (metrics['cssVisualViewport'] ?? metrics['cssLayoutViewport']) as { clientWidth?: number; clientHeight?: number } | undefined
        const coordinateWidth = page.viewport.width
        const coordinateHeight = page.viewport.height
        if (!Number.isFinite(Number(viewport?.clientWidth)) || Number(viewport?.clientWidth) <= 0 || !Number.isFinite(coordinateWidth) || coordinateWidth <= 0 || !Number.isFinite(coordinateHeight) || coordinateHeight <= 0) throw new Error('Размер области страницы ещё недоступен')
        const snapshot = (data: string): RuntimeResult => {
          const pixels = imageHeaderSize(Buffer.from(data, 'base64'))
          return { ...this.status(page), coordinateWidth, coordinateHeight,
            ...(pixels ? { width: pixels.width, height: pixels.height } : {}),
            text: 'Coordinates for tap/swipe are CSS viewport points; image width/height are JPEG pixels.',
            image: { data, mimeType: 'image/jpeg' } }
        }
        const captured = await this.command(page, 'Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: true, captureBeyondViewport: false })
        const data = captured['data']
        if (typeof data !== 'string' || data.length > 530_000) {
          const small = (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).resize({ width: 900 }).toJPEG(45)
          if (small.length > 390_000 || small.length < 1) throw new Error('Изображение страницы слишком велико')
          return snapshot(small.toString('base64'))
        }
        return snapshot(data)
      }
      case 'tap': {
        let x: number, y: number
        if (typeof input['ref'] === 'string') {
          const node = page.refs.get(input['ref'])
          if (!node) throw new Error('Ссылка на элемент устарела: вызови inspect ещё раз')
          await this.command(page, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: node })
          const box = await this.command(page, 'DOM.getBoxModel', { backendNodeId: node })
          const quad = (box['model'] as { content?: number[] } | undefined)?.content
          if (!quad || quad.length < 8) throw new Error('У элемента нет видимой области')
          x = ((quad[0] as number) + (quad[4] as number)) / 2
          y = ((quad[1] as number) + (quad[5] as number)) / 2
        } else {
          x = runtimeNumber(input['x'], -1, 0, 4096)
          y = runtimeNumber(input['y'], -1, 0, 4096)
        }
        const point = runtimeInputPoint({ x, y }, page.viewport, page.scale)
        // Electron 45.3.3's emulated surface requires presentation-scaled CDP
        // positions (qualified against native clicks); do not multiply by DPR.
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
        break
      }
      case 'type': {
        if (typeof input['text'] !== 'string' || input['text'].length > 20_000) throw new Error('Текст должен быть не длиннее 20 000 символов')
        await this.command(page, 'Input.insertText', { text: input['text'] })
        break
      }
      case 'swipe': case 'scroll': {
        const deltaX = runtimeNumber(input['deltaX'], 0, -5000, 5000)
        const deltaY = runtimeNumber(input['deltaY'], 500, -5000, 5000)
        const x = runtimeNumber(input['x'], 100, 0, 4096)
        const y = runtimeNumber(input['y'], 100, 0, 4096)
        const point = runtimeInputPoint({ x, y }, page.viewport, page.scale)
        await this.command(page, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY })
        break
      }
      case 'button': {
        const keys: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
          ENTER: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, TAB: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
          ESCAPE: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, BACKSPACE: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
        }
        const key = keys[String(input['name'] ?? '').toUpperCase()]
        if (!key) throw new Error('Допустимы ENTER, TAB, ESCAPE, BACKSPACE')
        await this.command(page, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key })
        await this.command(page, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
        break
      }
      case 'logs': return { ...this.status(page), logs: [...page.logs], text: page.logs.map((l) => `${l.kind}: ${l.text}`).join('\n') }
      default: throw new Error(`Действие браузера не поддерживается: ${action}`)
    }
    page.refs.clear()
    return this.status(page)
  }

  close(): void {
    for (const page of this.pages.values()) {
      if (!page.window.isDestroyed()) page.window.contentView.removeChildView(page.view)
      if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false })
    }
    this.pages.clear()
    this.bounds.clear()
    this.presentationRevision.clear()
  }
}
