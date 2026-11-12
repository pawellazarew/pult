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
const temp = mkdtempSync('/tmp/r3-claude-')
chmodSync(temp, 0o700)
const home = join(temp, 'home'), account = join(temp, 'account'), native = join(account, 'native'), project = join(temp, 'project')
for (const path of [home, account, native, project]) { mkdirSync(path); chmodSync(path, 0o700) }
writeFileSync(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
writeFileSync(join(home, 'config.json'), JSON.stringify({ network: { claude: { mode: 'off' }, guard: { mode: 'allow', countries: ['FI'] } } }), { mode: 0o600 })
const env = { ...process.env, HOME: account, PULT_TEST: '1', PULT_CLAUDE_BIN: join(root, 'rust/tests/fixtures/claude_daemon.py'), PULT_CODEX_BIN: join(temp, 'deliberately-missing-codex'), PULT_CURL_BIN: join(root, 'rust/tests/fixtures/curl_loc_fi.sh'), ANTHROPIC_API_KEY: 'synthetic-ambient-must-not-leak' }
for (const key of ['PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_WORKER_HOLDER_BIN', 'PULT_HOLDER_BIN', 'PULT_ASK_KEY', 'PULT_ASK_SESSION']) delete env[key]
const paths = layout(home)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let client, stderr = '', checks = 0
const child = spawn(binary, ['--home', home, 'daemon', 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000) })
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
async function until(check, label) {
  const deadline = Date.now() + 10000
  while (!await check()) { assert.equal(child.exitCode, null, `scratch daemon exited: ${stderr}`); assert.ok(Date.now() < deadline, label); await pause(10) }
}
const rows = file => existsSync(join(native, file)) ? readFileSync(join(native, file), 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row)) : []
const journal = () => existsSync(join(home, 'events/journal.jsonl')) ? readFileSync(join(home, 'events/journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row)) : []
const record = name => JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions.find(row => row.name === name)
const scope = name => JSON.parse(readFileSync(join(native, `${name}-scope.json`), 'utf8'))
const row = async name => (await client.request('agent.list')).sessions.find(row => row.name === name)
async function done(name, expected = 'done') {
  await until(async () => (await row(name)).status === expected && (await client.request('daemon.status')).nativeRuntime.activeTurns === 0, `${name} missing terminal/cleanup`)
  await until(() => !existsSync(scope(name).path), 'scoped MCP configuration outlived cleanup')
}
async function check(label, run) { await run(); checks++; console.log(`pass ${label}`) }
async function rejectedPurpose(key, purpose) {
  const socket = net.createConnection(paths.sock)
  socket.on('error', () => {})
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const frame = new Promise((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => reject(Error('purpose handshake deadline')), 3000)
      socket.on('data', bytes => { text += bytes; if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.slice(0, text.indexOf('\n')))) } })
      socket.once('end', () => { clearTimeout(timer); reject(Error('purpose handshake closed without denial')) })
    })
    socket.write(JSON.stringify({ type: 'hello', protocol: 1, client: purpose === 'ask' ? 'mcp-ask' : 'cli', [purpose]: key }) + '\n')
    const response = await frame
    assert.equal(response.type, 'error')
  } finally { socket.destroy() }
}
async function revokedHelper(server) {
  const helper = spawn(server.command, server.args ?? [], { env: { HOME: account, PATH: '/usr/bin:/bin', ...server.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  helper.stderr.resume()
  const exit = new Promise(resolve => helper.once('exit', resolve))
  const timer = setTimeout(() => helper.kill('SIGKILL'), 5000)
  const frame = new Promise((resolve, reject) => {
    helper.stdout.on('data', bytes => {
      output += bytes
      const line = output.split('\n').filter(Boolean).find(value => { try { return JSON.parse(value).id === 1 } catch { return false } })
      if (line) resolve(JSON.parse(line))
    })
    helper.once('exit', () => reject(Error('revoked helper closed without MCP denial')))
  })
  try {
    // Keep stdio open until the response: EOF deliberately cancels in-flight
    // MCP calls and would test transport cancellation rather than revoked auth.
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { tool_name: 'Bash', input: { command: 'must-not-run' } } } }) + '\n')
    const response = await frame
    assert.equal(JSON.parse(response.result.content[0].text).behavior, 'deny')
    helper.stdin.end()
    assert.equal(await exit, 0)
  } finally { clearTimeout(timer); if (helper.exitCode === null) { helper.kill('SIGKILL'); await exit } }
}

