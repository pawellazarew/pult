import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const root = fileURLToPath(new URL('../../', import.meta.url))
for (const file of ['dist/cli/client.js', 'dist/sessions/manager.js', 'dist/sessions/tree.js']) {
  assert.ok(existsSync(join(root, file)), 'Run npm ci && npm run build before session query interoperability tests')
}
const { connectClient } = await import(new URL('../../dist/cli/client.js', import.meta.url))
const { layout, ensureLayout } = await import(new URL('../../dist/core/paths.js', import.meta.url))
const { createStore, sessionFileName } = await import(new URL('../../dist/core/store.js', import.meta.url))
const { defaultConfig } = await import(new URL('../../dist/core/config.js', import.meta.url))
const { createRegistry } = await import(new URL('../../dist/sessions/registry.js', import.meta.url))
const { createManager } = await import(new URL('../../dist/sessions/manager.js', import.meta.url))
const { createBroker } = await import(new URL('../../dist/perm/broker.js', import.meta.url))
const { formatTree } = await import(new URL('../../dist/sessions/tree.js', import.meta.url))
const { withLanguage } = await import(new URL('../../dist/i18n/context.js', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync(join(tmpdir(), 'r3q-'))
chmodSync(scratch, 0o700)
const children = new Set()
const clients = new Set()
const wires = new Set()
const worlds = new Set()
const wire = (value) => JSON.parse(JSON.stringify(value))
const utf8 = (value) => Buffer.from(value, 'utf8').toString('utf8')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const epoch = '2026-01-01T00:00:00.000Z'
const lonely = String.fromCharCode(0xd800)
const readBudget = 1024 * 1024 - 4096
let passed = 0
let sequence = 0
let nextHome = 0
let active
let oracle
let rows = []
const rawLines = new Map()

function paths() { return layout(join(scratch, `h${nextHome++}`)) }
function writePrivate(file, body) { writeFileSync(file, body, { mode: 0o600 }); chmodSync(file, 0o600) }
function record(name, more = {}) {
  return { name, provider: 'codex', cwd: '/tmp/query-fixture', mode: 'turn', createdAt: epoch,
    lastStatus: 'cold', lastEventId: 0, ...more }
}
function event(sessionId, kind, data = {}, more = {}) {
  const id = ++sequence
  const row = { id, ts: new Date(Date.parse(epoch) + id * 100).toISOString(), sessionId,
    provider: 'codex', kind, data, ...more }
  rows.push(row)
  return row
}
function seed(p, records, events, config = { language: 'ru' }) {
  ensureLayout(p)
  writePrivate(p.sessions, JSON.stringify({ version: 2, sessions: records }) + '\n')
  writePrivate(p.config, JSON.stringify({ ...config, migrations: { accessLevels: { at: epoch } } }) + '\n')
  const line = (row) => rawLines.get(row.id) ?? JSON.stringify(row)
  writePrivate(p.journal, events.map((row) => line(row) + '\n').join(''))
  const groups = new Map()
  for (const row of events) {
    const name = sessionFileName(row.sessionId)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(row)
  }
  for (const [name, events] of groups) writePrivate(join(p.events, name), events.map((row) => line(row) + '\n').join(''))
}
function launch(p, env = {}) {
  const child = spawn(binary, ['--home', p.home, 'daemon', 'serve'], {
    env: { ...process.env, PULT_TEST: '1', ...env }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-8192) })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const handle = { child, exited, get stderr() { return stderr } }
  children.add(handle)
  exited.then(() => children.delete(handle), () => children.delete(handle))
  return handle
}
async function start(p, env = {}) {
  const handle = launch(p, env)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    assert.ok(handle.child.exitCode === null && handle.child.signalCode === null, `query startup exited\n${handle.stderr}`)
    if (existsSync(p.sock) && existsSync(p.token)) {
      let candidate
      try {
        candidate = await connectClient(p, { timeoutMs: 500, locale: () => 'ru' })
        const status = await candidate.request('daemon.status', {}, { timeoutMs: 500 })
        if (status.pid === handle.child.pid) {
          clients.add(candidate)
          return { paths: p, daemon: handle, client: candidate }
        }
      } catch { /* allow stale endpoint replacement and publication */ }
      candidate?.close()
    }
    await pause(10)
  }
  throw new Error(`query startup deadline\n${handle.stderr}`)
}
async function stop(live) {
  assert.deepEqual(await live.client.request('daemon.stop', {}, { timeoutMs: 3000 }), { stopping: true })
  live.client.close(); clients.delete(live.client)
  assert.equal((await live.daemon.exited).code, 0, live.daemon.stderr)
}
async function prepare() {
  const p = paths()
  const live = await start(p)
  await stop(live)
  return p
}
function makeOracle(records, events, config = { language: 'ru' }) {
  const p = paths()
  seed(p, records, events, config)
  const store = createStore(p)
  const registry = createRegistry(p)
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const manager = createManager({ paths: p, config: defaultConfig(), registry, logger, store,
    publish: (draft) => store.append(draft), adapters: {}, broker: createBroker({ emit() {} }) })
  const world = { paths: p, store, manager,
    async close() { await manager.shutdown(); store.close(); worlds.delete(world) } }
  worlds.add(world)
  return world
}
function expectedRead(name, since = 0, format = 'text') {
  return wire(oracle.manager.read(name, since, format))
}
function expectedTree(name, language = 'ru', world = oracle) {
  return withLanguage(language, () => {
    const tree = world.manager.tree(name)
    return wire({ roots: tree.roots, orphans: tree.orphans, text: formatTree(tree) })
  })
}
function rawRequest(p, request, followup) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(p.sock)
    socket.setEncoding('utf8')
    wires.add(socket)
    let buffer = ''
    let done = false
    let firstResponse
    const timer = setTimeout(() => finish(new Error('raw query response deadline')), 5000)
    function finish(error, value) {
      if (done) return
      done = true; clearTimeout(timer); wires.delete(socket); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    socket.on('error', (error) => finish(error))
    socket.on('close', () => { if (!done) finish(new Error('raw query socket closed')) })
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', token: readFileSync(p.token, 'utf8'), protocol: 1, client: 'query-interop' }) + '\n'))
    socket.on('data', (bytes) => {
      buffer += bytes
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error('raw query exceeded bounded response reader'))
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let value
        try { value = JSON.parse(line) } catch (error) { return finish(error) }
        if (value.type === 'hello_ok') { socket.write(JSON.stringify(request) + '\n'); continue }
        if (value.id === request.id) {
          if (!followup) return finish(null, value)
          firstResponse = value
          socket.write(JSON.stringify(followup) + '\n')
          continue
        }
        if (followup && firstResponse !== undefined && value.id === followup.id) return finish(null, { response: firstResponse, followup: value })
        if (value.type === 'error') return finish(new Error(`wire error ${value.code}`))
      }
    })
  })
}
async function check(name, run) { await run(); passed++; console.log(`pass ${name}`) }
async function cleanup() {
  for (const client of clients) client.close()
  for (const socket of wires) socket.destroy()
  for (const world of [...worlds]) await world.close()
  await Promise.all([...children].map(async (handle) => {
    handle.child.kill('SIGTERM')
    const timer = setTimeout(() => handle.child.kill('SIGKILL'), 1000)
    try { await handle.exited } finally { clearTimeout(timer) }
  }))
  rmSync(scratch, { recursive: true, force: true })
}
const watchdog = setTimeout(async () => {
  console.error('session query interoperability deadline exceeded')
  await cleanup(); process.exit(1)
}, 90_000)

