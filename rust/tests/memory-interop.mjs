import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const root = fileURLToPath(new URL('../../', import.meta.url))
assert.ok(existsSync(join(root, 'dist/cli/client.js')), 'Run npm ci && npm run build before memory interoperability tests')
const { connectClient } = await import(new URL('../../dist/cli/client.js', import.meta.url))
const { layout } = await import(new URL('../../dist/core/paths.js', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync(join(tmpdir(), 'm1m-'))
chmodSync(scratch, 0o700)
const paths = layout(join(scratch, 'h'))
const projectA = join(scratch, 'repo-a')
const projectB = join(scratch, 'folder-b')
const worktree = join(scratch, 'worktree-a')
const children = new Set()
const clients = new Set()
const sockets = new Set()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const epoch = '2026-01-01T00:00:00.000Z'
let live
let passed = 0
let globalRecord
let projectRecord
let winningUpdate
let winningResult
let deletedRecord
let journalBefore
let registryBefore

function writePrivate(file, text) { writeFileSync(file, text, { mode: 0o600 }); chmodSync(file, 0o600) }
function git(args, cwd) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Pult fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd, encoding: 'utf8', timeout: 5000,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  assert.equal(result.status, 0, `git fixture ${args[0]}: ${result.stderr}`)
}
function session(name, cwd, more = {}) {
  return { name, provider: 'codex', cwd, mode: 'turn', createdAt: epoch,
    lastStatus: 'cold', lastEventId: 0, seenEventId: 0, ...more }
}
function launch() {
  const child = spawn(binary, ['--home', paths.home, 'daemon', 'serve'], {
    env: { ...process.env, PULT_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', (text) => { stderr = (stderr + text).slice(-8192) })
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
  const daemon = launch()
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    assert.ok(daemon.child.exitCode === null && daemon.child.signalCode === null, `memory startup exited\n${daemon.stderr}`)
    if (existsSync(paths.sock) && existsSync(paths.token)) {
      let candidate
      try {
        candidate = await connectClient(paths, { timeoutMs: 500, locale: () => 'ru' })
        const status = await candidate.request('daemon.status', {}, { timeoutMs: 500 })
        if (status.pid === daemon.child.pid) {
          clients.add(candidate)
          return { daemon, client: candidate }
        }
      } catch { /* stale endpoint is replaced before the fresh token is published */ }
      candidate?.close()
    }
    await pause(10)
  }
  throw new Error(`memory startup deadline\n${daemon.stderr}`)
}
async function stop(instance) {
  assert.deepEqual(await instance.client.request('daemon.stop', {}, { timeoutMs: 3000 }), { stopping: true })
  instance.client.close(); clients.delete(instance.client)
  assert.equal((await instance.daemon.exited).code, 0, instance.daemon.stderr)
}
async function request(method, params = {}, client = live.client) { return client.request(`memory.${method}`, params) }
async function rejects(method, params, code = 'invalid_params', client = live.client) {
  await assert.rejects(request(method, params, client), (error) => error.code === code,
    `${method} must fail with ${code}`)
}
function add(commandId, more = {}) {
  return { commandId, name: 'SQLite convention', summary: 'Aurora: проверяем память проекта 🌊',
    details: 'Use transactions for SQLite writes. Согласованное решение: вечнозелёный кедр.',
    reason: 'Confirmed project decision in an owner-controlled fixture', ...more }
}
async function hello(extra) {
  const socket = net.createConnection(paths.sock)
  socket.setEncoding('utf8'); sockets.add(socket)
  try {
    return await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => finish(new Error('memory handshake deadline')), 3000)
      const finish = (error, value) => {
        clearTimeout(timer)
        if (error) reject(error); else resolve(value)
      }
      socket.once('error', (error) => finish(error))
      socket.once('connect', () => socket.write(JSON.stringify({ type: 'hello', protocol: 1,
        token: readFileSync(paths.token, 'utf8'), client: 'memory-scope-fixture', ...extra }) + '\n'))
      socket.on('data', (text) => {
        buffer += text
        if (buffer.includes('\n')) {
          try { finish(null, JSON.parse(buffer.slice(0, buffer.indexOf('\n')))) }
          catch (error) { finish(error) }
        }
      })
    })
  } finally { sockets.delete(socket); socket.destroy() }
}
async function check(name, run) { await run(); passed++; console.log(`pass ${name}`) }
async function cleanup() {
  for (const client of clients) client.close()
  for (const socket of sockets) socket.destroy()
  await Promise.all([...children].map(async (daemon) => {
    daemon.child.kill('SIGTERM')
    const timer = setTimeout(() => daemon.child.kill('SIGKILL'), 1000)
    try { await daemon.exited } finally { clearTimeout(timer) }
  }))
  rmSync(scratch, { recursive: true, force: true })
}
const watchdog = setTimeout(async () => {
  console.error('memory interoperability exceeded its cleanup watchdog')
  await cleanup(); process.exit(1)
}, 90_000)

