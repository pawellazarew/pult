import { readCompleteJsonl } from './support/complete-jsonl.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const { connectClient } = await import('../../dist/cli/client.js')
const { layout } = await import('../../dist/core/paths.js')
const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = mkdtempSync('/tmp/claude-memory-')
chmodSync(temp, 0o700)
const home = join(temp, 'home'), account = join(temp, 'account'), native = join(account, 'native'), project = join(temp, 'project')
for (const path of [home, account, native, project]) { mkdirSync(path); chmodSync(path, 0o700) }
writeFileSync(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { claude: { mode: 'off' }, codex: { mode: 'off' }, guard: { mode: 'allow', countries: ['FI'] } } }), { mode: 0o600 })
const env = { ...process.env, HOME: account, PULT_TEST: '1', PULT_CLAUDE_BIN: join(root, 'rust/tests/fixtures/claude_memory.py'), PULT_CODEX_BIN: join(root, 'rust/tests/fixtures/codex_memory.py'), PULT_CURL_BIN: join(root, 'rust/tests/fixtures/curl_loc_fi.sh'), ANTHROPIC_API_KEY: 'synthetic-not-an-account' }
for (const key of ['PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_ASK_KEY', 'PULT_ASK_SESSION', 'PULT_WORKER_HOLDER_BIN', 'PULT_HOLDER_BIN']) delete env[key]
const child = spawn(resolve(process.argv[2]), ['--home', home, 'daemon', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = '', client, checks = 0
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000) })
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
const paths = layout(home), pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const evidence = () => readCompleteJsonl(join(native, 'claude-memory.jsonl'))
const codexEvidence = () => readCompleteJsonl(join(native, 'memory-fixture.jsonl'))
const journal = () => readCompleteJsonl(join(home, 'events/journal.jsonl'))
const row = async name => (await client.request('agent.list')).sessions.find(value => value.name === name)
const memory = (method, params = {}) => client.request(`memory.${method}`, params)
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function until(predicate, label) {
  const deadline = Date.now() + 10000
  while (!await predicate()) {
    assert.equal(child.exitCode, null, `scratch daemon exited: ${stderr}`)
    assert.ok(Date.now() < deadline, label)
    await pause(10)
  }
}
async function prompt(name, instruction) { return client.request('agent.prompt', { name, text: JSON.stringify(instruction) }, { timeoutMs: 35000 }) }
async function result(name, run) {
  await until(() => evidence().some(value => value.kind === 'result' && value.run === run), `${run} missing fixture result`)
  await until(async () => (await row(name)).status === 'done', `${run} not done`)
  const launch = evidence().filter(value => value.kind === 'launch' && value.name === name).at(-1)
  await until(() => !alive(launch.pid) && !existsSync(launch.configPath), `${run} process/config cleanup pending`)
  return evidence().find(value => value.kind === 'result' && value.run === run)
}
async function card(name) {
  let value
  await until(async () => { value = (await client.request('perm.list', { name })).pending[0]; return !!value }, `${name} missing memory approval`)
  assert.equal(value.toolName, 'pult_memory.propose')
  return value
}
async function check(label, run) { await run(); checks++; console.log(`pass ${label}`) }
const add = commandId => ({ operation: 'add', commandId, name: 'Shared Claude decision', summary: 'Shared project choice', details: 'CLAUDE_SHARED_DETAILS', reason: 'Offline owner-approved fixture' })
let seed, saved
try {
  await until(() => existsSync(paths.sock) && existsSync(paths.token), 'startup')
  client = await connectClient(paths, { timeoutMs: 10000 })
  await check('cold policy registration and ordinary memory-off Claude do not discover Codex', async () => {
    for (const [name, more] of [
      ['writer', {}], ['readonly', { approval: 'read-only' }],
      ['full', { approval: 'full', confirm: true, grant: 'cli-once' }],
      ['off', { memory: { read: false, write: 'off' } }],
    ]) await client.request('agent.start', { kind: 'claude', name, cwd: project, approval: 'ask', memory: { read: true, write: 'ask' }, ...more })
    await client.request('agent.start', { kind: 'codex', name: 'reader', cwd: project, approval: 'ask', memory: { read: true, write: 'ask' } })
    assert.equal((await client.request('daemon.status')).nativeRuntime.initialized, false)
    seed = await memory('add', { session: 'writer', commandId: 'owner-seed', name: 'Seed decision', summary: 'Seed summary', details: 'DETAILS_NOT_IN_CATALOG', reason: 'Owner seed' })
    await prompt('off', { run: 'memory-off' })
    await result('off', 'memory-off')
    assert.equal(evidence().find(value => value.kind === 'launch' && value.name === 'off').memory, false)
    assert.equal((await client.request('daemon.status')).nativeRuntime.providers.codex.initialized, false)
  })
  await check('Claude receives bounded data catalog and reads through actual memory MCP', async () => {
    const instruction = { run: 'read-seed', id: seed.id }
    await prompt('writer', instruction)
    const outcome = await result('writer', instruction.run)
    assert.equal(outcome.get.details, seed.details)
    const texts = evidence().find(value => value.kind === 'dispatch' && value.run === instruction.run).texts
    assert.equal(texts[0], JSON.stringify(instruction))
    assert.ok(texts[1].includes(seed.id) && !texts[1].includes(seed.details))
    assert.ok(texts[1].length <= 4000 && Buffer.byteLength(texts[1]) <= 16000)
    const user = journal().find(value => value.sessionId === 'writer' && value.kind === 'message.user')
    assert.equal(user.data.text, texts[0])
    assert.ok(!user.data.text.includes('Project memory:'))
    assert.equal((await client.request('daemon.status')).nativeRuntime.providers.codex.initialized, false)
  })
  await check('denied Claude proposal does not save; allowed proposal has actual Claude provenance', async () => {
    await prompt('writer', { run: 'deny-add', proposal: add('deny-add') })
    const denied = await card('writer')
    await client.request('perm.resolve', { id: denied.id, decision: 'deny' })
    assert.equal((await result('writer', 'deny-add')).proposal.isError, true)
    const accepted = await prompt('writer', { run: 'allow-add', proposal: add('allow-add') })
    const allowed = await card('writer')
    assert.equal(allowed.input.sourceTurnId, accepted.turnId)
    await client.request('perm.resolve', { id: allowed.id, decision: 'allow', scope: 'once' })
    const outcome = await result('writer', 'allow-add')
    saved = await memory('get', { session: 'writer', id: outcome.proposal.id })
    assert.equal(saved.author, 'claude')
    assert.equal(saved.sourceTurnId, accepted.turnId)
    assert.equal(saved.sourceSession, 'writer')
    assert.equal(saved.version, 1)
    assert.equal(saved.details, 'CLAUDE_SHARED_DETAILS')
    const user = journal().find(value => value.id === saved.sourceEventId)
    assert.equal(user.kind, 'message.user')
    assert.equal(JSON.parse(user.data.text).run, 'allow-add')
    assert.equal((await memory('list', { session: 'writer' })).memories.filter(value => value.name === 'Shared Claude decision').length, 1)
  })
  await check('a later Codex turn reads the same record and version through the shared backend', async () => {
    await prompt('reader', { run: 'codex-read-claude', id: saved.id })
    await until(() => codexEvidence().some(value => value.kind === 'result' && value.run === 'codex-read-claude'), 'Codex did not read Claude record')
    await until(async () => (await row('reader')).status === 'done', 'Codex read did not finish')
    const outcome = codexEvidence().find(value => value.kind === 'result' && value.run === 'codex-read-claude')
    assert.equal(outcome.get.id, saved.id)
    assert.equal(outcome.get.version, saved.version)
    assert.equal(outcome.get.details, saved.details)
    assert.ok(outcome.catalog.memories.some(value => value.id === saved.id))
  })
  await check('read-only hides and rejects proposals; Full still requires separate memory approval', async () => {
    await prompt('readonly', { run: 'readonly-propose', id: seed.id, proposal: add('readonly-add') })
    const outcome = await result('readonly', 'readonly-propose')
    assert.equal(outcome.get.id, seed.id)
    assert.equal(outcome.tools.includes('memory_propose'), false)
    assert.equal(outcome.proposal.isError, true)
    assert.equal((await client.request('perm.list', { name: 'readonly' })).pending.length, 0)
    await prompt('full', { run: 'full-propose', proposal: add('full-add') })
    const pending = await card('full')
    assert.equal((await row('full')).liveApproval, 'full')
    await client.request('perm.resolve', { id: pending.id, decision: 'deny' })
    assert.equal((await result('full', 'full-propose')).proposal.isError, true)
  })
  await check('revoking policy denies an already prepared helper without another approval or write', async () => {
    await prompt('writer', { run: 'revoke-live', id: saved.id, hold: true, proposal: add('revoked-add') })
    await until(() => evidence().some(value => value.kind === 'holding' && value.run === 'revoke-live'), 'live helper barrier missing')
    const before = journal().filter(value => value.kind === 'permission.requested').length
    await memory('configure', { session: 'writer', memory: { read: false, write: 'off' } })
    writeFileSync(join(native, 'release-revoke-live'), '')
    const outcome = await result('writer', 'revoke-live')
    assert.equal(outcome.get.isError, true)
    assert.equal(outcome.proposal.isError, true)
    assert.equal(journal().filter(value => value.kind === 'permission.requested').length, before)
    assert.equal((await memory('get', { session: 'reader', id: saved.id })).version, 1)
  })
  console.log(`Claude shared memory interop passed ${checks}`)
} finally {
  if (client && child.exitCode === null) { try { await client.request('daemon.stop') } catch {} }
  client?.close()
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  try {
    const exit = await exited
    assert.equal(exit.code, 0, `scratch daemon cleanup failed: ${stderr}`)
    assert.equal(exit.signal, null)
    for (const entry of [...evidence(), ...codexEvidence()]) {
      for (const pid of [entry.pid, entry.mcpPid].filter(Boolean)) assert.equal(alive(pid), false, 'scratch native/helper PID escaped cleanup')
    }
  } finally { clearTimeout(timer); rmSync(temp, { recursive: true, force: true }) }
}
