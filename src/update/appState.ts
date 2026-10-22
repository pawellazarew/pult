// Состояние обновления окна (0.3.4) — `PULT_HOME/app-update.json`: версии окна, не вставшие на этой машине (bad),
// и последняя попытка. Отдельно от appUpdate.ts: его читает и `pult update --check` (channel.ts), а appUpdate.ts
// сам зависит от channel.ts.

import type { PultPaths } from '../core/paths.js'
import type { AppUpdateAttempt } from '../core/rpc.js'
import { isStableVersion } from '../core/semver.js'
import { atomicWrite } from '../service/fsutil.js'
import { readFileSync } from 'node:fs'

export interface AppState { bad: string[]; last: AppUpdateAttempt | null }

export function readAppState(paths: PultPaths): AppState {
  try {
    const o = JSON.parse(readFileSync(paths.appUpdateState, 'utf8')) as Record<string, unknown>
    const bad = Array.isArray(o['bad']) ? o['bad'].filter((v): v is string => typeof v === 'string' && isStableVersion(v)) : []
    const l = o['last'] as Record<string, unknown> | null | undefined
    const last = l && typeof l === 'object' && typeof l['to'] === 'string' && typeof l['at'] === 'string'
      && (l['result'] === 'done' || l['result'] === 'failed' || l['result'] === 'rolled_back') && typeof l['message'] === 'string'
      ? { to: l['to'], from: typeof l['from'] === 'string' ? l['from'] : null, at: l['at'], result: l['result'], message: l['message'] } as AppUpdateAttempt
      : null
    return { bad, last }
  } catch {
    return { bad: [], last: null }
  }
}

export function writeAppState(paths: PultPaths, st: AppState): void {
  atomicWrite(paths.appUpdateState, JSON.stringify({ schema: 1, ...st }, null, 2) + '\n', 0o600)
}
