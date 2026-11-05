import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AttachmentDraftOwner, attachmentPrompt, ATTACHMENT_DRAFT_KEY, MAX_ATTACHMENTS, MAX_RECOVERY_ATTACHMENTS, attachmentsOverLimit, mergeAttachments, recoverAttachments, readAttachmentDraft, saveAttachmentDraft } from '../src/model/attachmentDrafts.js'
import { DRAFT_TTL_MS } from '../src/model/drafts.js'
import type { SavedAttachment } from '../../shell/src/contract.js'

const file = (name: string): SavedAttachment => ({ path: `/tmp/pult/attachments/chat/2026-10-28/${name}`, name, bytes: 42, mime: 'text/plain', kind: 'file' })
function memory() { const data = new Map<string, string>(); return { data, get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => { data.set(k, v) } } }

describe('вложения в черновике', () => {
  it('отправляет вложение без текста и сохраняет пути с пробелами одним аргументом', () => {
    assert.equal(attachmentPrompt('  ', [file('Отчёт 1.txt')]), "Прикреплённые файлы:\n- '/tmp/pult/attachments/chat/2026-10-28/Отчёт 1.txt'")
    assert.equal(attachmentPrompt('проверь', []), 'проверь')
    assert.match(attachmentPrompt('проверь', [file('a.txt')]), /^проверь\n\nПрикреплённые файлы:/)
  })
  it('восстанавливает карточки после отказа без дублей и потери новых вложений', () => {
    const a = file('a.txt'), b = file('b.txt')
    assert.deepEqual(mergeAttachments([a], [a, b]), [a, b])
    assert.equal(mergeAttachments([], Array.from({ length: 30 }, (_, i) => file(`${i}.txt`))).length, MAX_ATTACHMENTS)
  })
  it('reload восстанавливает metadata без bytes/base64; удалённая карточка не возвращается', () => {
    const s = memory(), a = { ...file('a.txt'), dataUrl: 'data:image/png;base64,SECRET' }
    saveAttachmentDraft(s, 'chat', [a], 1000)
    assert.deepEqual(readAttachmentDraft(s, 'chat', 2000), [file('a.txt')])
    assert.doesNotMatch(s.get(ATTACHMENT_DRAFT_KEY)!, /base64|SECRET|dataUrl/)
    assert.deepEqual(readAttachmentDraft(s, 'other', 2000), [])
    saveAttachmentDraft(s, 'chat', [], 2000)
    assert.deepEqual(readAttachmentDraft(s, 'chat', 2001), [])
  })
  it('старый или повреждённый draft не ломает поле ввода', () => {
    const s = memory()
    saveAttachmentDraft(s, 'chat', [file('a')], 1000)
    assert.deepEqual(readAttachmentDraft(s, 'chat', 1001 + DRAFT_TTL_MS), [])
    s.set(ATTACHMENT_DRAFT_KEY, JSON.stringify({ chat: { at: 1000, items: [null, { path: '../oops' }, file('ok')] } }))
    assert.deepEqual(readAttachmentDraft(s, 'chat', 2000), [file('ok')])
    s.set(ATTACHMENT_DRAFT_KEY, 'null')
    saveAttachmentDraft(s, 'chat', [file('a')], 1000)
    assert.deepEqual(readAttachmentDraft(s, 'chat', 2000), [file('a')])
  })
  it('импорт после переключения чата не перезаписывает новый экземпляр его черновика', async () => {
    const saved: SavedAttachment[][] = []
    const owner = new AttachmentDraftOwner([], (items) => saved.push(items))
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const offOld = owner.subscribe(() => {})
    owner.enqueue(async () => { await barrier; owner.replace(mergeAttachments(owner.items, [file('first')])) }, (e) => { throw e })
    offOld() // A → B → A: view is gone, but its import remains owned by A.
    let visible: SavedAttachment[] = owner.items
    const offNew = owner.subscribe(() => { visible = owner.items })
    owner.enqueue(async () => { owner.replace(mergeAttachments(owner.items, [file('second')])) }, (e) => { throw e })
    assert.equal(owner.pending, 2)
    release()
    await owner.settled()
    assert.deepEqual(visible, [file('first'), file('second')])
    assert.deepEqual(saved.at(-1), visible)
    assert.equal(owner.pending, 0)
    offNew()
  })

  it('возвращает два снимка целиком, хранит больше20 карточек при reload и блокирует их отправку', () => {
    const s = memory()
    const current = Array.from({ length: 20 }, (_, i) => file(`current-${i}`))
    const returned = Array.from({ length: 20 }, (_, i) => file(`returned-${i}`))
    const recovered = recoverAttachments(returned, current)!
    assert.equal(recovered.length, 40)
    assert.deepEqual(new Set(recovered.map((a) => a.path)), new Set([...returned, ...current].map((a) => a.path)))
    assert.equal(attachmentsOverLimit(recovered), true)
    saveAttachmentDraft(s, 'chat', recovered, 1000)
    assert.deepEqual(readAttachmentDraft(s, 'chat', 2000), recovered)
    assert.equal(attachmentsOverLimit(recovered.slice(0, MAX_ATTACHMENTS)), false)
  })
  it('не теряет ни одного файла при совместном возврате отправки и правки очереди', () => {
    const s = memory()
    const batch = (name: string) => Array.from({ length: MAX_ATTACHMENTS }, (_, i) => file(`${name}-${i}`))
    const queueEdit = batch('edit')
    const submitting = batch('sending')
    const current = batch('current')
    const owner = new AttachmentDraftOwner([...submitting], (items) => saveAttachmentDraft(s, 'chat', items, 1000))
    assert.equal(owner.canEditQueue(), true)
    owner.beginSubmission()
    owner.replace([])
    assert.equal(owner.canEditQueue(), false, 'не берём вторую правку, пока отправка может вернуть снимок')
    owner.replace(current)
    assert.equal(owner.recover(queueEdit), true)
    assert.equal(owner.items.length, 40)
    assert.equal(owner.canEditQueue(), false)
    assert.equal(owner.recover(submitting), true)
    owner.endSubmission()
    assert.equal(owner.items.length, MAX_RECOVERY_ATTACHMENTS)
    assert.equal(attachmentsOverLimit(owner.items), true)
    const expected = [...queueEdit, ...submitting, ...current].map((a) => a.path).sort()
    assert.deepEqual(owner.items.map((a) => a.path).sort(), expected)
    const reloaded = readAttachmentDraft(s, 'chat', 2000)
    assert.deepEqual(reloaded, owner.items)
    const before = [...owner.items]
    assert.equal(owner.recover([file('unexpected-extra')]), false)
    assert.deepEqual(owner.items, before, 'отказ сохраняет существующий draft целиком')
    assert.deepEqual(readAttachmentDraft(s, 'chat', 2000), before)
    owner.replace(owner.items.slice(0, MAX_ATTACHMENTS))
    assert.equal(owner.canEditQueue(), true)
  })

})
