import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SavedAttachment } from '../../shell/src/contract.js'
import { setLanguage } from '../../src/i18n/core.js'
import { AttachmentStrip } from '../src/components/AttachmentStrip.js'
import { UserAttachments } from '../src/components/UserAttachments.js'
import { ATTACHMENT_DRAFT_KEY, MAX_ATTACHMENT_BYTES, attachmentSubmission, readAttachmentDraft, saveAttachmentDraft } from '../src/model/attachmentDrafts.js'
import { parseUserAttachments } from '../src/model/conversation.js'

const reference: SavedAttachment = { path: '/local/Original video.mov', name: 'Original video.mov', bytes: 27_282_841, mime: 'video/quicktime', kind: 'file-reference' }
const memory = () => { const entries = new Map<string, string>(); return { get: (k: string) => entries.get(k) ?? null, set: (k: string, value: string) => { entries.set(k, value) } } }

describe('linked original attachments', () => {
  it('keeps only reference metadata across draft reload and structured submission', () => {
    const store = memory()
    saveAttachmentDraft(store, 'chat', [{ ...reference, dataUrl: 'must-not-persist', rawBytes: 'must-not-persist' } as SavedAttachment], 1000)
    assert.deepEqual(readAttachmentDraft(store, 'chat', 1001), [reference])
    assert.deepEqual(attachmentSubmission('unchanged user text', [reference]), { text: 'unchanged user text', attachments: [reference] })
    assert.doesNotMatch(store.get(ATTACHMENT_DRAFT_KEY)!, /dataUrl|rawBytes|must-not-persist/)
    saveAttachmentDraft(store, 'chat', [], 1002)
    assert.deepEqual(readAttachmentDraft(store, 'chat', 1003), [])
  })
  it('only references may exceed the managed byte cap; unsafe numbers and unknown kinds do not restore', () => {
    const store = memory()
    const bad = [
      { ...reference, kind: 'file' }, { ...reference, kind: 'directory' }, { ...reference, kind: 'unknown' },
      { ...reference, bytes: -1 }, { ...reference, bytes: 1.5 }, { ...reference, bytes: Number.MAX_SAFE_INTEGER + 1 },
    ]
    store.set(ATTACHMENT_DRAFT_KEY, JSON.stringify({ chat: { at: 1000, items: [...bad, reference] } }))
    assert.deepEqual(readAttachmentDraft(store, 'chat', 1001), [reference])
    assert.deepEqual(parseUserAttachments([...bad, reference]), [reference])
    const managed = { ...reference, kind: 'file' as const, bytes: MAX_ATTACHMENT_BYTES }
    assert.deepEqual(parseUserAttachments([managed]), [managed])
    assert.deepEqual(parseUserAttachments([{ ...reference, bytes: Number.MAX_SAFE_INTEGER }]), [{ ...reference, bytes: Number.MAX_SAFE_INTEGER }])
  })
  it('RU/EN composer and history cards show link and size without thumbnail bytes or original path text', () => {
    for (const [language, label, size] of [['ru', 'Ссылка', '26.0 МБ'], ['en', 'Link', '26.0 MB']] as const) {
      setLanguage(language)
      const imageReference = { ...reference, name: 'Large image.png', mime: 'image/png' }
      const draft = renderToStaticMarkup(createElement(AttachmentStrip, { items: [imageReference], previews: { [reference.path]: 'data:image/png;base64,SHOULD_NOT_RENDER' }, pending: 0, onRemove: () => {} }))
      const history = renderToStaticMarkup(createElement(UserAttachments, { items: [imageReference] }))
      for (const markup of [draft, history]) {
        assert.ok(markup.includes(label) && markup.includes(size))
        assert.match(markup, /data-kind="file-reference"/)
        assert.doesNotMatch(markup, /<img|SHOULD_NOT_RENDER|data:image/)
      }
      assert.ok(!history.includes(reference.path))
    }
    setLanguage('ru')
  })
})
