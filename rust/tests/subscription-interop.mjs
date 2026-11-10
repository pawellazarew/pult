import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
for (const file of ['dist/cli/client.js', 'dist/core/store.js', 'dist/core/history.js']) {
  assert.ok(existsSync(join(root, file)), 'Run npm ci && npm run build before subscription interoperability tests')
}
const { connectClient } = await import(new URL('../../dist/cli/client.js', import.meta.url))
const { layout } = await import(new URL('../../dist/core/paths.js', import.meta.url))
const { createStore } = await import(new URL('../../dist/core/store.js', import.meta.url))
const { createLineSplitter } = await import(new URL('../../dist/core/ndjson.js', import.meta.url))
const { fitEvent } = await import(new URL('../../dist/core/history.js', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync(join(tmpdir(), 'r2s-'))
chmodSync(scratch, 0o700)
const paths = layout(join(scratch, 'home'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const children = new Set()
const clients = new Set()
const wires = new Set()
let daemon
let control
let passed = 0
let legacy
let giant
let afterGiant
let bulkIds
let lastFixtureId
const LIVE_BASE = 2 ** 50
const BULK_RECORDS = 2048

async function until(check, message, timeout = 5000, interval = 10) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(interval)
  }
  throw new Error(message)
}

function launch() {
  const child = spawn(binary, ['--home', paths.home, 'daemon', 'serve'], {
    env: { ...process.env, PULT_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
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

async function connect() {
  const client = await connectClient(paths, { timeoutMs: 1000 })
  clients.add(client)
  return client
}
function close(client) {
  client.close()
  clients.delete(client)
}

async function start() {
  daemon = launch()
  await until(async () => {
    assert.ok(daemon.child.exitCode === null && daemon.child.signalCode === null,
      `daemon exited during startup\n${daemon.stderr}`)
    if (!existsSync(paths.sock) || !existsSync(paths.token)) return false
    let candidate
    try {
      candidate = await connect()
      const status = await candidate.request('daemon.status', {}, { timeoutMs: 1000 })
      if (status.pid === daemon.child.pid) { control = candidate; return true }
    } catch { /* the old stale socket may still be getting replaced */ }
    if (candidate) close(candidate)
    return false
  }, `daemon startup deadline\n${daemon.stderr}`, 8000)
}

async function stop() {
  assert.deepEqual(await control.request('daemon.stop', {}, { timeoutMs: 3000 }), { stopping: true })
  close(control)
  assert.equal((await daemon.exited).code, 0, daemon.stderr)
}

async function raw() {
  const socket = net.connect(paths.sock)
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const splitter = createLineSplitter()
  const queue = []
  const waiters = []
  let closed = false
  const finish = () => {
    closed = true
    while (waiters.length) waiters.shift().reject(new Error('raw socket closed'))
  }
  socket.on('error', () => {})
  socket.on('close', finish)
  socket.on('data', (bytes) => {
    try {
      for (const line of splitter.push(bytes)) {
        const value = JSON.parse(line)
        if (waiters.length) waiters.shift().resolve(value)
        else queue.push(value)
      }
    } catch (error) {
      while (waiters.length) waiters.shift().reject(error)
      socket.destroy()
    }
  })
  const wire = {
    socket,
    get closed() { return closed },
    send(frame) { socket.write(JSON.stringify(frame) + '\n') },
    next(timeout = 5000) {
      if (queue.length) return Promise.resolve(queue.shift())
      if (closed) return Promise.reject(new Error('raw socket closed'))
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(value) { clearTimeout(timer); resolve(value) },
          reject(error) { clearTimeout(timer); reject(error) },
        }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('raw frame deadline'))
        }, timeout)
        waiters.push(waiter)
      })
    },
    destroy() { socket.destroy(); wires.delete(wire) },
  }
  wires.add(wire)
  wire.send({ type: 'hello', protocol: 1, token: readFileSync(paths.token, 'utf8'), client: 'cli' })
  assert.equal((await wire.next()).type, 'hello_ok')
  return wire
}