try {
  await until(() => existsSync(paths.sock) && existsSync(paths.token), 'daemon startup')
  client = await connectClient(paths, { timeoutMs: 5000 })
  await check('cold Claude metadata creates no provider and needs no Codex', async () => {
    for (const name of ['plain', 'ask', 'deny', 'hold']) await client.request('agent.start', { kind: 'claude', name, cwd: project, approval: 'ask' })
    assert.equal(journal().length, 0)
    assert.equal(rows('launches.jsonl').length, 0)
  })
  const literal = 'literal $HOME `do-not-execute` "quotes" 🌊'
  let nativeID
  await check('ordinary native identity and literal input are durable before provider dispatch', async () => {
    const accepted = await client.request('agent.prompt', { name: 'plain', text: literal })
    assert.ok(accepted.turnId.startsWith('claude-turn-'))
    await done('plain')
    nativeID = record('plain').providerSessionId
    assert.ok(typeof nativeID === 'string' && nativeID.length > 0)
    assert.equal(record('plain').claudeReservedSessionId, undefined)
    assert.equal(journal().find(event => event.sessionId === 'plain' && event.kind === 'message.user').data.text, literal)
    assert.ok(!rows('launches.jsonl')[0].args.includes(literal))
    assert.ok(rows('inputs.jsonl')[0].input.message.content.some(block => block.text === literal))
    const status = await client.request('daemon.status')
    assert.equal(status.nativeRuntime.providers.codex.initialized, false)
    assert.equal(status.nativeRuntime.providers.claude.initialized, true)
  })
  await check('explicit next input resumes the confirmed native identity with a new scoped process', async () => {
    await client.request('agent.prompt', { name: 'plain', text: 'explicit second input' })
    await done('plain')
    assert.equal(record('plain').providerSessionId, nativeID)
    const launches = rows('launches.jsonl').filter(row => row.name === 'plain')
    assert.equal(launches.length, 2)
    assert.ok(launches[1].args.some((value, index) => value === '--resume' && launches[1].args[index + 1] === nativeID))
    assert.notEqual(launches[0].pid, launches[1].pid)
  })
  let liveScope
  await check('actual MCP helper asks central Broker and allow cannot rewrite native input', async () => {
    await client.request('agent.prompt', { name: 'ask', text: 'ask-provider allow' })
    let card
    await until(async () => { card = (await client.request('perm.list', { name: 'ask' })).pending[0]; return !!card }, 'actual helper did not publish a permission card')
    liveScope = scope('ask')
    await rejectedPurpose(liveScope.server.env.PULT_ASK_KEY, 'token')
    await rejectedPurpose(liveScope.server.env.PULT_ASK_KEY, 'memory')
    await assert.rejects(client.request('perm.resolve', { id: card.id, decision: 'allow', updatedInput: { command: 'rewritten' } }), error => error.code === 'invalid_params')
    assert.equal((await client.request('perm.list', { name: 'ask' })).pending.length, 1)
    assert.equal((await client.request('perm.resolve', { id: card.id, decision: 'allow', scope: 'once' })).resolved, true)
    await done('ask')
    assert.equal(rows('decisions.jsonl').find(row => row.name === 'ask').behavior, 'allow')
  })
  await check('human denial reaches the actual helper after durable resolution', async () => {
    await client.request('agent.prompt', { name: 'deny', text: 'ask-provider deny' })
    let card
    await until(async () => { card = (await client.request('perm.list', { name: 'deny' })).pending[0]; return !!card }, 'denial permission missing')
    assert.equal((await client.request('perm.resolve', { id: card.id, decision: 'deny' })).resolved, true)
    await done('deny')
    assert.equal(rows('decisions.jsonl').find(row => row.name === 'deny').behavior, 'deny')
  })
  await check('revoked purpose key cannot authenticate or create another question', async () => {
    await rejectedPurpose(liveScope.server.env.PULT_ASK_KEY, 'ask')
    const before = journal().filter(event => event.kind === 'permission.requested').length
    await revokedHelper(liveScope.server)
    assert.equal((await client.request('perm.list')).pending.length, 0)
    assert.equal(journal().filter(event => event.kind === 'permission.requested').length, before)
    assert.ok(!readFileSync(join(home, 'events/journal.jsonl'), 'utf8').includes(liveScope.server.env.PULT_ASK_KEY))
  })
  await check('Claude FIFO drains after release and active selected send has no uncertain marker', async () => {
    await client.request('agent.prompt', { name: 'plain', text: 'hold-provider before FIFO' })
    const one = await client.request('agent.prompt', { name: 'plain', text: 'fifo first', queue: true })
    const two = await client.request('agent.prompt', { name: 'plain', text: 'fifo second', queue: true })
    assert.equal(one.queued, true); assert.equal(two.queued, true)
    const receipts = journal().filter(event => event.sessionId === 'plain' && event.kind === 'message.user').length
    const inputs = rows('inputs.jsonl').filter(row => row.name === 'plain').length
    await assert.rejects(client.request('agent.queue.send', { name: 'plain', id: two.id }), error => error.code === 'unsupported')
    assert.equal(record('plain').queueDispatch, undefined)
    assert.deepEqual(record('plain').queue.map(item => item.id), [one.id, two.id])
    assert.equal(journal().filter(event => event.sessionId === 'plain' && event.kind === 'message.user').length, receipts)
    assert.equal(rows('inputs.jsonl').filter(row => row.name === 'plain').length, inputs)
    writeFileSync(join(native, 'release-plain'), '')
    await until(async () => !(await row('plain')).queue?.length && (await row('plain')).status === 'done' && (await client.request('daemon.status')).nativeRuntime.activeTurns === 0, 'Claude FIFO did not drain')
    const queued = journal().filter(event => event.sessionId === 'plain' && event.kind === 'message.user' && [one.id, two.id].includes(event.data.queueItemId))
    assert.deepEqual(queued.map(event => event.data.queueItemId), [one.id, two.id])
    assert.deepEqual(queued.map(event => event.data.text), ['fifo first', 'fifo second'])
    assert.ok(queued.every(event => typeof event.data.queueItemAt === 'string'))
    assert.equal(record('plain').queueDispatch, undefined)
    await done('plain')
  })
  await check('interrupt replacement preserves paused Claude backlog and explicit resume drains it', async () => {
    await client.request('agent.prompt', { name: 'plain', text: 'hold-provider before interrupt' })
    const queued = await client.request('agent.prompt', { name: 'plain', text: 'retained after interrupt', queue: true })
    assert.equal(queued.queued, true)
    await client.request('agent.prompt', { name: 'plain', text: 'explicit interrupt replacement', interrupt: true })
    await done('plain')
    assert.equal((await row('plain')).queuePaused, true)
    assert.deepEqual((await row('plain')).queue.map(item => item.id), [queued.id])
    assert.equal(journal().filter(event => event.kind === 'message.user' && event.data.queueItemId === queued.id).length, 0)
    await client.request('agent.queue.resume', { name: 'plain' })
    await until(async () => !(await row('plain')).queue?.length && (await row('plain')).status === 'done' && (await client.request('daemon.status')).nativeRuntime.activeTurns === 0, 'Claude paused queue did not resume')
    assert.equal(journal().filter(event => event.kind === 'message.user' && event.data.queueItemId === queued.id).length, 1)
    assert.equal(record('plain').queueDispatch, undefined)
    await done('plain')
  })
  await check('exact public stop cleans native process and MCP files without hanging daemon', async () => {
    const accepted = await client.request('agent.prompt', { name: 'hold', text: 'hold-provider' })
    assert.equal((await client.request('agent.stop', { name: 'hold', turnId: 'pult-stale' })).stopped, false)
    assert.equal((await client.request('agent.stop', { name: 'hold', turnId: accepted.turnId })).stopped, true)
    await done('hold', 'interrupted')
    assert.equal((await client.request('daemon.stop')).stopping, true)
    client.close(); client = null
    const result = await Promise.race([exited, pause(6000).then(() => { throw Error('owned daemon cleanup did not finish') })])
    assert.equal(result.code, 0)
    for (const launch of rows('launches.jsonl')) assert.throws(() => process.kill(launch.pid, 0), error => error.code === 'ESRCH')
  })
} finally {
  if (client) { try { await client.request('daemon.stop') } catch {} client.close() }
  if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([exited, pause(5000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited } }
  rmSync(temp, { recursive: true, force: true })
}
console.log(`Claude daemon interop passed ${checks}`)
