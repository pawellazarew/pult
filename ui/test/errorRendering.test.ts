import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import { SessionCardView } from '../src/components/Panels.js'
import { foldConversation } from '../src/model/conversation.js'
import type { PultEvent } from '../src/model/types.js'

const noop = (): void => {}
const event = (id: number, kind: PultEvent['kind'], data: Record<string, unknown>): PultEvent => ({ id, kind, data, ts: '2026-10-28T10:00:00Z', sessionId: 'work', provider: 'codex' })
const render = (events: PultEvent[]): string => renderToStaticMarkup(createElement(Conversation, {
  agent: { name: 'work', provider: 'codex', status: 'failed', cwd: '/w/project', pending: 0, lastActivity: '2026-10-28T10:00:00Z' },
  items: foldConversation(events).items, now: 0, usage: undefined, focusedPerm: null, permBusy: new Set<string>(), sendError: null, sending: false,
  onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
}))

describe('ошибки в ленте и Inbox объясняются одинаково', () => {
  it('failed status: причина словами, исходный код сохранён за закрытым раскрытием', () => {
    const out = render([event(1, 'status.changed', { status: 'failed', errorCode: 'internal', message: 'claude: код 1' })])
    assert.match(out, /Агент не завершил ответ/)
    assert.match(out, /Код 1 — общий сигнал/)
    assert.match(out, /Точную причину по этому числу определить нельзя/)
    assert.match(out, /<details class="error-details"><summary>Технические подробности<\/summary><pre>claude: код 1<\/pre>/)
    const card = renderToStaticMarkup(createElement(SessionCardView, {
      c: { name: 'work', kind: 'failed', id: 1, at: '', error: true, text: 'claude: код 1', retryable: true },
      agent: { name: 'work', provider: 'codex', key: 'work' }, now: 0, retrying: false, onOpen: noop, onRetry: noop,
    }))
    assert.match(card, /Код 1 — общий сигнал/)
    assert.match(card, /Технические подробности/)
    assert.match(card, /data-testid="inbox-retry"/)
  })
  it('commandExecution exit 1 объясняет пустой поиск и не объявляет падение агента', () => {
    const out = render([
      event(1, 'tool.called', { toolUseId: 's', name: 'Bash', input: { command: 'rg "missing" src' } }),
      event(2, 'tool.finished', { toolUseId: 's', isError: true, exitCode: 1, content: '' }),
    ])
    assert.match(out, /Поиск ничего не нашёл/)
    assert.match(out, /Это не означает, что агент сломался/)
    assert.doesNotMatch(out, /Агент не завершил ответ/)
    assert.match(out, /Код завершения: 1/)
  })
  it('отказ авторизации получает конкретный совет, оригинал остаётся доступен', () => {
    const out = render([event(1, 'status.changed', { status: 'failed', message: 'Not logged in. Please run /login' })])
    assert.match(out, /Нужно проверить вход в аккаунт/)
    assert.match(out, /Открой «Диагностику»/)
    assert.match(out, /<pre>Not logged in. Please run \/login<\/pre>/)
  })
})
