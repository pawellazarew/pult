// Вывод фазы хода (0.3.5) — ОДНО место на оба провайдера. Вход — события журнала (их видит `emit` менеджера:
// реплика, статус, дельты, инструменты, разрешения, фоновые задачи), начало хода от менеджера (`accepted`) и
// живые сигналы адаптеров (`live`: провайдер отозвался, новое обращение к модели, размышления), которые в
// журнал не пишутся вовсе. Выход — `TurnPhase` сессии или `null` и вызов `onChange` на каждую перемену.
//
// ЧТО СЮДА НЕ ПОПАДАЕТ: события субагентов (`parentId`) фазу не двигают — строка говорит о разговоре сессии,
// а не о детях; дельты одной реплики не меняют фазу после первой (`writing` уже стоит), поэтому перемен на
// дельту нет. Текст размышлений копится сырым хвостом в памяти и отдаётся окну только после `redactString`.

import type { PultEvent } from '../core/events.js'
import { redactString } from '../core/log.js'
import type { PhaseName, TurnPhase } from './turnPhase.js'
import { REASONING_TAIL, toolSummary } from './turnPhase.js'

/**
 * Живой сигнал адаптера — то, чего в журнале нет:
 *   * `active` — первый признак жизни провайдера в ходе (Claude `system/init`, Codex `turn/started`);
 *   * `request` — новое обращение к модели внутри хода (Claude `message_start`);
 *   * `thinking` — начался блок размышлений (Claude `thinking`/`redacted_thinking`, Codex элемент `reasoning`);
 *   * `reasoning` — кусок текста размышлений (Claude `thinking_delta`, Codex `item/reasoning/summaryTextDelta`), СЫРОЙ.
 */
export type LiveSignal =
  | { kind: 'active' }
  | { kind: 'request' }
  | { kind: 'thinking' }
  | { kind: 'reasoning'; text: string }

export interface PhaseTracker {
  /** Ход принят: реплика записана, дальше страж сети, MCP, спавн — «запускается». */
  accepted(name: string): void
  /** Ход не завёлся, а события конца нет (упал `resume` адаптера) — фазу снять. */
  abandoned(name: string): void
  /** Событие журнала этой сессии (после записи). */
  event(ev: PultEvent): void
  live(name: string, sig: LiveSignal): void
  /** Текущая фаза; `reasoning: false` — без текста размышлений (так её отдаёт `agent.list`). */
  get(name: string, opts?: { reasoning?: boolean }): TurnPhase | null
  /** Сессии, у которых сейчас есть фаза. */
  names(): string[]
  forget(name: string): void
}

export interface PhaseTrackerOptions {
  now?: () => number
  /** Фаза сессии сменилась (в том числе текст размышлений). Синхронно, ждать нельзя. */
  onChange?(name: string): void
}

/** Сырой хвост размышлений в памяти — с запасом на маски редакции. */
const RAW_TAIL = REASONING_TAIL * 4

/** Статусы, которыми ход кончается (тот же набор, что `TURN_END` менеджера). */
const TURN_END: ReadonlySet<string> = new Set(['idle', 'failed', 'interrupted', 'done', 'cold'])

interface OpenTool { id: string; name: string; detail: string }

interface Turn {
  phase: PhaseName
  since: number
  turnSince: number
  /** Ключ фазы: `tool` с другим инструментом — новая фаза (свой отсчёт), та же — нет. */
  key: string
  /** Открытые инструменты корня разговора, в порядке начала. */
  tools: OpenTool[]
  /** Ждущие запросы (разрешение или вопрос), в порядке прихода. */
  waits: Array<{ kind: 'permission' | 'question'; permId: string; toolName: string }>
  reasoning: string
}

const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'requestUserInput'])
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

