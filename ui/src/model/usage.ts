import { getLanguage } from '../../../src/i18n/core.js'
import { t as tr } from '../lib/i18n.js'
// Лимиты подписок в шапке: окна 5 ч и 7 дн по провайдерам (docs/12 §3 п.4). Чистые функции.
//
// Источник — события `usage.updated` / `limit.hit` с полем `windows`: у Claude это
// `rate_limit_event` (доля `utilization` 0…1, `resetsAt` в секундах), у Codex адаптер переводит
// снимок `account/rateLimits` в те же поля. Снимок про АККАУНТ, поэтому берётся последний по
// провайдеру, а не по сессии.

import type { AgentProvider, PultEvent, Tone } from './types.js'
import { num, obj, str } from './types.js'

export interface UsageWindow { utilization: number | null; resetsAt: number | null }

export interface ProviderUsage {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  /** allowed | allowed_warning | limited | blocked | … — как прислал провайдер. */
  status: string
  /** Сброс ближайшего упёршегося окна (секунды), если провайдер его сказал. */
  resetsAt: number | null
  updatedAt: string
  eventId: number
}

export type UsageState = Readonly<Partial<Record<AgentProvider, ProviderUsage>>>

export const EMPTY_USAGE: UsageState = {}

/** Прошедшее окно остаётся в журнале, но его процент уже не описывает текущий лимит. */
export function usageForDisplay(usage: ProviderUsage | undefined, nowMs: number): ProviderUsage | undefined {
  if (!usage) return undefined
  const expired = (w: UsageWindow | null): boolean => w?.resetsAt != null && Number.isFinite(w.resetsAt) && w.resetsAt * 1000 <= nowMs
  const fiveExpired = expired(usage.fiveHour)
  const sevenExpired = expired(usage.sevenDay)
  const blocked = ['limited', 'blocked', 'rejected'].includes(usage.status)
  const resetPassed = usage.resetsAt != null && Number.isFinite(usage.resetsAt) && usage.resetsAt * 1000 <= nowMs
  const activeBlock = [usage.fiveHour, usage.sevenDay].some((w) => w?.utilization != null && w.utilization >= 1 && !expired(w))
  const expiredBlock = [usage.fiveHour, usage.sevenDay].some((w) => w?.utilization != null && w.utilization >= 1 && expired(w))
  return {
    ...usage,
    fiveHour: fiveExpired ? { ...usage.fiveHour!, utilization: null } : usage.fiveHour,
    sevenDay: sevenExpired ? { ...usage.sevenDay!, utilization: null } : usage.sevenDay,
    status: blocked && !activeBlock && (resetPassed || (usage.resetsAt == null && expiredBlock)) ? 'unknown' : usage.status,
  }
}

function window(w: unknown): UsageWindow | null {
  const o = obj(w)
  if (!o) return null
  return { utilization: num(o['utilization']) ?? null, resetsAt: num(o['resetsAt']) ?? null }
}

export function applyUsage(state: UsageState, ev: PultEvent): UsageState {
  if (ev.kind !== 'usage.updated' && ev.kind !== 'limit.hit') return state
  if (ev.provider !== 'claude' && ev.provider !== 'codex') return state
  const windows = obj(ev.data['windows'])
  if (!windows) return state
  const prev = state[ev.provider]
  if (prev && prev.eventId >= ev.id) return state
  return {
    ...state,
    [ev.provider]: {
      fiveHour: window(windows['five_hour']),
      sevenDay: window(windows['seven_day']),
      status: str(ev.data['status']) ?? 'unknown',
      resetsAt: num(ev.data['resetsAt']) ?? null,
      updatedAt: ev.ts,
      eventId: ev.id,
    },
  }
}

/** 0.35 → «35%»; нет данных — «—». */
export function formatPct(u: number | null | undefined): string {
  if (u === null || u === undefined || !Number.isFinite(u)) return '—'
  return `${Math.round(Math.max(0, u) * 100)}%`
}

export function usageTone(u: number | null | undefined, status?: string): Tone {
  if (status === 'limited' || status === 'blocked' || status === 'rejected') return 'fail'
  if (u === null || u === undefined) return 'queued'
  if (u >= 0.9) return 'fail'
  if (u >= 0.7) return 'wait'
  return 'ok'
}