try {
  const p = await prepare()
  const names = ['alpha', 'empty', 'big', 'oversize', 'textclip', 'tree', 'cycles', 'deep', 'wide', 'true']
  const records = names.map((name) => record(name, name === 'alpha' ? {
    worktree: { path: '/tmp/query-worktree', branch: 'fixture/task', repo: '/tmp/query-repo' },
  } : {}))
  event('alpha', 'message.user', { text: 'task' })
  event('alpha', 'message.done', { text: 'Ответ 🌊' })
  event('alpha', 'message.done', { text: `Child ${lonely}` }, { parentId: `sub-${lonely}` })
  event('alpha', 'message.done', { text: [1, [true, null, '終'], {}, []] })
  event('alpha', 'message.done', { text: false })
  event('alpha', 'message.done', { text: null })
  event('alpha', 'message.done', { text: '' })
  event('alpha', 'session.ended', { reason: 'rm' })
  event('alpha', 'message.done', { text: 'After name reuse' })
  const lexical = event('alpha', 'future.kind', { number: 1, duplicate: 'new', [`key-${lonely}`]: 'preserved' })
  rawLines.set(lexical.id, `{ "id": ${lexical.id}, "ts": ${JSON.stringify(lexical.ts)}, "sessionId":"alpha", "provider":"codex", "kind":"future.kind", "data": { "number":1e0, "minusZero":-0, "duplicate":"old", "duplicate":"new", ${JSON.stringify(`key-${lonely}`)}:"preserved" } }`)
  event('alpha', 'tool.finished', { content: 'not a model answer' })
  event('big', 'message.done', { text: 'first-' + 'x'.repeat(600_000) })
  event('big', 'message.done', { text: 'second-' + 'y'.repeat(600_000) })
  event('big', 'tool.finished', { content: 'last row controls the final cursor' })
  event('oversize', 'tool.finished', { content: 'x'.repeat(1024 * 1024 + 1024) })
  event('textclip', 'message.done', { text: '🌊\n"\\'.repeat(400_000) })
  event('textclip', 'tool.finished', { content: 'cursor after clipped answer' })
  const child = event('tree', 'tool.called', { toolUseId: 'early-child', name: 'Read' }, { parentId: 'late-parent' })
  const rootOpen = event('tree', 'agent.spawned', { toolUseId: 'root', name: 'Leader', subagentType: 'Explore', model: 'fixture-model' })
  event('tree', 'tool.finished', { toolUseId: 'not-open-yet' })
  event('tree', 'tool.called', { toolUseId: 'root', name: 'duplicate must be ignored' })
  event('tree', 'tool.called', { toolUseId: 'root-tool', name: 'Bash' }, { parentId: 'root' })
  event('tree', 'agent.spawned', { toolUseId: 'late-parent', subagentType: 'Worker' }, { parentId: 'root' })
  event('tree', 'tool.finished', { toolUseId: 'early-child' }, { ts: new Date(Date.parse(child.ts) + 300).toISOString() })
  event('tree', 'agent.finished', { toolUseId: 'root' }, { ts: new Date(Date.parse(rootOpen.ts) + 1700).toISOString() })
  event('tree', 'agent.finished', { toolUseId: 'root', isError: true }, { ts: 'invalid-date' })
  event('tree', 'tool.called', { toolUseId: 'orphan', name: 'Loose' }, { parentId: 'missing' })
  event('tree', 'tool.called', { toolUseId: 'empty-parent', name: '' }, { parentId: '' })
  event('tree', 'tool.called', { toolUseId: '', name: 'ignored empty ID' })
  event('tree', 'agent.spawned', { toolUseId: `sub-${lonely}`, name: `Name ${lonely}`, model: `model-${lonely}` }, { parentId: 'root' })
  event('tree', 'tool.called', { toolUseId: `tool-${lonely}`, name: `Tool ${lonely}` }, { parentId: `sub-${lonely}` })
  event('cycles', 'tool.called', { toolUseId: 'self', name: 'Self' }, { parentId: 'self' })
  event('cycles', 'tool.called', { toolUseId: 'left', name: 'Left' }, { parentId: 'right' })
  event('cycles', 'tool.called', { toolUseId: 'right', name: 'Right' }, { parentId: 'left' })
  for (let i = 0; i < 320; i++) event('deep', 'tool.called', { toolUseId: `d${i}`, name: 'Nested' }, i ? { parentId: `d${i - 1}` } : {})
  for (let i = 0; i < 7000; i++) event('wide', 'tool.called', { toolUseId: `w${i}`, name: 'wide-' + 'x'.repeat(100) })
  event('true', 'message.done', { text: 'boolean name coercion' })
  seed(p, records, rows)
  oracle = makeOracle(records, rows)
  active = await start(p)

  await check('registered empty sessions preserve fractional and negative cursors in both read formats', async () => {
    for (const since of [-1.5, 0, 3.25, 1e30]) for (const format of ['text', 'json']) {
      assert.deepEqual(await active.client.request('agent.read', { name: 'empty', since, format }), expectedRead('empty', since, format))
    }
    assert.deepEqual(await active.client.request('agent.tree', { name: 'empty' }), expectedTree('empty'))
  })
  await check('missing sessions report not_found and leave the connection usable', async () => {
    for (const method of ['agent.read', 'agent.tree']) await assert.rejects(active.client.request(method, { name: 'absent' }), (error) => error.code === 'not_found')
    assert.equal((await active.client.request('daemon.status')).pid, active.daemon.child.pid)
  })
  await check('read pages preserve original events, worktree metadata and canonical legacy JSON', async () => {
    assert.deepEqual(await active.client.request('agent.read', { name: 'alpha', format: 'json' }), expectedRead('alpha', 0, 'json'))
    for (const since of [-0.5, 1.5, 4, 999_999]) {
      assert.deepEqual(await active.client.request('agent.read', { name: 'alpha', since, format: 'json' }), expectedRead('alpha', since, 'json'))
    }
  })
  await check('text includes completed subagent replies and reused-name history with JS coercion', async () => {
    const expected = expectedRead('alpha')
    assert.match(expected.text, /After name reuse/)
    assert.match(expected.text, /1,true,,終,\[object Object\],\nfalse/)
    assert.deepEqual(await active.client.request('agent.read', { name: 'alpha' }), expected)
    assert.deepEqual(await active.client.request('agent.read', { name: 'alpha', format: 'JSON' }), expected)
  })
  await check('wrong since types default to zero and session names use JavaScript String coercion', async () => {
    for (const since of [true, '2', null, {}, [], NaN, Infinity]) {
      assert.deepEqual(await active.client.request('agent.read', { name: ['alpha'], since }), expectedRead('alpha'))
    }
    assert.deepEqual(await active.client.request('agent.read', { name: true }), expectedRead('true'))
    let deep = 'alpha'; for (let i = 0; i < 256; i++) deep = [deep]
    await assert.rejects(active.client.request('agent.read', { name: deep }), (error) => error.code === 'invalid_params')
    assert.equal((await active.client.request('daemon.status')).pid, active.daemon.child.pid)
  })
  await check('JSON paging uses the returned session cursor and advances without loss or duplication', async () => {
    const received = []
    let since = 0
    let first = true
    for (;;) {
      const actual = await active.client.request('agent.read', { name: 'big', since, format: 'json' })
      assert.deepEqual(actual, expectedRead('big', since, 'json'))
      assert.ok(actual.events.length > 0)
      if (first) { assert.equal(actual.truncated, true); first = false }
      received.push(...actual.events.map((event) => event.id))
      since = actual.cursor
      if (!actual.truncated) break
    }
    assert.deepEqual(received, rows.filter((event) => event.sessionId === 'big').map((event) => event.id))
  })
  await check('text clipping matches UTF16 slicing, JSON-escaped byte size and the fixed Node suffix', async () => {
    const actual = await active.client.request('agent.read', { name: 'textclip' })
    assert.deepEqual(actual, expectedRead('textclip'))
    assert.ok(Buffer.byteLength(JSON.stringify(actual.text)) < readBudget + 4096)
    assert.match(actual.text, /--format json/)
    const english = await rawRequest(p, { id: 'text-en', method: 'agent.read', locale: 'en', params: { name: 'textclip' } })
    assert.deepEqual(english.result, actual)
  })
  await check('a single oversized JSON event reports a frame error and subsequent reads still work', async () => {
    await assert.rejects(active.client.request('agent.read', { name: 'oversize', format: 'json' }), (error) => error.code === 'internal' && /budget|frame/i.test(error.message))
    assert.deepEqual(await active.client.request('agent.read', { name: 'oversize' }), expectedRead('oversize'))
    assert.equal((await active.client.request('daemon.status')).pid, active.daemon.child.pid)
  })
  await check('an oversized complete response envelope returns internal and keeps the same socket usable', async () => {
    const id = 'large-query-id-' + 'i'.repeat(600_000)
    const request = { id, method: 'agent.read', params: { name: 'big', format: 'json' } }
    const expected = expectedRead('big', 0, 'json')
    assert.ok(Buffer.byteLength(JSON.stringify(request)) + 1 < 1024 * 1024)
    assert.ok(Buffer.byteLength(JSON.stringify(expected)) < 1024 * 1024 - 4096)
    assert.ok(Buffer.byteLength(JSON.stringify({ id, result: expected })) + 1 > 1024 * 1024)
    const result = await rawRequest(p, request, { id: 'status-after-large-id', method: 'daemon.status', params: {} })
    assert.equal(result.response.id, id)
    assert.equal(result.response.error?.code, 'internal')
    assert.match(result.response.error.message, /budget|frame/i)
    assert.equal(result.followup.result?.pid, active.daemon.child.pid)
  })
  await check('trees match child adoption, orphans, duplicate IDs, close ordering and retained durations', async () => {
    const expected = expectedTree('tree')
    assert.equal(expected.orphans, 2)
    assert.equal(expected.roots[0].status, 'failed')
    assert.equal(expected.roots[0].durationMs, 1700)
    assert.equal(expected.roots[0].endedAt, 'invalid-date')
    assert.deepEqual(await active.client.request('agent.tree', { name: 'tree' }), expected)
  })
  await check('tree IDs and names preserve lone UTF16 code units', async () => {
    const expected = expectedTree('tree')
    assert.match(JSON.stringify(expected), /\\ud800/)
    assert.deepEqual(await active.client.request('agent.tree', { name: ['tree'] }), expected)
  })
  await check('request locale selects RU or EN tree duration units without changing node data', async () => {
    const russian = await rawRequest(p, { id: 'tree-ru', method: 'agent.tree', locale: 'ru', params: { name: 'tree' } })
    const english = await rawRequest(p, { id: 'tree-en', method: 'agent.tree', locale: 'en', params: { name: 'tree' } })
    assert.deepEqual(russian.result, expectedTree('tree', 'ru'))
    assert.deepEqual(english.result, expectedTree('tree', 'en'))
    assert.deepEqual(russian.result.roots, english.result.roots)
    assert.match(russian.result.text, /1700 мс/)
    assert.match(english.result.text, /1700 ms/)
  })
  await check('rootless self and two-node cycles keep the Node empty-root projection', async () => {
    const expected = expectedTree('cycles')
    assert.deepEqual(expected, { roots: [], orphans: 0, text: '' })
    assert.deepEqual(await active.client.request('agent.tree', { name: 'cycles' }), expected)
  })
  await check('deep and oversized trees keep the daemon and connection alive', async () => {
    try {
      assert.deepEqual(await active.client.request('agent.tree', { name: 'deep' }), expectedTree('deep'))
    } catch (error) {
      assert.equal(error.code, 'internal')
      assert.match(error.message, /budget|frame|depth/i)
    }
    await assert.rejects(active.client.request('agent.tree', { name: 'wide' }), (error) => error.code === 'internal' && /budget|frame/i.test(error.message))
    assert.equal((await active.client.request('daemon.status')).pid, active.daemon.child.pid)
    assert.deepEqual(await active.client.request('agent.tree', { name: 'empty' }), expectedTree('empty'))
  })
  await check('session queries read the authoritative journal after a projection-only rewrite', async () => {
    const injected = event('alpha', 'message.done', { text: 'projection-only must not appear' })
    writePrivate(join(p.events, sessionFileName('alpha')), JSON.stringify(injected) + '\n')
    const before = readFileSync(join(p.events, sessionFileName('alpha')))
    assert.deepEqual(await active.client.request('agent.read', { name: 'alpha' }), expectedRead('alpha'))
    assert.deepEqual(await active.client.request('agent.tree', { name: 'alpha' }), expectedTree('alpha'))
    assert.deepEqual(readFileSync(join(p.events, sessionFileName('alpha'))), before)
  })
  await check('Rust CLI preserves read stdout formats, worktree stderr and tree JSON/text modes', async () => {
    const run = (args) => spawnSync(binary, ['--home', p.home, 'agent', ...args], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PULT_LANG: 'ru' } })
    const json = run(['read', 'alpha', '--since', '2', '--format', 'json'])
    assert.equal(json.status, 0, json.stderr)
    assert.deepEqual(json.stdout.trim().split('\n').map((line) => JSON.parse(line)), expectedRead('alpha', 2, 'json').events)
    assert.match(json.stderr, /query-worktree/)
    for (const input of ['1.9', '12abc']) {
      const coerced = run(['read', 'alpha', '--since', input, '--format', 'json'])
      assert.equal(coerced.status, 0, coerced.stderr)
      const events = coerced.stdout.trim() ? coerced.stdout.trim().split('\n').map((line) => JSON.parse(line)) : []
      assert.deepEqual(events, expectedRead('alpha', Number.parseInt(input, 10), 'json').events)
    }
    const text = run(['read', 'alpha', '--since', '2'])
    assert.equal(text.status, 0, text.stderr)
    assert.equal(text.stdout, utf8(expectedRead('alpha', 2).text) + '\n')
    const tree = run(['tree', 'tree', '--json'])
    assert.equal(tree.status, 0, tree.stderr)
    assert.deepEqual(JSON.parse(tree.stdout), expectedTree('tree'))
    const plain = run(['tree', 'tree'])
    assert.equal(plain.status, 0, plain.stderr)
    assert.equal(plain.stdout, utf8(expectedTree('tree').text) + '\n')
  })
  await check('restarting preserves query data and leaves the journal and registry unchanged', async () => {
    const journal = readFileSync(p.journal)
    const registry = readFileSync(p.sessions)
    const read = await active.client.request('agent.read', { name: 'alpha', format: 'json' })
    const tree = await active.client.request('agent.tree', { name: 'tree' })
    await stop(active); active = await start(p)
    assert.deepEqual(await active.client.request('agent.read', { name: 'alpha', format: 'json' }), read)
    assert.deepEqual(await active.client.request('agent.tree', { name: 'tree' }), tree)
    assert.deepEqual(readFileSync(p.journal), journal)
    assert.deepEqual(readFileSync(p.sessions), registry)
  })
  await check('config language and system locale provide the fallback when request locale is absent or invalid', async () => {
    const sample = rows.filter((event) => event.sessionId === 'tree')
    for (const [language, environment, expected] of [
      ['en', { LC_ALL: 'ru_RU.UTF-8' }, 'en'],
      ['ru', { LC_ALL: 'en_US.UTF-8' }, 'ru'],
      ['auto', { LC_ALL: 'ru_RU.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'en_US.UTF-8' }, 'ru'],
      ['auto', { LC_ALL: '', LC_MESSAGES: '', LANG: 'de_DE.UTF-8' }, 'en'],
    ]) {
      const home = await prepare()
      seed(home, [record('tree')], sample, { language })
      const live = await start(home, environment)
      for (const locale of [undefined, 'auto', true]) {
        const response = await rawRequest(home, { id: `fallback-${String(locale)}`, method: 'agent.tree', ...(locale !== undefined ? { locale } : {}), params: { name: 'tree' } })
        assert.deepEqual(response.result, expectedTree('tree', expected))
      }
      await stop(live)
    }
  })
  console.log(`session query interop passed ${passed}`)
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
