// Надёжность демона при отказах диска и журнала — правки по ревью 28.10.2026. Всё локально,
// во временном PULT_HOME: брокер не теряет решение и не оставляет призраков, реестр откатывает
// запись при неудачной записи на диск, `agent.read` не рвёт строку NDJSON лимитом клиента.

import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { describe, it } from 'node:test'
import { MAX_LINE_BYTES } from '../dist/core/ndjson.js'
import { createStore } from '../dist/core/store.js'
import type { EventStore } from '../dist/core/store.js'
import { createBroker } from '../dist/perm/broker.js'
import { createManager } from '../dist/sessions/manager.js'
import { createRegistry } from '../dist/sessions/registry.js'
import type { SessionRecord } from '../dist/sessions/registry.js'
import { tempHome, type TempHome } from './helpers.js'

describe('ревью 28.10.2026: брокер переживает сломанный журнал', () => {
  it('вопрос не записался — спрашивающий получает отказ сразу, призрака в Inbox нет', async () => {
    const broker = createBroker({ emit: () => { throw new Error('ENOSPC') } })
    const decision = await broker.request({ sessionId: 'w', toolName: 'Bash', input: { command: 'ls' } })
    assert.equal(decision.behavior, 'deny', 'вопрос не задан — согласия нет')
    assert.equal(broker.pendingCount(), 0, 'карточка не висит до таймаута')
    assert.deepEqual(broker.list(), [])
  })

  it('решение не записалось — спрашивающий всё равно получает ответ (settle в finally)', async () => {
    let calls = 0
    const broker = createBroker({ emit: () => { if (++calls > 1) throw new Error('ENOSPC') } })
    const done = broker.request({ sessionId: 'w', toolName: 'Bash', input: { command: 'ls' } })
    const id = broker.list('w')[0]!.id
    assert.throws(() => broker.resolve(id, { behavior: 'allow' }), /ENOSPC/, 'ошибка журнала видна вызывающему')
    assert.equal((await done).behavior, 'allow', 'событие потеряно, решение — дошло')
    assert.equal(broker.pendingCount(), 0)
  })
})

describe('ревью 28.10.2026: реестр откатывает запись при неудачной записи на диск', () => {
  const record = (name: string): SessionRecord => ({
    name, provider: 'claude', cwd: '/tmp/x', mode: 'turn', createdAt: '2026-10-28T10:00:00.000Z', lastStatus: 'idle', lastEventId: 0,
  })

  it('update упал — режим подтверждений в памяти прежний, а не «применился молча»', () => {
    const home = tempHome()
    try {
      const reg = createRegistry(home.paths)
      reg.create({ ...record('w'), approval: 'workspace' })
      chmodSync(home.paths.home, 0o500)
      try {
        assert.throws(() => reg.update('w', { approval: 'full' }))
      } finally {
        chmodSync(home.paths.home, 0o700)
      }
      assert.equal(reg.get('w')?.approval, 'workspace', 'память не разошлась с диском')
      assert.equal(createRegistry(home.paths).get('w')?.approval, 'workspace', 'и на диске прежний режим')
    } finally {
      home.remove()
    }
  })

  it('remove упал — сессия никуда не делась', () => {
    const home = tempHome()
    try {
      const reg = createRegistry(home.paths)
      reg.create(record('w'))
      chmodSync(home.paths.home, 0o500)
      try {
        assert.throws(() => reg.remove('w'))
      } finally {
        chmodSync(home.paths.home, 0o700)
      }
      assert.ok(reg.get('w'), 'сессия вернулась в список')
      assert.ok(createRegistry(home.paths).get('w'), 'и на диске')
    } finally {
      home.remove()
    }
  })
})

describe('ревью 28.10.2026: agent.read не рвёт связь лимитом строки NDJSON', () => {
  /** Три реплики по ~400 КБ: по две влезает в бюджет строки, всё сразу — нет. */
  const bootWithBigSession = (): { home: TempHome; store: EventStore; manager: ReturnType<typeof createManager> } => {
    const home = tempHome()
    createRegistry(home.paths).create({
      name: 'w', provider: 'claude', cwd: '/tmp/x', mode: 'turn', createdAt: '2026-10-28T10:00:00.000Z', lastStatus: 'idle', lastEventId: 0,
    })
    const store = createStore(home.paths)
    for (let i = 0; i < 3; i++) {
      store.append({ sessionId: 'w', provider: 'claude', kind: 'message.done', data: { text: `реплика ${i} ` + 'x'.repeat(400_000) } })
    }
    const manager = createManager({
      paths: home.paths, config: home.config, logger: home.logger, store,
      publish: (d) => store.append(d), adapters: {}, broker: createBroker({ emit: () => {} }),
    })
    return { home, store, manager }
  }

  it('json: хвост режется по бюджету, дозагрузка от вернувшегося курсора доезжает до конца', () => {
    const { home, store, manager } = bootWithBigSession()
    try {
      const first = manager.read('w', 0, 'json') as { cursor: number; events: unknown[]; truncated?: boolean }
      assert.equal(first.truncated, true, 'хвост не влез — это сказано явно')
      assert.ok(first.events.length < 3, 'всё сразу не отдаётся')
      assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= MAX_LINE_BYTES, 'строка NDJSON в лимите клиента')

      const rest = manager.read('w', first.cursor, 'json') as { cursor: number; events: unknown[]; truncated?: boolean }
      assert.notEqual(rest.truncated, true)
      assert.equal(rest.events.length, 3 - first.events.length, 'дозагрузка от курсора возвращает ровно хвост')
    } finally {
      store.close()
      home.remove()
    }
  })

  it('text: длинный ответ обрезается с меткой и влезает в строку NDJSON', () => {
    const { home, store, manager } = bootWithBigSession()
    try {
      const r = manager.read('w', 0, 'text') as { text?: string }
      assert.ok(r.text!.includes('обрезан'), 'обрезание названо в тексте')
      assert.ok(Buffer.byteLength(JSON.stringify(r), 'utf8') <= MAX_LINE_BYTES, 'строка NDJSON в лимите клиента')
    } finally {
      store.close()
      home.remove()
    }
  })
})
