// Кэш лёгкой истории (src/core/historyCache.ts): страница большого чата не пересжимает весь файл сессии,
// пока он не менялся, и не отдаёт устаревшее, когда менялся.

import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'
import { createHistoryCache } from '../dist/core/historyCache.js'
import type { PultEvent } from '../dist/core/events.js'
import { PROTOCOL_VERSION } from '../dist/core/rpc.js'
import { readToken } from '../dist/core/token.js'
import { rawConnect, startTestDaemon, tempHome } from './helpers.js'

const ev = (id: number): PultEvent => ({ id, ts: '2026-11-06T10:00:00Z', sessionId: 's', provider: 'pult', kind: 'message.done', data: {} })

it('та же отметка файла — без повторного чтения; новая — читает заново; без файла — не кэширует', () => {
  const stamps: Record<string, string | null> = { a: '1', b: '1', gone: null }
  const loads: string[] = []
  const cache = createHistoryCache({ stamp: (id) => stamps[id] ?? null, load: (id) => { loads.push(id); return [ev(loads.length)] } })
  const first = cache.get('a')
  assert.equal(cache.get('a'), first)
  assert.deepEqual(loads, ['a'])
  stamps['a'] = '2'
  assert.notEqual(cache.get('a'), first)
  assert.deepEqual(loads, ['a', 'a'])
  cache.get('gone'); cache.get('gone')
  assert.deepEqual(loads, ['a', 'a', 'gone', 'gone'])
})

it('держит последние по использованию сессии, давнюю вытесняет', () => {
  const loads: string[] = []
  const cache = createHistoryCache({ stamp: () => 'x', load: (id) => { loads.push(id); return [] }, size: 2 })
  cache.get('a'); cache.get('b')
  cache.get('a') // a свежее b
  cache.get('c') // вытесняет b
  cache.get('a'); cache.get('c')
  assert.deepEqual(loads, ['a', 'b', 'c'])
  cache.get('b')
  assert.deepEqual(loads, ['a', 'b', 'c', 'b'])
})

it('демон: events.history видит дописанное в файл сессии и после того, как страница уже бралась', async () => {
  const home = tempHome()
  const daemon = await startTestDaemon(home)
  try {
    daemon.emit({ sessionId: 'w', provider: 'pult', kind: 'message.user', data: { text: 'первая' } })
    const conn = await rawConnect(home.paths)
    conn.send({ type: 'hello', token: readToken(home.paths.token), client: 'cli', protocol: PROTOCOL_VERSION })
    await conn.next()
    let id = 0
    const page = async (): Promise<string[]> => {
      conn.send({ id: ++id, method: 'events.history', params: { sessionId: 'w' } })
      return ((await conn.next())['result'] as { events: PultEvent[] }).events.map((e) => String(e.data['text']))
    }
    assert.deepEqual(await page(), ['первая'])
    daemon.emit({ sessionId: 'w', provider: 'pult', kind: 'message.user', data: { text: 'вторая' } })
    assert.deepEqual(await page(), ['первая', 'вторая'])
    // Файл переписали мимо emit (очистка, импорт): отметка другая — кэш не врёт.
    const file = join(home.paths.events, 'w.jsonl')
    writeFileSync(file, '')
    appendFileSync(file, `${JSON.stringify({ id: 1, ts: '2026-11-06T10:00:00Z', sessionId: 'w', provider: 'pult', kind: 'message.user', data: { text: 'другая' } })}\n`)
    assert.deepEqual(await page(), ['другая'])
    conn.end()
  } finally {
    await daemon.stop('тест')
    home.remove()
  }
})
