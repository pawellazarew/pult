// 0.3.2: правка реплики в очереди под полем ввода. Без DOM: разметка — react-dom/server, шаги правки — чистые
// функции model/queueEdit.ts (клавиши, сохранение, отказ «уже ушла / удалена», срок).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Conversation, QueueList } from '../src/components/Conversation.js'
import type { QueueEditView } from '../src/components/Conversation.js'
import type { AgentView } from '../src/model/agents.js'
import { restoreDraft } from '../src/model/pending.js'
import {
  expireQueueEdit, QUEUE_EDIT_EXPIRED, QUEUE_EDIT_EXPIRED_KEPT, queueEditKey, queueGoneText, saveQueueEdit, startQueueEdit,
} from '../src/model/queueEdit.js'
import type { QueueEditState } from '../src/model/queueEdit.js'

const html = (c: unknown, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(c as ComponentType<Record<string, unknown>>, props))
const noop = (): void => {}
const queue = [{ id: 'a1', text: 'первая', at: '' }, { id: 'b2', text: 'вторая', at: '' }, { id: 'c3', text: 'третья', at: '' }]
const view = (state: QueueEditState | null, over: Partial<QueueEditView> = {}): QueueEditView =>
  ({ state, opening: null, onStart: noop, onChange: noop, onSave: noop, onCancel: noop, ...over })
const list = (over: Record<string, unknown> = {}): string =>
  html(QueueList, { queue, paused: false, onRemove: noop, onMove: noop, onResume: noop, ...over })
const st = (over: Partial<QueueEditState> = {}): QueueEditState =>
  ({ ...startQueueEdit('b2', { text: 'вторая полностью', holdMs: 600_000 }), ...over })

