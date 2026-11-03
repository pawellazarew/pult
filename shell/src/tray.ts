import { t as tr } from './i18n.js'
import { getLanguage } from '../../src/i18n/core.js'
// Меню Пульта в строке меню macOS (docs/12 §2 «Строка меню»). Здесь только модель меню — чистая
// функция от состояния связи, `daemon.status`, `agent.list` и `perm.list`. Electron сюда не
// импортируется: main превращает модель в `Menu.buildFromTemplate`, юнит-тесты гоняют её как есть.
//
// Словарь — «сессия», не «агент»: продукт переименовывает агентов в сессии. Подписи статусов — те
// же, что в списке окна (`statusView` в ui/src/model/agents.ts): оболочка код интерфейса не
// импортирует, поэтому словарь продублирован, а юнит-тест сверяет его с окном.
//
// Демон недоступен — меню не показывает ни списка сессий, ни запросов: устаревший список выглядел
// бы живым. Остаются строка состояния демона, «Открыть Пульт» и «Выйти».

import type { PendingPermission } from '../../src/perm/broker.js'
import { needsYouCount, parseAttention } from '../../src/sessions/attention.js'
import type { Attention } from '../../src/sessions/attention.js'
import type { SessionRecord, SessionStatus } from '../../src/sessions/registry.js'
import type { ConnState, DaemonStatus, NotifyTarget } from './contract.js'

/** Строка `agent.list` — то, что нужно меню и значку на доке (О2: внимание и отметка «видел»). */
export type TraySession = Pick<SessionRecord, 'name' | 'title' | 'lastStatus' | 'lastEventId' | 'lastSeenEventId' | 'markedUnread' | 'archived'>
  & { pendingPermissions?: number; attention?: Attention | null }

/** Запрос из `perm.list`: разрешение или вопрос Codex (`requestUserInput`) — оба ждут человека. */
export type TrayRequest = Pick<PendingPermission, 'id' | 'sessionId' | 'toolName' | 'createdAt'>

export interface TrayInput {
  conn: ConnState
  /** `daemon.status`; null — не ответил. */
  status: Pick<DaemonStatus, 'version' | 'mode'> | null
  /** `agent.list`; null — списка нет (демон недоступен или не ответил). */
  sessions: readonly TraySession[] | null
  /** `perm.list`; null — как у `sessions`. */
  pending: readonly TrayRequest[] | null
}

/** Что делает пункт: открыть окно (на сессии или запросе) или выйти из оболочки. */
export type TrayAction = { kind: 'open'; target: NotifyTarget } | { kind: 'quit' }

export type TrayItem =
  | { kind: 'separator' }
  /** Заголовок раздела: «Ждут тебя», «Сессии». */
  | { kind: 'header'; label: string }
  | { kind: 'item'; id: string; label: string; enabled: boolean; sublabel?: string; action?: TrayAction }

export interface TrayModel {
  /**
   * Текст рядом со значком: сколько СЕССИЙ ждут тебя — то же число, что на доке (`dockBadge`): запрос
   * или вопрос плюс непрочитанная ошибка. Ноль — пусто. Два числа, которые расходятся, читались бы загадкой.
   */
  title: string
  /** Значок на доке (macOS): то же число, что `title`; ноль или нет связи — пусто. */
  badge: string
  tooltip: string
  items: TrayItem[]
}

/** Сколько запросов и сессий меню показывает поимённо; остальное — строкой «ещё N». */
export const TRAY_MAX_REQUESTS = 10
export const TRAY_MAX_SESSIONS = 15
/** Предел подписи пункта в знаках: меню шириной в пол-экрана никто не читает. */
const LABEL_MAX = 48

const STATUS_LABEL: Record<SessionStatus, string> = {
  cold: 'холодный',
  idle: 'готов',
  working: 'идёт',
  blocked_permission: 'ждёт тебя',
  blocked_question: 'ждёт ответа',
  limited: 'лимит',
  interrupted: 'остановлен',
  failed: 'ошибка',
  done: 'завершён',
}

/** Статус по-русски, как в списке окна; незнакомый — как есть. */
export function statusLabel(s: string): string {
  return tr((STATUS_LABEL as Record<string, string>)[s] ?? (s || '—'))
}

/** Как сессия подписана: название, а без него — имя. */
export function sessionLabel(s: { name: string; title?: string | undefined }): string {
  return s.title || s.name
}

