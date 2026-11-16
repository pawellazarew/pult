import { readCompleteJsonl } from './support/complete-jsonl.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
const { connectClient } = await import('../../dist/cli/client.js')
const { layout } = await import('../../dist/core/paths.js')
const root = fileURLToPath(new URL('../../', import.meta.url))
const binary = resolve(process.argv[2])
const coldSiteBarrier = process.argv[3] === '--cold-peer-site-barrier'
const journalTail = process.argv[3] === '--journal-unfinished-tail'
const journalCorrupt = process.argv[3] === '--journal-corrupt-complete'
assert.ok(process.argv[3] === undefined || coldSiteBarrier || journalTail || journalCorrupt, 'unknown private fixture mode')
const temp = mkdtempSync('/tmp/r3-session-')
chmodSync(temp, 0o700)
const home = join(temp, 'home'), account = join(temp, 'account'), native = join(account, 'native'), project = join(temp, 'project')
for (const path of [home, account, native, project]) { mkdirSync(path); chmodSync(path, 0o700) }
writeFileSync(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { codex: { mode: 'off' }, guard: { mode: 'allow', countries: ['FI'] } } }), { mode: 0o600 })
const env = { ...process.env, HOME: account, PULT_TEST: '1', PULT_CODEX_BIN: join(root, 'rust/tests/fixtures/codex_daemon.py'), PULT_CURL_BIN: join(root, 'rust/tests/fixtures/curl_loc_fi.sh'), OPENAI_API_KEY: 'fixture-only' }
for (const key of ['PULT_MEMORY_KEY', 'PULT_HOLDER_BIN']) delete env[key]
const paths = layout(home)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let client
let child, exited, stderr
function launch() {
  stderr = ''
  child = spawn(binary, ['--home', home, 'daemon', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000) })
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
}
launch()
let checks = 0
let fixtureFailed = false
async function until(check, label) {
  const deadline = Date.now() + 6000
  while (!await check()) { assert.equal(child.exitCode, null, `daemon exited: ${stderr}`); assert.ok(Date.now() < deadline, label); await pause(10) }
}
const journal = () => readCompleteJsonl(join(home, 'events/journal.jsonl'))
async function check(label, run) {
  // The new controlled regression needs only cold setup and the actual unknown
  // retry lifecycle. Normal mode retains every one of its original 18 checks.
  if (coldSiteBarrier && !['creates and lists cold metadata without a provider or receipt', 'unknown native delivery remains actionable and cannot Resume automatically'].includes(label)) return
  if ((journalTail || journalCorrupt) && !['creates and lists cold metadata without a provider or receipt', 'ordinary Codex turn uses the real daemon journal and durable thread metadata'].includes(label)) return
  try { await run() } catch (error) { fixtureFailed = true; throw error }
  checks++; console.log(`pass ${label}`)
}
// Failure-only private-fixture projection. Never print native arguments/config,
// user text, capability values, IDs, paths or reflected backend messages.
function boundedFile(path, offset = 0, limit = 256 * 1024) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size < offset || info.size - offset > limit) return null
    const data = Buffer.alloc(info.size - offset)
    const count = readSync(fd, data, 0, data.length, offset)
    return data.subarray(0, count).toString('utf8')
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}
function fileOffset(path) {
  let fd
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const info = fstatSync(fd); return info.isFile() ? info.size : 0 }
  catch { return 0 } finally { if (fd !== undefined) closeSync(fd) }
}
function boundedRows(path, offset) {
  const text = boundedFile(path, offset)
  if (text === null) return null
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)
  if (lines.length > 256) return null
  try { return lines.map(line => JSON.parse(line)) } catch { return null }
}
async function unknownDrainDiagnostic(nativeOffset, journalOffset, context) {
  const unavailable = () => ({})
  const [list, status] = await Promise.all([
    client.request('agent.list', {}, { timeoutMs: 500 }).catch(unavailable),
    client.request('daemon.status', {}, { timeoutMs: 500 }).catch(unavailable),
  ])
  const row = Array.isArray(list.sessions) ? list.sessions.find(row => row.name === 'one') ?? {} : {}
  const methods = ['initialize', 'initialized', 'thread/start', 'thread/resume', 'config/read', 'mcpServerStatus/list', 'turn/start', 'turn/interrupt', 'turn/steer']
  const counts = Object.fromEntries(methods.map(name => [name, 0]))
  const nativeRows = boundedRows(join(native, 'messages.jsonl'), nativeOffset)
  for (const frame of nativeRows ?? []) if (methods.includes(frame.method)) counts[frame.method]++
  const events = boundedRows(join(home, 'events/journal.jsonl'), journalOffset)
  const codes = new Set(['unavailable', 'provider_unavailable', 'memory_unavailable', 'start_unknown', 'send_unknown', 'interrupted', 'cancelled', 'storage_unavailable', 'thread_store_rejected', 'cleanup_timeout', 'cleanup_unconfirmed', 'unsupported', 'capacity', 'invalid_params', 'internal', 'unsupported_background'])
  let failureCode = 'none'
  for (const event of events ?? []) {
    const code = event?.data?.code ?? event?.data?.errorCode ?? event?.data?.error?.code
    if (typeof code === 'string') failureCode = codes.has(code) ? code : 'other'
  }
  let recordedNativePidAlive = false
  try {
    const ids = JSON.parse(boundedFile(join(native, 'pids.json'), 0, 1024) ?? 'null')
    if (Array.isArray(ids) && Number.isSafeInteger(ids[1]) && ids[1] > 1 && ids[1] < 2147483648) { process.kill(ids[1], 0); recordedNativePidAlive = true }
  } catch {}
  const knownStatuses = new Set(['cold', 'working', 'idle', 'failed', 'interrupted', 'done', 'blocked', 'starting', 'waiting'])
  let providerReadError = 'none', providerReadPhase = 'none'
  try {
    const evidence = JSON.parse(boundedFile(join(native, 'fixture-read-error.json'), 0, 1024) ?? 'null')
    if (['UnicodeDecodeError', 'JSONDecodeError', 'AssertionError', 'KeyError', 'other'].includes(evidence?.errorClass)) providerReadError = evidence.errorClass
    if (['bootstrap', 'turn_start_journal', 'permission_journal'].includes(evidence?.phase)) providerReadPhase = evidence.phase
  } catch {}
  console.error('[unknown-drain-fixture] ' + JSON.stringify({
    phase: context?.phase ?? 'edited_unknown_cold_retry', ...(context ? { failedRPC: context.method, rpcErrorCode: codes.has(context.code) ? context.code : 'other', providerReadError, providerReadPhase } : {}), status: knownStatuses.has(row.status) ? row.status : 'other',
    queueCount: Array.isArray(row.queue) ? Math.min(row.queue.length, 129) : -1,
    queuePaused: row.queuePaused === true,
    activeTurns: Number.isSafeInteger(status.nativeRuntime?.activeTurns) ? status.nativeRuntime.activeTurns : -1,
    hosts: Number.isSafeInteger(status.nativeRuntime?.hosts) ? status.nativeRuntime.hosts : -1,
    failureCode, nativeRowsAvailable: nativeRows !== null, nativeMethodCounts: counts,
    journalRowsAvailable: events !== null, recordedNativePidAlive,
    controlledSiteHookEntered: existsSync(join(temp, 'cold-site', 'entered')),
  }))
}
async function nativeCli(args, extra = {}) {
  const process = spawn(binary, ['--home', home, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  process.stdout.on('data', bytes => { stdout += bytes })
  process.stderr.on('data', bytes => { stderr += bytes })
  const timer = setTimeout(() => process.kill('SIGKILL'), 6000)
  try { const code = await new Promise(resolve => process.once('exit', resolve)); return { code, stdout, stderr } }
  finally { clearTimeout(timer) }
}
async function rawClient(memory) {
  const socket = net.createConnection(paths.sock)
  const frames = [], pending = []
  let text = ''
  socket.on('data', bytes => { text += bytes.toString(); while (text.includes('\n')) { const at = text.indexOf('\n'); const frame = JSON.parse(text.slice(0, at)); text = text.slice(at + 1); const waiter = pending.shift(); waiter ? waiter(frame) : frames.push(frame) } })
  socket.on('error', () => {})
  const next = () => frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve, reject) => {
    const receive = frame => { clearTimeout(timer); resolve(frame) }
    const timer = setTimeout(() => { const at = pending.indexOf(receive); if (at >= 0) pending.splice(at, 1); reject(Error('wire frame deadline')) }, 3000)
    pending.push(receive)
  })
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.write(JSON.stringify({ type: 'hello', protocol: 1, client: 'cli', ...(memory ? { memory } : { token: readFileSync(paths.token, 'utf8') }) }) + '\n')
  const hello = await next(); assert.equal(hello.type, 'hello_ok')
  return { hello, send: frame => socket.write(JSON.stringify(frame) + '\n'), next, close: () => socket.destroy() }
}
try {
  await until(() => existsSync(paths.sock) && existsSync(paths.token), 'daemon startup deadline')
  client = await connectClient(paths, { timeoutMs: 3000 })
  await check('creates and lists cold metadata without a provider or receipt', async () => {
    for (const [name, approval] of [['one', 'read-only'], ['ask', 'ask'], ['race', 'read-only']]) {
      const created = await client.request('agent.start', { kind: 'codex', name, cwd: project, approval })
      assert.equal(created.name, name); assert.equal(created.status, 'cold')
    }
    const list = await client.request('agent.list')
    assert.equal(list.sessions.length, 3); assert.ok(list.sessions.every(row => row.pendingPermissions === 0 && row.liveApproval === null))
    assert.equal(journal().length, 0); assert.equal(existsSync(join(native, 'messages.jsonl')), false)
  })
  await check('unsupported send forms leave no receipt or host', async () => {
    await assert.rejects(client.request('agent.prompt', { name: 'one', text: 'hello', queue: true, steer: true }), e => e.code === 'invalid_params')
    assert.equal(journal().length, 0); assert.equal(existsSync(join(native, 'messages.jsonl')), false)
  })
  await check('ordinary Codex turn uses the real daemon journal and durable thread metadata', async () => {
    if (journalTail || journalCorrupt) writeFileSync(join(native, 'journal-snapshot-mode'), journalTail ? 'unfinished_utf8' : 'corrupt_complete', { mode: 0o600 })
    if (journalCorrupt) {
      await assert.rejects(client.request('agent.prompt', { name: 'one', text: 'hello one' }), error => error.code === 'internal')
      await until(async () => (await client.request('daemon.status')).nativeRuntime.activeTurns === 0, 'corrupt snapshot did not drain')
      assert.deepEqual(JSON.parse(boundedFile(join(native, 'fixture-read-error.json'), 0, 1024)), { phase: 'turn_start_journal', errorClass: 'JSONDecodeError' })
      const copied = JSON.parse(boundedFile(join(native, 'journal-snapshot-evidence.json'), 0, 1024))
      assert.deepEqual(copied, { copiedWorkingReceipt: true, mode: 'corrupt_complete', sourceUnchanged: true })
      assert.equal(journal().filter(row => row.kind === 'message.user').length, 1)
      assert.equal(journal().filter(row => row.kind === 'message.done').length, 0)
      return
    }
    let accepted
    try { accepted = await client.request('agent.prompt', { name: 'one', text: 'hello one' }) }
    catch (error) {
      if (journalTail) try { await unknownDrainDiagnostic(0, 0, { phase: 'controlled_journal_tail', method: 'agent.prompt', code: error.code }) } catch { console.error('[accepted-fixture] diagnostic-unavailable') }
      throw error
    }
    assert.match(accepted.turnId, /^pult-/)
    await until(async () => (await client.request('agent.list')).sessions.find(row => row.name === 'one').status === 'idle', 'turn did not finish')
    const events = journal().filter(row => row.sessionId === 'one')
    assert.equal(events.filter(row => row.kind === 'message.user').length, 1)
    assert.ok(events.some(row => row.kind === 'message.done'))
    const records = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions
    assert.ok(records.find(row => row.name === 'one').providerSessionId)
    assert.equal((await client.request('daemon.status')).nativeRuntime.hosts, 1)
    if (journalTail) {
      assert.deepEqual(JSON.parse(boundedFile(join(native, 'journal-snapshot-evidence.json'), 0, 1024)), { copiedWorkingReceipt: true, mode: 'unfinished_utf8', sourceUnchanged: true })
      assert.equal(existsSync(join(native, 'fixture-read-error.json')), false)
    }
  })
  await check('permission resolution is durable and rejects input rewriting', async () => {
    await client.request('agent.prompt', { name: 'ask', text: 'permit' })
    let card
    await until(async () => { card = (await client.request('perm.list', { name: 'ask' })).pending[0]; return !!card }, 'permission missing')
    assert.equal((await client.request('agent.list')).sessions.find(row => row.name === 'ask').status, 'blocked_permission')
    await assert.rejects(client.request('perm.resolve', { id: card.id, decision: 'allow', updatedInput: null }), e => e.code === 'invalid_params')
    assert.equal((await client.request('perm.list', { name: 'ask' })).pending.length, 1)
    const result = await client.request('perm.resolve', { id: card.id, decision: 'allow', scope: 'once' })
    assert.equal(result.resolved, true)
    await until(async () => (await client.request('agent.list')).sessions.find(row => row.name === 'ask').status === 'idle', 'resolved turn did not finish')
    assert.ok(journal().some(row => row.kind === 'permission.resolved' && row.data.decision === 'allow'))
  })
  await check('a stale turn id cannot stop the current turn', async () => {
    const accepted = await client.request('agent.prompt', { name: 'one', text: 'hold' })
    assert.equal((await client.request('agent.stop', { name: 'one', turnId: 'pult-stale' })).stopped, false)
    assert.equal((await client.request('agent.list')).sessions.find(row => row.name === 'one').status, 'working')
    assert.equal((await client.request('agent.stop', { name: 'one', turnId: accepted.turnId })).stopped, true)
    await until(async () => (await client.request('agent.list')).sessions.find(row => row.name === 'one').status === 'interrupted', 'stop did not interrupt')
  })
  await until(async () => (await client.request('daemon.status')).nativeRuntime.activeTurns === 0, 'previous stop cleanup')
  const row = async name => (await client.request('agent.list')).sessions.find(row => row.name === name)
  const done = name => until(async () => ['idle', 'done', 'failed', 'interrupted'].includes((await row(name)).status) && (await client.request('daemon.status')).nativeRuntime.activeTurns === 0, `${name}: terminal`)
  const queue = async (text, name = 'one') => client.request('agent.prompt', { name, text, queue: true })
  await check('steering uses same public turn and rejection has no fake receipt', async () => {
    const active = await client.request('agent.prompt', { name: 'one', text: 'hold steering' })
    const before = journal().filter(e => e.kind === 'message.user').length
    await assert.rejects(client.request('agent.prompt', { name: 'one', text: 'reject-steer', steer: true }), e => e.code === 'invalid_params')
    assert.equal(journal().filter(e => e.kind === 'message.user').length, before)
    const steered = await client.request('agent.prompt', { name: 'one', text: 'clarify', steer: true })
    assert.equal(steered.turnId, active.turnId)
    const receipt = journal().find(e => e.kind === 'message.user' && e.data.text === 'clarify')
    assert.equal(receipt.data.steering, true); assert.equal(receipt.data.turnId, active.turnId)
  })
  await check('selected queue send steers only that item; edit/move/remove preserve remaining order', async () => {
    const a = await queue('🦀'.repeat(240)), b = await queue('selected second')
    assert.equal(a.queued, true); assert.equal(b.queued, true)
    assert.equal((await client.request('agent.stop', { name: 'one', turnId: 'stale-queue-turn' })).stopped, false)
    assert.notEqual((await row('one')).queuePaused, true)
    const selected = await client.request('agent.queue.send', { name: 'one', id: b.id })
    assert.match(selected.turnId, /^pult-/)
    await assert.rejects(client.request('agent.queue.send', { name: 'one', id: b.id }), e => e.code === 'queue_item_sent')
    const held = await client.request('agent.queue.move', { name: 'one', id: a.id, hold: true })
    assert.equal([...held.queue[0].text].length, 200); assert.equal([...held.edit.text].length, 240)
    const storedBefore = JSON.parse(readFileSync(join(home, 'sessions.json'))).sessions.find(r => r.name === 'one').queue[0]
    await client.request('agent.queue.move', { name: 'one', id: a.id, text: 'edited first' })
    const storedAfter = JSON.parse(readFileSync(join(home, 'sessions.json'))).sessions.find(r => r.name === 'one').queue[0]
    assert.equal(storedBefore.id, storedAfter.id); assert.equal(storedBefore.at, storedAfter.at)
    assert.deepEqual(journal().find(e => e.kind === 'queue.updated').data, { id: a.id })
    const c = await queue('remove me')
    await client.request('agent.queue.move', { name: 'one', id: c.id, to: 0 })
    assert.deepEqual((await row('one')).queue.map(q => q.id), [c.id, a.id])
    await client.request('agent.queue.remove', { name: 'one', id: c.id })
    await assert.rejects(client.request('agent.queue.move', { name: 'one', id: c.id, text: 'late' }), e => e.code === 'queue_item_removed')
    const receipt = journal().find(e => e.kind === 'message.user' && e.data.queueItemId === b.id)
    assert.equal(receipt.data.steering, true); assert.equal(typeof receipt.data.queueItemAt, 'string')
  })
  await check('successful completion drains FIFO with durable per-item receipts', async () => {
    const second = await queue('fifo second')
    await client.request('agent.prompt', { name: 'one', text: 'complete-steer', steer: true })
    await until(async () => !(await row('one')).queue?.length && (await row('one')).status === 'idle', 'FIFO did not drain')
    const messages = journal().filter(e => e.sessionId === 'one' && e.kind === 'message.user')
    const first = messages.findIndex(e => e.data.text === 'edited first'), last = messages.findIndex(e => e.data.queueItemId === second.id)
    assert.ok(first >= 0 && last > first); assert.equal(messages.filter(e => e.data.queueItemId === second.id).length, 1)
  })
  await check('interrupt-and-send pauses old queue; idle queue:true bypasses paused backlog', async () => {
    const observed = async (phase, method, params) => {
      const nativeOffset = fileOffset(join(native, 'messages.jsonl')), journalOffset = fileOffset(join(home, 'events/journal.jsonl'))
      try { return await client.request(method, params) }
      catch (error) {
        try { await unknownDrainDiagnostic(nativeOffset, journalOffset, { phase, method, code: error.code }) } catch { console.error('[accepted-fixture] diagnostic-unavailable') }
        throw error
      }
    }
    await observed('check9_hold_interrupt', 'agent.prompt', { name: 'one', text: 'hold interrupt' })
    const old = await queue('old paused')
    await observed('check9_replacement_interrupt', 'agent.prompt', { name: 'one', text: 'replacement', interrupt: true })
    await done('one')
    assert.equal((await row('one')).queuePaused, true); assert.equal((await row('one')).queue[0].id, old.id)
    const fresh = await observed('check9_idle_bypass', 'agent.prompt', { name: 'one', text: 'idle bypass', queue: true })
    assert.equal(typeof fresh.turnId, 'string'); await done('one')
    assert.equal((await row('one')).queue[0].id, old.id)
    await observed('check9_send_paused', 'agent.queue.send', { name: 'one', id: old.id }); await done('one')
  })
  await check('edit holds survive resume until disconnect releases their owner', async () => {
    await client.request('agent.prompt', { name: 'one', text: 'hold before edit' })
    const pending = await queue('after disconnect')
    await client.request('agent.stop', { name: 'one' }); await done('one')
    const editor = await connectClient(paths, { timeoutMs: 3000 })
    await editor.request('agent.queue.move', { name: 'one', id: pending.id, hold: true })
    await client.request('agent.queue.resume', { name: 'one' })
    const behind = await queue('behind held head')
    assert.equal(behind.queued, true)
    editor.close()
    await until(async () => !(await row('one')).queue?.length && (await row('one')).status === 'idle', 'disconnect did not release/drain held queue')
    const texts = journal().filter(e => e.kind === 'message.user').map(e => e.data.text)
    assert.ok(texts.indexOf('after disconnect') < texts.indexOf('behind held head'))
  })
  await check('image-only queued input survives hold/edit and steers native image blocks', async () => {
    const turn = await client.request('agent.prompt', { name: 'one', text: 'hold image' })
    const directory = join(home, 'attachments', 'one', '2026-11-12')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const imagePath = join(directory, 'fixture.png')
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0f8AAAAASUVORK5CYII=', 'base64')
    writeFileSync(imagePath, bytes, { mode: 0o600 })
    const path = realpathSync(imagePath)
    const attachment = { path, name: 'fixture.png', bytes: bytes.length, mime: 'image/png', kind: 'file' }
    const queued = await client.request('agent.prompt', { name: 'one', text: '', attachments: [attachment], queue: true })
    const held = await client.request('agent.queue.move', { name: 'one', id: queued.id, hold: true })
    assert.equal(held.edit.text, ''); assert.deepEqual(held.edit.attachments, [attachment])
    await client.request('agent.queue.move', { name: 'one', id: queued.id, text: '' })
    const accepted = await client.request('agent.queue.send', { name: 'one', id: queued.id })
    assert.equal(accepted.turnId, turn.turnId)
    const wire = readCompleteJsonl(join(native, 'messages.jsonl')).findLast(e => e.method === 'turn/steer')
    assert.deepEqual(wire.params.input, [{ type: 'localImage', path }])
    const receipt = journal().find(e => e.kind === 'message.user' && e.data.queueItemId === queued.id)
    assert.equal(receipt.data.text, ''); assert.deepEqual(receipt.data.attachments, [attachment])
    await assert.rejects(client.request('agent.prompt', { name: 'one', text: '', attachments: [{ ...attachment, path: join(home, 'foreign.png') }], queue: true }), e => e.code === 'invalid_params')
    await client.request('agent.stop', { name: 'one' }); await done('one')
  })
  await check('queue capacity and Unicode byte budgets reject atomically', async () => {
    await client.request('agent.prompt', { name: 'one', text: 'hold limits' })
    await assert.rejects(queue('x'.repeat(50001)), e => e.code === 'invalid_params')
    const large = await queue('🦀'.repeat(50000))
    await assert.rejects(queue('🦀'.repeat(20000)), e => e.code === 'invalid_params')
    assert.equal((await row('one')).queue.length, 1)
    await client.request('agent.queue.send', { name: 'one', id: large.id })
    const delivered = journal().find(e => e.kind === 'message.user' && e.data.queueItemId === large.id)
    assert.equal([...delivered.data.text].length, 50000)
    for (let i = 0; i < 20; i++) assert.equal((await queue(`cap-${i}`)).queued, true)
    await assert.rejects(queue('overflow'), e => e.code === 'invalid_params')
    const queued = (await row('one')).queue
    assert.equal(queued.length, 20)
    for (const item of queued) await client.request('agent.queue.remove', { name: 'one', id: item.id })
    await client.request('agent.stop', { name: 'one' }); await done('one')
  })
  await check('real Rust CLI queue, steer and interrupt flags reach the daemon', async () => {
    const first = await nativeCli(['agent', 'prompt', 'one', 'hold cli', '--json'])
    assert.equal(first.code, 0, first.stderr); const active = JSON.parse(first.stdout); assert.equal(active.waiting, false)
    const waiting = await nativeCli(['agent', 'prompt', 'one', 'queued cli', '--queue', '--json'])
    assert.equal(waiting.code, 0, waiting.stderr); const queued = JSON.parse(waiting.stdout); assert.equal(queued.queued, true)
    const steered = await nativeCli(['agent', 'prompt', 'one', 'clarify cli', '--steer', '--json'])
    assert.equal(steered.code, 0, steered.stderr); assert.equal(JSON.parse(steered.stdout).turnId, active.turnId); assert.equal(JSON.parse(steered.stdout).waiting, false)
    const interrupted = await nativeCli(['agent', 'prompt', 'one', 'replace cli', '--interrupt', '--json'])
    assert.equal(interrupted.code, 0, interrupted.stderr); assert.notEqual(JSON.parse(interrupted.stdout).turnId, active.turnId); assert.equal(JSON.parse(interrupted.stdout).waiting, false)
    await done('one'); assert.equal((await row('one')).queuePaused, true)
    const invalid = await nativeCli(['agent', 'prompt', 'one', 'invalid mode', '--queue', '--steer'])
    assert.notEqual(invalid.code, 0)
    assert.ok(!journal().some(e => e.kind === 'message.user' && e.data.text === 'invalid mode'))
    await client.request('agent.queue.remove', { name: 'one', id: queued.id })
  })
  await check('an edit hold in one Codex session does not delay another session FIFO', async () => {
    await client.request('agent.prompt', { name: 'one', text: 'hold independent one' })
    await client.request('agent.prompt', { name: 'ask', text: 'hold independent ask' })
    const held = await queue('held independent')
    const other = await queue('independent FIFO', 'ask')
    await client.request('agent.queue.move', { name: 'one', id: held.id, hold: true })
    await client.request('agent.prompt', { name: 'ask', text: 'complete-steer', steer: true })
    await until(async () => !(await row('ask')).queue?.length && (await row('ask')).status === 'idle', 'sibling FIFO delayed by another hold')
    assert.equal((await row('one')).queue[0].id, held.id)
    assert.ok(journal().some(e => e.sessionId === 'ask' && e.kind === 'message.user' && e.data.queueItemId === other.id))
    await client.request('agent.stop', { name: 'one' }); await done('one')
    await client.request('agent.queue.remove', { name: 'one', id: held.id })
  })
  await check('interrupt timeout never dispatches replacement or kills an unrelated turn', async () => {
    await client.request('agent.prompt', { name: 'one', text: 'never-interrupt' })
    await client.request('agent.prompt', { name: 'ask', text: 'hold timeout sibling' })
    const waiting = await queue('after timed out interruption')
    const before = journal().filter(e => e.kind === 'message.user').length
    await assert.rejects(client.request('agent.prompt', { name: 'one', text: 'must never be sent after timeout', interrupt: true }, { timeoutMs: 15000 }), e => e.code === 'timeout')
    assert.equal(journal().filter(e => e.kind === 'message.user').length, before)
    assert.equal((await row('ask')).status, 'working')
    assert.equal((await row('one')).queuePaused, true)
    assert.equal((await row('one')).queue[0].id, waiting.id)
    await client.request('agent.stop', { name: 'ask' })
    await until(async () => (await client.request('daemon.status')).nativeRuntime.activeTurns === 1, 'sibling cleanup before retrying quarantined turn')
    await client.request('agent.stop', { name: 'one' })
    await done('one')
    await client.request('agent.queue.remove', { name: 'one', id: waiting.id })
  })
  await check('unknown native delivery remains actionable and cannot Resume automatically', async () => {
    await client.request('agent.prompt', { name: 'one', text: 'hold before lost ack' })
    const uncertain = await queue('lost-ack')
    await client.request('agent.stop', { name: 'one' }); await done('one')
    await assert.rejects(client.request('agent.queue.send', { name: 'one', id: uncertain.id }))
    await until(() => JSON.parse(readFileSync(join(home, 'sessions.json'))).sessions.find(r => r.name === 'one').queueDispatch?.id === uncertain.id, 'unknown marker not durable')
    assert.match((await row('one')).queue[0].text, /Delivery unknown/)
    await assert.rejects(client.request('agent.queue.resume', { name: 'one' }), e => e.code === 'send_unknown')
    await client.request('daemon.stop'); client.close(); client = null; assert.equal((await exited).code, 0)
    const { createRegistry } = await import('../../dist/sessions/registry.js')
    const rollback = createRegistry(paths)
    assert.equal(rollback.get('one').queueDispatch.id, uncertain.id, 'Node normalization lost rollback guard')
    const nativeOffset = fileOffset(join(native, 'messages.jsonl'))
    const journalOffset = fileOffset(join(home, 'events/journal.jsonl'))
    if (coldSiteBarrier) {
      const site = join(temp, 'cold-site'), shim = join(temp, 'cold-peer-shim')
      mkdirSync(site, { mode: 0o700 })
      writeFileSync(join(site, 'sitecustomize.py'), readFileSync(join(root, 'rust/tests/fixtures/claude_sitecustomize.py')), { mode: 0o600 })
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
      // Preserve the actual peer's shebang. Only this explicit private test mode
      // introduces ambient startup state; production environment policy is intact.
      writeFileSync(shim, '#!/bin/sh\nexec /bin/sh ' + quote(join(root, 'rust/tests/fixtures/claude_site_startup.sh')) + ' ' + quote(site) + ' ' + quote(join(root, 'rust/tests/fixtures/codex_daemon.py')) + ' "$@"\n', { mode: 0o700 })
      env.PULT_CODEX_BIN = shim
    }
    launch(); await until(() => existsSync(paths.sock) && existsSync(paths.token), 'restart after unknown')
    client = await connectClient(paths, { timeoutMs: 3000 })
    await assert.rejects(client.request('agent.queue.resume', { name: 'one' }), e => e.code === 'send_unknown')
    await client.request('agent.queue.move', { name: 'one', id: uncertain.id, text: 'explicitly changed after unknown' })
    await client.request('agent.queue.resume', { name: 'one' })
    try {
      await until(async () => !(await row('one')).queue?.length && (await row('one')).status === 'idle', 'edited unknown item did not drain')
    } catch (error) {
      try { await unknownDrainDiagnostic(nativeOffset, journalOffset) } catch { console.error('[unknown-drain-fixture] diagnostic-unavailable') }
      throw error
    }
    if (coldSiteBarrier) {
      assert.equal(existsSync(join(temp, 'cold-site', 'entered')), false, 'isolated peer executed ambient site hook')
      const dispatched = boundedRows(join(native, 'messages.jsonl'), nativeOffset)
      assert.ok(dispatched?.some(frame => frame?.method === 'turn/start'), 'controlled cold retry did not reach actual native dispatch')
    }
  })
  await check('scoped memory credentials cannot execute owner session commands', async () => {
    await client.request('memory.context.bind', { session: 'one', enabled: true })
    const issued = await client.request('memory.context.issue', { session: 'one' })
    const forbiddenCli = await nativeCli(['agent', 'prompt', 'one', 'forbidden cli', '--queue'], { PULT_MEMORY_KEY: issued.key })
    assert.notEqual(forbiddenCli.code, 0); assert.match(forbiddenCli.stderr, /forbidden/)
    assert.ok(!journal().some(e => e.kind === 'message.user' && e.data.text === 'forbidden cli'))
    const scoped = await rawClient(issued.key)
    try {
      assert.deepEqual(scoped.hello.capabilities.partialMethods, [])
      for (const [id, method, params] of [
        [2, 'agent.start', { kind: 'codex', name: 'forbidden', cwd: project }],
        [3, 'agent.prompt', { name: 'one', text: 'forbidden' }],
        [4, 'perm.resolve', { id: 'missing', decision: 'allow' }],
      ]) {
        scoped.send({ id, method, params })
        assert.equal((await scoped.next()).error.code, 'forbidden')
      }
    } finally { scoped.close() }
  })
  await check('same-socket stop cancels preparation before any user receipt or model', async () => {
    // A fresh owner has no cached network probe result.
    await client.request('daemon.stop'); client.close(); client = null
    assert.equal((await exited).code, 0)
    writeFileSync(join(native, 'block-probe'), '')
    launch()
    await until(() => existsSync(paths.sock) && existsSync(paths.token), 'daemon restart deadline')
    const raw = await rawClient()
    try {
      raw.send({ type: 'request', id: 2, method: 'agent.prompt', params: { name: 'race', text: 'hello race' } })
      await until(() => existsSync(join(native, 'probe-entered')), 'probe did not start')
      raw.send({ type: 'request', id: 3, method: 'agent.stop', params: { name: 'race' } })
      const frames = await Promise.race([Promise.all([raw.next(), raw.next()]), pause(3000).then(() => { throw Error('stop blocked behind prompt on the same socket') })])
      const stop = frames.find(frame => frame.id === 3), prompt = frames.find(frame => frame.id === 2)
      assert.equal(stop.result.stopped, true)
      assert.equal(prompt.error.code, 'cancelled')
      assert.equal(journal().filter(row => row.sessionId === 'race' && row.kind === 'message.user').length, 0)
    } finally { writeFileSync(join(native, 'release-probe'), ''); raw.close() }
    client = await connectClient(paths, { timeoutMs: 3000 })
    assert.equal((await client.request('daemon.status')).nativeRuntime.hosts, 0)
  })
} finally {
  if (client) { try { await client.request('daemon.stop', {}, { timeoutMs: 3000 }) } catch {} client.close() }
  if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([exited, pause(5000)]); if (child.exitCode === null) child.kill('SIGKILL') }
  if (!fixtureFailed && child.exitCode === 0 && child.signalCode === null) rmSync(temp, { recursive: true, force: true })
}
console.log(`session runtime interop passed ${checks}`)
