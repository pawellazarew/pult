import { createHash, randomUUID } from 'node:crypto'
import { TemporaryChatError } from './types.js'
import type {
  TemporaryCapability, TemporaryChatService, TemporaryConfigureRequest, TemporaryDraftRequest, TemporaryErrorCode,
  TemporaryIdentity, TemporaryLimits, TemporaryListReply, TemporaryPromptReply, TemporaryPromptRequest,
  TemporaryReadReply, TemporaryReadRequest, TemporaryServiceOptions, TemporarySettings, TemporarySnapshot,
  TemporaryStartReply, TemporaryStartRequest, TemporarySummary, TemporaryTransport,
} from './types.js'
import {
  cleanupTemporaryWorkspaces, createTemporaryWorkspace, defaultTemporaryWorkspaceRoot,
  removeTemporaryWorkspace, validateTemporaryWorkspace,
} from './workspaces.js'

export const TEMPORARY_LIMITS: Readonly<TemporaryLimits> = Object.freeze({
  maxChats: 8, maxSnapshotBytes: 512 * 1024, maxTotalBytes: 4 * 1024 * 1024,
  maxTextBytes: 64 * 1024, maxStartReceipts: 1024, maxPromptReceipts: 128,
})
const RESERVE = 256 // Terminal status/error must fit even after refusing further output.
const CLOSE_MS = 2000
const ID_RE = /^temporary:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REQUEST_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const CODES = new Set<TemporaryErrorCode>([
  'invalid_params', 'temporary_expired', 'not_found', 'busy', 'draft_conflict', 'memory_limit',
  'provider_unavailable', 'unsupported_provider', 'blocked_network', 'interrupted', 'transport_closed',
  'internal', 'shutting_down', 'configure_locked',
])
type Receipt = { hash: string; reply: TemporaryPromptReply }
interface ActiveTurn {
  id: string
  controller: AbortController
  assistantId: string
  done: Promise<void>
  factoryStarted: boolean
}
interface Chat {
  snapshot: TemporarySnapshot
  receipts: Map<string, Receipt>
  requestId: string
  firstPrompt: boolean
  transport?: TemporaryTransport
  opening?: Promise<TemporaryTransport>
  cwd?: string
  active?: ActiveTurn
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const clone = <T>(value: T): T => structuredClone(value)
const error = (code: TemporaryErrorCode): TemporaryChatError => new TemporaryChatError(code)
function alive(transport?: TemporaryTransport): boolean {
  try { return transport?.alive === true } catch { return false }
}
function safeCode(value: unknown, fallback: TemporaryErrorCode): TemporaryErrorCode {
  try {
    const code = (value as { code?: unknown } | null)?.code
    return typeof code === 'string' && CODES.has(code as TemporaryErrorCode) ? code as TemporaryErrorCode : fallback
  } catch { return fallback }
}
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('invalid_params')
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) throw error('invalid_params')
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw error('invalid_params')
  return Object.assign(Object.create(null) as Record<string, unknown>, value)
}
function settingsOf(value: unknown): TemporarySettings {
  const p = fields(value, ['provider', 'model', 'effort', 'serviceTier'])
  if (p['provider'] !== 'claude' && p['provider'] !== 'codex') throw error('unsupported_provider')
  if (p['model'] !== undefined && (typeof p['model'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(p['model']))) throw error('invalid_params')
  if (p['effort'] !== undefined && (typeof p['effort'] !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(p['effort']))) throw error('invalid_params')
  if (p['serviceTier'] !== undefined && (p['provider'] !== 'codex' || !['default', 'fast'].includes(String(p['serviceTier'])))) throw error('invalid_params')
  return { provider: p['provider'], ...(p['model'] !== undefined ? { model: p['model'] as string } : {}),
    ...(p['effort'] !== undefined ? { effort: p['effort'] as string } : {}),
    ...(p['serviceTier'] !== undefined ? { serviceTier: p['serviceTier'] as 'default' | 'fast' } : {}) }
}
function requestKey(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_RE.test(value)) throw error('invalid_params')
  return value
}
async function settledWithin(promise: Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise.then(() => true, () => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), CLOSE_MS) })])
  } finally { clearTimeout(timer) }
}

export function createTemporaryChatService(options: TemporaryServiceOptions): TemporaryChatService {
  return new Service(options)
}

