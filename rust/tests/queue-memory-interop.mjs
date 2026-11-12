import { readCompleteJsonl } from './support/complete-jsonl.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const { connectClient } = await import('../../dist/cli/client.js')
const { layout } = await import('../../dist/core/paths.js')
const root = fileURLToPath(new URL('../../', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync('/tmp/qmturn-')
chmodSync(scratch, 0o700)
const home = join(scratch, 'home'), account = join(scratch, 'account'), native = join(account, 'native')
const projectA = join(scratch, 'a'), projectB = join(scratch, 'b')
for (const directory of [home, account, native, projectA, projectB]) { mkdirSync(directory); chmodSync(directory, 0o700) }
writeFileSync(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { codex: { mode: 'off' }, guard: { mode: 'allow', countries: ['FI'] } }, migrations: { accessLevels: { at: '2026-11-01T00:00:00Z' } } }), { mode: 0o600 })
const env = { ...process.env, HOME: account, PULT_TEST: '1', PULT_CODEX_BIN: join(root, 'rust/tests/fixtures/codex_memory.py'), PULT_CURL_BIN: join(root, 'rust/tests/fixtures/curl_loc_fi.sh'), OPENAI_API_KEY: 'fixture-not-a-real-account' }
for (const key of ['PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_HOLDER_BIN']) delete env[key]
const paths = layout(home)
const boundedClient = original => ({ ...original, request: (method, params, options = {}) => original.request(method, params, { timeoutMs: 10000, ...options }) })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const jsonl = readCompleteJsonl
const evidence = () => jsonl(join(native, 'memory-fixture.jsonl'))
const journal = () => jsonl(join(home, 'events/journal.jsonl'))
const records = () => JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
let child, exited, stderr = '', client, passed = 0
function launch() {
  stderr = ''
  child = spawn(binary, ['--home', home, 'daemon', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8000) })
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
}
launch()
const sockets = new Set()
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    assert.equal(child.exitCode, null, `daemon exited: ${stderr}`)
    assert.ok(Date.now() < deadline, `${label}; fixture=${JSON.stringify(evidence().slice(-5))}; stderr=${stderr}`)
    await pause(10)
  }
}
async function check(label, run) { await run(); passed++; console.log(`pass ${label}`) }
const memory = (method, params = {}) => client.request(`memory.${method}`, params, { timeoutMs: 5000 })
const session = async name => (await client.request('agent.list')).sessions.find(value => value.name === name)
async function start(name, cwd = projectA, more = {}) {
  const params = { kind: 'codex', name, cwd, approval: 'ask', memory: { read: true, write: 'ask' }, ...more }
  if (params.scope === 'general') delete params.cwd
  try { return await client.request('agent.start', params) } catch (error) { error.message = `agent.start ${name}: ${error.message}`; throw error }
}
async function card(name) {
  let value
  await until(async () => { value = (await client.request('perm.list', { name })).pending[0]; return !!value }, `permission missing for ${name}`)
  assert.equal(value.toolName, 'pult_memory.propose')
  assert.equal(value.offers?.session ?? false, false)
  assert.equal(value.offers?.rule, undefined)
  return value
}
async function raw(credentials) {
  const socket = net.createConnection(paths.sock); sockets.add(socket)
  const frames = [], waiters = [], requests = new Map(); let buffer = '', sequence = 0
  socket.on('error', () => {})
  socket.on('data', bytes => { buffer += bytes.toString(); while (buffer.includes('\n')) { const at = buffer.indexOf('\n'); const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); const request = requests.get(frame.id); if (request) { requests.delete(frame.id); request(frame) } else { const waiter = waiters.shift(); waiter ? waiter(frame) : frames.push(frame) } } })
  const next = () => frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve, reject) => {
    const receive = frame => { clearTimeout(timer); resolve(frame) }
    const timer = setTimeout(() => { const at = waiters.indexOf(receive); if (at >= 0) waiters.splice(at, 1); reject(Error('raw memory deadline')) }, 4000)
    waiters.push(receive)
  })
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.write(JSON.stringify({ type: 'hello', protocol: 1, client: 'local-memory-test', ...credentials }) + '\n')
  const hello = await next()
  const request = (method, params = {}) => {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(Error('raw memory request deadline')) }, 4000)
      requests.set(id, frame => { clearTimeout(timer); resolve(frame) })
      socket.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  return { hello, next, request, close: () => { sockets.delete(socket); socket.destroy() } }
}
const proposal = (record, commandId, summary) => ({ operation: 'update', id: record.id, expectedVersion: record.version, commandId, summary, reason: 'Owner-reviewed local fixture decision' })
async function cleanup() {
  for (const socket of sockets) socket.destroy()
  if (client) { try { await client.request('daemon.stop', {}, { timeoutMs: 3000 }) } catch {} client.close() }
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited, pause(3000)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  await Promise.race([exited, pause(1000)])
  // Bounded cleanup also covers fixture regressions that orphan a child.
  for (const row of evidence()) for (const pid of [row.pid, row.mcpPid].filter(Boolean)) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} } }
  rmSync(scratch, { recursive: true, force: true })
}

