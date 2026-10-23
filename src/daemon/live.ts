// Живой канал фаз хода (0.3.5): кадры `turn.phase` подписчикам, у которых `since >= LIVE_CURSOR_BASE`
// (src/sessions/turnPhase.ts — почему так). В журнал не пишется НИЧЕГО: фаза — состояние «сейчас», а не история,
// и её перемены (тем более текст размышлений) раздули бы events.jsonl и ленту.
//
// ТЕМП. Перемены сессии сливаются: первая уходит сразу, следующие — не чаще раза в `minGapMs` (последнее
// значение на момент отправки). Поток дельт размышлений — это несколько кадров в секунду, а не сотни.
// Подписчиков нет — кадров нет вовсе (ни таймеров, ни редакции текста).
//
// НОМЕРА. Кадр получает номер из своей последовательности от `LIVE_CURSOR_BASE`; новая подписка поднимает её
// выше своего `since` — оболочка после рестарта демона переподписывается с последним номером, который видела,
// и обязана получить кадры с номерами больше него.

import type { PultEvent } from '../core/events.js'
import type { PhaseFrameData, TurnPhase } from '../sessions/turnPhase.js'
import { LIVE_CURSOR_BASE, PHASE_FRAME_KIND } from '../sessions/turnPhase.js'
import { DAEMON_SESSION } from '../core/events.js'

/** Кадр живого канала: та же форма, что у события, чтобы оболочка 0.1.15 доставила его как есть. */
export type LiveFrame = Omit<PultEvent, 'kind' | 'data'> & { kind: typeof PHASE_FRAME_KIND; data: PhaseFrameData }

export interface LiveChannel {
  /** Фаза сессии сменилась — кадр уйдёт по правилу темпа. */
  touch(name: string): void
  /** Подписаться: сначала `reset` и текущие фазы (снимок), потом живые кадры. Номера — выше `since`. */
  subscribe(since: number, deliver: (frame: LiveFrame) => void): { start(): void; stop(): void }
  count(): number
  close(): void
}

export interface LiveChannelOptions {
  /** Текущая фаза сессии (с текстом размышлений) и все сессии с фазой. */
  phase(name: string): TurnPhase | null
  names(): string[]
  minGapMs?: number
  now?: () => number
}

/** Один кадр сессии не чаще, мс. */
export const LIVE_MIN_GAP_MS = 150

export function createLiveChannel(opts: LiveChannelOptions): LiveChannel {
  const gap = opts.minGapMs ?? LIVE_MIN_GAP_MS
  const now = opts.now ?? Date.now
  let seq = LIVE_CURSOR_BASE
  const listeners = new Set<(frame: LiveFrame) => void>()
  const lastSent = new Map<string, number>()
  const timers = new Map<string, NodeJS.Timeout>()

  const frame = (sessionId: string, data: PhaseFrameData): LiveFrame =>
    ({ id: ++seq, ts: new Date(now()).toISOString(), sessionId, provider: 'pult', kind: PHASE_FRAME_KIND, data })

  const send = (name: string): void => {
    timers.delete(name)
    lastSent.set(name, now())
    if (!listeners.size) return
    const f = frame(name, { phase: opts.phase(name) })
    for (const l of [...listeners]) { try { l(f) } catch { /* один сломанный подписчик не роняет других */ } }
  }

  return {
    touch(name) {
      if (!listeners.size) { lastSent.delete(name); return }
      if (timers.has(name)) return
      const wait = (lastSent.get(name) ?? -Infinity) + gap - now()
      if (wait <= 0) { send(name); return }
      const t = setTimeout(() => send(name), wait)
      t.unref?.()
      timers.set(name, t)
    },

    subscribe(since, deliver) {
      let on: ((f: LiveFrame) => void) | null = null
      return {
        start() {
          if (Number.isFinite(since) && since > seq) seq = Math.floor(since)
          deliver(frame(DAEMON_SESSION, { reset: true }))
          for (const name of opts.names()) deliver(frame(name, { phase: opts.phase(name) }))
          on = deliver
          listeners.add(on)
        },
        stop() { if (on) listeners.delete(on); on = null },
      }
    },

    count: () => listeners.size,

    close() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      listeners.clear()
    },
  }
}