async function check(name, run) {
  await run()
  passed++
  console.log(`pass ${name}`)
}

async function noSubscriptions() {
  await until(async () => (await control.request('daemon.status', {}, { timeoutMs: 2000 })).subscriptions === 0,
    'subscriptions leaked after cancellation', 5000)
}

async function cleanup() {
  for (const wire of wires) wire.socket.destroy()
  for (const client of clients) client.close()
  wires.clear()
  clients.clear()
  await Promise.all([...children].map(async (process) => {
    process.child.kill('SIGTERM')
    const timer = setTimeout(() => process.child.kill('SIGKILL'), 1500)
    try { await process.exited } finally { clearTimeout(timer) }
  }))
  rmSync(scratch, { recursive: true, force: true })
}

function rssKiB() {
  return Number(execFileSync('/bin/ps', ['-p', String(daemon.child.pid), '-o', 'rss='], { encoding: 'utf8', timeout: 2000 }).trim())
}

const watchdog = setTimeout(async () => {
  console.error('subscription interoperability deadline exceeded')
  await cleanup()
  process.exit(1)
}, 85_000)

try {
  // Bootstrap the real scratch marker before the legacy Node writer creates data.
  await start()
  await stop()
  let store = createStore(paths)
  legacy = [
    store.append({ sessionId: 'legacy', provider: 'codex', kind: 'message.done', data: { text: 'Привет 🌊' } }),
    store.append({ sessionId: 'other', provider: 'claude', kind: 'message.done', data: { text: '别の会話' } }),
    store.append({ sessionId: 'legacy', provider: 'codex', kind: 'message.done', data: { text: '🌊'.slice(0, 1), unknown: { utf16: '\udc00' } } }),
  ]
  store.close()
  legacy[1].id = 3
  legacy[2].id = 7
  legacy[2].kind = 'future.event.kind'
  legacy[2].extension = { future: true }
  writeFileSync(paths.journal, legacy.map((event) => JSON.stringify(event) + '\n').join(''), { mode: 0o600 })
  store = createStore(paths)
  bulkIds = []
  const text = 'b'.repeat(32 * 1024)
  for (let n = 0; n < BULK_RECORDS; n++) {
    bulkIds.push(store.append({ sessionId: 'bulk', provider: 'pult', kind: 'message.done', data: { n, text } }).id)
  }
  giant = store.append({ sessionId: 'giant', provider: 'codex', kind: 'message.done',
    data: { text: 'a' + '🌊'.repeat(350_000), half: '🌊'.slice(0, 1), nested: ['終わり'] } })
  afterGiant = store.append({ sessionId: 'giant', provider: 'pult', kind: 'message.done', data: { text: 'after giant' } })
  lastFixtureId = store.lastId
  store.close()
  await start()

  await check('subscribe ACK precedes frames and legacy replay preserves gaps and UTF-16', async () => {
    const wire = await raw()
    wire.send({ id: 'ack-order', method: 'events.subscribe', params: { since: 0, sessionId: 'legacy' } })
    const first = await wire.next()
    assert.equal(first.id, 'ack-order')
    assert.deepEqual(first.result, { sub: 1, cursor: lastFixtureId })
    assert.deepEqual((await wire.next()).event, legacy[0])
    assert.deepEqual((await wire.next()).event, legacy[2])
    wire.destroy()
    await noSubscriptions()
  })

  await check('filtered TypeScript client replay and per-connection subscription IDs', async () => {
    const left = await connect()
    const right = await connect()
    const events = []
    const a = await left.subscribe({ since: 1.5, sessionId: 'legacy' }, (event) => events.push(event))
    const b = await left.subscribe({ since: lastFixtureId }, () => {})
    const c = await right.subscribe({ since: lastFixtureId }, () => {})
    assert.equal(a.sub, 1)
    assert.equal(b.sub, 2)
    assert.equal(c.sub, 1)
    await until(() => events.length === 1, 'filtered legacy event missing')
    assert.deepEqual(events[0], legacy[2])
    assert.deepEqual(await left.request('events.unsubscribe', { sub: a.sub }), { removed: true })
    assert.deepEqual(await left.request('events.unsubscribe', { sub: a.sub }), { removed: false })
    await assert.rejects(left.request('events.unsubscribe', { sub: '1' }), (error) => error.code === 'invalid_params')
    close(left)
    close(right)
    await noSubscriptions()
  })

  await check('active subscription cap bounds producers and releases reusable capacity', async () => {
    const subscriber = await connect()
    const subscriptions = []
    for (let n = 0; n < 32; n++) {
      subscriptions.push(await subscriber.subscribe({ live: true }, () => {}))
    }
    await assert.rejects(subscriber.subscribe({ live: true }, () => {}),
      (error) => error.code === 'invalid_params' && /32|subscription/i.test(error.message))
    assert.equal((await subscriber.request('daemon.status', {}, { timeoutMs: 2000 })).subscriptions, 32)
    for (const subscription of subscriptions) {
      assert.deepEqual(await subscriber.request('events.unsubscribe', { sub: subscription.sub }), { removed: true })
    }
    await noSubscriptions()
    const reused = await subscriber.subscribe({ live: true }, () => {})
    assert.ok(reused.sub > subscriptions.at(-1).sub)
    assert.deepEqual(await subscriber.request('events.unsubscribe', { sub: reused.sub }), { removed: true })
    close(subscriber)
    await noSubscriptions()
  })

  await check('future durable cursor suppresses history but still receives new committed events', async () => {
    const historical = await control.request('events.emit', { kind: 'message.done', sessionId: 'future-cursor' })
    const since = historical.lastEventId + 1000
    assert.ok(since < LIVE_BASE)
    const subscriber = await connect()
    const events = []
    const subscription = await subscriber.subscribe({ since, sessionId: 'future-cursor' }, (event) => events.push(event))
    await subscriber.request('daemon.status', {}, { timeoutMs: 2000 })
    await pause(50)
    assert.deepEqual(events, [], 'future cursor replayed old history')
    const appended = await control.request('events.emit', { kind: 'message.done', sessionId: 'future-cursor' })
    assert.ok(appended.ids[0] < since)
    await until(() => events.length === 1, 'future cursor suppressed a new live event')
    assert.deepEqual(events.map((event) => event.id), appended.ids)
    assert.deepEqual(await subscriber.request('events.unsubscribe', { sub: subscription.sub }), { removed: true })
    close(subscriber)
    await noSubscriptions()
  })

  await check('history and concurrent committed events meet without gaps or duplicates', async () => {
    const subscriber = await connect()
    const writers = await Promise.all(Array.from({ length: 4 }, () => connect()))
    const idsReceived = []
    const newlyReceived = []
    const subPromise = subscriber.subscribe({ since: 0, sessionId: 'bulk' }, (event) => {
      idsReceived.push(event.id)
      if (event.id > lastFixtureId) newlyReceived.push(event)
    })
    const writes = writers.flatMap((writer, index) => Array.from({ length: 4 }, (_, turn) =>
      writer.request('events.emit', { kind: 'message.done', sessionId: 'bulk', count: 3, data: { writer: index, turn } })))
    const sub = await subPromise
    const answers = await Promise.all(writes)
    const ids = answers.flatMap((answer) => answer.ids).sort((a, b) => a - b)
    await until(() => idsReceived.length >= BULK_RECORDS + 48, 'concurrent committed frames missing', 10_000)
    assert.deepEqual(idsReceived, [...bulkIds, ...ids])
    assert.equal(new Set(idsReceived).size, BULK_RECORDS + 48)
    const stored = await control.request('events.tail', { since: lastFixtureId, sessionId: 'bulk' })
    assert.deepEqual(newlyReceived, stored.events)
    bulkIds.push(...ids)
    assert.deepEqual(await subscriber.request('events.unsubscribe', { sub: sub.sub }), { removed: true })
    for (const writer of writers) close(writer)
    close(subscriber)
    await noSubscriptions()
  })

  await check('large replay stays responsive to status and unsubscribe on the same connection', async () => {
    const subscriber = await connect()
    const ids = []
    const sub = await subscriber.subscribe({ since: 0, sessionId: 'bulk' }, (event) => ids.push(event.id))
    await until(() => ids.length > 0, 'bulk replay never started')
    const status = await subscriber.request('daemon.status', {}, { timeoutMs: 2000 })
    assert.ok(status.subscriptions >= 1)
    assert.deepEqual(await subscriber.request('events.unsubscribe', { sub: sub.sub }, { timeoutMs: 2000 }), { removed: true })
    const settled = ids.length
    await pause(100)
    assert.equal(ids.length, settled, 'frames continued after unsubscribe acknowledgement')
    assert.ok(ids.length < bulkIds.length, 'replay monopolized the connection before RPC could execute')
    close(subscriber)
    await noSubscriptions()
  })

  await check('replay beyond writer backlog survives a paused then resumed reader', async () => {
    const wire = await raw()
    wire.send({ id: 1, method: 'events.subscribe', params: { since: 0, sessionId: 'bulk' } })
    const response = await wire.next()
    assert.equal(response.result.sub, 1)
    wire.socket.pause()
    await pause(250)
    assert.ok((await control.request('daemon.status', {}, { timeoutMs: 2000 })).subscriptions >= 1)
    wire.socket.resume()
    const ids = []
    while (ids.length < bulkIds.length) {
      const frame = await wire.next(10_000)
      assert.equal(frame.end, undefined, `paused reader was dropped ${JSON.stringify(frame.end)}`)
      if (frame.event) ids.push(frame.event.id)
    }
    assert.deepEqual(ids, bulkIds)
    wire.destroy()
    await noSubscriptions()
  })

  await check('oversized events match Node clipping while full journal data remains intact', async () => {
    const subscriber = await connect()
    const events = []
    const sub = await subscriber.subscribe({ since: giant.id - 1, sessionId: 'giant' }, (event) => events.push(event))
    await until(() => events.length >= 2, 'oversized event blocked following frame')
    const expected = fitEvent(giant)
    assert.equal(expected.data.text.charCodeAt(19_999), 0xd83c, 'fixture must cut through a surrogate pair')
    assert.deepEqual(events, [expected, afterGiant])
    assert.ok(Buffer.byteLength(JSON.stringify({ sub: sub.sub, event: events[0] })) < 1024 * 1024)
    const journal = readFileSync(paths.journal)
    const location = journal.indexOf(Buffer.from(`{"id":${giant.id},`))
    assert.ok(location >= 0, 'original giant journal row disappeared')
    const end = journal.indexOf(10, location)
    assert.deepEqual(JSON.parse(journal.subarray(location, end).toString()), giant)
    close(subscriber)
    await noSubscriptions()
  })

  await check('disconnect during replay releases subscription ownership', async () => {
    const subscriber = await connect()
    await subscriber.subscribe({ since: 0, sessionId: 'bulk' }, () => {})
    close(subscriber)
    await noSubscriptions()
    assert.equal((await control.request('daemon.status', {}, { timeoutMs: 2000 })).subscriptions, 0)
  })

  let liveCursor
  await check('live flag and high cursors produce reset without durable history', async () => {
    const before = (await control.request('daemon.status')).lastEventId
    const subscriber = await connect()
    const frames = []
    const first = await subscriber.subscribe({ since: 0, live: true, sessionId: 'ignored-filter' }, (event) => frames.push(event))
    await until(() => frames.length === 1, 'live reset missing')
    assert.equal(first.cursor, before)
    assert.deepEqual(frames[0].data, { reset: true })
    assert.equal(frames[0].kind, 'turn.phase')
    assert.equal(frames[0].sessionId, 'daemon')
    assert.equal(frames[0].provider, 'pult')
    assert.ok(frames[0].id > LIVE_BASE)
    liveCursor = frames[0].id + 100
    const secondFrames = []
    const second = await subscriber.subscribe({ since: liveCursor }, (event) => secondFrames.push(event))
    await until(() => secondFrames.length === 1, 'high-cursor live reset missing')
    assert.ok(secondFrames[0].id > liveCursor)
    liveCursor = secondFrames[0].id
    assert.equal((await control.request('daemon.status')).lastEventId, before)
    await subscriber.request('events.unsubscribe', { sub: first.sub })
    await subscriber.request('events.unsubscribe', { sub: second.sub })
    close(subscriber)
    await noSubscriptions()
  })

  await check('restart preserves durable cursor and advances live reset above saved cursor', async () => {
    const before = (await control.request('daemon.status')).lastEventId
    await stop()
    await start()
    const subscriber = await connect()
    const durable = []
    const live = []
    await subscriber.subscribe({ since: before, sessionId: 'after-restart' }, (event) => durable.push(event))
    await subscriber.subscribe({ since: liveCursor }, (event) => live.push(event))
    await until(() => live.length === 1, 'restart live reset missing')
    assert.ok(live[0].id > liveCursor)
    const result = await control.request('events.emit', { kind: 'message.done', sessionId: 'after-restart' })
    await until(() => durable.length === 1, 'restart durable frame missing')
    assert.deepEqual(durable.map((event) => event.id), result.ids)
    close(subscriber)
    await noSubscriptions()
  })

  await check('permanent non-reader is isolated with bounded memory and eventually removed', async () => {
    const baselineRss = rssKiB()
    let peakRss = baselineRss
    const wire = await raw()
    wire.send({ id: 1, method: 'events.subscribe', params: { since: 0, sessionId: 'bulk' } })
    assert.equal((await wire.next()).result.sub, 1)
    wire.socket.pause()
    const started = Date.now()
    await until(async () => {
      peakRss = Math.max(peakRss, rssKiB())
      const status = await control.request('daemon.status', {}, { timeoutMs: 2000 })
      return status.subscriptions === 0
    }, 'permanent non-reader was never detached', 36_000, 250)
    assert.ok(Date.now() - started < 36_000)
    assert.ok(peakRss - baselineRss < 48 * 1024,
      `blocked replay RSS grew ${(peakRss - baselineRss) / 1024} MiB over baseline`)
    console.log(`non-reader metrics ${JSON.stringify({ elapsedMs: Date.now() - started, baselineRssKiB: baselineRss, peakRssKiB: peakRss })}`)
    wire.socket.resume()
    let end
    try {
      while (!wire.closed) {
        const frame = await wire.next(3000)
        if (frame.end) { end = frame.end; break }
      }
    } catch (error) {
      assert.match(error.message, /closed/)
    }
    assert.ok(end?.code === 'slow_consumer' || wire.closed,
      'slow consumer neither received end nor closed')
    wire.destroy()
  })

  await check('daemon stop delivers end reason and removes outstanding subscriptions', async () => {
    const subscriber = await connect()
    const ends = []
    await subscriber.subscribe({ since: (await control.request('daemon.status')).lastEventId }, () => {}, (end) => ends.push(end))
    await control.request('daemon.stop', {}, { timeoutMs: 3000 })
    await until(() => ends.length === 1, 'shutdown end reason missing')
    assert.equal(ends[0].code, 'daemon_stopping')
    assert.equal((await daemon.exited).code, 0, daemon.stderr)
    close(subscriber)
    close(control)
    await start()
    assert.equal((await control.request('daemon.status')).subscriptions, 0)
  })

  await check('invalid subscribe shapes preserve the owner connection', async () => {
    const wire = await raw()
    wire.send({ id: 1, method: 'events.subscribe', params: { since: 'ignored', sessionId: 42, live: true } })
    assert.equal((await wire.next()).result.sub, 1)
    assert.equal((await wire.next()).event.kind, 'turn.phase')
    wire.send({ id: 2, method: 'events.unsubscribe', params: { sub: false } })
    assert.equal((await wire.next()).error.code, 'invalid_params')
    wire.destroy()
    await noSubscriptions()
  })
  await stop()
  console.log(`subscription interop passed ${passed}`)
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
