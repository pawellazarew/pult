import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
for (const file of ['dist/cli/client.js', 'dist/sessions/registry.js', 'dist/sessions/manager.js']) {
  assert.ok(existsSync(join(root, file)), 'Run npm ci && npm run build before registry interoperability tests')
}
const { connectClient } = await import(new URL('../../dist/cli/client.js', import.meta.url))
const { layout, ensureLayout } = await import(new URL('../../dist/core/paths.js', import.meta.url))
const { createStore, sessionFileName } = await import(new URL('../../dist/core/store.js', import.meta.url))
const { defaultConfig } = await import(new URL('../../dist/core/config.js', import.meta.url))
const { createBroker } = await import(new URL('../../dist/perm/broker.js', import.meta.url))
const { createManager, publicRecord } = await import(new URL('../../dist/sessions/manager.js', import.meta.url))
const { createRegistry, parseSessions } = await import(new URL('../../dist/sessions/registry.js', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync(join(tmpdir(), 'r3r-'))
chmodSync(scratch, 0o700)
const clients = new Set()
const children = new Set()
const worlds = new Set()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const wire = (value) => JSON.parse(JSON.stringify(value))
let nextHome = 0
let passed = 0
let paths
let daemon
let client
let oracle
let baseline
let events
const fixedMarker = '2026-01-02T00:00:00.000Z'
const markedConfig = { custom: { keep: 'unchanged', nested: ['opaque', { x: 1 }] }, migrations: { untouched: { at: '2025-01-01T00:00:00.000Z', extra: true }, accessLevels: { at: fixedMarker } } }
const epoch = '1970-01-01T00:00:00.000Z'
const lonely = String.fromCharCode(0xd800)

function newPaths() { return layout(join(scratch, `h${nextHome++}`)) }
function writePrivate(file, body) { writeFileSync(file, body, { mode: 0o600 }); chmodSync(file, 0o600) }
function writeJSON(file, value) { writePrivate(file, JSON.stringify(value) + '\n') }
function sessions(p = paths) { return JSON.parse(readFileSync(p.sessions, 'utf8')).sessions }
function record(name, over = {}) {
  return { name, provider: 'claude', cwd: '/tmp/fixture-project', mode: 'turn', createdAt: '2026-01-01T00:00:00.000Z', lastStatus: 'idle', lastEventId: 0, ...over }
}
function event(id, sessionId, kind, data = {}, extra = {}) {
  return { id, sessionId, kind, data, provider: 'claude', ts: `2026-01-01T00:00:${String(id).padStart(2, '0')}.000Z`, ...extra }
}
function seed(p, raw, rows = [], config = markedConfig) {
  ensureLayout(p)
  writeJSON(p.sessions, raw)
  if (config !== undefined) writeJSON(p.config, config)
  writePrivate(p.journal, rows.map((ev) => JSON.stringify(ev) + '\n').join(''))
  const groups = new Map()
  for (const ev of rows) {
    const name = sessionFileName(ev.sessionId)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(ev)
  }
  for (const [name, rows] of groups) writePrivate(join(p.events, name), rows.map((ev) => JSON.stringify(ev) + '\n').join(''))
}
function launch(p) {
  const child = spawn(binary, ['--home', p.home, 'daemon', 'serve'], {
    env: { ...process.env, PULT_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
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
async function start(p = paths) {
  const handle = launch(p)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    assert.ok(handle.child.exitCode === null && handle.child.signalCode === null, `daemon exited at startup\n${handle.stderr}`)
    if (existsSync(p.sock) && existsSync(p.token)) {
      let candidate
      try {
        candidate = await connectClient(p, { timeoutMs: 500 })
        const status = await candidate.request('daemon.status', {}, { timeoutMs: 500 })
        if (status.pid === handle.child.pid) {
          clients.add(candidate)
          return { daemon: handle, client: candidate }
        }
      } catch { /* publication or replacement of a stale socket is still in progress */ }
      candidate?.close()
    }
    await pause(10)
  }
  throw new Error(`registry startup deadline\n${handle.stderr}`)
}
async function stop(connection = client, handle = daemon) {
  assert.deepEqual(await connection.request('daemon.stop', {}, { timeoutMs: 3000 }), { stopping: true })
  connection.close()
  clients.delete(connection)
  assert.equal((await handle.exited).code, 0, handle.stderr)
}
async function prepare() {
  const p = newPaths()
  const { daemon, client } = await start(p)
  await stop(client, daemon)
  return p
}
async function rejectsStartup(p, match = /registry|session|config|private|regular|link|version|json|parse|permission|date|marker|migration|backup/i) {
  const handle = launch(p)
  const timer = setTimeout(() => handle.child.kill('SIGKILL'), 3000)
  try {
    const result = await handle.exited
    assert.notEqual(result.signal, 'SIGKILL', 'unsafe state must fail without blocking on a FIFO')
    assert.notEqual(result.code, 0, 'unsafe state must not start a daemon')
    assert.match(handle.stderr, match)
  } finally { clearTimeout(timer) }
}
function makeOracle(raw, rows = [], config = markedConfig) {
  const p = newPaths()
  seed(p, raw, rows, config)
  const store = createStore(p)
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const registry = createRegistry(p)
  const manager = createManager({ paths: p, config: defaultConfig(), logger, registry, store,
    publish: (draft) => store.append(draft), adapters: {}, broker: createBroker({ emit() {} }) })
  const world = { paths: p, registry, store, manager,
    async close() { await manager.shutdown(); store.close(); worlds.delete(world) } }
  worlds.add(world)
  return world
}
async function check(name, run) { await run(); passed++; console.log(`pass ${name}`) }
async function cleanup() {
  for (const connection of clients) connection.close()
  for (const world of [...worlds]) await world.close()
  await Promise.all([...children].map(async (handle) => {
    handle.child.kill('SIGTERM')
    const timer = setTimeout(() => handle.child.kill('SIGKILL'), 1000)
    try { await handle.exited } finally { clearTimeout(timer) }
  }))
  rmSync(scratch, { recursive: true, force: true })
}
const watchdog = setTimeout(async () => { console.error('registry interoperability deadline exceeded'); await cleanup(); process.exit(1) }, 65_000)

try {
  await check('a missing registry starts in a marked scratch home without creating provider activity', async () => {
    paths = newPaths()
    ;({ daemon, client } = await start())
    const status = await client.request('daemon.status')
    assert.equal(status.lastEventId, 0)
    assert.equal(readFileSync(join(paths.home, '.rust-core-scratch'), 'utf8'), 'pult-rust-scratch-v1\n')
    assert.equal(readFileSync(paths.journal, 'utf8'), '')
    await stop()
  })

  const queue = Array.from({ length: 23 }, (_, i) => ({ id: `q${i}`, text: i ? `pending ${i} ${lonely}🌊` : 'already accepted', at: `at-${i}` }))
  queue.splice(2, 0, { ...queue[1], text: 'duplicate must not replace first' }, { id: 'invalid', text: ' ', at: epoch })
  baseline = { version: 2, sessions: [
    record('alpha', { title: '\u202E  Починить\nПульт\u200B  🌊 ', provider: 'codex', serviceTier: 'fast', model: '', effort: 'high', scope: 'general', settingSources: '', providerSessionId: `provider-${lonely}`, forkOnResume: true,
      worktree: { path: '/tmp/fixture-worktree', branch: 'topic', repo: '/tmp/fixture-repo' }, context: { used: 2.5, window: 0, model: '', at: 'context-at' },
      lastStatus: 'working', lastEventId: 3, lastSeenEventId: 999, markedUnread: true, queue, browser: true, browserSuspended: { headed: true }, approval: 'unknown', grant: 'cli-once',
      applied: { approval: 'read-only', reported: null, confirmed: 1, full: true }, inheritSeen: 'manual', startRequest: '00000000-0000-0000-0000-000000000000' }),
    ...['cold', 'idle', 'working', 'blocked_permission', 'blocked_question', 'limited', 'interrupted', 'failed', 'done'].map((lastStatus, i) => record(`status${i}`, { provider: i % 2 ? 'zcode' : 'claude', lastStatus, lastSeenEventId: i % 2 ? 2 : undefined, ...(i === 0 ? { lastTurnAt: fixedMarker } : {}) })),
    record('quiet'), record('empty'),
    record('normalize', { title: '🌊'.repeat(65), createdAt: 7, mode: 'other', approval: null,
      lastStatus: 'unknown', lastEventId: -7, lastSeenEventId: -1, browser: { headed: 1 },
      context: { used: 2.49, window: 0.4, model: 'fixture', at: 'at' },
      applied: { approval: 'full', reported: 0, confirmed: true, full: false } }),
    record('attachments', { queue: [
      { id: 'file', text: ' ', attachments: [{ path: '/tmp/fixture.bin', name: 'fixture.bin', bytes: 0, mime: 'application/octet-stream', kind: 'file' }] },
      { id: 'bad', text: 'bad attachment', attachments: [{ path: 'relative', name: 'x', bytes: 0, mime: 'text/plain', kind: 'file' }] },
      { id: 'large', text: 'bad bytes', attachments: [{ path: '/tmp/x', name: 'x', bytes: 25 * 1024 * 1024 + 1, mime: 'text/plain', kind: 'file' }] },
    ] }),
    record('A'), record('bad-provider', { provider: 'other' }), record('bad-cwd', { cwd: '' }), null,
  ] }
  events = [
    event(1, 'alpha', 'message.user', { text: 'accepted', queueItemId: 'q0', queueItemAt: 'at-0' }),
    event(2, 'alpha', 'message.done', { text: 'finished' }),
    event(3, 'quiet', 'session.started'),
    event(4, 'alpha', 'message.user', { text: 'newest user' }),
    event(5, 'alpha', 'context.updated', { used: 12 }),
  ]
  seed(paths, baseline, events)
  oracle = makeOracle(baseline, events)

  await check('startup normalizes stored fields exactly like the current Node registry and manager', async () => {
    ;({ daemon, client } = await start())
    assert.deepEqual(sessions(), wire(oracle.registry.list()))
    assert.deepEqual(JSON.parse(readFileSync(paths.config, 'utf8')), markedConfig)
    assert.equal(readFileSync(paths.journal, 'utf8'), events.map((ev) => JSON.stringify(ev) + '\n').join(''))
  })
  await check('recovery cools every unfinished status but preserves cold, failed and done', async () => {
    for (const rec of sessions().filter((r) => r.name.startsWith('status'))) {
      const was = baseline.sessions.find((r) => r?.name === rec.name).lastStatus
      assert.equal(rec.lastStatus, ['cold', 'failed', 'done'].includes(was) ? was : 'cold')
    }
  })
  await check('seen IDs are seeded and clamped while existing older read markers are preserved', async () => {
    const alpha = sessions().find((r) => r.name === 'alpha')
    assert.equal(alpha.lastSeenEventId, 5)
    assert.equal(sessions().find((r) => r.name === 'status1').lastSeenEventId, 2)
    assert.equal(sessions().find((r) => r.name === 'quiet').lastSeenEventId, 5)
  })
  await check('last turn is recovered from the latest user, last event or creation date', async () => {
    const list = sessions()
    assert.equal(list.find((r) => r.name === 'alpha').lastTurnAt, events[3].ts)
    assert.equal(list.find((r) => r.name === 'quiet').lastTurnAt, events[2].ts)
    assert.equal(list.find((r) => r.name === 'empty').lastTurnAt, baseline.sessions.find((r) => r?.name === 'empty').createdAt)
    assert.equal(list.find((r) => r.name === 'status0').lastTurnAt, fixedMarker)
  })
  await check('accepted queue receipts are removed once and surviving queues pause without losing UTF16', async () => {
    const alpha = sessions().find((r) => r.name === 'alpha')
    assert.equal(alpha.queue.length, 19)
    assert.equal(alpha.queue[0].id, 'q1')
    assert.match(alpha.queue[0].text, new RegExp(lonely))
    assert.equal(alpha.queuePaused, true)
    const attachment = sessions().find((r) => r.name === 'attachments')
    assert.equal(attachment.queue.length, 1)
    assert.equal(attachment.queue[0].at, epoch)
  })
  await check('rename preserves full queue storage but returns the same 200-codepoint preview as Node', async () => {
    const long = '🌊'.repeat(240) + lonely
    // The currently stored queue has short entries, so replace only the oracle/Rust
    // fixture before restart to check the public projection independently of save.
    await stop()
    const raw = { version: 2, sessions: sessions().map((r) => r.name === 'alpha' ? { ...r, queue: [{ id: 'long', text: long, at: epoch }], queuePaused: true } : r) }
    seed(paths, raw, events)
    await oracle.close()
    oracle = makeOracle(raw, events)
    ;({ daemon, client } = await start())
    for (const title of ['  Новый\nзаголовок 🌊  ', '', `Legacy ${lonely}`, '\u200B\u202E']) {
      const expected = wire(publicRecord(oracle.manager.rename('alpha', title)))
      const actual = await client.request('agent.rename', { name: 'alpha', title })
      assert.deepEqual(actual, expected)
      assert.equal(sessions().find((r) => r.name === 'alpha').queue[0].text, long)
      assert.equal([...actual.queue[0].text].length, 200)
    }
  })
  await check('archive and unarchive preserve the same record fields and durable state as Node', async () => {
    for (const archived of [true, false]) {
      assert.deepEqual(await client.request('agent.archive', { name: 'alpha', archived }), wire(publicRecord(oracle.manager.archive('alpha', archived))))
      assert.deepEqual(sessions(), wire(oracle.registry.list()))
    }
  })
  await check('seen is monotonic, clamps to the global cursor and toggles manual unread like Node', async () => {
    for (const params of [{ unread: true }, { unread: true }, { unread: false, upTo: 1 }, { upTo: 999 }, { upTo: 0 }, {}]) {
      const expected = wire(publicRecord(oracle.manager.seen('alpha', params.unread === true, params.upTo)))
      assert.deepEqual(await client.request('agent.seen', { name: 'alpha', ...params }), expected)
      assert.deepEqual(sessions(), wire(oracle.registry.list()))
    }
  })
  await check('invalid mutations leave the registry intact and the RPC connection usable', async () => {
    const before = readFileSync(paths.sessions)
    const deeplyNestedName = Array.from({ length: 256 }).reduce((value) => [value], 'alpha')
    for (const [method, params, code] of [
      ['agent.rename', { name: 'alpha' }, 'invalid_params'], ['agent.rename', { name: 'alpha', title: null }, 'invalid_params'],
      ['agent.rename', { name: 'alpha', title: '🌊'.repeat(61) }, 'invalid_params'], ['agent.rename', { name: 'missing', title: 'x' }, 'not_found'],
      ['agent.archive', { name: 'alpha', archived: 'true' }, 'invalid_params'], ['agent.archive', { name: 'missing', archived: true }, 'not_found'],
      ['agent.seen', { name: 'alpha', unread: 1 }, 'invalid_params'], ['agent.seen', { name: 'alpha', upTo: -1 }, 'invalid_params'],
      ['agent.seen', { name: 'alpha', upTo: 0.1 }, 'invalid_params'], ['agent.seen', { name: 'missing' }, 'not_found'],
      ['agent.rename', { name: deeplyNestedName, title: 'must not overflow or close the connection' }, 'invalid_params'],
    ]) await assert.rejects(client.request(method, params), (error) => error.code === code)
    assert.deepEqual(readFileSync(paths.sessions), before)
    assert.equal((await client.request('daemon.status')).pid, daemon.child.pid)
  })
  await check('Rust CLI rename, archive, unarchive and seen use the same durable RPC path', async () => {
    for (const [args, expected] of [
      [['agent', 'rename', 'alpha', '--title', 'CLI 🌊'], () => oracle.manager.rename('alpha', 'CLI 🌊')],
      [['agent', 'archive', 'alpha'], () => oracle.manager.archive('alpha', true)],
      [['agent', 'unarchive', 'alpha'], () => oracle.manager.archive('alpha', false)],
      [['agent', 'seen', 'alpha', '--unread'], () => oracle.manager.seen('alpha', true)],
      [['agent', 'seen', 'alpha'], () => oracle.manager.seen('alpha', false)],
    ]) {
      const actual = JSON.parse(execFileSync(binary, ['--home', paths.home, ...args], { encoding: 'utf8', timeout: 5000 }))
      assert.deepEqual(actual, wire(publicRecord(expected())))
      assert.deepEqual(sessions(), wire(oracle.registry.list()))
    }
  })
  await check('a second startup preserves recovered records and never replays queued messages', async () => {
    const before = readFileSync(paths.sessions)
    const journal = readFileSync(paths.journal)
    await stop()
    ;({ daemon, client } = await start())
    assert.deepEqual(readFileSync(paths.sessions), before)
    assert.deepEqual(readFileSync(paths.journal), journal)
    assert.deepEqual(await client.request('agent.archive', { name: ['alpha'], archived: false }), wire(publicRecord(oracle.manager.archive('alpha', false))))
    await stop()
  })

  await check('v1 access migration saves a private original backup and preserves unrelated config', async () => {
    const p = await prepare()
    const raw = { version: 1, sessions: [record('old'), record('explicit', { approval: 'ask' }), record('codex', { provider: 'codex' })] }
    const config = { custom: { keep: ['fixture', 1] }, migrations: { other: { at: epoch, keep: true } } }
    seed(p, raw, [], config)
    const original = readFileSync(p.sessions)
    const world = makeOracle(raw, [], config)
    const started = Date.now()
    const live = await start(p)
    assert.deepEqual(sessions(p), wire(world.registry.list()))
    assert.deepEqual(readFileSync(`${p.sessions}.bak-v1`), original)
    assert.equal(statSync(`${p.sessions}.bak-v1`).mode & 0o777, 0o600)
    const written = JSON.parse(readFileSync(p.config, 'utf8'))
    assert.deepEqual(written.custom, config.custom)
    assert.deepEqual(written.migrations.other, config.migrations.other)
    const at = Date.parse(written.migrations.accessLevels.at)
    assert.ok(at >= started - 1000 && at <= Date.now() + 1000)
    await stop(live.client, live.daemon)
    await world.close()
  })
  await check('rollback migration uses the existing cutoff and never replaces the first backup', async () => {
    const p = await prepare()
    const raw = { version: 1, sessions: [record('older'), record('newer', { createdAt: '2026-01-03T00:00:00.000Z' }), record('equal', { createdAt: fixedMarker }), record('invalid', { createdAt: 'not-a-date' }), record('compact-year', { createdAt: '01/03/26' })] }
    seed(p, raw)
    const firstBackup = JSON.stringify({ version: 1, sessions: [record('original')] }) + '\n'
    writePrivate(`${p.sessions}.bak-v1`, firstBackup)
    const world = makeOracle(raw)
    const live = await start(p)
    assert.deepEqual(sessions(p), wire(world.registry.list()))
    assert.equal(sessions(p).find((r) => r.name === 'older').approval, 'inherit')
    for (const name of ['newer', 'equal', 'invalid', 'compact-year']) assert.equal(sessions(p).find((r) => r.name === name).approval, undefined)
    assert.equal(readFileSync(`${p.sessions}.bak-v1`, 'utf8'), firstBackup)
    assert.deepEqual(JSON.parse(readFileSync(p.config, 'utf8')), markedConfig)
    await stop(live.client, live.daemon)
    await world.close()
  })
  await check('receipt matching uses typed tuples so delimiter collisions cannot discard unsent messages', async () => {
    const p = await prepare()
    const raw = { version: 2, sessions: [record('collision', { queue: [
      { id: 'a:b', at: 'c', text: 'must remain' },
      { id: 'number', at: '1', text: 'numeric receipt is not a matching string receipt' },
      { id: 'missing', at: 'undefined', text: 'missing receipt-at is not a matching string receipt' },
      { id: 'accepted', at: 'proper', text: 'already accepted' },
    ] })] }
    const rows = [event(1, 'collision', 'message.user', { queueItemId: 'a', queueItemAt: 'b:c' }), event(2, 'collision', 'message.user', { queueItemId: 'number', queueItemAt: 1 }), event(3, 'collision', 'message.user', { queueItemId: 'missing' }), event(4, 'collision', 'message.user', { queueItemId: 'accepted', queueItemAt: 'proper' })]
    seed(p, raw, rows)
    const live = await start(p)
    assert.deepEqual(sessions(p)[0].queue.map((q) => q.id), ['a:b', 'number', 'missing'])
    assert.equal(sessions(p)[0].queuePaused, true)
    await stop(live.client, live.daemon)
  })
  await check('durable global receipts prevent re-sending when the session projection is missing or stale', async () => {
    for (const projection of ['missing', 'stale']) {
      const p = await prepare()
      const raw = { version: 2, sessions: [record('authoritative', { queue: [
        { id: 'accepted', at: 'accepted-at', text: 'already accepted in the durable global journal' },
        { id: 'pending', at: 'pending-at', text: 'still unsent' },
      ] })] }
      const rows = [
        event(1, 'authoritative', 'message.user', { text: 'earlier turn' }),
        event(2, 'authoritative', 'message.user', { text: 'accepted turn', queueItemId: 'accepted', queueItemAt: 'accepted-at' }),
      ]
      seed(p, raw, rows)
      const file = join(p.events, sessionFileName('authoritative'))
      if (projection === 'missing') rmSync(file)
      else writePrivate(file, JSON.stringify(rows[0]) + '\n')
      const projectionBefore = existsSync(file) ? readFileSync(file) : null
      const journalBefore = readFileSync(p.journal)
      const live = await start(p)
      assert.deepEqual(sessions(p)[0].queue.map((item) => item.id), ['pending'])
      assert.equal(sessions(p)[0].queuePaused, true)
      assert.deepEqual(readFileSync(p.journal), journalBefore, 'recovery cannot append or re-send a queued prompt')
      assert.deepEqual(existsSync(file) ? readFileSync(file) : null, projectionBefore, 'receipt recovery must not silently rebuild a projection')
      const history = await live.client.request('events.history', { sessionId: 'authoritative' })
      assert.deepEqual(history.events, projection === 'missing' ? [] : rows.slice(0, 1))
      await stop(live.client, live.daemon)
    }
  })
  await check('corrupt sessions and config fail closed without rewriting either file', async () => {
    for (const [which, body] of [
      ['sessions', '{"truncated":'], ['config', '{"truncated":'],
      ['sessions', JSON.stringify({ version: 3, sessions: [record('keep')] })],
      ['sessions', '[]'], ['sessions', '{"version":2,"sessions":{}}'], ['config', '[]'],
      ['config', JSON.stringify({ migrations: { accessLevels: { at: '2026-01-01T24:00:00.1Z' } } })],
    ]) {
      const p = await prepare()
      seed(p, { version: 2, sessions: [record('keep')] })
      writePrivate(p[which], body)
      const before = [readFileSync(p.sessions), readFileSync(p.config), readFileSync(p.journal)]
      await rejectsStartup(p)
      assert.deepEqual([readFileSync(p.sessions), readFileSync(p.config), readFileSync(p.journal)], before)
    }
  })
  await check('unsafe registry, config and migration-backup paths refuse without touching their targets', async () => {
    for (const which of ['sessions', 'config', 'backup']) for (const kind of ['symlink', 'hardlink', 'fifo', 'public']) {
      const p = await prepare()
      seed(p, { version: which === 'backup' ? 1 : 2, sessions: [record('keep')] })
      const file = which === 'backup' ? `${p.sessions}.bak-v1` : p[which]
      if (which === 'backup') writeJSON(file, { version: 1, sessions: [record('original')] })
      const target = join(p.home, 'sentinel')
      const original = readFileSync(file)
      if (kind === 'public') chmodSync(file, 0o644)
      else {
        renameSync(file, target)
        if (kind === 'symlink') symlinkSync(target, file)
        else if (kind === 'hardlink') linkSync(target, file)
        else execFileSync('mkfifo', [file])
      }
      await rejectsStartup(p)
      if (kind !== 'public') assert.deepEqual(readFileSync(target), original)
      else assert.deepEqual(readFileSync(file), original)
    }
  })
  await check('a failed live save cannot overwrite an unsafe target or acknowledge success', async () => {
    const p = await prepare()
    seed(p, { version: 2, sessions: [record('keep')] })
    const live = await start(p)
    const saved = readFileSync(p.sessions)
    renameSync(p.sessions, join(p.home, 'saved'))
    const sentinel = join(p.home, 'sentinel')
    writePrivate(sentinel, 'must not change\n')
    symlinkSync(sentinel, p.sessions)
    await assert.rejects(live.client.request('agent.rename', { name: 'keep', title: 'must fail' }), (error) => ['internal', 'registry_write_failed'].includes(error.code))
    assert.equal(readFileSync(sentinel, 'utf8'), 'must not change\n')
    assert.equal((await live.client.request('daemon.status')).pid, live.daemon.child.pid)
    await stop(live.client, live.daemon)
    rmSync(p.sessions)
    renameSync(join(p.home, 'saved'), p.sessions)
    const restarted = await start(p)
    assert.deepEqual(readFileSync(p.sessions), saved)
    await stop(restarted.client, restarted.daemon)
  })
  await oracle.close()
  console.log(`registry interop passed ${passed}`)
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