let note, neighborPid, attachment, unknown, heldBacklog
const send = (run, flags = {}, name = 'writer') => client.request('agent.prompt', { name, text: JSON.stringify(run), ...flags }, { timeoutMs: 15000 })
const stored = name => records().find(record => record.name === name)
const queuedReceipt = id => journal().find(event => event.sessionId === 'writer' && event.kind === 'message.user' && event.data.queueItemId === id)
const dispatch = run => evidence().find(row => row.kind === 'dispatch' && row.run === run)
async function outcome(run) { await until(() => evidence().some(row => row.kind === 'result' && row.run === run), `missing ${run}`); return evidence().find(row => row.kind === 'result' && row.run === run) }
async function terminal(name, status = 'done') { await until(async () => { const row = await session(name); return row.status === status && row.liveApproval === null }, `terminal/cleanup ${name}/${status}`) }
async function reaped(pid) { await until(() => evidence().filter(row => row.kind === 'mcp-started' && row.pid === pid).every(row => !alive(row.mcpPid)) && !alive(pid), `unreaped dedicated host ${pid}`) }
const watchdog = setTimeout(async () => { console.error('composed queue memory watchdog'); await cleanup(); process.exit(1) }, 165000)
try {
  await until(() => existsSync(paths.sock) && existsSync(paths.token), 'startup')
  client = boundedClient(await connectClient(paths, { timeoutMs: 5000 }))
  await check('live fixture JSONL waits for newline and rejects complete corrupt records', async () => {
    const file = join(native, 'reader-probe.jsonl')
    writeFileSync(file, '{"first":1}\n{"second":"par', { mode: 0o600 })
    assert.deepEqual(jsonl(file), [{ first: 1 }])
    appendFileSync(file, 'tial"}')
    assert.deepEqual(jsonl(file), [{ first: 1 }], 'a complete JSON value still needs its record newline')
    appendFileSync(file, '\n')
    assert.deepEqual(jsonl(file), [{ first: 1 }, { second: 'partial' }])
    appendFileSync(file, '{"broken":}\n')
    assert.throws(() => jsonl(file), SyntaxError, 'complete corrupt records must not be hidden')
    rmSync(file)
  })
  await check('ordinary setup has real memory MCP and a distinct shared neighbor', async () => {
    await start('writer')
    await start('neighbor', projectA, { memory: { read: false, write: 'off' } })
    await send({ run: 'neighbor', mode: 'hold' }, {}, 'neighbor')
    neighborPid = dispatch('neighbor').pid
    note = await memory('add', { session: 'writer', commandId: 'seed-composed', name: 'Queue convention', summary: 'original one', details: 'PRIVATE_DETAILS_NOT_CATALOG', reason: 'Owner seed' })
    const directory = join(home, 'attachments', 'writer', 'day')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, 'notes.txt'), bytes = Buffer.from('fixture attachment text')
    writeFileSync(file, bytes, { mode: 0o600 })
    attachment = { path: realpathSync(file), name: 'notes.txt', bytes: bytes.length, mime: 'text/plain', kind: 'file' }
    assert.equal((await session('writer')).memory.read, true)
    assert.ok(alive(neighborPid))
  })
  await check('queued write waits for real accepted receipt; allow persists queue provenance and next-turn catalog', async () => {
    const primer = await send({ run: 'queue-primer', mode: 'hold' })
    const first = await send({ run: 'queued-write', id: note.id, proposal: proposal(note, 'queued-memory-write', 'queue version two') }, { queue: true, attachments: [attachment] })
    const second = await send({ run: 'queued-read-two', id: note.id }, { queue: true })
    assert.equal(first.queued, true); assert.equal(second.queued, true)
    const original = structuredClone(stored('writer').queue)
    assert.deepEqual(original.map(item => item.id), [first.id, second.id]); assert.deepEqual(original[0].attachments, [attachment])
    assert.equal(queuedReceipt(first.id), undefined); assert.equal(queuedReceipt(second.id), undefined)
    await client.request('agent.rename', { name: 'writer', title: 'Concurrent queue title' })
    assert.deepEqual(stored('writer').queue, original)
    assert.equal((await send({ run: 'finish-queue-primer' }, { steer: true })).turnId, primer.turnId)
    const pending = await card('writer')
    const receipt = queuedReceipt(first.id)
    assert.ok(receipt, 'proposal must not invent an input receipt before durable acceptance')
    assert.equal(pending.input.sourceEventId, receipt.id)
    assert.notEqual(pending.input.sourceTurnId, primer.turnId)
    assert.equal(receipt.data.queueItemAt, original[0].at)
    assert.deepEqual(receipt.data.attachments, [attachment])
    assert.equal(queuedReceipt(second.id), undefined)
    assert.equal(dispatch('queued-read-two'), undefined, 'next item dispatched before human decision')
    assert.deepEqual(await memory('get', { session: 'writer', id: note.id }), note)
    await client.request('perm.resolve', { id: pending.id, decision: 'allow', scope: 'once' })
    const written = await outcome('queued-write'), next = await outcome('queued-read-two')
    await terminal('writer')
    assert.equal(written.proposal.version, 2); assert.equal(next.get.version, 2)
    note = await memory('get', { session: 'writer', id: note.id })
    assert.equal(note.sourceEventId, receipt.id); assert.equal(note.sourceTurnId, pending.input.sourceTurnId)
    assert.equal(note.sourceCreatedAt, stored('writer').createdAt); assert.equal(note.author, 'codex')
    assert.ok(next.catalog.memories.some(row => row.id === note.id && row.version === 2))
    const dataBlock = dispatch('queued-read-two').texts[1].split('\n').slice(1).filter(line => line.startsWith('{')).map(JSON.parse)
    assert.ok(dataBlock.some(row => row.id === note.id && row.version === 2))
    assert.ok(!dispatch('queued-write').texts[1].includes('PRIVATE_DETAILS_NOT_CATALOG'))
    assert.notEqual(written.pid, next.pid); assert.notEqual(written.pid, neighborPid)
    assert.equal(evidence().find(row => row.kind === 'thread' && row.pid === next.pid).method, 'thread/resume')
    assert.deepEqual(stored('writer').memory, { read: true, write: 'ask' })
    assert.equal(stored('writer').title, 'Concurrent queue title'); assert.equal(stored('writer').queue?.length ?? 0, 0)
    assert.equal(stored('writer').queueDispatch, undefined)
    assert.equal(journal().filter(row => row.kind === 'message.user' && row.data.queueItemId === first.id).length, 1)
    assert.equal(journal().filter(row => row.kind === 'message.user' && row.data.queueItemId === second.id).length, 1)
    await reaped(written.pid); await reaped(next.pid); assert.ok(alive(neighborPid))
  })
  await check('steer resolves exact dedicated Lease.host and retains honest base-turn memory provenance', async () => {
    const base = await send({ run: 'steer-holder', mode: 'hold' })
    const active = dispatch('steer-holder')
    const baseReceipt = journal().find(row => row.kind === 'message.user' && row.data.text.includes('steer-holder'))
    const steered = await send({ run: 'dedicated-steer', id: note.id, proposal: proposal(note, 'steer-memory-write', 'steered version three') }, { steer: true })
    assert.equal(steered.turnId, base.turnId)
    const routed = evidence().find(row => row.kind === 'steer' && row.run === 'dedicated-steer')
    assert.equal(routed.pid, active.pid); assert.notEqual(routed.pid, neighborPid)
    assert.equal(routed.expectedTurnId, active.turn); assert.equal(routed.thread, active.thread)
    const pending = await card('writer')
    assert.equal(pending.input.sourceTurnId, base.turnId); assert.equal(pending.input.sourceEventId, baseReceipt.id)
    const steeringReceipt = journal().find(row => row.kind === 'message.user' && row.data.steering && row.data.text.includes('dedicated-steer'))
    assert.ok(steeringReceipt); assert.notEqual(steeringReceipt.id, baseReceipt.id)
    await client.request('perm.resolve', { id: pending.id, decision: 'allow', scope: 'once' })
    assert.equal((await outcome('dedicated-steer')).proposal.version, 3)
    await terminal('writer')
    note = await memory('get', { session: 'writer', id: note.id })
    assert.equal(note.sourceEventId, baseReceipt.id); assert.equal(note.sourceTurnId, base.turnId)
    await reaped(active.pid); assert.ok(alive(neighborPid)); assert.equal((await session('neighbor')).status, 'working')
  })
  await check('failed queued memory turn pauses backlog before release; explicit resume reads current memory', async () => {
    await send({ run: 'failure-primer', mode: 'hold' })
    const failed = await send({ run: 'queued-failure', id: note.id, status: 'failed' }, { queue: true })
    const after = await send({ run: 'after-failure', id: note.id }, { queue: true })
    const saved = structuredClone(stored('writer').queue[1])
    await send({ run: 'finish-failure-primer' }, { steer: true })
    assert.equal((await outcome('queued-failure')).get.version, 3)
    await terminal('writer', 'failed')
    assert.equal(stored('writer').queuePaused, true)
    assert.deepEqual(stored('writer').queue, [saved]); assert.equal(dispatch('after-failure'), undefined)
    assert.ok(queuedReceipt(failed.id)); assert.equal(queuedReceipt(after.id), undefined)
    assert.deepEqual(stored('writer').memory, { read: true, write: 'ask' })
    await client.request('agent.queue.resume', { name: 'writer' })
    assert.equal((await outcome('after-failure')).get.version, 3)
    await terminal('writer'); assert.equal(stored('writer').queue?.length ?? 0, 0)
  })
  await check('interrupt replacement uses fresh MCP while old backlog stays paused and unchanged', async () => {
    const before = await send({ run: 'interrupt-primer', mode: 'hold' })
    const old = dispatch('interrupt-primer')
    const after = await send({ run: 'after-interrupt', id: note.id }, { queue: true, attachments: [attachment] })
    const saved = structuredClone(stored('writer').queue)
    const replacement = await send({ run: 'interrupt-replacement', id: note.id }, { interrupt: true })
    assert.notEqual(replacement.turnId, before.turnId)
    assert.equal((await outcome('interrupt-replacement')).get.version, 3)
    await terminal('writer')
    assert.equal(stored('writer').queuePaused, true); assert.deepEqual(stored('writer').queue, saved)
    assert.equal(queuedReceipt(after.id), undefined); assert.equal(dispatch('after-interrupt'), undefined)
    assert.notEqual(dispatch('interrupt-replacement').pid, old.pid)
    await reaped(old.pid); assert.ok(alive(neighborPid))
    await client.request('agent.queue.resume', { name: 'writer' })
    assert.equal((await outcome('after-interrupt')).get.version, 3)
    await terminal('writer'); assert.deepEqual(queuedReceipt(after.id).data.attachments, [attachment])
  })
  await check('unknown queued memory acceptance has no forged receipt or automatic resend', async () => {
    await send({ run: 'unknown-primer', mode: 'hold' })
    unknown = await send({ run: 'unknown-queued', unknown: true, id: note.id }, { queue: true, attachments: [attachment] })
    heldBacklog = structuredClone(stored('writer').queue[0])
    await client.request('agent.stop', { name: 'writer' }); await terminal('writer', 'interrupted')
    await assert.rejects(client.request('agent.queue.send', { name: 'writer', id: unknown.id }, { timeoutMs: 15000 }))
    await terminal('writer', 'failed')
    assert.equal(queuedReceipt(unknown.id), undefined)
    assert.equal(stored('writer').queuePaused, true)
    assert.deepEqual(stored('writer').queueDispatch, { id: heldBacklog.id, at: heldBacklog.at })
    assert.deepEqual(stored('writer').queue, [heldBacklog])
    await assert.rejects(client.request('agent.queue.resume', { name: 'writer' }), error => error.code === 'send_unknown')
    assert.equal(evidence().filter(row => row.kind === 'dispatch' && row.run === 'unknown-queued').length, 1)
    assert.equal((await client.request('perm.list', { name: 'writer' })).pending.length, 0)
    assert.equal((await memory('get', { session: 'writer', id: note.id })).version, 3)
    await reaped(dispatch('unknown-queued').pid)
  })
  await check('Node rollback and Rust restart preserve both memory policy and unknown queue metadata', async () => {
    await client.request('agent.stop', { name: 'neighbor' }); await terminal('neighbor', 'interrupted')
    await client.request('daemon.stop'); client.close(); client = null
    assert.equal((await exited).code, 0)
    const config = readFileSync(join(home, 'config.json')), consentFile = join(home, 'consent.json')
    const consent = existsSync(consentFile) ? readFileSync(consentFile) : null
    const { createRegistry } = await import('../../dist/sessions/registry.js')
    const rollback = createRegistry(paths)
    rollback.coolDown(); rollback.update('writer', { title: 'Rollback preserved title' })
    assert.deepEqual(stored('writer').memory, { read: true, write: 'ask' })
    assert.deepEqual(stored('writer').queue, [heldBacklog])
    assert.deepEqual(stored('writer').queueDispatch, { id: heldBacklog.id, at: heldBacklog.at })
    assert.equal(stored('writer').queuePaused, true)
    assert.deepEqual(readFileSync(join(home, 'config.json')), config)
    assert.equal(existsSync(consentFile), consent !== null)
    if (consent) assert.deepEqual(readFileSync(consentFile), consent)
    const dispatchCount = evidence().filter(row => row.kind === 'dispatch').length
    launch(); await until(() => existsSync(paths.sock) && existsSync(paths.token), 'restart socket')
    client = boundedClient(await connectClient(paths, { timeoutMs: 5000 }))
    console.log('restart: owner connected; checking recovered projection')
    assert.equal((await session('writer')).status, 'failed')
    console.log('restart: projection available; checking runtime')
    assert.equal((await client.request('daemon.status')).nativeRuntime.initialized, false)
    console.log('restart: runtime cold; checking stale capability')
    const staleKey = jsonl(join(native, 'private-keys.jsonl'))[0].key
    const stale = await raw({ memoryTurn: staleKey })
    try { assert.equal(stale.hello.code, 'bad_token') } finally { stale.close() }
    console.log('restart: stale capability rejected; checking unknown queue marker')
    await assert.rejects(client.request('agent.queue.resume', { name: 'writer' }), error => error.code === 'send_unknown')
    assert.equal(evidence().filter(row => row.kind === 'dispatch').length, dispatchCount)
    assert.equal(queuedReceipt(unknown.id), undefined)
  })
  await check('explicitly edited retry gets fresh queue provenance and the following turn observes committed memory', async () => {
    const edited = { run: 'edited-after-unknown', id: note.id, proposal: proposal(note, 'post-rollback-write', 'version four after explicit edit') }
    await client.request('agent.queue.move', { name: 'writer', id: unknown.id, text: JSON.stringify(edited) })
    assert.equal(stored('writer').queueDispatch, undefined)
    assert.equal(stored('writer').queue[0].id, heldBacklog.id); assert.equal(stored('writer').queue[0].at, heldBacklog.at)
    assert.deepEqual(stored('writer').queue[0].attachments, [attachment])
    await client.request('agent.queue.resume', { name: 'writer' })
    const pending = await card('writer'), receipt = queuedReceipt(unknown.id)
    assert.ok(receipt); assert.equal(pending.input.sourceEventId, receipt.id)
    assert.deepEqual(receipt.data.attachments, [attachment]); assert.equal(receipt.data.queueItemAt, heldBacklog.at)
    await client.request('perm.resolve', { id: pending.id, decision: 'allow', scope: 'once' })
    assert.equal((await outcome('edited-after-unknown')).proposal.version, 4)
    await terminal('writer')
    note = await memory('get', { session: 'writer', id: note.id })
    assert.equal(note.sourceEventId, receipt.id); assert.equal(note.sourceTurnId, pending.input.sourceTurnId)
    assert.equal(stored('writer').title, 'Rollback preserved title')
    await send({ run: 'final-read-four', id: note.id })
    const next = await outcome('final-read-four'); await terminal('writer')
    assert.equal(next.get.version, 4); assert.ok(next.catalog.memories.some(row => row.id === note.id && row.version === 4))
    assert.equal(journal().filter(row => row.kind === 'message.user' && row.data.queueItemId === unknown.id).length, 1)
  })
  await check('all ephemeral MCP generations and dedicated processes retire without key leakage', async () => {
    const children = evidence().filter(row => row.kind === 'mcp-started')
    await until(() => children.every(row => !alive(row.pid) && !alive(row.mcpPid)), 'dedicated process cleanup')
    const keys = jsonl(join(native, 'private-keys.jsonl')).map(row => row.key)
    assert.equal(new Set(keys).size, keys.length)
    const publicText = JSON.stringify(journal()) + JSON.stringify(await client.request('agent.list')) + stderr
    for (const key of keys) assert.ok(!publicText.includes(key))
    assert.equal(evidence().filter(row => row.kind === 'fixture-error').length, 0)
    assert.deepEqual(stored('writer').memory, { read: true, write: 'ask' })
    assert.equal(stored('writer').queue?.length ?? 0, 0)
  })
  console.log(`queue memory composed passed ${passed}`)
} catch (error) {
  const compact = evidence().slice(-12).map(row => ({ ...row, texts: row.texts?.map(text => text.slice(0, 120)), list: undefined }))
  console.error(`composed fixture ${JSON.stringify(compact)}; stderr=${stderr}`)
  throw error
} finally { clearTimeout(watchdog); await cleanup() }