/** Что просит запрос: вопрос Codex — «вопрос», остальное — имя инструмента. */
export function requestWhat(toolName: string): string {
  return toolName === 'requestUserInput' || toolName === 'AskUserQuestion' ? tr('вопрос') : toolName || tr('инструмент')
}

function clip(s: string, max = LABEL_MAX): string {
  const chars = [...s]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
}

/** 1, 21, 101 → «ждёт»; 2, 5, 11, 12 → «ждут». */
function verb(n: number, one: string, many: string): string {
  return (getLanguage() === 'en' ? n === 1 : n % 10 === 1 && n % 100 !== 11) ? one : many
}

function waitingRank(s: TraySession, waiting: number): number {
  if (waiting > 0 || s.lastStatus === 'blocked_permission' || s.lastStatus === 'blocked_question') return 0
  if (s.lastStatus === 'working') return 1
  return 2
}

/**
 * Порядок как в списке окна: ждут тебя → идут → остальные; внутри групп свежие выше. Свежесть —
 * `lastEventId` (номер последнего события сессии в общем журнале): он растёт монотонно и, в отличие
 * от времени, есть прямо в `agent.list`.
 */
export function sortSessions(list: readonly TraySession[], pending: readonly TrayRequest[] | null = null): TraySession[] {
  const waiting = waitingBySession(list, pending)
  return [...list].sort((a, b) =>
    waitingRank(a, waiting[a.name] ?? 0) - waitingRank(b, waiting[b.name] ?? 0)
    || (b.lastEventId ?? 0) - (a.lastEventId ?? 0)
    || sessionLabel(a).localeCompare(sessionLabel(b)))
}

/** Ждущие запросы по сессиям: есть `perm.list` — по нему (он свежее счётчика в `agent.list`), нет — по счётчику. */
function waitingBySession(list: readonly TraySession[], pending: readonly TrayRequest[] | null): Record<string, number> {
  const out: Record<string, number> = {}
  if (!pending) {
    for (const s of list) out[s.name] = s.pendingPermissions ?? 0
    return out
  }
  for (const p of pending) out[p.sessionId] = (out[p.sessionId] ?? 0) + 1
  return out
}

function daemonLine(conn: ConnState, status: TrayInput['status']): TrayItem {
  if (conn.state === 'up') {
    const version = status?.version ?? conn.daemon.version
    const mode = status ? ` · ${status.mode === 'service' ? tr('служба') : tr('по требованию')}` : ''
    return { kind: 'item', id: 'daemon', label: tr`Демон ${version}${mode}`, enabled: false }
  }
  if (conn.state === 'connecting') return { kind: 'item', id: 'daemon', label: tr('Демон: подключение…'), enabled: false }
  return { kind: 'item', id: 'daemon', label: tr('Демон недоступен'), enabled: false, ...(conn.reason ? { sublabel: clip(conn.reason, 64) } : {}) }
}

export function trayModel(input: TrayInput): TrayModel {
  const { conn, status } = input
  const up = conn.state === 'up'
  // Без связи списки — прошлое: не показываем их вовсе.
  const sessions = up ? input.sessions : null
  const pending = up ? input.pending : null
  const items: TrayItem[] = [daemonLine(conn, status)]

  const byName = new Map((sessions ?? []).map((s) => [s.name, s]))
  const labelOf = (name: string): string => { const s = byName.get(name); return s ? sessionLabel(s) : name }

  if (pending && pending.length > 0) {
    // Старые сверху, как в Inbox окна: кто ждёт дольше, тот и первый.
    const list = [...pending].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
    items.push({ kind: 'separator' }, { kind: 'header', label: tr('Ждут тебя') })
    for (const p of list.slice(0, TRAY_MAX_REQUESTS)) {
      items.push({
        kind: 'item',
        id: `perm:${p.id}`,
        label: `${clip(labelOf(p.sessionId), 32)} — ${clip(requestWhat(p.toolName), 24)}`,
        enabled: true,
        action: { kind: 'open', target: { sessionId: p.sessionId, permId: p.id } },
      })
    }
    const rest = list.slice(TRAY_MAX_REQUESTS)
    if (rest[0]) {
      items.push({
        kind: 'item',
        id: 'perm:more',
        label: tr`Ещё ${rest.length} — в Inbox окна`,
        enabled: true,
        action: { kind: 'open', target: { sessionId: rest[0].sessionId, permId: rest[0].id } },
      })
    }
  }

  if (sessions) {
    items.push({ kind: 'separator' }, { kind: 'header', label: tr('Сессии') })
    const sorted = sortSessions(sessions, pending)
    if (sorted.length === 0) items.push({ kind: 'item', id: 'sessions:none', label: tr('Сессий пока нет'), enabled: false })
    for (const s of sorted.slice(0, TRAY_MAX_SESSIONS)) {
      items.push({
        kind: 'item',
        id: `session:${s.name}`,
        label: `● ${clip(sessionLabel(s))} · ${statusLabel(s.lastStatus)}`,
        enabled: true,
        action: { kind: 'open', target: { sessionId: s.name } },
      })
    }
    if (sorted.length > TRAY_MAX_SESSIONS) {
      items.push({ kind: 'item', id: 'sessions:more', label: tr`Ещё ${sorted.length - TRAY_MAX_SESSIONS} — в окне`, enabled: true, action: { kind: 'open', target: {} } })
    }
  }

  items.push(
    { kind: 'separator' },
    { kind: 'item', id: 'open', label: tr('Открыть Пульт'), enabled: true, action: { kind: 'open', target: {} } },
    { kind: 'item', id: 'quit', label: tr('Выйти из Пульта'), sublabel: tr('Сессии продолжат работать в демоне'), enabled: true, action: { kind: 'quit' } },
  )

  const badge = dockBadge(sessions, pending)
  return { title: badge, badge, tooltip: tooltip(conn, Number(badge || 0), sessions), items }
}

