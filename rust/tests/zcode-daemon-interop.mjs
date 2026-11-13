import { readCompleteJsonl } from './support/complete-jsonl.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const { connectClient } = await import('../../dist/cli/client.js')
const { layout } = await import('../../dist/core/paths.js')
const root = fileURLToPath(new URL('../../', import.meta.url))
const temp = mkdtempSync('/tmp/r3-zcode-')
chmodSync(temp, 0o700)
const home = join(temp, 'home'), account = join(temp, 'account'), native = join(account, 'native'), projects = join(temp, 'projects')
for (const path of [home, account, native, projects]) { mkdirSync(path); chmodSync(path, 0o700) }
writeFileSync(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { zcode: { mode: 'off' }, guard: { mode: 'allow', countries: ['FI'] } } }), { mode: 0o600 })
const env = { ...process.env, HOME: account, PULT_TEST: '1', PULT_ZCODE_BIN: join(root, 'rust/tests/fixtures/zcode_daemon.py'), PULT_CODEX_BIN: join(temp, 'missing-codex'), PULT_CLAUDE_BIN: join(temp, 'missing-claude'), PULT_CURL_BIN: join(root, 'rust/tests/fixtures/curl_loc_fi.sh'), OPENAI_API_KEY: 'synthetic-ambient-must-not-leak' }
for (const key of ['PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_WORKER_HOLDER_BIN', 'PULT_HOLDER_BIN', 'PULT_ASK_KEY', 'PULT_ASK_SESSION']) delete env[key]
const paths = layout(home), pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let client, stderr = '', checks = 0
const child = spawn(resolve(process.argv[2]), ['--home', home, 'daemon', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000) })
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
// Queue drain includes native admission (30s default) and owned retirement;
// post-acceptance terminal checks below keep their original 10s watchdog.
const QUEUED_START_AND_CLEANUP_MS = 35000
async function until(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    assert.equal(child.exitCode, null, `scratch daemon exited: ${stderr}`)
    assert.ok(Date.now() < deadline, label)
    await pause(10)
  }
}
const launches = () => readCompleteJsonl(join(native, 'launches.jsonl'))
const journal = () => readCompleteJsonl(join(home, 'events/journal.jsonl'))
const record = name => JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions.find(row => row.name === name)
const row = async name => (await client.request('agent.list')).sessions.find(row => row.name === name)
async function done(name) {
  await until(async () => (await row(name)).status === 'idle' && (await client.request('daemon.status')).nativeRuntime.activeTurns === 0, `${name} did not finish cleanup`)
}
async function check(label, run) { await run(); checks++; console.log(`pass ${label}`) }
try {
  await until(() => existsSync(paths.sock) && existsSync(paths.token), 'daemon startup')
  client = await connectClient(paths, { timeoutMs: 10000 })
  await check('cold ZCode metadata needs neither Claude nor Codex', async () => {
    for (const name of ['plain', 'unknown', 'auth']) {
      const cwd = join(projects, name)
      mkdirSync(cwd); chmodSync(cwd, 0o700)
      await client.request('agent.start', { kind: 'zcode', name, cwd, approval: 'ask' })
    }
    assert.equal(launches().length, 0)
    assert.equal(journal().length, 0)
  })
  const literal = 'literal $HOME `do-not-execute` "quotes" 🌊'
  let nativeID
  await check('native acceptance receipts literal argv without shell expansion', async () => {
    const accepted = await client.request('agent.prompt', { name: 'plain', text: literal })
    assert.ok(accepted.turnId.startsWith('zcode-turn-'))
    await done('plain')
    nativeID = record('plain').providerSessionId
    assert.equal(nativeID, 'sess_fixture_plain')
    assert.equal(record('plain').zcodePendingInput, undefined)
    assert.equal(journal().find(e => e.sessionId === 'plain' && e.kind === 'message.user').data.text, literal)
    const args = launches()[0].args
    assert.ok(args[args.indexOf('-p') + 1].startsWith(literal))
    assert.equal(args[args.indexOf('--mode') + 1], 'guarded')
    assert.ok(!args.includes('--session-id') && !args.includes('--mcp-config'))
    const status = await client.request('daemon.status')
    assert.equal(status.nativeRuntime.providers.codex.initialized, false)
    assert.equal(status.nativeRuntime.providers.claude.initialized, false)
    assert.equal(status.nativeRuntime.providers.zcode.initialized, true)
  })
  await check('next explicit input resumes only the confirmed native conversation', async () => {
    await client.request('agent.prompt', { name: 'plain', text: 'explicit second input' })
    await done('plain')
    const started = launches().filter(row => row.name === 'plain')
    assert.equal(started.length, 2)
    assert.notEqual(started[0].pid, started[1].pid)
    assert.equal(started[1].args[started[1].args.indexOf('--resume') + 1], nativeID)
  })
  await check('FIFO preserves queued receipts and rejects live steering', async () => {
    await client.request('agent.prompt', { name: 'plain', text: 'hold-provider before FIFO' })
    const first = await client.request('agent.prompt', { name: 'plain', text: 'fifo first', queue: true })
    const second = await client.request('agent.prompt', { name: 'plain', text: 'fifo second', queue: true })
    assert.equal(first.queued, true); assert.equal(second.queued, true)
    await assert.rejects(client.request('agent.queue.send', { name: 'plain', id: second.id }), e => e.code === 'unsupported')
    assert.equal(record('plain').queueDispatch, undefined)
    writeFileSync(join(native, 'release-plain'), '')
    await until(async () => !(await row('plain')).queue?.length && (await row('plain')).status === 'idle' && (await client.request('daemon.status')).nativeRuntime.activeTurns === 0, 'FIFO did not drain', 2 * QUEUED_START_AND_CLEANUP_MS)
    const receipts = journal().filter(e => e.sessionId === 'plain' && e.kind === 'message.user' && [first.id, second.id].includes(e.data.queueItemId))
    assert.deepEqual(receipts.map(e => e.data.queueItemId), [first.id, second.id])
    assert.deepEqual(receipts.map(e => e.data.text), ['fifo first', 'fifo second'])
  })
  await check('interrupt joins old process and preserves paused backlog', async () => {
    await client.request('agent.prompt', { name: 'plain', text: 'hold-provider before interrupt' })
    const queued = await client.request('agent.prompt', { name: 'plain', text: 'retained after interrupt', queue: true })
    const oldPID = launches().at(-1).pid
    await client.request('agent.prompt', { name: 'plain', text: 'explicit interrupt replacement', interrupt: true })
    await done('plain')
    assert.throws(() => process.kill(oldPID, 0), e => e.code === 'ESRCH')
    assert.equal((await row('plain')).queuePaused, true)
    assert.deepEqual(record('plain').queue.map(item => item.id), [queued.id])
    const startBarrier = join(native, 'block-start-plain')
    const beforeResume = launches().length
    writeFileSync(startBarrier, '')
    let releaseStart
    try {
      await client.request('agent.queue.resume', { name: 'plain' })
      await until(() => launches().length > beforeResume, 'held queued process did not start')
      assert.ok(record('plain').zcodePendingInput)
      assert.equal(journal().filter(e => e.sessionId === 'plain' && e.kind === 'message.user' && e.data.queueItemId === queued.id).length, 0)
      // This deliberate delay is below the production 30s acceptance deadline,
      // but above the old terminal-only 10s helper. No early queued receipt.
      releaseStart = setTimeout(() => rmSync(startBarrier, { force: true }), 11500)
      await until(async () => !(await row('plain')).queue?.length && (await row('plain')).status === 'idle', 'paused backlog did not resume', QUEUED_START_AND_CLEANUP_MS)
      assert.equal(journal().filter(e => e.sessionId === 'plain' && e.kind === 'message.user' && e.data.queueItemId === queued.id).length, 1)
    } finally {
      clearTimeout(releaseStart)
      rmSync(startBarrier, { force: true })
    }
  })
  await check('session header alone retains unknown delivery and forbids replay', async () => {
    await assert.rejects(client.request('agent.prompt', { name: 'unknown', text: 'session-only-provider input' }))
    await until(async () => (await client.request('daemon.status')).nativeRuntime.activeTurns === 0, 'unknown process cleanup')
    const before = launches().length
    assert.ok(record('unknown').zcodePendingInput)
    assert.deepEqual(journal().filter(e => e.sessionId === 'unknown' && e.kind === 'message.user').map(e => e.data.text), ['session-only-provider input'])
    await assert.rejects(client.request('agent.prompt', { name: 'unknown', text: 'must not replay' }), e => e.code === 'start_unknown' && e.message.includes('ZCode') && !e.message.includes('Claude'))
    assert.equal(launches().length, before)
    assert.equal(journal().filter(e => e.sessionId === 'unknown' && e.kind === 'message.user').length, 1)
  })
  await check('observed auth blocks ZCode admission without another CLI or login', async () => {
    await assert.rejects(client.request('agent.prompt', { name: 'auth', text: 'auth-provider input' }))
    await until(async () => (await client.request('daemon.status')).nativeRuntime.providers.zcode.blocked, 'observed auth latch missing')
    const before = launches().length
    await assert.rejects(client.request('agent.prompt', { name: 'plain', text: 'blocked admission' }), e => e.code === 'provider_unavailable')
    assert.equal(launches().length, before)
    assert.ok(journal().some(e => e.sessionId === 'auth' && e.kind === 'provider.blocked'))
  })
  console.log(`ZCode daemon interop passed ${checks}`)
} finally {
  if (client && child.exitCode === null) {
    try { await client.request('daemon.stop') } catch {}
  }
  client?.close()
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  try {
    await exited
    for (const launch of launches()) {
      assert.throws(() => process.kill(launch.pid, 0), e => e.code === 'ESRCH', 'daemon released a synthetic provider PID')
    }
  } finally { clearTimeout(timer); rmSync(temp, { recursive: true, force: true }) }
}
