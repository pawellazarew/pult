import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const root = fileURLToPath(new URL('../../', import.meta.url))
assert.ok(existsSync(join(root, 'dist/cli/client.js')), 'Run npm ci && npm run build before scoped memory interoperability tests')
const { connectClient } = await import(new URL('../../dist/cli/client.js', import.meta.url))
const { layout } = await import(new URL('../../dist/core/paths.js', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync(join(tmpdir(), 'm2r-'))
chmodSync(scratch, 0o700)
const paths = layout(join(scratch, 'h'))
const projectA = join(scratch, 'a')
const projectB = join(scratch, 'b')
const general = join(scratch, 'general')
const worktree = join(scratch, 'linked')
const epoch = '2026-01-01T00:00:00.000Z'
const children = new Set()
const owners = new Set()
const scopes = new Set()
const sockets = new Set()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let live
let passed = 0
let sequence = 0
let noteA
let noteB
let globalNote
let keyA
let keyB
let clientA
let clientB

function writePrivate(file, value) { writeFileSync(file, value, { mode: 0o600 }); chmodSync(file, 0o600) }
function cleanEnvironment() { return Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'PULT_MEMORY_KEY' && !name.startsWith('GIT_'))) }
function git(args, cwd) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Pult fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd, encoding: 'utf8', timeout: 5000,
    env: { ...cleanEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  assert.equal(result.status, 0, `git fixture ${args[0]}: ${result.stderr}`)
}
function record(name, provider, cwd, extra = {}) {
  return { name, provider, cwd, mode: 'turn', createdAt: epoch, lastStatus: 'cold', lastEventId: 0,
    seenEventId: 0, approval: 'read-only', ...extra }
}
function launch() {
  const child = spawn(binary, ['--home', paths.home, 'daemon', 'serve'], {
    env: { ...cleanEnvironment(), PULT_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', (value) => { stderr = (stderr + value).slice(-8192) })
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
    assert.ok(daemon.child.exitCode === null && daemon.child.signalCode === null, `scoped memory startup exited\n${daemon.stderr}`)
    if (existsSync(paths.sock) && existsSync(paths.token)) {
      let client
      try {
        client = await connectClient(paths, { locale: () => 'ru', timeoutMs: 500 })
        const status = await client.request('daemon.status', {}, { timeoutMs: 500 })
        if (status.pid === daemon.child.pid) { owners.add(client); return { daemon, client } }
      } catch { /* stale endpoint publication during a restart */ }
      client?.close()
    }
    await pause(10)
  }
  throw new Error(`scoped memory startup deadline\n${daemon.stderr}`)
}
async function stop() {
  assert.deepEqual(await live.client.request('daemon.stop'), { stopping: true })
  live.client.close(); owners.delete(live.client)
  assert.equal((await live.daemon.exited).code, 0, live.daemon.stderr)
}
const owner = (method, params = {}) => live.client.request(`memory.${method}`, params)
const bind = (session, enabled = true) => owner('context.bind', { session, enabled })
const issue = (session) => owner('context.issue', { session })
function add(commandId, more = {}) {
  return { commandId, name: 'Shared decision', summary: 'Кедр 🌊: общая проверенная заметка',
    details: 'PRIVATE_DETAILS_DO_NOT_INJECT: use a transaction', reason: 'Owner fixture decision', ...more }
}

async function scoped(key, extra = {}) {
  const socket = net.createConnection(paths.sock)
  socket.setEncoding('utf8'); sockets.add(socket)
  let buffer = ''
  let initial = true
  const pending = new Map()
  let resolveHello
  let rejectHello
  const handshake = new Promise((resolve, reject) => { resolveHello = resolve; rejectHello = reject })
  const helloTimer = setTimeout(() => rejectHello(new Error('scoped memory handshake deadline')), 3000)
  function fail(error) {
    if (initial) { initial = false; clearTimeout(helloTimer); rejectHello(error) }
    for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error) }
    pending.clear()
  }
  socket.on('error', fail)
  socket.on('close', () => fail(Object.assign(new Error('scoped memory socket closed'), { code: 'closed' })))
  socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', protocol: 1, memory: key, client: 'memory-fixture', ...extra }) + '\n'))
  socket.on('data', (text) => {
    buffer += text
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return fail(new Error('scoped memory response reader overflow'))
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let message
      try { message = JSON.parse(buffer.slice(0, newline)) } catch (error) { return fail(error) }
      buffer = buffer.slice(newline + 1)
      if (initial) {
        initial = false; clearTimeout(helloTimer)
        if (message.type === 'hello_ok') resolveHello(message)
        else rejectHello(Object.assign(new Error(message.message ?? 'scoped memory handshake rejected'), { code: message.code, wire: message }))
        continue
      }
      const wait = pending.get(message.id)
      if (!wait) continue
      pending.delete(message.id); clearTimeout(wait.timer)
      if (message.error) wait.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      else wait.resolve(message.result)
    }
  })
  try { await handshake } catch (error) { socket.destroy(); sockets.delete(socket); throw error }
  const client = {
    request(method, params = {}) {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`scoped ${method} deadline`)) }, 4000)
        pending.set(id, { resolve, reject, timer })
        socket.write(JSON.stringify({ id, method, params }) + '\n')
      })
    },
    close() { scopes.delete(client); sockets.delete(socket); socket.destroy() },
  }
  scopes.add(client)
  return client
}
const read = (client, method, params = {}) => client.request(`memory.${method}`, params)
async function denied(client, method, params = {}, codes = ['forbidden']) {
  await assert.rejects(client.request(method, params), (error) => codes.includes(error.code), `${method} must be rejected as ${codes.join('/')}`)
}
async function badHello(key, extra = {}) { await assert.rejects(scoped(key, extra), (error) => error.code === 'bad_token') }
async function check(name, action) { await action(); passed++; console.log(`pass ${name}`) }
async function cleanup() {
  for (const client of scopes) client.close()
  for (const client of owners) client.close()
  for (const socket of sockets) socket.destroy()
  await Promise.all([...children].map(async (daemon) => {
    daemon.child.kill('SIGTERM')
    const timer = setTimeout(() => daemon.child.kill('SIGKILL'), 1000)
    try { await daemon.exited } finally { clearTimeout(timer) }
  }))
  rmSync(scratch, { recursive: true, force: true })
}
const watchdog = setTimeout(async () => {
  console.error('scoped memory interoperability exceeded its cleanup watchdog')
  await cleanup(); process.exit(1)
}, 90_000)