/**
 * Число на значке дока (О2, docs/14): сессии, которые ждут человека, — с разрешением или вопросом
 * (`perm.list`) и с непрочитанной ошибкой (ход упал, лимит, страж). Непрочитанные «готово» сюда не
 * идут: у VS Code значок тоже считает «требующие внимания», а не всё подряд. Нет списков (демон
 * недоступен) — пусто: старое число выглядело бы живым. Классификация — src/sessions/attention.ts,
 * общая с окном.
 */
export function dockBadge(sessions: readonly TraySession[] | null, pending: readonly TrayRequest[] | null): string {
  if (!sessions) return ''
  const waiting: Record<string, number> = {}
  if (pending) for (const p of pending) waiting[p.sessionId] = (waiting[p.sessionId] ?? 0) + 1
  else for (const s of sessions) waiting[s.name] = s.pendingPermissions ?? 0
  const n = needsYouCount(sessions.map((s) => ({
    name: s.name,
    ...(s.archived === true ? { archived: true } : {}),
    attention: parseAttention(s.attention),
    ...(typeof s.lastSeenEventId === 'number' ? { lastSeenEventId: s.lastSeenEventId } : {}),
    ...(s.markedUnread === true ? { markedUnread: true } : {}),
  })), waiting)
  return n > 0 ? String(n) : ''
}

function tooltip(conn: ConnState, waiting: number, sessions: readonly TraySession[] | null): string {
  if (conn.state === 'down') return tr('Пульт · демон недоступен')
  if (conn.state === 'connecting') return tr('Пульт · подключение к демону…')
  const working = (sessions ?? []).filter((s) => s.lastStatus === 'working').length
  const parts = [tr('Пульт')]
  if (waiting > 0) parts.push(tr`${waiting} ${verb(waiting, tr('ждёт'), tr('ждут'))} тебя`)
  if (working > 0) parts.push(`${working} ${verb(working, tr('идёт'), tr('идут'))}`)
  if (parts.length === 1) parts.push(tr('всё спокойно'))
  return parts.join(' · ')
}

/** Ответ `agent.list` → строки меню; кривой ответ — null (меню не покажет список). */
export function sessionsFrom(result: unknown): TraySession[] | null {
  const list = (result as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(list)) return null
  return list.filter((s): s is TraySession =>
    !!s && typeof s === 'object' && typeof (s as TraySession).name === 'string' && typeof (s as TraySession).lastStatus === 'string')
}

/** Ответ `perm.list` → запросы; кривой ответ — null. */
export function pendingFrom(result: unknown): TrayRequest[] | null {
  const list = (result as { pending?: unknown } | null)?.pending
  if (!Array.isArray(list)) return null
  return list.filter((p): p is TrayRequest =>
    !!p && typeof p === 'object' && typeof (p as TrayRequest).id === 'string' && typeof (p as TrayRequest).sessionId === 'string')
}

/**
 * Подпись пункта для нативного меню: Electron (как Chromium) читает `&` как метку мнемоники и
 * съедает её, в том числе на macOS; `&&` — буквальный `&`. Название сессии — свободный текст.
 */
export function menuLabel(s: string): string {
  return s.replace(/&/g, '&&')
}
