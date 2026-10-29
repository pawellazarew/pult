import { t as tr } from '../lib/i18n.js'
// Фаза хода в окне (0.3.5): кадры живого канала → карта «сессия → фаза», строка под репликой и короткая подпись
// в дереве. Выводит фазу демон (src/sessions/phaseTracker.ts) — окно только рисует. Чистые функции.

import type { PultEvent } from './types.js'
import type { TurnPhase } from '../../../src/sessions/turnPhase.js'
import { LIVE_CURSOR_BASE, PHASE_FRAME_KIND, PHASE_NAMES } from '../../../src/sessions/turnPhase.js'

export type { TurnPhase }
export { LIVE_CURSOR_BASE }

export type PhaseMap = Readonly<Record<string, TurnPhase>>

export const EMPTY_PHASES: PhaseMap = {}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)

/** Разобрать фазу из кадра; мусор — `null` (кадр от демона другой версии не роняет окно). */
export function parsePhase(v: unknown): TurnPhase | null {
  const o = obj(v)
  if (!o || !(PHASE_NAMES as readonly unknown[]).includes(o['phase'])) return null
  const since = typeof o['since'] === 'number' ? o['since'] : NaN
  if (!Number.isFinite(since)) return null
  const turnSince = typeof o['turnSince'] === 'number' && Number.isFinite(o['turnSince']) ? o['turnSince'] : since
  const tool = obj(o['tool'])
  const waiting = obj(o['waiting'])
  const bg = typeof o['background'] === 'number' && o['background'] > 0 ? o['background'] : 0
  return {
    phase: o['phase'] as TurnPhase['phase'],
    since,
    turnSince,
    ...(tool && typeof tool['name'] === 'string' ? { tool: { name: tool['name'], detail: typeof tool['detail'] === 'string' ? tool['detail'] : '' } } : {}),
    ...(waiting && typeof waiting['permId'] === 'string' ? {
      waiting: { kind: waiting['kind'] === 'question' ? 'question' : 'permission', permId: waiting['permId'], toolName: typeof waiting['toolName'] === 'string' ? waiting['toolName'] : '' },
    } : {}),
    ...(bg ? { background: bg } : {}),
    ...(typeof o['reasoning'] === 'string' && o['reasoning'] ? { reasoning: o['reasoning'] } : {}),
  }
}

/**
 * Кадр живого канала → новая карта (та же — если кадр не про фазы). `reset` — начало подписки (в том числе после
 * рестарта демона): прежнее знание забывается, следом идут текущие фазы.
 */
export function applyPhaseFrame(map: PhaseMap, ev: PultEvent): PhaseMap {
  if ((ev.kind as string) !== PHASE_FRAME_KIND) return map
  const d = obj(ev.data) ?? {}
  if (d['reset'] === true) return Object.keys(map).length ? EMPTY_PHASES : map
  if (!('phase' in d)) return map
  const p = parsePhase(d['phase'])
  if (!p) {
    if (!(ev.sessionId in map)) return map
    const next = { ...map }
    delete next[ev.sessionId]
    return next
  }
  return { ...map, [ev.sessionId]: p }
}

/** Прошедшее время для строки: «0 с», «12 с», «1 мин 05 с», «1 ч 02 мин». */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return tr`${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return tr`${m} мин ${String(s % 60).padStart(2, '0')} с`
  return tr`${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`
}

/**
 * Имя инструмента покороче: `mcp__browser__browser_navigate` → `browser_navigate`; команда Codex
 * (`commandExecution`) — `shell`, как `Bash` у Claude.
 */
export function shortToolName(name: string): string {
  if (name === 'commandExecution') return 'shell'
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name)
  return m ? (m[1] as string) : name
}

function bgText(n: number): string { return tr`фоновые задачи: ${n}` }

/** Что сказать фазой — словами, без секунд (они идут отдельно). */
export function phaseText(p: TurnPhase): string {
  const bg = p.background && p.phase !== 'background' ? ` · ${bgText(p.background)}` : ''
  switch (p.phase) {
    case 'starting': return tr`запускается…${bg}`
    case 'thinking': return tr`думает…${bg}`
    case 'writing': return tr`пишет…${bg}`
    case 'tool': {
      const t = p.tool
      const what = t ? `${t.name === 'commandExecution' ? shortToolName(t.name) : t.name}${t.detail ? ` ${t.detail}` : ''}` : tr('инструмент')
      return tr`выполняет: ${what}…${bg}`
    }
    case 'waiting': return `${p.waiting?.kind === 'question' ? tr('ждёт ответа на вопрос') : tr('ждёт тебя')}${bg}`
    case 'background': return bgText(p.background ?? 0)
  }
}

/**
 * Что прочитать экранному диктору: меняется только со сменой фазы (не каждую секунду и не с каждой строкой
 * размышлений) — поэтому без секунд, без подписи инструмента и без текста размышлений.
 */
export function phaseAnnouncement(p: TurnPhase | null): string {
  if (!p) return ''
  switch (p.phase) {
    case 'starting': return tr('запускается')
    case 'thinking': return tr('думает')
    case 'writing': return tr('пишет')
    case 'tool': return tr`выполняет ${p.tool ? shortToolName(p.tool.name) : tr('инструмент')}`
    case 'waiting': return p.waiting?.kind === 'question' ? tr('ждёт ответа на вопрос') : tr('ждёт твоего решения')
    case 'background': return bgText(p.background ?? 0)
  }
}

/** Секунды строки: от начала текущей фазы, по часам демона (окно и демон на одной машине). */
export function phaseElapsed(p: TurnPhase, now: number): string {
  return formatElapsed(now - p.since)
}

/** Подпись в строке дерева вместо «идёт»: «думает», «пишет», «Bash», «запуск». Нет фазы — `null`. */
export function treePhaseLabel(p: TurnPhase | undefined | null): string | null {
  if (!p) return null
  switch (p.phase) {
    case 'starting': return tr('запуск')
    case 'thinking': return tr('думает')
    case 'writing': return tr('пишет')
    case 'tool': {
      const n = p.tool ? shortToolName(p.tool.name) : tr('инструмент')
      return n.length > 16 ? `${n.slice(0, 15)}…` : n
    }
    case 'waiting': return tr('ждёт тебя')
    case 'background': return null
  }
}
