// Actual public Node cmdAgent oracle and optional Rust CLI comparison. No
// daemon/provider process is launched: child CLI subprocesses are guarded.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = join(root, 'dist/cli/main.js')
const preload = join(root, 'rust/tests/fixtures/deny_cli_subprocess.mjs')
await access(entry) // npm ci --ignore-scripts + tsc required; never silently skip.
const rust = process.argv[2]
const bound = 8000
const token = 'a'.repeat(64)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function run(kind, scenario) {
  const scratch = await mkdtemp('/tmp/r4p-')
  const home = join(scratch, 'pult')
  const user = join(scratch, 'user')
  await mkdir(home, { mode: 0o700 })
  await mkdir(join(home, 'run'), { mode: 0o700 })
  await mkdir(user, { mode: 0o700 })
  await writeFile(join(home, 'run/token'), token, { mode: 0o600 })
  const sockets = new Set()
  const requests = []
  let connections = 0
  let peerError
  const server = net.createServer(socket => {
    sockets.add(socket)
    connections++
    let buffer = ''
    socket.on('error', error => { peerError ??= error })
    socket.on('data', chunk => {
      try {
        buffer += chunk.toString()
        assert.ok(Buffer.byteLength(buffer) <= 1024 * 1024)
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n')
          const frame = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          if (frame.type === 'hello') {
            assert.equal(frame.protocol, 1)
            assert.equal(frame.token, token)
            socket.write(JSON.stringify({ type: 'hello_ok', protocol: 1, daemon: { version: 'fixture', pid: 1, startedAt: 'fixture' } }) + '\n')
          } else {
            requests.push(frame)
            assert.equal(requests.length, 1, 'no wait, cancel, reconnect or retry')
            assert.equal(frame.method, 'agent.prompt')
            assert.equal(frame.locale, scenario.locale)
            assert.deepEqual(frame.params, scenario.params)
            socket.write(JSON.stringify({ id: frame.id, ...scenario.reply }) + '\n')
          }
        }
      } catch (error) { peerError ??= error; socket.destroy() }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(join(home, 'run/pultd.sock'), resolve)
  })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PULT_') && key !== 'NODE_OPTIONS'))
  // Node resolves its socket from PULT_HOME. Rust deliberately rejects --home
  // equal to the protected PULT_HOME; keep that production path separate, but
  // still entirely inside this fixture's private scratch tree.
  Object.assign(env, { HOME: user, PULT_HOME: kind === 'node' ? home : join(scratch, 'protected'), PULT_LANG: scenario.locale })
  const args = kind === 'node'
    ? ['--import', preload, entry, ...scenario.args]
    : ['--home', home, ...scenario.args]
  let child, timer
  try {
    child = spawn(kind === 'node' ? process.execPath : rust, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    let bytes = 0
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) child.kill('SIGKILL')
        else chunks.push(chunk)
      })
    }
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
      timer = setTimeout(() => { child.kill('SIGKILL') }, bound)
    })
    const status = await completion
    assert.equal(status.signal, null, `${kind} watchdog/signal`)
    assert.ifError(peerError)
    assert.equal(connections, 1, `${kind} ${scenario.name}: code=${status.code}; ${Buffer.concat(stderr).toString()}`)
    assert.equal(requests.length, 1)
    const result = { code: status.code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }
    assert.deepEqual(result, scenario.expected, `${kind} ${scenario.name}`)
    return result
  } finally {
    clearTimeout(timer)
    if (child?.exitCode === null && child?.signalCode === null) {
      child.kill('SIGKILL')
      await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(2000)])
    }
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await rm(scratch, { recursive: true, force: true })
  }
}

const cases = []
for (const locale of ['en', 'ru']) {
  for (const json of [false, true]) {
    cases.push({
      name: `started ${locale} json=${json}`, locale,
      args: ['agent', 'prompt', 'chat', 'hello', 'world', ...(json ? ['--json'] : [])],
      params: { name: 'chat', text: 'hello world' }, reply: { result: { turnId: 'turn-A', extra: 'discarded' } },
      expected: { code: 0, stdout: json ? '{"turnId":"turn-A","waiting":false}\n' : locale === 'ru' ? 'ход turn-A запущен\n' : 'Turn turn-A started\n', stderr: '' },
    })
    cases.push({
      name: `queued ${locale} json=${json}`, locale,
      args: ['session', 'prompt', 'chat', 'hello', '--queue', '--wait', ...(json ? ['--json'] : [])],
      params: { name: 'chat', text: 'hello', queue: true }, reply: { result: { queued: true, id: 'queue-A', extra: 'kept' } },
      expected: { code: 0, stdout: json ? '{"queued":true,"id":"queue-A","extra":"kept"}\n' : locale === 'ru' ? 'реплика в очереди (queue-A): уйдёт, когда ход chat кончится\n' : 'Message queued (queue-A): will send when turn chat ends\n', stderr: '' },
    })
  }
}
cases.push({
  name: 'literal words after --', locale: 'en', args: ['agent', 'prompt', 'chat', 'hello', '--', '--queue', 'second'],
  params: { name: 'chat', text: 'hello --queue second' }, reply: { result: { turnId: 'turn-A' } },
  expected: { code: 0, stdout: 'Turn turn-A started\n', stderr: '' },
})
for (const [code, exit] of [['timeout', 2], ['blocked_network', 4], ['provider_unavailable', 5], ['limited', 5], ['not_found', 1]]) {
  cases.push({
    name: `typed error ${code}`, locale: 'en', args: ['agent', 'prompt', 'chat', 'hello', '--json'],
    params: { name: 'chat', text: 'hello' }, reply: { error: { code, message: 'controlled reason' } },
    expected: { code: exit, stdout: '', stderr: `pult agent: ${code} — controlled reason\n` },
  })
}
for (const scenario of cases) {
  const node = await run('node', scenario)
  if (rust) assert.deepEqual(await run('rust', scenario), node)
}
// Record exact incidental Node behavior independently of Rust's deliberate
// malformed-ACK rejection; this must not become a fabricated start in Rust.
await run('node', {
  name: 'incidental missing native turnId', locale: 'en', args: ['agent', 'prompt', 'chat', 'hello', '--json'],
  params: { name: 'chat', text: 'hello' }, reply: { result: {} },
  expected: { code: 0, stdout: '{"waiting":false}\n', stderr: '' },
})
console.log(`prompt oracle passed ${cases.length} ${rust ? 'paired Node/Rust' : 'Node-only'} cases + malformed Node observation`)
