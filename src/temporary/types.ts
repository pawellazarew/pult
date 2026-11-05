/** Temporary chat data is RAM-only. These types never enter the saved-session/event pipeline. */
export type TemporaryProvider = 'claude' | 'codex'

export interface TemporarySettings {
  provider: TemporaryProvider
  model?: string
  effort?: string
  serviceTier?: 'default' | 'fast'
}

export type TemporaryStatus = 'idle' | 'starting' | 'working' | 'stopping' | 'interrupted' | 'failed' | 'closed'
export type TemporaryErrorCode =
  | 'invalid_params' | 'temporary_expired' | 'not_found' | 'busy' | 'draft_conflict'
  | 'memory_limit' | 'provider_unavailable' | 'unsupported_provider' | 'blocked_network'
  | 'interrupted' | 'transport_closed' | 'internal' | 'shutting_down' | 'configure_locked'

export interface TemporaryFailure { code: TemporaryErrorCode }
/** Safe across RPC/logging boundaries: message is always a fixed code, never provider text. */
export class TemporaryChatError extends Error {
  constructor(readonly code: TemporaryErrorCode, readonly currentDraftRevision?: number) {
    super(code)
    this.name = 'TemporaryChatError'
  }
}
export interface TemporaryCapability {
  provider: TemporaryProvider
  available: boolean
  reason?: 'not_installed' | 'unsupported_version' | 'privacy_unverified' | 'temporarily_unavailable'
}

export interface TemporaryMessage {
  id: string
  turnId: string
  role: 'user' | 'assistant'
  text: string
  at: string
  state: 'streaming' | 'done' | 'interrupted' | 'failed'
}

export interface TemporarySummary {
  id: string
  /** Fixed label; UI translates it. Never derive a title from private text. */
  title: 'Временный чат'
  settings: TemporarySettings
  status: TemporaryStatus
  revision: number
}

export interface TemporarySnapshot extends TemporarySummary {
  epoch: string
  messages: TemporaryMessage[]
  draft: { revision: number; text: string }
  error?: TemporaryFailure
}

export interface TemporaryListReply {
  epoch: string
  chats: TemporarySummary[]
  capabilities: TemporaryCapability[]
}

export interface TemporaryIdentity { epoch: string; id: string }
export interface TemporaryStartRequest extends TemporarySettings { epoch: string; requestId: string }
export interface TemporaryStartReply { snapshot: TemporarySnapshot; duplicate: boolean }
export interface TemporaryReadRequest extends TemporaryIdentity { ifRevision?: number }
export type TemporaryReadReply =
  | { epoch: string; id: string; revision: number; unchanged: true }
  | { epoch: string; id: string; revision: number; unchanged: false; snapshot: TemporarySnapshot }
export interface TemporaryDraftRequest extends TemporaryIdentity { text: string; baseDraftRevision: number }
export interface TemporaryConfigureRequest extends TemporaryIdentity { settings: TemporarySettings }
export interface TemporaryPromptRequest extends TemporaryIdentity { clientMessageId: string; text: string }
export interface TemporaryPromptReply extends TemporaryIdentity { turnId: string; revision: number; duplicate: boolean }
export interface TemporaryRemoveReply { removed: boolean }

/** Provider-private identifiers and raw errors must remain inside this handle. */
export interface TemporaryTransport {
  readonly alive: boolean
  run(text: string, onDelta: (text: string) => void, signal: AbortSignal): Promise<void>
  close(): Promise<void>
}
export type TemporaryTransportFactory = (settings: TemporarySettings, id: string) => Promise<TemporaryTransport>

export interface TemporaryLimits {
  maxChats: number
  maxSnapshotBytes: number
  maxTotalBytes: number
  maxTextBytes: number
  maxStartReceipts: number
  maxPromptReceipts: number
}

export interface TemporaryServiceOptions {
  factory: TemporaryTransportFactory
  capabilities(): Promise<readonly TemporaryCapability[]>
  beforeTurn(provider: TemporaryProvider, id: string): Promise<void>
  /** Dedicated, non-project directory. No chat data is written here. */
  workspaceRoot?: string
  limits?: Partial<TemporaryLimits>
  now?(): number
}

export interface TemporaryChatService {
  readonly epoch: string
  /** Daemon-internal update/restart guard; no private text or provider identifiers. */
  runningCount(): number
  /** Daemon-internal transport hook, never an RPC. Available only during/after lazy factory creation. */
  workspaceFor(id: string): string
  list(): Promise<TemporaryListReply>
  start(request: TemporaryStartRequest): Promise<TemporaryStartReply>
  read(request: TemporaryReadRequest): TemporaryReadReply
  draft(request: TemporaryDraftRequest): TemporarySnapshot
  configure(request: TemporaryConfigureRequest): Promise<TemporarySnapshot>
  prompt(request: TemporaryPromptRequest): TemporaryPromptReply
  stop(request: TemporaryIdentity): Promise<TemporarySnapshot>
  remove(request: TemporaryIdentity): Promise<TemporaryRemoveReply>
  shutdown(): Promise<void>
}
