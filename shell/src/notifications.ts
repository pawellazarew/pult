import { t as tr } from './i18n.js'
import { randomUUID } from 'node:crypto'
import type { NotificationConstructorOptions } from 'electron'
import type { NotifyTarget } from './contract.js'

type Options = Pick<NotificationConstructorOptions, 'title' | 'body' | 'sound' | 'silent'>
export interface NativeNotice {
  readonly id: string
  once(event: 'click' | 'close' | 'failed', cb: () => void): unknown
  show(): void
}

export function sanitizeTarget(t: unknown): NotifyTarget {
  const out: NotifyTarget = {}
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const o = t as Record<string, unknown>
    for (const k of ['sessionId', 'permId'] as const) {
      if (typeof o[k] === 'string' && o[k].length > 0 && o[k].length <= 128) out[k] = o[k]
    }
    if (o['inbox'] === true) out.inbox = true
  }
  return out
}

/** Цель хранится в системном id, чтобы вернуть обработчик после перезапуска приложения. Текста беседы здесь нет. */
export function notificationTarget(id: string): NotifyTarget | null {
  const m = /^pult-notify-v1\.([A-Za-z0-9_-]{1,800})\.[0-9a-f-]{36}$/.exec(id)
  if (!m) return null
  try {
    const raw: unknown = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const target = sanitizeTarget(raw)
    if (JSON.stringify(raw) !== JSON.stringify(target)) return null
    return target
  } catch { return null }
}

export function createNotificationRouter(d: {
  create(options: Options & { id: string }): NativeNotice
  open(target: NotifyTarget): void
  history?(): Promise<NativeNotice[]>
  warn?(message: string): void
}) {
  // Electron требует живой JS-объект для событий click. Локальной переменной IPC-обработчика мало.
  const active = new Map<string, NativeNotice>()
  const retain = (n: NativeNotice, target: NotifyTarget): void => {
    active.set(n.id, n)
    const release = (): void => { if (active.get(n.id) === n) active.delete(n.id) }
    n.once('click', () => { try { d.open(target) } finally { release() } })
    n.once('close', release)
    n.once('failed', () => { release(); d.warn?.(tr('системное уведомление не показано')) })
  }
  return {
    show(options: Options, raw: unknown): string {
      const target = sanitizeTarget(raw)
      const id = `pult-notify-v1.${Buffer.from(JSON.stringify(target)).toString('base64url')}.${randomUUID()}`
      const n = d.create({ ...options, id })
      retain(n, target)
      try { n.show() } catch (e) { active.delete(id); throw e }
      return id
    },
    async restore(): Promise<void> {
      if (!d.history) return
      try {
        for (const n of await d.history()) {
          const target = notificationTarget(n.id)
          if (target && !active.has(n.id)) retain(n, target)
        }
      } catch { d.warn?.(tr('история системных уведомлений недоступна')) }
    },
    size: (): number => active.size,
  }
}
