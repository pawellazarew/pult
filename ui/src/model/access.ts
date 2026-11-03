// Быстрый старт, шаг A: доступ в окне — согласие на полный доступ (один раз на всех провайдеров), метки по
// действующему режиму и строки ленты (design/2026-11-02-quick-start/DESIGN-REVIEW.md §3.6). Чистые функции:
// проверяются отрисовкой в строку (ui/test/access.test.ts).
//
// Согласие и красную метку окно не решает само: согласие проверяет демон (`consent.json`), а метка строится по
// `access` из `agent.list` — желаемый режим, применённый (что сказал провайдер) и живой ли процесс с этими правами.

import { getLanguage, t as tr } from '../lib/i18n.js'
import type { ApprovalMode } from '../../../src/adapters/types.js'
import type { ConsentView } from '../../../src/core/consent.js'
import type { AccessView } from '../../../src/sessions/access.js'
import { isFullLevel } from '../../../src/sessions/access.js'
import type { ConfigureChanges } from '../../../src/sessions/settings.js'
import { APPROVAL_LABEL } from './newAgent.js'
import type { AgentProvider } from './types.js'

export type { AccessView, ConsentView }
export { isFullLevel }

/** `settings.get` → `access` (демон шага A и новее). */
export interface AccessSettings {
  consent: ConsentView
  providers: AgentProvider[]
  /** Действующий `defaultMode` Claude владельца (настройки пользователя). */
  claudeDefaultMode: string | null
}

/** Версия текста согласия, которую показывает этот диалог (`CONSENT_VERSION` демона). */
export const CONSENT_DIALOG_VERSION = 1

/** Кого называет диалог согласия (`CONSENT_PROVIDERS` демона): ровно их окно и шлёт в `access.grantFull`. */
export const CONSENT_DIALOG_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'zcode']

/** Согласие действует для провайдера. Нет данных (старый демон) — нет. */
export function consentGrants(c: ConsentView | null | undefined, provider: AgentProvider): boolean {
  return !!c && c.granted && c.version >= c.current && c.providers.includes(provider)
}

/** Выбор уровня требует диалога согласия: это полный доступ, а согласия на провайдера нет. */
export function needsConsent(provider: AgentProvider, approval: ApprovalMode, inheritMode: string | null | undefined, c: ConsentView | null | undefined): boolean {
  return isFullLevel(provider, approval, inheritMode) && !consentGrants(c, provider)
}

