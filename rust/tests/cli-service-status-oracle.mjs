// Actual public Node cmdDaemonStatus, optionally paired with Rust. Only fake
// sockets/managers and private scratch homes; no system manager or provider.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = join(root, 'dist/cli/main.js')
await access(entry)
const rust = process.argv[2]
const token = 'a'.repeat(64)
const fixture = name => readFile(join(root, 'test/fixtures/service', name), 'utf8')
const base = { version: 'fixture', pid: 321, protocol: 1, uptimeMs: 1500, home: 'fixture-home', clients: 2, subscriptions: 3, lastEventId: 9 }
const cases = [
  { name: 'absent service and daemon', platform: 'darwin', online: false },
  { name: 'absent service online', platform: 'darwin', online: true },
  { name: 'foreign service', platform: 'darwin', online: true, service: 'foreign' },
  { name: 'running', platform: 'darwin', online: true, service: 'own', stdout: await fixture('launchctl-print-running.txt'), state: { loaded: true, running: true, pid: 24594, lastExitCode: null, lastSignal: null } },
  { name: 'killed', platform: 'darwin', online: false, service: 'own', stdout: await fixture('launchctl-print-after-kill.txt'), state: { loaded: true, running: false, pid: null, lastExitCode: null, lastSignal: { name: 'Killed', num: 9 } } },
  { name: 'derived 78', platform: 'darwin', online: true, service: 'own', stdout: await fixture('launchctl-print-exited-78.txt'), state: { loaded: true, running: false, pid: null, lastExitCode: 78, lastSignal: null } },
  { name: 'missing', platform: 'darwin', online: true, service: 'own', status: 113, stderr: 'Bad request.\n', state: { loaded: false, running: false, pid: null } },
  { name: 'linux running', platform: 'linux', online: true, service: 'own', stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=71\nExecMainPID=71\nExecMainCode=1\nExecMainStatus=0\n', state: { loaded: true, running: true, pid: 71, lastExitCode: 0, lastSignal: null } },
  { name: 'linux killed auto-restart', platform: 'linux', online: false, service: 'own', stdout: 'LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\nExecMainPID=72\nExecMainCode=2\nExecMainStatus=9\n', state: { loaded: true, running: false, pid: null, lastExitCode: null, lastSignal: { num: 9, name: '' }, state: 'activating (auto-restart)' } },
  { name: 'explicit opaque stderr profile', platform: 'linux', online: true, service: 'own', status: 7, stderr: 'private-manager-line sk-abcdefghijklmnopqrstuvwxyz\n', delta: true },
]
async function run(kind, scenario, locale, json, scratch) {
  const home = join(scratch, 'pult'), user = join(scratch, 'user'), serviceDir = join(scratch, 'services')
  const calls = join(scratch, 'calls')
  await writeFile(calls, '')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PULT_') && !key.startsWith('FAKE_') && key !== 'NODE_OPTIONS'))
  Object.assign(env, { HOME: user, PULT_HOME: kind === 'node' ? home : join(scratch, 'protected'), PULT_LANG: locale,
    PULT_TEST: '1', PULT_SERVICE_PLATFORM: scenario.platform, PULT_SERVICE_DIR: serviceDir,
    PULT_LAUNCHCTL: join(scratch, 'manager'), PULT_SYSTEMCTL: join(scratch, 'manager'), FAKE_CALLS: calls,
    FAKE_STDOUT: scenario.stdout ?? '', FAKE_STDERR: scenario.stderr ?? '', FAKE_STATUS: String(scenario.status ?? 0),
    ANTHROPIC_API_KEY: 'synthetic-must-not-pass', OPENAI_API_KEY: 'synthetic-must-not-pass' })
  const sockets = new Set(), requests = []
  let peerError
  const server = net.createServer(socket => {
    sockets.add(socket)
    let buffer = ''
    socket.on('error', () => {})
    socket.on('data', bytes => { try {
      buffer += bytes
      assert.ok(Buffer.byteLength(buffer) < 1024 * 1024)
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        if (frame.type === 'hello') {
          assert.equal(frame.token, token)
          socket.write(JSON.stringify({ type: 'hello_ok', protocol: 1, daemon: { version: 'fixture', pid: 1, startedAt: 'fixture' } }) + '\n')
        } else {
          requests.push(frame)
          assert.equal(frame.method, 'daemon.status'); assert.deepEqual(frame.params, kind === 'node' ? undefined : {}); assert.equal(frame.locale, locale)
          assert.equal(requests.length, 1, 'no autostart/retry/extra diagnostic RPC')
          socket.write(JSON.stringify({ id: frame.id, result: base }) + '\n')
        }
      }
    } catch (e) { peerError ??= e; socket.destroy() } })
  })
  if (scenario.online) await new Promise(resolve => server.listen(join(home, 'run/pultd.sock'), resolve))
  let child, timer
  try {
    const args = kind === 'node' ? ['--import', join(root, 'rust/tests/fixtures/service_status_preload.mjs'), entry] : ['--home', home]
    child = spawn(kind === 'node' ? process.execPath : rust, [...args, 'daemon', 'status', ...(json ? ['--json'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []; let bytes = 0
    for (const [stream, out] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', b => { bytes += b.length; assert.ok(bytes <= 2 * 1024 * 1024); out.push(b) })
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
      timer = setTimeout(() => child.kill('SIGKILL'), 8000)
    })
    assert.equal(status.signal, null, `${kind} watchdog`); assert.ifError(peerError)
    assert.equal(requests.length, scenario.online ? 1 : 0)
    const result = { code: status.code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }
    assert.equal(result.code, scenario.online ? 0 : 1); assert.equal(result.stderr, '')
    const recorded = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(recorded.length, scenario.service === 'own' ? 1 : 0)
    for (const call of recorded) {
      assert.equal(call.secret, false)
      assert.deepEqual(call.argv, scenario.platform === 'darwin' ? ['print', `gui/${process.getuid()}/dev.pult.daemon`] : ['--user', 'show', 'pultd.service', '-p', 'LoadState,ActiveState,SubState,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus'])
    }
    if (json) {
      const value = JSON.parse(result.stdout)
      assert.equal(value.running, scenario.online)
      assert.equal(value.service.installed, Boolean(scenario.service))
      assert.equal(value.service.ours, scenario.service === 'own')
      if (scenario.online) for (const [key, expected] of Object.entries(base)) assert.deepEqual(value[key], expected)
      else assert.equal(value.home, home)
      if (scenario.state) for (const [key, expected] of Object.entries(scenario.state)) assert.deepEqual(value.service.manager[key], expected, scenario.name + key)
      if (scenario.delta) {
        const original = 'systemctl --user show pultd.service -p LoadState,ActiveState,SubState,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus: код 7 — private-manager-line sk-abcdefghijklmnopqrstuvwxyz'
        const opaque = 'systemctl --user show pultd.service: код 7 — service manager query failed'
        assert.equal(value.service.error, kind === 'node' ? original : opaque)
        assert.equal(value.service.manager.error, kind === 'node' ? original : opaque)
        assert.equal(value.service.installed, true); assert.equal(value.service.ours, true)
      }
    } else {
      assert.ok(result.stdout.startsWith(scenario.online ? locale === 'en' ? 'pultd fixture · pid 321 · protocol 1 · uptime 2 s\n' : 'pultd fixture · pid 321 · протокол 1 · аптайм 2 с\n' : locale === 'en' ? 'Daemon is not running\n' : 'демон не запущен\n'))
      assert.ok(result.stdout.includes('служба:'), 'legacy RU service line remains under EN')
    }
    return result
  } finally {
    clearTimeout(timer)
    if (child?.exitCode === null && child?.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)) }
    for (const socket of sockets) socket.destroy()
    if (scenario.online) await new Promise(resolve => server.close(resolve))
  }
}
let count = 0
for (const scenario of cases) {
  const scratch = await mkdtemp('/tmp/r4s-')
  try {
    for (const dir of ['pult', 'pult/run', 'user', 'services']) await mkdir(join(scratch, dir), { mode: 0o700 })
    for (const [path, body] of [['pult/.rust-core-scratch', 'pult-rust-scratch-v1\n'], ['pult/config.json', '{}'], ['pult/run/token', token]]) await writeFile(join(scratch, path), body, { mode: 0o600 })
    const home = scenario.service === 'foreign' ? join(scratch, 'foreign') : join(scratch, 'pult')
    const launcher = join(scratch, 'launcher')
    await writeFile(launcher, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    if (scenario.service) await writeFile(join(scratch, 'services', scenario.platform === 'darwin' ? 'dev.pult.daemon.plist' : 'pultd.service'), scenario.platform === 'darwin' ? `<key>PULT_HOME</key><string>${home}</string><key>ProgramArguments</key><array><string>${launcher}</string></array><key>ProcessType</key><string>Standard</string>` : `Environment="PULT_HOME=${home}"\nExecStart="${launcher}"\n`)
    await writeFile(join(scratch, 'manager'), `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify({argv:process.argv.slice(2),secret:Boolean(process.env.ANTHROPIC_API_KEY||process.env.OPENAI_API_KEY||process.env.PULT_ASK_KEY)})+'\\n');process.stdout.write(process.env.FAKE_STDOUT);process.stderr.write(process.env.FAKE_STDERR);process.exit(Number(process.env.FAKE_STATUS));\n`, { mode: 0o700 })
    for (const locale of ['en', 'ru']) for (const json of [false, true]) {
      const node = await run('node', scenario, locale, json, scratch)
      if (rust) {
        let expected = node
        if (scenario.delta) {
          const original = 'systemctl --user show pultd.service -p LoadState,ActiveState,SubState,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus: код 7 — private-manager-line sk-abcdefghijklmnopqrstuvwxyz'
          const opaque = 'systemctl --user show pultd.service: код 7 — service manager query failed'
          assert.ok(node.stdout.includes(original), 'exact original Node diagnostic is observed')
          expected = { ...node, stdout: node.stdout.replaceAll(original, opaque) }
        }
        assert.deepEqual(await run('rust', scenario, locale, json, scratch), expected, scenario.name)
      }
      count++
    }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
console.log(`service status oracle: ${count - 4} exact ${rust ? 'paired Node/Rust' : 'Node-only'} cases + 4 explicit opaque-stderr profile cases`)
