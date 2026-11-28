// Старт окна без доигрывания журнала (0.2.19): лёгкая история сессии (src/core/history.ts),
// снимок и чтение по номерам в хранилище (src/core/store.ts), RPC `events.snapshot|history|get`.
// Что лента из лёгкой истории в окне выглядит так же, как из полной, — ui/test/model.test.ts.

import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import type { PultEvent } from '../dist/core/events.js'
import { compactHistory, HISTORY_PAGE_BYTES, OTHER_CHARS, pageHistory, readLatestHistoryPage, TOOL_INPUT_CHARS } from '../dist/core/history.js'
import { createStore, GET_LIMIT } from '../dist/core/store.js'
import { PROTOCOL_VERSION } from '../dist/core/rpc.js'
import { readToken } from '../dist/core/token.js'
import { rawConnect, startTestDaemon, tempHome } from './helpers.js'

let seq = 0
const ev = (kind: string, data: Record<string, unknown> = {}, extra: Partial<PultEvent> = {}): PultEvent =>
  ({ id: ++seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), sessionId: 's', provider: 'claude', kind, data, ...extra }) as PultEvent

describe('compactHistory', () => {
  it('серию, которую тут же закрывает итог, заменяет один символ; пустые дельты выброшены', () => {
    const a = ev('message.delta', { text: '' })
    const b = ev('message.delta', { text: 'Длинный ' })
    const c = ev('message.delta', { text: 'текст' })
    const done = ev('message.done', { text: 'Длинный текст.' })
    const out = compactHistory([a, b, c, done])
    assert.deepEqual(out.map((e) => [e.id, e.data['text']]), [[b.id, 'Д'], [done.id, 'Длинный текст.']])
    // Итог с пустым текстом серию не заменяет: текст живёт только в дельтах.
    const d1 = ev('message.delta', { text: 'только ' })
    const d2 = ev('message.delta', { text: 'дельты' })
    const empty = ev('message.done', { text: '' })
    assert.equal(compactHistory([d1, d2, empty])[0]?.data['text'], 'только дельты')
  })

  it('серия дельт одной области — одна дельта с номером первой; любое другое событие рвёт серию', () => {
    const a = ev('message.delta', { text: 'При' })
    const b = ev('message.delta', { text: 'вет' })
    const t = ev('tool.called', { toolUseId: 'u1', name: 'Bash', input: { command: 'ls' } })
    const c = ev('message.delta', { text: '!' })
    const out = compactHistory([a, b, t, c])
    assert.deepEqual(out.map((e) => [e.id, e.kind, e.data['text']]), [[a.id, 'message.delta', 'Привет'], [t.id, 'tool.called', undefined], [c.id, 'message.delta', '!']])
    // Вход не мутирован: история читается из файла, но функция чистая.
    assert.equal(a.data['text'], 'При')
  })

  it('дельты субагента — своя область: не склеиваются с корнем и не рвут его серию', () => {
    const spawn = ev('agent.spawned', { toolUseId: 'A' })
    const r1 = ev('message.delta', { text: 'корень ' })
    const s1 = ev('message.delta', { text: 'суб ' }, { parentId: 'A' })
    const r2 = ev('message.delta', { text: 'дальше' })
    const s2 = ev('message.delta', { text: 'ещё' }, { parentId: 'A' })
    const out = compactHistory([spawn, r1, s1, r2, s2])
    assert.deepEqual(out.map((e) => [e.id, e.data['text']]), [[spawn.id, undefined], [r1.id, 'корень дальше'], [s1.id, 'суб ещё']])
  })

  it('родитель неизвестен — корень, как у окна; другой itemId — новая реплика', () => {
    const r1 = ev('message.delta', { text: 'a' })
    const orphan = ev('message.delta', { text: 'b' }, { parentId: 'нет-такого' })
    const other = ev('message.delta', { text: 'c', itemId: 'i2' })
    const same = ev('message.delta', { text: 'd', itemId: 'i2' })
    const out = compactHistory([ev('message.delta', { text: 'x', itemId: 'i1' }), r1, orphan, other, same])
    assert.deepEqual(out.map((e) => e.data['text']), ['xab', 'cd'])
  })

  it('вывод инструмента не отдаётся (elided), вход — до TOOL_INPUT_CHARS с флагом; реплики целиком', () => {
    const long = 'x'.repeat(TOOL_INPUT_CHARS + 50)
    const called = ev('tool.called', { toolUseId: 'u', name: 'Write', input: { file_path: '/a', content: long } })
    const short = ev('tool.called', { toolUseId: 'v', name: 'Bash', input: { command: 'ls' } })
    const fin = ev('tool.finished', { toolUseId: 'u', content: 'y'.repeat(10_000), isError: false, exitCode: 0 })
    const finNoContent = ev('tool.finished', { toolUseId: 'v', isError: true })
    const user = ev('message.user', { text: 'z'.repeat(OTHER_CHARS * 3) })
    const done = ev('message.done', { text: 'w'.repeat(OTHER_CHARS * 3) })
    const out = compactHistory([called, short, fin, finNoContent, user, done])
    assert.equal((out[0]?.data['input'] as Record<string, string>)['content'], `${'x'.repeat(TOOL_INPUT_CHARS)}…`)
    assert.equal(out[0]?.data['inputElided'], true)
    assert.equal(out[1]?.data['inputElided'], undefined)
    assert.deepEqual(out[2]?.data, { toolUseId: 'u', isError: false, exitCode: 0, elided: true })
    assert.deepEqual(out[3]?.data, { toolUseId: 'v', isError: true })
    assert.equal((out[4]?.data['text'] as string).length, OTHER_CHARS * 3)
    assert.equal((out[5]?.data['text'] as string).length, OTHER_CHARS * 3)
  })
})

