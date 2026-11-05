import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { PultBridge } from '../../shell/src/contract.js'
import type { TemporaryConfigureRequest, TemporaryDraftRequest, TemporaryIdentity, TemporaryListReply, TemporaryPromptReply, TemporaryPromptRequest, TemporaryReadReply, TemporarySettings, TemporarySnapshot, TemporaryStartReply } from '../../src/temporary/types.js'

interface ClientFailure { code: string }
interface ClientView {
  listing: TemporaryListReply | null
  snapshots: Record<string, TemporarySnapshot>
  activeId: string | null
  error: ClientFailure | null
  starting: boolean
}
const SAFE_CODES = new Set(['invalid_params', 'temporary_expired', 'not_found', 'busy', 'draft_conflict', 'memory_limit',
  'provider_unavailable', 'unsupported_provider', 'blocked_network', 'interrupted', 'transport_closed', 'internal',
  'shutting_down', 'configure_locked', 'method_not_allowed', 'method_not_found', 'no_daemon', 'disconnected'])
const METHOD_MISSING = new Set(['method_not_allowed', 'method_not_found', 'not_found'])
function codeOf(failure: unknown): string {
  try {
    const code = failure && typeof failure === 'object' ? (failure as { code?: unknown }).code : undefined
    return typeof code === 'string' && SAFE_CODES.has(code) ? code : 'internal'
  } catch { return 'internal' }
}
const expired = (): ClientFailure => ({ code: 'temporary_expired' })

/** Authoritative client state lives only in RAM. Also exercised against a delayed RPC bridge. */
export class TemporaryChatsClient {
  private view: ClientView = { listing: null, snapshots: {}, activeId: null, error: null, starting: false }
  private readonly listeners = new Set<() => void>()
  private epoch: string | null = null
  private readonly removed = new Set<string>()
  /** Failed End operations retain only identities, never a transcript or draft. */
  private readonly pendingDeletes = new Map<string, TemporaryIdentity>()
  private readonly deleteFlights = new Map<string, Promise<void>>()
  private baseError: ClientFailure | null = null
  private listSerial = 0
  private online = false
  private supported = true
  private pollGeneration = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private startFlight = false
  private pendingStart: { epoch: string; shape: string; requestId: string } | null = null

  constructor(private readonly bridge: Pick<PultBridge, 'call'>) {}
  getSnapshot = (): ClientView => this.view
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private publish(patch: Partial<ClientView> = {}): void {
    this.view = { ...this.view, ...patch, error: this.pendingDeletes.size ? { code: 'delete_unconfirmed' } : this.baseError }
    for (const listener of this.listeners) listener()
  }
  clearError = (): void => { this.baseError = null; this.publish() }

  activate = (id: string | null): void => {
    if (id && this.removed.has(id)) return
    this.baseError = null
    this.publish({ activeId: id })
    if (id && this.epoch && this.online) void this.read({ epoch: this.epoch, id }).catch((failure) => {
      if (this.view.activeId === id) { this.baseError = { code: codeOf(failure) }; this.publish() }
    })
  }

  setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    ++this.listSerial
    const generation = ++this.pollGeneration
    clearTimeout(this.timer)
    if (!online) return
    this.supported = true
    void this.poll(generation)
  }
  private async poll(generation: number): Promise<void> {
    try { await this.refresh() } catch (failure) {
      if (generation !== this.pollGeneration || !this.online) return
      if (this.view.activeId) { this.baseError = { code: codeOf(failure) }; this.publish() }
    }
    if (generation === this.pollGeneration && this.online && this.supported) {
      this.timer = setTimeout(() => { void this.poll(generation) }, this.view.activeId ? 400 : 1800)
    }
  }

  private applySnapshot(snapshot: TemporarySnapshot): TemporarySnapshot {
    if (snapshot.epoch !== this.epoch || this.removed.has(snapshot.id)) throw expired()
    const previous = this.view.snapshots[snapshot.id]
    if (previous && snapshot.revision < previous.revision) return previous
    this.publish({ snapshots: { ...this.view.snapshots, [snapshot.id]: snapshot } })
    return snapshot
  }
  private forget(id: string, notify: boolean): void {
    this.removed.add(id)
    const snapshots = { ...this.view.snapshots }; delete snapshots[id]
    const listing = this.view.listing ? { ...this.view.listing, chats: this.view.listing.chats.filter((chat) => chat.id !== id) } : null
    if (notify && this.view.activeId === id) this.baseError = expired()
    this.publish({ snapshots, listing, ...(this.view.activeId === id ? { activeId: null } : {}) })
  }
  private async read(identity: TemporaryIdentity, force = false): Promise<TemporarySnapshot> {
    if (identity.epoch !== this.epoch || this.removed.has(identity.id)) throw expired()
    try {
      const previous = this.view.snapshots[identity.id]
      const reply = await this.bridge.call('temporary.read', { ...identity, ...(!force && previous ? { ifRevision: previous.revision } : {}) }) as TemporaryReadReply
      if (identity.epoch !== this.epoch || this.removed.has(identity.id)) throw expired()
      if (!reply.unchanged) return this.applySnapshot(reply.snapshot)
      const current = this.view.snapshots[identity.id]
      if (!current) throw expired()
      return current
    } catch (failure) {
      const code = codeOf(failure)
      if (identity.epoch === this.epoch && !this.removed.has(identity.id) && (code === 'not_found' || code === 'temporary_expired')) {
        this.forget(identity.id, true)
        // Another owner can End between list and read; that does not remove the RPC method.
        if (this.online) void this.refresh().catch(() => {})
      }
      throw { code }
    }
  }

  refresh = async (): Promise<TemporaryListReply | null> => {
    const serial = ++this.listSerial
    let next: TemporaryListReply
    try { next = await this.bridge.call('temporary.list') as TemporaryListReply } catch (failure) {
      if (serial === this.listSerial && METHOD_MISSING.has(codeOf(failure))) {
        // Only LIST failure establishes that this daemon lacks the namespace.
        this.supported = false
        this.baseError = { code: 'provider_unavailable' }
        this.publish({ listing: null, snapshots: {}, activeId: null })
      }
      throw { code: codeOf(failure) }
    }
    if (serial !== this.listSerial) return null
    if (this.epoch !== null && next.epoch !== this.epoch) {
      this.removed.clear()
      this.pendingDeletes.clear()
      this.deleteFlights.clear()
      this.pendingStart = null
      this.baseError = this.view.activeId ? expired() : null
      this.publish({ snapshots: {}, activeId: null })
    }
    this.epoch = next.epoch
    for (const identity of this.pendingDeletes.values()) if (identity.epoch === next.epoch) void this.performDelete(identity).catch(() => {})
    const chats = next.chats.filter((chat) => !this.removed.has(chat.id))
    const present = new Set(chats.map((chat) => chat.id))
    const snapshots = Object.fromEntries(Object.entries(this.view.snapshots).filter(([id]) => present.has(id)))
    const id = this.view.activeId
    this.publish({ listing: { ...next, chats }, snapshots })
    if (id && !present.has(id)) this.forget(id, true)
    else if (id) await this.read({ epoch: next.epoch, id })
    return next
  }

  start = async (settings: TemporarySettings = { provider: 'claude' }): Promise<void> => {
    if (this.startFlight || !this.online) return
    this.startFlight = true
    this.baseError = null
    this.publish({ starting: true })
    try {
      if (!this.epoch) await this.refresh()
      const epoch = this.epoch
      if (!epoch) throw { code: 'internal' }
      const canonical = { provider: settings.provider, model: settings.model, effort: settings.effort, serviceTier: settings.serviceTier }
      const shape = JSON.stringify(canonical)
      if (this.pendingStart?.epoch !== epoch || this.pendingStart.shape !== shape) this.pendingStart = { epoch, shape, requestId: crypto.randomUUID() }
      const reply = await this.bridge.call('temporary.start', { ...canonical, epoch, requestId: this.pendingStart.requestId }) as TemporaryStartReply
      if (reply.snapshot.epoch !== this.epoch || this.removed.has(reply.snapshot.id)) throw expired()
      ++this.listSerial
      this.pendingStart = null
      this.applySnapshot(reply.snapshot)
      const { id, title, settings: chosen, status, revision } = reply.snapshot
      const listing = this.view.listing?.epoch === reply.snapshot.epoch ? { ...this.view.listing,
        chats: [...this.view.listing.chats.filter((chat) => chat.id !== id), { id, title, settings: chosen, status, revision }] } : this.view.listing
      this.baseError = null
      this.publish({ activeId: id, listing })
    } catch (failure) { this.baseError = { code: codeOf(failure) }; this.publish() }
    finally { this.startFlight = false; this.publish({ starting: false }) }
  }

  draft = async (request: TemporaryDraftRequest): Promise<TemporarySnapshot> => {
    if (request.epoch !== this.epoch || this.removed.has(request.id)) throw expired()
    try { return this.applySnapshot(await this.bridge.call('temporary.draft', { ...request }) as TemporarySnapshot) }
    catch (failure) { if (this.online) void this.refresh().catch(() => {}); throw { code: codeOf(failure) } }
  }
  configure = async (request: TemporaryConfigureRequest): Promise<TemporarySnapshot> => {
    if (request.epoch !== this.epoch || this.removed.has(request.id)) throw expired()
    return this.applySnapshot(await this.bridge.call('temporary.configure', { ...request }) as TemporarySnapshot)
  }
  prompt = async (request: TemporaryPromptRequest): Promise<TemporarySnapshot> => {
    if (request.epoch !== this.epoch || this.removed.has(request.id)) throw expired()
    await this.bridge.call('temporary.prompt', { ...request }) as TemporaryPromptReply
    return this.read(request, true)
  }
  stop = async (identity: TemporaryIdentity): Promise<TemporarySnapshot> => {
    if (identity.epoch !== this.epoch || this.removed.has(identity.id)) throw expired()
    return this.applySnapshot(await this.bridge.call('temporary.stop', { ...identity }) as TemporarySnapshot)
  }

  private performDelete(identity: TemporaryIdentity): Promise<void> {
    const previous = this.deleteFlights.get(identity.id)
    if (previous) return previous
    const pending = this.pendingDeletes.get(identity.id)
    if (!pending || pending.epoch !== this.epoch) return Promise.resolve()
    const work = Promise.resolve().then(async () => {
      try {
        await this.bridge.call('temporary.remove', { ...identity })
        if (this.epoch !== identity.epoch || this.pendingDeletes.get(identity.id) !== pending) return
        this.pendingDeletes.delete(identity.id)
        this.publish()
      } catch {
        if (this.epoch === identity.epoch && this.pendingDeletes.get(identity.id) === pending) this.publish()
        throw { code: 'delete_unconfirmed' }
      }
    }).finally(() => { if (this.deleteFlights.get(identity.id) === work) this.deleteFlights.delete(identity.id) })
    this.deleteFlights.set(identity.id, work)
    return work
  }
  remove = async (identity: TemporaryIdentity): Promise<void> => {
    if (identity.epoch !== this.epoch) throw expired()
    // Erase and tombstone before IPC/network/provider cleanup can await.
    this.pendingDeletes.set(identity.id, this.pendingDeletes.get(identity.id) ?? { epoch: identity.epoch, id: identity.id })
    this.pendingStart = null
    this.baseError = null
    this.forget(identity.id, false)
    await this.performDelete(identity)
  }
}

/** A separate RAM-only hook. Never pass its ids/content to saved state or browser storage. */
export function useTemporaryChats(bridge: PultBridge, online: boolean) {
  const client = useMemo(() => new TemporaryChatsClient(bridge), [bridge])
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  useEffect(() => { client.setOnline(online); return () => client.setOnline(false) }, [client, online])
  return { listing: view.listing, activeId: view.activeId, snapshot: view.activeId ? view.snapshots[view.activeId] ?? null : null,
    error: view.error, starting: view.starting, activate: client.activate, start: client.start, draft: client.draft,
    configure: client.configure, prompt: client.prompt, stop: client.stop, remove: client.remove, clearError: client.clearError }
}
