import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { setLanguage } from '../../../src/i18n/core.js'
import type { ProviderFileIdentity } from '../../../src/env/providerIdentity.js'
import type { DaemonStatus, ProviderTool, PultBridge } from '../../src/contract.js'
import { providerDaemonKey, providerUpdateCards } from '../../../ui/src/model/providerUpdates.js'
import { useProviderUpdates } from '../../../ui/src/useProviderUpdates.js'

setLanguage('ru')
let clock = 100_000
Date.now = () => clock
const identity = (version: number): ProviderFileIdentity => ({ path: '/fixture/codex', realpath: `/fixture/codex-${version}`, dev: '1', ino: String(version), size: '100', mtimeNs: String(version), ctimeNs: String(version) })
const tool = (version: number): ProviderTool => ({ provider: 'codex', path: '/fixture/codex', realpath: `/fixture/codex-${version}`, version: `codex-cli ${version}.0`, source: 'native', installation: identity(version) })
const daemon = (pid: number, version: number): DaemonStatus => ({ pid, home: '/fixture/pult', startedAt: `2026-11-19T10:00:0${pid}Z`, providerInstallations: { codex: { initialized: true, installation: identity(version) }, claude: { initialized: false, installation: null } } }) as DaemonStatus
let inventory = [tool(1)]
let fixturePid = 1
let holdInventory = true
let holdRestart = false
let restartOutcome: 'cancel' | 'confirm' | 'lost' = 'cancel'
const calls: Array<{ id: number; pid: number; version: string | null }> = []
const restartCalls: Array<{ id: number; outcome: string }> = []
const otherCalls: string[] = []
const heldInventory = new Map<number, () => void>()
const heldRestart = new Map<number, () => void>()
const acknowledged: string[] = []
let refreshStatusCalls = 0
const refreshStatus = async (): Promise<void> => { refreshStatusCalls++ }
const bridge = {
  providerTools: async (): Promise<ProviderTool[]> => {
    const selected = structuredClone(inventory)
    const id = calls.length + 1
    calls.push({ id, pid: fixturePid, version: selected[0]?.version ?? null })
    if (holdInventory) {
      holdInventory = false
      await new Promise<void>(resolve => { heldInventory.set(id, resolve) })
    }
    return selected
  },
  restartDaemon: async (): Promise<boolean> => {
    const outcome = restartOutcome
    const id = restartCalls.length + 1
    restartCalls.push({ id, outcome })
    if (holdRestart) {
      holdRestart = false
      await new Promise<void>(resolve => { heldRestart.set(id, resolve) })
    }
    if (outcome === 'lost') throw new Error('Fixture lost restart reply')
    return outcome === 'confirm'
  },
  call: async (method: string): Promise<never> => { otherCalls.push(method); throw new Error('Unexpected RPC in provider observation fixture') },
  providerAction: async (): Promise<never> => { otherCalls.push('providerAction'); throw new Error('Installer/login action is forbidden in fixture') },
  runDoctor: async (): Promise<never> => { otherCalls.push('runDoctor'); throw new Error('Doctor/auth action is forbidden in fixture') },
} as unknown as PultBridge

function App() {
  const [status, setStatus] = useState(() => daemon(1, 1))
  const updates = useProviderUpdates(bridge, status, true, refreshStatus)
  const cards = providerUpdateCards(status, updates.observation, { online: true, canReconnect: true, checking: updates.checking, reconnecting: updates.reconnecting, error: updates.error })
  useEffect(() => {
    if (updates.observation) acknowledged.push(updates.observation.daemon)
  }, [updates.observation])
  Object.assign(window, { __providerUpdatesFixture: {
    snapshot: () => ({ calls: structuredClone(calls), restartCalls: structuredClone(restartCalls), otherCalls: [...otherCalls], heldInventory: [...heldInventory.keys()], heldRestart: [...heldRestart.keys()], acknowledged: [...acknowledged], refreshStatusCalls, clock }),
    setDaemon: (pid: number, version: number) => { fixturePid = pid; setStatus(daemon(pid, version)) },
    setInventory: (version: number) => { inventory = [tool(version)] },
    holdNextInventory: () => { holdInventory = true },
    releaseInventory: (id: number) => { const release = heldInventory.get(id); heldInventory.delete(id); release?.() },
    setRestart: (outcome: 'cancel' | 'confirm' | 'lost', hold: boolean) => { restartOutcome = outcome; holdRestart = hold },
    releaseRestart: (id: number) => { const release = heldRestart.get(id); heldRestart.delete(id); release?.() },
    advance: (ms: number) => { clock += ms },
    focusBurst: (count: number) => { for (let n = 0; n < count; n++) window.dispatchEvent(new Event('focus')) },
  } })
  return <main>
    <div data-testid="fixture-provider-state" data-checking={updates.checking ? '1' : '0'} data-reconnecting={updates.reconnecting ? '1' : '0'} data-daemon={providerDaemonKey(status)} />
    <output data-testid="fixture-provider-observation">{JSON.stringify(updates.observation)}</output>
    <output data-testid="fixture-provider-error">{updates.error}</output>
    <button type="button" data-testid="fixture-provider-refresh" onClick={() => void updates.refresh(true)}>Перепроверить</button>
    <button type="button" data-testid="fixture-provider-reconnect" onClick={() => void updates.reconnect()}>Переподключить</button>
    <section>{cards.map(card => <article key={card.id} data-testid="fixture-provider-notice" data-notice-id={card.id} data-action={card.action} data-error={card.error ? '1' : '0'}>
      <strong>{card.title}</strong><p>{card.detail}</p><button type="button" disabled={card.actionDisabled} onClick={() => card.action === 'reconnect' ? void updates.reconnect() : void updates.refresh(true)}>{card.actionLabel}</button>
    </article>)}</section>
  </main>
}
createRoot(document.getElementById('root')!).render(<App />)
