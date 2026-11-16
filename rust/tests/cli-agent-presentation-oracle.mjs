// Actual public Node CLI vs Rust, using only a private owner socket. No provider.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = join(root, 'dist/cli/main.js')
await access(entry)
const rust = process.argv[2]
const token = 'a'.repeat(64)
const extra = { future: { lone: '\ud800', nested: [1, null, '🙂'] } }
const record = (values = {}) => ({ name: 'one', provider: 'claude', lastStatus: 'idle', mode: 'turn', approval: 'ask', ...values })
const context = values => ({ at: 'fixture', model: 'fixture', ...values })
const rows = [
  record({ name: '🙂e\u0301', provider: 'codex', lastStatus: 'working', mode: 'warm', approval: 'workspace', context: context({ used: 125, window: 1000 }), attention: { id: 9, kind: 'done' }, lastSeenEventId: 8, pendingPermissions: 2, worktree: { path: '/fixture/a b', branch: 'topic' }, title: 'Задача' }),
  record({ name: 'name-longer-than-16', lastStatus: 'status-longer-than-19-characters', approval: 'read-only', context: context({ used: 1500, window: null }), title: '', archived: true }),
]
const edgeRows = [
  ...['done', 'failed', 'ask', 'limit', 'blocked', 'stalled', 'unknown'].map((kind, i) => record({ name: `att-${kind}`, attention: { id: 10, kind }, lastSeenEventId: i % 2 ? 10 : 9 })),
  ...[null, {}, context({ used: 0, window: 100 }), context({ used: 250, window: 1000 }), context({ used: 1001, window: 1000 }), context({ used: 1499, window: 0 }), context({ used: 1500, window: -1 }), context({ used: -1, window: 100 }), context({ used: 1.5, window: 0.49 }), { used: 1, window: 2 }].map((context, i) => record({ name: `ctx-${i}`, context })),
  ...['ask', 'full', 'inherit', 'workspace', 'read-only', 'future', null].map((approval, i) => record({ name: `approval-${i}`, approval })),
  record({ name: 'manual-unread', markedUnread: true, lastSeenEventId: 999 }),
  record({ name: 'negative-att', attention: { id: -1, kind: 'done' }, lastSeenEventId: -2 }),
  record({ name: 'unsafe-att', attention: { id: 2 ** 53, kind: 'done' } }),
  record({ name: 'numeric-seen', attention: { id: 10, kind: 'done' }, lastSeenEventId: '99' }),
  record({ name: 'pending-string', pendingPermissions: '2' }),
  record({ name: 'pending-zero', pendingPermissions: 0 }),
  ...['0x2', '0b10', '0o2', 'Infinity', '+Infinity', 'inf', '', '  ', '-0x2'].map((pendingPermissions, i) => record({ name: `number-${i}`, pendingPermissions })),
  record({ name: 'pending-array', pendingPermissions: ['3'] }),
  record({ name: 'pending-object', pendingPermissions: {} }),
  record({ name: 'ctx-round-near-half', context: context({ used: 1.4999999999999998, window: 1 }) }),
  record({ name: 'ctx-round-half', context: context({ used: 0.5, window: 0.5 }) }),
  record({ name: 'lone-\ud800', title: '🙂\udfff', worktree: { path: '/fixture/🙂', branch: 'e\u0301' } }),
  record({ name: null, provider: 7, lastStatus: true, mode: ['a', null, ['b']], pendingPermissions: true }),
  record({ name: ['x', null, 2], provider: {}, lastStatus: null, mode: false }),
  { title: 'missing-fields', ...extra },
]
const cases = [
  { name: 'utf16-key-error', args: ['list'], method: 'agent.list', opaqueEnvelope: true, error: { code: 'limited', message: 'Controlled error', ['\ud800']: 1 } },
  { name: 'utf16-key-top', args: ['list'], method: 'agent.list', result: { sessions: [record()], ['\ud800']: 1 } },
  { name: 'utf16-key-row', args: ['list'], method: 'agent.list', result: { sessions: [record({ ['\ud800']: 1 })] } },
  { name: 'utf16-key-metadata', opaqueEnvelope: true, args: ['list'], method: 'agent.list', result: { sessions: [record({ context: context({ used: 125, window: 1000, ['\ud800']: 1 }), attention: { kind: 'done', id: 9, ['\ud800']: 1 }, lastSeenEventId: 8, worktree: { path: '/fixture/a b', branch: 'topic', ['\udfff']: 2 } })] } },
  { name: 'empty', args: ['list'], method: 'agent.list', result: { sessions: [], ...extra } },
  { name: 'basic', args: ['list'], method: 'agent.list', result: { sessions: [record()], ...extra } },
  { name: 'decorated', args: ['list'], method: 'agent.list', result: { sessions: rows, ...extra } },
  { name: 'edges', args: ['list'], method: 'agent.list', result: { sessions: edgeRows, ...extra } },
  { name: 'rename-words', args: ['rename', 'one', 'New', 'title'], method: 'agent.rename', params: { name: 'one', title: 'New title' }, result: { name: 'one', title: 'New title', ...extra } },
  { name: 'rename-remove', args: ['rename', 'one'], method: 'agent.rename', params: { name: 'one', title: '' }, result: { name: 'one', ...extra } },
  { name: 'rename-empty', args: ['rename', 'one', '--title='], method: 'agent.rename', params: { name: 'one', title: '' }, result: { name: 'one', ...extra } },
  { name: 'rename-dash', args: ['rename', 'one', '--title=-🙂'], method: 'agent.rename', params: { name: 'one', title: '-🙂' }, result: { name: 'one', title: '-🙂', ...extra } },
  { name: 'rename-returned-empty', args: ['rename', 'one', 'empty'], method: 'agent.rename', params: { name: 'one', title: 'empty' }, result: { title: '', ...extra } },
  { name: 'rename-returned-null', args: ['rename', 'one', 'null'], method: 'agent.rename', params: { name: 'one', title: 'null' }, result: { title: null, ...extra } },
  { name: 'archive', args: ['archive', 'one'], method: 'agent.archive', params: { name: 'one', archived: true }, result: { name: 'one', archived: true, ...extra } },
  { name: 'unarchive', args: ['unarchive', 'one'], method: 'agent.archive', params: { name: 'one', archived: false }, result: { name: 'one', archived: false, ...extra } },
  { name: 'seen', args: ['seen', 'one'], method: 'agent.seen', params: { name: 'one', unread: false }, result: { name: 'one', lastSeenEventId: 12, ...extra } },
  { name: 'unread', args: ['seen', 'one', '--unread'], method: 'agent.seen', params: { name: 'one', unread: true }, result: { name: 'one', markedUnread: true, ...extra } },
  { name: 'stop', args: ['stop', 'one'], method: 'agent.stop', params: { name: 'one' }, result: { stopped: false, ...extra } },
  ...['timeout', 'blocked_network', 'provider_unavailable', 'limited', 'not_found'].map(code => ({ name: `error-${code}`, args: ['list'], method: 'agent.list', error: { code, message: 'Controlled error' } })),
]
const errorExit = code => ({ timeout: 2, blocked_network: 4, provider_unavailable: 5, limited: 5 })[code] ?? 1