try {
  mkdirSync(projectA); mkdirSync(projectB)
  git(['init', '--initial-branch=main'], projectA)
  git(['commit', '--allow-empty', '-m', 'fixture'], projectA)
  git(['worktree', 'add', '--detach', worktree, 'HEAD'], projectA)
  // Let the daemon create its private scratch marker before seeding registry fixtures.
  live = await start(); await stop(live)
  writePrivate(paths.sessions, JSON.stringify({ version: 2, sessions: [
    session('project-a', projectA), session('project-b', projectB),
    session('linked-a', worktree, { worktree: { path: worktree, branch: 'fixture', repo: projectA } }),
  ] }) + '\n')
  writePrivate(paths.config, JSON.stringify({ language: 'ru', migrations: { accessLevels: { at: epoch } } }) + '\n')
  live = await start()
  journalBefore = readFileSync(paths.journal)
  registryBefore = readFileSync(paths.sessions)

  await check('global writes are explicit and project writes require a registered session context', async () => {
    await rejects('add', add('missing-project'))
    globalRecord = await request('add', add('global-one', { scope: 'global', name: 'Global convention', summary: 'Shared global knowledge', details: 'General owner preference shared across projects' }))
    assert.equal(globalRecord.scope, 'global')
    assert.equal(globalRecord.version, 1)
    assert.equal(globalRecord.author, 'owner')
    assert.equal(globalRecord.deleted, false)
    assert.ok(globalRecord.id)
    assert.ok(Number.isFinite(Date.parse(globalRecord.createdAt)))
    assert.deepEqual((await request('list')).memories.map((row) => row.id), [globalRecord.id])
  })
  await check('project records preserve Unicode, provenance and pinned state without leaking details in lists', async () => {
    projectRecord = await request('add', add('project-one', { session: 'project-a', pinned: true }))
    assert.equal(projectRecord.scope, 'project')
    assert.ok(projectRecord.projectId)
    assert.equal(projectRecord.sourceSession, 'project-a')
    assert.equal(projectRecord.pinned, true)
    assert.equal(projectRecord.details, add('ignored').details)
    assert.equal(projectRecord.summary, add('ignored').summary)
    const listed = await request('list', { session: 'project-a' })
    assert.equal(listed.hasMore, false)
    assert.deepEqual(new Set(listed.memories.map((row) => row.id)), new Set([projectRecord.id, globalRecord.id]))
    for (const row of listed.memories) assert.equal(Object.hasOwn(row, 'details'), false)
    assert.deepEqual(await request('get', { session: 'project-a', id: projectRecord.id }), projectRecord)
  })
  await check('another project cannot read a known record or its history', async () => {
    assert.deepEqual((await request('list', { session: 'project-b' })).memories.map((row) => row.id), [globalRecord.id])
    await rejects('get', { session: 'project-b', id: projectRecord.id }, 'not_found')
    await rejects('history', { session: 'project-b', id: projectRecord.id }, 'not_found')
    await rejects('update', { session: 'project-b', commandId: 'cross-update', id: projectRecord.id,
      expectedVersion: 1, reason: 'Must not cross scopes', summary: 'forbidden' }, 'not_found')
    await rejects('forget', { session: 'project-b', commandId: 'cross-forget', id: projectRecord.id,
      expectedVersion: 1, reason: 'Must not cross scopes' }, 'not_found')
  })
  await check('a linked worktree sees exactly the main repository project memory', async () => {
    const linked = await request('get', { session: 'linked-a', id: projectRecord.id })
    assert.equal(linked.projectId, projectRecord.projectId)
    assert.deepEqual(linked, projectRecord)
    assert.deepEqual((await request('list', { session: 'linked-a', scope: 'project' })).memories.map((row) => row.id), [projectRecord.id])
  })
  await check('full-text search retrieves Unicode details and treats query syntax as data', async () => {
    const found = await request('search', { session: 'project-a', query: 'вечнозелёный' })
    assert.deepEqual(found.memories.map((row) => row.id), [projectRecord.id])
    assert.equal(Object.hasOwn(found.memories[0], 'details'), false)
    assert.deepEqual((await request('search', { session: 'project-b', query: 'вечнозелёный' })).memories, [])
    const literal = await request('search', { session: 'project-a', query: 'nonexistent OR "*"' })
    assert.deepEqual(literal.memories, [])
  })
  await check('list pagination is bounded and stable across pages', async () => {
    const first = await request('list', { session: 'project-a', limit: 1, offset: 0 })
    const next = await request('list', { session: 'project-a', limit: 1, offset: 1 })
    assert.equal(first.memories.length, 1)
    assert.equal(first.hasMore, true)
    assert.equal(next.memories.length, 1)
    assert.equal(next.hasMore, false)
    assert.notEqual(first.memories[0].id, next.memories[0].id)
    await rejects('list', { session: 'project-a', limit: 51 })
    await rejects('list', { session: 'project-a', offset: 10001 })
  })
  await check('concurrent clients cannot silently overwrite the same version', async () => {
    const second = await connectClient(paths, { locale: () => 'ru' }); clients.add(second)
    const updates = ['left', 'right'].map((side) => ({ session: 'project-a', commandId: `race-${side}`,
      id: projectRecord.id, expectedVersion: 1, reason: `Concurrent ${side} update`, summary: `Winner ${side} 🌊` }))
    const results = await Promise.allSettled(updates.map((params, i) => request('update', params, i ? second : live.client)))
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    const winner = results.findIndex((result) => result.status === 'fulfilled')
    winningUpdate = updates[winner]; winningResult = results[winner].value
    assert.equal(winningResult.version, 2)
    assert.equal(results[1 - winner].reason.code, 'conflict')
    assert.deepEqual(await request('get', { session: 'project-a', id: projectRecord.id }), winningResult)
    assert.equal((await request('history', { session: 'project-a', id: projectRecord.id })).versions.length, 2)
    second.close(); clients.delete(second)
  })
  await check('retrying add returns its original receipt without creating a second record', async () => {
    const retried = await request('add', add('project-one', { session: 'project-a', pinned: true }))
    assert.deepEqual(retried, projectRecord)
    assert.equal((await request('list', { session: 'project-a', scope: 'project' })).memories.length, 1)
    assert.equal((await request('history', { session: 'project-a', id: projectRecord.id })).versions.length, 2)
  })
  await check('retrying update preserves its original result and rejects command ID reuse with another payload', async () => {
    assert.deepEqual(await request('update', winningUpdate), winningResult)
    await rejects('update', { ...winningUpdate, summary: 'Changed retry body' }, 'command_conflict')
    await rejects('add', add('project-one', { session: 'project-a', pinned: true, summary: 'Changed add body' }), 'command_conflict')
    assert.equal((await request('history', { session: 'project-a', id: projectRecord.id })).versions.length, 2)
  })
  await check('command receipts cannot disclose a record when reused from another project', async () => {
    await rejects('add', add('project-one', { session: 'project-b', pinned: true }), 'command_conflict')
    assert.deepEqual((await request('list', { session: 'project-b', scope: 'project' })).memories, [])
  })
  await check('global update and forget require an explicit global write scope', async () => {
    const update = { commandId: 'global-update', id: globalRecord.id, expectedVersion: 1,
      reason: 'Explicit global owner update', summary: 'Updated shared knowledge' }
    await rejects('update', update)
    await rejects('update', { ...update, session: 'project-a' }, 'not_found')
    globalRecord = await request('update', { ...update, scope: 'global' })
    assert.equal(globalRecord.version, 2)
    await rejects('forget', { session: 'project-a', commandId: 'global-forget-implicit', id: globalRecord.id,
      expectedVersion: 2, reason: 'Must explicitly choose global' }, 'not_found')
  })
  await check('soft deletion hides records from reads and search while retaining scoped version history', async () => {
    const forget = { session: 'project-a', commandId: 'project-forget', id: projectRecord.id,
      expectedVersion: 2, reason: 'This convention is obsolete' }
    deletedRecord = await request('forget', forget)
    assert.equal(deletedRecord.deleted, true)
    assert.equal(deletedRecord.version, 3)
    assert.deepEqual(await request('forget', forget), deletedRecord)
    await rejects('get', { session: 'project-a', id: projectRecord.id }, 'not_found')
    assert.deepEqual((await request('search', { session: 'project-a', query: 'вечнозелёный' })).memories, [])
    assert.deepEqual((await request('list', { session: 'project-a', scope: 'project' })).memories, [])
    const history = await request('history', { session: 'project-a', id: projectRecord.id })
    assert.equal(history.versions.length, 3)
    assert.deepEqual(new Set(history.versions.map((row) => row.version)), new Set([1, 2, 3]))
    assert.equal(history.versions.find((row) => row.version === 3).deleted, true)
    await rejects('history', { session: 'project-b', id: projectRecord.id }, 'not_found')
    assert.deepEqual(await request('add', add('project-one', { session: 'project-a', pinned: true })), projectRecord)
    await rejects('get', { session: 'project-a', id: projectRecord.id }, 'not_found')
  })
  await check('malformed requests fail without poisoning a usable connection', async () => {
    await rejects('add', add('spoof-project', { session: 'project-a', projectId: projectRecord.projectId }))
    await rejects('add', add('bad-scope', { session: 'project-a', scope: 'all' }))
    await rejects('add', add('long-summary', { session: 'project-a', summary: 'x'.repeat(501) }))
    await rejects('add', add('long-details', { session: 'project-a', details: 'x'.repeat(16001) }))
    await rejects('add', add('surrogate', { session: 'project-a', details: String.fromCharCode(0xd800) }))
    await rejects('get', { session: 'not-registered', id: globalRecord.id }, 'not_found')
    await rejects('update', { session: 'project-a', scope: 'global', commandId: 'missing-version', id: globalRecord.id,
      reason: 'Missing version' })
    assert.equal((await live.client.request('daemon.status')).pid, live.daemon.child.pid)
  })
  await check('CLI memory operations use the same RPC data and error boundary', async () => {
    const run = (action, params) => spawnSync(binary, ['--home', paths.home, 'memory', action,
      '--params', JSON.stringify(params)], { encoding: 'utf8', timeout: 8000, env: { ...process.env, PULT_LANG: 'ru' } })
    const added = run('add', add('cli-one', { session: 'project-a', name: 'CLI decision' }))
    assert.equal(added.status, 0, added.stderr)
    const row = JSON.parse(added.stdout)
    assert.deepEqual(await request('get', { session: 'project-a', id: row.id }), row)
    const fetched = run('get', { session: 'project-a', id: row.id })
    assert.equal(fetched.status, 0, fetched.stderr)
    assert.deepEqual(JSON.parse(fetched.stdout), row)
    const denied = run('get', { session: 'project-b', id: row.id })
    assert.notEqual(denied.status, 0)
    assert.equal(denied.stdout, '')
    assert.match(denied.stderr, /not_found|not found/i)
  })
  await check('SIGKILL after acknowledgement preserves records, tombstones and receipts without changing session or event storage', async () => {
    const current = await request('get', { id: globalRecord.id, scope: 'global' })
    const history = await request('history', { session: 'project-a', id: projectRecord.id })
    assert.deepEqual(readFileSync(paths.journal), journalBefore)
    assert.deepEqual(readFileSync(paths.sessions), registryBefore)
    const acknowledgedParams = add('kill-after-ack', { session: 'project-a', name: 'Committed before SIGKILL' })
    const acknowledged = await request('add', acknowledgedParams)
    assert.equal(live.daemon.child.kill('SIGKILL'), true)
    assert.equal((await live.daemon.exited).signal, 'SIGKILL')
    live.client.close(); clients.delete(live.client)
    live = await start()
    assert.deepEqual(await request('get', { session: 'project-a', id: acknowledged.id }), acknowledged)
    assert.deepEqual(await request('add', acknowledgedParams), acknowledged)
    assert.deepEqual((await request('history', { session: 'project-a', id: acknowledged.id })).versions, [acknowledged])
    assert.deepEqual(await request('update', winningUpdate), winningResult)
    assert.deepEqual(await request('get', { id: globalRecord.id, scope: 'global' }), current)
    assert.deepEqual(await request('history', { session: 'project-a', id: projectRecord.id }), history)
    assert.deepEqual(await request('add', add('project-one', { session: 'project-a', pinned: true })), projectRecord)
    await rejects('get', { session: 'project-a', id: projectRecord.id }, 'not_found')
    assert.deepEqual(readFileSync(paths.journal), journalBefore)
    assert.deepEqual(readFileSync(paths.sessions), registryBefore)
  })
  await check('runtime and question credentials cannot use the owner-only memory API', async () => {
    for (const scoped of [{ runtime: { session: 'project-a' } }, { ask: { session: 'project-a' } }]) {
      const response = await hello(scoped)
      assert.equal(response.type, 'error')
      assert.equal(response.code, 'bad_token')
    }
    assert.equal((await live.client.request('daemon.status')).pid, live.daemon.child.pid)
  })
  await check('a corrupt memory database disables memory while preserving the core daemon and original bytes', async () => {
    await stop(live)
    const database = join(paths.home, 'memory', 'memory.sqlite3')
    assert.ok(existsSync(database), 'memory database must be created in its private directory')
    renameSync(database, join(scratch, 'memory-before-corruption.sqlite3'))
    const corrupt = Buffer.from('This is an intentionally corrupt SQLite memory fixture.\n', 'utf8')
    writePrivate(database, corrupt)
    live = await start()
    const status = await live.client.request('daemon.status')
    assert.equal(status.memory.available, false)
    assert.ok(status.memory.error)
    await assert.rejects(request('list'), (error) => error.code === 'internal' && /memory unavailable/i.test(error.message))
    assert.deepEqual(await live.client.request('events.tail', { since: 0, limit: 1 }), { cursor: 0, events: [] })
    assert.deepEqual(await live.client.request('agent.read', { name: 'project-a' }), { cursor: 0, text: '' })
    assert.deepEqual(readFileSync(database), corrupt)
    assert.deepEqual(readFileSync(paths.journal), journalBefore)
    assert.deepEqual(readFileSync(paths.sessions), registryBefore)
    await stop(live)
  })
  console.log(`memory interop passed ${passed}`)
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
