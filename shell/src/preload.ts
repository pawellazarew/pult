// preload окна Пульта: мост `window.pult` (docs/12 §2). Работает в песочнице (sandbox: true),
// поэтому этот файл собирается ОДНИМ бандлом без внешних require, кроме `electron`.
// В окно уходят только функции ниже; ipcRenderer и сам Electron окну не видны.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { BRIDGE_VERSION, IPC } from './contract.js'
import type { AllowedMethod, CallReply, ConnState, NavTarget, NotifyKind, NotifyTarget, PultBridge, PultEvent } from './contract.js'

const testMode = ipcRenderer.sendSync(IPC.testMode) === true

let subSeq = 0

// Цель перехода (уведомление, строка меню, ссылка pult://), пришедшая раньше, чем интерфейс подписался (новое окно:
// main шлёт кадр по did-finish-load, а React вешает onNavigate позже, в эффекте). Без буфера
// такой кадр терялся. Хранится одна — последняя.
let navPending: NavTarget | null = null
let navListener: ((t: NavTarget) => void) | null = null
ipcRenderer.on(IPC.navigate, (_e: IpcRendererEvent, t: NavTarget) => {
  if (navListener) { navListener(t); return }
  // Два перехода до подписки интерфейса: побеждает последний, о вытесненном — строка в консоль окна.
  if (navPending) console.warn('pult: переход вытеснен следующим до готовности окна', { link: navPending.link === true })
  navPending = t
})

function unwrap(r: CallReply): unknown {
  if (r.ok) return r.result
  // Отказ — простой объект {code, message}: Error через contextBridge потерял бы код.
  throw { code: r.error.code, message: r.error.message }
}

const bridge: PultBridge = {
  version: BRIDGE_VERSION,
  testMode,

  async call(method: AllowedMethod, params?: Record<string, unknown>): Promise<unknown> {
    return unwrap((await ipcRenderer.invoke(IPC.call, method, params)) as CallReply)
  },

  subscribe(since: number, onEvent: (ev: PultEvent) => void): () => void {
    const id = `s${++subSeq}`
    const handler = (_e: IpcRendererEvent, subId: string, ev: PultEvent): void => {
      if (subId === id) onEvent(ev)
    }
    ipcRenderer.on(IPC.event, handler)
    void ipcRenderer.invoke(IPC.subscribe, id, since)
    return () => {
      ipcRenderer.removeListener(IPC.event, handler)
      void ipcRenderer.invoke(IPC.unsubscribe, id)
    }
  },

  onConnection(cb: (s: ConnState) => void): () => void {
    const handler = (_e: IpcRendererEvent, s: ConnState): void => cb(s)
    ipcRenderer.on(IPC.connection, handler)
    const now = ipcRenderer.sendSync(IPC.connectionGet) as ConnState | null
    if (now) cb(now)
    return () => { ipcRenderer.removeListener(IPC.connection, handler) }
  },

  async startDaemon(): Promise<void> {
    unwrap((await ipcRenderer.invoke(IPC.startDaemon)) as CallReply)
  },

  async stopDaemon(): Promise<boolean> {
    return unwrap((await ipcRenderer.invoke(IPC.stopDaemon)) as CallReply) === true
  },

  async pickFolder(): Promise<string | null> {
    return (await ipcRenderer.invoke(IPC.pickFolder)) as string | null
  },

  async revealPath(p: string): Promise<void> {
    await ipcRenderer.invoke(IPC.revealPath, p)
  },

  async openFile(p: string): Promise<'opened' | 'revealed'> {
    return unwrap(await ipcRenderer.invoke(IPC.openFile, p) as CallReply) as 'opened' | 'revealed'
  },

  async listFiles(sessionId: string, source = '.', showHidden = false) {
    return unwrap(await ipcRenderer.invoke(IPC.listFiles, sessionId, source, showHidden) as CallReply) as import('./contract.js').FileListing
  },

  async previewFile(sessionId: string, source: string) {
    return unwrap(await ipcRenderer.invoke(IPC.previewFile, sessionId, source) as CallReply) as import('./contract.js').FilePreview
  },

  async copyText(text: string): Promise<void> {
    await ipcRenderer.invoke(IPC.copyText, text)
  },

  async notify(title: string, body: string, target?: NotifyTarget, kind?: NotifyKind, opts?: { sound?: boolean }): Promise<void> {
    await ipcRenderer.invoke(IPC.notify, title, body, target ?? {}, kind ?? null, opts?.sound !== false)
  },

  async clipboardFilePaths(): Promise<string[]> {
    const r = await ipcRenderer.invoke(IPC.clipboardPaths)
    return Array.isArray(r) ? r.filter((p): p is string => typeof p === 'string') : []
  },

  async openExternal(url: string): Promise<void> {
    await ipcRenderer.invoke(IPC.openExternal, url)
  },

  async readImage(sessionId: string, source: string): Promise<{ dataUrl: string; name: string }> {
    return unwrap(await ipcRenderer.invoke(IPC.readImage, sessionId, source) as CallReply) as { dataUrl: string; name: string }
  },

  async saveImage(sessionId: string, source: string): Promise<boolean> {
    return unwrap(await ipcRenderer.invoke(IPC.saveImage, sessionId, source) as CallReply) === true
  },

  async openImage(sessionId: string, source: string): Promise<void> {
    unwrap(await ipcRenderer.invoke(IPC.openImage, sessionId, source) as CallReply)
  },

  pathsForFiles(files: File[]): string[] {
    // Путь знает только preload: с Electron 32 у File нет поля `path`.
    return Array.from(files ?? []).flatMap((f) => { try { const p = webUtils.getPathForFile(f); return p ? [p] : [] } catch { return [] } })
  },

  onNavigate(cb: (target: NavTarget) => void): () => void {
    navListener = cb
    if (navPending) { const t = navPending; navPending = null; cb(t) }
    return () => { if (navListener === cb) navListener = null }
  },
}

contextBridge.exposeInMainWorld('pult', bridge)
