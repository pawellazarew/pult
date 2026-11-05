import type { TemporaryDraftRequest, TemporaryErrorCode, TemporaryIdentity, TemporarySnapshot, TemporaryStatus } from '../../../src/temporary/types.js'
import type { Block, Inline } from './markdown.js'
import { parseMarkdown, safeHref } from './markdown.js'
import { t } from '../lib/i18n.js'

const ERROR_CODES = new Set<TemporaryErrorCode>(['invalid_params', 'temporary_expired', 'not_found', 'busy', 'draft_conflict', 'memory_limit', 'provider_unavailable', 'unsupported_provider', 'blocked_network', 'interrupted', 'transport_closed', 'internal', 'shutting_down', 'configure_locked'])

/** Never turn provider exceptions, stderr or prompt-bearing errors into UI text. */
export function temporaryErrorCode(error: unknown): TemporaryErrorCode {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null
  return typeof code === 'string' && ERROR_CODES.has(code as TemporaryErrorCode) ? code as TemporaryErrorCode : 'internal'
}

export function temporaryBusy(status: TemporaryStatus): boolean {
  return status === 'starting' || status === 'working' || status === 'stopping'
}

export function temporaryErrorMessage(error: unknown): string {
  const clientCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : null
  if (clientCode === 'delete_unconfirmed') return t('Mac не подтвердил удаление. Запрос будет повторён, пока это окно открыто.')
  if (clientCode === 'draft_changed') return t('Черновик изменился в другом окне. Проверь текст перед отправкой.')
  switch (temporaryErrorCode(error)) {
    case 'temporary_expired': case 'not_found': return t('Временный чат завершён или исчез после перезапуска демона.')
    case 'draft_conflict': return t('Черновик изменился в другом окне. Выбери, какой текст оставить.')
    case 'memory_limit': return t('Достигнут лимит памяти временных чатов. Заверши один из них или сократи текст.')
    case 'provider_unavailable': case 'unsupported_provider': return t('Этот провайдер пока недоступен для временных чатов.')
    case 'blocked_network': return t('Страж сети не разрешил отправку. Проверь подключение в настройках.')
    case 'busy': return t('Дождись ответа или останови его перед новой отправкой.')
    case 'configure_locked': return t('Параметры временного чата можно менять до первой реплики.')
    case 'interrupted': return t('Ответ остановлен.')
    case 'transport_closed': return t('Связь с провайдером закрылась. Начни новый временный чат.')
    case 'shutting_down': return t('Демон завершает работу. Временный чат не будет восстановлен.')
    default: return t('Временный чат недоступен. Попробуй ещё раз.')
  }
}

/** Receipts are scoped to one daemon chat. An acknowledged draft revision survives renderer remounts. */
export function temporaryPromptId(acknowledgedDraftRevision: number): string {
  return `draft:${acknowledgedDraftRevision}`
}

export interface TemporaryDraftView {
  text: string
  revision: number
  dirty: boolean
  conflict: boolean
  remoteReady: boolean
  error: TemporaryErrorCode | null
  expired: boolean
}

export type TemporaryDraftWriter = (request: TemporaryDraftRequest) => Promise<TemporarySnapshot>

/** A RAM-only editing buffer. One write at a time; later keystrokes coalesce without overwriting remote edits. */
export class TemporaryDraftBuffer {
  private view: TemporaryDraftView
  private remote: TemporarySnapshot['draft']
  private readonly identity: TemporaryIdentity
  private readonly listeners = new Set<() => void>()
  private running: Promise<void> | null = null
  private inFlight: { text: string; revision: number } | null = null
  private online = true
  private writer: TemporaryDraftWriter

  constructor(snapshot: TemporarySnapshot, writer: TemporaryDraftWriter) {
    this.identity = { epoch: snapshot.epoch, id: snapshot.id }
    this.remote = snapshot.status === 'closed' ? { text: '', revision: snapshot.draft.revision } : { ...snapshot.draft }
    this.writer = writer
    this.view = { ...this.remote, dirty: false, conflict: false, remoteReady: true, error: snapshot.status === 'closed' ? 'temporary_expired' : null, expired: snapshot.status === 'closed' }
  }

  getSnapshot = (): TemporaryDraftView => this.view
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  setWriter(writer: TemporaryDraftWriter): void { this.writer = writer }

  private update(patch: Partial<TemporaryDraftView>): void {
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener()
  }

  setOnline(online: boolean): void {
    this.online = online
    if (this.view.expired) return
    if (online && this.view.error !== 'draft_conflict') {
      if (this.view.error) this.update({ error: null })
      void this.flush()
    }
  }

  edit(text: string): void {
    if (this.view.expired) return
    this.update({ text, dirty: text !== this.remote.text, error: this.view.conflict ? 'draft_conflict' : null })
    void this.flush()
  }