async function run(kind, scenario, locale, json, alias, scratch) {
  const home = join(scratch, 'home')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PULT_') && !key.startsWith('FAKE_') && !key.endsWith('_API_KEY') && key !== 'NODE_OPTIONS'))
  Object.assign(env, { HOME: join(scratch, 'user'), PULT_HOME: kind === 'node' ? home : join(scratch, 'protected'), PULT_LANG: locale, PULT_TEST: '1' })
  const sockets = new Set(), requests = []
  let peerError
  let phase = 'waiting-for-client'
  const server = net.createServer(socket => {
    phase = 'connected'
    sockets.add(socket); socket.on('error', () => {})
    let buffer = ''
    socket.on('data', bytes => { try {
      buffer += bytes
      assert.ok(Buffer.byteLength(buffer) <= 1024 * 1024)
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        if (frame.type === 'hello') {
          phase = 'hello-received'
          assert.equal(frame.token, token)
          socket.write(JSON.stringify({ ...(scenario.opaqueEnvelope ? { ['\udfff']: 1 } : {}), type: 'hello_ok', protocol: 1, daemon: { version: 'fixture', pid: 1, startedAt: 'fixture' } }) + '\n')
        } else {
          phase = 'request-received'
          requests.push(frame)
          assert.equal(requests.length, 1, 'no retry or extra diagnostic/mutation RPC')
          assert.equal(frame.method, scenario.method); assert.equal(frame.locale, locale)
          assert.deepEqual(frame.params, scenario.params ?? (kind === 'node' ? undefined : {}))
          socket.write(JSON.stringify({ ...(scenario.opaqueEnvelope ? { ['\udfff']: 1 } : {}), id: frame.id, ...(scenario.error ? { error: scenario.error } : { result: scenario.result }) }) + '\n')
          phase = 'response-enqueued'
        }
      }
    } catch (e) { peerError ??= e; socket.destroy() } })
  })
  await new Promise(resolve => server.listen(join(home, 'run/pultd.sock'), resolve))
  let child, timer
  try {
    const args = kind === 'node' ? ['--import', join(root, 'rust/tests/fixtures/agent_presentation_preload.mjs'), entry] : ['--home', home]
    child = spawn(kind === 'node' ? process.execPath : rust, [...args, alias, ...scenario.args, ...(json ? ['--json'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []; let bytes = 0
    for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', b => { bytes += b.length; assert.ok(bytes <= 2 * 1024 * 1024); target.push(b) })
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
      timer = setTimeout(() => {
        const size = chunks => chunks.reduce((total, chunk) => total + chunk.length, 0)
        process.stderr.write(JSON.stringify({ oracleWatchdog: {
          kind, scenario: scenario.name, locale, json, alias, phase,
          requests: requests.length, stdoutBytes: size(stdout), stderrBytes: size(stderr),
          peerError: Boolean(peerError),
        } }) + '\n')
        child.kill('SIGKILL')
      }, 8000)
    })
    assert.equal(status.signal, null, `${kind} watchdog ${scenario.name}`); assert.ifError(peerError)
    assert.equal(requests.length, 1)
    const result = { code: status.code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }
    assert.equal(result.code, scenario.error ? errorExit(scenario.error.code) : 0)
    if (scenario.error) assert.equal(result.stderr, `pult agent: ${scenario.error.code} — Controlled error\n`)
    else {
      assert.equal(result.stderr, '')
      if (json) assert.deepEqual(JSON.parse(result.stdout), scenario.method === 'agent.stop' ? { stopped: true } : scenario.result)
      if (!json && scenario.name === 'empty') assert.equal(result.stdout, locale === 'ru' ? 'агентов нет\n' : 'No agents\n')
      if (!json && scenario.name === 'basic') assert.equal(result.stdout, `${'one'.padEnd(16)} · ${'claude'.padEnd(7)} ${'idle'.padEnd(19)} turn\n`)
    }
    return result
  } finally {
    clearTimeout(timer)
    if (child?.exitCode === null && child?.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)) }
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
let count = 0
for (const scenario of cases) {
  const scratch = await mkdtemp('/tmp/r4agent-')
  try {
    for (const dir of ['home', 'home/run', 'user']) await mkdir(join(scratch, dir), { mode: 0o700 })
    for (const [name, body] of [['home/.rust-core-scratch', 'pult-rust-scratch-v1\n'], ['home/config.json', '{}'], ['home/run/token', token]]) await writeFile(join(scratch, name), body, { mode: 0o600 })
    for (const locale of ['ru', 'en']) for (const json of [false, true]) {
      const alias = count % 2 ? 'session' : 'agent'
      const node = await run('node', scenario, locale, json, alias, scratch)
      if (rust) assert.deepEqual(await run('rust', scenario, locale, json, alias, scratch), node, `${scenario.name}/${locale}/${json}`)
      count++
    }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
console.log(`agent presentation oracle: ${count} ${rust ? 'paired Node/Rust' : 'Node-only'} cases`)
