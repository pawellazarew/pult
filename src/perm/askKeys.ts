// Ключи вопросов (0.3.7): узкое право `pult mcp-ask` вместо токена хозяина.
//
// ЗАЧЕМ. До 0.3.7 заглушка читала PULT_HOME/run/token — тот же токен, которым окно и CLI делают ВСЁ (разрешают,
// останавливают, меняют режим). Агент, дотянувшийся до файла токена, получал полный пульт. Теперь демон на каждый
// процесс `claude` выдаёт свой ключ, привязанный к одной сессии: с ним можно только спросить (`perm.request`) от
// имени этой сессии, больше ничего. Ключ уходит заглушке через env файла --mcp-config, а не через диск с токеном.
//
// Живут ключи только в памяти демона: рестарт демона гасит все (живые `claude` при этом и так перезапускаются).
// Снимаются на выходе процесса `claude`, которому выданы (адаптер), — ключ мёртвого процесса никому не нужен.

import { randomBytes, timingSafeEqual } from 'node:crypto'

export const ASK_KEY_BYTES = 32

export interface AskKeys {
  /** Новый ключ для сессии: 32 случайных байта, hex. */
  mint(session: string): string
  /** Сессия ключа; null — такого ключа нет (снят, чужой, пустой). Сравнение постоянного времени. */
  lookup(key: unknown): string | null
  /** Снять ключ; false — его и не было. */
  revoke(key: string): boolean
  /** Снять все ключи сессии (закрытие, `agent rm`, остановка): имя может достаться новой сессии. Сколько снято. */
  revokeSession(session: string): number
  /** Сколько ключей живо (тесты, отладка). */
  size(): number
}

/** Форма ключа: 32 байта hex строчными — то, что выдаёт `mint`. Всё прочее не сверяется вовсе. */
export function isAskKeyShape(key: unknown): key is string {
  return typeof key === 'string' && key.length === ASK_KEY_BYTES * 2 && /^[0-9a-f]+$/.test(key)
}

export function createAskKeys(): AskKeys {
  // Ключи храним списком и сверяем каждый `timingSafeEqual`: поиск по Map выдавал бы по времени, есть ли префикс.
  // Ключей — по одному на живой процесс `claude`, единицы; перебор ничего не стоит.
  const keys: Array<{ key: Buffer; hex: string; session: string }> = []
  const find = (key: unknown): number => {
    // Ровно 64 строчных hex-знака ДО любой сверки: длина строки JS — не длина байт (`'é'.repeat(64)` — 128 байт),
    // и `timingSafeEqual` на разной длине бросает. Бросок в обработчике рукопожатия ронял весь демон (ревью #16).
    if (!isAskKeyShape(key)) return -1
    const given = Buffer.from(key, 'ascii')
    let hit = -1
    for (let i = 0; i < keys.length; i++) {
      // Без раннего выхода: время не зависит от того, какой по счёту ключ совпал.
      if (timingSafeEqual(given, keys[i]!.key) && hit < 0) hit = i
    }
    return hit
  }
  return {
    mint(session) {
      const hex = randomBytes(ASK_KEY_BYTES).toString('hex')
      keys.push({ key: Buffer.from(hex, 'ascii'), hex, session })
      return hex
    },
    lookup(key) {
      const i = find(key)
      return i < 0 ? null : keys[i]!.session
    },
    revoke(key) {
      const i = find(key)
      if (i < 0) return false
      keys.splice(i, 1)
      return true
    },
    revokeSession(session) {
      let n = 0
      for (let i = keys.length - 1; i >= 0; i--) {
        if (keys[i]!.session === session) { keys.splice(i, 1); n++ }
      }
      return n
    },
    size: () => keys.length,
  }
}
