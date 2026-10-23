// Подписки на поток событий.
//
// ГЛАВНАЯ ТРУДНОСТЬ — стык «доигрываем прошлое» и «отдаём живое». Наивно: сначала прочитать
// журнал, потом подписаться — и события, случившиеся между чтением и подпиской, пропадут.
// Наоборот — подписаться, потом читать — и они придут дважды.
// Решение: сначала вешаем живого слушателя в БУФЕР, затем синхронно читаем журнал с курсора,
// затем сливаем буфер, отбрасывая всё, что уже доиграно по номеру. Между этими шагами нет ни
// одного await — Node однопоточен, значит новое событие вклиниться не может.
//
// ДОИГРЫВАНИЕ — ПОРЦИЯМИ. Журнал растёт без предела (08.10.2026: 24 тыс. событий, 8,4 МБ), а окно
// подписывается с нуля. Отдать прошлое одним махом — переполнить буфер сокета: демон отцеплял
// окно как «не читающее ответы», окно переподключалось, и так по кругу («демон не запускается»).
// Поэтому прошлое идёт, пока буфер сокета не разросся (`backedUp`), дальше — ждём, пока клиент
// его выпишет (`drained`). Живые события тем временем копятся в буфере подписки, как и раньше.

import type { PultEvent } from '../core/events.js'
import type { EventStore } from '../core/store.js'
import type { LiveChannel } from './live.js'

export interface EventBus {
  emit(ev: PultEvent): void
  on(listener: (ev: PultEvent) => void): () => void
  listenerCount(): number
}

export function createBus(): EventBus {
  const listeners = new Set<(ev: PultEvent) => void>()
  return {
    emit(ev) {
      for (const l of [...listeners]) {
        try { l(ev) } catch { /* один сломанный слушатель не роняет поток остальным */ }
      }
    },
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listenerCount: () => listeners.size,
  }
}

export interface SubscriptionSink {
  /** false — клиент не успевает, подписку надо снять. */
  write(frame: unknown): boolean
  /**
   * Прощальный кадр в обход лимита с закрытием соединения. Нужен ровно там, где `write`
   * уже ответил `false`: иначе кадр про slow_consumer уходит в тот же переполненный буфер,
   * откуда его выбрасывают, и клиент остаётся с открытым сокетом и без событий.
   */
  close?(frame: unknown): void
  /** Буфер сокета разросся — доигрывание ждёт `drained`. Нет — прошлое уходит одним махом. */
  backedUp?(): boolean
  /** Ждать, пока клиент выпишет буфер. false — соединение закрылось или клиент не читает. */
  drained?(): Promise<boolean>
}

export interface SubscribeParams {
  since?: number
  sessionId?: string
  /**
   * Живой канал фаз хода (0.3.5, src/daemon/live.ts): журнал не доигрывается, приходят только кадры `turn.phase`
   * — снимок текущих фаз, затем перемены. Сервер ставит его по `since >= LIVE_CURSOR_BASE` (или `live: true`).
   */
  live?: boolean
}

export interface SubscriptionHandle {
  sub: number
  /**
   * Доиграть прошлое и слить буфер. Вызывается ПОСЛЕ того, как клиенту ушёл ответ с номером
   * подписки: иначе кадры подписки приходят раньше ответа, и клиент не знает, куда их деть.
   * Пока буфер сокета не разросся, всё идёт синхронно; дальше — порциями по `drained`.
   */
  start(): Promise<{ replayed: number }>
}

export interface SubscriptionManager {
  subscribe(params: SubscribeParams, sink: SubscriptionSink): SubscriptionHandle
  unsubscribe(sub: number): boolean
  count(): number
  /** Снять все подписки соединения (клиент отвалился, демон останавливается). */
  dispose(reason?: { code: string; message: string }): void
}

export function createSubscriptions(bus: EventBus, store: EventStore, live?: LiveChannel): SubscriptionManager {
  let seq = 0
  const off = new Map<number, () => void>()
  const sinks = new Map<number, SubscriptionSink>()

  const drop = (sub: number, reason?: { code: string; message: string }): void => {
    const unlisten = off.get(sub)
    if (unlisten) unlisten()
    const sink = sinks.get(sub)
    if (sink && reason) {
      let delivered = false
      try { delivered = sink.write({ sub, end: reason }) } catch { /* соединение уже мертво */ }
      if (!delivered) { try { sink.close?.({ sub, end: reason }) } catch { /* соединение уже мертво */ } }
    }
    off.delete(sub)
    sinks.delete(sub)
  }

  return {
    subscribe(params, sink) {
      const sub = ++seq
      const since = Number.isFinite(params.since) ? Number(params.since) : 0
      if (params.live) {
        // Живой канал: ни журнала, ни буфера — снимок фаз на `start` новее всего, что пришло бы до него.
        sinks.set(sub, sink)
        const ch = live?.subscribe(since, (frame) => {
          if (!sink.write({ sub, event: frame })) drop(sub, { code: 'slow_consumer', message: 'клиент не успевает читать поток событий' })
        })
        off.set(sub, () => { ch?.stop() })
        return { sub, start: async () => { if (sinks.has(sub)) ch?.start(); return { replayed: 0 } } }
      }
      const buffered: PultEvent[] = []
      let replaying = true

      const deliver = (ev: PultEvent): void => {
        if (params.sessionId !== undefined && ev.sessionId !== params.sessionId) return
        if (!sink.write({ sub, event: ev })) {
          drop(sub, { code: 'slow_consumer', message: 'клиент не успевает читать поток событий' })
        }
      }

      const unlisten = bus.on((ev) => {
        if (replaying) buffered.push(ev)
        else deliver(ev)
      })
      off.set(sub, unlisten)
      sinks.set(sub, sink)

      /** Подписка ещё жива и клиент успевает. false — снята (отписка, отцепление, обрыв). */
      const keepUp = async (): Promise<boolean> => {
        if (!sinks.has(sub)) return false
        if (!sink.backedUp?.() || !sink.drained) return true
        if (await sink.drained()) return sinks.has(sub)
        drop(sub, { code: 'slow_consumer', message: 'клиент не успевает читать поток событий' })
        return false
      }

      const start = async (): Promise<{ replayed: number }> => {
        const past = store.readFrom(since, params.sessionId !== undefined ? { sessionId: params.sessionId } : {})
        for (const ev of past) {
          deliver(ev)
          if (!(await keepUp())) return { replayed: 0 }
        }
        const lastReplayed = past.length ? (past[past.length - 1] as PultEvent).id : since

        // Буфер может расти, пока ждём `drained`, — поэтому по индексу, а не for…of по снимку.
        // Последняя проверка длины и `replaying = false` идут без await между ними: живое
        // событие не проскочит ни мимо буфера, ни дважды.
        for (let i = 0; i < buffered.length; i++) {
          const ev = buffered[i] as PultEvent
          if (ev.id <= lastReplayed) continue
          deliver(ev)
          if (!(await keepUp())) return { replayed: past.length }
        }
        replaying = false
        buffered.length = 0
        return { replayed: past.length }
      }

      return { sub, start }
    },

    unsubscribe(sub) {
      if (!off.has(sub)) return false
      drop(sub)
      return true
    },

    count: () => off.size,

    dispose(reason) {
      for (const sub of [...off.keys()]) drop(sub, reason)
    },
  }
}
