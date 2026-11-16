// Commit-boundary keyboard ownership: actual components, synthetic runtime bridge only.
import '../../../ui/src/styles.css'
import { createElement, useEffect, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RuntimePanel } from '../../../ui/src/components/RuntimePanel.js'
import { SettingsDialog } from '../../../ui/src/components/Settings.js'
import { setLanguage } from '../../../src/i18n/core.js'
import type { PultBridge } from '../../src/contract.js'

setLanguage('ru')
type Trigger = 'none' | 'escape' | 'native'
let nativeVisible = false
let saveCount = 0
let passiveSeq = 0
const nativeHandlers = new Set<(id: string) => void>()
const probes: Array<{ beforePassive: boolean; expanded: boolean; modal: boolean; nativeVisible: boolean }> = []
const nativeEscape = (): void => { for (const fn of nativeHandlers) fn('fixture') }
const bridge = {
  call: async (method: string) => {
    if (method === 'runtime.discover') return { targets: [{ id: 'web:fixture', name: 'Fixture', kind: 'web', state: 'ready', capabilities: ['screenshot'] }], setup: [], attached: ['web:fixture'], controller: 'human' }
    if (method === 'runtime.setup.list') return { requests: [] }
    if (method === 'runtime.perform') return { width: 1280, height: 800, coordinateWidth: 1280, coordinateHeight: 800 }
    throw new Error('unexpected fixture method')
  },
  runtimePreview: async () => ({ width: 1280, height: 800, coordinateWidth: 1280, coordinateHeight: 800 }),
  runtimeView: async (_id: string, bounds: unknown) => { nativeVisible = bounds !== null },
  onRuntimeEscape: (fn: (id: string) => void) => { nativeHandlers.add(fn); return () => { nativeHandlers.delete(fn) } },
} as unknown as PultBridge
const snapshot = () => ({ expanded: !!document.querySelector('.runtime-expanded'), modal: !!document.querySelector('[data-testid="settings-dialog"]'), nativeVisible, discard: !!document.querySelector('.settings-discard'), saves: saveCount })
function LayoutProbe({ seq, trigger }: { seq: number; trigger: Trigger }): null {
  useLayoutEffect(() => {
    if (!seq || trigger === 'none') return
    const state = snapshot()
    probes.push({ beforePassive: passiveSeq < seq, expanded: state.expanded, modal: state.modal, nativeVisible: state.nativeVisible })
    if (trigger === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    else nativeEscape()
  }, [seq, trigger])
  useEffect(() => { passiveSeq = seq }, [seq])
  return null
}
function App() {
  const [modal, setModal] = useState(false)
  const [probe, setProbe] = useState({ seq: 0, trigger: 'none' as Trigger })
  Object.assign(window, { __modalRuntimeKeys: {
    open: (trigger: Trigger) => { setModal(true); setProbe((p) => ({ seq: p.seq + 1, trigger })) },
    probe: (trigger: Trigger) => setProbe((p) => ({ seq: p.seq + 1, trigger })),
    nativeEscape, snapshot, probes: () => probes,
  } })
  return <>
    <RuntimePanel bridge={bridge} sessionId="fixture" obstructed={modal} onClose={() => {}} />
    {modal && <SettingsDialog settings={null} catalog={null} languageSupported onSave={async () => { saveCount += 1; return null }} onClose={() => setModal(false)} />}
    <LayoutProbe seq={probe.seq} trigger={probe.trigger} />
  </>
}
createRoot(document.getElementById('root')!).render(createElement(App))
