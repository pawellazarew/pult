import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
const { connectClient } = await import('../../dist/cli/client.js')
const { layout } = await import('../../dist/core/paths.js')
const root = fileURLToPath(new URL('../../', import.meta.url))
const binary = resolve(process.argv[2])
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
async function until(check, label) {
  const deadline = Date.now() + 6000
  while (!await check()) { assert.equal(child.exitCode, null, `daemon exited: ${stderr}`); assert.ok(Date.now() < deadline, label); await pause(10) }
}
const journal = () => existsSync(join(home, 'events/journal.jsonl')) ? readFileSync(join(home, 'events/journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
async function check(label, run) { await run(); checks++; console.log(`pass ${label}`) }
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
    await assert.rejects(client.request('agent.prompt', { name: 'one', text: 'hello', queue: true }), e => e.code === 'unsupported')
    assert.equal(journal().length, 0); assert.equal(existsSync(join(native, 'messages.jsonl')), false)
  })
  await check('ordinary Codex turn uses the real daemon journal and durable thread metadata', async () => {
    const accepted = await client.request('agent.prompt', { name: 'one', text: 'hello one' })
    assert.match(accepted.turnId, /^pult-/)
    await until(async () => (await client.request('agent.list')).sessions.find(row => row.name === 'one').status === 'done', 'turn did not finish')
    const events = journal().filter(row => row.sessionId === 'one')
    assert.equal(events.filter(row => row.kind === 'message.user').length, 1)
    assert.ok(events.some(row => row.kind === 'message.done'))
    const records = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions
    assert.ok(records.find(row => row.name === 'one').providerSessionId)
    assert.equal((await client.request('daemon.status')).nativeRuntime.hosts, 1)
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
    await until(async () => (await client.request('agent.list')).sessions.find(row => row.name === 'ask').status === 'done', 'resolved turn did not finish')
    assert.ok(journal().some(row => row.kind === 'permission.resolved' && row.data.decision === 'allow'))
  })
  await check('a stale turn id cannot stop the current turn', async () => {
    const accepted = await client.request('agent.prompt', { name: 'one', text: 'hold' })
    assert.equal((await client.request('agent.stop', { name: 'one', turnId: 'pult-stale' })).stopped, false)
    assert.equal((await client.request('agent.list')).sessions.find(row => row.name === 'one').status, 'working')
    assert.equal((await client.request('agent.stop', { name: 'one', turnId: accepted.turnId })).stopped, true)
    await until(async () => (await client.request('agent.list')).sessions.find(row => row.name === 'one').status === 'interrupted', 'stop did not interrupt')
  })
  await check('scoped memory credentials cannot execute owner session commands', async () => {
    await client.request('memory.context.bind', { session: 'one', enabled: true })
    const issued = await client.request('memory.context.issue', { session: 'one' })
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
  rmSync(temp, { recursive: true, force: true })
}
console.log(`session runtime interop passed ${checks}`)
