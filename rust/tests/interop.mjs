import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { realpathSync, mkdtempSync, existsSync, readFileSync, statSync, rmSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
assert.ok(existsSync(join(root, 'dist/cli/client.js')), 'Run npm ci && npm run build before Rust interoperability tests')
const { connectClient } = await import(new URL('../../dist/cli/client.js', import.meta.url))
const { layout } = await import(new URL('../../dist/core/paths.js', import.meta.url))
const binary = resolve(process.argv[2])
const scratch = mkdtempSync(join(tmpdir(), 'r2-'))
chmodSync(scratch, 0o700)
const home = join(scratch, 'home')
const paths = layout(home)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
let daemon
let client
let passed = 0
async function check(name, run) { await run(); passed++; console.log(`pass ${name}`) }
function launch(directory = home) {
  const child = spawn(binary, ['--home', directory, 'daemon', 'serve'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-4096) })
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))
  return { child, exited, get stderr() { return stderr } }
}
async function ready() {
  const deadline = Date.now() + 5000
  while (!existsSync(paths.sock) || !existsSync(paths.token)) {
    assert.equal(daemon.child.exitCode, null, `daemon exited during startup ${daemon.stderr}`)
    if (Date.now() > deadline) throw new Error('daemon startup deadline')
    await pause(10)
  }
}
async function frame(first, timeout = 3500) {
  const socket = net.connect(paths.sock)
  try {
    await new Promise((r, reject) => { socket.once('connect', r); socket.once('error', reject) })
    const answer = new Promise((r, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('wire frame deadline')), timeout)
      socket.on('data', (bytes) => { buffer += bytes; if (buffer.includes('\n')) { clearTimeout(timer); r(JSON.parse(buffer.split('\n')[0])) } })
      socket.once('error', (e) => { clearTimeout(timer); reject(e) })
    })
    if (first !== undefined) socket.write(typeof first === 'string' ? first : JSON.stringify(first) + '\n')
    return await answer
  } finally { socket.destroy() }
}
try {
  daemon = launch()
  await ready()
  client = await connectClient(paths)
  const initialToken = readFileSync(paths.token, 'utf8')
  await check('actual TypeScript client hello and status', async () => {
    const status = await client.request('daemon.status')
    assert.equal(status.protocol, 1)
    assert.equal(status.pid, daemon.child.pid)
    assert.equal(status.home, realpathSync(home))
    assert.deepEqual(status.capabilities.supportedMethods, ['agent.archive', 'agent.read', 'agent.rename', 'agent.seen', 'agent.tree', 'daemon.status', 'daemon.stop', 'events.emit', 'events.get', 'events.history', 'events.snapshot', 'events.subscribe', 'events.tail', 'events.unsubscribe', 'memory.add', 'memory.catalog', 'memory.context.bind', 'memory.context.issue', 'memory.context.revoke', 'memory.context.status', 'memory.forget', 'memory.get', 'memory.history', 'memory.list', 'memory.search', 'memory.update', 'protocol.catalog'])
    assert.equal(status.lastEventId, 0)
  })
  await check('private runtime paths', async () => {
    assert.equal(statSync(home).mode & 0o777, 0o700)
    assert.equal(statSync(paths.run).mode & 0o777, 0o700)
    for (const path of [paths.token, paths.sock, paths.lock]) assert.equal(statSync(path).mode & 0o777, 0o600)
  })
  await check('bad and scoped credentials fail closed', async () => {
    for (const credentials of [{ token: 'wrong' }, { token: initialToken, ask: 'scope' }, { runtime: 'scope' }]) {
      assert.equal((await frame({ type: 'hello', protocol: 1, client: 'cli', ...credentials })).code, 'bad_token')
    }
  })
  await check('protocol errors and deadline', async () => {
    assert.equal((await frame({ id: 1, method: 'daemon.status' })).code, 'handshake_required')
    assert.equal((await frame({ type: 'hello', protocol: 99, token: initialToken })).code, 'bad_protocol')
    assert.equal((await frame('{broken\n')).code, 'bad_json')
    assert.equal((await frame('null\n')).code, 'bad_json')
    assert.equal((await frame({ type: 'hello', protocol: 99, token: 'wrong' })).code, 'bad_token')
    assert.equal((await frame({ type: 'hello', token: initialToken })).type, 'hello_ok')
    assert.equal((await frame()).code, 'handshake_timeout')
    assert.equal((await frame('x'.repeat(1024 * 1024 + 1))).code, 'line_too_long')
  })
  await check('catalog and unavailable methods', async () => {
    const catalog = await client.request('protocol.catalog')
    assert.equal(catalog.protocolVersion, 1)
    const status = await client.request('daemon.status')
    assert.deepEqual(catalog.methods.filter((m) => m.rust === 'implemented').map((m) => m.name).sort(), [...status.capabilities.supportedMethods].sort())
    assert.ok(catalog.methods.some((m) => m.name === 'agent.start' && m.rust === 'unported'))
    await assert.rejects(client.request('agent.start', { name: 'must-not-start' }), (e) => e.code === 'not_implemented')
    await assert.rejects(client.request('invented.action'), (e) => e.code === 'not_found')
  })
  await check('second owner cannot rotate credentials', async () => {
    const second = launch()
    const result = await second.exited
    assert.notEqual(result.code, 0)
    assert.equal(readFileSync(paths.token, 'utf8'), initialToken)
  })
  async function stalledReader(token) {
    const socket = net.connect(paths.sock)
    socket.on('error', () => {})
    await new Promise((r, reject) => { socket.once('connect', r); socket.once('error', reject) })
    const hello = new Promise((r) => socket.once('data', (bytes) => r(JSON.parse(bytes.toString().trim()))))
    socket.write(JSON.stringify({ type: 'hello', protocol: 1, client: 'cli', token }) + '\n')
    assert.equal((await hello).type, 'hello_ok')
    socket.pause()
    socket.write(Array.from({ length: 200 }, (_, id) => JSON.stringify({ id, method: 'protocol.catalog' }) + '\n').join(''))
    return socket
  }
  await check('slow authenticated reader cannot block another client', async () => {
    const stalled = await stalledReader(initialToken)
    try {
      const status = await client.request('daemon.status', {}, { timeoutMs: 2000 })
      assert.equal(status.pid, daemon.child.pid)
    } finally { stalled.destroy() }
  })
  await check('crash restart reclaims socket and rotates token', async () => {
    client.close()
    daemon.child.kill('SIGKILL')
    await daemon.exited
    daemon = launch()
    await ready()
    // Existing artifacts can precede startup; connect retries until new token is published.
    const deadline = Date.now() + 5000
    while (readFileSync(paths.token, 'utf8') === initialToken) { assert.ok(Date.now() < deadline); await pause(10) }
    client = await connectClient(paths)
    assert.equal((await frame({ type: 'hello', protocol: 1, token: initialToken })).code, 'bad_token')
  })
  await check('authenticated stop responds before closing and cleans ownership', async () => {
    const stalled = await stalledReader(readFileSync(paths.token, 'utf8'))
    try {
      // Let catalog responses fill the kernel send buffer; keep the reader paused through exit.
      await pause(100)
      assert.deepEqual(await client.request('daemon.stop'), { stopping: true })
      let timer
      try {
        const exit = await Promise.race([daemon.exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('stop blocked by stalled writer')), 3000)
        })])
        assert.equal(exit.code, 0)
      } finally { clearTimeout(timer) }
    } finally { stalled.destroy() }
    assert.equal(existsSync(paths.sock), false)
    assert.equal(existsSync(paths.lock), false)
    assert.equal(existsSync(paths.token), false)
  })
  await check('live legacy Node lock is preserved', async () => {
    writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, started: execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() }), { mode: 0o600 })
    const candidate = launch()
    assert.notEqual((await candidate.exited).code, 0)
    assert.equal(JSON.parse(readFileSync(paths.lock)).pid, process.pid)
    rmSync(paths.lock)
  })
  await check('symlink home and public home are rejected without changing files', async () => {
    const linked = join(scratch, 'linked')
    symlinkSync(home, linked)
    assert.notEqual((await launch(linked).exited).code, 0)
    const publicHome = join(scratch, 'public')
    mkdirSync(publicHome, { mode: 0o755 })
    assert.notEqual((await launch(publicHome).exited).code, 0)
    assert.equal(statSync(publicHome).mode & 0o777, 0o755)
  })
  await check('bare PID belonging to unrelated process can be reclaimed', async () => {
    const sleeper = spawn('/bin/sleep', ['30'])
    const ended = new Promise((r) => sleeper.once('exit', r))
    try {
      writeFileSync(paths.lock, String(sleeper.pid), { mode: 0o600 })
      daemon = launch()
      await ready()
      client = await connectClient(paths)
      await client.request('daemon.stop')
      assert.equal((await daemon.exited).code, 0)
    } finally { sleeper.kill('SIGTERM'); await ended }
  })
  await check('refusing live endpoint preserves its token and socket', async () => {
    writeFileSync(paths.token, 'old-endpoint-token', { mode: 0o600 })
    const server = net.createServer((socket) => socket.destroy())
    await new Promise((r, reject) => { server.once('error', reject); server.listen(paths.sock, r) })
    try {
      const candidate = launch()
      assert.notEqual((await candidate.exited).code, 0)
      assert.equal(readFileSync(paths.token, 'utf8'), 'old-endpoint-token')
      assert.equal(statSync(paths.sock).isSocket(), true)
    } finally { await new Promise((r) => server.close(r)) }
  })
  await check('nonregular runtime files are refused without opening them', async () => {
    for (const [index, name] of ['pultd.lock', 'token', 'rust-owner.guard'].entries()) {
      const testHome = join(scratch, `f${index}`)
      mkdirSync(join(testHome, 'run'), { recursive: true, mode: 0o700 })
      const fifo = join(testHome, 'run', name)
      execFileSync('mkfifo', [fifo])
      const candidate = launch(testHome)
      const result = await Promise.race([candidate.exited, pause(1500).then(() => { candidate.child.kill('SIGKILL'); throw new Error('blocked opening FIFO') })])
      assert.notEqual(result.code, 0)
      assert.match(candidate.stderr, /runtime files must be regular files/)
      assert.equal(statSync(fifo).isFIFO(), true)
    }
  })
  await check('Rust client refuses mismatched or missing responses', async () => {
    for (const response of [{ id: 999, result: {} }, {}, { id: 1, result: {}, error: {} }]) {
      const server = net.createServer((socket) => {
        let buffer = ''
        let first = true
        socket.on('error', () => {})
        socket.on('data', (bytes) => {
          buffer += bytes
          while (buffer.includes('\n')) {
            buffer = buffer.slice(buffer.indexOf('\n') + 1)
            socket.write(JSON.stringify(first ? { type: 'hello_ok', protocol: 1 } : response) + '\n')
            first = false
          }
        })
      })
      await new Promise((r, reject) => { server.once('error', reject); server.listen(paths.sock, r) })
      try {
        const child = spawn(binary, ['--home', home, 'daemon', 'status'], { stdio: 'ignore' })
        const code = await new Promise((r) => child.once('exit', r))
        assert.notEqual(code, 0)
      } finally { await new Promise((r) => server.close(r)) }
    }
  })
  console.log(`interop passed ${passed}`)
} finally {
  client?.close()
  if (daemon?.child.exitCode === null && daemon.child.signalCode === null) {
    daemon.child.kill('SIGTERM')
    const timer = setTimeout(() => daemon.child.kill('SIGKILL'), 3000)
    await daemon.exited
    clearTimeout(timer)
  }
  rmSync(scratch, { recursive: true, force: true })
}
