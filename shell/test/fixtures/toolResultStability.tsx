// Real mounted UI with synthetic history and explicitly held lazy-detail requests.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Conversation } from '../../../ui/src/components/Conversation.js'
import { foldConversation } from '../../../ui/src/model/conversation.js'
import { compactHistory } from '../../../src/core/history.js'
import { setLanguage } from '../../../src/i18n/core.js'
import type { PultEvent } from '../../../src/core/events.js'

const ts = '2026-11-16T00:00:00Z'
const original = Array.from({ length: 100 }, (_, i) => `строка ${i}`).join('\n') + '\nНе найден тестовый пакет. Установить зависимости?'
interface Scenario { session?: string; end?: number; lite?: boolean; output?: string; language?: 'ru' | 'en'; running?: boolean; success?: boolean }
let scenario: Scenario = {}
const requests: Array<{ resolve(events: PultEvent[]): void; reject(error: Error): void; events: PultEvent[] }> = []
const events = (s: Scenario): PultEvent[] => {
  const called: PultEvent = { id: 1, kind: 'tool.called', data: { toolUseId: 'fixture', name: 'Bash', input: { command: 'echo LONG_INPUT_'.repeat(2000) } }, ts, sessionId: s.session ?? 'fixture', provider: 'codex' }
  if (s.running) return [called]
  return [called, { id: s.end ?? 2, kind: 'tool.finished', data: { toolUseId: 'fixture', isError: !s.success, exitCode: s.success ? 0 : 2, content: s.output ?? original }, ts, sessionId: s.session ?? 'fixture', provider: 'codex' }]
}
const loadEvents = async (): Promise<PultEvent[]> => new Promise((resolve, reject) => requests.push({ resolve, reject, events: events(scenario) }))
const noop = (): void => {}
const root = createRoot(document.getElementById('root')!)
function show(next: Scenario): void {
  scenario = next
  setLanguage(next.language ?? 'ru')
  const all = events(next)
  root.render(createElement('div', { 'data-fixture-session': next.session ?? 'fixture', 'data-fixture-end': next.end ?? 2, 'data-fixture-lite': String(Boolean(next.lite)) }, createElement(Conversation, {
    agent: { name: next.session ?? 'fixture', createdAt: ts, provider: 'codex', status: 'failed', cwd: '/fixture', pending: 0, lastActivity: ts },
    items: foldConversation(next.lite ? compactHistory(all) : all).items, now: 0, usage: undefined, focusedPerm: null,
    permBusy: new Set<string>(), sendError: null, sending: false, onSend: async () => true, onRename: async () => true,
    onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop, loadEvents,
  })))
}
Object.assign(window, { __toolStability: {
  show,
  requests: () => requests.length,
  resolve: (index: number) => requests[index]!.resolve(requests[index]!.events),
  reject: (index: number) => requests[index]!.reject(new Error('controlled detail failure')),
} })
show({})
