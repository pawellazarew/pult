import type { SavedAttachment } from '../../../shell/src/contract.js'
import { quotePath } from './paths.js'
import type { DraftStore } from './drafts.js'
import { DRAFT_TTL_MS } from './drafts.js'

export const ATTACHMENT_DRAFT_KEY = 'pult.attachmentDrafts.v1'
export const MAX_ATTACHMENTS = 20
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export function attachmentPrompt(text: string, items: readonly SavedAttachment[]): string {
  if (!items.length) return text
  return [text.trim(), `Прикреплённые файлы:\n${items.map((a) => `- ${quotePath(a.path)}`).join('\n')}`].filter(Boolean).join('\n\n')
}

export function mergeAttachments(a: readonly SavedAttachment[], b: readonly SavedAttachment[]): SavedAttachment[] {
  return [...new Map([...a, ...b].map((v) => [v.path, v])).values()].slice(0, MAX_ATTACHMENTS)
}

export function readAttachmentDraft(store: DraftStore, session: string, now: number): SavedAttachment[] {
  try {
    const all = JSON.parse(store.get(ATTACHMENT_DRAFT_KEY) ?? '{}') as Record<string, { at: number; items: unknown[] }>
    const v = all[session]
    if (!v || !Number.isFinite(v.at) || now - v.at > DRAFT_TTL_MS || !Array.isArray(v.items)) return []
    return v.items.filter((x): x is SavedAttachment => {
      if (!x || typeof x !== 'object') return false
      const a = x as SavedAttachment
      return typeof a.path === 'string' && a.path.startsWith('/') && typeof a.name === 'string' && a.name.length < 512
        && typeof a.bytes === 'number' && a.bytes >= 0 && a.bytes <= MAX_ATTACHMENT_BYTES && typeof a.mime === 'string'
        && (a.kind === 'file' || a.kind === 'directory')
    }).slice(0, MAX_ATTACHMENTS)
  } catch { return [] }
}

export function saveAttachmentDraft(store: DraftStore, session: string, items: readonly SavedAttachment[], now: number): void {
  try {
    let all: Record<string, { at: number; items: readonly SavedAttachment[] }> = {}
    try { all = JSON.parse(store.get(ATTACHMENT_DRAFT_KEY) ?? '{}') as typeof all } catch { /* empty */ }
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {}
    if (items.length) all[session] = { at: now, items: items.map(({ path, name, bytes, mime, kind }) => ({ path, name, bytes, mime, kind })) }
    else delete all[session]
    const live = Object.entries(all).filter(([, v]) => v && Number.isFinite(v.at) && now - v.at <= DRAFT_TTL_MS)
      .sort((a, b) => b[1].at - a[1].at).slice(0, 50)
    store.set(ATTACHMENT_DRAFT_KEY, JSON.stringify(Object.fromEntries(live)))
  } catch { /* localStorage unavailable; current in-memory draft remains */ }
}

/** One owner per conversation: an import started in a closed view updates the currently open view too. */
export class AttachmentDraftOwner {
  pending = 0
  private queue = Promise.resolve()
  private listeners = new Set<() => void>()
  constructor(public items: SavedAttachment[], private persist: (items: SavedAttachment[]) => void) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { for (const listener of this.listeners) listener() }
  replace(items: SavedAttachment[]): void { this.items = items; this.persist(items); this.emit() }
  enqueue(job: () => Promise<void>, onError: (e: unknown) => void): void {
    this.pending++
    this.emit()
    this.queue = this.queue.then(job).catch(onError).finally(() => { this.pending--; this.emit() })
  }
  settled(): Promise<void> { return this.queue }
}
