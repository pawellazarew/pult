import { readCompleteJsonl } from './support/complete-jsonl.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const { connectClient } = await import('../../dist/cli/client.js')
const { layout } = await import('../../dist/core/paths.js')
const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = mkdtempSync('/tmp/zcode-memory-')
chmodSync(temp, 0o700)
const home = join(temp, 'home'), account = join(temp, 'account'), native = join(account, 'native')
const project = join(temp, 'project'), foreign = join(temp, 'foreign')
for (const path of [home, account, native, project, foreign]) { mkdirSync(path); chmodSync(path, 0o700) }
writeFileSync(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { zcode: { mode: 'off' }, claude: { mode: 'off' }, codex: { mode: 'off' }, guard: { mode: 'allow', countries: ['FI'] } } }), { mode: 0o600 })
const codex = join(temp, 'codex-fixture'), claude = join(temp, 'claude-fixture')
const env = { ...process.env, HOME: account, PULT_TEST: '1', PULT_ZCODE_BIN: join(root, 'rust/tests/fixtures/zcode_memory.py'), PULT_CODEX_BIN: codex, PULT_CLAUDE_BIN: claude, PULT_CURL_BIN: join(root, 'rust/tests/fixtures/curl_loc_fi.sh'), OPENAI_API_KEY: 'synthetic-not-an-account' }
for (const key of ['PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_ASK_KEY', 'PULT_ASK_SESSION', 'PULT_WORKER_HOLDER_BIN', 'PULT_HOLDER_BIN']) delete env[key]
const child = spawn(resolve(process.argv[2]), ['--home', home, 'daemon', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = '', client, checks = 0, seed, saved, foreignSeed
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-5000) })
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
const paths = layout(home), pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const evidence = () => readCompleteJsonl(join(native, 'zcode-memory.jsonl'))
const privateKeys = () => readCompleteJsonl(join(native, 'zcode-private-keys.jsonl'))
const journal = () => readCompleteJsonl(join(home, 'events/journal.jsonl'))
const sessions = () => JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions
const request = (method, params = {}, options = {}) => client.request(method, params, { timeoutMs: 10000, ...options })
const row = async name => (await request('agent.list')).sessions.find(value => value.name === name)
const memory = (method, params = {}) => request(`memory.${method}`, params)
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function until(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    assert.equal(child.exitCode, null, `scratch daemon exited: ${stderr}`)
    assert.ok(Date.now() < deadline, label)
    await pause(10)
  }
}
async function prompt(name, instruction) { return request('agent.prompt', { name, text: JSON.stringify(instruction) }, { timeoutMs: 35000 }) }
async function result(name, run) {
  await until(() => evidence().some(value => value.kind === 'result' && value.run === run), `${run} missing native result`)
  await until(async () => (await row(name)).status === 'done', `${run} not done`)
  const outcome = evidence().find(value => value.kind === 'result' && value.run === run)
  const helper = evidence().find(value => value.kind === 'mcp' && value.pid === outcome.pid)
  await until(() => !alive(outcome.pid) && !alive(helper.mcpPid), `${run} process/helper cleanup pending`)
  return outcome
}
async function card(name, timeoutMs = 10000) {
  let value
  await until(async () => { value = (await request('perm.list', { name })).pending[0]; return !!value }, `${name} missing memory approval`, timeoutMs)
  assert.equal(value.toolName, 'pult_memory.propose')
  return value
}
async function check(label, run) { await run(); checks++; console.log(`pass ${label}`) }
const proposal = commandId => ({ operation: 'add', commandId, name: 'Shared ZCode decision', summary: 'A shared decision', details: 'ZCODE_SHARED_DETAILS', reason: 'Offline owner approval fixture' })
async function crossRead(name, provider, run, value) {
  await prompt(name, { run, id: value.id })
  const file = provider === 'claude' ? 'claude-memory.jsonl' : 'memory-fixture.jsonl'
  let outcome
  await until(() => { outcome = readCompleteJsonl(join(native, file)).find(item => item.kind === 'result' && item.run === run); return !!outcome }, `${run} no cross-provider result`)
  await until(async () => (await row(name)).status === 'done', `${run} cross-provider cleanup`)
  const records = readCompleteJsonl(join(native, file))
  const helpers = records.filter(item => item.pid === outcome.pid && item.mcpPid)
  assert.ok(helpers.length, `${run} missing actual helper PID evidence`)
  await until(() => !alive(outcome.pid) && helpers.every(item => !alive(item.mcpPid)), `${run} retained native/helper process`)
  assert.equal(outcome.get.id, value.id)
  assert.equal(outcome.get.details, value.details)
  assert.equal(outcome.get.version, value.version)
}
try {
  await until(() => existsSync(paths.sock) && existsSync(paths.token), 'startup')
  client = await connectClient(paths, { timeoutMs: 10000 })
  await check('cold metadata and ZCode memory need neither Claude nor Codex executable', async () => {
    for (const [name, more] of [
      ['writer', {}], ['readonly', { approval: 'read-only' }],
      ['full', { approval: 'full', confirm: true, grant: 'cli-once' }],
      ['foreign', { cwd: foreign }],
    ]) await request('agent.start', { kind: 'zcode', name, cwd: project, approval: 'ask', memory: { read: true, write: 'ask' }, ...more })
    assert.equal(existsSync(codex), false); assert.equal(existsSync(claude), false)
    assert.equal((await request('daemon.status')).nativeRuntime.initialized, false)
    seed = await memory('add', { session: 'writer', commandId: 'owner-seed', name: 'Seed', summary: 'Seed summary', details: 'DETAILS_NOT_IN_CATALOG', reason: 'Owner seed' })
    foreignSeed = await memory('add', { session: 'foreign', commandId: 'foreign-seed', name: 'Other project', summary: 'Foreign summary', details: 'FOREIGN_DETAILS', reason: 'Owner seed' })
    assert.equal(evidence().length, 0)
  })
  await check('actual MCP reads bounded catalog and denies another project', async () => {
    const instruction = { run: 'read-seed', id: seed.id, foreignId: foreignSeed.id, eventFirst: true }
    const accepted = await prompt('writer', instruction)
    const outcome = await result('writer', instruction.run)
    assert.equal(outcome.get.details, seed.details)
    assert.equal(outcome.foreign.isError, true)
    assert.ok(outcome.catalog.memories.some(value => value.id === seed.id))
    assert.ok(!outcome.catalog.memories.some(value => value.id === foreignSeed.id))
    const sent = evidence().find(value => value.kind === 'dispatch' && value.run === instruction.run)
    assert.equal(sent.text, JSON.stringify(instruction))
    assert.ok(sent.catalog.includes(seed.id) && !sent.catalog.includes(seed.details))
    const user = journal().find(value => value.sessionId === 'writer' && value.kind === 'message.user')
    assert.ok(user.id > 0 && accepted.turnId)
    assert.ok(!user.data.text.includes('Shared memory data'))
    const status = await request('daemon.status')
    assert.equal(status.nativeRuntime.providers.codex.initialized, false)
    assert.equal(status.nativeRuntime.providers.claude.initialized, false)
    assert.equal(status.nativeRuntime.providers.zcode.initialized, true)
  })
  await check('denied proposal stays absent; approved proposal has actual ZCode receipt', async () => {
    await prompt('writer', { run: 'denied-add', proposal: proposal('denied-add') })
    const denied = await card('writer')
    await request('perm.resolve', { id: denied.id, decision: 'deny' })
    assert.equal((await result('writer', 'denied-add')).proposal.isError, true)
    const accepted = await prompt('writer', { run: 'approved-add', proposal: proposal('approved-add') })
    const allowed = await card('writer')
    assert.equal(allowed.input.sourceTurnId, accepted.turnId)
    await request('perm.resolve', { id: allowed.id, decision: 'allow', scope: 'once' })
    const outcome = await result('writer', 'approved-add')
    saved = await memory('get', { session: 'writer', id: outcome.proposal.id })
    assert.equal(saved.author, 'zcode')
    assert.equal(saved.sourceSession, 'writer')
    assert.equal(saved.sourceTurnId, accepted.turnId)
    assert.equal(saved.version, 1)
    const user = journal().find(value => value.id === saved.sourceEventId)
    assert.equal(user.kind, 'message.user')
    assert.equal(JSON.parse(user.data.text).run, 'approved-add')
    assert.equal((await memory('list', { session: 'writer' })).memories.filter(value => value.name === 'Shared ZCode decision').length, 1)
  })
  await check('readonly has no write tool and Full still requires memory approval', async () => {
    await prompt('readonly', { run: 'readonly', id: saved.id })
    const read = await result('readonly', 'readonly')
    assert.equal(read.get.details, saved.details)
    assert.ok(!read.tools.includes('memory_propose'))
    await prompt('full', { run: 'full-denied', proposal: proposal('full-denied') })
    const pending = await card('full')
    await request('perm.resolve', { id: pending.id, decision: 'deny' })
    assert.equal((await result('full', 'full-denied')).proposal.isError, true)
    assert.equal((await memory('list', { session: 'writer' })).memories.filter(value => value.name === 'Shared ZCode decision').length, 1)
  })
  await check('later Claude and Codex read the same ZCode-authored record', async () => {
    for (const [kind, path] of [['codex', codex], ['claude', claude]]) {
      copyFileSync(join(root, `rust/tests/fixtures/${kind}_memory.py`), path); chmodSync(path, 0o700)
      await request('agent.start', { kind, name: `${kind}-reader`, cwd: project, approval: 'ask', memory: { read: true, write: 'ask' } })
      await crossRead(`${kind}-reader`, kind, `${kind}-read-zcode`, saved)
    }
  })
  await check('queued ZCode update uses deferred receipt and both providers see version 2', async () => {
    const blocker = await prompt('writer', { run: 'queue-blocker', hold: true })
    await until(() => evidence().some(value => value.kind === 'holding' && value.run === 'queue-blocker'), 'blocker not running')
    const holding = evidence().find(value => value.kind === 'holding' && value.run === 'queue-blocker')
    const blockerHelper = evidence().find(value => value.kind === 'mcp' && value.pid === holding.pid)
    const instruction = { run: 'queued-update', proposal: { operation: 'update', id: saved.id, expectedVersion: saved.version, commandId: 'queued-update', summary: 'Queued ZCode update', reason: 'Deferred receipt fixture' } }
    const queued = await request('agent.prompt', { name: 'writer', text: JSON.stringify(instruction), queue: true })
    assert.equal(queued.queued, true)
    assert.equal(journal().filter(value => value.kind === 'message.user' && value.data.queueItemId === queued.id).length, 0)
    assert.equal(evidence().some(value => value.kind === 'dispatch' && value.run === instruction.run), false)
    writeFileSync(join(native, 'release-queue-blocker'), '')
    const pending = await card('writer', 35000)
    assert.equal(alive(holding.pid), false, 'queue advanced before blocker process cleanup')
    assert.equal(alive(blockerHelper.mcpPid), false, 'queue advanced before blocker helper cleanup')
    const users = journal().filter(value => value.kind === 'message.user' && value.data.queueItemId === queued.id)
    assert.equal(users.length, 1)
    assert.equal(pending.input.sourceEventId, users[0].id)
    assert.notEqual(pending.input.sourceTurnId, blocker.turnId)
    await request('perm.resolve', { id: pending.id, decision: 'allow', scope: 'once' })
    await result('writer', instruction.run)
    saved = await memory('get', { session: 'writer', id: saved.id })
    assert.equal(saved.version, 2)
    assert.equal(saved.sourceEventId, users[0].id)
    assert.equal(saved.sourceTurnId, pending.input.sourceTurnId)
    for (const kind of ['claude', 'codex']) await crossRead(`${kind}-reader`, kind, `${kind}-read-v2`, saved)
  })
  await check('cancelled memory proposal cannot commit or retain provider/helper processes', async () => {
    await prompt('writer', { run: 'cancel-proposal', proposal: { operation: 'update', id: saved.id, expectedVersion: 2, commandId: 'cancelled-update', summary: 'MUST_NOT_SAVE', reason: 'Cancellation fixture' } })
    const pending = await card('writer')
    const running = evidence().filter(value => value.kind === 'dispatch' && value.run === 'cancel-proposal').at(-1)
    const helper = evidence().find(value => value.kind === 'mcp' && value.pid === running.pid)
    await request('agent.stop', { name: 'writer' })
    await until(() => !alive(running.pid) && !alive(helper.mcpPid), 'cancel left native/helper process')
    await until(async () => !(await request('perm.list', { name: 'writer' })).pending.length, 'cancel left approval')
    await assert.rejects(request('perm.resolve', { id: pending.id, decision: 'allow', scope: 'once' }))
    assert.equal((await memory('get', { session: 'writer', id: saved.id })).version, 2)
    await until(async () => !(await row('writer')).queue?.length && (await request('daemon.status')).nativeRuntime.activeTurns === 0, 'cancel cleanup not complete')
  })
  await check('policy revocation denies an already running helper without another write approval', async () => {
    await prompt('writer', { run: 'policy-revoke', id: saved.id, hold: true, proposal: proposal('revoked-add') })
    await until(() => evidence().some(value => value.kind === 'holding' && value.run === 'policy-revoke'), 'revocation barrier missing')
    const approvals = journal().filter(value => value.kind === 'permission.requested').length
    await memory('configure', { session: 'writer', memory: { read: false, write: 'off' } })
    writeFileSync(join(native, 'release-policy-revoke'), '')
    const outcome = await result('writer', 'policy-revoke')
    assert.equal(outcome.get.isError, true)
    assert.equal(outcome.proposal.isError, true)
    assert.equal(journal().filter(value => value.kind === 'permission.requested').length, approvals)
    assert.equal((await memory('get', { session: 'codex-reader', id: saved.id })).version, 2)
    await memory('configure', { session: 'writer', memory: { read: true, write: 'ask' } })
  })
  await check('explicit resume uses same native session with fresh private keys and redacted echo', async () => {
    const previous = sessions().find(value => value.name === 'writer').providerSessionId
    await prompt('writer', { run: 'after-cancel', id: saved.id, echoKey: true })
    const outcome = await result('writer', 'after-cancel')
    assert.equal(outcome.sid, previous)
    assert.equal(outcome.get.version, 2)
    const launches = evidence().filter(value => value.kind === 'bootstrap' && value.sid === previous)
    assert.equal(launches.at(-1).method, 'session/resume')
    const keys = privateKeys().map(value => value.key)
    assert.equal(new Set(keys).size, keys.length)
    const text = readFileSync(join(home, 'events/journal.jsonl'), 'utf8')
    assert.ok(keys.length >= 8)
    for (const key of keys) assert.ok(!text.includes(key), 'private helper capability reached journal')
    assert.ok(journal().some(value => value.sessionId === 'writer' && value.kind === 'message.done' && JSON.stringify(value.data).includes('<token>')))
    assert.equal(evidence().some(value => value.kind === 'error'), false)
  })
  await request('daemon.stop')
  client.close(); client = undefined
  assert.equal((await exited).code, 0, stderr)
  console.log(`ZCode shared memory interop passed ${checks}`)
} finally {
  client?.close()
  if (child.exitCode === null) child.kill('SIGTERM')
  await Promise.race([exited, pause(10000)])
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited }
  try {
    const records = [...evidence(), ...readCompleteJsonl(join(native, 'claude-memory.jsonl')), ...readCompleteJsonl(join(native, 'memory-fixture.jsonl'))]
    for (const entry of records) {
      for (const pid of [entry.pid, entry.mcpPid].filter(Boolean)) assert.equal(alive(pid), false, 'scratch native/helper PID escaped daemon cleanup')
    }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