  observe(snapshot: TemporarySnapshot): void {
    if (snapshot.epoch !== this.identity.epoch || snapshot.id !== this.identity.id || snapshot.status === 'closed') {
      this.expire()
      return
    }
    if (this.view.expired || snapshot.draft.revision < this.remote.revision) return
    const incoming = snapshot.draft
    if (incoming.revision === this.remote.revision && incoming.text === this.remote.text) return
    const ownWrite = this.inFlight && incoming.revision === this.inFlight.revision + 1 && incoming.text === this.inFlight.text
    this.remote = { ...incoming }
    if (!this.view.dirty || incoming.text === this.view.text) {
      this.update({ ...incoming, dirty: false, conflict: false, remoteReady: true, error: null })
    } else if (ownWrite) {
      this.update({ revision: incoming.revision })
    } else {
      this.update({ revision: incoming.revision, conflict: true, remoteReady: true, error: 'draft_conflict' })
    }
  }

  useRemote(): void {
    if (!this.view.expired && this.view.remoteReady) this.update({ ...this.remote, dirty: false, conflict: false, error: null })
  }

  keepLocal(): void {
    if (this.view.expired || !this.view.remoteReady) return
    this.update({ revision: this.remote.revision, dirty: this.view.text !== this.remote.text, conflict: false, error: null })
    void this.flush()
  }

  expire(): void {
    this.remote = { text: '', revision: 0 }
    this.update({ text: '', revision: 0, dirty: false, conflict: false, remoteReady: true, error: 'temporary_expired', expired: true })
  }

  /** Also used on navigation/pagehide; deliberately has no destroy/remove side effect. */
  async flush(): Promise<void> {
    if (this.running) return this.running
    if (!this.online || this.view.expired || this.view.conflict || !this.view.dirty) return
    const task = this.drain()
    this.running = task
    try { await task } finally {
      if (this.running === task) this.running = null
      if (this.view.dirty && !this.view.error && !this.view.conflict && !this.view.expired && this.online) void this.flush()
    }
  }

  private async drain(): Promise<void> {
    while (this.online && !this.view.expired && !this.view.conflict && this.view.dirty) {
      const sent = { text: this.view.text, revision: this.remote.revision }
      this.inFlight = sent
      try {
        const snapshot = await this.writer({ ...this.identity, text: sent.text, baseDraftRevision: sent.revision })
        if (this.view.expired) return
        this.observe(snapshot)
        if (this.view.conflict) return
        if (snapshot.draft.revision < this.remote.revision) continue
        if (snapshot.draft.text !== sent.text) {
          this.update({ conflict: true, error: 'draft_conflict' })
          return
        }
        this.update({ revision: this.remote.revision, dirty: this.view.text !== this.remote.text, error: null })
      } catch (error) {
        if (this.view.expired) return
        const code = temporaryErrorCode(error)
        if (code === 'temporary_expired' || code === 'not_found') this.expire()
        else this.update({ error: code, conflict: code === 'draft_conflict' || this.view.conflict, ...(code === 'draft_conflict' ? { remoteReady: this.remote.revision > sent.revision } : {}) })
        return
      } finally { this.inFlight = null }
    }
  }
}

function textInline(parts: readonly Inline[]): string {
  return parts.map((part) => part.t === 'text' || part.t === 'code' ? part.v : part.t === 'br' ? '\n' : part.t === 'file' ? part.path : part.t === 'image' ? part.alt || part.url : textInline(part.c)).join('')
}

/** Keep ordinary formatting, but remove every local file/image capability from the render tree. */
export function temporaryInlines(parts: readonly Inline[]): Inline[] {
  return parts.map((part): Inline => {
    if (part.t === 'file') return { t: 'text', v: part.path }
    if (part.t === 'image') return { t: 'text', v: part.alt || part.url }
    if (part.t === 'link') {
      const href = safeHref(part.url)
      return href ? { ...part, href, c: temporaryInlines(part.c) } : { t: 'text', v: textInline(part.c) || part.url }
    }
    if (part.t === 'bold' || part.t === 'em' || part.t === 'del') return { ...part, c: temporaryInlines(part.c) }
    return part
  })
}

function temporaryBlock(block: Block): Block {
  switch (block.t) {
    case 'h': case 'p': return { ...block, v: temporaryInlines(block.v) }
    case 'quote': return { ...block, c: block.c.map(temporaryBlock) }
    case 'list': return { ...block, items: block.items.map((item) => ({ ...item, c: item.c.map(temporaryBlock) })) }
    case 'table': return { ...block, head: block.head.map(temporaryInlines), rows: block.rows.map((row) => row.map(temporaryInlines)) }
    default: return block
  }
}

export function temporaryMarkdown(text: string, human = false): Block[] {
  return parseMarkdown(text, { human }).map(temporaryBlock)
}
