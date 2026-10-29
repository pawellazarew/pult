// Правила системных уведомлений окна (О2, docs/14 «Правила уведомлений»). Чистые функции: какое событие
// заслуживает уведомления и сколько их пускать подряд.
//
// ПРАВИЛА. Окно не в фокусе (это проверяет вызывающий и ещё раз оболочка):
//   * конец хода — только если ход шёл дольше `minTurnSeconds` (по умолчанию 20 с, порог Ghostty
//     `notify-on-command-finish-after`). Длительность — `turnMs` из события демона; её нет (старый демон) —
//     уведомляем, как раньше;
//   * вопросы и разрешения, ошибки (ход упал, лимит, страж, «похоже, завис») — всегда.
// Звук — по виду (`kind`): вопрос громче «готово», ошибка — своим звуком (shell/src/notifySound.ts).
//
// ПРЕДЕЛ ПАЧКИ (как у Warp): не больше двух уведомлений за 10 с. Остальные копятся и, когда окно в 10 с
// закрывается, уходят одной сводкой «ещё N сессий ждут тебя».

import type { NotifyKind, NotifyTarget } from '../../../shell/src/contract.js'
import { attentionOf } from '../../../src/sessions/attention.js'
import { plural } from '../lib/ru.js'
import { describePermission } from './permissions.js'
import type { PultEvent } from './types.js'
import { str } from './types.js'

export interface NotifyRules {
  minTurnSeconds: number
  sound: boolean
}

/** Значения по умолчанию — те же, что у демона (src/core/config.ts); старый демон их не присылает. */
export const DEFAULT_NOTIFY_RULES: NotifyRules = { minTurnSeconds: 20, sound: true }

/** Правила из `daemon.status.notify`; кривое или нет — по умолчанию. */
export function notifyRules(x: unknown): NotifyRules {
  const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {}
  const min = o['minTurnSeconds']
  return {
    minTurnSeconds: typeof min === 'number' && Number.isFinite(min) && min >= 0 ? min : DEFAULT_NOTIFY_RULES.minTurnSeconds,
    sound: typeof o['sound'] === 'boolean' ? o['sound'] : DEFAULT_NOTIFY_RULES.sound,
  }
}

export interface Notice {
  title: string
  body: string
  target: NotifyTarget
  kind: NotifyKind
}

export interface NoticeOptions {
  /** Событие старше этого — доигрывание истории, а не новость. */
  freshMs?: number
  /** Порог конца хода в мс (`minTurnSeconds` · 1000). */
  minTurnMs?: number
}

/**
 * Уведомление macOS для СВЕЖЕГО события или `null`. `label` — как агент подписан в окне (название); без
 * него — имя сессии. Клик всегда ведёт по имени сессии.
 */
export function notificationFor(ev: PultEvent, nowMs: number, label?: string, opts: NoticeOptions = {}): Notice | null {
  const t = Date.parse(ev.ts)
  if (!Number.isFinite(t) || nowMs - t > (opts.freshMs ?? 30_000)) return null
  if (ev.sessionId === 'daemon') return null
  const who = label || ev.sessionId
  const target = { sessionId: ev.sessionId }
  if (ev.kind === 'permission.requested') {
    const id = str(ev.data['id'])
    const input = (ev.data['input'] ?? {}) as Record<string, unknown>
    const v = describePermission(str(ev.data['toolName']) ?? 'tool', input)
    return {
      title: `${who} ждёт тебя`,
      body: `${v.title}${v.target ? `: ${v.target}` : ''}`,
      target: { ...target, ...(id ? { permId: id } : {}) },
      kind: 'ask',
    }
  }
  // `limited` с номером хода — эхо `limit.hit`: о лимите уже сказало оно.
  if (ev.kind === 'status.changed' && ev.data['status'] === 'limited') return null
  const att = attentionOf(ev)
  if (!att) return null
  switch (att.kind) {
    case 'ask':
      return { title: `${who} ждёт ответа`, body: att.text ?? 'вопрос в ленте', target, kind: 'ask' }
    case 'done': {
      const ms = ev.data['turnMs']
      if (typeof ms === 'number' && Number.isFinite(ms) && ms < (opts.minTurnMs ?? DEFAULT_NOTIFY_RULES.minTurnSeconds * 1000)) return null
      return { title: `${who}: ход закончен`, body: 'сессия ждёт следующей реплики', target, kind: 'done' }
    }
    case 'failed':
      return { title: `${who}: ход не удался`, body: (att.text ?? 'причина — в ленте').slice(0, 200), target, kind: 'error' }
    case 'limit':
      return { title: `${who}: лимит исчерпан`, body: (att.text ?? 'новая реплика до сброса не пойдёт').slice(0, 200), target, kind: 'error' }
    case 'blocked':
      return { title: `${who}: страж не пустил ход`, body: (att.text ?? 'проверь VPN и вход').slice(0, 200), target, kind: 'error' }
    case 'stalled':
      return { title: `${who}: похоже, завис`, body: `${att.text ?? 'ход давно молчит'} — прервать или ждать?`, target, kind: 'error' }
  }
}

// --- предел пачки ---------------------------------------------------------------------------------

export const BURST_MAX = 2
export const BURST_WINDOW_MS = 10_000

export interface Throttle {
  /** Когда ушли уведомления последнего окна (мс). */
  sent: readonly number[]
  /** Придержанные: сессия и вид — для сводки. */
  held: readonly { sessionId?: string | undefined; kind: NotifyKind }[]
}

export const EMPTY_THROTTLE: Throttle = { sent: [], held: [] }

const recent = (sent: readonly number[], nowMs: number): number[] => sent.filter((t) => nowMs - t < BURST_WINDOW_MS)

/**
 * Пускать ли уведомление сейчас. Нет — оно придержано до сводки, а `flushAt` — когда окно закроется
 * (вызывающий ставит таймер и зовёт `flushThrottle`).
 */
export function offerNotice(t: Throttle, n: Pick<Notice, 'target' | 'kind'>, nowMs: number): { t: Throttle; show: boolean; flushAt: number | null } {
  const sent = recent(t.sent, nowMs)
  if (sent.length < BURST_MAX && t.held.length === 0) return { t: { sent: [...sent, nowMs], held: t.held }, show: true, flushAt: null }
  const held = [...t.held, { sessionId: n.target.sessionId, kind: n.kind }]
  const oldest = sent[0] ?? nowMs
  return { t: { sent, held }, show: false, flushAt: oldest + BURST_WINDOW_MS }
}

/** Окно закрылось: придержанное — одной сводкой «ещё N сессий ждут тебя». Нечего — `null`. */
export function flushThrottle(t: Throttle, nowMs: number): { t: Throttle; summary: Notice | null } {
  if (!t.held.length) return { t: { sent: recent(t.sent, nowMs), held: [] }, summary: null }
  const names = [...new Set(t.held.map((h) => h.sessionId).filter((x): x is string => !!x))]
  const n = Math.max(1, names.length)
  // Сводка звучит самым тревожным из придержанного: ошибка > вопрос > готово.
  const kind: NotifyKind = t.held.some((h) => h.kind === 'error') ? 'error' : t.held.some((h) => h.kind === 'ask') ? 'ask' : 'done'
  const summary: Notice = {
    title: 'Пульт',
    body: `ещё ${n} ${plural(n, 'сессия ждёт', 'сессии ждут', 'сессий ждут')} тебя`,
    target: names.length === 1 ? { sessionId: names[0] as string } : { inbox: true },
    kind,
  }
  return { t: { sent: [...recent(t.sent, nowMs), nowMs], held: [] }, summary }
}
