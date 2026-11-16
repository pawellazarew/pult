import { t as tr } from './i18n.js'
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

/** Native view occupies only the content rectangle; surrounding bars never receive page input. */
export function runtimeFit(box: RuntimeBounds, viewport: { width: number; height: number }, actualSize = false): RuntimeBounds & { scale: number } {
  const fit = Math.min(2, box.width / viewport.width, box.height / viewport.height)
  const scale = actualSize && fit >= 1 ? 1 : fit
  const width = Math.floor(viewport.width * scale), height = Math.floor(viewport.height * scale)
  return { x: box.x + Math.floor((box.width - width) / 2), y: box.y + Math.floor((box.height - height) / 2), width, height, scale }
}

/** Qualified Electron 45.2.3 emulation position transform, independent of display DPR. */
export function runtimeInputPoint(point: { x: number; y: number }, viewport: { width: number; height: number }, scale: number): { x: number; y: number } {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) throw new Error(tr('Точка за пределами страницы'))
  return { x: point.x * scale, y: point.y * scale }
}

/** Recheck incarnation after observational controller lookup; names may be recycled. */
export async function runtimeViewAuthorized(
  id: string, createdAt: string,
  discover: () => Promise<{ controllers?: Record<string, string> }>,
  sessions: () => Promise<{ sessions?: Array<{ name?: unknown; createdAt?: unknown }> }>,
): Promise<boolean> {
  const controller = await discover()
  const fresh = await sessions()
  return fresh.sessions?.some(s => s.name === id && s.createdAt === createdAt) === true
    && controller.controllers?.[`web:${id}`] === 'human'
}