export function createPhaseTracker(opts: PhaseTrackerOptions = {}): PhaseTracker {
  const now = opts.now ?? Date.now
  const turns = new Map<string, Turn>()
  const bg = new Map<string, { count: number; since: number }>()
  const changed = (name: string): void => { try { opts.onChange?.(name) } catch { /* слушатель не роняет вывод */ } }

  const keyOf = (t: Turn, phase: PhaseName): string => {
    if (phase === 'tool') return `tool:${t.tools[t.tools.length - 1]?.id ?? ''}`
    if (phase === 'waiting') return `waiting:${t.waits[0]?.permId ?? ''}`
    return phase
  }
  /** Поставить фазу; отсчёт — только при настоящей смене (другая фаза, другой инструмент, другой запрос). */
  const set = (name: string, t: Turn, phase: PhaseName): boolean => {
    const key = keyOf(t, phase)
    if (t.key === key) return false
    t.phase = phase
    t.key = key
    t.since = now()
    return true
  }
  /** Куда возвращаться, когда кончился инструмент или ответили на вопрос. */
  const settle = (name: string, t: Turn): boolean => {
    if (t.waits.length) return set(name, t, 'waiting')
    if (t.tools.length) return set(name, t, 'tool')
    return set(name, t, 'thinking')
  }
  const begin = (name: string, phase: PhaseName): void => {
    const at = now()
    turns.set(name, { phase, since: at, turnSince: at, key: phase, tools: [], waits: [], reasoning: '' })
    changed(name)
  }
  const end = (name: string): void => {
    if (turns.delete(name)) changed(name)
  }

  return {
    accepted(name) { begin(name, 'starting') },

    abandoned(name) { end(name) },

    event(ev) {
      const name = ev.sessionId
      const d = ev.data ?? {}
      if (ev.kind === 'session.ended') {
        const had = turns.delete(name) || bg.delete(name)
        bg.delete(name)
        if (had) changed(name)
        return
      }
      if (ev.parentId) return
      if (ev.kind === 'background.changed') {
        const count = typeof d['count'] === 'number' && d['count'] > 0 ? Math.floor(d['count']) : 0
        const prev = bg.get(name)
        if ((prev?.count ?? 0) === count) return
        if (count > 0) bg.set(name, { count, since: prev?.since ?? now() })
        else bg.delete(name)
        changed(name)
        return
      }
      if (ev.kind === 'status.changed') {
        const st = d['status']
        if (st === 'working') {
          // Ход, начатый не репликой (Claude сам берёт итоги фоновых задач): провайдер уже работает.
          if (!turns.has(name)) begin(name, 'thinking')
          return
        }
        const isEnd = typeof st === 'string' && (TURN_END.has(st) || (st === 'limited' && typeof d['turnId'] === 'string'))
        if (isEnd && d['rateLimitStatus'] !== 'allowed_warning') end(name)
        return
      }
      const t = turns.get(name)
      if (!t) return
      let moved = false
      switch (ev.kind) {
        case 'message.delta':
          // Пока ждём человека, запоздалая дельта вопрос не прячет.
          if (!t.waits.length) moved = set(name, t, 'writing')
          break
        case 'tool.called':
        case 'agent.spawned': {
          const id = str(d['toolUseId'])
          if (id === null) break
          const input = rec(d['input'])
          const toolName = ev.kind === 'agent.spawned' ? (str(d['name']) ?? 'Agent') : (str(d['name']) ?? 'tool')
          const detail = ev.kind === 'agent.spawned'
            ? (str(d['description']) ?? str(d['subagentType']) ?? '')
            : toolSummary(toolName, input)
          t.tools = [...t.tools.filter((x) => x.id !== id), { id, name: toolName, detail: detail.length > 160 ? `${detail.slice(0, 160)}…` : detail }]
          moved = t.waits.length ? set(name, t, 'waiting') : set(name, t, 'tool')
          break
        }
        case 'tool.finished':
        case 'agent.finished': {
          const id = str(d['toolUseId'])
          if (id === null || !t.tools.some((x) => x.id === id)) break
          t.tools = t.tools.filter((x) => x.id !== id)
          moved = settle(name, t)
          break
        }
        case 'permission.requested': {
          const permId = str(d['id'])
          if (permId === null) break
          const toolName = str(d['toolName']) ?? ''
          t.waits = [...t.waits.filter((w) => w.permId !== permId), { kind: QUESTION_TOOLS.has(toolName) ? 'question' : 'permission', permId, toolName }]
          moved = set(name, t, 'waiting')
          break
        }
        case 'permission.resolved': {
          const permId = str(d['id'])
          if (permId === null || !t.waits.some((w) => w.permId === permId)) break
          t.waits = t.waits.filter((w) => w.permId !== permId)
          moved = settle(name, t)
          break
        }
        default:
          break
      }
      if (moved) changed(name)
    },

    live(name, sig) {
      const t = turns.get(name)
      if (!t) return
      let moved = false
      switch (sig.kind) {
        case 'active':
          if (t.phase === 'starting') moved = set(name, t, 'thinking')
          break
        case 'request':
          if (t.phase === 'starting' || t.phase === 'writing') moved = set(name, t, 'thinking')
          break
        case 'thinking':
          if (t.phase === 'starting' || t.phase === 'writing') moved = set(name, t, 'thinking')
          // Новый блок размышлений — с новой строки, а не впритык к прошлому.
          if (t.reasoning && !t.reasoning.endsWith('\n\n')) { t.reasoning += '\n\n'; moved = true }
          break
        case 'reasoning':
          if (!sig.text) break
          if (t.phase === 'starting' || t.phase === 'writing') set(name, t, 'thinking')
          t.reasoning = (t.reasoning + sig.text).slice(-RAW_TAIL)
          moved = true
          break
      }
      if (moved) changed(name)
    },

    get(name, o = {}) {
      const b = bg.get(name)
      const t = turns.get(name)
      if (t) {
        const top = t.tools[t.tools.length - 1]
        const wait = t.waits[0]
        const text = o.reasoning === false || !t.reasoning.trim() ? '' : redactString(t.reasoning).trim().slice(-REASONING_TAIL)
        return {
          phase: t.phase,
          since: t.since,
          turnSince: t.turnSince,
          ...(t.phase === 'tool' && top ? { tool: { name: top.name, detail: top.detail } } : {}),
          ...(t.phase === 'waiting' && wait ? { waiting: { ...wait } } : {}),
          ...(b ? { background: b.count } : {}),
          ...(text ? { reasoning: text } : {}),
        }
      }
      if (b) return { phase: 'background', since: b.since, turnSince: b.since, background: b.count }
      return null
    },

    names() {
      return [...new Set([...turns.keys(), ...bg.keys()])]
    },

    forget(name) {
      const had = turns.delete(name) || bg.has(name)
      bg.delete(name)
      if (had) changed(name)
    },
  }
}
