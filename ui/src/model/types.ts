// Типы, которые интерфейс берёт у пакета pult. Только `import type`: рантайм демона в бандл окна
// не попадает, а источник правды о формах ответов один — src/.

import type { PultEvent } from '../../../src/core/events.js'
import type { DaemonStatus } from '../../../src/core/rpc.js'
import type { DoctorItem, DoctorReport, DoctorStatus } from '../../../src/env/doctor.js'
import type { PendingPermission } from '../../../src/perm/broker.js'
import type { QueueItem, SessionRecord, SessionStatus, SessionWorktree } from '../../../src/sessions/registry.js'
import type { Attention, AttentionKind } from '../../../src/sessions/attention.js'
import type { AccessView } from '../../../src/sessions/access.js'
export type { ProviderCatalog, ProviderReadiness, ProviderModel } from '../../../src/env/providers.js'

export type { PultEvent, DaemonStatus, DoctorItem, DoctorReport, DoctorStatus, PendingPermission, QueueItem, SessionRecord, SessionStatus, SessionWorktree }
export type { Attention, AttentionKind }

/**
 * Строка ответа `agent.list`; `attention` — последнее событие внимания сессии (О2, демон 0.2.21+);
 * `browserDownloads` — папка скачиваний браузера агента (О3), есть только у сессии с браузером.
 */
export type AgentRecord = SessionRecord & { pendingPermissions: number; attention?: Attention; browserDownloads?: string
  /** M8d: у Claude в режиме `inherit` — действующий `defaultMode` из настроек владельца (демон читает их сам). */
  claudeMode?: string
  /** Шаг A: доступ чата — желаемый, применённый, ожидающий, красная метка (src/sessions/access.ts). */
  access?: AccessView }

/** Провайдеры агентов (без служебного `pult`). */
export type AgentProvider = 'claude' | 'codex' | 'zcode'

/** Тон статуса — одна палитра на весь интерфейс (docs/12 §3). */
export type Tone = 'ok' | 'run' | 'wait' | 'fail' | 'queued'

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
export const obj = (v: unknown): Record<string, unknown> | undefined =>
  (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
