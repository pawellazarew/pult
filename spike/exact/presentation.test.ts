import { test, expect } from 'bun:test'
import { presentTranscript } from './presentation.ts'
import type { PultEvent } from '../../src/core/events.ts'

const event = (id: number, kind: PultEvent['kind'], data: PultEvent['data']): PultEvent => ({
  id, kind, data, ts: '2026-11-19T10:00:00Z', sessionId: 'test', provider: 'codex',
})
test('history keeps speakers and folds streamed chunks into one Markdown answer', () => {
  const view = presentTranscript([
    event(1, 'message.user', { text: 'Сделай красиво' }),
    event(2, 'message.delta', { text: '**Гото' }),
    event(3, 'message.delta', { text: 'во**' }),
    event(4, 'message.done', { text: '**Готово**' }),
  ])
  expect(view.messages.map(m => [m.role, m.text])).toEqual([
    ['user', 'Сделай красиво'], ['assistant', '**Готово**'],
  ])
  expect(view.total).toBe(2)
})
test('the reader shows recent messages and reports incomplete history', () => {
  const view = presentTranscript(Array.from({ length: 25 }, (_, i) => event(i + 1, 'message.user', { text: String(i) })), true)
  expect(view.messages).toHaveLength(20)
  expect(view.messages[0].text).toBe('5')
  expect(view.total).toBe(25)
  expect(view.truncated).toBe(true)
})