/** Дата согласия: «02.11.2026»; по-английски — «2 Nov 2026» (день и месяц не путаются). */
export function consentDate(iso: string | undefined): string {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  if (getLanguage() === 'en') return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

/** Строка «Настройки → Доступ». */
export function consentLine(c: ConsentView | null | undefined): string {
  if (c && c.granted) return tr`Полный доступ разрешён ${consentDate(c.grantedAt)}`.trim()
  if (c && c.revokedAt) return tr`Полный доступ отозван ${consentDate(c.revokedAt)}. Разрешение спрошу снова при первом выборе «Полного доступа».`
  return tr('Полный доступ не разрешён. Разрешение спрашивается один раз — при первом выборе «Полного доступа».')
}

// --- метки чата -----------------------------------------------------------------------------------

/** Минимум полей сессии, по которым строятся метки. */
export interface AccessAgent {
  provider: AgentProvider
  approval?: ApprovalMode
  claudeMode?: string
  access?: AccessView
}

/** Состояние метки для тестов и CSS: что именно сейчас видно. */
export type ChipState = 'full' | 'pending' | 'blocked' | 'expected' | 'unconfirmed' | 'plain'

export interface AccessChip {
  label: string
  /** Хвост мелким: «после хода», «ожидается», «не подтверждено», «не разрешён». */
  suffix: string | null
  state: ChipState
  /** Красный: полный доступ выбран и разрешён или жив процесс с полными правами. */
  red: boolean
  title: string
}

const levelWords = (provider: AgentProvider, approval: ApprovalMode, claudeMode?: string): string =>
  provider === 'claude' && approval === 'inherit' && claudeMode ? `${APPROVAL_LABEL.inherit}: ${claudeMode}` : APPROVAL_LABEL[approval]

/**
 * Чип доступа в подвале: желаемый уровень словами и что с ним сейчас.
 *   * понижение, пока жив процесс с прежними правами, — «Спрашивать · после хода» (кадр 11);
 *   * полный выбран, а разрешения нет — «Полный доступ · не разрешён» (ход пойдёт в «Спрашивать»);
 *   * ходов ещё не было — «ожидается»; Codex не подтвердил режим — «не подтверждено» (у ZCode — всегда: режим он не
 *     сообщает, известно только, с каким `--mode` ушёл процесс).
 */
export function accessChip(a: AccessAgent): AccessChip {
  const desired = a.access?.desired ?? a.approval ?? 'ask'
  const label = levelWords(a.provider, desired, a.access?.inheritMode ?? a.claudeMode)
  const v = a.access
  const red = v ? v.red : desired === 'full'
  let state: ChipState = 'plain'
  let suffix: string | null = null
  if (v?.pending) { state = 'pending'; suffix = tr('после хода') }
  else if (v?.blocked) { state = 'blocked'; suffix = tr('не разрешён') }
  else if (v && !v.applied) { state = 'expected'; suffix = tr('ожидается') }
  else if (v?.applied && !v.applied.confirmed && a.provider !== 'claude') { state = 'unconfirmed'; suffix = tr('не подтверждено') }
  else if (red) state = 'full'
  const applied = v?.applied
  const now = applied?.reported ? tr`сейчас процесс: ${applied.reported}${applied.confirmed ? '' : tr(' (не подтверждено)')}`
    : applied ? tr`последний процесс запущен с «${APPROVAL_LABEL[applied.approval]}» (не подтверждено)` : tr('ходов с этим режимом ещё не было')
  const title = v?.blocked
    ? tr('Полный доступ выбран, но не разрешён (согласие отозвано или не дано): ходы идут в «Спрашивать». Разрешить — выбери «Полный доступ» снова.')
    : v?.pending
      ? tr('Текущий ход идёт с прежними правами — выбор применится, когда он закончится. Нужно сейчас — «Стоп».')
      : tr`Доступ: ${label}; ${now}`
  return { label, suffix, state, red, title }
}

/** Плашка в шапке чата: «полный доступ» или «полный доступ · до конца хода» при понижении (кадры 05, 11). */
export function headerPill(a: AccessAgent): { label: string; state: 'full' | 'until-turn-end' } | null {
  const v = a.access
  if (!v) return a.approval === 'full' ? { label: tr('полный доступ'), state: 'full' } : null
  if (!v.red) return null
  const desiredRed = v.desiredFull && !v.blocked
  return desiredRed ? { label: tr('полный доступ'), state: 'full' } : { label: tr('полный доступ · до конца хода'), state: 'until-turn-end' }
}

/** Щит «полный» в строке сайдбара — по той же красной метке. */
export function sidebarFull(a: AccessAgent): boolean {
  return a.access ? a.access.red : a.approval === 'full'
}

/** Строка под полем при понижении во время хода с полными правами (кадр 11). */
export function pendingStrip(a: AccessAgent): string | null {
  const v = a.access
  if (!v || !v.pending || !v.red || (v.desiredFull && !v.blocked)) return null
  return tr('Текущий ход идёт с полным доступом — метка снимется, когда он закончится. Нужно сейчас — «Стоп».')
}

/**
 * Строка ленты о смене доступа (одна на смену): «Доступ: Правки в папке → Полный доступ», при понижении во время
 * хода — «… · применится, когда закончится текущий ход». Нет смены доступа — `null` (ленту рисует общая строка).
 */
export function accessChangeLine(c: ConfigureChanges, pending: boolean, when: 'next_turn' | 'after_background' = 'next_turn'): { title: string; full: boolean } | null {
  if (!c.approval) return null
  const from = c.approval.from ?? 'ask'
  const to = c.approval.to ?? 'ask'
  const full = to === 'full'
  // Тёплый процесс Claude держит фоновые задачи — смена ждёт их; иначе при понижении во время хода — его конца.
  const tail = when === 'after_background' ? tr(' · применится, когда доделаются фоновые задачи')
    : pending && !full ? tr(' · применится, когда закончится текущий ход') : ''
  return { title: tr`Доступ: ${APPROVAL_LABEL[from]} → ${APPROVAL_LABEL[to]}${tail}`, full }
}
