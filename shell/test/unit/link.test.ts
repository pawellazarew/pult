// DaemonLink на фальшивом демоне и ручных таймерах: переподключение с растущей паузой и
// доигрывание с курсора — ни одного потерянного и ни одного повторного события.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Client } from '../../../src/cli/client.js'
import type { PultEvent } from '../../../src/core/events.js'
import type { ConnState } from '../../src/contract.js'
import { DaemonLink } from '../../src/link.js'
import type { Timers } from '../../src/link.js'

class FakeDaemon {
  up = true
  journal: PultEvent[] = []
  clients = new Set<{ closeFns: Array<() => void>; subs: Array<(ev: PultEvent) => void>; ends: Array<(end: { code: string; message: string }) => void> }>()
  connects = 0
  ensures = 0
  replayDuplicates = false
  silent = false
  failSubscriptions = false

  emit(n = 1): void {
    for (let i = 0; i < n; i++) {
      const ev: PultEvent = { id: this.journal.length + 1, ts: 't', sessionId: 's', provider: 'pult', kind: 'status.changed', data: {} }
      this.journal.push(ev)
      for (const c of this.clients) for (const s of c.subs) s(ev)
    }
  }

  down(): void {
    this.up = false
    for (const c of [...this.clients]) { this.clients.delete(c); for (const f of c.closeFns) f() }
  }

  async connect(): Promise<Client> {
    this.connects++
    if (!this.up) throw Object.assign(new Error('сокет не отвечает'), { code: 'no_daemon' })
    const conn = { closeFns: [] as Array<() => void>, subs: [] as Array<(ev: PultEvent) => void>, ends: [] as Array<(end: { code: string; message: string }) => void> }
    this.clients.add(conn)
    const self = this
    let subNo = 0
    return {
      daemon: { version: '0.1.0', pid: 1, startedAt: '2026-11-03T00:00:00Z' },
      async request(method: string) {
        if (self.silent) throw Object.assign(new Error('timeout'), { code: 'timeout' })
        if (!self.clients.has(conn)) throw Object.assign(new Error('closed'), { code: 'connection_closed' })
        return { method }
      },
      async subscribe(params, onEvent, onEnd) {
        if (self.failSubscriptions) throw new Error("subscription unavailable")
        if (onEnd) conn.ends.push(onEnd)
        const since = params.since ?? 0
        // Демон может прислать хвост, который окно уже видело (гонка на переподключении).
        const from = self.replayDuplicates ? Math.max(0, since - 2) : since
        for (const ev of self.journal.filter((e) => e.id > from)) onEvent(ev)
        conn.subs.push(onEvent)
        return { sub: ++subNo, cursor: self.journal.length }
      },
      close() { if (self.clients.delete(conn)) for (const f of conn.closeFns) f() },
      onClose(fn) { conn.closeFns.push(fn) },
    }
  }
}

