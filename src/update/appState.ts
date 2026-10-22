// Состояние обновления окна (0.3.4) — `PULT_HOME/app-update.json`: версии окна, не вставшие на этой машине (bad),
// и последняя попытка. Отдельно от appUpdate.ts: его читает и `pult update --check` (channel.ts), а appUpdate.ts
// сам зависит от channel.ts.

import type { PultPaths } from '../core/paths.js'
import type { AppUpdateAttempt } from '../core/rpc.js'
import { isStableVersion } from '../core/semver.js'
import { atomicWrite } from '../service/fsutil.js'
import { readFileSync } from 'node:fs'

/**
 * Окно заменено, пока оно было закрыто, и ещё ни разу не запускалось: прежнее (`prev`) держится до первой готовности
 * нового; первый запуск не заработал за 60 с — `failed`, и «Вернуть <from>» в «Настройках» / `pult update --app
 * --rollback`.
 */
export interface AppPending { to: string; from: string; prev: string; app: string; swapAt: number; failed: boolean }

export interface AppState { bad: string[]; last: AppUpdateAttempt | null; pending?: AppPending | null }

export function readAppState(paths: PultPaths): AppState {
  try {
    const o = JSON.parse(readFileSync(paths.appUpdateState, 'utf8')) as Record<string, unknown>
    const bad = Array.isArray(o['bad']) ? o['bad'].filter((v): v is string => typeof v === 'string' && isStableVersion(v)) : []
    const l = o['last'] as Record<string, unknown> | null | undefined
    const last = l && typeof l === 'object' && typeof l['to'] === 'string' && typeof l['at'] === 'string'
      && (l['result'] === 'done' || l['result'] === 'failed' || l['result'] === 'rolled_back') && typeof l['message'] === 'string'
      ? { to: l['to'], from: typeof l['from'] === 'string' ? l['from'] : null, at: l['at'], result: l['result'], message: l['message'] } as AppUpdateAttempt
      : null
    const pd = o['pending'] as Record<string, unknown> | null | undefined
    const pending = pd && typeof pd === 'object' && typeof pd['to'] === 'string' && typeof pd['from'] === 'string'
      && typeof pd['prev'] === 'string' && typeof pd['app'] === 'string' && typeof pd['swapAt'] === 'number'
      ? { to: pd['to'], from: pd['from'], prev: pd['prev'], app: pd['app'], swapAt: pd['swapAt'], failed: pd['failed'] === true }
      : null
    return { bad, last, pending }
  } catch {
    return { bad: [], last: null }
  }
}

export function writeAppState(paths: PultPaths, st: AppState): void {
  atomicWrite(paths.appUpdateState, JSON.stringify({ schema: 1, ...st }, null, 2) + '\n', 0o600)
}
