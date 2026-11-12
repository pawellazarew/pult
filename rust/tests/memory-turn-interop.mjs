import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { performance } from 'node:perf_hooks'

const { connectClient } = await import('../../dist/cli/client.js')
const { layout } = await import('../../dist/core/paths.js')
const root = fileURLToPath(new URL('../../', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync('/tmp/mturn-')
chmodSync(scratch, 0o700)
const home = join(scratch, 'home'), account = join(scratch, 'account'), native = join(account, 'native')
const projectA = join(scratch, 'a'), projectB = join(scratch, 'b')
for (const directory of [home, account, native, projectA, projectB]) { mkdirSync(directory); chmodSync(directory, 0o700) }
writeFileSync(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { codex: { mode: 'off' }, guard: { mode: 'allow', countries: ['FI'] } } }), { mode: 0o600 })
const env = { ...process.env, HOME: account, PULT_TEST: '1', PULT_CODEX_BIN: join(root, 'rust/tests/fixtures/codex_memory.py'), PULT_CURL_BIN: join(root, 'rust/tests/fixtures/curl_loc_fi.sh'), OPENAI_API_KEY: 'fixture-not-a-real-account' }
for (const key of ['PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_HOLDER_BIN']) delete env[key]
const paths = layout(home)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const jsonl = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const evidence = () => jsonl(join(native, 'memory-fixture.jsonl'))
const journal = () => jsonl(join(home, 'events/journal.jsonl'))
const records = () => JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const child = spawn(binary, ['--home', home, 'daemon', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = '', client, passed = 0
const timings = []
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8000) })
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
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
async function prompt(name, instruction) {
  const begin = performance.now()
  let accepted
  try { accepted = await client.request('agent.prompt', { name, text: JSON.stringify(instruction) }, { timeoutMs: 15000 }) } catch (error) { error.message = `prompt ${name}/${instruction.run}: ${error.message}`; throw error }
  timings.push({ run: instruction.run, acceptedMs: Math.round(performance.now() - begin) })
  assert.match(accepted.turnId, /^pult-/)
  return accepted
}
async function result(run, name) {
  await until(() => evidence().some(value => value.kind === 'result' && value.run === run), `missing result ${run}`)
  await until(async () => (await session(name)).status === 'done', `turn ${run} not done`)
  return evidence().find(value => value.kind === 'result' && value.run === run)
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
let note, foreignNote, globalNote, neighborPid
async function cleanup() {
  for (const socket of sockets) socket.destroy()
  if (client) { try { await client.request('daemon.stop', {}, { timeoutMs: 3000 }) } catch {} client.close() }
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited, pause(3000)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  await Promise.race([exited, pause(1000)])
  // Bounded cleanup also covers fixture regressions that orphan a child.
  for (const row of evidence()) for (const pid of [row.pid, row.mcpPid].filter(Boolean)) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} } }
  rmSync(scratch, { recursive: true, force: true })
}
const watchdog = setTimeout(async () => { console.error('memory turn interoperability watchdog'); await cleanup(); process.exit(1) }, 165000)
try {
  await until(() => existsSync(paths.sock) && existsSync(paths.token), 'startup')
  client = await connectClient(paths, { timeoutMs: 5000 })
  await check('explicit policy auto-registers memory and ordinary shared neighbor stays alive', async () => {
    await start('writer')
    await start('other-project', projectB)
    await start('general', projectA, { scope: 'general' })
    await start('readonly', projectA, { approval: 'read-only' })
    await start('neighbor', projectA, { memory: { read: false, write: 'off' } })
    const configured = await memory('configure', { session: 'writer' })
    assert.deepEqual(configured, { session: 'writer', memory: { read: true, write: 'ask' } })
    assert.deepEqual((await session('writer')).memory, configured.memory)
    note = await memory('add', { session: 'writer', commandId: 'owner-seed', name: 'Project decision', summary: 'seed version one', details: 'DETAILS_MUST_NOT_BE_IN_CATALOG', reason: 'Owner seed' })
    foreignNote = await memory('add', { session: 'other-project', commandId: 'foreign-seed', name: 'Foreign decision', summary: 'project B only', details: 'FOREIGN_PROJECT_DETAILS', reason: 'Owner seed' })
    globalNote = await memory('add', { scope: 'global', commandId: 'global-seed', name: 'Global decision', summary: 'all projects', details: 'global details', reason: 'Owner global seed' })
    assert.deepEqual((await memory('context.status', {})).contexts, [])
    await prompt('neighbor', { run: 'neighbor', mode: 'hold' })
    neighborPid = evidence().find(value => value.kind === 'dispatch' && value.run === 'neighbor').pid
    assert.ok(alive(neighborPid))
    await prompt('writer', { run: 'read-one', id: note.id, foreignId: foreignNote.id })
    const first = await result('read-one', 'writer')
    assert.equal(first.get.details, note.details)
    assert.equal(first.foreign.isError, true)
    assert.ok(!first.catalog.memories.some(value => value.id === foreignNote.id))
    assert.equal(first.get.version, 1)
    assert.ok((await memory('context.status', {})).contexts.some(value => value.session === 'writer'))
    assert.ok(first.catalog.memories.some(value => value.id === note.id && value.version === 1))
    const dispatch = evidence().find(value => value.kind === 'dispatch' && value.run === 'read-one')
    assert.equal(dispatch.texts.length, 3)
    assert.ok(dispatch.texts[2].startsWith('<pult_runtime_context>'))
    assert.ok(dispatch.texts[1].includes(note.id))
    assert.ok(!dispatch.texts[1].includes(note.details))
    await until(() => !alive(dispatch.pid), 'dedicated host was not reaped')
    assert.ok(alive(neighborPid))
  })
  await check('denied proposal leaves record unchanged; allow commits exact server provenance', async () => {
    await prompt('writer', { run: 'denied', id: note.id, proposal: proposal(note, 'denied-update', 'MUST_NOT_COMMIT') })
    const denied = await card('writer')
    assert.equal(denied.input.operation, 'memory.update')
    assert.equal(denied.input.proposal.expectedVersion, 1)
    assert.equal((await memory('get', { session: 'writer', id: note.id })).version, 1)
    await client.request('perm.resolve', { id: denied.id, decision: 'deny' })
    assert.equal((await result('denied', 'writer')).proposal.isError, true)
    assert.deepEqual(await memory('get', { session: 'writer', id: note.id }), note)
    const accepted = await prompt('writer', { run: 'allowed', id: note.id, proposal: proposal(note, 'allowed-update', 'approved version two') })
    const allowed = await card('writer')
    assert.equal(allowed.input.sourceTurnId, accepted.turnId)
    await assert.rejects(client.request('perm.resolve', { id: allowed.id, decision: 'allow', scope: 'session' }), error => ['invalid_params', 'forbidden'].includes(error.code))
    assert.equal((await client.request('perm.list', { name: 'writer' })).pending.length, 1)
    assert.equal((await client.request('perm.resolve', { id: allowed.id, decision: 'allow', scope: 'once' })).resolved, true)
    const outcome = await result('allowed', 'writer')
    assert.equal(outcome.proposal.version, 2)
    note = await memory('get', { session: 'writer', id: note.id })
    assert.equal(note.version, 2); assert.equal(note.author, 'codex')
    assert.equal(note.sourceTurnId, accepted.turnId)
    const userEvent = journal().find(value => value.sessionId === 'writer' && value.kind === 'message.user' && JSON.stringify(value.data).includes('allowed-update'))
    assert.ok(userEvent)
    assert.equal(note.sourceEventId, userEvent.id)
    const metadata = records().find(value => value.name === 'writer')
    assert.equal(note.sourceCreatedAt, metadata.createdAt)
    assert.equal(note.sourceSession, 'writer')
  })
  await check('fresh dedicated resume sees committed version and preserves ordinary shared host', async () => {
    const previous = evidence().filter(value => value.kind === 'thread' && value.memory)
    const nativeId = records().find(value => value.name === 'writer').providerSessionId
    await prompt('writer', { run: 'read-two', id: note.id })
    const outcome = await result('read-two', 'writer')
    assert.equal(outcome.get.version, 2)
    assert.ok(outcome.catalog.memories.some(value => value.id === note.id && value.version === 2))
    const thread = evidence().find(value => value.kind === 'thread' && value.pid === outcome.pid)
    assert.equal(thread.method, 'thread/resume'); assert.equal(thread.thread, nativeId)
    assert.ok(previous.every(value => value.pid !== outcome.pid))
    await until(() => !alive(outcome.pid), 'resumed dedicated host was not reaped')
    assert.ok(alive(neighborPid))
  })
  await check('project and general contexts isolate details while global notes remain visible', async () => {
    for (const name of ['other-project', 'general']) {
      await prompt(name, { run: name, id: globalNote.id, foreignId: note.id })
      const outcome = await result(name, name)
      assert.equal(outcome.get.details, globalNote.details)
      assert.equal(outcome.foreign.isError, true)
      assert.ok(!outcome.catalog.memories.some(value => value.id === note.id))
      assert.ok(outcome.catalog.memories.some(value => value.id === globalNote.id))
    }
  })
  await check('read-only turn hides propose and rejects direct tool calls even with ask policy', async () => {
    await prompt('readonly', { run: 'readonly', id: note.id, proposal: proposal(note, 'readonly-update', 'MUST_NOT_COMMIT') })
    const outcome = await result('readonly', 'readonly')
    assert.equal(outcome.get.version, 2); assert.equal(outcome.proposal.isError, true)
    const mcp = evidence().find(value => value.kind === 'mcp-started' && value.pid === outcome.pid)
    assert.equal(mcp.tools.length, 4); assert.ok(!mcp.tools.includes('memory_propose'))
    assert.equal((await client.request('perm.list', { name: 'readonly' })).pending.length, 0)
    assert.equal((await memory('get', { session: 'writer', id: note.id })).version, 2)
  })
  await check('filesystem Full still requires human approval for explicit global memory writes', async () => {
    await start('full-memory', projectA, { approval: 'full', confirm: true, grant: 'cli-once' })
    const before = await memory('get', { scope: 'global', id: globalNote.id })
    const globalProposal = (commandId, summary) => ({ ...proposal(before, commandId, summary), scope: 'global' })
    await prompt('full-memory', { run: 'full-global-deny', id: globalNote.id, proposal: globalProposal('full-global-deny', 'MUST_NOT_COMMIT') })
    const denied = await card('full-memory')
    assert.equal(denied.input.scope, 'global')
    assert.equal(denied.input.proposal.scope, 'global')
    assert.equal((await session('full-memory')).liveApproval, 'full')
    assert.equal((await session('full-memory')).status, 'blocked_permission')
    const dispatch = evidence().find(value => value.kind === 'dispatch' && value.run === 'full-global-deny')
    assert.ok(dispatch.texts.at(-1).includes('sandbox=danger-full-access'))
    assert.deepEqual(await memory('get', { scope: 'global', id: globalNote.id }), before)
    await client.request('perm.resolve', { id: denied.id, decision: 'deny' })
    assert.equal((await result('full-global-deny', 'full-memory')).proposal.isError, true)
    assert.deepEqual(await memory('get', { scope: 'global', id: globalNote.id }), before)
    const accepted = await prompt('full-memory', { run: 'full-global-allow', proposal: globalProposal('full-global-allow', 'approved global version two') })
    const allowed = await card('full-memory')
    assert.equal(allowed.input.scope, 'global')
    assert.equal(allowed.input.proposal.scope, 'global')
    assert.equal(allowed.input.sourceTurnId, accepted.turnId)
    assert.equal((await session('full-memory')).liveApproval, 'full')
    assert.deepEqual(await memory('get', { scope: 'global', id: globalNote.id }), before)
    await client.request('perm.resolve', { id: allowed.id, decision: 'allow', scope: 'once' })
    const outcome = await result('full-global-allow', 'full-memory')
    assert.equal(outcome.proposal.scope, 'global')
    assert.equal(outcome.proposal.version, 2)
    globalNote = await memory('get', { scope: 'global', id: globalNote.id })
    assert.equal(globalNote.scope, 'global'); assert.equal(globalNote.author, 'codex')
    assert.equal(globalNote.sourceSession, 'full-memory')
    assert.equal(globalNote.sourceTurnId, accepted.turnId)
    assert.equal((await memory('get', { session: 'writer', id: note.id })).version, 2)
  })
  await check('owner update during pending human approval defeats the stale expectedVersion', async () => {
    const original = await memory('add', { session: 'writer', commandId: 'owner-race-seed', name: 'Race decision', summary: 'race version one', details: 'owner original', reason: 'Owner seed' })
    await prompt('writer', { run: 'stale-expected-version', id: original.id, proposal: proposal(original, 'stale-agent-update', 'MUST_NOT_COMMIT') })
    const pending = await card('writer')
    assert.equal(pending.input.proposal.expectedVersion, 1)
    const winner = await memory('update', { session: 'writer', id: original.id, expectedVersion: 1, commandId: 'owner-race-winner', summary: 'owner version two', reason: 'Owner changed while approval pending' })
    assert.equal(winner.version, 2); assert.equal(winner.author, 'owner')
    await client.request('perm.resolve', { id: pending.id, decision: 'allow', scope: 'once' })
    const outcome = await result('stale-expected-version', 'writer')
    assert.equal(outcome.proposal.isError, true)
    assert.deepEqual(await memory('get', { session: 'writer', id: original.id }), winner)
    const history = await memory('history', { session: 'writer', id: original.id })
    assert.deepEqual(history.versions.map(value => value.version).sort(), [1, 2])
    assert.ok(history.versions.every(value => value.author === 'owner' && value.sourceTurnId === undefined && value.sourceEventId === undefined))
    // Trusted test harness inspects only the receipt table through a read-only
    // connection. The fake provider itself never opens the memory database.
    const receipts = execFileSync('/usr/bin/python3', ['-c',
      'import pathlib,sqlite3,sys; db=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); print(db.execute("SELECT count(*) FROM memory_receipts WHERE command_id=?",(sys.argv[2],)).fetchone()[0])',
      join(home, 'memory', 'memory.sqlite3'), 'stale-agent-update'], { encoding: 'utf8', timeout: 3000 })
    assert.equal(Number(receipts.trim()), 0)

  })
  await check('turn keys are masked in assistant text, tool values, property names and structural IDs', async () => {
    const before = await memory('get', { session: 'writer', id: note.id })
    await prompt('writer', { run: 'echo-key', id: note.id, expectedVersion: before.version, echoKey: true })
    const outcome = await result('echo-key', 'writer')
    assert.equal(outcome.echoedKey, true)
    assert.equal(outcome.proposal.isError, true)
    assert.equal((await client.request('perm.list', { name: 'writer' })).pending.length, 0)
    assert.deepEqual(await memory('get', { session: 'writer', id: note.id }), before)
    const key = jsonl(join(native, 'private-keys.jsonl')).find(value => value.pid === outcome.pid).key
    assert.notEqual(key, outcome.unknownStructuralId)
    const events = journal().filter(value => value.sessionId === 'writer')
    const text = JSON.stringify(events)
    const transcript = await client.request('agent.read', { name: 'writer' })
    assert.ok(text.includes('fixture key echo'), 'assistant echo must reach the journal after filtering')
    assert.ok(text.includes(outcome.ordinaryStructuralId), 'ordinary 32-hex tool identity must survive filtering')
    for (const secret of [key, outcome.unknownStructuralId]) {
      assert.ok(!text.includes(secret), 'turn credential escaped into journal')
      assert.ok(!JSON.stringify(transcript).includes(secret), 'turn credential escaped into agent.read')
    }
    const tools = events.filter(value => JSON.stringify(value.data).includes('mcp__pult_memory__memory_get'))
    assert.ok(tools.some(value => value.data.toolUseId === outcome.ordinaryStructuralId))
    assert.ok(!tools.some(value => value.data.input && Object.hasOwn(value.data.input, key)))
  })
  await check('legacy read credential cannot mutate and mixed credential hellos fail closed', async () => {
    // Registration was automatic; issue is only used to check backwards compatibility.
    const issued = await memory('context.issue', { session: 'writer' })
    const legacy = await raw({ memory: issued.key })
    try {
      assert.equal(legacy.hello.type, 'hello_ok')
      assert.equal(legacy.hello.capabilities.supportedMethods.length, 4)
      assert.equal((await legacy.request('memory.update', { id: note.id, expectedVersion: 2, commandId: 'legacy-denied', summary: 'MUST_NOT_COMMIT', reason: 'fixture' })).error.code, 'forbidden')
    } finally { legacy.close() }
    await prompt('writer', { run: 'credential-hold', mode: 'hold' })
    const dispatch = evidence().find(value => value.kind === 'dispatch' && value.run === 'credential-hold')
    const key = jsonl(join(native, 'private-keys.jsonl')).find(value => value.pid === dispatch.pid).key
    const turn = await raw({ memoryTurn: key })
    try {
      assert.equal(turn.hello.type, 'hello_ok')
      assert.equal(turn.hello.capabilities.supportedMethods.length, 7)
      assert.equal((await turn.request('agent.list')).error.code, 'forbidden')
    } finally { turn.close() }
    for (const credentials of [{ token: readFileSync(paths.token, 'utf8'), memoryTurn: key }, { memory: issued.key, memoryTurn: key }, { token: readFileSync(paths.token, 'utf8'), memory: issued.key }]) {
      const mixed = await raw(credentials)
      try { assert.equal(mixed.hello.code, 'bad_token'); assert.ok(!JSON.stringify(mixed.hello).includes(key)) } finally { mixed.close() }
    }
    for (const pid of [dispatch.pid, evidence().find(value => value.kind === 'mcp-started' && value.pid === dispatch.pid).mcpPid]) {
      assert.ok(!execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).includes(key))
    }
    await client.request('agent.stop', { name: 'writer' })
    await until(async () => (await session('writer')).status === 'interrupted', 'credential hold not stopped')
  })
  await check('disabling or revoking while human approval is pending cannot commit', async () => {
    for (const action of ['disable', 'revoke']) {
      await memory('configure', { session: 'writer', memory: { read: true, write: 'ask' } })
      const before = records().find(value => value.name === 'writer')
      await prompt('writer', { run: action, proposal: proposal(note, `${action}-pending`, 'MUST_NOT_COMMIT') })
      const pending = await card('writer')
      if (action === 'disable') {
        assert.deepEqual(await memory('configure', { session: 'writer', memory: { read: false, write: 'off' } }), { session: 'writer', memory: { read: false, write: 'off' } })
      } else await memory('context.revoke', { session: 'writer' })
      // Resolution may already be cancelled; either outcome must leave storage intact.
      try { await client.request('perm.resolve', { id: pending.id, decision: 'allow', scope: 'once' }) } catch (error) { assert.ok(['not_found', 'forbidden'].includes(error.code)) }
      const outcome = await result(action, 'writer')
      assert.equal(outcome.proposal.isError, true)
      assert.equal((await memory('get', { session: 'writer', id: note.id })).version, 2)
      const after = records().find(value => value.name === 'writer')
      for (const field of ['name', 'provider', 'createdAt', 'cwd']) assert.equal(after[field], before[field])
    }
  })
  await check('two dedicated memory slots stay bounded and ordered stop cancels a third preparation', async () => {
    for (const name of ['slot-one', 'slot-two', 'slot-queued']) await start(name)
    for (const [name, run] of [['slot-one', 'slot-one-hold'], ['slot-two', 'slot-two-hold']]) {
      await prompt(name, { run, mode: 'hold' })
    }
    const holds = ['slot-one-hold', 'slot-two-hold'].map(run => evidence().find(value => value.kind === 'dispatch' && value.run === run))
    assert.ok(holds.every(Boolean))
    assert.notEqual(holds[0].pid, holds[1].pid)
    const children = holds.map(hold => evidence().find(value => value.kind === 'mcp-started' && value.pid === hold.pid))
    assert.ok(children.every(Boolean))
    assert.ok(holds.every(value => alive(value.pid)))
    assert.ok(children.every(value => alive(value.mcpPid)))
    const occupied = await client.request('daemon.status')
    assert.equal(occupied.nativeRuntime.hosts, 3) // Existing shared neighbor plus two dedicated hosts.
    assert.equal(occupied.nativeRuntime.activeTurns, 3)
    const ordered = await raw({ token: readFileSync(paths.token, 'utf8') })
    try {
      assert.equal(ordered.hello.type, 'hello_ok')
      // The server admits session commands synchronously in wire order before
      // spawning their async bodies. Both slots are held, so no third dispatch
      // can race this cancellation; the test does not infer admission from time.
      const pending = ordered.request('agent.prompt', { name: 'slot-queued', text: JSON.stringify({ run: 'slot-must-not-dispatch', mode: 'hold' }) })
        .then(frame => frame.error ? { ok: false, error: frame.error } : { ok: true, frame }, error => ({ ok: false, error }))
      const beginStop = performance.now()
      const stopped = await ordered.request('agent.stop', { name: 'slot-queued' })
      assert.ok(performance.now() - beginStop < 3000, 'stop blocked behind exhausted dedicated slots')
      assert.equal(stopped.result.stopped, true)
      const cancelled = await pending
      assert.equal(cancelled.ok, false, 'queued prompt must be rejected')
      assert.equal(cancelled.error.code, 'cancelled')
      assert.ok(!evidence().some(value => value.kind === 'dispatch' && value.run === 'slot-must-not-dispatch'))
      assert.equal(journal().filter(value => value.sessionId === 'slot-queued' && value.kind === 'message.user').length, 0)
      assert.equal((await client.request('daemon.status')).nativeRuntime.hosts, 3)
    } finally { ordered.close() }
    for (const name of ['slot-one', 'slot-two']) await client.request('agent.stop', { name })
    await until(() => holds.every(value => !alive(value.pid)) && children.every(value => !alive(value.mcpPid)), 'held dedicated children were not reaped')
    for (const name of ['slot-one', 'slot-two']) assert.equal((await session(name)).status, 'interrupted')
    assert.ok(alive(neighborPid))
    assert.equal((await session('neighbor')).status, 'working')
    assert.equal((await client.request('daemon.status')).nativeRuntime.hosts, 1)
  })
  await check('failed MCP bootstrap rejects without dispatch or automatic resend and reaps its real child', async () => {
    await start('bad-mcp', projectA, { model: 'bad-mcp-fixture' })
    assert.equal(journal().filter(value => value.sessionId === 'bad-mcp' && value.kind === 'message.user').length, 0)
    const attempted = await client.request('agent.prompt', { name: 'bad-mcp', text: JSON.stringify({ run: 'bad-mcp-must-not-dispatch' }) }, { timeoutMs: 15000 })
      .then(value => ({ ok: true, value }), error => ({ ok: false, error }))
    assert.equal(attempted.ok, false)
    assert.equal(attempted.error.message, 'turn was not accepted')
    await until(async () => (await session('bad-mcp')).status === 'failed', 'bad MCP bootstrap did not publish failed status')
    const nativeId = records().find(value => value.name === 'bad-mcp').providerSessionId
    assert.ok(nativeId)
    const threads = evidence().filter(value => value.kind === 'thread' && value.thread === nativeId)
    assert.equal(threads.length, 1, 'bootstrap failure must not create a replacement native thread')
    const host = threads[0]
    const mcp = evidence().find(value => value.kind === 'mcp-started' && value.pid === host.pid)
    assert.ok(mcp, 'negative status must follow actual Rust MCP initialization')
    assert.ok(mcp.tools.includes('memory_get'))
    assert.ok(evidence().some(value => value.kind === 'mcp-status' && value.pid === host.pid && value.rejected))
    assert.equal(evidence().filter(value => value.kind === 'dispatch' && value.pid === host.pid).length, 0)
    assert.equal(journal().filter(value => value.sessionId === 'bad-mcp' && value.kind === 'message.user').length, 1)
    const statuses = journal().filter(value => value.sessionId === 'bad-mcp' && value.kind === 'status.changed')
    assert.equal(statuses.at(-1).data.status, 'failed')
    await until(() => !alive(host.pid) && !alive(mcp.mcpPid), 'failed MCP bootstrap children were not reaped')
    assert.ok(alive(neighborPid))
    assert.equal((await session('neighbor')).status, 'working')
    assert.equal((await client.request('daemon.status')).nativeRuntime.hosts, 1)
  })
  await check('credentials and injected catalogs stay out of public journal and all dedicated children exit', async () => {
    const keys = jsonl(join(native, 'private-keys.jsonl')).map(value => value.key)
    const publicText = JSON.stringify(journal()) + JSON.stringify(await client.request('agent.list')) + stderr
    for (const key of keys) assert.ok(!publicText.includes(key))
    for (const event of journal().filter(value => value.kind === 'message.user')) assert.ok(!JSON.stringify(event.data).includes('Project memory:'))
    const mcpProcesses = evidence().filter(value => value.kind === 'mcp-started')
    assert.ok(mcpProcesses.length >= 8)
    await until(() => mcpProcesses.every(value => !alive(value.pid) && !alive(value.mcpPid)), 'dedicated host or MCP child leaked')
    assert.ok(alive(neighborPid))
    await client.request('agent.stop', { name: 'neighbor' })
    await until(async () => (await session('neighbor')).status === 'interrupted', 'neighbor failed after dedicated hosts')
    assert.equal((await client.request('daemon.status')).nativeRuntime.hosts, 1)
    assert.equal(evidence().filter(value => value.kind === 'fixture-error').length, 0)
  })
  console.log(`local fake overhead ${JSON.stringify(timings)}; fixture-only, no production latency claim`)
  console.log(`memory turn interop passed ${passed}`)
} catch (error) {
  const compact = evidence().slice(-12).map(value => ({ ...value, texts: value.texts?.map(text => text.slice(0, 180)), list: undefined }))
  console.error(`local fixture evidence ${JSON.stringify(compact)}; daemon stderr=${stderr}`)
  throw error
} finally {
  clearTimeout(watchdog)
  await cleanup()
}