class ManualTimers implements Timers {
  queue: Array<{ fn: () => void; ms: number; id: number }> = []
  private seq = 0
  set(fn: () => void, ms: number): unknown { const id = ++this.seq; this.queue.push({ fn, ms, id }); return id }
  clear(h: unknown): void { this.queue = this.queue.filter((t) => t.id !== h) }
  async fire(): Promise<number> {
    const t = this.queue.shift()
    assert.ok(t, 'таймер повтора не запланирован')
    t.fn()
    await flush()
    return t.ms
  }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

function setup(): { d: FakeDaemon; timers: ManualTimers; link: DaemonLink; states: ConnState[]; got: number[] } {
  const d = new FakeDaemon()
  const timers = new ManualTimers()
  const states: ConnState[] = []
  const got: number[] = []
  const link = new DaemonLink({
    connect: () => d.connect(),
    ensure: () => { d.ensures++; d.up = true; return d.connect() },
    backoff: { minMs: 100, maxMs: 400 },
    timers,
    onState: (s) => states.push(s),
  })
  link.subscribe('w:1', 0, (ev) => got.push(ev.id))
  return { d, timers, link, states, got }
}

describe('DaemonLink', () => {
  it('конец подписки при живом сокете переподключает и доигрывает курсор', async () => {
    const { d, link, timers, got } = setup()
    await link.start(); await flush()
    d.emit(2)
    const old = [...d.clients][0]!
    old.ends[0]!({ code: 'slow_consumer', message: 'slow' })
    assert.equal(link.current.state, 'down')
    assert.equal(d.clients.size, 0)
    d.emit(1)
    await timers.fire()
    assert.deepEqual(got, [1, 2, 3])
    old.ends[0]!({ code: 'slow_consumer', message: 'stale' })
    old.subs[0]!({ id: 100, ts: 't', sessionId: 's', provider: 'pult', kind: 'status.changed', data: {} })
    assert.equal(link.current.state, 'up')
    assert.deepEqual(got, [1, 2, 3])
    assert.equal(timers.queue.length, 0)
    link.close()
  })

  it('ошибка подписки при живом сокете повторяется с растущей паузой', async () => {
    const { d, link, timers, got } = setup()
    d.failSubscriptions = true
    await link.start(); await flush()
    assert.equal(link.current.state, 'down')
    assert.equal(await timers.fire(), 100)
    assert.equal(await timers.fire(), 200)
    d.failSubscriptions = false
    d.emit(2)
    assert.equal(await timers.fire(), 400)
    assert.equal(link.current.state, 'up')
    assert.deepEqual(got, [1, 2])
    assert.equal(d.ensures, 1)
    link.close()
  })

  it('конец подписки после остановки кнопкой не планирует повтор', async () => {
    const { d, link, timers } = setup()
    await link.start(); await flush()
    await link.stopDaemon()
    const old = [...d.clients][0]!
    old.ends[0]!({ code: 'daemon_stopping', message: 'stopping' })
    assert.equal(timers.queue.length, 0)
    assert.equal(d.ensures, 1)
    link.close()
  })

  it('текущая ручная остановка объясняет обрыв; повтор не запускает демон', async () => {
    const { d, link, timers } = setup()
    await link.start(); await flush()
    const stop: PultEvent = {
      id: 1, ts: '2026-11-03T01:00:00Z', sessionId: 'daemon', provider: 'pult',
      kind: 'daemon.stopping', data: { reason: 'запрошено через daemon.stop' },
    }
    for (const c of d.clients) for (const sub of c.subs) sub(stop)
    d.down()
    assert.deepEqual(link.current, {
      state: 'down', reason: 'демон остановлен: запрошено через daemon.stop', attempt: 1, retryInMs: 100,
    })
    await timers.fire()
    assert.equal(d.up, false)
    assert.equal(d.ensures, 1)
    link.close()
  })

  it('историческая остановка не меняет причину нового обрыва', async () => {
    const { d, link } = setup()
    d.journal.push({
      id: 1, ts: '2026-11-02T01:00:00Z', sessionId: 'daemon', provider: 'pult',
      kind: 'daemon.stopping', data: { reason: 'запрошено через daemon.stop' },
    })
    await link.start(); await flush()
    d.down()
    assert.deepEqual(link.current, {
      state: 'down', reason: 'соединение с демоном закрыто', attempt: 1, retryInMs: 100,
    })
    link.close()
  })

  it('возврат в окно немедленно переподключает и доигрывает курсор', async () => {
    const { d, link, timers, got } = setup()
    await link.start(); await flush()
    d.emit(1)
    d.down()
    d.up = true
    d.emit(1)
    await link.checkConnection(); await flush()
    assert.equal(timers.queue.length, 0)
    assert.deepEqual(got, [1, 2])
    assert.equal(d.ensures, 1)
    link.close()
  })

  it('молчавшее соединение заменяется; повторные проверки объединяются', async () => {
    const { d, link } = setup()
    await link.start(); await flush()
    d.silent = true
    const first = link.checkConnection()
    assert.equal(link.checkConnection(), first)
    await first; await flush()
    assert.equal(d.connects, 2)
    assert.equal(d.clients.size, 1)
    assert.equal(link.current.state, 'up')
    link.close()
  })

  it('возврат в окно не запускает остановленный вручную демон', async () => {
    const { d, link, timers } = setup()
    await link.start(); await flush()
    await link.stopDaemon()
    d.down()
    await link.checkConnection()
    assert.equal(d.connects, 1)
    assert.equal(timers.queue.length, 0)
    link.close()
  })
  it('старт поднимает демона и доигрывает историю с курсора 0', async () => {
    const { d, link, got, states } = setup()
    d.up = false
    d.journal = []
    await link.start()
    await flush()
    assert.equal(d.ensures, 1)
    d.emit(3)
    assert.deepEqual(got, [1, 2, 3])
    assert.equal(states.at(-1)?.state, 'up')
    link.close()
  })

  it('демон упал: плашка down, паузы 100→200→400→400, затем доигрывание без потерь и повторов', async () => {
    const { d, timers, link, got, states } = setup()
    await link.start(); await flush()
    d.emit(2)
    d.down()
    assert.deepEqual(states.at(-1), { state: 'down', reason: 'соединение с демоном закрыто', attempt: 1, retryInMs: 100 })
    assert.equal(await timers.fire(), 100)
    assert.equal(await timers.fire(), 200)
    assert.equal(await timers.fire(), 400)
    assert.equal(states.at(-1)?.state, 'down')
    // Демон вернулся (служба подняла), и пока окно ждёт паузу, в журнал пришли события.
    d.up = true
    d.emit(3)
    d.replayDuplicates = true
    assert.equal(await timers.fire(), 400)
    assert.equal(states.at(-1)?.state, 'up')
    d.emit(1)
    assert.deepEqual(got, [1, 2, 3, 4, 5, 6])
    assert.equal(d.ensures, 1, 'повторы только подключаются, демона не поднимают')
    link.close()
  })

  it('call без связи — отказ no_daemon; со связью — к демону', async () => {
    const { d, link } = setup()
    d.up = false
    await assert.rejects(link.call('daemon.status'), { code: 'no_daemon' })
    d.up = true
    await link.startDaemon()
    assert.deepEqual(await link.call('daemon.status'), { method: 'daemon.status' })
    link.close()
  })

  it('остановка кнопкой: повторов нет до «запустить»', async () => {
    const { d, timers, link, states } = setup()
    await link.start(); await flush()
    await link.stopDaemon()
    d.down()
    assert.deepEqual(states.at(-1), { state: 'down', reason: 'остановлен кнопкой', attempt: 0, retryInMs: null })
    assert.equal(timers.queue.length, 0)
    await link.startDaemon()
    assert.equal(states.at(-1)?.state, 'up')
    link.close()
  })

  it('отписка: события больше не доставляются; close снимает таймер повтора', async () => {
    const { d, timers, link, got } = setup()
    await link.start(); await flush()
    d.emit(1)
    link.unsubscribePrefix('w:')
    d.emit(1)
    assert.deepEqual(got, [1])
    d.down()
    assert.equal(timers.queue.length, 1)
    link.close()
    assert.equal(timers.queue.length, 0)
  })
})