describe('хранилище: снимок, файл сессии, номера', () => {
  it('снимок — последнее событие SNAPSHOT_KINDS по сессии и время активности без дельт; переживает переоткрытие', () => {
    const home = tempHome()
    try {
      const st = createStore(home.paths)
      st.append({ sessionId: 'a', provider: 'claude', kind: 'context.updated', data: { used: 1 }, ts: '2026-10-14T10:00:00.000Z' })
      st.append({ sessionId: 'a', provider: 'claude', kind: 'message.user', data: { text: 'q' }, ts: '2026-10-14T10:01:00.000Z' })
      st.append({ sessionId: 'a', provider: 'claude', kind: 'context.updated', data: { used: 2 }, ts: '2026-10-14T10:02:00.000Z' })
      st.append({ sessionId: 'a', provider: 'claude', kind: 'message.delta', data: { text: 'x' }, ts: '2026-10-14T10:03:00.000Z' })
      st.append({ sessionId: 'b', provider: 'claude', kind: 'usage.updated', data: {}, ts: '2026-10-14T10:04:00.000Z' })
      const check = (snap: ReturnType<typeof st.snapshot>): void => {
        assert.deepEqual(snap.events.map((e) => [e.sessionId, e.kind, e.data['used'] ?? null]), [['a', 'context.updated', 2], ['b', 'usage.updated', null]])
        assert.deepEqual(snap.activity, { a: '2026-10-14T10:01:00.000Z', b: '2026-10-14T10:04:00.000Z' })
        assert.equal(snap.cursor, 5)
      }
      check(st.snapshot())
      st.close()
      const again = createStore(home.paths)
      check(again.snapshot())
      again.close()
    } finally {
      home.remove()
    }
  })

  it('удаление сессии (session.ended rm) убирает её из снимка: новая с тем же именем не наследует фон', () => {
    const home = tempHome()
    try {
      const st = createStore(home.paths)
      st.append({ sessionId: 'x', provider: 'claude', kind: 'background.changed', data: { count: 2 } })
      st.append({ sessionId: 'x', provider: 'claude', kind: 'session.ended', data: { reason: 'rm' } })
      assert.deepEqual(st.snapshot().events, [])
      assert.equal(st.snapshot().activity['x'], undefined)
      st.close()
      const again = createStore(home.paths)
      assert.deepEqual(again.snapshot().events, [], 'после переоткрытия удалённая сессия вернулась в снимок')
      again.close()
    } finally {
      home.remove()
    }
  })

  it('readIds режет строку по переводу строки: мусор между индексированными строками событие не теряет', () => {
    const home = tempHome()
    try {
      const st = createStore(home.paths)
      st.append({ sessionId: 'a', provider: 'claude', kind: 'message.user', data: { text: 'первое' } })
      st.close()
      appendFileSync(home.paths.journal, 'мусор от чужой руки\n')
      const again = createStore(home.paths)
      again.append({ sessionId: 'a', provider: 'claude', kind: 'message.user', data: { text: 'второе' } })
      assert.deepEqual(again.readIds([1, 2]).map((e) => e.data['text']), ['первое', 'второе'])
      again.close()
    } finally {
      home.remove()
    }
  })

  it('readSession — только своя сессия, по порядку; readIds — по номерам, неизвестные пропускаются', () => {
    const home = tempHome()
    try {
      const st = createStore(home.paths)
      for (let i = 0; i < 5; i++) st.append({ sessionId: i % 2 ? 'b' : 'a', provider: 'claude', kind: 'message.user', data: { text: `t${i}` } })
      assert.deepEqual(st.readSession('a').map((e) => e.data['text']), ['t0', 't2', 't4'])
      assert.deepEqual(st.readSession('нет').length, 0)
      assert.deepEqual(st.readIds([4, 999, 1]).map((e) => [e.id, e.data['text']]), [[4, 't3'], [1, 't0']])
      assert.ok(GET_LIMIT >= 2)
      st.close()
    } finally {
      home.remove()
    }
  })
})

