// Список агентов слева: подпись статуса, сортировка, строка «папка · ветка». Чистые функции.
//
// ПОРЯДОК (docs/12 §3 п.1): сначала те, кто ждёт человека, потом работающие, потом остальные. Внутри
// групп — по началу последнего хода (`lastTurnAt`, затем `createdAt`, затем имя): беседа встаёт наверх
// один раз, когда человек отправил реплику, и стоит на месте, пока идёт ход и после него. События потока,
// инструменты, субагенты и фон порядок не двигают — строка не прыгает под курсором.

import { isUnread, parseAttention } from '../../../src/sessions/attention.js'
import type { SessionContext } from './context.js'
import type { TurnPhase } from './phase.js'
import type { AgentProvider, AgentRecord, Attention, QueueItem, SessionStatus, Tone } from './types.js'

export interface StatusView {
  label: string
  tone: Tone
  /** Нужен человек: янтарная подсветка строки и счёт в заголовке окна. */
  needsYou: boolean
  /** Ход идёт: кнопка «Стоп» и запрет новой реплики. */
  busy: boolean
}

const VIEWS: Record<SessionStatus, StatusView> = {
  cold: { label: 'холодный', tone: 'queued', needsYou: false, busy: false },
  idle: { label: 'готов', tone: 'ok', needsYou: false, busy: false },
  working: { label: 'идёт', tone: 'run', needsYou: false, busy: true },
  blocked_permission: { label: 'ждёт тебя', tone: 'wait', needsYou: true, busy: true },
  blocked_question: { label: 'ждёт ответа', tone: 'wait', needsYou: true, busy: true },
  limited: { label: 'лимит', tone: 'fail', needsYou: false, busy: false },
  interrupted: { label: 'остановлен', tone: 'queued', needsYou: false, busy: false },
  failed: { label: 'ошибка', tone: 'fail', needsYou: false, busy: false },
  done: { label: 'завершён', tone: 'queued', needsYou: false, busy: false },
}

export function statusView(s: SessionStatus | string | undefined): StatusView {
  return (s && (VIEWS as Record<string, StatusView>)[s]) || { label: s ? String(s) : '—', tone: 'queued', needsYou: false, busy: false }
}

/** То же число, что у демона (`SESSION_TITLE_MAX` в src/sessions/registry.ts; тест сверяет). */
export const AGENT_TITLE_MAX = 60

export interface AgentView {
  /** Ключ агента: им зовут демона и CLI. Не меняется. */
  name: string
  /** Название для людей; нет — показывается `name`. */
  title?: string
  provider: AgentProvider
  status: SessionStatus
  cwd: string
  branch?: string
  /** Корень исходного репозитория, если сессия в worktree: по нему сессия встаёт в проект. */
  repo?: string
  model?: string
  effort?: string
  pending: number
  /** ISO последней активности: последнее событие сессии или момент заведения. */
  lastActivity: string
  /** Неизменная дата из реестра: порядок работающих бесед не зависит от событий потока. */
  createdAt?: string
  /** Начало последнего хода человека: ключ порядка бесед. Нет — `createdAt`. */
  lastTurnAt?: string
  /** В архиве: в дереве — в секции «Архив», а не под проектом. */
  archived?: boolean
  /** Фоновые задачи сессии (субагенты, команды), которые ещё идут после ответа. */
  background?: { count: number; tasks: readonly string[] }
  /** Контекстное окно: из потока, а до первого `context.updated` в нём — из `agent.list`. */
  context?: SessionContext
  /**
   * О2: непрочитано — ход закончился, упал или спросил, а сессию с тех пор не показывали (или её
   * пометили ⌥⌘U). Считает демон по отметке «видел» (`agent.seen`), окно только читает.
   */
  unread?: boolean
  /** Последнее событие внимания сессии: вид и причина для карточки ошибки в Inbox. */
  attention?: Attention
  /** О2: реплики в очереди (превью от демона) — уйдут сами, когда ход кончится. */
  queue?: readonly QueueItem[]
  /** Очередь стоит после неудачного хода — до «Продолжить». */
  queuePaused?: boolean
  /** О3: браузер для агента включён (`headed` — окно браузера видно). */
  browser?: { headed?: boolean }
  /** Папка скачиваний и снимков страниц браузера — кнопка в подвале показывает её в Finder. */
  browserDownloads?: string
  /** M8d: как подтверждать действия; нет — `ask` (так жили все сессии до M8d). */
  approval?: 'read-only' | 'workspace' | 'full'
  /** M8d: Claude в `ask` — действующий режим из настроек владельца (`auto`, `default`, …). */
  claudeMode?: string
  /** 0.3.5: фаза хода из живого канала демона — строка «думает… 12 с» и подпись в дереве. */
  phase?: TurnPhase
}

/** Как агент подписан в окне: название, а без него — имя. */
export function agentLabel(a: { name: string; title?: string | undefined }): string {
  return a.title || a.name
}

