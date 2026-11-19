import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { appendMemoryPage, MEMORY_METHODS, memoryAvailability, memoryDirty, memoryDraft, memoryDraftError, memoryMutation, memoryProjectLabel, memorySelector } from '../src/model/memory.js'
import type { MemoryRecord } from '../src/model/memory.js'

const record: MemoryRecord = {
  id: 'm-1', scope: 'project', projectId: 'git:/repo/.git', name: 'Решение', summary: 'Кратко', details: 'Подробно',
  pinned: false, version: 7, createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T11:00:00Z',
  deleted: false, author: 'codex', reason: 'Исходная причина', sourceSession: 'chat-1', sourceEventId: 42,
  sourceTurnId: 'turn-1', sourceCreatedAt: '2026-11-19T09:00:00Z',
}

describe('owner memory UI contract', () => {
  it('gates on actual backend methods and treats a busy store as available', () => {
    assert.equal(memoryAvailability(null, true).available, false)
    const capabilities = { supportedMethods: [...MEMORY_METHODS] }
    assert.deepEqual(memoryAvailability({ capabilities, memory: { busy: true } }, true), { available: true, error: null })
    assert.equal(memoryAvailability({ capabilities, memory: { available: true } }, false).available, false)
    assert.deepEqual(memoryAvailability({ capabilities, memory: { available: false, error: 'storage error' } }, true), { available: false, error: 'storage error' })
    assert.equal(memoryAvailability({ capabilities: { supportedMethods: ['memory.list'] } }, true).available, false)
  })

  it('keeps session and persisted project selection exact and mutually exclusive', () => {
    assert.deepEqual(memorySelector('global'), { scope: 'global' })
    assert.deepEqual(memorySelector('session:chat:1'), { scope: 'project', session: 'chat:1' })
    assert.deepEqual(memorySelector('project:git:/repo/.git'), { scope: 'project', projectId: 'git:/repo/.git' })
    for (const value of ['', 'project:', 'session:', 'git:/repo/.git']) assert.throws(() => memorySelector(value))
  })

  it('labels exact .git metadata directories without stripping similarly named project folders', () => {
    assert.equal(memoryProjectLabel('git:/repo/.git'), 'repo')
    assert.equal(memoryProjectLabel('git:/repo/.git/'), 'repo')
    assert.equal(memoryProjectLabel('dir:/repo/agit'), 'agit')
    assert.equal(memoryProjectLabel('dir:/проект/папка'), 'папка')
  })

  it('preserves editable content and requires a fresh reason for an owner edit', () => {
    const draft = memoryDraft(record)
    assert.equal(draft.details, record.details)
    assert.equal(draft.reason, '')
    assert.equal(memoryDirty(draft, record), false)
    assert.ok(memoryDraftError(draft))
    draft.reason = 'Проверено человеком'
    assert.equal(memoryDirty(draft, record), true)
    assert.equal(memoryDraftError(draft), null)
    assert.equal(record.reason, 'Исходная причина')
  })

  it('counts Unicode code points at the API limits', () => {
    const draft = { ...memoryDraft(record), name: '🙂'.repeat(120), reason: 'Причина' }
    assert.equal(memoryDraftError(draft), null)
    assert.ok(memoryDraftError({ ...draft, name: draft.name + '🙂' }))
    assert.ok(memoryDraftError({ ...draft, summary: 'x'.repeat(501) }))
    assert.ok(memoryDraftError({ ...draft, details: 'x'.repeat(16001) }))
    assert.ok(memoryDraftError({ ...draft, reason: 'x'.repeat(1001) }))
  })

  it('builds a stable owner mutation with the read version and exact chosen context', () => {
    const selector = memorySelector('project:git:/repo/.git')
    const draft = { ...memoryDraft(record), pinned: true, reason: 'Закрепляю' }
    const request = memoryMutation('save', selector, record, draft, 'command-1')
    assert.equal(request.method, 'memory.update')
    assert.deepEqual(request.params, { ...selector, ...draft, commandId: 'command-1', id: 'm-1', expectedVersion: 7 })
    assert.deepEqual(memoryMutation('save', selector, record, draft, 'command-1'), request)
    const deletion = memoryMutation('forget', selector, record, draft, 'delete-1')
    assert.deepEqual(deletion, { method: 'memory.forget', params: { ...selector, commandId: 'delete-1', id: 'm-1', expectedVersion: 7, reason: 'Закрепляю' } })
    const created = memoryMutation('save', memorySelector('session:new-chat'), null, draft, 'add-1')
    assert.equal(created.method, 'memory.add')
    assert.equal('expectedVersion' in created.params, false)
    assert.equal('sourceSession' in created.params, false)
  })

  it('deduplicates paged rows without discarding newer copies', () => {
    assert.deepEqual(appendMemoryPage([{ id: 'a', version: 1 }], [{ id: 'a', version: 2 }, { id: 'b', version: 1 }], value => value.id), [{ id: 'a', version: 2 }, { id: 'b', version: 1 }])
  })
})
