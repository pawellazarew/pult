import { t as tr } from './lib/i18n.js'
// Доступ к мосту `window.pult`. Интерфейс не знает ни про сокет, ни про токен демона — только
// этот объект, который кладёт preload оболочки (shell/src/preload.ts).

import type { BridgeError, PultBridge } from '../../shell/src/contract.js'

declare global {
  interface Window {
    pult?: PultBridge
  }
}

/** Мост с проверкой версии: окно, открытое не в оболочке или в оболочке другой версии, должно это сказать, а не падать молча. */
export function getBridge(expectedVersion: number): { bridge: PultBridge | null; problem: string | null } {
  const b = window.pult
  if (!b) return { bridge: null, problem: tr('мост window.pult не найден — окно открыто не в оболочке Пульта') }
  if (b.version !== expectedVersion) {
    return { bridge: null, problem: tr`версия моста ${b.version}, интерфейс ждёт ${expectedVersion} — обнови Пульт целиком` }
  }
  return { bridge: b, problem: null }
}

export function isBridgeError(e: unknown): e is BridgeError {
  return typeof e === 'object' && e !== null && typeof (e as BridgeError).code === 'string' && typeof (e as BridgeError).message === 'string'
}

export function errorText(e: unknown): string {
  if (isBridgeError(e)) return `${e.message} (${e.code})`
  if (e instanceof Error) return e.message
  return String(e)
}