describe('readLatestHistoryPage', () => {
  for (const inheritedAgent of [false, true]) {
    it(inheritedAgent ? 'восстанавливает область дельт субагента из начала журнала' : 'читает первую страницу с конца и сохраняет её границы', () => {
      const home = tempHome()
      const store = createStore(home.paths)
      try {
        const append = (kind: PultEvent['kind'], data: PultEvent['data'], parentId?: string): void => {
          store.append({ sessionId: 's', provider: 'claude', kind, data, ...(parentId ? { parentId } : {}) })
        }
        append('agent.spawned', { toolUseId: 'worker' })
        append('tool.finished', { toolUseId: 'big', content: 'я'.repeat(3 * HISTORY_PAGE_BYTES) })
        for (let i = 0; i < 8; i++) {
          append('message.user', { text: `ход ${i}` })
          append('message.delta', { text: 'основной текст' })
          if (inheritedAgent) append('message.delta', { text: 'текст субагента' }, 'worker')
          append('message.done', { text: 'готово '.repeat(90) })
        }
        const all = compactHistory(store.readSession('s'))
        const budget = 1024
        const expected = pageHistory(all, null, budget)
        assert.ok(expected.more)
        const { bytesRead } = store.stats()
        const actual = readLatestHistoryPage(store, 's', budget)
        assert.deepEqual(actual, inheritedAgent ? null : expected)
        assert.equal(store.stats().bytesRead - bytesRead, 4 * HISTORY_PAGE_BYTES)
      } finally {
        store.close()
        home.remove()
      }
    })
  }
})

describe('RPC окна: events.snapshot | history | get', () => {
  it('снимок с курсором, лёгкая история сессии, полные события по номерам; кривые параметры — invalid_params', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      daemon.emit({ sessionId: 'w', provider: 'claude', kind: 'tool.called', data: { toolUseId: 'u', name: 'Read', input: { file_path: '/x' } } })
      const fin = daemon.emit({ sessionId: 'w', provider: 'claude', kind: 'tool.finished', data: { toolUseId: 'u', content: 'секрет вывода' } })
      daemon.emit({ sessionId: 'w', provider: 'claude', kind: 'context.updated', data: { used: 10 } })
      const conn = await rawConnect(home.paths)
      conn.send({ type: 'hello', token: readToken(home.paths.token), client: 'cli', protocol: PROTOCOL_VERSION })
      await conn.next()
      const rpc = async (id: number, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
        conn.send({ id, method, params })
        return conn.next()
      }
      const snap = (await rpc(1, 'events.snapshot'))['result'] as { events: PultEvent[]; cursor: number; activity: Record<string, string> }
      assert.ok(snap.events.some((e) => e.kind === 'context.updated' && e.sessionId === 'w'))
      assert.ok(snap.events.some((e) => e.kind === 'daemon.started'))
      assert.equal(snap.cursor, fin.id + 1)
      assert.ok(snap.activity['w'])

      const hist = (await rpc(2, 'events.history', { sessionId: 'w' }))['result'] as { events: PultEvent[]; cursor: number }
      assert.deepEqual(hist.events.map((e) => e.kind), ['tool.called', 'tool.finished', 'context.updated'])
      assert.equal(hist.events[1]?.data['content'], undefined)
      assert.equal(hist.events[1]?.data['elided'], true)
      assert.equal(hist.cursor, snap.cursor)

      const full = (await rpc(3, 'events.get', { ids: [fin.id] }))['result'] as { events: PultEvent[] }
      assert.equal(full.events[0]?.data['content'], 'секрет вывода')

      // Страницы: малый бюджет — с конца, с флагом «есть раньше»; before листает назад.
      for (let i = 0; i < 3; i++) {
        daemon.emit({ sessionId: 'p', provider: 'claude', kind: 'message.user', data: { text: `ход ${i} ${'x'.repeat(600)}` } })
        daemon.emit({ sessionId: 'p', provider: 'claude', kind: 'message.done', data: { text: `ответ ${i}` } })
      }
      const last = (await rpc(7, 'events.history', { sessionId: 'p', budget: 1024 }))['result'] as { events: PultEvent[]; more: boolean; oldest: number }
      assert.equal(last.more, true)
      assert.equal(last.events[0]?.kind, 'message.user')
      assert.match(String(last.events[0]?.data['text']), /^ход 2/)
      const prev = (await rpc(8, 'events.history', { sessionId: 'p', budget: 1024, before: last.oldest }))['result'] as { events: PultEvent[]; more: boolean }
      assert.match(String(prev.events[0]?.data['text']), /^ход 1/)

      // events.get урезает гигантские строки: ответ не перерастёт строку клиента (1 МиБ).
      const huge = daemon.emit({ sessionId: 'w', provider: 'claude', kind: 'tool.finished', data: { toolUseId: 'h', content: 'z'.repeat(300_000) } })
      const got = (await rpc(9, 'events.get', { ids: [huge.id] }))['result'] as { events: PultEvent[] }
      assert.ok(String(got.events[0]?.data['content']).length <= 100_001)

      assert.equal(((await rpc(4, 'events.history', {}))['error'] as Record<string, unknown>)['code'], 'invalid_params')
      assert.equal(((await rpc(5, 'events.get', { ids: [] }))['error'] as Record<string, unknown>)['code'], 'invalid_params')
      assert.equal(((await rpc(6, 'events.get', { ids: Array.from({ length: GET_LIMIT + 1 }, (_, i) => i + 1) }))['error'] as Record<string, unknown>)['code'], 'invalid_params')
      conn.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })
})
