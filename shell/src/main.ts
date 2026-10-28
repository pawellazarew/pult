// main-процесс окна Пульта (docs/12 §2). Тонкая оболочка: находит пакет pult, поднимает демона
// тем же кодом, что и CLI (`ensureDaemon` пакета), держит одно соединение клиента `shell`, отдаёт
// интерфейс из `<пакет>/dist/ui` по `app://pult/` и пропускает к демону только белый список методов.
// Ещё держит значок в строке меню macOS (модель меню — tray.ts): он живёт и без окна, — и
// принимает ссылки `pult://` (pultUrl.ts, docs/14 О3).
//
// Токен демона живёт только здесь: рендерер его не видит и подключиться к сокету не может (путь
// сокета и PULT_HOME виден ему в daemon.status/doctor.run — это не секрет: без токена рукопожатие
// не пройдёт, а песочница рендерера unix-сокетов не открывает).

import { realpathSync, readFileSync, writeFileSync, statSync, accessSync, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, session, shell, Tray,
} from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions, NativeImage, WebContents } from 'electron'
import { readScopedImage } from '../../src/core/images.js'
import { localFile } from './localFile.js'
import { listWorkspaceFiles, readWorkspaceFile } from '../../src/core/fileBrowser.js'
import { referencesFile } from '../../src/core/fileReferences.js'
import { APP_INDEX, APP_ORIGIN, APP_SCHEME, appHeaders, mimeOf, resolveAppPath } from './appPath.js'
import { parseBackoff } from './backoff.js'
import { readClipboardImageBytes, saveClipboardImage, SaveRate } from './clipboardImage.js'
import type { ClipboardItemsLike, SaveImageResult } from './clipboardImage.js'
import { readClipboardPaths } from './clipboardPaths.js'
import { importAttachment, importStoredAttachment, previewAttachment } from './attachmentStore.js'
import { BRIDGE_VERSION, IPC, isAllowedMethod, sanitizeParams, SUBSCRIBE_VIA_BRIDGE } from './contract.js'
import type { CallReply, ConnState, DaemonStatus, NavTarget, NotifyTarget } from './contract.js'
import { externalUrl } from './externalUrl.js'
import { DaemonLink } from './link.js'
import { locatePackage, resolveNode } from './locate.js'
import { isNotifyKind, notificationSound } from './notifySound.js'
import { checkPultUrl, LINK_GAP_MS, LinkGate, LinkRate, linkFromArgv, linkTarget, matchKnownPath, PULT_SCHEME } from './pultUrl.js'
import type { FsProbe } from './locate.js'
import { menuLabel, pendingFrom, sessionsFrom, trayModel } from './tray.js'
import type { TrayAction, TrayInput, TrayItem, TrayModel } from './tray.js'

type ClientModule = typeof import('../../src/cli/client.js')
type StartModule = typeof import('../../src/cli/startOnDemand.js')
type PathsModule = typeof import('../../src/core/paths.js')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEST_MODE = process.env['PULT_TEST'] === '1'

// Схема регистрируется ДО ready: standard + secure дают окну настоящий origin `app://pult`,
// на котором работают CSP 'self' и модульные скрипты.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
])

const realFs: FsProbe = {
  isFile: (p) => { try { return statSync(p).isFile() } catch { return false } },
  isExecutable: (p) => {
    try { accessSync(p, fsConstants.X_OK); return statSync(p).isFile() } catch { return false }
  },
  read: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
}

function log(msg: string, extra?: Record<string, unknown>): void {
  process.stderr.write(`pult-shell: ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`)
}

let mainWindow: BrowserWindow | null = null
let link: DaemonLink | null = null
let uiRoot = ''
/** PULT_HOME — из paths() пакета, как у демона; пусто до boot. */
let pultHome = ''
let tray: Tray | null = null
const saveRate = new SaveRate(1000)

/** Только наше окно и только наша страница: IPC из чужого фрейма молча отвергается. */
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  return url.startsWith(`${APP_ORIGIN}/`) && BrowserWindow.fromWebContents(e.sender) !== null
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

function fail(code: string, message: string): CallReply {
  return { ok: false, error: { code, message } }
}

function toReply(e: unknown): CallReply {
  const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'internal'
  return fail(code, (e as Error)?.message ?? String(e))
}

