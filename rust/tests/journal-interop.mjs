import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
for (const file of ['dist/cli/client.js', 'dist/core/store.js']) {
  assert.ok(existsSync(join(root, file)), 'Run npm ci && npm run build before Rust journal interoperability tests')
}
const { connectClient } = await import(new URL('../../dist/cli/client.js', import.meta.url))
const { layout } = await import(new URL('../../dist/core/paths.js', import.meta.url))
const { createStore, sessionFileName } = await import(new URL('../../dist/core/store.js', import.meta.url))
const { EVENT_KINDS } = await import(new URL('../../dist/core/events.js', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync(join(tmpdir(), 'r2j-'))
chmodSync(scratch, 0o700)
const paths = layout(join(scratch, 'home'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const children = new Set()
const clients = new Set()
let daemon
let client
let passed = 0

function launch(home = paths.home, testMode = true) {
  const child = spawn(binary, ['--home', home, 'daemon', 'serve'], {
    env: { ...process.env, PULT_TEST: testMode ? '1' : '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-8192) })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const handle = { child, exited, get stderr() { return stderr } }
  children.add(handle)
  exited.then(() => children.delete(handle), () => children.delete(handle))
  return handle
}

async function ready(process) {
  const deadline = Date.now() + 5000
  let lastError
  while (Date.now() < deadline) {
    assert.ok(process.child.exitCode === null && process.child.signalCode === null,
      `Rust daemon exited during startup\n${process.stderr}`)
    if (existsSync(paths.sock) && existsSync(paths.token)) {
      try {
        const candidate = await connectClient(paths, { timeoutMs: 500 })
        clients.add(candidate)
        const status = await candidate.request('daemon.status', {}, { timeoutMs: 500 })
        if (status.pid === process.child.pid) return candidate
        candidate.close()
        clients.delete(candidate)
      } catch (error) { lastError = error }
    }
    await pause(10)
  }
  throw new Error(`Rust journal startup deadline ${lastError ?? ''}\n${process.stderr}`)
}

async function start(testMode = true) {
  daemon = launch(paths.home, testMode)
  client = await ready(daemon)
}

async function stop() {
  assert.deepEqual(await client.request('daemon.stop', {}, { timeoutMs: 2000 }), { stopping: true })
  client.close()
  clients.delete(client)
  assert.equal((await daemon.exited).code, 0, daemon.stderr)
}

async function check(name, run) {
  await run()
  passed++
  console.log(`pass ${name}`)
}

async function cleanup() {
  for (const connection of clients) connection.close()
  clients.clear()
  await Promise.all([...children].map(async (process) => {
    process.child.kill('SIGTERM')
    const timer = setTimeout(() => process.child.kill('SIGKILL'), 1500)
    try { await process.exited } finally { clearTimeout(timer) }
  }))
  rmSync(scratch, { recursive: true, force: true })
}

const watchdog = setTimeout(async () => {
  console.error('journal interoperability deadline exceeded')
  await cleanup()
  process.exit(1)
}, 50_000)

try {
  await start()
  await check('empty journal uses existing tail wire shape', async () => {
    assert.deepEqual(await client.request('events.tail'), { events: [], cursor: 0 })
    assert.equal((await client.request('daemon.status')).lastEventId, 0)
  })
  await check('test emit persists Unicode data, parent and interleaved sessions', async () => {
    const first = await client.request('events.emit', {
      kind: 'message.user', sessionId: 'chat-a', provider: 'codex', parentId: 'parent-α',
      count: 2.3, data: { text: 'Привет 🌊 e\u0301', futureField: { nested: [null, false, 12] } },
    })
    assert.deepEqual(first, { ids: [1, 2, 3], lastEventId: 3 })
    const second = await client.request('events.emit', {
      kind: 'message.done', sessionId: 'chat-b', provider: 'claude', count: -2,
      data: { text: '別の会話' },
    })
    assert.deepEqual(second, { ids: [4], lastEventId: 4 })
    const { events, cursor } = await client.request('events.tail')
    assert.equal(cursor, 4)
    assert.deepEqual(events.map((event) => event.id), [1, 2, 3, 4])
    assert.deepEqual(events.slice(0, 3).map((event) => event.data.n), [0, 1, 2])
    assert.equal(events[0].data.text, 'Привет 🌊 e\u0301')
    assert.equal(events[0].parentId, 'parent-α')
    assert.equal(events[0].provider, 'codex')
    assert.ok(Number.isFinite(Date.parse(events[0].ts)))
    assert.equal((await client.request('daemon.status')).lastEventId, 4)
  })
  await check('Node store reads Rust global journal and session projections', async () => {
    const expected = (await client.request('events.tail')).events
    await stop()
    const node = createStore(paths)
    try {
      assert.equal(node.lastId, 4)
      assert.deepEqual(node.readFrom(0), expected)
      assert.deepEqual(node.readSession('chat-a'), expected.filter((event) => event.sessionId === 'chat-a'))
      assert.deepEqual(node.readSession('chat-b'), expected.filter((event) => event.sessionId === 'chat-b'))
    } finally { node.close() }
  })
  await check('Rust replays Node-produced legacy records including ID gaps and future fields', async () => {
    const node = createStore(paths)
    let records
    try {
      node.append({ sessionId: 'chat-a', provider: 'zcode', kind: 'tool.finished',
        parentId: 'legacy-parent', ts: '2026-01-02T03:04:05.678Z',
        data: { path: 'проект/файл.ts', future: { result: '✅' } } })
      records = node.readFrom(0)
    } finally { node.close() }
    records.at(-1).id = 8
    records.at(-1).kind = 'future.event.kind'
    records.at(-1).data.text = '🌊'.slice(0, 1)
    records.at(-1).extension = { version: 2, utf16: '\udc00' }
    records[1].sessionId = 'legacy-' + String.fromCharCode(0xd83c)
    writeFileSync(paths.journal, records.map((event) => JSON.stringify(event) + '\n').join(''), { mode: 0o600 })
    // Keep the human-readable per-session projections aligned with this legacy fixture.
    for (const sessionId of new Set(records.map((event) => event.sessionId))) {
      writeFileSync(join(paths.events, sessionFileName(sessionId)),
        records.filter((event) => event.sessionId === sessionId).map((event) => JSON.stringify(event) + '\n').join(''), { mode: 0o600 })
    }
    const reopened = createStore(paths)
    let expected
    try { expected = reopened.readFrom(0) } finally { reopened.close() }
    await start()
    assert.deepEqual(await client.request('events.tail'), { events: expected, cursor: 8 })
    const cli = execFileSync(binary, ['--home', paths.home, 'events', 'tail', '--json', '--no-follow', '--limit', '20'],
      { encoding: 'utf8', timeout: 3000 })
    assert.deepEqual(cli.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)), expected)
    assert.equal((await client.request('daemon.status')).lastEventId, 8)
  })
  await check('tail filtering and numeric edges match current Node store', async () => {
    const node = createStore(paths)
    try {
      for (const params of [
        { since: 3 }, { since: 1.5 }, { since: -0.5 }, { since: 100 },
        { sessionId: 'chat-a', since: 2, limit: 1 }, { sessionId: 'missing' },
        { limit: 0 }, { limit: -1 }, { limit: 1.2 },
        { since: '3', limit: '1', sessionId: 42 },
      ]) {
        const expected = node.readFrom(typeof params.since === 'number' ? params.since : 0, {
          ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
          ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
        })
        assert.deepEqual(await client.request('events.tail', params), { events: expected, cursor: node.lastId }, JSON.stringify(params))
      }
    } finally { node.close() }
  })
  await check('acknowledged events survive SIGKILL and continue the existing cursor', async () => {
    const accepted = await client.request('events.emit', { kind: 'status.changed', sessionId: 'chat-b', data: { status: 'idle' } })
    assert.deepEqual(accepted, { ids: [9], lastEventId: 9 })
    const expected = await client.request('events.tail')
    client.close()
    clients.delete(client)
    daemon.child.kill('SIGKILL')
    assert.equal((await daemon.exited).signal, 'SIGKILL')
    await start()
    assert.deepEqual(await client.request('events.tail'), expected)
    assert.deepEqual(await client.request('events.emit', { kind: 'message.done' }), { ids: [10], lastEventId: 10 })
  })
  await check('only an incomplete final line is discarded during restart', async () => {
    const expected = await client.request('events.tail')
    await stop()
    const complete = readFileSync(paths.journal)
    appendFileSync(paths.journal, Buffer.from('{"id":11,"data":{"text":"обрыв 🌊'))
    await start()
    assert.deepEqual(await client.request('events.tail'), expected)
    assert.deepEqual(readFileSync(paths.journal), complete)
    assert.deepEqual(await client.request('events.emit', { kind: 'message.done' }), { ids: [11], lastEventId: 11 })
  })
  await check('test-only emit is unavailable in normal mode and validates kinds', async () => {
    await assert.rejects(client.request('events.emit', { kind: 'invented.kind' }), (error) => error.code === 'invalid_params')
    await stop()
    await start(false)
    await assert.rejects(client.request('events.emit', { kind: 'message.done' }), (error) => error.code === 'not_found')
    assert.equal((await client.request('events.tail')).cursor, 11)
    await stop()
  })
  await check('every current Node event kind is catalogued and accepted by Rust', async () => {
    await start()
    const catalog = await client.request('protocol.catalog')
    const emit = catalog.methods.find((method) => method.name === 'events.emit')
    assert.deepEqual([...emit.paramsSchema.properties.kind.enum].sort(), [...EVENT_KINDS].sort())
    const before = (await client.request('daemon.status')).lastEventId
    for (const kind of EVENT_KINDS) {
      const result = await client.request('events.emit', { kind, sessionId: 'dictionary', data: { kind } })
      assert.equal(result.ids.length, 1, kind)
    }
    const replay = await client.request('events.tail', { since: before, sessionId: 'dictionary' })
    assert.deepEqual(replay.events.map((event) => event.kind), EVENT_KINDS)
    assert.equal(replay.cursor, before + EVENT_KINDS.length)
  })
  await check('concurrent owner clients receive unique durable IDs in replay order', async () => {
    const before = (await client.request('daemon.status')).lastEventId
    const writers = await Promise.all(Array.from({ length: 4 }, async () => {
      const writer = await connectClient(paths)
      clients.add(writer)
      return writer
    }))
    let accepted
    try {
      accepted = await Promise.all(writers.flatMap((writer, owner) =>
        Array.from({ length: 4 }, (_, request) => writer.request('events.emit', {
          kind: 'message.delta', sessionId: 'parallel', count: 3, data: { owner, request },
        }))))
    } finally {
      for (const writer of writers) { writer.close(); clients.delete(writer) }
    }
    const ids = accepted.flatMap((result) => result.ids).sort((a, b) => a - b)
    assert.deepEqual(ids, Array.from({ length: 48 }, (_, i) => before + i + 1))
    assert.equal(new Set(ids).size, ids.length)
    const expected = await client.request('events.tail', { since: before })
    assert.deepEqual(expected.events.map((event) => event.id), ids)
    assert.equal(expected.cursor, ids.at(-1))
    await stop()
    await start()
    assert.deepEqual(await client.request('events.tail', { since: before }), expected)
  })
  await check('Rust events CLI filters the same persisted page as RPC', async () => {
    const params = { since: 3, sessionId: 'chat-a', limit: 2 }
    const expected = await client.request('events.tail', params)
    const output = execFileSync(binary, ['--home', paths.home, 'events', 'tail', '--json', '--no-follow',
      '--since', String(params.since), '--session', params.sessionId, '--limit', String(params.limit)],
    // Filtered replay can end below the global cursor; TS no-follow then uses
    // its 3s fallback. Allow that product timer plus CLI startup/cleanup margin.
    { encoding: 'utf8', timeout: 6000 })
    assert.deepEqual(output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)), expected.events)
    const node = createStore(paths)
    try { assert.equal(expected.cursor, node.lastId) } finally { node.close() }
  })
  await check('oversized tail fails explicitly while the connection and limited replay remain usable', async () => {
    const before = (await client.request('daemon.status')).lastEventId
    const accepted = await client.request('events.emit', {
      kind: 'message.delta', sessionId: 'large-page', count: 24,
      data: { text: 'x'.repeat(64 * 1024) },
    })
    assert.equal(accepted.ids.length, 24)
    await assert.rejects(client.request('events.tail', { since: before }),
      (error) => error.code === 'internal' && /frame budget/.test(error.message))
    assert.equal((await client.request('daemon.status')).lastEventId, before + 24)
    const limited = await client.request('events.tail', { since: before, sessionId: 'large-page', limit: 2 })
    assert.deepEqual(limited.events.map((event) => event.id), [before + 1, before + 2])
    assert.equal(limited.cursor, before + 24)
    assert.equal(limited.events[0].data.text.length, 64 * 1024)
    await stop()
  })
  await check('complete corruption refuses startup and preserves every byte', async () => {
    const complete = readFileSync(paths.journal)
    const newline = complete.indexOf(10) + 1
    const corrupt = Buffer.concat([complete.subarray(0, newline), Buffer.from('{broken}\n'), complete.subarray(newline), Buffer.from('partial tail')])
    writeFileSync(paths.journal, corrupt)
    const failed = launch()
    assert.notEqual((await failed.exited).code, 0)
    assert.deepEqual(readFileSync(paths.journal), corrupt)
    assert.match(failed.stderr, /journal|record|corrupt/i)
    const unmarked = join(scratch, 'unmarked')
    mkdirSync(join(unmarked, 'events'), { recursive: true, mode: 0o700 })
    const original = Buffer.from('{"id":1}\n')
    writeFileSync(join(unmarked, 'events/journal.jsonl'), original, { mode: 0o600 })
    assert.notEqual((await launch(unmarked).exited).code, 0)
    assert.deepEqual(readFileSync(join(unmarked, 'events/journal.jsonl')), original)
  })
  console.log(`journal interop passed ${passed}`)
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