/** Сколько до сброса: «через 40 мин», «через 2 ч 10 мин», «через 3 дн 4 ч». */
export function formatResetIn(resetsAtSec: number | null | undefined, nowMs: number): string {
  if (resetsAtSec === null || resetsAtSec === undefined || !Number.isFinite(resetsAtSec)) return ''
  const s = Math.round(resetsAtSec - nowMs / 1000)
  if (s <= 0) return tr('ожидаем свежие данные')
  const m = Math.ceil(s / 60)
  if (m < 60) return tr`через ${m} мин`
  const h = Math.floor(m / 60)
  if (h < 24) return tr`через ${h} ч${m % 60 ? tr` ${m % 60} мин` : ''}`
  const d = Math.floor(h / 24)
  return tr`через ${d} дн${h % 24 ? tr` ${h % 24} ч` : ''}`
}

const MONTHS = [tr('янв'), tr('фев'), tr('мар'), tr('апр'), tr('мая'), tr('июн'), tr('июл'), tr('авг'), tr('сен'), tr('окт'), tr('ноя'), tr('дек')]

/** Когда сброс: «14:30» сегодня, иначе «2 окт 14:30». `timeZone` — для тестов. */
export function formatClock(epochMs: number, nowMs: number, timeZone?: string): string {
  const parts = (t: number): Record<string, string> => {
    const f = new Intl.DateTimeFormat(getLanguage() === 'ru' ? 'ru-RU' : 'en-GB', {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      ...(timeZone ? { timeZone } : {}),
    })
    const out: Record<string, string> = {}
    for (const p of f.formatToParts(new Date(t))) out[p.type] = p.value
    return out
  }
  const a = parts(epochMs)
  const b = parts(nowMs)
  const hm = `${a['hour']}:${a['minute']}`
  if (a['year'] === b['year'] && a['month'] === b['month'] && a['day'] === b['day']) return hm
  return `${Number(a['day'])} ${MONTHS[Number(a['month']) - 1] ?? a['month']} ${hm}`
}

/**
 * Держит ли лимит реплику прямо сейчас. Статус `limited` у простаивающего агента сам не снимается:
 * codex рассылает `limit.hit` ВСЕМ живым сессиям аккаунта, а вернуть их в `idle` может только
 * следующий ход. Если окно блокировало ввод по одному статусу, такого агента после сброса нельзя
 * было продолжить из окна вовсе. Поэтому держим только до известного сброса; сброс прошёл или
 * неизвестен — реплика уходит, и если лимит ещё держит, об этом скажет сам демон.
 */
export function limitHolds(status: string | undefined, resetsAtSec: number | null | undefined, nowMs: number): boolean {
  if (status !== 'limited') return false
  if (resetsAtSec === null || resetsAtSec === undefined || !Number.isFinite(resetsAtSec)) return false
  return resetsAtSec * 1000 > nowMs
}

/** Окно лимита для полосы под чатом: «5ч 12%» и когда сброс. */
export interface LimitWindowView { key: string; pct: string; tone: Tone; reset: string; title: string }

/**
 * Лимиты провайдера для полосы под полем ввода. Прошедшее окно — «ожидаем свежие данные», а не
 * старые проценты (usageForDisplay). Сброс — время сегодня, иначе «через N дн».
 */
export function limitWindowsView(usage: ProviderUsage | undefined, nowMs: number): LimitWindowView[] {
  const u = usageForDisplay(usage, nowMs)
  if (!u) return []
  const out: LimitWindowView[] = []
  for (const [key, w, name] of [[tr('5ч'), u.fiveHour, tr('пятичасовое')], [tr('7дн'), u.sevenDay, tr('недельное')]] as const) {
    if (!w) continue
    const at = w.resetsAt
    // Сброс уже прошёл, свежих данных нет — окну нечего сказать: прошлая дата сброса только путает.
    if (w.utilization == null && at != null && at * 1000 <= nowMs) continue
    const today = at != null && Number.isFinite(at) && at * 1000 - nowMs < 20 * 3_600_000
    const reset = at == null || !Number.isFinite(at) ? '' : today ? formatClock(at * 1000, nowMs) : formatResetIn(at, nowMs)
    out.push({
      key, pct: formatPct(w.utilization), tone: usageTone(w.utilization, u.status === 'limited' || u.status === 'blocked' || u.status === 'rejected' ? u.status : undefined), reset,
      title: tr`${name} окно: использовано ${formatPct(w.utilization)}${at ? tr`, сброс ${formatResetIn(at, nowMs)} (${formatClock(at * 1000, nowMs)})` : ''}`,
    })
  }
  return out
}
