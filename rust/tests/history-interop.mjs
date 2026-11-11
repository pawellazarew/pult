import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
for (const file of ['dist/cli/client.js', 'dist/core/store.js', 'dist/core/history.js']) {
  assert.ok(existsSync(join(root, file)), 'Run npm ci && npm run build before history interoperability tests')
}
const { connectClient } = await import(new URL('../../dist/cli/client.js', import.meta.url))
const { layout } = await import(new URL('../../dist/core/paths.js', import.meta.url))
const { createStore, sessionFileName, GET_LIMIT } = await import(new URL('../../dist/core/store.js', import.meta.url))
const { compactHistory, pageHistory, clipEvent, HISTORY_PAGE_BYTES } = await import(new URL('../../dist/core/history.js', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync(join(tmpdir(), 'r2h-'))
chmodSync(scratch, 0o700)
const paths = layout(join(scratch, 'home'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const children = new Set()
const clients = new Set()
let daemon
let client
let passed = 0
let records = []
let snapshot
let oversizedId
const lonely = 'legacy-' + String.fromCharCode(0xd800)

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

async function start() {
  daemon = launch()
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    assert.ok(daemon.child.exitCode === null && daemon.child.signalCode === null,
      `Rust daemon exited during startup\n${daemon.stderr}`)
    if (existsSync(paths.sock) && existsSync(paths.token)) {
      let candidate
      try {
        candidate = await connectClient(paths, { timeoutMs: 1000 })
        const status = await candidate.request('daemon.status', {}, { timeoutMs: 1000 })
        if (status.pid === daemon.child.pid) {
          client = candidate
          clients.add(client)
          return
        }
      } catch { /* wait for the old socket to be replaced */ }
      candidate?.close()
    }
    await pause(10)
  }
  throw new Error(`Rust history startup deadline\n${daemon.stderr}`)
}

async function stop() {
  assert.deepEqual(await client.request('daemon.stop', {}, { timeoutMs: 3000 }), { stopping: true })
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
  await Promise.all([...children].map(async (handle) => {
    handle.child.kill('SIGTERM')
    const timer = setTimeout(() => handle.child.kill('SIGKILL'), 1500)
    try { await handle.exited } finally { clearTimeout(timer) }
  }))
  rmSync(scratch, { recursive: true, force: true })
}

function row(sessionId, kind, data = {}, extra = {}) {
  const event = {
    id: records.length + 1, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, records.length)).toISOString(),
    sessionId, provider: 'codex', kind, data, ...extra,
  }
  records.push(event)
  return event
}
function writeRows(file, events) {
  writeFileSync(file, events.map((event) => JSON.stringify(event) + '\n').join(''), { mode: 0o600 })
}
// Compare actual wire values: JSON.stringify normalizes -0 to 0 (as Node RPC does).
const wireValue = (value) => JSON.parse(JSON.stringify(value))
function expectedPage(sessionId, params = {}, events = records.filter((event) => event.sessionId === sessionId)) {
  const before = Number.isSafeInteger(params.before) ? params.before : null
  const budget = Number.isSafeInteger(params.budget)
    ? Math.max(1024, Math.min(params.budget, HISTORY_PAGE_BYTES)) : HISTORY_PAGE_BYTES
  return wireValue({ ...pageHistory(compactHistory(events), before, budget), cursor: records.at(-1)?.id ?? 0 })
}
function expectedGet(params) {
  const ids = params.ids.filter(Number.isSafeInteger).slice(0, GET_LIMIT)
  const events = []
  let bytes = 0
  let truncated = false
  for (const id of ids) {
    const original = records.find((event) => event.id === id)
    if (!original) continue
    const event = clipEvent(original, 100_000)
    const size = Buffer.byteLength(JSON.stringify(event))
    if (bytes + size > HISTORY_PAGE_BYTES && events.length) { truncated = true; break }
    bytes += size
    events.push(event)
  }
  return wireValue({ events, ...(truncated ? { truncated: true } : {}) })
}
function nodeSnapshot() {
  const node = createStore(paths)
  try { return wireValue(node.snapshot()) } finally { node.close() }
}

const watchdog = setTimeout(async () => {
  console.error('history interoperability deadline exceeded')
  await cleanup()
  process.exit(1)
}, 55_000)

try {
  await start()
  await check('empty snapshot, missing history and unknown IDs keep the Node wire shapes', async () => {
    assert.deepEqual(await client.request('events.snapshot'), { events: [], activity: {}, cursor: 0 })
    assert.deepEqual(await client.request('events.history', { sessionId: 'missing' }), { events: [], more: false, oldest: null, cursor: 0 })
    assert.deepEqual(await client.request('events.get', { ids: [0, -1, 1] }), { events: [] })
  })
  await stop()

  row('chat', 'daemon.started', { version: 'fixture' })
  row('chat', 'background.changed', { active: true })
  row('chat', 'context.updated', { tokens: 1 })
  row('chat', 'message.user', { text: 'Начало 🌊 e\u0301' })
  row('chat', 'message.delta', { text: '🌊 первая ', itemId: 'one' }, { extension: { raw: '\ud800' } })
  row('chat', 'message.delta', { text: 'часть', itemId: 'one' })
  row('chat', 'message.done', { text: '🌊 итог', itemId: 'one' })
  row('chat', 'message.delta', { text: 'До границы' })
  row('chat', 'status.changed', { status: 'working' })
  row('chat', 'message.done', { text: 'После границы' })
  row('chat', 'agent.spawned', { toolUseId: 'sub', name: 'subagent' })
  row('chat', 'message.delta', { text: 'root-A' })
  row('chat', 'message.delta', { text: 'sub-A', itemId: 's' }, { parentId: 'sub' })
  row('chat', 'message.delta', { text: 'root-B' }, { parentId: 'unknown-parent' })
  row('chat', 'message.delta', { text: 'sub-B', itemId: 's' }, { parentId: 'sub' })
  row('chat', 'message.delta', { text: 'different item', itemId: 'different' }, { parentId: 'sub' })
  row('chat', 'message.done', { text: '\u00a0\ufeff\u2029' }, { parentId: 'sub' })
  row('chat', 'message.delta', { text: '' })
  row('chat', 'tool.called', { input: { file: 'ф'.repeat(301), nested: ['🌊'.repeat(151)] }, name: 'Read', rest: 'a'.repeat(2001) })
  row('chat', 'tool.finished', { content: [{ text: 'x'.repeat(200_000) }], error: false, extra: '🌊'.repeat(1001) })
  row('chat', 'future.kind', { long: '🌊'.repeat(1001), raw: '\udc00', array: [{ text: 'x'.repeat(2001) }] }, { future: 'kept' })
  row('chat', 'permission.requested', { text: 'p'.repeat(2500) })
  row('chat', 'permission.resolved', { text: 'r'.repeat(2500) })
  row('chat', 'usage.updated', { limit: 100 })
  row('chat', 'limit.hit', { reason: 'quota' })
  row('chat', 'net.blocked', { country: 'fixture' })
  row('chat', 'context.updated', { tokens: 99 })
  row('deleted', 'background.changed', { active: true })
  row('deleted', 'usage.updated', { quota: 1 })
  row('deleted', 'session.ended', { reason: 'rm' })
  row('deleted', 'message.user', { text: 'new session using the old name' })
  row('journal', 'message.done', { text: 'reserved file name' })
  row('../../unsafe', 'message.done', { text: 'shared projection, unsafe name' })
  row('another unsafe', 'message.done', { text: 'must not leak into the other shared projection' })
  row(lonely, 'message.done', { text: '\ud800 and \udc00', nested: { raw: '\udfff' } })
  row(lonely, 'context.updated', { text: '\ud800' })
  row('chat', 'message.user', { text: 'pagination starts a new turn ' + 'з'.repeat(1100) })
  row('chat', 'message.done', { text: 'last reply ' + 'r'.repeat(1000) })
  const getIds = []
  for (let i = 0; i < 7; i++) getIds.push(row('get-large', 'tool.finished', { text: '🌊'.repeat(60_000), label: `large-${i}` }).id)
  const wideId = row('get-wide', 'future.kind', { values: Array(6).fill('w'.repeat(90_000)) }).id
  oversizedId = row('oversized', 'message.user', { text: 'x'.repeat(1_100_000) }).id
  writeRows(paths.journal, records)
  for (const filename of new Set(records.map((event) => sessionFileName(event.sessionId)))) {
    writeRows(join(paths.events, filename), records.filter((event) => sessionFileName(event.sessionId) === filename))
  }
  snapshot = nodeSnapshot()
  await start()

  await check('history compaction matches Node for scopes, items, UTF16, boundaries and tool elision', async () => {
    const expected = expectedPage('chat')
    const actual = await client.request('events.history', { sessionId: 'chat' })
    assert.deepEqual(actual, expected)
    assert.equal(actual.events.find((event) => event.id === 5).data.text, '\ud83c')
    assert.equal(actual.events.find((event) => event.kind === 'tool.finished').data.elided, true)
    assert.equal(actual.events.find((event) => event.kind === 'tool.called').data.inputElided, true)
    assert.equal(actual.events.find((event) => event.id === 5).extension.raw, '\ud800')
  })
  await check('history before and byte budgets match Node across numeric edges and turn boundaries', async () => {
    for (const params of [
      {}, { before: 0 }, { before: -1 }, { before: 12 }, { before: 12.5 }, { before: '12' },
      { before: Number.MAX_SAFE_INTEGER }, { before: Number.MAX_SAFE_INTEGER + 1 },
      { budget: -1 }, { budget: 0 }, { budget: 1024 }, { budget: 2048 }, { budget: 4096 },
      { budget: 2.5 }, { budget: '2048' }, { budget: HISTORY_PAGE_BYTES * 2 },
      { before: 36, budget: 1024 },
    ]) {
      assert.deepEqual(await client.request('events.history', { sessionId: 'chat', ...params }), expectedPage('chat', params), JSON.stringify(params))
    }
    let before
    const pages = []
    for (let n = 0; n < 100; n++) {
      const params = { budget: 1024, ...(before !== undefined ? { before } : {}) }
      const page = await client.request('events.history', { sessionId: 'chat', ...params })
      assert.deepEqual(page, expectedPage('chat', params))
      pages.unshift(...page.events)
      if (!page.more) break
      assert.ok(page.oldest !== null && (before === undefined || page.oldest < before))
      before = page.oldest
    }
    assert.deepEqual(pages, compactHistory(records.filter((event) => event.sessionId === 'chat')))
  })
  await check('read methods validate required arguments and filter safe integer get IDs', async () => {
    for (const params of [{}, { sessionId: '' }, { sessionId: null }, { sessionId: 1 }]) {
      await assert.rejects(client.request('events.history', params), (error) => error.code === 'invalid_params')
    }
    for (const params of [{}, { ids: [] }, { ids: '1' }, { ids: [1.5, '1', null] }, { ids: Array(201).fill(1) }]) {
      await assert.rejects(client.request('events.get', params), (error) => error.code === 'invalid_params')
    }
    const params = { ids: [7, 1, 7, -1, 0, 2.5, '2', Number.MAX_SAFE_INTEGER + 1, 9999, 3] }
    assert.deepEqual(await client.request('events.get', params), expectedGet(params))
    assert.equal((await client.request('events.get', { ids: Array(200).fill(1) })).events.length, 200)
  })
  await check('get returns original tool input/output and preserves duplicate request order', async () => {
    const params = { ids: [20, 19, 5, 20, 21] }
    assert.deepEqual(await client.request('events.get', params), expectedGet(params))
  })
  await check('get clips by JavaScript UTF16 length and truncates the total page budget', async () => {
    const params = { ids: getIds }
    const actual = await client.request('events.get', params)
    assert.deepEqual(actual, expectedGet(params))
    assert.equal(actual.truncated, true)
    assert.ok(actual.events.length > 0 && actual.events.length < getIds.length)
    assert.equal(actual.events[0].data.text.length, 100_001)
    const wide = { ids: [wideId, 1] }
    const wideResult = await client.request('events.get', wide)
    assert.deepEqual(wideResult, expectedGet(wide))
    assert.equal(wideResult.events[0].id, wideId, 'the first event is included even when larger than the page budget')
    assert.equal(wideResult.truncated, true)
  })
  await check('snapshot is the Node store reduction with rm reset and independent activity', async () => {
    assert.deepEqual(await client.request('events.snapshot'), snapshot)
    assert.equal(snapshot.events.some((event) => event.sessionId === 'deleted'), false)
    assert.equal(snapshot.activity.deleted, records.find((event) => event.sessionId === 'deleted' && event.kind === 'message.user').ts)
  })
  await check('Rust CLI snapshot, history and get preserve the same wire data', async () => {
    const cli = (...args) => JSON.parse(execFileSync(binary, ['--home', paths.home, 'events', ...args], {
      encoding: 'utf8', timeout: 5000,
    }))
    assert.deepEqual(cli('snapshot'), snapshot)
    assert.deepEqual(cli('history', '--session', 'chat', '--before', '37', '--budget', '1024'),
      expectedPage('chat', { before: 37, budget: 1024 }))
    assert.deepEqual(cli('get', '7', '1', '7'), expectedGet({ ids: [7, 1, 7] }))
  })
  await check('legacy lone UTF16 values and session identifiers survive history/get/snapshot', async () => {
    assert.deepEqual(await client.request('events.history', { sessionId: lonely }), expectedPage(lonely))
    assert.deepEqual(await client.request('events.get', { ids: [35, 36] }), expectedGet({ ids: [35, 36] }))
    assert.equal((await client.request('events.snapshot')).activity[lonely], snapshot.activity[lonely])
  })
  await check('projection-only imports, rewrites and invalid rows follow Node session reads without clobbering', async () => {
    const filename = join(paths.events, sessionFileName('chat'))
    const imported = { ...records[3], id: 1000, data: { text: 'imported only, absent from global journal' } }
    const earlier = { ...imported, id: 999, data: { text: 'out of order' } }
    const foreign = { ...imported, id: 1001, sessionId: 'other' }
    const last = { ...imported, id: 1002, kind: 'message.done', data: { text: 'new end' } }
    const lexical = String.raw`{"id":1003,"ts":"2026-01-01T00:00:00.000Z","sessionId":"chat","provider":"codex","kind":"future.kind","data":{"number":1e0,"minusZero":-0,"nested":{"same":"old","same":"new","\ud800":"key"}}}`
    const text = [JSON.stringify(imported), '{bad JSON', JSON.stringify(imported), JSON.stringify(earlier), JSON.stringify(foreign), JSON.stringify(last), lexical, JSON.stringify({ id: 0, sessionId: 'chat' })].join('\n') + '\n'
    writeFileSync(filename, text)
    const node = createStore(paths)
    let expected
    try { expected = node.readSession('chat') } finally { node.close() }
    assert.deepEqual(await client.request('events.history', { sessionId: 'chat' }), expectedPage('chat', {}, expected))
    assert.equal(readFileSync(filename, 'utf8'), text)
    assert.deepEqual(await client.request('events.get', { ids: [1000] }), { events: [] })
    assert.deepEqual(await client.request('events.snapshot'), snapshot)
    writeRows(filename, records.filter((event) => event.sessionId === 'chat'))
    assert.deepEqual(await client.request('events.history', { sessionId: 'chat' }), expectedPage('chat'))
  })
  await check('missing and shared projection paths preserve reserved-name and session isolation', async () => {
    for (const sessionId of ['missing', '../../unsafe', 'another unsafe', 'journal']) {
      assert.deepEqual(await client.request('events.history', { sessionId }), expectedPage(sessionId), sessionId)
    }
    const filename = join(paths.events, sessionFileName('deleted'))
    rmSync(filename)
    assert.deepEqual(await client.request('events.history', { sessionId: 'deleted' }), { events: [], more: false, oldest: null, cursor: records.at(-1).id })
    assert.deepEqual(await client.request('events.get', { ids: [28] }), expectedGet({ ids: [28] }))
  })
  await check('unsafe projection files fail promptly without changing targets or the connection', async () => {
    const filename = join(paths.events, sessionFileName('security'))
    const target = join(scratch, 'private-target')
    const sentinel = Buffer.from('private target must stay unchanged\n')
    writeFileSync(target, sentinel, { mode: 0o600 })
    const rejected = async () => {
      await assert.rejects(client.request('events.history', { sessionId: 'security' }, { timeoutMs: 1500 }),
        (error) => error.code === 'internal')
      assert.equal((await client.request('daemon.status')).lastEventId, records.at(-1).id)
      assert.deepEqual(readFileSync(target), sentinel)
    }
    symlinkSync(target, filename)
    await rejected()
    assert.equal(statSync(target).nlink, 1)
    rmSync(filename)
    linkSync(target, filename)
    await rejected()
    assert.equal(statSync(target).nlink, 2)
    rmSync(filename)
    execFileSync('mkfifo', [filename])
    chmodSync(filename, 0o600)
    assert.equal(statSync(filename).isFIFO(), true)
    await rejected()
    rmSync(filename)
    writeFileSync(filename, sentinel, { mode: 0o644 })
    chmodSync(filename, 0o644)
    await rejected()
    assert.deepEqual(readFileSync(filename), sentinel)
    rmSync(filename)
    assert.deepEqual(await client.request('events.history', { sessionId: 'security' }),
      { events: [], more: false, oldest: null, cursor: records.at(-1).id })
  })
  await check('oversized whole-message history returns a frame-budget error without losing the socket', async () => {
    await assert.rejects(client.request('events.history', { sessionId: 'oversized' }), (error) => error.code === 'internal' && /frame budget/.test(error.message))
    assert.equal((await client.request('daemon.status')).lastEventId, records.at(-1).id)
    assert.deepEqual(await client.request('events.get', { ids: [oversizedId] }), expectedGet({ ids: [oversizedId] }))
  })
  await check('restart keeps snapshot and projection imports distinct from authoritative ID reads', async () => {
    const filename = join(paths.events, sessionFileName('import-only'))
    const imported = { ...records[0], id: 2000, sessionId: 'import-only', kind: 'message.done', data: { text: 'preserved import' } }
    writeRows(filename, [imported])
    await stop()
    await start()
    assert.deepEqual(await client.request('events.snapshot'), snapshot)
    assert.deepEqual(await client.request('events.history', { sessionId: 'chat' }), expectedPage('chat'))
    assert.deepEqual(await client.request('events.history', { sessionId: 'import-only' }), expectedPage('import-only', {}, [imported]))
    assert.deepEqual(await client.request('events.get', { ids: [2000, 5] }), expectedGet({ ids: [2000, 5] }))
    assert.equal(JSON.parse(readFileSync(filename, 'utf8')).data.text, 'preserved import')
  })
  await check('new durable writes refresh history and cursor atomically across all read APIs', async () => {
    const result = await client.request('events.emit', { sessionId: 'chat', kind: 'message.done', data: { text: 'new committed reply' } })
    const tail = await client.request('events.tail', { since: records.at(-1).id, limit: 10 })
    records.push(...tail.events)
    assert.equal(records.at(-1).id, result.lastEventId)
    assert.deepEqual(await client.request('events.history', { sessionId: 'chat' }), expectedPage('chat'))
    assert.deepEqual(await client.request('events.get', { ids: result.ids }), expectedGet({ ids: result.ids }))
    await stop()
    snapshot = nodeSnapshot()
    await start()
    assert.deepEqual(await client.request('events.snapshot'), snapshot)
  })
  await stop()
  console.log(`history interop passed ${passed}`)
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