try {
  for (const path of [projectA, projectB, general]) mkdirSync(path)
  for (const path of [projectA, projectB]) { git(['init', '--initial-branch=main'], path); git(['commit', '--allow-empty', '-m', 'fixture'], path) }
  git(['worktree', 'add', '--detach', worktree, 'HEAD'], projectA)
  live = await start(); await stop()
  writePrivate(paths.sessions, JSON.stringify({ version: 2, sessions: [
    record('claude-a', 'claude', projectA), record('codex-a', 'codex', projectA), record('zcode-a', 'zcode', projectA),
    record('project-b', 'codex', projectB), record('general', 'codex', general, { scope: 'general' }),
    record('linked-a', 'codex', worktree, { worktree: { path: worktree, repo: projectA, branch: 'fixture' } }),
  ] }) + '\n')
  writePrivate(paths.config, JSON.stringify({ language: 'ru', migrations: { accessLevels: { at: epoch } } }) + '\n')
  live = await start()
  globalNote = await owner('add', add('global', { scope: 'global', name: 'Global preference', summary: 'Общее правило', details: 'GLOBAL_PRIVATE_DETAILS_DO_NOT_INJECT' }))
  noteA = await owner('add', add('a', { session: 'claude-a', pinned: true }))
  noteB = await owner('add', add('b', { session: 'project-b', name: 'Foreign decision', summary: 'OTHER_PROJECT_SENTINEL' }))

  await check('owner binds a trusted session and issues an opaque read-only credential without exposing it in status', async () => {
    const context = await bind('claude-a')
    assert.equal(context.session, 'claude-a'); assert.equal(context.enabled, true); assert.equal(context.readOnly, true)
    assert.equal(context.projectId, noteA.projectId)
    assert.match(context.generation, /^[a-f0-9]{32}$/)
    const ownerIssue = spawnSync(binary, ['--home', paths.home, 'memory', 'context', 'issue', '--params', JSON.stringify({ session: 'claude-a' })], {
      encoding: 'utf8', timeout: 5000, env: { ...cleanEnvironment(), PULT_LANG: 'ru' },
    })
    assert.equal(ownerIssue.status, 0, ownerIssue.stderr)
    const issued = JSON.parse(ownerIssue.stdout); keyA = issued.key
    assert.equal(ownerIssue.stderr.includes(keyA), false)
    assert.match(keyA, /^mem_[a-f0-9]{64}$/)
    assert.deepEqual(issued.context, context)
    const status = await owner('context.status')
    assert.equal(status.contexts.some((item) => item.session === 'claude-a'), true)
    assert.equal(JSON.stringify(status).includes(keyA), false)
    const ownerStatus = spawnSync(binary, ['--home', paths.home, 'memory', 'context', 'status'], {
      encoding: 'utf8', timeout: 5000, env: { ...cleanEnvironment(), PULT_LANG: 'ru' },
    })
    assert.equal(ownerStatus.status, 0, ownerStatus.stderr)
    assert.deepEqual(JSON.parse(ownerStatus.stdout), status)
    clientA = await scoped(keyA)
  })
  await check('a scoped connection reads only its project and global knowledge', async () => {
    assert.deepEqual(new Set((await read(clientA, 'list')).memories.map((item) => item.id)), new Set([noteA.id, globalNote.id]))
    assert.deepEqual(await read(clientA, 'get', { id: noteA.id }), noteA)
    assert.deepEqual(await read(clientA, 'get', { id: globalNote.id }), globalNote)
    await denied(clientA, 'memory.get', { id: noteB.id }, ['not_found'])
    assert.deepEqual((await read(clientA, 'search', { query: 'OTHER_PROJECT_SENTINEL' })).memories, [])
    await bind('project-b'); keyB = (await issue('project-b')).key; clientB = await scoped(keyB)
    await denied(clientB, 'memory.get', { id: noteA.id }, ['not_found'])
    assert.deepEqual(await read(clientB, 'get', { id: noteB.id }), noteB)
  })
  await check('read scopes can narrow visibility but arbitrary session and project selectors cannot redirect it', async () => {
    assert.deepEqual((await read(clientA, 'list', { scope: 'project' })).memories.map((item) => item.id), [noteA.id])
    assert.deepEqual((await read(clientA, 'list', { scope: 'global' })).memories.map((item) => item.id), [globalNote.id])
    for (const params of [{ session: 'project-b' }, { session: 'claude-a' }, { projectId: noteB.projectId }]) {
      await denied(clientA, 'memory.list', params, ['invalid_params', 'forbidden'])
    }
    assert.deepEqual(await read(clientA, 'get', { id: noteA.id }), noteA)
  })
  await check('memory credentials cannot mutate memory, inspect deleted history or use owner/core routes', async () => {
    for (const [method, params] of [
      ['memory.add', add('scope-write')], ['memory.update', { id: noteA.id, expectedVersion: 1, commandId: 'scope-update', reason: 'denied', summary: 'denied' }],
      ['memory.forget', { id: noteA.id, expectedVersion: 1, commandId: 'scope-forget', reason: 'denied' }],
      ['memory.history', { id: noteA.id }], ['daemon.status', {}], ['daemon.stop', {}], ['events.tail', {}],
      ['protocol.catalog', {}], ['memory.context.issue', { session: 'project-b' }], ['agent.archive', { name: 'project-b', archived: true }],
    ]) await denied(clientA, method, params)
    assert.deepEqual(await read(clientA, 'get', { id: noteA.id }), noteA)
    assert.equal((await live.client.request('daemon.status')).pid, live.daemon.child.pid)
  })
  await check('question/runtime/owner credentials cannot be mixed with the memory role', async () => {
    for (const extra of [{ token: readFileSync(paths.token, 'utf8') }, { token: '' }, { ask: 'not-an-ask-key' }, { runtime: 'not-a-runtime-key' }]) {
      await badHello(keyA, extra)
    }
    for (const key of ['', 'mem_bad', `mem_${'0'.repeat(64)}`, keyA.toUpperCase()]) await badHello(key)
    assert.deepEqual(await read(clientA, 'get', { id: noteA.id }), noteA)
  })
  await check('issuing another key rotates the old credential on existing connections and new handshakes', async () => {
    const rotated = await issue('claude-a')
    assert.notEqual(rotated.key, keyA)
    await denied(clientA, 'memory.list')
    await badHello(keyA)
    keyA = rotated.key; clientA.close(); clientA = await scoped(keyA)
    assert.deepEqual(await read(clientA, 'get', { id: noteA.id }), noteA)
  })
  await check('explicit revoke removes a binding and rejects its old key without owner-token fallback', async () => {
    assert.deepEqual(await owner('context.revoke', { session: 'claude-a' }), { revoked: true })
    await denied(clientA, 'memory.list'); await badHello(keyA)
    await assert.rejects(issue('claude-a'), (error) => ['not_found', 'forbidden'].includes(error.code))
    assert.deepEqual(await owner('context.revoke', { session: 'claude-a' }), { revoked: false })
    await bind('claude-a'); keyA = (await issue('claude-a')).key
    clientA.close(); clientA = await scoped(keyA)
  })
  await check('disabled memory invalidates keys, denies issuance and leaves owner administration available', async () => {
    const disabled = await bind('claude-a', false)
    assert.equal(disabled.enabled, false)
    await denied(clientA, 'memory.list'); await badHello(keyA)
    await assert.rejects(issue('claude-a'), (error) => error.code === 'forbidden')
    assert.deepEqual(await owner('get', { session: 'claude-a', id: noteA.id }), noteA)
    await bind('claude-a'); keyA = (await issue('claude-a')).key
    clientA.close(); clientA = await scoped(keyA)
  })
  await check('archiving revokes access and unarchiving does not silently restore credentials', async () => {
    await live.client.request('agent.archive', { name: 'claude-a', archived: true })
    await denied(clientA, 'memory.list'); await badHello(keyA)
    await assert.rejects(bind('claude-a'), (error) => ['not_found', 'forbidden'].includes(error.code))
    await live.client.request('agent.archive', { name: 'claude-a', archived: false })
    await badHello(keyA)
    await bind('claude-a'); keyA = (await issue('claude-a')).key
    clientA.close(); clientA = await scoped(keyA)
  })
  await check('Claude, Codex, ZCode and a linked worktree share one project catalogue through identical scoped reads', async () => {
    const base = await read(clientA, 'catalog')
    for (const session of ['codex-a', 'zcode-a', 'linked-a']) {
      const context = await bind(session)
      assert.equal(context.projectId, noteA.projectId)
      const issued = await issue(session)
      const client = await scoped(issued.key)
      const catalogue = await read(client, 'catalog')
      assert.equal(catalogue.text, base.text)
      assert.deepEqual(catalogue.memories, base.memories)
      assert.equal(catalogue.context.session, session)
      client.close()
    }
  })
  await check('a general chat sees only global notes even when its workspace is an existing directory', async () => {
    const context = await bind('general')
    assert.equal(Object.hasOwn(context, 'projectId'), false)
    const issued = await issue('general'); const client = await scoped(issued.key)
    assert.deepEqual((await read(client, 'list')).memories.map((item) => item.id), [globalNote.id])
    await denied(client, 'memory.get', { id: noteA.id }, ['not_found'])
    const catalogue = await read(client, 'catalog')
    assert.equal(catalogue.memories.some((item) => item.id === noteA.id), false)
    assert.equal(catalogue.memories.some((item) => item.id === globalNote.id), true)
    client.close()
  })
  await check('a bounded catalogue contains IDs and versions but never full details, credentials or another project', async () => {
    for (let i = 0; i < 54; i++) await owner('add', add(`budget-${i}`, {
      session: 'claude-a', name: `Budget ${i} 🌊`, summary: `Short summary ${i} ${'🌊Ж'.repeat(100)}`,
      details: `CATALOG_PRIVATE_${i}`, pinned: i % 2 === 0,
    }))
    const catalogue = await read(clientA, 'catalog')
    assert.ok([...catalogue.text].length <= 4000)
    assert.ok(Buffer.byteLength(catalogue.text) <= 16000)
    assert.equal(catalogue.truncated, true)
    assert.match(catalogue.text, /search|get/i)
    assert.ok(catalogue.memories.length > 0)
    assert.ok(catalogue.memories.length <= 50)
    for (const item of catalogue.memories) {
      assert.deepEqual(Object.keys(item).sort(), ['id', 'version'])
      assert.ok(item.id); assert.ok(Number.isSafeInteger(item.version) && item.version > 0)
    }
    for (const forbidden of ['PRIVATE_DETAILS_DO_NOT_INJECT', 'GLOBAL_PRIVATE_DETAILS_DO_NOT_INJECT', 'CATALOG_PRIVATE_', keyA, keyB, 'OTHER_PROJECT_SENTINEL']) {
      assert.equal(JSON.stringify(catalogue).includes(forbidden), false, `catalogue leaked ${forbidden}`)
    }
    assert.deepEqual(await owner('catalog', { session: 'claude-a' }), catalogue)
  })
  await check('the next catalogue request reflects a new owner version without reissuing the scoped key', async () => {
    const fresh = await owner('add', add('fresh-owner', { session: 'claude-a', name: 'fresh', summary: 'FRESH_OWNER_VERSION_ONE', pinned: true }))
    await owner('update', { session: 'claude-a', id: fresh.id, expectedVersion: 1, commandId: 'fresh-owner-update',
      reason: 'Owner updated a visible decision', summary: 'FRESH_OWNER_VERSION_TWO' })
    assert.equal((await read(clientA, 'get', { id: fresh.id })).version, 2)
    const catalogue = await read(clientA, 'catalog')
    assert.equal(catalogue.text.includes('FRESH_OWNER_VERSION_ONE'), false)
    assert.equal(catalogue.memories.some((item) => item.id === fresh.id), true, 'the newest pinned note fits the next catalogue')
    assert.equal(catalogue.memories.find((item) => item.id === fresh.id).version, 2)
    assert.match(catalogue.text, /FRESH_OWNER_VERSION_TWO/)
  })
  await check('pinned project identity cannot be redirected by rewriting Git metadata; owner rebind is required', async () => {
    const marker = join(projectA, '.git')
    const saved = join(projectA, '.git-original')
    renameSync(marker, saved)
    try {
      writeFileSync(marker, `gitdir: ${join(projectB, '.git')}\n`)
      assert.deepEqual(await read(clientA, 'get', { id: noteA.id }), noteA)
      await denied(clientA, 'memory.get', { id: noteB.id }, ['not_found'])
      const rebound = await bind('claude-a')
      assert.equal(rebound.projectId, noteB.projectId)
      await denied(clientA, 'memory.list'); await badHello(keyA)
      const next = await scoped((await issue('claude-a')).key)
      assert.deepEqual(await read(next, 'get', { id: noteB.id }), noteB)
      await denied(next, 'memory.get', { id: noteA.id }, ['not_found'])
      next.close()
    } finally { rmSync(marker, { force: true }); renameSync(saved, marker) }
    await bind('claude-a'); keyA = (await issue('claude-a')).key
    clientA.close(); clientA = await scoped(keyA)
  })
  await check('scoped CLI does not read owner token or config and never falls back to owner access', async () => {
    const token = readFileSync(paths.token)
    const config = readFileSync(paths.config)
    const run = (args, key = keyA, home = paths.home) => spawnSync(binary, ['--home', home, ...args], {
      encoding: 'utf8', timeout: 5000, env: { ...cleanEnvironment(), PULT_MEMORY_KEY: key },
    })
    try {
      writePrivate(paths.token, 'not-the-owner-token\n'); writePrivate(paths.config, '{ deliberately invalid owner config')
      const listed = run(['memory', 'list'])
      assert.equal(listed.status, 0, listed.stderr)
      assert.equal(JSON.parse(listed.stdout).memories.some((item) => item.id === noteB.id), false)
      const catalogue = run(['memory', 'catalog'])
      assert.equal(catalogue.status, 0, catalogue.stderr)
      assert.equal(JSON.parse(catalogue.stdout).context.session, 'claude-a')
      const privileged = run(['daemon', 'status'])
      assert.notEqual(privileged.status, 0); assert.equal(privileged.stdout, '')
      const issued = run(['memory', 'context', 'issue', '--params', JSON.stringify({ session: 'project-b' })])
      assert.notEqual(issued.status, 0); assert.equal(issued.stdout, '')
      assert.equal(listed.stderr.includes(keyA) || catalogue.stderr.includes(keyA), false)
    } finally { writePrivate(paths.token, token); writePrivate(paths.config, config) }
    // With a valid owner token present, neither an invalid key nor a forbidden
    // route may silently reconnect as the owner.
    const invalidKey = `mem_${'f'.repeat(64)}`
    const invalid = run(['memory', 'list'], invalidKey)
    assert.notEqual(invalid.status, 0); assert.equal(invalid.stdout, '')
    assert.equal(invalid.stderr.includes(invalidKey), false)
    const privileged = run(['daemon', 'status'])
    assert.notEqual(privileged.status, 0); assert.equal(privileged.stdout, '')
    const issued = run(['memory', 'context', 'issue', '--params', JSON.stringify({ session: 'project-b' })])
    assert.notEqual(issued.status, 0); assert.equal(issued.stdout, '')
    const forbiddenHome = join(scratch, 'must-not-bootstrap')
    const boot = run(['daemon', 'serve'], keyA, forbiddenHome)
    assert.notEqual(boot.status, 0)
    assert.equal(boot.error, undefined, 'scoped daemon serve must refuse, not launch until a timeout')
    assert.equal(boot.signal, null)
    assert.equal(existsSync(forbiddenHome), false)
    assert.equal((await live.client.request('daemon.status')).pid, live.daemon.child.pid)
  })
  await check('invalid parameters and Unicode fail while the read-only connection remains usable', async () => {
    await denied(clientA, 'memory.search', { query: String.fromCharCode(0xd800) }, ['invalid_params'])
    await denied(clientA, 'memory.list', { limit: 51 }, ['invalid_params'])
    await denied(clientA, 'memory.catalog', { session: 'claude-a' }, ['invalid_params', 'forbidden'])
    await assert.rejects(bind('missing-session'), (error) => error.code === 'not_found')
    await assert.rejects(owner('catalog'), (error) => error.code === 'invalid_params')
    assert.deepEqual(await read(clientA, 'get', { id: noteA.id }), noteA)
  })
  await check('restart invalidates all bindings and keys without changing persistent notes or session storage', async () => {
    const journal = readFileSync(paths.journal)
    const registry = readFileSync(paths.sessions)
    const remembered = await read(clientA, 'get', { id: noteA.id })
    const oldKey = keyA
    await stop(); live = await start()
    await badHello(oldKey); await badHello(keyB)
    assert.deepEqual(await owner('context.status'), { contexts: [] })
    assert.deepEqual(await owner('get', { session: 'claude-a', id: noteA.id }), remembered)
    assert.deepEqual(readFileSync(paths.journal), journal)
    assert.deepEqual(readFileSync(paths.sessions), registry)
    await bind('claude-a'); keyA = (await issue('claude-a')).key
    clientA.close(); clientA = await scoped(keyA)
    assert.deepEqual(await read(clientA, 'get', { id: noteA.id }), remembered)
  })
  console.log(`scoped memory interop passed ${passed}`)
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
