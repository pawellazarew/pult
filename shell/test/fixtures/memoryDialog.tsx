import '../../../ui/src/styles.css'
import { useEffect, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryDialog } from '../../../ui/src/components/MemoryDialog.js'
import type { MemoryRecord } from '../../../ui/src/model/memory.js'
import type { PultBridge } from '../../src/contract.js'
import { setLanguage } from '../../../src/i18n/core.js'

setLanguage('ru')
const base = { scope: 'global' as const, summary: 'Краткое описание', details: 'Исходный текст', pinned: false, version: 1, createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z', deleted: false, author: 'owner' as const, reason: 'Создано вручную' }
const records = new Map<string, MemoryRecord>([['first', { ...base, id: 'first', name: 'Первая запись' }], ['second', { ...base, id: 'second', name: 'Вторая запись' }]])
const receipts = new Map<string, MemoryRecord>()
const calls: Array<{ method: string; params: Record<string, unknown> }> = []
let delayed: string | null = null
let release: (() => void) | null = null
let loseReply = false
let globalEscapes = 0
const bridge = { call: async (method: string, params: Record<string, unknown> = {}) => {
  calls.push({ method, params: structuredClone(params) })
  if (method === 'memory.projects') return { projects: [], hasMore: false }
  if (method === 'memory.list' || method === 'memory.search') return { memories: [...records.values()].filter(record => !record.deleted), hasMore: false }
  if (method === 'memory.get') {
    if (params['id'] === delayed) await new Promise<void>(resolve => { release = resolve })
    return structuredClone(records.get(String(params['id'])))
  }
  if (method === 'memory.history') return { versions: [records.get(String(params['id']))], hasMore: false }
  if (method === 'memory.update') {
    const command = String(params['commandId'])
    if (receipts.has(command)) return structuredClone(receipts.get(command))
    const current = records.get(String(params['id']))!
    if (current.version !== params['expectedVersion']) throw { code: 'conflict', message: 'Version conflict' }
    const next = { ...current, name: String(params['name']), summary: String(params['summary']), details: String(params['details']), pinned: Boolean(params['pinned']), reason: String(params['reason']), version: current.version + 1 }
    records.set(next.id, next); receipts.set(command, structuredClone(next))
    if (loseReply) { loseReply = false; throw { code: 'connection_closed', message: 'Fixture lost the committed reply' } }
    return structuredClone(next)
  }
  throw new Error('Unexpected fixture memory method')
} } as unknown as Pick<PultBridge, 'call'>

function LayoutProbe({ sequence }: { sequence: number }): null {
  useLayoutEffect(() => { if (sequence) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) }, [sequence])
  return null
}
function App() {
  const [active, setActive] = useState(true)
  const [sequence, setSequence] = useState(0)
  useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape' && active) { globalEscapes++; setActive(false) } }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [active])
  Object.assign(window, { __memoryDialog: {
    snapshot: () => ({ active, globalEscapes, calls: structuredClone(calls) }),
    delayGet: (id: string) => { delayed = id },
    releaseGet: () => { delayed = null; release?.(); release = null },
    loseNextReply: () => { loseReply = true },
    openAtLayout: () => { setActive(true); setSequence(value => value + 1) },
  } })
  return <><button type="button" data-testid="fixture-memory-open" onClick={() => setActive(true)}>Память</button><MemoryDialog bridge={bridge} active={active} online available onClose={() => setActive(false)} /><LayoutProbe sequence={sequence} /></>
}
createRoot(document.getElementById('root')!).render(<App />)
