// Окно целиком: связь с демоном, поток событий, запросы к демону и горячие клавиши. Всё, что
// «событие → вид», — в model/*.ts; здесь только провода между мостом, свёрткой и компонентами.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ConnState, PultBridge, PultEvent } from '../../shell/src/contract.js'
import { errorText, isBridgeError } from './bridge.js'
import { ProjectTree } from './components/ProjectTree.js'
import { CMD, Icon, IS_MAC, Kbd } from './components/common.js'
import { Conversation } from './components/Conversation.js'
import type { SendMode } from './components/Conversation.js'
import { Header } from './components/Header.js'
import { FileWorkspace } from './components/FileWorkspace.js'
import { WorkspaceLayout } from './components/WorkspaceLayout.js'
import type { FileRequest } from './components/FileWorkspace.js'
import { FilePreviewContext } from './model/filePreviewContext.js'
import { ExternalSessions } from './components/ExternalSessions.js'
import { followLink, MdBridgeContext } from './components/Markdown.js'
import { Confirm, DoctorPanel, HotkeysHelp, Inbox, McpServersDialog, NewAgentDialog, RenameDialog } from './components/Panels.js'
import { SearchDialog } from './components/Search.js'
import { SettingsDialog } from './components/Settings.js'
import { guardFromExits } from './model/netGuard.js'
import type { GuardRule } from './model/netGuard.js'
import { configureParams, confirmNeeded, isNoop, modelWindows, settingsErrorText, settingsParams, shellHasSettings } from './model/sessionSettings.js'
import type { SettingsPick } from './model/sessionSettings.js'
import type { SettingsReply } from './model/newAgent.js'
import type { NewSessionSettings } from '../../src/sessions/settings.js'
import { APPROVAL_FULL_WARNING } from './model/newAgent.js'
import { UpdateBanner } from './components/UpdateBanner.js'
import { addDismissed, applyErrorText, checkErrorText, FOCUS_CHECK_STALE_MS, focusCheckWanted, updateBanner, upToDateNote, windowVersionFromUA } from './model/update.js'
import type { UpdateAction } from './model/update.js'
import type { UpdateStatus } from '../../src/core/rpc.js'
import type { McpListing } from './model/mcp.js'
import { connView } from './lib/conn.js'
import { agentLabel, buildAgents, statusView, waitingCount } from './model/agents.js'
import { blockedProviders, doctorGroups, doctorTone, guardFromDoctor, guardView } from './model/health.js'
import { hotkeyAction, userJumpAllowed } from './model/hotkeys.js'
import { itemForEvent, jumpStep } from './model/search.js'
import type { SearchHit, SearchReply } from './model/search.js'
import type { HotAction } from './model/hotkeys.js'
import { composerApproves, focusedRequest, inboxCounts, inboxList, inboxView, isInboxFilter, pendingBySession, reconcileInbox } from './model/inbox.js'
import type { InboxFilter } from './model/inbox.js'
import { isSnoozed, nextWaiting, pruneSnoozed, snooze, unsnooze } from './model/queue.js'
import type { Snoozed } from './model/queue.js'
import { startParams } from './model/newAgent.js'
import type { NewAgentForm } from './model/newAgent.js'
import { linkPrefill } from './model/newAgent.js'
import { armLinkGuard, keysGuarded, swallowsKey } from './lib/linkGuard.js'
import type { NewSessionPrefill } from '../../shell/src/contract.js'
import {
  applyEvents, beginEarlier, beginHydrate, bootState, EMPTY_STATE, failEarlier, failHydrate, finishEarlier, finishHydrate, needsHydrate,
  refreshesAgents, syncStatuses,
} from './model/state.js'
import { EMPTY_THROTTLE, flushThrottle, notificationFor, notifyRules, offerNotice } from './model/notify.js'
import type { Notice, NotifyRules, Throttle } from './model/notify.js'
import type { EventsSnapshot, HistoryPageReply, UiState } from './model/state.js'
import type { ConvItem } from './model/conversation.js'
import { PENDING_SENT_MAX_MS, pendingBubble, pendingConfirmed, willQueue } from './model/pending.js'
import type { QueueEditApi } from './model/queueEdit.js'
import type { PendingSend } from './model/pending.js'
import type { AgentRecord, DaemonStatus, DoctorReport, PendingPermission } from './model/types.js'
import type { ProviderCatalog } from './model/types.js'
import type { FilePathSource } from './model/paths.js'
import { isQuestionTool } from './model/questions.js'
import { applyPhaseFrame, EMPTY_PHASES, LIVE_CURSOR_BASE } from './model/phase.js'
import type { PhaseMap } from './model/phase.js'
import type { SessionContext } from './model/context.js'
import { closeTab, groupByProject, openTab, projectName, pruneTabs } from './model/projects.js'
import { plural } from './lib/ru.js'

declare global {
  interface Window {
    /** Только при PULT_TEST=1: e2e читает отсюда, что окно приняло. */
    __pultDebug?: { eventIds(): number[]; connLog(): Array<{ state: ConnState['state']; at: number }>; bootCursor(): number | null }
  }
}

type Modal = null | { type: 'new'; cwd?: string | null; prefill?: NewSessionPrefill; seq?: number } | { type: 'external' } | { type: 'doctor' } | { type: 'mcp' } | { type: 'stop'; name: string } | { type: 'rm'; name: string } | { type: 'hide'; path: string; sessions: readonly string[]; busy: readonly string[] } | { type: 'rename'; name: string } | { type: 'help' } | { type: 'search' }
  | { type: 'settings' } | { type: 'configure'; name: string; pick: SettingsPick; reason: 'full' | 'misfit'; text?: string }

