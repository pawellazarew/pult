// Full production Console and native bridge; only the daemon.status transport snapshot is controlled.
import '../../../ui/src/styles.css'
import '../../../ui/src/projects.css'
import '../../../ui/src/appearance.css'
import '../../../ui/src/workspace.css'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Console } from '../../../ui/src/Console.js'
import { setLanguage } from '../../../src/i18n/core.js'
import type { UpdateStatus } from '../../../src/core/rpc.js'
import type { PultBridge } from '../../src/contract.js'

setLanguage('ru')
const real = window.pult!
let injected: UpdateStatus | null = null
let calls = 0, active = 0, peak = 0, delay = 0
const history: Array<Record<string, unknown>> = []
const record = (method: string, phase: string, u: UpdateStatus | null): void => { history.push({ method, phase, at: performance.now(), percent: u?.staged?.progress?.percent ?? null, stage: u?.staged?.state ?? null, apply: u?.apply.state ?? null, checkedAgeMs: u?.checkedAt ? Date.now() - Date.parse(u.checkedAt) : null }); if (history.length > 100) history.shift() }
const root = createRoot(document.getElementById('root')!)
const bridge = { ...real, call: async (method: Parameters<PultBridge['call']>[0], params?: Record<string, unknown>) => {
  if (method !== 'daemon.status') { const value = await real.call(method, params); if (method === 'update.check') record(method, 'done', value as UpdateStatus); return value }
  calls++; active++; peak = Math.max(peak, active)
  try {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    const status = await real.call(method, params) as Record<string, unknown>
    const result = injected ? { ...status, update: injected } : status
    record(method, 'done', result['update'] as UpdateStatus)
    return result
  } finally { active-- }
} } as PultBridge
Object.assign(window, { __updateExperienceFixture: {
  setStatus: (value: UpdateStatus) => { injected = value; record('injected', 'set', value) },
  delay: (value: number) => { delay = value },
  stats: () => ({ calls, active, peak, history }),
  unmount: () => root.unmount(),
} })
root.render(createElement(Console, { bridge }))