/** 0 — ждут тебя, 1 — работают, 2 — остальные. */
export function statusRank(s: SessionStatus, pending = 0): number {
  const v = statusView(s)
  if (v.needsYou || pending > 0) return 0
  if (s === 'working') return 1
  return 2
}

/** Порядок бесед в любом списке: свежий ход выше, затем новее заведённая, затем имя (оно не меняется). */
export function byLastTurn(a: AgentView, b: AgentView): number {
  const time = (iso: string | undefined): number => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : 0 }
  return time(b.lastTurnAt ?? b.createdAt) - time(a.lastTurnAt ?? a.createdAt)
    || time(b.createdAt) - time(a.createdAt)
    || a.name.localeCompare(b.name)
}

export function sortAgents(list: readonly AgentView[]): AgentView[] {
  return [...list].sort((a, b) => {
    const r = statusRank(a.status, a.pending) - statusRank(b.status, b.pending)
    if (r !== 0) return r
    return byLastTurn(a, b)
  })
}

/**
 * Собрать строки списка: запись реестра (`agent.list`) + живой статус из потока + активность.
 * Живой статус важнее записанного: `agent.list` зовётся с задержкой, а поток приходит сразу.
 */
export function buildAgents(
  records: readonly AgentRecord[],
  live: Readonly<Record<string, { status?: SessionStatus; lastTs?: string; lastTurnTs?: string; pending?: number; background?: { count: number; tasks: readonly string[] }; context?: SessionContext; phase?: TurnPhase }>>,
): AgentView[] {
  return sortAgents(records.map((r) => {
    const l = live[r.name] ?? {}
    const lastActivity = l.lastTs && Date.parse(l.lastTs) > Date.parse(r.createdAt) ? l.lastTs : r.createdAt
    // Реестр знает ход после рестарта, живой поток — раньше `agent.list`; у обоих одно и то же `ts`.
    const lastTurnAt = l.lastTurnTs && Date.parse(l.lastTurnTs) > Date.parse(r.lastTurnAt ?? r.createdAt) ? l.lastTurnTs : r.lastTurnAt ?? r.createdAt
    const context = l.context ?? r.context
    // Демон старше 0.2.21 полей не знает — тогда ничего не «непрочитано», как и было.
    const attention = parseAttention(r.attention)
    const unread = isUnread({ attention, lastSeenEventId: r.lastSeenEventId, markedUnread: r.markedUnread })
    return {
      name: r.name,
      ...(r.title ? { title: r.title } : {}),
      provider: r.provider,
      status: l.status ?? r.lastStatus,
      cwd: r.cwd,
      ...(r.worktree?.branch ? { branch: r.worktree.branch } : {}),
      ...(r.worktree?.repo ? { repo: r.worktree.repo } : {}),
      ...(r.archived ? { archived: true } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
      pending: l.pending ?? r.pendingPermissions,
      lastActivity,
      createdAt: r.createdAt,
      lastTurnAt,
      ...(l.background?.count ? { background: l.background } : {}),
      ...(context ? { context } : {}),
      ...(attention ? { attention } : {}),
      ...(unread ? { unread: true } : {}),
      ...(Array.isArray(r.queue) && r.queue.length ? { queue: r.queue } : {}),
      ...(r.queuePaused === true ? { queuePaused: true } : {}),
      ...(r.browser ? { browser: r.browser.headed ? { headed: true } : {} } : {}),
      ...(r.browser && typeof r.browserDownloads === 'string' ? { browserDownloads: r.browserDownloads } : {}),
      ...(r.approval === 'read-only' || r.approval === 'workspace' || r.approval === 'full' ? { approval: r.approval } : {}),
      ...(typeof r.claudeMode === 'string' && r.claudeMode ? { claudeMode: r.claudeMode } : {}),
      ...(l.phase ? { phase: l.phase } : {}),
    }
  }))
}

/**
 * Путь для строки агента: домашняя папка → `~`, длинный путь — хвост из двух последних частей.
 * Домашняя папка угадывается по форме пути (/Users/<имя>, /home/<имя>) — окну её никто не сообщает.
 */
export function shortPath(p: string, max = 42): string {
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/.exec(p)
  const tilde = home ? `~${p.slice(home[1]!.length)}` : p
  if (tilde.length <= max) return tilde
  const parts = tilde.split('/').filter(Boolean)
  return `…/${parts.slice(-2).join('/')}`
}

/** «только что», «3 мин», «2 ч», «4 дн» — относительно `now`. */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'только что'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} ч`
  return `${Math.floor(h / 24)} дн`
}

/** Сколько агентов ждёт человека — для бейджа и заголовка окна. */
export function waitingCount(list: readonly AgentView[]): number {
  return list.filter((a) => statusRank(a.status, a.pending) === 0).length
}
