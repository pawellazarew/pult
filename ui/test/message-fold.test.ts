import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation } from '../src/components/Conversation.js'
import type { ConversationProps } from '../src/components/Conversation.js'
import type { ConvItem } from '../src/model/conversation.js'

const ts = '2026-11-11T00:00:00Z'
const noop = (): void => {}
function render(text: string, type: 'user' | 'model' = 'user', streaming = false): string {
  const item: ConvItem = type === 'user'
    ? { type, key: 'e1', id: 1, ts, text }
    : { type, key: 'e1', id: 1, ts, text, streaming }
  const props: ConversationProps = {
    agent: { name: 'fold', provider: 'claude', status: 'idle', cwd: '/project', pending: 0, lastActivity: ts },
    items: [item], now: Date.parse(ts), usage: undefined, focusedPerm: null,
    permBusy: new Set(), sendError: null, sending: false,
    onSend: async () => true, onRename: async () => true,
    onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
  }
  return renderToStaticMarkup(createElement(Conversation, props))
}

describe('long message folding', () => {
  it('keeps exactly 500 characters fully visible and folds the 501st for both authors', () => {
    for (const type of ['user', 'model'] as const) {
      assert.doesNotMatch(render('а'.repeat(500), type), /data-testid="message-fold"/)
      const long = render('а'.repeat(500) + 'END_HIDDEN', type)
      assert.match(long, /aria-expanded="false"/)
      assert.match(long, /Развернуть/)
      assert.doesNotMatch(long, /END_HIDDEN/)
    }
  })

  it('counts Unicode code points and never cuts an emoji pair in the preview', () => {
    assert.doesNotMatch(render('🌊'.repeat(500)), /data-testid="message-fold"/)
    const long = render('🌊'.repeat(500) + 'END_HIDDEN')
    assert.match(long, new RegExp('🌊'.repeat(500) + '…'))
    assert.doesNotMatch(long, /END_HIDDEN|�/)
  })

  it('uses the same accessible folding control while a model answer streams', () => {
    const long = render('б'.repeat(500) + 'STREAM_TAIL', 'model', true)
    assert.match(long, /data-streaming="1"/)
    assert.match(long, /aria-controls="[^"]+" aria-expanded="false"/)
    assert.doesNotMatch(long, /STREAM_TAIL/)
  })

  it('does not offer code-copy actions for a truncated fenced-code preview', () => {
    const code = '```ts\n' + 'const value = 1;\n'.repeat(60) + '```'
    const folded = render(code, 'model')
    assert.match(folded, /data-testid="message-fold"/)
    assert.doesNotMatch(folded, /data-testid="md-copy"|data-testid="md-code"/)
  })
})