function registerAppProtocol(): void {
  const notFound = (): Response => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
  protocol.handle(APP_SCHEME, (req) => {
    const file = resolveAppPath(uiRoot, req.url)
    if (!file) return notFound()
    let real: string
    try { real = realpathSync(file) } catch { return notFound() }
    // Симлинк внутри dist/ui, указывающий наружу, — тоже выход за корень.
    const rel = path.relative(uiRoot, real)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return notFound()
    const type = mimeOf(real)
    if (!type || !realFs.isFile(real)) return notFound()
    return new Response(readFileSync(real), { status: 200, headers: appHeaders(type) })
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Пульт',
    backgroundColor: '#0E141B',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged || TEST_MODE,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('focus', () => { void link?.checkConnection() })
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  const wcId = win.webContents.id
  win.webContents.once('destroyed', () => link?.unsubscribePrefix(`${wcId}:`))
  void win.loadURL(APP_INDEX)
  return win
}

function showWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

/** Открыть окно и повести его к сессии, запросу или диалогу новой сессии (уведомление, строка меню, ссылка). */
function openAt(t: NavTarget): void {
  const w = showWindow()
  if (!t.sessionId && !t.permId && !t.newSession) return
  // Окно могли закрыть: showWindow создал новое, и страница ещё грузится. Кадр, отправленный
  // сейчас, ушёл бы до preload и потерялся — окно открылось бы не на той сессии. Ждём конца
  // загрузки; дальше до подписки интерфейса кадр держит preload.
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => w.webContents.send(IPC.navigate, t))
  else w.webContents.send(IPC.navigate, t)
}

// ------------------------------------------------------------------ ссылки pult:// (docs/14 О3)
// macOS шлёт `open-url` (в том числе до `ready`, если ссылка и запустила приложение), Linux —
// второй экземпляр с адресом в argv или адрес в argv первого. Всё сходится в `openLink`: разбор
// (pultUrl.ts), предел частоты, отказ — строка в лог без самой ссылки, годная — в ворота до конца
// boot(). На выходе из ворот папка `pult://new` сверяется с проектами и сессиями демона.

type LinkTestGlobals = {
  __pultTestLinks?: Array<{ via: string; ok: boolean; reason?: string; target?: NavTarget }>
  __pultTestLinkDelivered?: NavTarget[]
  __pultTestProtocolClient?: boolean
}

// Тестовый прогон может сжать окно предела частоты, чтобы шаги e2e не ждали по полторы секунды.
const linkGapEnv = TEST_MODE ? Number(process.env['PULT_TEST_LINK_GAP_MS']) : NaN
const linkRate = new LinkRate(Number.isFinite(linkGapEnv) && linkGapEnv >= 0 ? linkGapEnv : LINK_GAP_MS)
/** Ждать демона ради сверки папки — не дольше: холодный старт службы укладывается в секунды. */
const LINK_VET_WAIT_MS = 15_000

const linkGate = new LinkGate<NavTarget>((t) => {
  void vetLinkPath(t).then((v) => {
    if (TEST_MODE) ((globalThis as LinkTestGlobals).__pultTestLinkDelivered ??= []).push(v)
    // Без `steal`: окно встаёт впереди, когда человек сам переключится, — значок в доке подпрыгнет.
    // Чужая ссылка не должна выхватывать клавиатуру у приложения, в котором человек печатает.
    if (process.platform === 'darwin' && !TEST_MODE) app.focus()
    openAt(v)
  })
}, (why) => {
  log(why === 'overwritten' ? 'ссылка pult:// вытеснена следующей до старта окна' : 'ссылка pult:// потеряна: окно не поднялось')
})

const realpathOrNull = (p: string): string | null => { try { return realpathSync(p) } catch { return null } }

/** Проекты и папки сессий демона; демон не поднялся за LINK_VET_WAIT_MS или отказал — `null`. */
async function knownFolders(): Promise<string[] | null> {
  const deadline = Date.now() + LINK_VET_WAIT_MS
  while (link && link.current.state !== 'up' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  const l = link
  if (!l || l.current.state !== 'up') return null
  try {
    const [pl, al] = await Promise.all([l.call('project.list', {}), l.call('agent.list', {})])
    const projects = (pl as { projects?: Array<{ path?: unknown }> } | null)?.projects ?? []
    const sessions = (al as { sessions?: Array<{ cwd?: unknown }> } | null)?.sessions ?? []
    return [...projects.map((p) => p.path), ...sessions.map((s) => s.cwd)].filter((p): p is string => typeof p === 'string')
  } catch {
    return null
  }
}

/**
 * Папка ссылки → знакомая папка или ничего. Сессия в чужой папке исполняет её хуки и настройки
 * проекта, поэтому незнакомую папку окно не подставляет: `pathRejected`, выбирает человек.
 */
async function vetLinkPath(t: NavTarget): Promise<NavTarget> {
  const ns = t.newSession
  if (!ns?.path) return t
  const { path: p, ...rest } = ns
  const known = await knownFolders()
  const hit = known ? matchKnownPath(p, known, realpathOrNull) : null
  if (!hit) log('ссылка pult://: папка не из проектов и сессий — выбирает человек', { checked: known !== null })
  return { ...t, newSession: hit ? { ...rest, path: hit } : { ...rest, pathRejected: true } }
}

/** Принять ссылку. `false` — отвергнута или отброшена пределом частоты (окно тогда поднимает вызывающий). */
function openLink(raw: unknown, via: 'open-url' | 'argv'): boolean {
  const r = checkPultUrl(raw)
  const rec = (e: NonNullable<LinkTestGlobals['__pultTestLinks']>[number]): void => {
    if (TEST_MODE) ((globalThis as LinkTestGlobals).__pultTestLinks ??= []).push(e)
  }
  if (!r.ok) {
    rec({ via, ok: false, reason: r.reason })
    // Саму ссылку не пишем: в реплике может быть личное. Длины хватит, чтобы узнать свою.
    log('ссылка pult:// отвергнута', { via, reason: r.reason, length: typeof raw === 'string' ? raw.length : null })
    return false
  }
  if (!linkRate.allow(Date.now())) {
    rec({ via, ok: false, reason: 'частая ссылка' })
    log('ссылка pult:// отброшена: предыдущая пришла только что', { via, type: r.link.type })
    return false
  }
  rec({ via, ok: true, target: linkTarget(r.link) })
  log('ссылка pult://', { via, type: r.link.type })
  linkGate.offer(linkTarget(r.link))
  return true
}

// ------------------------------------------------------------------ строка меню (docs/12 §2)
// Значок со счётчиком ждущих запросов и меню: что ждёт человека, какие сессии есть, «Открыть
// Пульт», «Выйти». Обновляется по событиям демона и по смене связи — одним обновлением на пачку
// (TRAY_COALESCE_MS), тремя вызовами: `daemon.status`, `agent.list`, `perm.list`. Опроса нет.

const TRAY_COALESCE_MS = 200
/**
 * События, после которых меню и значок на доке устарели. О2: лимит и стражи — новые непрочитанные
 * ошибки. Отметку «видел» (`agent.seen`) демон событием не пишет: её из окна ловит обработчик `call`.
 */
const TRAY_EVENTS = new Set([
  'status.changed', 'permission.requested', 'permission.resolved', 'session.started', 'session.ended', 'daemon.started',
  'limit.hit', 'net.blocked', 'provider.blocked',
  // Сторож тишины: «похоже, завис» — непрочитанная ошибка, значок на доке растёт.
  'turn.stalled',
])
/** Методы окна, после которых меняется непрочитанное — значок на доке пересчитывается сразу. */
const TRAY_METHODS = new Set(['agent.seen', 'agent.retry', 'agent.rm'])

let trayTimer: ReturnType<typeof setTimeout> | null = null
let trayBusy = false
let trayAgain = false
let traySubscribed = false
let trayLast: TrayModel | null = null

type TrayTestGlobals = {
  __pultTestTray?: TrayModel
  __pultTestTrayIcon?: { empty: boolean; template: boolean; width: number; height: number; scales: number[] }
  __pultTestTrayClick?: (id: string) => boolean
}

function trayIcon(): NativeImage {
  // Рядом с dist/main.js: в рабочей копии — shell/build, в собранном приложении — build/ внутри
  // app.asar (electron-builder кладёт его по `files`). Вариант @2x nativeImage находит сам по имени.
  const icon = nativeImage.createFromPath(path.join(HERE, '..', 'build', 'trayTemplate.png'))
  // Имя на `Template` уже делает значок шаблонным (цвет подставляет система); явно — на случай
  // переименования файла.
  icon.setTemplateImage(true)
  return icon
}

function createTray(): void {
  const icon = trayIcon()
  const info = { empty: icon.isEmpty(), template: icon.isTemplateImage(), ...icon.getSize(), scales: icon.getScaleFactors() }
  if (info.empty) log('трей: значок не загрузился', { dir: path.join(HERE, '..', 'build') })
  tray = new Tray(icon)
  log('трей поднят', info)
  if (TEST_MODE) {
    const g = globalThis as TrayTestGlobals
    g.__pultTestTrayIcon = info
    // e2e жмёт пункт меню по id: нативное меню Playwright не открыть.
    g.__pultTestTrayClick = (id: string): boolean => {
      const item = trayLast?.items.find((i): i is Extract<TrayItem, { kind: 'item' }> => i.kind === 'item' && i.id === id)
      if (!item?.action || !item.enabled) return false
      runTrayAction(item.action)
      return true
    }
  }
  applyTray(trayModel({ conn: link?.current ?? { state: 'connecting', attempt: 0 }, status: null, sessions: null, pending: null }))
}

function runTrayAction(a: TrayAction): void {
  if (a.kind === 'quit') {
    // Выходит только оболочка: before-quit закрывает соединение, демон и сессии живут дальше.
    app.quit()
    return
  }
  if (!link) return
  // Клик в строке меню приложение не активирует: без этого окно встало бы позади текущего.
  // Тестовый прогон фокус у человека не отбирает.
  if (process.platform === 'darwin' && !TEST_MODE) app.focus({ steal: true })
  openAt(a.target)
}

function toMenuItem(i: TrayItem): MenuItemConstructorOptions {
  if (i.kind === 'separator') return { type: 'separator' }
  if (i.kind === 'header') return { type: 'header', label: menuLabel(i.label) }
  const action = i.action
  return {
    label: menuLabel(i.label),
    enabled: i.enabled,
    ...(i.sublabel ? { sublabel: i.sublabel, toolTip: i.sublabel } : {}),
    ...(action ? { click: () => runTrayAction(action) } : {}),
  }
}

function applyTray(m: TrayModel): void {
  if (!tray || tray.isDestroyed()) return
  trayLast = m
  // Значок на доке — та же модель, что и меню: одно обновление на пачку событий (docs/14 О2).
  if (process.platform === 'darwin') app.dock?.setBadge(m.badge)
  tray.setTitle(m.title, { fontType: 'monospacedDigit' })
  tray.setToolTip(m.tooltip)
  tray.setContextMenu(Menu.buildFromTemplate(m.items.map(toMenuItem)))
  if (TEST_MODE) (globalThis as TrayTestGlobals).__pultTestTray = m
}

/** Обновить меню. События идут пачками (ход — десятки кадров): одно обновление на пачку. */
function scheduleTray(): void {
  if (!tray || trayTimer) return
  trayTimer = setTimeout(() => { trayTimer = null; void refreshTray() }, TRAY_COALESCE_MS)
}

async function refreshTray(): Promise<void> {
  if (!tray || !link) return
  if (trayBusy) { trayAgain = true; return }
  trayBusy = true
  try {
    const l = link
    const input: TrayInput = { conn: l.current, status: null, sessions: null, pending: null }
    if (l.current.state === 'up') {
      const [st, ls, pl] = await Promise.allSettled([l.call('daemon.status'), l.call('agent.list', {}), l.call('perm.list', {})])
      const status = st.status === 'fulfilled' ? (st.value as DaemonStatus) : null
      input.status = status
      input.sessions = ls.status === 'fulfilled' ? sessionsFrom(ls.value) : null
      input.pending = pl.status === 'fulfilled' ? pendingFrom(pl.value) : null
      // Подписка — одна на жизнь оболочки, с курсора «сейчас»: прошлое журнала меню не нужно,
      // списки только что прочитаны. После переподключения пропущенное доигрывает DaemonLink.
      if (!traySubscribed && status && Number.isInteger(status.lastEventId)) {
        traySubscribed = true
        l.subscribe('tray', status.lastEventId, (ev) => { if (TRAY_EVENTS.has(ev.kind)) scheduleTray() })
      }
    }
    // Связь могла уйти, пока шли вызовы: модель строится по состоянию на конец, а не на начало.
    input.conn = l.current
    applyTray(trayModel(input))
  } finally {
    trayBusy = false
    if (trayAgain) { trayAgain = false; scheduleTray() }
  }
}

function stopTray(): void {
  if (trayTimer) { clearTimeout(trayTimer); trayTimer = null }
  tray?.destroy()
  tray = null
}

function hardenWebContents(): void {
  app.on('web-contents-created', (_e, contents: WebContents) => {
    contents.on('will-navigate', (ev) => ev.preventDefault())
    contents.on('will-redirect', (ev) => ev.preventDefault())
    contents.on('will-attach-webview', (ev) => ev.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

/** cwd берём у демона, не от renderer. Даже знакомый sessionId не даёт доступ к чужому media. */
async function imageForSession(sessionId: unknown, source: unknown) {
  if (!link || !pultHome || typeof sessionId !== 'string' || typeof source !== 'string') throw new Error('Изображение недоступно')
  const result = await link.call('agent.list', {}) as { sessions?: Array<{ name?: unknown; cwd?: unknown }> }
  const rec = result.sessions?.find((s) => s.name === sessionId)
  if (!rec || typeof rec.cwd !== 'string') throw new Error('Сессия недоступна')
  return readScopedImage({ home: pultHome, sessionId, cwd: rec.cwd, codexHome: process.env['CODEX_HOME'] }, source)
}

function registerIpc(): void {
  ipcMain.on(IPC.testMode, (e) => { e.returnValue = trusted(e) ? TEST_MODE : false })
  ipcMain.on(IPC.connectionGet, (e) => { e.returnValue = trusted(e) && link ? link.current : null })

  const workspace = async (sessionId: unknown): Promise<{ cwd: string }> => {
    if (!link || typeof sessionId !== 'string') throw new Error('Сессия недоступна')
    const result = await link.call('agent.list', {}) as { sessions?: Array<{ name?: unknown; cwd?: unknown }> }
    const rec = result.sessions?.find((s) => s.name === sessionId)
    if (!rec || typeof rec.cwd !== 'string') throw new Error('Сессия недоступна')
    return { cwd: rec.cwd }
  }
  ipcMain.handle(IPC.listFiles, async (e, sessionId: unknown, source: unknown = '.', hidden: unknown = false): Promise<CallReply> => {
    if (!trusted(e)) return fail('forbidden', 'Вызов не из окна Пульта')
    try {
      if (typeof source !== 'string' || typeof hidden !== 'boolean') throw new Error('Неверная папка')
      return { ok: true, result: await listWorkspaceFiles(await workspace(sessionId), source, hidden) }
    } catch { return fail('files_unavailable', 'Не удалось прочитать папку проекта') }
  })
  ipcMain.handle(IPC.previewFile, async (e, sessionId: unknown, source: unknown): Promise<CallReply> => {
    if (!trusted(e)) return fail('forbidden', 'Вызов не из окна Пульта')
    try {
      if (typeof source !== 'string' || typeof sessionId !== 'string' || !link) throw new Error('Неверный файл')
      const scope = await workspace(sessionId)
      try { return { ok: true, result: await readWorkspaceFile(scope, source) } } catch {
        // Files outside the workspace are only previewed when the conversation actually linked them.
        const history = await link.call('agent.read', { name: sessionId, format: 'json' }) as { events?: Array<{ kind?: string; data?: Record<string, unknown> }> }
        if (!referencesFile(history.events ?? [], source)) throw new Error('Файл вне проекта')
        return { ok: true, result: await readWorkspaceFile({ ...scope, allowedFiles: [source] }, source) }
      }
    } catch { return fail('file_unavailable', 'Файл недоступен: он перемещён, вне проекта или доступ к нему закрыт') }
  })

  ipcMain.handle(IPC.call, async (e, method: unknown, params: unknown): Promise<CallReply> => {
    if (!trusted(e)) return fail('forbidden', 'вызов не из окна Пульта')
    if (!isAllowedMethod(method)) return fail('method_not_allowed', `метод ${String(method)} окну не разрешён`)
    if (SUBSCRIBE_VIA_BRIDGE.has(method)) return fail('use_subscribe', `${method} — только через window.pult.subscribe`)
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      return fail('invalid_params', 'params — объект')
    }
    if (!link) return fail('no_daemon', 'демон недоступен')
    try {
      const result = await link.call(method, sanitizeParams(method, params as Record<string, unknown> | undefined))
      if (TRAY_METHODS.has(method)) scheduleTray()
      return { ok: true, result }
    } catch (err) {
      return toReply(err)
    }
  })

  ipcMain.handle(IPC.subscribe, (e, subId: unknown, since: unknown): boolean => {
    if (!trusted(e) || typeof subId !== 'string' || subId.length > 64 || !link) return false
    const wc = e.sender
    const cursor = typeof since === 'number' && Number.isFinite(since) && since >= 0 ? since : 0
    link.subscribe(`${wc.id}:${subId}`, cursor, (ev) => {
      if (!wc.isDestroyed()) wc.send(IPC.event, subId, ev)
    })
    return true
  })

  ipcMain.handle(IPC.unsubscribe, (e, subId: unknown): void => {
    if (!trusted(e) || typeof subId !== 'string' || !link) return
    link.unsubscribe(`${e.sender.id}:${subId}`)
  })

  ipcMain.handle(IPC.startDaemon, async (e): Promise<CallReply> => {
    if (!trusted(e) || !link) return fail('forbidden', 'вызов не из окна Пульта')
    try { await link.startDaemon(); return { ok: true, result: null } } catch (err) { return toReply(err) }
  })

  ipcMain.handle(IPC.stopDaemon, async (e): Promise<CallReply> => {
    if (!trusted(e) || !link) return fail('forbidden', 'вызов не из окна Пульта')
    const win = BrowserWindow.fromWebContents(e.sender)
    // Подтверждение — системным диалогом в main, а не только в интерфейсе: код страницы сам
    // остановить демона не может, нужен клик человека.
    const opts = {
      type: 'warning' as const,
      buttons: ['Остановить', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      message: 'Остановить демона Пульта?',
      detail: 'Все агенты остановятся, текущие ходы прервутся. Окно останется открытым — запустить демона можно кнопкой.',
    }
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (response !== 0) return { ok: true, result: false }
    try { await link.stopDaemon(); return { ok: true, result: true } } catch (err) { return toReply(err) }
  })

  ipcMain.handle(IPC.pickFolder, async (e): Promise<string | null> => {
    if (!trusted(e)) return null
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const], title: 'Папка агента' }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.revealPath, (e, p: unknown): void => {
    if (!trusted(e) || typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return
    shell.showItemInFolder(p)
  })

  ipcMain.handle(IPC.readImage, async (e, sessionId: unknown, source: unknown): Promise<CallReply> => {
    if (!trusted(e)) return fail('forbidden', 'вызов не из окна Пульта')
    try {
      const image = await imageForSession(sessionId, source)
      return { ok: true, result: { dataUrl: `data:${image.mimeType};base64,${image.bytes.toString('base64')}`, name: image.name } }
    } catch { return fail('image_unavailable', 'Изображение недоступно: файл отсутствует, вне папки проекта или формат не поддерживается') }
  })

  ipcMain.handle(IPC.openFile, async (e, raw: unknown): Promise<CallReply> => {
    if (!trusted(e)) return fail('forbidden', 'вызов не из окна Пульта')
    try {
      const file = localFile(raw)
      if (TEST_MODE) ((globalThis as { __pultTestFiles?: unknown[] }).__pultTestFiles ??= []).push(file)
      else if (file.action === 'reveal') shell.showItemInFolder(file.path)
      else { const error = await shell.openPath(file.path); if (error) throw new Error(error) }
      return { ok: true, result: file.action === 'open' ? 'opened' : 'revealed' }
    } catch { return fail('file_unavailable', 'Файл недоступен: он удалён, перемещён или нет доступа') }
  })

  ipcMain.handle(IPC.saveImage, async (e, sessionId: unknown, source: unknown): Promise<CallReply> => {
    if (!trusted(e)) return fail('forbidden', 'вызов не из окна Пульта')
    try {
      const image = await imageForSession(sessionId, source)
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = { title: 'Сохранить изображение', defaultPath: image.name }
      const selected = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (selected.canceled || !selected.filePath) return { ok: true, result: false }
      writeFileSync(selected.filePath, image.bytes)
      return { ok: true, result: true }
    } catch { return fail('image_unavailable', 'Не удалось сохранить изображение') }
  })

  ipcMain.handle(IPC.openImage, async (e, sessionId: unknown, source: unknown): Promise<CallReply> => {
    if (!trusted(e)) return fail('forbidden', 'вызов не из окна Пульта')
    try {
      const image = await imageForSession(sessionId, source)
      if (TEST_MODE) ((globalThis as { __pultTestOpened?: string[] }).__pultTestOpened ??= []).push(image.path)
      else { const error = await shell.openPath(image.path); if (error) throw new Error(error) }
      return { ok: true, result: null }
    } catch { return fail('image_unavailable', 'Не удалось открыть изображение') }
  })

  ipcMain.handle(IPC.copyText, (e, text: unknown): void => {
    if (!trusted(e) || typeof text !== 'string' || text.length > 100_000) return
    // Тестовый прогон системный буфер не трогает: e2e читает скопированное из main.
    if (TEST_MODE) { (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard = text; return }
    clipboard.writeText(text)
  })

  ipcMain.handle(IPC.openExternal, async (e, raw: unknown): Promise<void> => {
    if (!trusted(e)) return
    // Адрес — из текста модели, то есть чужой: пропускаем только http(s) и mailto (externalUrl.ts).
    const url = externalUrl(raw)
    if (!url) return
    // Тестовый прогон браузер не открывает: e2e читает открытое из main.
    if (TEST_MODE) { ((globalThis as { __pultTestOpened?: string[] }).__pultTestOpened ??= []).push(url); return }
    await shell.openExternal(url)
  })

  const clipboardPathsForAttachments = async (): Promise<string[]> => {
    // Тестовый прогон системный буфер не читает: e2e кладёт «скопированные файлы» в main.
    if (TEST_MODE) return [...((globalThis as { __pultTestClipboardPaths?: string[] }).__pultTestClipboardPaths ?? [])]
    return readClipboardPaths({
      async read(type) {
        for (const item of await clipboard.read()) {
          if (!item.types.includes(type)) continue
          const v = await item.getType(type)
          return v instanceof Blob ? await v.text() : ''
        }
        return ''
      },
    }, process.platform)
  }
  ipcMain.handle(IPC.clipboardPaths, async (e): Promise<string[]> => trusted(e) ? await clipboardPathsForAttachments() : [])

  // Окно 0.1.16: картинка из буфера → PNG в PULT_HOME/attachments/<сессия> (clipboardImage.ts). От окна — только имя
  // сессии (проверяется по правилу имён демона); путь решает main, байты — из системного буфера.
  ipcMain.handle(IPC.clipboardImage, async (e, session: unknown): Promise<SaveImageResult> => {
    if (!trusted(e)) return { error: 'вызов не из окна Пульта' }
    if (!pultHome) return { error: 'Пульт ещё не готов' }
    if (!saveRate.take(Date.now())) return { error: 'не чаще одной картинки в секунду' }
    // Тестовый прогон системный буфер не читает и не пишет: e2e кладёт байты картинки в main, дальше — тот же путь
    // (ClipboardItem → заголовок → nativeImage → PNG → файл).
    const testBytes = (globalThis as { __pultTestClipboardImage?: Uint8Array }).__pultTestClipboardImage
    const board: ClipboardItemsLike = TEST_MODE
      ? { read: async () => (testBytes ? [{ types: ['image/png'], getType: async () => new Blob([new Uint8Array(testBytes)], { type: 'image/png' }) }] : []) }
      : clipboard
    // nativeImage перекодирует в PNG: метаданные (EXIF, геометка) не уходят. Декодирует — только после проверки
    // размера по заголовку (бомба распаковки).
    const r = saveClipboardImage({
      home: pultHome,
      session,
      bytes: await readClipboardImageBytes(board),
      decode: (b) => nativeImage.createFromBuffer(b),
    })
    if ('error' in r) log('картинка из буфера не сохранена', { error: r.error })
    return r
  })

  ipcMain.handle(IPC.attachmentImport, (e, session: unknown, item: unknown) => {
    if (!trusted(e)) return { error: 'Вызов не из окна Пульта.' }
    return importStoredAttachment({ home: pultHome, session, item })
  })

  // Не exposed строковым методом рендерера: preload получает path у настоящего File через webUtils.
  ipcMain.handle(IPC.attachmentFiles, (e, session: unknown, item: unknown) => {
    if (!trusted(e)) return { error: 'Вызов не из окна Пульта.' }
    return importAttachment({ home: pultHome, session, item })
  })
  // Источник выбирается системой, а не строкой из страницы.
  ipcMain.handle(IPC.attachmentClipboard, async (e, session: unknown) => {
    if (!trusted(e)) return [{ error: 'Вызов не из окна Пульта.' }]
    const sources = await clipboardPathsForAttachments()
    if (sources.length > 20) return [{ error: 'Можно добавить не больше 20 файлов за один раз.' }]
    return sources.map((source) => importAttachment({ home: pultHome, session, item: { path: source } }))
  })

  ipcMain.handle(IPC.attachmentPreview, (e, session: unknown, source: unknown) => {
    if (!trusted(e)) return { error: 'Вызов не из окна Пульта.' }
    return previewAttachment({ home: pultHome, session, source, decode: (bytes) => nativeImage.createFromBuffer(bytes) })
  })

  ipcMain.handle(IPC.notify, (e, title: unknown, body: unknown, target: unknown, kind: unknown, sound: unknown): boolean => {
    if (!trusted(e) || typeof title !== 'string' || typeof body !== 'string') return false
    // Пока окно в фокусе, уведомление — шум: человек и так смотрит на Пульт.
    if (BrowserWindow.getFocusedWindow()) return false
    const t = sanitizeTarget(target)
    // Тестовый прогон системных уведомлений не показывает: e2e читает их список из main.
    if (TEST_MODE) {
      const g = globalThis as { __pultTestNotifications?: Array<{ title: string; body: string; target: NotifyTarget; kind?: string; sound?: string; silent?: boolean }> }
      ;(g.__pultTestNotifications ??= []).push({ title, body, target: t, ...(isNotifyKind(kind) ? { kind } : {}), ...notificationSound(kind, sound) })
      return true
    }
    if (!Notification.isSupported()) return false
    const n = new Notification({ title: title.slice(0, 120), body: body.slice(0, 400), ...notificationSound(kind, sound) })
    n.on('click', () => openAt(t))
    n.show()
    return true
  })
}

function sanitizeTarget(t: unknown): NotifyTarget {
  const out: NotifyTarget = {}
  if (t && typeof t === 'object') {
    const o = t as Record<string, unknown>
    if (typeof o['sessionId'] === 'string' && o['sessionId'].length <= 128) out.sessionId = o['sessionId']
    if (typeof o['permId'] === 'string' && o['permId'].length <= 128) out.permId = o['permId']
  }
  return out
}

async function boot(): Promise<void> {
  const located = locatePackage(process.env, realFs, { packaged: app.isPackaged })
  if ('error' in located) {
    // В лог тоже: диалог в безголовом прогоне (check-app) никто не видит, а причина нужна.
    log('пакет не найден', { error: located.error })
    linkGate.drop()
    dialog.showErrorBox('Пульт не найден', located.error)
    app.exit(1)
    return
  }
  const pkg = located.root
  uiRoot = realpathSync(path.join(pkg, 'dist', 'ui'))
  log('пакет найден', { root: pkg, via: located.via, bridge: BRIDGE_VERSION })

  // Код протокола — из самого пакета (один источник правды), а не копия в оболочке.
  const load = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(pkg, 'dist', rel)).href)) as T
  const clientMod = await load<ClientModule>('cli/client.js')
  const startMod = await load<StartModule>('cli/startOnDemand.js')
  const pathsMod = await load<PathsModule>('core/paths.js')
  const paths = pathsMod.paths(process.env)
  // Не `paths.attachments`: окно 0.1.16 может стоять при пакете старше, чей layout этого поля не знает.
  pultHome = paths.home
  const nodePath = resolveNode(process.env, paths.nodePath, realFs)

  link = new DaemonLink({
    connect: () => clientMod.connectClient(paths, { client: 'shell' }),
    ensure: async () => {
      try {
        return await clientMod.connectClient(paths, { client: 'shell' })
      } catch { /* демона нет — поднимаем */ }
      if (!nodePath) {
        throw Object.assign(new Error('node >= 22 не найден: задай PULT_NODE или поставь службу (pult daemon install)'), { code: 'no_node' })
      }
      const r = await startMod.ensureDaemon(paths, {
        client: 'shell',
        nodePath,
        env: process.env,
        warn: (s) => log(s.trim()),
      })
      return r.client
    },
    backoff: parseBackoff(process.env['PULT_SHELL_BACKOFF'], TEST_MODE),
    onState: (s: ConnState) => { broadcast(IPC.connection, s); scheduleTray() },
    log,
  })

  registerAppProtocol()
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  registerIpc()
  powerMonitor.on('resume', () => { void link?.checkConnection() })
  createTray()
  showWindow()
  // Ссылки, пришедшие до этой строки (холодный старт по ссылке), — теперь, в только что открытое окно.
  linkGate.open()
  void link.start()
}

app.setName('Pult')
// Тестовый прогон держит профиль Chromium внутри временного PULT_HOME: e2e не трогает профиль
// настоящего окна и не упирается в его блокировку одного экземпляра.
if (TEST_MODE && process.env['PULT_HOME']) app.setPath('userData', path.join(process.env['PULT_HOME'], 'shell-data'))
// Тестовый прогон не касается связки ключей macOS ни при каких обстоятельствах.
if (TEST_MODE) app.commandLine.appendSwitch('use-mock-keychain')

// Один экземпляр окна: второй запуск просто поднимает первое (а ссылку из его argv — открывает).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // Отвергнутая или отброшенная ссылка ведёт себя как второй запуск без ссылки: окно поднимается.
    const raw = linkFromArgv(argv)
    if (!(raw && openLink(raw, 'argv')) && link) showWindow()
  })
  // До `ready`: macOS отдаёт ссылку холодного старта сразу, обработчик должен уже висеть.
  app.on('open-url', (e, url) => { e.preventDefault(); openLink(url, 'open-url') })
  const coldLink = linkFromArgv(process.argv.slice(1))
  if (coldLink) openLink(coldLink, 'argv')
  // Обработчик ссылок в системе — только у собранного приложения и не в тестовом прогоне: e2e и
  // `npm start` из рабочей копии не перехватывают pult:// у установленного Пульта. Info.plist
  // (CFBundleURLTypes) пишет electron-builder по `build.protocols`.
  const registerScheme = app.isPackaged && !TEST_MODE
  if (registerScheme) app.setAsDefaultProtocolClient(PULT_SCHEME)
  if (TEST_MODE) (globalThis as LinkTestGlobals).__pultTestProtocolClient = registerScheme
  hardenWebContents()
  app.whenReady().then(boot).catch((e: unknown) => {
    log('старт оболочки провалился', { error: (e as Error).message })
    linkGate.drop()
    dialog.showErrorBox('Пульт не запустился', (e as Error).message)
    app.exit(1)
  })
  // Закрыть окно ≠ остановить сессии: демон живёт отдельно, приложение остаётся в доке и в строке
  // меню (macOS) — значок и без окна показывает, кто ждёт тебя. Выход — «Выйти из Пульта» или ⌘Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => { if (link) showWindow() })
  app.on('before-quit', () => { stopTray(); link?.close() })
}