describe('правка реплики в очереди: клавиши', () => {
  const k = (key: string, mods: Partial<Record<'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'isComposing', boolean>> = {}) =>
    queueEditKey({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods })
  it('Enter — сохранить, Shift+Enter — новая строка, Esc — отмена; ⌘Enter и набор IME — не наши', () => {
    assert.equal(k('Enter'), 'save')
    assert.equal(k('Enter', { shiftKey: true }), null)
    assert.equal(k('Enter', { metaKey: true }), null)
    assert.equal(k('Enter', { ctrlKey: true }), null)
    assert.equal(k('Enter', { altKey: true }), null)
    assert.equal(k('Escape'), 'cancel')
    assert.equal(k('Enter', { isComposing: true }), null)
    assert.equal(k('Escape', { isComposing: true }), null)
    assert.equal(k('a'), null)
  })
})

describe('правка реплики в очереди: список', () => {
  it('без правки — «Изменить» у каждой реплики; старый демон (нет edit) — кнопки нет', () => {
    const h = list({ edit: view(null) })
    assert.equal((h.match(/data-testid="queue-edit"/g) ?? []).length, 3)
    assert.match(h, /aria-label="Изменить реплику"/)
    assert.doesNotMatch(list(), /queue-edit/)
  })

  it('правка открыта — поле с полным текстом на том же месте, «Сохранить»/«Отмена», остальные «Изменить» заперты', () => {
    const h = list({ edit: view(st()) })
    const rows = h.split('<li').slice(1)
    assert.equal(rows.length, 3)
    assert.match(rows[1] ?? '', /data-testid="queue-item-edit"[^>]*data-id="b2"/)
    assert.match(rows[1] ?? '', /<span class="n mono">2<\/span>/)
    assert.match(rows[1] ?? '', /<textarea[^>]*aria-label="Изменить реплику в очереди"[^>]*>вторая полностью<\/textarea>/)
    assert.match(rows[1] ?? '', /data-testid="queue-edit-save"[^>]*>Сохранить/)
    assert.match(rows[1] ?? '', /data-testid="queue-edit-cancel"[^>]*>Отмена/)
    assert.doesNotMatch(rows[1] ?? '', /queue-remove|queue-up/, 'у правленой — только «Сохранить» и «Отмена»')
    for (const r of [rows[0], rows[2]]) assert.match(r ?? '', /disabled=""[^>]*data-testid="queue-edit"/)
  })

  it('сохраняется — поле только для чтения (фокус и Esc остаются у него), кнопки заперты; ошибка — под полем', () => {
    const h = list({ edit: view(st({ saving: true })) })
    assert.match(h, /<textarea[^>]*readOnly=""/)
    assert.match(h, /disabled=""[^>]*data-testid="queue-edit-save"/)
    const e = list({ edit: view(st({ error: 'реплика для очереди длиннее 50000 знаков' })) })
    assert.match(e, /role="alert"[^>]*data-testid="queue-edit-error"[^>]*>реплика для очереди длиннее/)
  })

  it('реплику убрали, пока правка открыта, — правка остаётся последней строкой с пометкой', () => {
    const h = list({ queue: queue.filter((x) => x.id !== 'b2'), edit: view(st()) })
    assert.equal((h.match(/data-testid="queue-item"/g) ?? []).length, 2)
    assert.match(h, /data-testid="queue-item-edit"[^>]*>.*—<\/span>/)
    assert.match(h, /реплики уже нет в очереди/)
    // Очереди нет совсем — список всё равно показывает правку.
    assert.match(list({ queue: [], edit: view(st()) }), /queue-edit-text/)
  })

  it('заметка над списком', () => {
    assert.match(list({ notice: 'Реплика уже ушла — исправленный текст в поле ввода' }), /data-testid="queue-notice"[^>]*>Реплика уже ушла/)
  })

  it('разговор с правкой очереди — кнопка «Изменить» под полем ввода', () => {
    const agent: AgentView = {
      name: 'w', provider: 'claude', status: 'working', cwd: '/w', pending: 0, lastActivity: '2026-10-20T10:00:00Z', queue: queue.slice(0, 1),
    }
    const props = {
      agent, items: [], now: 0, usage: undefined, focusedPerm: null, permBusy: new Set(), sendError: null, sending: false,
      onSend: async () => true, onRename: async () => true, onStop: noop, onRemove: noop, onReveal: noop, onApprove: noop, onDeny: noop, onFocusPerm: noop,
      onQueueRemove: noop, onQueueMove: noop, onQueueResume: noop,
    }
    assert.match(html(Conversation, { ...props, onQueueEdit: { hold: async () => ({ text: '', holdMs: 1 }), save: async () => {}, release: noop } }), /data-testid="queue-edit"/)
    assert.doesNotMatch(html(Conversation, props), /data-testid="queue-edit"/)
  })
})

describe('правка реплики в очереди: сохранение, отказ, срок', () => {
  const rig = (fail?: { code: string | null; text: string }) => {
    const calls: string[] = []
    let composer = ''
    const io = {
      save: async (id: string, text: string) => { calls.push(`save ${id} ${text}`); if (fail) throw fail },
      release: (id: string) => { calls.push(`release ${id}`) },
      toComposer: (text: string) => { calls.push(`composer ${text}`); composer = restoreDraft(composer, text).text },
      errorOf: (e: unknown) => e as { code: string | null; text: string },
      setComposer: (t: string) => { composer = t },
      composer: () => composer,
    }
    return { calls, io }
  }

  it('сохранено — правка закрыта, текст ушёл демону; без изменений — только отпустить очередь', async () => {
    const r = rig()
    assert.deepEqual(await saveQueueEdit(st({ text: 'новое' }), r.io), { next: null, notice: null })
    assert.deepEqual(r.calls, ['save b2 новое'])
    const u = rig()
    assert.deepEqual(await saveQueueEdit(st(), u.io), { next: null, notice: null })
    assert.deepEqual(u.calls, ['release b2'])
  })

  it('пусто — правка открыта с ошибкой, демон не зовётся', async () => {
    const r = rig()
    const s = await saveQueueEdit(st({ text: '  \n ' }), r.io)
    assert.equal(s.next?.id, 'b2')
    assert.match(s.next?.error ?? '', /крестиком/)
    assert.deepEqual(r.calls, [])
  })

  it('реплика уже ушла / удалена — правка закрыта, исправленный текст в поле: пустое — как есть, набранное — под ним', async () => {
    const sent = rig({ code: 'queue_item_sent', text: 'Реплика уже ушла' })
    const a = await saveQueueEdit(st({ text: 'исправлено' }), sent.io)
    assert.deepEqual(a, { next: null, notice: 'Реплика уже ушла — исправленный текст в поле ввода' })
    assert.equal(sent.io.composer(), 'исправлено')

    const removed = rig({ code: 'queue_item_removed', text: 'удалена' })
    removed.io.setComposer('уже набрал')
    const b = await saveQueueEdit(st({ text: 'исправлено' }), removed.io)
    assert.equal(b.notice, 'Реплика уже удалена — исправленный текст в поле ввода')
    assert.equal(removed.io.composer(), 'исправлено\n\nуже набрал', 'правило M8e: отвергнутое — первым, через пустую строку')
  })

  it('другая ошибка (длинно) — правка открыта, текст на месте, в поле ввода ничего', async () => {
    const r = rig({ code: 'invalid_params', text: 'реплика для очереди длиннее 50000 знаков' })
    const s = await saveQueueEdit(st({ text: 'длинно', saving: true }), r.io)
    assert.deepEqual([s.next?.text, s.next?.saving, s.next?.error, s.notice], ['длинно', false, 'реплика для очереди длиннее 50000 знаков', null])
    assert.equal(r.io.composer(), '')
  })

  it('коды отказа', () => {
    assert.match(queueGoneText('queue_item_sent') ?? '', /уже ушла/)
    assert.match(queueGoneText('queue_item_removed') ?? '', /уже удалена/)
    assert.equal(queueGoneText('invalid_params'), null)
    assert.equal(queueGoneText(null), null)
  })

  it('срок вышел — правка закрыта, очередь отпущена; исправленное — в поле, нетронутое — нет', () => {
    const a = rig()
    assert.deepEqual(expireQueueEdit(st(), a.io), { next: null, notice: QUEUE_EDIT_EXPIRED })
    assert.deepEqual(a.calls, ['release b2'])
    const b = rig()
    assert.deepEqual(expireQueueEdit(st({ text: 'почти дописал' }), b.io), { next: null, notice: QUEUE_EDIT_EXPIRED_KEPT })
    assert.equal(b.io.composer(), 'почти дописал')
  })
})
