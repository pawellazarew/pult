import { readCompleteJsonl } from './support/complete-jsonl.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const { connectClient } = await import('../../dist/cli/client.js')
const { layout } = await import('../../dist/core/paths.js')
const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = mkdtempSync('/tmp/r3-zcode-recovery-')
chmodSync(temp, 0o700)
const home = join(temp, 'home'), account = join(temp, 'account'), native = join(account, 'native'), projects = join(temp, 'projects')
for (const path of [home, account, native, projects]) { mkdirSync(path); chmodSync(path, 0o700) }
writeFileSync(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { zcode: { mode: 'off' }, guard: { mode: 'allow', countries: ['FI'] } } }), { mode: 0o600 })
const env = { ...process.env, HOME: account, PULT_TEST: '1', PULT_ZCODE_BIN: join(root, 'rust/tests/fixtures/zcode_recovery.py'), PULT_CODEX_BIN: join(temp, 'missing-codex'), PULT_CLAUDE_BIN: join(temp, 'missing-claude'), PULT_CURL_BIN: join(root, 'rust/tests/fixtures/curl_loc_fi.sh'), OPENAI_API_KEY: 'synthetic-not-forwarded' }
for (const key of ['PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_WORKER_HOLDER_BIN', 'PULT_HOLDER_BIN', 'PULT_ASK_KEY', 'PULT_ASK_SESSION']) delete env[key]
const paths = layout(home), pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const launches = () => readCompleteJsonl(join(native, 'launches.jsonl'))
const journal = () => readCompleteJsonl(join(home, 'events/journal.jsonl'))
const record = name => JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions.find(row => row.name === name)
const events = name => journal().filter(event => event.sessionId === name)
const pidAlive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
let child, client, exited, stderr = '', checks = 0
async function until(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    assert.equal(child.exitCode, null, `scratch daemon exited: ${stderr}`)
    assert.ok(Date.now() < deadline, label)
    await pause(10)
  }
}
async function start() {
  stderr = ''
  child = spawn(resolve(process.argv[2]), ['--home', home, 'daemon', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000) })
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await until(() => existsSync(paths.sock) && existsSync(paths.token), 'daemon startup')
  client = await connectClient(paths, { timeoutMs: 35000 }) // production native admission deadline is 30s
}
async function stop() {
  if (!child) return
  if (client && child.exitCode === null) { try { await client.request('daemon.stop') } catch {} }
  client?.close(); client = undefined
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  try {
    const result = await exited
    assert.equal(result.signal, null, 'scratch daemon needed a forced stop')
    assert.equal(result.code, 0, `scratch daemon stop failed: ${stderr}`)
    for (const launch of launches()) assert.equal(pidAlive(launch.pid), false, 'synthetic provider escaped daemon cleanup')
  } finally { clearTimeout(timer); child = undefined }
}
const status = () => client.request('daemon.status')
const row = async name => (await client.request('agent.list')).sessions.find(value => value.name === name)
const get = name => client.request('agent.recovery.get', { name })
async function normal(name, text) {
  const result = await client.request('agent.prompt', { name, text })
  assert.ok(result.turnId.startsWith('zcode-turn-'))
  await until(async () => (await row(name)).status === 'idle' && !pidAlive(launches().filter(value => value.name === name).at(-1).pid), `${name} did not finish owned cleanup`)
  return record(name).providerSessionId
}
async function missing(name) {
  await assert.rejects(client.request('agent.prompt', { name, text: `missing-provider ${name}` }), error => error.code === 'internal')
  let value
  await until(async () => { value = await get(name); return value.recovery?.state === 'available' }, `${name} missing proof did not become available`)
  assert.equal(value.deliveryUnknown, true)
  assert.equal(value.executionUnavailable, false)
  assert.equal(value.recovery.sessionId, name)
  assert.equal(value.recovery.createdAt, record(name).createdAt)
  assert.equal(value.recovery.mayHaveExecuted, true)
  assert.ok(value.recovery.recoveryId.startsWith('zr-'))
  assert.ok(record(name).zcodePendingInput)
  assert.equal(pidAlive(launches().filter(value => value.name === name).at(-1).pid), false)
  return value.recovery.recoveryId
}
async function check(label, run) { await run(); checks++; console.log(`pass ${label}`) }
let plainID, coldID, plainRecovery, coldRecovery, neighborPID
try {
  await start()
  await check('cold GET validates metadata without provider initialization', async () => {
    for (const name of ['plain', 'cold', 'neighbor', 'other']) {
      const cwd = join(projects, name); mkdirSync(cwd); chmodSync(cwd, 0o700)
      await client.request('agent.start', { kind: 'zcode', name, cwd, approval: 'ask' })
    }
    assert.deepEqual(await get('plain'), { provider: 'zcode', recovery: null, deliveryUnknown: false, executionUnavailable: false })
    assert.equal((await status()).nativeRuntime.initialized, false)
    assert.equal(launches().length, 0)
    assert.equal(journal().length, 0)
    await assert.rejects(client.request('agent.recovery.get', { name: 'plain', nativeSid: 'forged' }), error => error.code === 'invalid_params')
  })
  await check('confirmed IDs then genuine resumed missing create exact joined proofs', async () => {
    const literal = 'literal $HOME `not-a-shell` "quotes" 🌊'
    plainID = await normal('plain', literal)
    coldID = await normal('cold', 'first cold conversation')
    assert.equal(events('plain').find(value => value.kind === 'message.user').data.text, literal)
    await client.request('agent.prompt', { name: 'neighbor', text: 'hold-provider neighbor survives recovery' })
    neighborPID = launches().filter(value => value.name === 'neighbor').at(-1).pid
    plainRecovery = await missing('plain')
    coldRecovery = await missing('cold')
    for (const [name, id] of [['plain', plainID], ['cold', coldID]]) {
      const launch = launches().filter(value => value.name === name).at(-1)
      assert.equal(launch.args[launch.args.indexOf('--resume') + 1], id)
    }
    assert.equal(pidAlive(neighborPID), true)
    assert.equal((await row('neighbor')).status, 'working')
  })
  await check('strict acknowledgement selectors and cross-session authority fail closed', async () => {
    const before = launches().length, original = record('plain'), history = events('plain')
    const valid = { name: 'plain', recoveryId: plainRecovery, acknowledgePossibleExecution: true }
    for (const params of [
      { name: 'plain', recoveryId: plainRecovery },
      { ...valid, acknowledgePossibleExecution: false },
      { ...valid, acknowledgePossibleExecution: 'true' },
      { ...valid, providerSessionId: 'forged' },
      { ...valid, recoveryId: 'forged' },
      { ...valid, recoveryId: 'zr-wrong' },
      { ...valid, name: 'cold' },
    ]) await assert.rejects(client.request('agent.recovery.confirm', params), error => error.code === 'invalid_params')
    assert.deepEqual(record('plain'), original)
    assert.deepEqual(events('plain'), history)
    assert.equal(launches().length, before)
    assert.equal((await get('plain')).recovery.recoveryId, plainRecovery)
    assert.equal((await get('cold')).recovery.recoveryId, coldRecovery)
  })
  await check('confirmation appends requested then committed and only resets metadata', async () => {
    const before = launches().length, original = record('plain'), history = events('plain')
    const result = await client.request('agent.recovery.confirm', { name: 'plain', recoveryId: plainRecovery, acknowledgePossibleExecution: true })
    assert.deepEqual({ ...result, requestedEventId: 0, committedEventId: 0 }, { provider: 'zcode', reset: true, mayHaveExecuted: true, requestedEventId: 0, committedEventId: 0, queuePaused: true, startsNewConversation: true })
    assert.ok(Number.isSafeInteger(result.requestedEventId) && result.requestedEventId > history.at(-1).id)
    assert.ok(Number.isSafeInteger(result.committedEventId) && result.committedEventId > result.requestedEventId)
    const after = record('plain')
    assert.equal(after.providerSessionId, undefined)
    assert.equal(after.zcodePendingInput, undefined)
    assert.equal(after.queuePaused, true)
    for (const field of ['createdAt', 'cwd', 'approval', 'title', 'queue', 'queueDispatch']) assert.deepEqual(after[field], original[field])
    const updated = events('plain')
    assert.deepEqual(updated.slice(0, history.length), history)
    const notices = updated.slice(history.length)
    assert.deepEqual(notices.map(value => value.data.recovery.phase), ['requested', 'committed'])
    assert.deepEqual(notices.map(value => value.id), [result.requestedEventId, result.committedEventId])
    assert.equal(notices[0].data.changes, undefined)
    assert.ok(notices.every(value => value.kind === 'session.configured' && value.data.mayHaveExecuted === true))
    assert.equal(launches().length, before)
    assert.deepEqual(await get('plain'), { provider: 'zcode', recovery: null, deliveryUnknown: false, executionUnavailable: false })
    assert.equal(pidAlive(neighborPID), true)
    assert.equal((await row('neighbor')).status, 'working')
    await assert.rejects(client.request('agent.recovery.confirm', { name: 'plain', recoveryId: plainRecovery, acknowledgePossibleExecution: true }), error => error.code === 'invalid_params')
  })
  await check('only explicit next input starts a new native conversation without resume', async () => {
    const before = launches().length, users = events('plain').filter(value => value.kind === 'message.user').length
    const newID = await normal('plain', 'explicit next input after recovery')
    assert.notEqual(newID, plainID)
    assert.equal(launches().length, before + 1)
    const launch = launches().filter(value => value.name === 'plain').at(-1)
    assert.equal(launch.args.includes('--resume'), false)
    assert.equal(events('plain').filter(value => value.kind === 'message.user').length, users + 1)
    assert.equal(pidAlive(neighborPID), true)
    await client.request('agent.stop', { name: 'neighbor' })
    await until(() => !pidAlive(neighborPID), 'neighbor stop did not join provider')
  })
  await check('cold restart retains uncertainty but cannot reconstruct or initialize proof', async () => {
    const before = launches().length, original = record('cold'), history = events('cold')
    await stop()
    await start()
    assert.deepEqual(await get('cold'), { provider: 'zcode', recovery: null, deliveryUnknown: true, executionUnavailable: false })
    assert.equal((await status()).nativeRuntime.initialized, false)
    await assert.rejects(client.request('agent.recovery.confirm', { name: 'cold', recoveryId: coldRecovery, acknowledgePossibleExecution: true }), error => error.code === 'not_found')
    assert.equal((await status()).nativeRuntime.initialized, false)
    assert.equal(record('cold').providerSessionId, original.providerSessionId)
    assert.deepEqual(record('cold').zcodePendingInput, original.zcodePendingInput)
    assert.equal(record('cold').queuePaused, true)
    assert.deepEqual(events('cold'), history)
    assert.equal(launches().length, before)
  })
  console.log(`ZCode recovery interop passed ${checks}`)
} finally {
  try { await stop() } finally { rmSync(temp, { recursive: true, force: true }) }
}
