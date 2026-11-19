import type { DaemonStatus } from '../../../src/core/rpc.js'
import type { RustFoundationParams, RustFoundationResults } from '../../../src/core/methodCatalog.js'
import { t } from '../lib/i18n.js'

export const MEMORY_METHODS = ['memory.projects', 'memory.list', 'memory.search', 'memory.get', 'memory.history', 'memory.add', 'memory.update', 'memory.forget'] as const
export const MEMORY_PAGE_SIZE = 20
export type MemoryRecord = RustFoundationResults['memory.get']
export type MemorySummary = RustFoundationResults['memory.list']['memories'][number]
export type MemoryProject = RustFoundationResults['memory.projects']['projects'][number]
export type MemorySelector = { scope: 'global' } | { scope: 'project'; session: string } | { scope: 'project'; projectId: string }
export interface MemoryDraft { name: string; summary: string; details: string; reason: string; pinned: boolean }
export type MemoryMutation =
  | { method: 'memory.add'; params: RustFoundationParams['memory.add'] & MemorySelector }
  | { method: 'memory.update'; params: RustFoundationParams['memory.update'] & MemorySelector }
  | { method: 'memory.forget'; params: RustFoundationParams['memory.forget'] & MemorySelector }

export function memoryAvailability(status: Pick<DaemonStatus, 'capabilities' | 'memory'> | null, online: boolean): { available: boolean; error: string | null } {
  if (!online) return { available: false, error: t('Для работы с памятью подключись к демону.') }
  const methods = status?.capabilities?.supportedMethods
  if (!methods || !MEMORY_METHODS.every(method => methods.includes(method))) {
    return { available: false, error: t('В этой версии демона общая память пока недоступна.') }
  }
  if (status?.memory && 'available' in status.memory && status.memory.available === false) {
    return { available: false, error: status.memory.error || t('Хранилище памяти недоступно.') }
  }
  return { available: true, error: null }
}

export function memorySelector(key: string): MemorySelector {
  if (key === 'global') return { scope: 'global' }
  if (key.startsWith('session:') && key.length > 8) return { scope: 'project', session: key.slice(8) }
  if (key.startsWith('project:') && key.length > 8) return { scope: 'project', projectId: key.slice(8) }
  throw new Error(t('Выбери область памяти.'))
}

export function memoryProjectLabel(id: string): string {
  const path = id.replace(/^(git|dir):/, '').replace(/\/\.git\/?$/, '').replace(/\/$/, '')
  return path.split('/').filter(Boolean).pop() || id
}

export function memoryDraft(record: MemoryRecord | null): MemoryDraft {
  return record ? { name: record.name, summary: record.summary, details: record.details, pinned: record.pinned, reason: '' }
    : { name: '', summary: '', details: '', pinned: false, reason: '' }
}

export function memoryDirty(draft: MemoryDraft, record: MemoryRecord | null): boolean {
  const initial = memoryDraft(record)
  return draft.name !== initial.name || draft.summary !== initial.summary || draft.details !== initial.details || draft.pinned !== initial.pinned || draft.reason !== ''
}

export function memoryDraftError(draft: MemoryDraft): string | null {
  for (const [value, label, limit, required] of [
    [draft.name, t('Название'), 120, true], [draft.summary, t('Краткое описание'), 500, true],
    [draft.details, t('Подробности'), 16000, false], [draft.reason, t('Причина изменения'), 1000, true],
  ] as const) {
    if (required && !value.trim()) return t`Заполни поле «${label}».`
    if ([...value].length > limit) return t`В поле «${label}» допустимо не более ${limit} символов.`
  }
  return null
}

export function memoryMutation(action: 'save' | 'forget', selector: MemorySelector, record: MemoryRecord | null, draft: MemoryDraft, commandId: string): MemoryMutation {
  if (action === 'forget') {
    if (!record) throw new Error(t('Сначала выбери запись.'))
    return { method: 'memory.forget', params: { ...selector, id: record.id, expectedVersion: record.version, commandId, reason: draft.reason } }
  }
  const fields = { name: draft.name, summary: draft.summary, details: draft.details, pinned: draft.pinned, reason: draft.reason, commandId }
  return record ? { method: 'memory.update', params: { ...selector, ...fields, id: record.id, expectedVersion: record.version } }
    : { method: 'memory.add', params: { ...selector, ...fields } }
}

/** Append pages without duplicate React identities while offsets count actual backend rows. */
export function appendMemoryPage<T>(before: readonly T[], page: readonly T[], key: (value: T) => string | number): T[] {
  const result = new Map(before.map(value => [key(value), value]))
  for (const value of page) result.set(key(value), value)
  return [...result.values()]
}