const store = {
  get(k: string): string | null { try { return window.localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string): void { try { window.localStorage.setItem(k, v) } catch { /* хранилище недоступно — не страшно */ } },
  /** Список строк (вкладки, свёрнутые проекты); мусор в хранилище — пустой список. */
  list(k: string): string[] {
    try { const v = JSON.parse(this.get(k) ?? '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
  },
}

/** Переход из поиска, который за это время не дошёл до ленты (история не грузится, элемента нет), — брошен. */
const JUMP_TIMEOUT_MS = 30_000

/** Лента сессии с ранними страницами истории впереди (model/state.ts finishEarlier). */
function withEarlier(ui: UiState, name: string): readonly ConvItem[] {
  const items = ui.sessions[name]?.conv.items ?? []
  const early = ui.earlier[name]?.items
  return early && early.length ? [...early, ...items] : items
}

export function Console({ bridge }: { bridge: PultBridge }): ReactElement {
  const [conn, setConn] = useState<ConnState>({ state: 'connecting', attempt: 0 })
  const [ui, setUi] = useState<UiState>(EMPTY_STATE)
  // 0.3.5: фазы ходов из живого канала демона (кадры `turn.phase` мимо журнала).
  const [phases, setPhases] = useState<PhaseMap>(EMPTY_PHASES)
  const [records, setRecords] = useState<AgentRecord[]>([])
  // Имя → подпись (название или само имя): и «знаком ли агент окну», и текст уведомлений.
  const known = useRef<Map<string, string>>(new Map())
  useEffect(() => { known.current = new Map(records.map((r) => [r.name, agentLabel(r)])) }, [records])
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [statusAt, setStatusAt] = useState(0)
  const [doctor, setDoctor] = useState<{ report: DoctorReport | null; loading: boolean; error: string | null }>({ report: null, loading: false, error: null })
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState<string | null>(() => store.get('pult.selected'))
  // Вкладки открытых сессий (порядок — порядок открытия) и свёрнутые проекты: переживают перезапуск окна.
  const [tabs, setTabs] = useState<string[]>(() => { const t = store.list('pult.tabs'); const s = store.get('pult.selected'); return s ? openTab(t, s) : t })
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(store.list('pult.collapsed')))
  const [projects, setProjects] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [sidebarHidden, setSidebarHidden] = useState(() => store.get('pult.sidebarHidden') === '1')
  useEffect(() => { store.set('pult.sidebarHidden', sidebarHidden ? '1' : '0') }, [sidebarHidden])
  const [inboxOpen, setInboxOpen] = useState<boolean>(() => store.get('pult.inbox') === '1')
  const [filesOpen, setFilesOpen] = useState(false)
  const [filesExpanded, setFilesExpanded] = useState(false)
  const [fileRequest, setFileRequest] = useState<FileRequest | null>(null)
  useEffect(() => { if (inboxOpen) setFilesOpen(false) }, [inboxOpen])
  useEffect(() => {
    const resize = (): void => { if (window.innerWidth < 1200) setFilesExpanded(true) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>(() => { const f = store.get('pult.inboxFilter'); return isInboxFilter(f) ? f : 'all' })
  // M8c: плашка обновления. Скрытая крестиком версия помнится до следующей; версия окна — из user agent.
  // Скрытые крестиком «Доступна X» и «не встало» — списком: скрыть одно не должно воскрешать другое.
  const [updDismissed, setUpdDismissed] = useState<string[]>(() => store.list('pult.updateDismissed'))
  const [updBusy, setUpdBusy] = useState(false)
  // «Настройки» → «Обновления»: идёт ли «Проверить сейчас», чем кончился сам вызов, отказ «Обновить» оттуда.
  const [updCheck, setUpdCheck] = useState<{ checking: boolean; error: string | null; applyError: string | null }>({ checking: false, error: null, applyError: null })
  // Короткая плашка «Установлена последняя версия (X)» после ручной проверки, которой нечего ставить.
  const [updNote, setUpdNote] = useState<string | null>(null)
  const updNoteTimer = useRef<number | null>(null)
  useEffect(() => () => { if (updNoteTimer.current !== null) clearTimeout(updNoteTimer.current) }, [])
  const windowVersion = useMemo(() => windowVersionFromUA(typeof navigator !== 'undefined' ? navigator.userAgent : null), [])
  // О2: отложенные ⌃⌘L (только в окне) и «Повторить» в пути.
  const [snoozed, setSnoozed] = useState<Snoozed>({})
  const [retrying, setRetrying] = useState<Set<string>>(() => new Set())
  // Окно перед глазами: видно и в фокусе. Только тогда показ сессии считается «прочитал».
  const [windowActive, setWindowActive] = useState(() => document.visibilityState === 'visible' && document.hasFocus())
  const [modal, setModal] = useState<Modal>(null)
  const [focusChosen, setFocusChosen] = useState<string | null>(null)
  const [permBusy, setPermBusy] = useState<Set<string>>(() => new Set())
  const [send, setSend] = useState<{ sending: boolean; error: string | null }>({ sending: false, error: null })
  // M8e: реплика «отправляется…» — поле уже пустое, демон ещё не подтвердил (model/pending.ts).
  const [outgoing, setOutgoing] = useState<PendingSend | null>(null)
  /** Отправка из поля, чей ход вернёт строку чата в виду в списке (не очередь): см. `ProjectTree.revealSend`. */
  const [revealSend, setRevealSend] = useState<{ name: string; id: number } | null>(null)
  const pendingSeq = useRef(0)
  const [bannerError, setBannerError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderCatalog | null>(null)
  const [providersChecking, setProvidersChecking] = useState(false)
  // О3: «MCP-серверы» — ответ `mcp.list` и запись выбора.
  const [mcp, setMcp] = useState<{ listing: McpListing | null; loading: boolean; error: string | null; saving: boolean }>(
    { listing: null, loading: false, error: null, saving: false })
  // M8f: умолчания и последний выбор «+ Сессия» (`settings.get`); null — старый демон или оболочка.
  const [settings, setSettings] = useState<SettingsReply | null>(null)

  // Отладочный журнал — мимо React: e2e сверяет порядок и отсутствие повторов по КАЖДОМУ
  // доставленному кадру и моменты смены связи, а не то, что успело отрисоваться.
  const debug = useRef({ ids: [] as number[], conn: [] as Array<{ state: ConnState['state']; at: number }>, boot: null as number | null })
  useEffect(() => {
    if (!bridge.testMode) return
    const d = debug.current
    window.__pultDebug = { eventIds: () => [...d.ids], connLog: () => [...d.conn], bootCursor: () => d.boot }
    return () => { delete window.__pultDebug }
  }, [bridge])

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t) }, [])
  useEffect(() => { if (selected) store.set('pult.selected', selected) }, [selected])
  useEffect(() => { store.set('pult.tabs', JSON.stringify(tabs)) }, [tabs])
  useEffect(() => { store.set('pult.collapsed', JSON.stringify([...collapsed])) }, [collapsed])
  /** Открыть сессию: вкладка (если её нет) и активная. Сюда ведут дерево, уведомления, ⌘1…9, импорт. */
  const select = useCallback((name: string): void => {
    setTabs((t) => openTab(t, name))
    setSelected(name)
    // Пришёл к сессии сам (клик, вкладка, ⌘⌥L, уведомление) — она больше не отложена (О2, ⌃⌘L).
    setSnoozed((s) => unsnooze(s, name))
  }, [])
  useEffect(() => { store.set('pult.inbox', inboxOpen ? '1' : '0') }, [inboxOpen])
  useEffect(() => { store.set('pult.inboxFilter', inboxFilter) }, [inboxFilter])
  useEffect(() => {
    const upd = (): void => setWindowActive(document.visibilityState === 'visible' && document.hasFocus())
    window.addEventListener('focus', upd)
    window.addEventListener('blur', upd)
    document.addEventListener('visibilitychange', upd)
    return () => { window.removeEventListener('focus', upd); window.removeEventListener('blur', upd); document.removeEventListener('visibilitychange', upd) }
  }, [])

  // --- запросы к демону ------------------------------------------------------------
  const refreshAgents = useCallback(async (): Promise<void> => {
    try {
      const r = (await bridge.call('agent.list')) as { sessions: AgentRecord[] }
      setRecords(r.sessions)
      setLoaded(true)
      setUi((s) => syncStatuses(s, r.sessions))
    } catch { /* связь упала — придёт новое состояние */ }
  }, [bridge])

  // Старая оболочка `project.*` не пропускает — дерево тогда строится из одних папок сессий.
  const refreshProjects = useCallback(async (): Promise<void> => {
    try {
      const r = (await bridge.call('project.list')) as { projects: Array<{ path: string }> }
      setProjects(r.projects.map((p) => p.path))
    } catch { /* нет метода или связи — неявные проекты всё равно видны */ }
  }, [bridge])

  const refreshPerms = useCallback(async (): Promise<void> => {
    const askedAt = new Date().toISOString()
    try {
      const r = (await bridge.call('perm.list')) as { pending: PendingPermission[] }
      setUi((s) => { const inbox = reconcileInbox(s.inbox, r.pending, askedAt); return inbox === s.inbox ? s : { ...s, inbox } })
    } catch { /* см. выше */ }
  }, [bridge])

  const statusRef = useRef<DaemonStatus | null>(null)
  useEffect(() => { statusRef.current = status }, [status])
  /** Свежий статус канала — сразу в `daemon.status.update`: плашка и «Настройки» видят его без опроса. */
  const putUpdate = useCallback((u: UpdateStatus): void => { setStatus((s) => (s ? { ...s, update: u } : s)) }, [])
  // Снимок статуса застал проверку канала («Проверяю…») — переспросить через секунду, а не ждать опроса раз в 15 с.
  const refreshStatusRef = useRef<(() => Promise<void>) | null>(null)
  const updChecking = status?.update?.checking === true
  // 0.3.16: пока новая версия качается в фоне или идёт перезапуск — переспрашивать раз в 2 с: «Пульт X готов» и
  // «Перезапускаю…» должны появляться и уходить сразу, а не через 15 с опроса.
  const upd = status?.update
  const updMoving = upd?.staged?.state === 'downloading' || (upd?.continuing ?? null) !== null || (upd?.app?.applying ?? null) !== null
  useEffect(() => {
    if (!updChecking && !updMoving) return
    const t = window.setTimeout(() => { void refreshStatusRef.current?.() }, updChecking ? 1_000 : 2_000)
    return () => clearTimeout(t)
  }, [updChecking, updMoving, status])
  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const st = (await bridge.call('daemon.status')) as DaemonStatus
      setStatus(st)
      setStatusAt(Date.now())
    } catch { /* см. выше */ }
  }, [bridge])

  refreshStatusRef.current = refreshStatus
  const runDoctor = useCallback(async (): Promise<void> => {
    setDoctor((d) => ({ ...d, loading: true, error: null }))
    try {
      const report = (await bridge.call('doctor.run', { net: true })) as DoctorReport
      setDoctor({ report, loading: false, error: null })
    } catch (e) {
      setDoctor((d) => ({ ...d, loading: false, error: errorText(e) }))
    }
  }, [bridge])
  // Пути файлов для поля реплики (⌘V из Finder, перетаскивание). Старая оболочка мост не знает — поле как раньше.
  // Окно 0.1.16 ещё и сохраняет картинку из буфера (`clipboardImage.save`); у старого метода нет — ⌘V на картинке
  // подсказывает обновить окно.
  const filePaths = useMemo<FilePathSource | null>(() => {
    const { clipboardFilePaths, pathsForFiles, clipboardImage, attachments } = bridge
    if (!clipboardFilePaths || !pathsForFiles) return null
    return {
      clipboard: () => clipboardFilePaths(),
      ...(attachments ? { attachments } : {}),
      files: (f) => pathsForFiles(f),
      ...(clipboardImage && typeof clipboardImage.save === 'function' ? { image: (session: string) => clipboardImage.save(session) } : {}),
    }
  }, [bridge])
  const refreshSettings = useCallback(async (): Promise<void> => {
    try { setSettings(await bridge.call('settings.get') as SettingsReply) } catch { /* старый демон или оболочка — форма на встроенных умолчаниях */ }
  }, [bridge])
  const checkProviders = useCallback(async (): Promise<void> => {
    setProvidersChecking(true)
    try { setProviders(await bridge.call('providers.check') as ProviderCatalog) }
    catch (e) { setBannerError(errorText(e)) }
    finally { setProvidersChecking(false) }
  }, [bridge])

  // «Настройки» открылись — перечитать (правило стража могли сменить из терминала): диалог встанет на свежее.
  const settingsOpen = modal?.type === 'settings'
  useEffect(() => { if (settingsOpen) void refreshSettings() }, [settingsOpen, refreshSettings])

  const refreshTimer = useRef<number | null>(null)
  const scheduleRefresh = useCallback((): void => {
    if (refreshTimer.current !== null) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      void refreshAgents()
      void refreshStatus()
    }, 150)
  }, [refreshAgents, refreshStatus])
  useEffect(() => () => { if (refreshTimer.current !== null) clearTimeout(refreshTimer.current) }, [])

  // --- связь и поток событий -------------------------------------------------------
  // --- уведомления (О2): правила из `daemon.status.notify`, предел пачки — model/notify.ts ---------
  const rules = useRef<NotifyRules>(notifyRules(null))
  useEffect(() => { rules.current = notifyRules(status?.notify) }, [status])
  const throttle = useRef<Throttle>(EMPTY_THROTTLE)
  const flushTimer = useRef<number | null>(null)
  useEffect(() => () => { if (flushTimer.current !== null) clearTimeout(flushTimer.current) }, [])
  const showNotice = useCallback((n: Notice): void => {
    bridge.notify(n.title, n.body, n.target, n.kind, { sound: rules.current.sound }).catch(() => { /* уведомление — не обязанность */ })
  }, [bridge])
  const notify = useCallback((n: Notice): void => {
    // Окно в фокусе — человек и так смотрит на Пульт (оболочка проверит ещё раз). В счёт пачки не идёт.
    if (document.hasFocus()) return
    const r = offerNotice(throttle.current, n, Date.now())
    throttle.current = r.t
    if (r.show) { showNotice(n); return }
    if (r.flushAt === null || flushTimer.current !== null) return
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null
      const f = flushThrottle(throttle.current, Date.now())
      throttle.current = f.t
      if (f.summary && !document.hasFocus()) showNotice(f.summary)
    }, Math.max(0, r.flushAt - Date.now()))
  }, [showNotice])

  useEffect(() => bridge.onConnection((s) => {
    debug.current.conn.push({ state: s.state, at: Date.now() })
    setConn(s)
  }), [bridge])

  useEffect(() => {
    if (conn.state !== 'up') { setStatus(null); return }
    void refreshStatus()
    void refreshAgents()
    void refreshPerms()
    void runDoctor()
    void checkProviders()
    void refreshProjects()
    void refreshSettings()
    const t = setInterval(() => { void refreshStatus() }, 15_000)
    // `agent.start` события не пишет (session.started — это init самого CLI на первом ходу):
    // агент, заведённый из терминала, окно узнаёт опросом списка.
    const a = setInterval(() => { void refreshAgents() }, 4_000)
    return () => { clearInterval(t); clearInterval(a) }
  }, [conn, refreshStatus, refreshAgents, refreshPerms, runDoctor, checkProviders, refreshProjects, refreshSettings])
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'hidden') return
      setNow(Date.now())
      void refreshStatus(); void refreshAgents(); void refreshPerms(); void refreshProjects()
      // Окно вернулось, а канал давно не проверяли — попросить демона. Решает он: автопроверка включена,
      // не чаще раза в 10 минут на всех. Старая оболочка (без update.check) молча откажет.
      if (focusCheckWanted(statusRef.current?.update, Date.now())) {
        bridge.call('update.check', { ifOlderThanMs: FOCUS_CHECK_STALE_MS }).then((u) => { putUpdate(u as UpdateStatus); void refreshStatus() }, () => { /* не вышло — опрос статуса покажет */ })
      }
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [bridge, putUpdate, refreshStatus, refreshAgents, refreshPerms, refreshProjects])

  // Старт без доигрывания журнала (0.2.19, model/state.ts): снимок, когда связь поднялась, —
  // и поток с его курсора. Снимок ложится ПОВЕРХ того, что уже пришло из `perm.list`/`agent.list`.
  // Метода нет (старая оболочка: method_not_allowed, старый демон: not_found) — прежний путь,
  // доигрывание с нуля. Прочий отказ (таймаут, рестарт демона) — повтор через 2 с: иначе окно до
  // конца жизни сидело бы на 18-мегабайтном доигрывании из-за одной осечки.
  const [bootSince, setBootSince] = useState<number | null>(null)
  const [bootTry, setBootTry] = useState(0)
  useEffect(() => {
    if (bootSince !== null || conn.state !== 'up') return
    let gone = false
    let retry: number | null = null
    bridge.call('events.snapshot').then(
      (r) => {
        if (gone) return
        const snap = r as EventsSnapshot
        setUi((s) => bootState(snap, s))
        setBootSince(snap.cursor)
      },
      (e: unknown) => {
        if (gone) return
        if (isBridgeError(e) && (e.code === 'method_not_allowed' || e.code === 'not_found')) setBootSince(0)
        else retry = window.setTimeout(() => setBootTry((n) => n + 1), 2000)
      },
    )
    return () => { gone = true; if (retry !== null) clearTimeout(retry) }
  }, [bridge, conn, bootSince, bootTry])

  useEffect(() => {
    if (bootSince === null) return
    debug.current.boot = bootSince
    const queue: PultEvent[] = []
    let timer: number | null = null
    const flush = (): void => {
      timer = null
      const evs = queue.splice(0)
      if (!evs.length) return
      setUi((s) => applyEvents(s, evs))
      if (evs.some((e) => refreshesAgents(e) || (e.sessionId !== 'daemon' && !known.current.has(e.sessionId)))) scheduleRefresh()
      const t = Date.now()
      const minTurnMs = rules.current.minTurnSeconds * 1000
      for (const ev of evs) {
        const n = notificationFor(ev, t, known.current.get(ev.sessionId), { minTurnMs })
        if (n) notify(n)
      }
    }
    const off = bridge.subscribe(bootSince, (ev) => {
      debug.current.ids.push(ev.id)
      queue.push(ev)
      // Пачкой: доигрывание истории — сотни кадров, перерисовка на каждый — лишняя работа.
      if (timer === null) timer = window.setTimeout(flush, 24)
    })
    return () => { off(); if (timer !== null) clearTimeout(timer) }
  }, [bridge, scheduleRefresh, bootSince, notify])

  // 0.3.5: живой канал фаз хода — отдельная подписка с курсором от LIVE_CURSOR_BASE (src/sessions/turnPhase.ts).
  // Журнал по ней не идёт; первый кадр — `reset`, следом текущие фазы, дальше перемены (не чаще ~7 в секунду на
  // сессию). Рестарт демона оболочка переживает сама: переподписка с последним номером, демон снова шлёт `reset`.
  // Старый демон таких кадров не знает — карта просто пустая, строки фазы нет.
  useEffect(() => {
    const off = bridge.subscribe(LIVE_CURSOR_BASE, (ev) => { setPhases((m) => applyPhaseFrame(m, ev)) })
    return () => { off() }
  }, [bridge])
  // Связь упала — фазы устарели; поднимется — придут заново с `reset`.
  useEffect(() => { if (conn.state !== 'up') setPhases(EMPTY_PHASES) }, [conn.state])

  // Ссылка `pult://session/<имя>` на сессию, которой нет, — строка в шапке, а не молчание. Пока список
  // не пришёл (холодный старт по ссылке), судить рано: переход как есть, лишняя вкладка уйдёт сама.
  const loadedRef = useRef(false)
  useEffect(() => { loadedRef.current = loaded }, [loaded])
  const modalRef = useRef<Modal>(null)
  useEffect(() => { modalRef.current = modal }, [modal])
  const linkSeq = useRef(0)
  useEffect(() => bridge.onNavigate((t) => {
    if (t.link) {
      // Окно всплыло по чужой ссылке, а человек, возможно, печатал в другом приложении: фокус —
      // ни в одно поле, клавиши полсекунды глотаются, поле ввода сессии из ссылки фокус не берёт.
      armLinkGuard(Date.now(), t.sessionId)
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }
    // `pult://new` (О3): диалог новой сессии с заполненными полями. Открытый «Новая сессия» ссылка
    // не подменяет: человек мог уже что-то ввести, а подмена под рукой — способ подсунуть другое.
    // Старая оболочка `newSession` не шлёт — эта ветка у неё просто не срабатывает.
    const prefill = t.newSession !== undefined ? linkPrefill(t.newSession) : null
    if (prefill) {
      if (modalRef.current?.type === 'new') {
        setBannerError('Пришла ссылка pult:// — закрой диалог «Новая сессия» и открой ссылку снова')
        return
      }
      setModal({ type: 'new', prefill, seq: ++linkSeq.current })
      return
    }
    if (t.sessionId) {
      if (loadedRef.current && !known.current.has(t.sessionId)) setBannerError(`Сессии ${t.sessionId} нет — ссылка устарела или с опечаткой`)
      else select(t.sessionId)
    }
    if (t.permId) { setInboxOpen(true); setFocusChosen(t.permId) }
  }), [bridge, select])
  // Окно защиты после ссылки: Enter, ⌘Enter и буквы не доходят ни до горячих клавиш, ни до полей.
  // Ловим на window в фазе захвата — раньше любых обработчиков React и поля ввода.
  useEffect(() => {
    const guard = (e: KeyboardEvent): void => {
      if (!keysGuarded(Date.now()) || !swallowsKey(e.key)) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', guard, true)
    window.addEventListener('keypress', guard, true)
    return () => { window.removeEventListener('keydown', guard, true); window.removeEventListener('keypress', guard, true) }
  }, [])

  // --- вид ---------------------------------------------------------------------------
  const pending = useMemo(() => pendingBySession(ui.inbox), [ui.inbox])
  const agents = useMemo(() => {
    const live: Record<string, { status?: AgentRecord['lastStatus']; lastTs?: string; lastTurnTs?: string; pending: number; context?: SessionContext; phase?: PhaseMap[string] }> = {}
    for (const r of records) {
      const s = ui.sessions[r.name]
      const ph = phases[r.name]
      live[r.name] = { ...(s ? { status: s.status, lastTs: s.lastTs, ...(s.lastTurnTs ? { lastTurnTs: s.lastTurnTs } : {}), ...(s.background ? { background: s.background } : {}) } : {}), ...(s?.context ? { context: s.context } : {}), pending: pending[r.name] ?? 0, ...(ph ? { phase: ph } : {}) }
    }
    return buildAgents(records, live)
  }, [records, ui.sessions, pending, phases])
  // Удалённые сессии уходят из вкладок — но только после первого `agent.list`, иначе пустой
  // список на старте стёр бы сохранённые вкладки.
  useEffect(() => { if (loaded) setTabs((t) => { const n = pruneTabs(t, new Set(records.map((r) => r.name))); return n.length === t.length ? t : n }) }, [records, loaded])
  const groups = useMemo(() => groupByProject(projects, agents), [projects, agents])
  const archivedViews = useMemo(() => agents.filter((a) => a.archived), [agents])
  const tabViews = useMemo(() => tabs.flatMap((n) => agents.filter((a) => a.name === n)), [tabs, agents])
  const current = agents.find((a) => a.name === selected && tabs.includes(a.name)) ?? tabViews[0] ?? null
  const showFiles = (source?: string): void => {
    if (!current || !bridge.previewFile || !bridge.listFiles) return
    setFilesOpen(true); setInboxOpen(false); setFilesExpanded(window.innerWidth < 1200)
    setFileRequest((r) => ({ sessionId: current.name, path: source ?? '', nonce: (r?.nonce ?? 0) + 1 }))
  }
  const closeFiles = (): void => {
    setFilesOpen(false)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="toggle-files"]')?.focus())
  }
  // Лента открытой сессии — из истории, один раз (model/state.ts finishHydrate). Отказ не
  // повторяется в цикле: следующая попытка — при новом открытии или переподключении.
  const uiRef = useRef(ui)
  uiRef.current = ui
  const currentName = current?.name ?? null

  // --- О2: «прочитал» ------------------------------------------------------------------
  // Непрочитанная сессия открыта, окно перед глазами — через полсекунды демону уходит `agent.seen`
  // (отметка «видел» общая для окна, строки меню, дока и CLI). Новое событие внимания у открытой
  // сессии приходит обновлением `agent.list` и гасится тем же путём. Ключ — сессия и номер события:
  // отказ (старый демон или оболочка без метода) не повторяется в цикле.
  // ⌥⌘U держит пометку, пока человек не уйдёт с сессии и не вернётся: иначе её погасил бы этот же показ.
  // Отложенная (⌃⌘L) тоже не гаснет, пока к ней не придут сами: иначе «отложить» терял бы её из очереди.
  // Лента ещё грузится (старт по снимку) — человек ничего не видел, отметки нет.
  // `upTo` — номер события, которое было на экране: пришедшее, пока запрос летел, останется непрочитанным.
  const seenSent = useRef<string | null>(null)
  const heldUnread = useRef<string | null>(null)
  const seenTimer = useRef<number | null>(null)
  useEffect(() => { if (heldUnread.current !== currentName) heldUnread.current = null }, [currentName])
  const unreadKey = current?.unread ? `${current.name}:${current.attention?.id ?? 0}` : null
  const seenUpTo = current?.attention?.id ?? 0
  const currentSnoozed = current ? isSnoozed(current, snoozed) : false
  const historyShown = !currentName || !ui.lazy || ui.hydration[currentName] === 'done'
  useEffect(() => {
    if (!unreadKey) { seenSent.current = null; return }
    if (!currentName || !windowActive || conn.state !== 'up' || !historyShown || currentSnoozed
      || heldUnread.current === currentName || seenSent.current === unreadKey) return
    const t = window.setTimeout(() => {
      seenTimer.current = null
      // ⌥⌘U мог прийти, пока таймер ждал.
      if (heldUnread.current === currentName) return
      seenSent.current = unreadKey
      bridge.call('agent.seen', { name: currentName, upTo: seenUpTo }).then(() => refreshAgents(), () => { /* старый демон — точка просто не гаснет */ })
    }, 500)
    seenTimer.current = t
    return () => { clearTimeout(t); if (seenTimer.current === t) seenTimer.current = null }
  }, [bridge, unreadKey, seenUpTo, currentName, windowActive, conn.state, historyShown, currentSnoozed, refreshAgents])
  useEffect(() => { setSnoozed((s) => pruneSnoozed(s, agents)) }, [agents])

  useEffect(() => {
    if (!currentName || conn.state !== 'up' || !needsHydrate(uiRef.current, currentName)) return
    setUi((s) => beginHydrate(s, currentName))
    bridge.call('events.history', { sessionId: currentName }).then(
      (r) => setUi((s) => finishHydrate(s, currentName, r as HistoryPageReply)),
      (e: unknown) => {
        setUi((s) => failHydrate(s, currentName))
        // Переход из поиска ждал эту ленту — без неё ему некуда вести.
        setJump((j) => (j?.name === currentName ? null : j))
        setBannerError(`история сессии ${currentName} не загрузилась: ${errorText(e)}`)
      },
    )
  }, [bridge, currentName, conn, ui.lazy])
  const loadEarlier = useCallback((name: string): void => {
    const e = uiRef.current.earlier[name]
    if (!e || !e.more || e.loading || e.oldest === null) return
    setUi((s) => beginEarlier(s, name))
    bridge.call('events.history', { sessionId: name, before: e.oldest }).then(
      (r) => setUi((s) => finishEarlier(s, name, r as HistoryPageReply)),
      (err: unknown) => {
        setUi((s) => failEarlier(s, name))
        // Переход из поиска ждал эту страницу — бросаем его, иначе он просил бы её снова и снова.
        setJump(null)
        setBannerError(`ранняя история не загрузилась: ${errorText(err)}`)
      },
    )
  }, [bridge])
  // --- О2: переход к событию из поиска ⌘⇧F (model/search.ts jumpStep) ---------------------------------
  // Сессия открывается, лента собирается из истории, ранние страницы догружаются, пока событие не окажется
  // в ленте, — тогда Conversation прокручивает к нему и подсвечивает (`scrollTo`).
  const [jump, setJump] = useState<{ name: string; eventId: number; nonce: number; kind: string; parentId?: string } | null>(null)
  const jumpNonce = useRef(0)
  const jumpState = jump && currentName === jump.name ? jumpStep(ui, jump.name, jump.eventId) : null
  useEffect(() => {
    if (jump && jumpState === 'earlier') loadEarlier(jump.name)
    // Всё догружено, а элемента под событие в ленте нет (лента из другой истории, событие вне ленты) — бросаем.
    if (jump && jumpState === 'ready' && !itemForEvent(withEarlier(ui, jump.name), jump.eventId, jump)) setJump(null)
  }, [jump, jumpState, loadEarlier, ui])
  // Переход, который так и не случился за JUMP_TIMEOUT_MS, не должен выстрелить через минуты.
  const jumpLive = jump?.nonce ?? null
  useEffect(() => {
    if (jumpLive === null) return
    const t = window.setTimeout(() => setJump((j) => (j?.nonce === jumpLive ? null : j)), JUMP_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [jumpLive])
  // Ушёл на другую сессию, пока догружалось, — переход отменён.
  useEffect(() => { setJump((j) => (j && currentName !== null && j.name !== currentName ? null : j)) }, [currentName])
  const openHit = (hit: SearchHit): void => {
    setModal(null)
    // Сессию удалили, пока смотрели выдачу: открывать нечего.
    if (!agents.some((a) => a.name === hit.sessionId)) { setBannerError(`сессии ${hit.sessionId} больше нет`); return }
    select(hit.sessionId)
    setJump({ name: hit.sessionId, eventId: hit.eventId, nonce: ++jumpNonce.current, kind: hit.kind, ...(hit.parentId !== undefined ? { parentId: hit.parentId } : {}) })
  }
  const onScrolled = useCallback((nonce: number): void => { setJump((j) => (j?.nonce === nonce ? null : j)) }, [])
  const runSearch = useCallback((query: string): Promise<SearchReply> =>
    bridge.call('events.search', { query, limit: 100 }).then((r) => r as SearchReply), [bridge])
  const labels = useRef<Map<string, string>>(new Map())
  labels.current = new Map(agents.map((a) => [a.name, agentLabel(a)]))
  const labelOf = useCallback((name: string): string | null => labels.current.get(name) ?? null, [])
  // ⌥↑/⌥↓ — соседняя реплика человека в ленте открытой сессии.
  const [userJump, setUserJump] = useState<{ dir: -1 | 1; nonce: number } | null>(null)
  /** Меню сессии «Экспорт в Markdown»: демон пишет файл в PULT_HOME/exports, Finder показывает его. */
  const exportAgent = (name: string): void => {
    bridge.call('agent.export', { name }).then(
      (r) => bridge.revealPath((r as { path: string }).path).catch((e: unknown) => setBannerError(`файл выгружен, но Finder не открылся: ${errorText(e)}`)),
      (e: unknown) => setBannerError(`экспорт не удался: ${errorText(e)}`),
    )
  }
  const loadEvents = useCallback(
    (ids: number[]): Promise<PultEvent[]> => bridge.call('events.get', { ids }).then((r) => (r as { events: PultEvent[] }).events),
    [bridge],
  )
  /** Проект текущей сессии: ⌘N заводит новую сессию в нём же. */
  const currentProject = current ? groups.find((g) => g.sessions.some((s) => s.name === current.name))?.path ?? null : null
  const inbox = useMemo(() => inboxList(ui.inbox), [ui.inbox])
  // Inbox по фильтру (О2): запросы, ошибки, непрочитанное — model/inbox.ts.
  const inboxShown = useMemo(() => inboxView(inboxFilter, inbox, agents), [inboxFilter, inbox, agents])
  // ⌘↵ разрешает только видимую карточку: закрытый Inbox чужих запросов не показывает.
  const focused = focusedRequest(inbox, focusChosen, current?.name ?? null, inboxOpen ? inboxShown.perms : [], historyShown)
  // Поле реплики знает только запрос СВОЕЙ сессии: ⌘↵ в нём не разрешает карточку другой сессии из Inbox.
  const ownFocused = composerApproves(focused, current?.name ?? null)
  const inboxNums = useMemo(() => inboxCounts(inbox, agents), [inbox, agents])
  const guard = useMemo(() => guardView([...guardFromDoctor(doctor.report), ...ui.guard]), [doctor.report, ui.guard])
  const doctorGroupsList = useMemo(() => doctorGroups(doctor.report), [doctor.report])
  const blocked = blockedProviders(status?.providers)
  const view = connView(conn)
  const waiting = waitingCount(agents)

  useEffect(() => { document.title = waiting ? `Пульт · ждут ${waiting}` : 'Пульт' }, [waiting])

  // --- действия ----------------------------------------------------------------------
  const withPerm = (id: string, fn: () => Promise<unknown>): void => {
    setPermBusy((b) => new Set(b).add(id))
    fn().catch((e: unknown) => setBannerError(errorText(e))).finally(() => {
      setPermBusy((b) => { const n = new Set(b); n.delete(id); return n })
    })
  }
  // ⌘↵ зовёт `approve(id)` — без scope, то есть ОДИН раз. Шире — только кнопками карточки (M8d).
  const approve = (id: string, scope?: 'session' | 'rule'): void =>
    withPerm(id, () => bridge.call('perm.resolve', { id, decision: 'allow', ...(scope ? { scope } : {}) }))
  const answer = (id: string, answers: Record<string, { answers: string[] }>): void =>
    withPerm(id, () => bridge.call('perm.resolve', { id, decision: 'allow', answers }))
  const deny = (id: string, reason: string): void =>
    withPerm(id, () => bridge.call('perm.resolve', { id, decision: 'deny', ...(reason ? { message: reason } : {}) }))

  const sendPrompt = async (text: string, mode?: SendMode): Promise<boolean> => {
    if (!current) return false
    const name = current.name
    const sv = statusView(current.status)
    const nonce = ++pendingSeq.current
    // M8e: пузырь «отправляется…» сразу; реплика, которая встанет в очередь, ждёт под полем, а не в ленте.
    setOutgoing({
      name, text, ts: new Date().toISOString(), afterId: ui.lastId, phase: 'sending', nonce,
      inFeed: !willQueue(mode === 'queue' || mode === 'interrupt' ? mode : undefined,
        { busy: sv.busy, needsYou: sv.needsYou, queueLen: current.queue?.length ?? 0, queuePaused: current.queuePaused === true }),
    })
    const mine = (f: (p: PendingSend) => PendingSend | null) => (p: PendingSend | null): PendingSend | null => (p && p.nonce === nonce ? f(p) : p)
    const unmark = (r: { name: string; id: number } | null): { name: string; id: number } | null => (r?.id === nonce ? null : r)
    setRevealSend({ name, id: nonce })
    setSend({ sending: true, error: null })
    try {
      // О2: идёт ход — в очередь демона; ⌘Enter — прервать и сказать (демон ждёт, пока ход осядет).
      const r = (await bridge.call('agent.prompt', {
        name, text, ...(mode === 'queue' ? { queue: true } : {}), ...(mode === 'interrupt' ? { interrupt: true } : {}),
      })) as { queued?: boolean } | null
      setSend({ sending: false, error: null })
      if (r?.queued) {
        // В очереди ход начнёт демон сам, позже: строку тогда не дёргаем.
        setRevealSend(unmark)
        // В очереди: реплика видна под полем, когда придёт свежий `agent.list`, — пузырь до тех пор.
        await refreshAgents()
        setOutgoing(mine(() => null))
      } else setOutgoing(mine((p) => ({ ...p, phase: 'sent' })))
      return true
    } catch (e) {
      // Отказ: пузырь уходит, черновик возвращает поле (только в пустое), ошибка — под полем, как раньше.
      setOutgoing(mine(() => null))
      setRevealSend(unmark)
      setSend({ sending: false, error: errorText(e) })
      return false
    }
  }
  // Демон сказал «принято»: пузырь живёт, пока в ленте не появится настоящая реплика (обычно она приходит
  // раньше ответа — демон пишет её до стража сети) или пока не выйдет срок (поток оборвался, старый демон).
  useEffect(() => {
    if (outgoing?.phase === 'sent' && pendingConfirmed(withEarlier(ui, outgoing.name), outgoing.afterId)) setOutgoing(null)
  }, [outgoing, ui])
  const sentNonce = outgoing?.phase === 'sent' ? outgoing.nonce : null
  useEffect(() => {
    if (sentNonce === null) return
    const t = window.setTimeout(() => setOutgoing((p) => (p && p.nonce === sentNonce ? null : p)), PENDING_SENT_MAX_MS)
    return () => window.clearTimeout(t)
  }, [sentNonce])
  /** Очередь реплик под полем: ×, ↑/↓, «Продолжить». После — свежий `agent.list` (очередь живёт в нём). */
  const queueCall = (method: 'agent.queue.remove' | 'agent.queue.move' | 'agent.queue.resume', params: Record<string, unknown>): void => {
    bridge.call(method, params).then(() => refreshAgents(), (e: unknown) => setBannerError(errorText(e)))
  }

  /**
   * Правка реплики очереди (0.3.2) — через `agent.queue.move` с `hold`/`text`: метод уже в белом списке моста,
   * новое окно не нужно. Отказы (`queue_item_sent`/`queue_item_removed`, пусто, длинно) разбирает список.
   */
  const queueEditApi = (name: string): QueueEditApi => ({
    hold: async (id) => {
      const r = (await bridge.call('agent.queue.move', { name, id, hold: true })) as { edit?: { text?: unknown; holdMs?: unknown } } | null
      const text = r?.edit?.text
      // Старый демон молча переставил бы реплику вместо правки — без полного текста правку не открываем.
      if (typeof text !== 'string') throw new Error('демон не умеет править очередь — обнови Пульт')
      return { text, holdMs: typeof r?.edit?.holdMs === 'number' ? r.edit.holdMs : 10 * 60_000 }
    },
    save: async (id, text) => {
      try { await bridge.call('agent.queue.move', { name, id, text }) } finally { void refreshAgents() }
    },
    release: (id) => { bridge.call('agent.queue.move', { name, id, hold: false }).then(() => refreshAgents(), () => { /* реплики или сессии уже нет */ }) },
  })

  /** «Повторить» в карточке ошибки: последняя реплика заново (`agent.retry`), ошибка — прочитана. */
  const retryAgent = (name: string): void => {
    setRetrying((r) => new Set(r).add(name))
    bridge.call('agent.retry', { name }).then(() => refreshAgents(), (e: unknown) => setBannerError(errorText(e))).finally(() => {
      setRetrying((r) => { const n = new Set(r); n.delete(name); return n })
    })
  }
  /**
   * «Похоже, завис» (О2): «Ждать» — карточка прочитана до своего события, ход идёт дальше; «Прервать» — ещё и
   * стоп. Остановка события внимания не пишет — без отметки карточка «завис» висела бы после стопа.
   */
  const markSeen = (name: string, upTo: number): void => {
    bridge.call('agent.seen', { name, upTo }).then(() => refreshAgents(), (e: unknown) => setBannerError(errorText(e)))
  }
  /** ⌥⌘U: пометить непрочитанной — вернуться к ней позже. */
  const markUnread = (name: string): void => {
    heldUnread.current = name
    seenSent.current = null
    if (seenTimer.current !== null) { clearTimeout(seenTimer.current); seenTimer.current = null }
    bridge.call('agent.seen', { name, unread: true }).then(() => refreshAgents(), (e: unknown) => setBannerError(errorText(e)))
  }

  const stopAgent = (name: string): void => {
    setModal(null)
    bridge.call('agent.stop', { name }).catch((e: unknown) => setBannerError(errorText(e)))
  }
  const removeAgent = (name: string): void => {
    setModal(null)
    bridge.call('agent.rm', { name }).then(() => refreshAgents(), (e: unknown) => setBannerError(errorText(e)))
  }
  const renameAgent = async (name: string, title: string): Promise<boolean> => {
    try {
      await bridge.call('agent.rename', { name, title })
    } catch (e) {
      setBannerError(errorText(e))
      return false
    }
    await refreshAgents()
    return true
  }
  /** Кого останавливаем/удаляем: название, а рядом имя — названия не уникальны, имя — да. */
  const whoIs = (name: string): ReactElement => {
    const a = agents.find((x) => x.name === name)
    return a?.title ? <><b>{a.title}</b> (<span className="mono">{name}</span>)</> : <b>{name}</b>
  }

  const createAgent = async (form: NewAgentForm, rememberCwd: boolean): Promise<string | null> => {
    try {
      // M8f: `rememberCwd: false` — форму открыли уже с папкой (проект, ссылка): последний выбор её не запомнит.
      await bridge.call('agent.start', { ...startParams(form), ...(rememberCwd ? {} : { rememberCwd: false }) })
    } catch (e) {
      return errorText(e)
    }
    select(form.name)
    setModal(null)
    await refreshAgents()
    void refreshSettings()
    if (form.prompt.trim()) {
      try {
        await bridge.call('agent.prompt', { name: form.name, text: form.prompt.trim() })
      } catch (e) {
        setSend({ sending: false, error: errorText(e) })
      }
    }
    return null
  }

  const addProject = async (): Promise<void> => {
    const dir = await bridge.pickFolder()
    if (!dir) return
    try { await bridge.call('project.add', { path: dir }) } catch (e) { setBannerError(errorText(e)); return }
    await refreshProjects()
  }
  const pinProject = (path: string, pin: boolean): void => {
    bridge.call(pin ? 'project.add' : 'project.remove', { path }).then(() => refreshProjects(), (e: unknown) => setBannerError(errorText(e)))
  }
  /** M8d: «Убрать из списка» папки с сессиями — они в архив (вкладки закрываются), закрепление снимается. */
  const hideProject = (path: string, sessions: readonly string[]): void => {
    setModal(null)
    const before = { tabs, active: current?.name ?? null }
    for (const name of sessions) if (tabs.includes(name)) closeSessionTab(name)
    bridge.call('project.remove', { path, sessions: [...sessions] })
      .then(() => Promise.all([refreshProjects(), refreshAgents()]), (e: unknown) => {
        // Демон отказал (сессия занялась, пока шёл вопрос) — вкладки возвращаются как были.
        setTabs((t) => [...t, ...before.tabs.filter((n) => !t.includes(n))])
        if (before.active && sessions.includes(before.active)) setSelected(before.active)
        setBannerError(errorText(e))
      })
  }
  const toggleProject = (path: string): void => {
    setCollapsed((c) => { const n = new Set(c); if (n.has(path)) n.delete(path); else n.add(path); return n })
  }
  const archiveSession = (name: string, archived: boolean): void => {
    // В архиве вкладке нечего делать: сессия убрана с глаз. Вернуть — из секции «Архив».
    if (archived && tabs.includes(name)) closeSessionTab(name)
    bridge.call('agent.archive', { name, archived }).then(() => refreshAgents(), (e: unknown) => setBannerError(errorText(e)))
  }
  const closeSessionTab = (name: string): void => {
    const r = closeTab(tabs, name, current?.name ?? null)
    setTabs(r.tabs)
    setSelected(r.active)
  }

  /** О3: браузер для агента из меню сессии — со следующего хода. */
  const setBrowser = (name: string, on: boolean, headed: boolean): void => {
    bridge.call('agent.browser', { name, on, ...(on && headed ? { headed: true } : {}) }).then(() => refreshAgents(), (e: unknown) => setBannerError(errorText(e)))
  }
  /** «MCP-серверы»: серверы пользователя из ~/.claude.json. */
  const openMcp = (): void => {
    setModal({ type: 'mcp' })
    setMcp({ listing: null, loading: true, error: null, saving: false })
    bridge.call('mcp.list').then(
      (r) => setMcp((m) => ({ ...m, listing: r as McpListing, loading: false })),
      (e: unknown) => setMcp((m) => ({ ...m, loading: false, error: errorText(e) })),
    )
  }
  const saveMcp = (names: string[]): void => {
    setMcp((m) => ({ ...m, saving: true, error: null }))
    bridge.call('mcp.select', { names }).then(
      () => { setMcp((m) => ({ ...m, saving: false })); setModal(null); void runDoctor() },
      (e: unknown) => setMcp((m) => ({ ...m, saving: false, error: errorText(e) })),
    )
  }

  // --- M8f: модель, усилие, режим живой сессии; «Настройки» ---------------------------------------------
  const settingsOk = shellHasSettings(windowVersion)
  // Окна моделей из прошлых `context.updated` всех сессий: «не влезет: 300k > 200k» в меню подвала.
  const windows = useMemo(() => modelWindows(records.map((r) => ({ ...(r.model ? { model: r.model } : {}), context: ui.sessions[r.name]?.context ?? r.context ?? null }))), [records, ui.sessions])
  const configureAgent = (name: string, pick: SettingsPick, confirmed = false): void => {
    const a = agents.find((x) => x.name === name)
    if (!a || isNoop(pick, a)) return
    const need = confirmed ? null : confirmNeeded(pick)
    if (need) { setModal({ type: 'configure', name, pick, reason: need }); return }
    setModal(null)
    bridge.call('agent.configure', configureParams(name, pick, confirmed)).then(() => refreshAgents(), (e: unknown) => {
      // Окно не знало окна модели, а демон знает: спросить человека и повторить с подтверждением.
      if (isBridgeError(e) && e.code === 'needs_confirm') { setModal({ type: 'configure', name, pick, reason: 'misfit', text: e.message }); return }
      setBannerError(settingsErrorText(isBridgeError(e) ? e.code : null, errorText(e)))
    })
  }
  const saveSettings = async (next: NewSessionSettings, autoCheck: boolean | null, guardRule: { rule: GuardRule; expect: GuardRule } | null): Promise<string | null> => {
    // Флаг автопроверки и правило стража — только если сменились: старый демон их не принимает, и зря трогать файл незачем.
    const updates = autoCheck !== null && settings?.updates && autoCheck !== settings.updates.check ? autoCheck : undefined
    const guardNext = guardRule && settings?.network ? guardRule : undefined
    try {
      setSettings(await bridge.call('settings.set', settingsParams(next, updates, guardNext?.rule, guardNext?.expect)) as SettingsReply)
    } catch (e) {
      // Правило сменили снаружи — свежее в окне сразу; диалог открывается заново на нём.
      if (isBridgeError(e) && e.code === 'guard_changed') void refreshSettings()
      return settingsErrorText(isBridgeError(e) ? e.code : null, errorText(e))
    }
    if (updates !== undefined) void refreshStatus()
    setModal(null)
    return null
  }

  const resetProvider = (provider: string): void => {
    bridge.call('provider.reset', { provider }).then(() => refreshStatus(), (e: unknown) => setBannerError(errorText(e)))
  }

  // «Перезапустить» / «Сейчас» / «Повторить» (0.3.16): `update.apply` без target — дальше демон сам: ждёт ходы, ставит
  // пакет и перезапускается, а новый демон закрывает это окно, меняет Pult.app и открывает новое (черновики полей ввода
  // переживут это — model/drafts.ts). «Вернуть <from>» — `target: 'app', rollback`.
  const applyUpdate = (a: UpdateAction): void => {
    setUpdBusy(true)
    setUpdCheck((c) => ({ ...c, applyError: null }))
    const params = a.target === 'app'
      ? { target: 'app', ...(a.rollback ? { rollback: true } : {}) }
      : a.force ? { force: true } : {}
    bridge.call('update.apply', params)
      .then(() => refreshStatus(), (e: unknown) => {
        const text = isBridgeError(e) ? applyErrorText(e.code, e.message, a.target) : applyErrorText(null, errorText(e), a.target)
        setBannerError(text)
        setUpdCheck((c) => ({ ...c, applyError: text }))
      })
      .finally(() => setUpdBusy(false))
  }
  // «Проверить сейчас» (⌘, → «Обновления»): ручная проверка идёт в сеть всегда. Есть что ставить — плашка сразу
  // (и снова, если эту версию скрывали крестиком: человек сам спросил); нечего — короткое «последняя версия».
  const checkUpdates = (): void => {
    if (updCheck.checking) return
    setUpdCheck({ checking: true, error: null, applyError: null })
    setUpdNote(null)
    bridge.call('update.check').then((r) => {
      const u = r as UpdateStatus
      putUpdate(u)
      void refreshStatus()
      setNow(Date.now())
      setUpdCheck({ checking: false, error: null, applyError: null })
      if (u.available && u.latest && updDismissed.includes(u.latest.version)) {
        const next = updDismissed.filter((k) => k !== u.latest?.version)
        setUpdDismissed(next)
        store.set('pult.updateDismissed', JSON.stringify(next))
      }
      const note = upToDateNote(u)
      if (note) {
        setUpdNote(note)
        if (updNoteTimer.current !== null) clearTimeout(updNoteTimer.current)
        updNoteTimer.current = window.setTimeout(() => { updNoteTimer.current = null; setUpdNote(null) }, 6_000)
      }
    }, (e: unknown) => {
      setUpdCheck({ checking: false, error: checkErrorText(isBridgeError(e) ? e.code : null, errorText(e)), applyError: null })
    })
  }
  const updateView = updateBanner(status?.update, windowVersion, updDismissed)

  const startDaemon = (): void => {
    setStarting(true)
    setBannerError(null)
    bridge.startDaemon().then(
      () => setStarting(false),
      (e: unknown) => { setStarting(false); setBannerError(errorText(e)) },
    )
  }

  const copy = (text: string): void => {
    bridge.copyText(text).then(() => { setCopied(text); window.setTimeout(() => setCopied(null), 1600) }, () => { /* буфер недоступен */ })
  }

  // --- горячие клавиши ---------------------------------------------------------------
  const onHot = useRef<(a: HotAction, e: KeyboardEvent) => void>(() => {})
  onHot.current = (a, e) => {
    switch (a.type) {
      case 'openFiles':
        if (modal) return
        e.preventDefault(); showFiles(); return
      case 'quickSwitch':
        if (modal) return
        e.preventDefault()
        setSidebarHidden(false)
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="chat-filter"]')?.focus())
        return
      case 'toggleSidebar':
        if (modal) return
        e.preventDefault()
        setSidebarHidden((v) => !v)
        return
      case 'newAgent':
        if (modal) return
        e.preventDefault()
        if (conn.state === 'up') setModal({ type: 'new', cwd: currentProject })
        return
      case 'selectAgent': {
        // ⌘1…9 — первые видимые беседы единственного списка, с учётом поиска.
        if (modal) return
        const visible = [...document.querySelectorAll<HTMLElement>('.chat-section [data-sidebar-chat]')].filter((el) => !el.closest('details:not([open])'))
        const names = [...new Set(visible.map((el) => el.dataset.agent).filter((name): name is string => !!name))]
        const name = names[a.index]
        if (name) { e.preventDefault(); select(name) }
        return
      }
      case 'search':
        if (modal && modal.type !== 'search') return
        e.preventDefault()
        if (modal?.type === 'search') document.querySelector<HTMLInputElement>('[data-testid="search-input"]')?.select()
        else setModal({ type: 'search' })
        return
      case 'userJump':
        if (modal || !current || !userJumpAllowed(document.activeElement as HTMLElement | null)) return
        e.preventDefault()
        setUserJump((j) => ({ dir: a.dir, nonce: (j?.nonce ?? 0) + 1 }))
        return
      case 'help':
        e.preventDefault()
        setModal((m) => (m?.type === 'help' ? null : m ?? { type: 'help' }))
        return
      case 'settings':
        e.preventDefault()
        if (conn.state === 'up') setModal((m) => (m?.type === 'settings' ? null : m ?? { type: 'settings' }))
        return
      case 'toggleInbox':
        if (modal) return
        e.preventDefault()
        setFilesOpen(false)
        setInboxOpen((v) => !v)
        return
      case 'nextWaiting': {
        if (modal) return
        e.preventDefault()
        const next = nextWaiting(agents, current?.name ?? null, snoozed)
        if (next) select(next)
        return
      }
      case 'snooze': {
        // Отложить: текущая уходит в конец своего класса очереди (до нового события внимания) — и к следующей.
        if (modal || !current) return
        e.preventDefault()
        const after = snooze(snoozed, current)
        setSnoozed(after)
        const next = nextWaiting(agents, current.name, after)
        if (next) select(next)
        return
      }
      case 'markUnread':
        if (modal || !current) return
        e.preventDefault()
        markUnread(current.name)
        return
      case 'approveFocused': {
        // ⌘↵ из поля реплики — только свой запрос текущей сессии; вне поля — любой видимый (свой или в открытом Inbox).
        const fromComposer = (e.target as { getAttribute?(n: string): string | null } | null)?.getAttribute?.('data-testid') === 'composer'
        const target = fromComposer ? composerApproves(focused, current?.name ?? null) : focused
        if (modal || !target || (filesOpen && filesExpanded)) return
        // Вопрос модели ⌘↵ не «разрешает»: на него отвечают выбором в карточке.
        if (isQuestionTool(target.toolName)) return
        e.preventDefault()
        approve(target.id)
        return
      }
      case 'escape': {
        const info = document.querySelector<HTMLDetailsElement>('.chat-info[open], .health-menu[open]')
        if (!modal && info) { e.preventDefault(); const fromInfo = info.contains(document.activeElement); info.open = false; if (fromInfo) info.querySelector('summary')?.focus(); return }
        if (modal) { e.preventDefault(); setModal(null); return }
        if (filesOpen) { e.preventDefault(); closeFiles(); return }
        if (current && statusView(current.status).busy) { e.preventDefault(); setModal({ type: 'stop', name: current.name }) }
        return
      }
    }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const a = hotkeyAction(e, IS_MAC)
      if (a) onHot.current(a, e)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  return (
    // Реплики модели копируют код и открывают ссылки через мост — без прокидывания пропсов по ленте.
    <MdBridgeContext.Provider value={bridge}>
    <FilePreviewContext.Provider value={current && bridge.previewFile && bridge.listFiles ? { open: showFiles, basePath: current.cwd } : null}>
    <div className="app" data-conn={conn.state}>
      <Header conn={conn} status={status} statusAt={statusAt} now={now} guard={guard} usage={ui.usage}
        providers={providers} providersChecking={providersChecking} onProvidersCheck={() => void checkProviders()}
        doctorTone={doctorTone(doctor.report)} inboxCount={inboxNums.all} inboxOpen={inboxOpen}
        sidebarHidden={sidebarHidden} onToggleSidebar={() => setSidebarHidden((v) => !v)}
        filesOpen={filesOpen} filesAvailable={!!current && !!bridge.listFiles && !!bridge.previewFile} onFiles={() => filesOpen ? closeFiles() : showFiles()}
        onDoctor={() => { setModal({ type: 'doctor' }); if (!doctor.loading) void runDoctor() }}
        onInbox={() => { setFilesOpen(false); setInboxOpen((v) => !v) }} />

      {view.banner && (
        <div className="banner banner-fail" role="alert" data-testid="conn-banner">
          <Icon name="alert" />
          <span className="grow" title={view.reason ?? undefined}>
            <b>Демон недоступен.</b> {view.banner} Сессии ждут его: их ходы и история вернутся после запуска.
            {view.reasonVisible && view.reason ? <span className="banner-err"> {view.reason}</span> : null}
          </span>
          {bannerError && <span className="banner-err">{bannerError}</span>}
          <button type="button" className="btn btn-primary" onClick={startDaemon} disabled={starting} data-testid="start-daemon">
            {starting ? 'запускаю…' : 'Запустить демона'}
          </button>
        </div>
      )}
      {!view.banner && blocked.map((b) => (
        <div key={b.provider} className="banner banner-fail" role="alert" data-testid="provider-blocked">
          <Icon name="alert" />
          <span className="grow"><b>Провайдер {b.provider} остановлен целиком.</b> {b.reason ?? ''} — проверь VPN и вход, потом сними остановку.</span>
          <button type="button" className="btn" onClick={() => resetProvider(b.provider)} data-testid="provider-reset">Снять остановку</button>
        </div>
      ))}
      {!view.banner && guard.tone === 'fail' && (
        <div className="banner banner-wait" role="alert" data-testid="net-blocked">
          <Icon name="alert" />
          <span className="grow"><b>Страж сети не пускает ходы:</b> {guard.detail}.</span>
          <button type="button" className="btn" onClick={() => { setModal({ type: 'doctor' }); void runDoctor() }}>Перепроверить</button>
        </div>
      )}
      {!view.banner && (
        <UpdateBanner view={updateView} busy={updBusy} onAction={applyUpdate}
          onNotes={(url) => { void followLink(bridge, url, url) }}
          onDismiss={(v) => { const next = addDismissed(updDismissed, v); setUpdDismissed(next); store.set('pult.updateDismissed', JSON.stringify(next)) }} />
      )}
      {!view.banner && !updateView && updNote && (
        <div className="banner banner-update" role="status" data-testid="update-latest">
          <Icon name="info" />
          <span className="grow">{updNote}</span>
          <button type="button" className="btn btn-ghost btn-sm" title="Скрыть" aria-label="Скрыть" onClick={() => setUpdNote(null)}><Icon name="x" /></button>
        </div>
      )}
      {!view.banner && bannerError && (
        <div className="banner banner-wait" role="alert" data-testid="action-error">
          <Icon name="alert" />
          <span className="grow">{bannerError}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBannerError(null)}><Icon name="x" /></button>
        </div>
      )}

      <WorkspaceLayout sidebarHidden={sidebarHidden} inboxOpen={inboxOpen} filesOpen={filesOpen} filesExpanded={filesExpanded}>
        <div className="agents-col">
          <ProjectTree groups={groups} selected={current?.name ?? null} revealSend={revealSend} now={now} collapsed={collapsed}
            onSelect={select} onNew={(cwd) => setModal({ type: 'new', cwd })} onToggle={toggleProject}
            onAddProject={() => void addProject()} onPin={pinProject}
            onHide={(path, sessions, busy) => setModal({ type: 'hide', path, sessions, busy })}
            archived={archivedViews} onRename={(name) => setModal({ type: 'rename', name })}
            onArchive={archiveSession} onRemove={(name) => setModal({ type: 'rm', name })} onExport={exportAgent}
            onReveal={(p) => void bridge.revealPath(p)} onBrowser={setBrowser} />
          <button type="button" className="btn external-open" disabled={conn.state !== 'up'} onClick={() => setModal({ type: 'external' })} data-testid="open-external-sessions"><Icon name="folder" />Существующие чаты</button>
          <button type="button" className="btn sidebar-settings" onClick={() => setModal({ type: 'settings' })} data-testid="open-settings"><Icon name="tool" />Настройки<Kbd>{`${CMD},`}</Kbd></button>
          <div className="ag-foot mono" data-testid="event-count">журнал #{ui.lastId}</div>
        </div>
        <div className="conv-col">
        {current ? (
          <Conversation key={current.name} agent={current} items={withEarlier(ui, current.name)} now={now}
            historyLoading={ui.hydration[current.name] === 'loading'} loadEvents={loadEvents}
            earlier={ui.earlier[current.name]} onLoadEarlier={() => loadEarlier(current.name)}
            scrollTo={jump && jump.name === current.name && jumpState === 'ready'
              ? { eventId: jump.eventId, nonce: jump.nonce, kind: jump.kind, ...(jump.parentId !== undefined ? { parentId: jump.parentId } : {}) } : null}
            onScrolled={onScrolled} userJump={userJump}
            usage={ui.usage[current.provider]} focusedPerm={ownFocused?.id ?? null} permBusy={permBusy} link={conn.state}
            sending={send.sending} sendError={send.error}
            pending={pendingBubble(outgoing, current.name, withEarlier(ui, current.name))}
            onSend={sendPrompt} filePaths={filePaths}
            onQueueRemove={(id) => queueCall('agent.queue.remove', { name: current.name, id })}
            onQueueMove={(id, to) => queueCall('agent.queue.move', { name: current.name, id, to })}
            onQueueResume={() => queueCall('agent.queue.resume', { name: current.name })}
            onQueueEdit={queueEditApi(current.name)} onHelp={() => setModal({ type: 'help' })} onRename={(title) => renameAgent(current.name, title)}
            onStop={() => setModal({ type: 'stop', name: current.name })}
            onRemove={() => setModal({ type: 'rm', name: current.name })}
            onReveal={(p) => void bridge.revealPath(p)}
            onApprove={approve} onDeny={deny} onAnswer={answer} onFocusPerm={setFocusChosen}
            onOpenInbox={(permId) => { setInboxOpen(true); setFocusChosen(permId) }}
            {...(settingsOk && conn.state === 'up' ? { onConfigure: (pick: SettingsPick) => configureAgent(current.name, pick) } : {})}
            catalog={providers} windows={windows} />
        ) : (
          <section className="conv">
            <div className="conv-empty" data-testid="conv-empty">
              <h3>{conn.state !== 'up' ? 'Жду демона' : agents.length ? 'Открой сессию слева' : 'Здесь будет разговор'}</h3>
              <div>{agents.length
                ? 'Выбери беседу слева. Вверху списка — агенты, которые ждут ответа, затем работающие и недавние.'
                : 'Заведи сессию — выбери папку и провайдера, напиши, что сделать. Разрешения всех сессий собираются в Inbox справа.'}</div>
              <div className="keys mono"><span>{CMD}N — сессия</span><span>{CMD}1…9 — беседы</span><span>{CMD}I — Inbox</span><span>{CMD}⇧F — поиск</span><span>{CMD}/ — все клавиши</span></div>
            </div>
          </section>
        )}
        </div>
        {current && bridge.previewFile && bridge.listFiles && <FileWorkspace bridge={bridge} sessionId={current.name} cwd={current.cwd}
          open={filesOpen} expanded={filesExpanded} request={fileRequest} onClose={closeFiles}
          onExpand={() => setFilesExpanded((v) => window.innerWidth < 1200 ? true : !v)} />}
        {inboxOpen && (
          <Inbox items={inboxShown.perms} cards={inboxShown.sessions} filter={inboxFilter} counts={inboxNums} onFilter={setInboxFilter}
            agents={agents} focused={focused?.id ?? null} busy={permBusy} retrying={retrying} now={now}
            onFocus={setFocusChosen} onApprove={approve} onDeny={deny} onAnswer={answer} onClose={() => setInboxOpen(false)}
            onOpen={select} onRetry={retryAgent}
            onStop={(name, upTo, turnId) => {
              // Стоп только зависшего хода: он уже кончился — демон ответит `stopped: false` и ничего не тронет.
              bridge.call('agent.stop', { name, ...(turnId ? { turnId } : {}) }).catch((e: unknown) => setBannerError(errorText(e)))
              markSeen(name, upTo)
            }}
            onWait={markSeen} />
        )}
      </WorkspaceLayout>

      {modal?.type === 'new' && (
        <NewAgentDialog key={modal.seq ?? 0} taken={records.map((r) => r.name)} defaultCwd={modal.cwd ?? null} prefill={modal.prefill ?? null} catalog={providers} checking={providersChecking} onCheck={() => void checkProviders()}
          settings={settings} pickFolder={() => bridge.pickFolder()} filePaths={filePaths} onCreate={(form) => createAgent(form, !(modal.cwd || modal.prefill?.path))} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'external' && <ExternalSessions bridge={bridge} taken={records.map((r) => r.name)} onClose={() => setModal(null)}
        onImported={(name) => { select(name); setModal(null); void refreshAgents() }} />}
      {modal?.type === 'doctor' && (
        <DoctorPanel report={doctor.report} groups={doctorGroupsList} loading={doctor.loading} error={doctor.error} copied={copied}
          onRerun={() => void runDoctor()} onCopy={copy} onClose={() => setModal(null)} onMcp={openMcp} />
      )}
      {modal?.type === 'mcp' && (
        <McpServersDialog listing={mcp.listing} loading={mcp.loading} error={mcp.error} saving={mcp.saving}
          onSave={saveMcp} onClose={() => setModal({ type: 'doctor' })} />
      )}
      {modal?.type === 'stop' && (
        <Confirm title="Остановить ход?" testId="confirm-stop" action="Остановить" danger
          text={<>Сессия {whoIs(modal.name)} прервёт текущий ход. Разговор сохранится — можно продолжить новой репликой.</>}
          onOk={() => stopAgent(modal.name)} onCancel={() => setModal(null)} />
      )}
      {modal?.type === 'help' && <HotkeysHelp onClose={() => setModal(null)} />}
      {modal?.type === 'settings' && (
        <SettingsDialog settings={settings?.newSession ?? null} catalog={providers} onSave={saveSettings} onClose={() => setModal(null)}
          autoCheck={settings?.updates?.check ?? null}
          {...(settings?.network ? {
            netGuard: {
              rule: settings.network.guard,
              checks: [...guardFromExits(settings.network.exits), ...guardFromDoctor(doctor.report), ...ui.guard],
              checking: doctor.loading,
              onCheck: () => { void runDoctor().then(() => refreshSettings()) },
            },
          } : {})}
          updates={{
            status: status?.update, packageVersion: status?.update?.current ?? (conn.state === 'up' ? conn.daemon.version : null), windowVersion,
            checking: updCheck.checking, error: updCheck.error, applyError: updCheck.applyError, busy: updBusy, now,
            onCheck: checkUpdates, onApply: applyUpdate, onNotes: (url) => { void followLink(bridge, url, url) },
          }} />
      )}
      {modal?.type === 'configure' && (
        <Confirm testId="confirm-configure" danger
          title={modal.reason === 'full' ? 'Полный доступ?' : 'Разговор не влезет в окно модели'}
          action={modal.reason === 'full' ? 'Включить полный доступ' : 'Всё равно сменить'}
          text={modal.reason === 'full'
            ? <>Сессия {whoIs(modal.name)} со следующего хода: {APPROVAL_FULL_WARNING}.</>
            : <>{modal.text ?? (modal.pick.kind === 'model' ? `${modal.pick.misfit ?? ''}: разговор сессии больше окна модели ${modal.pick.model}` : '')}. Сменить модель сессии {whoIs(modal.name)} всё равно?
              Первый ход после смены модели дороже — кэш промпта у каждой модели свой.</>}
          onOk={() => configureAgent(modal.name, modal.pick, true)} onCancel={() => setModal(null)} />
      )}
      {modal?.type === 'search' && <SearchDialog run={runSearch} labelOf={labelOf} now={now} onOpen={openHit} onClose={() => setModal(null)} />}
      {modal?.type === 'rename' && (
        <RenameDialog name={modal.name} title={agents.find((a) => a.name === modal.name)?.title ?? ''}
          onSave={(title) => renameAgent(modal.name, title)} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'hide' && modal.busy.length > 0 && (
        <Confirm title="Пока нельзя убрать" testId="confirm-hide-busy" action="Понятно"
          text={<>Папка <b>{projectName(modal.path)}</b>: сначала останови {modal.busy.map((n, i) => <span key={n}>{i ? ', ' : ''}{whoIs(n)}</span>)} —
            {modal.busy.length === 1 ? ' она работает или ждёт тебя' : ' они работают или ждут тебя'}. Убрать в архив занятую сессию — потерять её из виду посреди дела.</>}
          onOk={() => setModal(null)} onCancel={() => setModal(null)} />
      )}
      {modal?.type === 'hide' && modal.busy.length === 0 && (
        <Confirm title="Убрать из списка?" testId="confirm-hide" action="Убрать"
          text={<>Папка <b>{projectName(modal.path)}</b>: {modal.sessions.length} {plural(modal.sessions.length, 'сессия уйдёт', 'сессии уйдут', 'сессий уйдут')} в архив,
            папка на диске не трогается. Новая сессия в этой папке вернёт её в список.</>}
          onOk={() => hideProject(modal.path, modal.sessions)} onCancel={() => setModal(null)} />
      )}
      {modal?.type === 'rm' && (
        <Confirm title="Удалить сессию?" testId="confirm-rm" action="Удалить" danger
          text={<>Сессия {whoIs(modal.name)} исчезнет из списка, её лента — тоже. Папка и worktree на диске останутся.</>}
          onOk={() => removeAgent(modal.name)} onCancel={() => setModal(null)} />
      )}
    </div>
    </FilePreviewContext.Provider>
    </MdBridgeContext.Provider>
  )
}
