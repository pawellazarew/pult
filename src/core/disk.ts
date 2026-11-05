import { statfsSync } from 'node:fs'
import type { Logger } from './log.js'

export const GB = 1_000_000_000
export const LOW_DISK_BYTES = 6 * GB
export interface DiskSettings { thresholdGb: number; prompt: string | null }
export interface DiskStatus { state: 'ok' | 'low' | 'unknown'; freeBytes: number | null; thresholdBytes: number; path: string; checkedAt: string }
export const DEFAULT_DISK_SETTINGS: DiskSettings = { thresholdGb: 6, prompt: null }
export function parseDiskSettings(value: unknown): DiskSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('disk: expected {thresholdGb, prompt}')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => k !== 'thresholdGb' && k !== 'prompt') || typeof v.thresholdGb !== 'number' || !Number.isSafeInteger(v.thresholdGb) || v.thresholdGb < 1 || !Number.isSafeInteger(v.thresholdGb * GB) || (v.prompt !== null && typeof v.prompt !== 'string')) throw new Error('disk: thresholdGb must be a positive integer; prompt must be text or null')
  return { thresholdGb: v.thresholdGb, prompt: typeof v.prompt === 'string' ? v.prompt.trim() || null : null }
}

/** Same snapshot for the log and UI. Unknown measurements never imply a full disk. */
export function createDiskMonitor(home: string, logger: Logger, options: {
  thresholdBytes?: number | (() => number)
  availableBytes?: () => number
} = {}): () => DiskStatus {
  const available = options.availableBytes ?? (() => { const s = statfsSync(home); return s.bavail * s.bsize })
  let low = false
  return () => {
    const threshold = typeof options.thresholdBytes === 'function' ? options.thresholdBytes() : options.thresholdBytes ?? LOW_DISK_BYTES
    const base = { thresholdBytes: threshold, path: home, checkedAt: new Date().toISOString() }
    try {
      const bytes = available()
      if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid disk measurement')
      if (bytes < threshold && !low) logger.warn('мало свободного места — запись состояния демона под угрозой', { availableBytes: bytes, thresholdBytes: threshold })
      if (bytes >= threshold && low) logger.info('свободное место восстановлено', { availableBytes: bytes })
      low = bytes < threshold
      return { ...base, state: low ? 'low' : 'ok', freeBytes: bytes }
    } catch { return { ...base, state: 'unknown', freeBytes: null } }
  }
}