class Service implements TemporaryChatService {
  readonly epoch = randomUUID()
  private readonly chats = new Map<string, Chat>()
  private readonly starts = new Map<string, { signature: string; id: string }>()
  private readonly pendingStarts = new Map<string, { signature: string; promise: Promise<TemporaryStartReply> }>()
  private readonly endedStarts = new Set<string>()
  private readonly limits: TemporaryLimits
  private readonly root: string
  private readonly now: () => number
  private closing = false

  runningCount(): number { return [...this.chats.values()].filter((chat) => chat.active !== undefined).length }

  constructor(private readonly options: TemporaryServiceOptions) {
    this.limits = { ...TEMPORARY_LIMITS, ...options.limits }
    for (const [key, n] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(n) || n < 1 || n > TEMPORARY_LIMITS[key as keyof TemporaryLimits]) throw error('invalid_params')
    }
    this.root = options.workspaceRoot ?? defaultTemporaryWorkspaceRoot()
    this.now = options.now ?? Date.now
    cleanupTemporaryWorkspaces(this.root)
  }

  private epochOf(p: Record<string, unknown>): void {
    if (typeof p['epoch'] !== 'string') throw error('invalid_params')
    if (p['epoch'] !== this.epoch) throw error('temporary_expired')
    if (this.closing) throw error('shutting_down')
  }

  private get(p: Record<string, unknown>): Chat {
    this.epochOf(p)
    if (typeof p['id'] !== 'string' || !ID_RE.test(p['id'])) throw error('invalid_params')
    const chat = this.chats.get(p['id'])
    if (!chat) throw error('not_found')
    this.refreshClosed(chat)
    return chat
  }

  private summary(chat: Chat): TemporarySummary {
    const { id, title, settings, status, revision } = chat.snapshot
    return { id, title, settings: clone(settings), status, revision }
  }

  private refreshClosed(chat: Chat): void {
    if (!chat.active && chat.transport && !alive(chat.transport) && chat.snapshot.status !== 'closed') {
      chat.snapshot.status = 'closed'
      chat.snapshot.error = { code: 'transport_closed' }
      chat.snapshot.revision++
    }
  }

  private live(chat: Chat, active?: ActiveTurn): boolean {
    return this.chats.get(chat.snapshot.id) === chat && (!active || chat.active === active)
  }

  private fits(next: TemporarySnapshot, replacing?: Chat, extra = 0): boolean {
    if (bytes(next) + RESERVE > this.limits.maxSnapshotBytes) return false
    let total = bytes([...this.starts]) + bytes([...this.endedStarts]) + extra
    for (const chat of this.chats.values()) total += bytes(chat === replacing ? next : chat.snapshot) + bytes([...chat.receipts]) + RESERVE
    if (!replacing) total += bytes(next) + RESERVE
    return total <= this.limits.maxTotalBytes
  }

  private changed(chat: Chat, update: (next: TemporarySnapshot) => void, extra = 0): void {
    const next = clone(chat.snapshot)
    update(next)
    next.revision++
    if (!this.fits(next, chat, extra)) throw error('memory_limit')
    chat.snapshot = next
  }

  private text(value: unknown, blank: boolean): string {
    if (typeof value !== 'string' || (!blank && !value.trim())) throw error('invalid_params')
    if (Buffer.byteLength(value, 'utf8') > this.limits.maxTextBytes) throw error('memory_limit')
    return value
  }

  private async capabilities(): Promise<TemporaryCapability[]> {
    try {
      const values = await this.options.capabilities()
      return (['claude', 'codex'] as const).map((provider) => {
        const value = values.find((v) => v.provider === provider)
        const reasons = ['not_installed', 'unsupported_version', 'privacy_unverified', 'temporarily_unavailable']
        return { provider, available: value?.available === true,
          ...(value?.available === true ? {} : { reason: value?.reason && reasons.includes(value.reason) ? value.reason : 'privacy_unverified' as const }) }
      })
    } catch { return (['claude', 'codex'] as const).map((provider) => ({ provider, available: false, reason: 'temporarily_unavailable' })) }
  }

  async list(): Promise<TemporaryListReply> {
    if (this.closing) throw error('shutting_down')
    const capabilities = await this.capabilities()
    if (this.closing) throw error('shutting_down')
    for (const chat of this.chats.values()) this.refreshClosed(chat)
    return { epoch: this.epoch, chats: [...this.chats.values()].map((chat) => this.summary(chat)), capabilities }
  }

  start(request: TemporaryStartRequest): Promise<TemporaryStartReply> {
    const p = fields(request, ['epoch', 'requestId', 'provider', 'model', 'effort', 'serviceTier'])
    this.epochOf(p)
    const requestId = requestKey(p['requestId'])
    const settings = settingsOf(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'epoch' && k !== 'requestId')))
    const signature = JSON.stringify(settings)
    if (this.endedStarts.has(createHash('sha256').update(requestId).digest('hex'))) throw error('not_found')
    const old = this.starts.get(requestId)
    if (old) {
      if (old.signature !== signature) throw error('invalid_params')
      const chat = this.chats.get(old.id)
      if (!chat) throw error('not_found')
      this.refreshClosed(chat)
      return Promise.resolve({ snapshot: clone(chat.snapshot), duplicate: true })
    }
    const pending = this.pendingStarts.get(requestId)
    if (pending) {
      if (pending.signature !== signature) throw error('invalid_params')
      return pending.promise.then((reply) => {
        const current = this.chats.get(reply.snapshot.id)
        if (!current) throw error('not_found')
        return { snapshot: clone(current.snapshot), duplicate: true }
      })
    }
    if (this.starts.size + this.pendingStarts.size + this.endedStarts.size >= this.limits.maxStartReceipts
      || this.chats.size + this.pendingStarts.size >= this.limits.maxChats) throw error('memory_limit')
    const promise = this.finishStart(requestId, settings, signature)
    this.pendingStarts.set(requestId, { signature, promise })
    void promise.finally(() => { this.pendingStarts.delete(requestId) }).catch(() => {})
    return promise
  }

  private async finishStart(requestId: string, settings: TemporarySettings, signature: string): Promise<TemporaryStartReply> {
    const caps = await this.capabilities()
    if (this.closing) throw error('shutting_down')
    if (!caps.some((c) => c.provider === settings.provider && c.available)) throw error('provider_unavailable')
    if (this.chats.size >= this.limits.maxChats || this.starts.size + this.endedStarts.size >= this.limits.maxStartReceipts) throw error('memory_limit')
    const snapshot: TemporarySnapshot = { epoch: this.epoch, id: `temporary:${randomUUID()}`, title: 'Временный чат', settings,
      status: 'idle', revision: 1, messages: [], draft: { revision: 0, text: '' } }
    const receipt = { signature, id: snapshot.id }
    if (!this.fits(snapshot, undefined, bytes([requestId, receipt]))) throw error('memory_limit')
    this.chats.set(snapshot.id, { snapshot, requestId, firstPrompt: false, receipts: new Map() })
    this.starts.set(requestId, receipt)
    return { snapshot: clone(snapshot), duplicate: false }
  }

  read(request: TemporaryReadRequest): TemporaryReadReply {
    const p = fields(request, ['epoch', 'id', 'ifRevision']), chat = this.get(p)
    if (p['ifRevision'] !== undefined && (!Number.isSafeInteger(p['ifRevision']) || Number(p['ifRevision']) < 0)) throw error('invalid_params')
    const { id, revision } = chat.snapshot
    return p['ifRevision'] === revision ? { epoch: this.epoch, id, revision, unchanged: true }
      : { epoch: this.epoch, id, revision, unchanged: false, snapshot: clone(chat.snapshot) }
  }

  draft(request: TemporaryDraftRequest): TemporarySnapshot {
    const p = fields(request, ['epoch', 'id', 'text', 'baseDraftRevision']), chat = this.get(p)
    if (chat.snapshot.status === 'closed') throw error('transport_closed')
    const text = this.text(p['text'], true)
    if (!Number.isSafeInteger(p['baseDraftRevision']) || Number(p['baseDraftRevision']) < 0) throw error('invalid_params')
    if (p['baseDraftRevision'] !== chat.snapshot.draft.revision) throw new TemporaryChatError('draft_conflict', chat.snapshot.draft.revision)
    if (text !== chat.snapshot.draft.text) this.changed(chat, (s) => { s.draft = { text, revision: s.draft.revision + 1 } })
    return clone(chat.snapshot)
  }

  async configure(request: TemporaryConfigureRequest): Promise<TemporarySnapshot> {
    const p = fields(request, ['epoch', 'id', 'settings']), chat = this.get(p), settings = settingsOf(p['settings'])
    if (chat.firstPrompt) throw error('configure_locked')
    if (!(await this.capabilities()).some((c) => c.provider === settings.provider && c.available)) throw error('provider_unavailable')
    if (!this.live(chat)) throw error('not_found')
    if (chat.firstPrompt) throw error('configure_locked')
    this.changed(chat, (s) => { s.settings = settings })
    return clone(chat.snapshot)
  }

  workspaceFor(id: string): string {
    const chat = this.chats.get(id)
    if (!chat?.cwd) throw error('not_found')
    validateTemporaryWorkspace(this.root, chat.cwd)
    return chat.cwd
  }

  prompt(request: TemporaryPromptRequest): TemporaryPromptReply {
    const p = fields(request, ['epoch', 'id', 'clientMessageId', 'text']), chat = this.get(p)
    const clientMessageId = requestKey(p['clientMessageId']), text = this.text(p['text'], false)
    const hash = createHash('sha256').update(text).digest('hex'), old = chat.receipts.get(clientMessageId)
    if (old) {
      if (old.hash !== hash) throw error('invalid_params')
      return { ...old.reply, revision: chat.snapshot.revision, duplicate: true }
    }
    if (chat.snapshot.status === 'closed') throw error('transport_closed')
    if (chat.active) throw error('busy')
    if (chat.receipts.size >= this.limits.maxPromptReceipts) throw error('memory_limit')
    const turnId = randomUUID(), assistantId = randomUUID(), at = new Date(this.now()).toISOString()
    const reply: TemporaryPromptReply = { epoch: this.epoch, id: chat.snapshot.id, turnId, revision: chat.snapshot.revision + 1, duplicate: false }
    this.changed(chat, (s) => {
      delete s.error
      s.status = 'starting'
      if (s.draft.text === text) s.draft = { text: '', revision: s.draft.revision + 1 }
      s.messages.push({ id: randomUUID(), turnId, role: 'user', text, at, state: 'done' },
        { id: assistantId, turnId, role: 'assistant', text: '', at, state: 'streaming' })
    }, bytes([clientMessageId, { hash, reply }]))
    chat.receipts.set(clientMessageId, { hash, reply })
    chat.firstPrompt = true
    const active: ActiveTurn = { id: turnId, assistantId, controller: new AbortController(), factoryStarted: false, done: Promise.resolve() }
    chat.active = active
    active.done = Promise.resolve().then(() => this.runTurn(chat, active, text)).catch(() => {})
    return clone(reply)
  }

  private terminal(chat: Chat, active: ActiveTurn, code?: TemporaryErrorCode, forceClosed = false): void {
    if (!this.live(chat, active)) return
    const interrupted = active.controller.signal.aborted && code !== 'memory_limit'
    const closed = forceClosed || (chat.transport ? !alive(chat.transport) : active.factoryStarted)
    const finalCode = code ?? (closed ? 'transport_closed' : undefined)
    const s = chat.snapshot
    s.status = closed ? 'closed' : interrupted ? 'interrupted' : finalCode ? 'failed' : 'idle'
    if (finalCode) s.error = { code: finalCode }; else delete s.error
    const message = s.messages.find((m) => m.id === active.assistantId)
    if (message) message.state = interrupted ? 'interrupted' : finalCode ? 'failed' : 'done'
    s.revision++
    chat.active = undefined
  }

  private async runTurn(chat: Chat, active: ActiveTurn, text: string): Promise<void> {
    try {
      if (!this.live(chat, active) || active.controller.signal.aborted) { this.terminal(chat, active, 'interrupted'); return }
      await this.options.beforeTurn(chat.snapshot.settings.provider, chat.snapshot.id)
      if (!this.live(chat, active) || active.controller.signal.aborted) { this.terminal(chat, active, 'interrupted'); return }
      if (!chat.transport) {
        chat.cwd = createTemporaryWorkspace(this.root)
        active.factoryStarted = true
        chat.opening = this.options.factory(clone(chat.snapshot.settings), chat.snapshot.id)
        const transport = await chat.opening
        chat.opening = undefined
        if (!this.live(chat, active) || active.controller.signal.aborted) {
          await this.close(transport)
          this.terminal(chat, active, 'interrupted')
          return
        }
        chat.transport = transport
        // Capability checks/process setup may await. Recheck the current route/update gate before
        // the first private byte, without recreating a transport if the pinned route changed.
        await this.options.beforeTurn(chat.snapshot.settings.provider, chat.snapshot.id)
        if (!this.live(chat, active) || active.controller.signal.aborted) { this.terminal(chat, active, 'interrupted'); return }
      }
      active.factoryStarted = true
      if (!alive(chat.transport)) throw error('transport_closed')
      this.changed(chat, (s) => { s.status = 'working' })
      await chat.transport.run(text, (delta) => {
        if (!this.live(chat, active) || active.controller.signal.aborted || typeof delta !== 'string' || !delta) return
        try {
          this.changed(chat, (s) => { const m = s.messages.find((m) => m.id === active.assistantId); if (m) m.text += delta })
        } catch {
          // Invalidate the producer immediately; never retain or echo the refused chunk.
          active.controller.abort()
          this.terminal(chat, active, 'memory_limit', true)
          void this.close(chat.transport)
        }
      }, active.controller.signal)
      this.terminal(chat, active, active.controller.signal.aborted ? 'interrupted' : undefined)
    } catch (e) {
      this.terminal(chat, active, active.controller.signal.aborted ? 'interrupted' : safeCode(e, 'provider_unavailable'))
    }
  }

  private async close(transport?: TemporaryTransport): Promise<void> {
    if (transport) await settledWithin(Promise.resolve().then(() => transport.close()))
  }

  async stop(request: TemporaryIdentity): Promise<TemporarySnapshot> {
    const p = fields(request, ['epoch', 'id']), chat = this.get(p), active = chat.active
    if (!active) return clone(chat.snapshot)
    active.controller.abort()
    // Cancellation consumes the reserved terminal space and must never fail due to a full transcript.
    chat.snapshot.status = 'stopping'
    chat.snapshot.revision++
    if (!active.factoryStarted) {
      // A pending network check has not touched the provider and need not delay cancellation.
      this.terminal(chat, active, 'interrupted')
      return clone(chat.snapshot)
    }
    if (!(await settledWithin(active.done)) && this.live(chat, active)) {
      chat.active = undefined
      await this.close(chat.transport)
      if (this.live(chat)) {
        chat.snapshot.status = active.factoryStarted ? 'closed' : 'interrupted'
        chat.snapshot.error = { code: active.factoryStarted ? 'transport_closed' : 'interrupted' }
        const m = chat.snapshot.messages.find((m) => m.id === active.assistantId)
        if (m) m.state = 'interrupted'
        chat.snapshot.revision++
      }
    }
    if (!this.live(chat)) throw error('not_found')
    this.refreshClosed(chat)
    return clone(chat.snapshot)
  }

  async remove(request: TemporaryIdentity): Promise<{ removed: boolean }> {
    const p = fields(request, ['epoch', 'id'])
    this.epochOf(p)
    if (typeof p['id'] !== 'string' || !ID_RE.test(p['id'])) throw error('invalid_params')
    const chat = this.chats.get(p['id'])
    if (!chat) return { removed: false }
    this.chats.delete(chat.snapshot.id)
    this.endedStarts.add(createHash('sha256').update(chat.requestId).digest('hex'))
    this.starts.delete(chat.requestId)
    chat.active?.controller.abort()
    chat.active = undefined
    // Drop private strings before any asynchronous provider cleanup.
    chat.snapshot.messages.length = 0
    chat.snapshot.draft.text = ''
    chat.receipts.clear()
    const transport = chat.transport, opening = chat.opening, cwd = chat.cwd
    chat.transport = undefined
    chat.opening = undefined
    chat.cwd = undefined
    if (opening) void opening.then((t) => this.close(t), () => {})
    await this.close(transport)
    if (cwd) removeTemporaryWorkspace(this.root, cwd)
    return { removed: true }
  }

  async shutdown(): Promise<void> {
    if (this.closing) return
    const requests = [...this.chats.keys()].map((id) => ({ epoch: this.epoch, id }))
    // remove synchronously invalidates every chat before its first await.
    const removals = requests.map((request) => this.remove(request))
    this.closing = true
    this.pendingStarts.clear()
    await Promise.allSettled(removals)
    this.starts.clear()
    this.endedStarts.clear()
    cleanupTemporaryWorkspaces(this.root)
  }
}
