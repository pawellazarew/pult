import { statfsSync } from 'node:fs'
import type { Logger } from './log.js'

export const LOW_DISK_BYTES = 10 * 1024 ** 3

/** Проверка не блокирует работу при недоступной статистике; предупреждение только при смене состояния. */
export function createDiskMonitor(home: string, logger: Logger, options: {
  thresholdBytes?: number
  availableBytes?: () => number
} = {}): () => void {
  const threshold = options.thresholdBytes ?? LOW_DISK_BYTES
  const available = options.availableBytes ?? (() => {
    const s = statfsSync(home)
    return s.bavail * s.bsize
  })
  let low = false
  return () => {
    try {
      const bytes = available()
      if (!Number.isFinite(bytes) || bytes < 0) return
      if (bytes < threshold && !low) logger.warn('мало свободного места — запись состояния демона под угрозой', { availableBytes: bytes, thresholdBytes: threshold })
      if (bytes >= threshold && low) logger.info('свободное место восстановлено', { availableBytes: bytes })
      low = bytes < threshold
    } catch { /* Ошибка statfs сама по себе не означает заполненный диск. */ }
  }
}
