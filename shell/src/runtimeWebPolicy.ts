import { createHash } from 'node:crypto'
import type { RuntimeBounds } from '../../src/runtimes/types.js'

export function runtimeSessionId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(raw)) throw new Error('Неверная сессия среды')
  return raw
}

export function runtimeWebUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('Нужен адрес http:// или https://')
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('Неверный адрес страницы') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Разрешены только http(s) без пароля в адресе')
  return url.href
}

export function runtimeWebPartition(sessionId: string, instanceId = ''): string {
  if (typeof instanceId !== 'string' || instanceId.length > 256) throw new Error('Неверный экземпляр сессии')
  // Session names can be reused after removal. The persisted creation identity must not be.
  return `persist:pult-runtime-web-${createHash('sha256').update(JSON.stringify([runtimeSessionId(sessionId), instanceId])).digest('hex').slice(0, 32)}`
}

export function runtimeBounds(raw: unknown, viewport: { width: number; height: number }): RuntimeBounds | null {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Неверная область превью')
  const r = raw as Record<string, unknown>
  for (const k of ['x', 'y', 'width', 'height']) if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) throw new Error('Неверная область превью')
  const x = Math.max(0, Math.min(viewport.width, Math.round(r['x'] as number)))
  const y = Math.max(0, Math.min(viewport.height, Math.round(r['y'] as number)))
  const width = Math.max(0, Math.min(4096, viewport.width - x, Math.round(r['width'] as number)))
  const height = Math.max(0, Math.min(4096, viewport.height - y, Math.round(r['height'] as number)))
  return width < 20 || height < 20 ? null : { x, y, width, height }
}

export function runtimeNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = raw === undefined ? fallback : raw
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`Число должно быть от ${min} до ${max}`)
  return n
}
