/** Stable provider-neutral surface. Device SDKs/helpers are optional, never bundled. */
export type RuntimeKind = 'web' | 'ios' | 'android'
export interface RuntimeTarget {
  id: string
  kind: RuntimeKind
  name: string
  state: 'ready' | 'stopped' | 'unavailable'
  detail?: string
  capabilities: string[]
}
export interface RuntimeSetup {
  id: string
  kind: RuntimeKind
  title: string
  detail: string
  command?: string
  url?: string
  installable: boolean
}
export interface RuntimeDiscovery { targets: RuntimeTarget[]; setup: RuntimeSetup[] }
export interface RuntimeInput { sessionId: string; targetId: string; action: string; input?: Record<string, unknown> }
export interface RuntimeResult {
  [key: string]: unknown
  text?: string
  /** Single bounded image; never stored in the event journal. */
  image?: { data: string; mimeType: 'image/jpeg' | 'image/png' }
}
export interface RuntimeHostJob { id: string; sessionId: string; action: string; input: Record<string, unknown> }
export interface RuntimeBounds { x: number; y: number; width: number; height: number }
