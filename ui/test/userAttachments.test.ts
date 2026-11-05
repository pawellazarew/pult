import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { setLanguage } from '../../src/i18n/core.js'
import { UserAttachments, attachmentSize } from '../src/components/UserAttachments.js'
import { applyConversation, EMPTY_CONVERSATION, foldConversation, parseUserAttachments } from '../src/model/conversation.js'
import type { PultEvent } from '../src/model/types.js'
import type { UserItem } from '../src/model/conversation.js'
import { attachmentSubmission } from '../src/model/attachmentDrafts.js'
const image = { path: '/pult/attachments/w/2026-11-05/copy.png', name: 'Снимок экрана.png', bytes: 55 * 1024, mime: 'image/png', kind: 'file' as const }
const event = (id: number, text: string, attachments?: unknown): PultEvent => ({ id, sessionId: 'w', ts: '2026-11-05T12:00:00Z', provider: 'codex', kind: 'message.user', data: { text, ...(attachments !== undefined ? { attachments } : {}) } })

describe('user attachment history metadata', () => {
  it('replays original text and attachment-only messages without injecting provider paths into text', () => {
    const rows = [event(1, 'Посмотри', [image]), event(2, '', [image])]
    const conversation = foldConversation(rows)
    const first = conversation.items[0] as UserItem, second = conversation.items[1] as UserItem
    assert.equal(first.text, 'Посмотри'); assert.deepEqual(first.attachments, [image])
    assert.equal(second.text, ''); assert.deepEqual(second.attachments, [image])
    const live = rows.reduce(applyConversation, EMPTY_CONVERSATION)
    assert.deepEqual(live.items, conversation.items)
    assert.deepEqual(attachmentSubmission('', [image]), { text: '', attachments: [image] })
  })
  it('leaves legacy text messages unchanged and drops malformed or blob fields', () => {
    const legacy = foldConversation([event(1, 'Прикреплённые файлы:\n- /legacy/file.png')]).items[0] as UserItem
    assert.equal(legacy.attachments, undefined); assert.match(legacy.text, /legacy/)
    assert.deepEqual(parseUserAttachments([{ ...image, base64: 'do-not-copy', dataUrl: 'data:image/png;base64,secret' }]), [image])
    assert.deepEqual(parseUserAttachments([null, { ...image, bytes: -1 }, { ...image, path: 'https://example.com/a.png' }, { ...image, name: 'bad\nname' }, { ...image, mime: null }]), [])
    assert.equal(parseUserAttachments(Array(22).fill(image)).length, 20)
  })
  it('renders compact names and sizes without technical path text, path title, or base64', () => {
    setLanguage('ru')
    const markup = renderToStaticMarkup(createElement(UserAttachments, { items: [image] }))
    assert.match(markup, /Снимок экрана.png/); assert.match(markup, /55 КБ/)
    assert.ok(!markup.includes(image.path)); assert.ok(!markup.includes('Прикреплённые файлы:\n'))
    assert.equal(renderToStaticMarkup(createElement(UserAttachments, { items: [] })), '')
  })
  it('keeps English attachment sizes and labels readable', () => {
    setLanguage('en')
    try {
      assert.equal(attachmentSize(image), '55 KB')
      assert.equal(attachmentSize({ bytes: 0, kind: 'directory' }), 'Folder · link')
      const markup = renderToStaticMarkup(createElement(UserAttachments, { items: [{ ...image, name: 'Screenshot.png' }] }))
      assert.match(markup, /Open Screenshot.png/); assert.ok(!markup.includes('Открыть'))
    } finally { setLanguage('ru') }
  })
})
