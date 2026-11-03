// Журнал стартов `agent.start {requestId}` (быстрый старт, шаг B; design/2026-11-02-quick-start §3.3).
//
// ЗАЧЕМ. Черновик отправляется одним RPC: завести сессию и отдать первую реплику. Ответ может потеряться (окно
// перезагрузили, демон перезапустился посреди старта), и «Повторить» не должно заводить вторую сессию или слать
// реплику второй раз. Поэтому каждый старт с `requestId` (= uuid черновика) пишет журнал фаз
// `PULT_HOME/start/<requestId>.json`:
//
//   accepted → name-reserved → worktree → registered → prompt-accepted → running
//
// Повтор с тем же `requestId` продолжает с записанной фазы: сессия уже есть — её и возвращаем; реплика принята —
// второй раз не шлём. Имя выделяет демон на `name-reserved`, и оно держится за `requestId`, пока журнал жив (7 дней).

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from '../service/fsutil.js'

export const START_PHASES = ['accepted', 'name-reserved', 'worktree', 'registered', 'prompt-accepted', 'running'] as const
export type StartPhase = (typeof START_PHASES)[number]
export const START_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface StartEntry {
  requestId: string
  phase: StartPhase
  name?: string
  /** Ошибка последней попытки: старт не дошёл до `registered` или реплика не принята. */
  error?: { code: string; message: string }
  at: string
  updatedAt: string
}

export const phaseAtLeast = (have: StartPhase, want: StartPhase): boolean => START_PHASES.indexOf(have) >= START_PHASES.indexOf(want)

export interface StartJournal {
  get(requestId: string): StartEntry | null
  put(entry: StartEntry): void
  /** Имена, выделенные стартам, которые ещё не дошли до `registered`. */
  reservedNames(): Set<string>
  /** Убрать записи старше срока; число убранных. */
  prune(maxAgeMs?: number): number
}

export function createStartJournal(dir: string, now: () => number = Date.now): StartJournal {
  const file = (id: string): string => join(dir, `${id}.json`)
  const read = (id: string): StartEntry | null => {
    if (!REQUEST_ID_RE.test(id)) return null
    try {
      const o = JSON.parse(readFileSync(file(id), 'utf8')) as Record<string, unknown>
      if (o['requestId'] !== id || !(START_PHASES as readonly string[]).includes(o['phase'] as string)) return null
      const err = o['error'] && typeof o['error'] === 'object' ? o['error'] as Record<string, unknown> : null
      return {
        requestId: id, phase: o['phase'] as StartPhase,
        ...(typeof o['name'] === 'string' ? { name: o['name'] } : {}),
        ...(err && typeof err['code'] === 'string' && typeof err['message'] === 'string' ? { error: { code: err['code'], message: err['message'] } } : {}),
        at: typeof o['at'] === 'string' ? o['at'] : new Date(0).toISOString(),
        updatedAt: typeof o['updatedAt'] === 'string' ? o['updatedAt'] : new Date(0).toISOString(),
      }
    } catch { return null }
  }
  const all = (): string[] => {
    try { return readdirSync(dir).filter((n) => n.endsWith('.json') && REQUEST_ID_RE.test(n.slice(0, -5))).map((n) => n.slice(0, -5)) } catch { return [] }
  }
  return {
    get: read,
    put(entry) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      atomicWrite(file(entry.requestId), JSON.stringify({ ...entry, updatedAt: new Date(now()).toISOString() }) + '\n', 0o600)
    },
    reservedNames() {
      const out = new Set<string>()
      for (const id of all()) {
        const e = read(id)
        if (e?.name && !phaseAtLeast(e.phase, 'registered')) out.add(e.name)
      }
      return out
    },
    prune(maxAgeMs = START_JOURNAL_MAX_AGE_MS) {
      let n = 0
      for (const id of all()) {
        try {
          if (now() - statSync(file(id)).mtimeMs > maxAgeMs) { unlinkSync(file(id)); n++ }
        } catch { /* уже нет */ }
      }
      return n
    },
  }
}
