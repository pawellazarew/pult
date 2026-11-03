import { getLanguage } from '../../../src/i18n/core.js'
import { t as tr } from '../lib/i18n.js'
// Контекстное окно сессии в окне Пульта: «контекст 48k / 200k · 24%», тон полоски, подсказка.
// Чистые функции. Разбор и слияние события — те же, что у демона (src/sessions/context.ts):
// окно и `agent list` обязаны показывать одно и то же.

import { contextShare, mergeContext, parseContextData } from '../../../src/sessions/context.js'
import type { SessionContext } from '../../../src/sessions/context.js'
import type { PultEvent, Tone } from './types.js'

export type { SessionContext }

/** Свёртка: `context.updated` поверх прошлого значения сессии; прочие события его не трогают. */
export function applyContext(prev: SessionContext | undefined, ev: PultEvent): SessionContext | undefined {
  if (ev.kind !== 'context.updated') return prev
  const d = parseContextData(ev.data)
  return d ? mergeContext(prev, d, ev.ts) : prev
}

/** Порог, с которого доля окна видна прямо в строке дерева: ниже — только в подсказке. */
export const CONTEXT_ROW_MIN = 0.5

/** Тон доли окна: до 70% — спокойно, 70–90% — пора думать о сжатии, дальше — край. */
export function contextTone(share: number | null): Tone {
  if (share === null) return 'queued'
  if (share >= 0.9) return 'fail'
  if (share >= 0.7) return 'wait'
  return 'ok'
}

/** Десятичная запятая и без лишнего нуля: 1.25 → «1,3», 4 → «4». */
const short = (x: number): string => {
  const number = (Math.round(x * 10) / 10).toString()
  return getLanguage() === 'ru' ? number.replace('.', ',') : number
}

/** Токены коротко: 950 · 4,2k · 48k · 200k · 1M · 1,2M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${short(n / 1000)}k`
  if (n < 999_500) return `${Math.round(n / 1000)}k`
  return `${short(n / 1_000_000)}M`
}

/** Точное число с разбивкой по три (неразрывный пробел): 48213 → «48 213». */
export function formatExact(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, getLanguage() === 'ru' ? ' ' : ',')
}

/** 0.2412 → «24%». */
export function formatShare(share: number | null): string {
  return share === null ? '—' : `${Math.round(share * 100)}%`
}

export interface ContextView {
  /** «контекст 48k / 200k · 24%»; окно ещё не известно — «контекст 48k». */
  label: string
  /** Коротко для строк и вкладок: «24%»; окна нет — «48k». */
  short: string
  share: number | null
  tone: Tone
  /** Ширина полоски, 0…100. */
  barPct: number
  /** Подсказка с точными числами и моделью. */
  title: string
}

export function contextView(c: SessionContext | null | undefined): ContextView | null {
  if (!c) return null
  const share = contextShare(c)
  const sizes = c.window !== null ? `${formatTokens(c.used)} / ${formatTokens(c.window)}` : formatTokens(c.used)
  const exact = c.window !== null
    ? tr`${formatExact(c.used)} из ${formatExact(c.window)} токенов (${formatShare(share)})`
    : tr`${formatExact(c.used)} токенов, размер окна станет известен в конце хода`
  return {
    label: tr`контекст ${sizes}${share !== null ? ` · ${formatShare(share)}` : ''}`,
    short: share !== null ? formatShare(share) : formatTokens(c.used),
    share,
    tone: contextTone(share),
    barPct: share === null ? 0 : Math.min(100, Math.max(0, Math.round(share * 100))),
    title: tr`Контекстное окно: ${exact}${c.model ? ` · ${c.model}` : ''}`,
  }
}

/** Доля для строки дерева — только когда окно занято хотя бы наполовину; иначе `null`. */
export function contextRowView(c: SessionContext | null | undefined): ContextView | null {
  const v = contextView(c)
  return v && v.share !== null && v.share >= CONTEXT_ROW_MIN ? v : null
}
