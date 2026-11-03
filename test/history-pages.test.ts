import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createStore } from '../dist/core/store.js'
import { createBus, createSubscriptions } from '../dist/daemon/subscriptions.js'
import type { PultEvent } from '../dist/core/events.js'
import { tempHome } from './helpers.js'

it('limit и фильтр сессии не читают большой хвост чужой истории, включая после рестарта', () => {
  const home = tempHome()
  let store = createStore(home.paths)
  try {
    store.append({ sessionId: 'target', provider: 'pult', kind: 'message.done' })
    for (let i = 0; i < 1000; i++) {
      store.append({ sessionId: 'other', provider: 'pult', kind: 'message.delta', data: { text: 'я'.repeat(4096) } })
    }
    const end = store.append({ sessionId: 'target', provider: 'pult', kind: 'message.done' })
    store.close()
    store = createStore(home.paths)
    assert.equal(store.readFrom(0, { limit: 1 })[0]?.id, 1)
    assert.deepEqual(store.readFrom(0, { sessionId: 'target', limit: 2 }).map((ev) => ev.id), [1, end.id])
    assert.ok(store.stats().bytesRead < 4096, `прочитано ${store.stats().bytesRead} байт чужой истории`)
  } finally { store.close(); home.remove() }
})

it('большая подписка уступает событийный цикл и сохраняет новые события на границе порций', async () => {
  const home = tempHome()
  const store = createStore(home.paths)
  const bus = createBus()
  const subs = createSubscriptions(bus, store)
  try {
    for (let i = 0; i < 800; i++) store.append({ sessionId: 's', provider: 'pult', kind: 'message.done' })
    const got: number[] = []
    let countAtTick = -1
    const handle = subs.subscribe({ since: 0 }, {
      write(frame) { const ev = (frame as { event?: PultEvent }).event; if (ev) got.push(ev.id); return true },
    })
    const tick = new Promise<void>((resolve) => setImmediate(() => {
      countAtTick = got.length
      bus.emit(store.append({ sessionId: 's', provider: 'pult', kind: 'message.done' }))
      resolve()
    }))
    const result = await handle.start()
    await tick
    assert.ok(countAtTick > 0 && countAtTick < 800, `событийный цикл ждал ${countAtTick} событий`)
    assert.equal(result.replayed, 800)
    bus.emit(store.append({ sessionId: 's', provider: 'pult', kind: 'message.done' }))
    assert.deepEqual(got, Array.from({ length: 802 }, (_, i) => i + 1))
  } finally { subs.dispose(); store.close(); home.remove() }
})

it('лимит байт ограничивает порцию, но пропускает одну большую запись и не обрывает replay', async () => {
  const home = tempHome()
  const store = createStore(home.paths)
  const subs = createSubscriptions(createBus(), store)
  try {
    for (let i = 0; i < 4; i++) store.append({ sessionId: 's', provider: 'pult', kind: 'message.delta', data: { text: 'x'.repeat(700_000) } })
    assert.equal(store.readFrom(0, { maxBytes: 1024 * 1024 }).length, 1)
    assert.equal(store.readFrom(0, { maxBytes: 1 }).length, 1, 'большая запись не должна навечно заблокировать курсор')
    const got: number[] = []
    const h = subs.subscribe({ since: 0 }, { write(f) { const e = (f as { event?: PultEvent }).event; if (e) got.push(e.id); return true } })
    assert.equal((await h.start()).replayed, 4)
    assert.deepEqual(got, [1, 2, 3, 4])
  } finally { subs.dispose(); store.close(); home.remove() }
})
