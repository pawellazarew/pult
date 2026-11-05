// Кэш «лёгкой» истории сессий для `events.history` (06.11.2026).
//
// ЗАЧЕМ: каждая страница истории заново читала и сжимала ВЕСЬ файл сессии — на сессии в 9 МБ это 80 мс
// чтения и разбора плюс 60 мс `compactHistory` на одно открытие чата и ещё столько же на каждое «Показать
// раньше». Сжатая история не меняется, пока не меняется файл, поэтому её можно держать готовой.
//
// Свежесть — по отметке файла (размер, время изменения, inode), а не по подписке на запись: файл сессии
// меняет не только `emit` (импорт сессий Codex, очистка диска, удаление сессии), и отметка ловит любой из
// этих путей. Демон однопоточный, чтение и запись идут синхронно — отметка и чтение не разъедутся.
// Держим несколько последних сессий: одна большая сжатая история — единицы мегабайт.

import type { PultEvent } from './events.js'

export interface HistoryCache {
  /** Сжатая история сессии: из кэша, если файл не менялся, иначе — прочитанная заново. */
  get(sessionId: string): readonly PultEvent[]
}

export function createHistoryCache(opts: {
  /** Отметка файла сессии; `null` — файла нет (такое не кэшируется). */
  stamp(sessionId: string): string | null
  /** Прочитать и сжать историю сессии. */
  load(sessionId: string): readonly PultEvent[]
  /** Сколько сессий держать (по умолчанию 4). */
  size?: number
}): HistoryCache {
  const size = Math.max(1, opts.size ?? 4)
  // Map помнит порядок вставки: первая запись — самая давняя по использованию.
  const entries = new Map<string, { stamp: string; events: readonly PultEvent[] }>()
  return {
    get(sessionId) {
      const stamp = opts.stamp(sessionId)
      const hit = entries.get(sessionId)
      if (hit && stamp !== null && hit.stamp === stamp) {
        entries.delete(sessionId)
        entries.set(sessionId, hit)
        return hit.events
      }
      entries.delete(sessionId)
      const events = opts.load(sessionId)
      if (stamp === null) return events
      entries.set(sessionId, { stamp, events })
      while (entries.size > size) entries.delete(entries.keys().next().value as string)
      return events
    },
  }
}
