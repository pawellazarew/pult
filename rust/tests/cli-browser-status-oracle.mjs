// Actual public cmdBrowser with private files/socket and a discovery preload.
// Optional Rust comparison never launches Chrome or any provider subprocess.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, writeFile, rm, readdir, rename, symlink } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = join(root, 'dist/cli/main.js')
await access(entry)
const rust = process.argv[2]
const version = '0.0.84', token = 'a'.repeat(64)
const scenarios = [
  { name: 'opaque package key', expectedInstalled: true, package: JSON.stringify({version, ['\ud800']: 1}) },
  { name: 'opaque daemon status key', package: null, online: true, statusExtra: { ['\ud800']: 1 }, browser: { state: 'installed', sessions: 1 } },
  { name: 'opaque browser key', package: null, online: true, browser: { state: 'installed', sessions: 1, ['\udfff']: 2 } },
  { name: 'missing offline', package: null },
  { name: 'installed offline with Chrome', package: version, chrome: true },
  { name: 'wrong disk pin', package: '0.0.83' },
  { name: 'cli file missing', package: version, noCli: true },
  { name: 'malformed disk package', package: '{not-json' },
  { name: 'online installed overrides disk', package: null, online: true, browser: { state: 'installed', sessions: 1 } },
  { name: 'online installing', package: null, online: true, browser: { state: 'installing', sessions: 0 } },
  { name: 'online failure first line', package: null, online: true, browser: { state: 'failed', error: 'controlled first line\nnot displayed in text', sessions: 1 }, chrome: true },
  { name: 'unknown daemon state overrides installed disk', package: version, online: true, browser: { state: 'future-state', sessions: 2, future: { lone: '\ud800', values: ['\udfff', 7] } } },
  { name: 'old daemon without browser', package: version, online: true },
  { name: 'numeric zero daemon browser uses disk fallback', package: version, online: true, browser: 0, browserRaw: '0e0', textOnly: true },
]
async function setup(scenario, layout = true) {
  const scratch = await mkdtemp('/tmp/r4b-'), home = join(scratch, 'pult'), user = join(scratch, 'user')
  await mkdir(home, { mode: 0o700 }); await mkdir(user, { mode: 0o700 })
  if (layout) for (const dir of ['run', 'events', 'logs']) await mkdir(join(home, dir), { mode: 0o700 })
  await writeFile(join(home, '.rust-core-scratch'), 'pult-rust-scratch-v1\n', { mode: 0o600 })
  const browserHome = join(home, 'fake-chrome-home'), chrome = join(browserHome, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  if (scenario.chrome) { await mkdir(dirname(chrome), { recursive: true, mode: 0o700 }); await writeFile(chrome, 'must not execute', { mode: 0o700 }) }
  const prefix = join(home, 'mcp', 'playwright-mcp-' + version)
  if (scenario.package !== null) {
    const pkg = join(prefix, 'node_modules/@playwright/mcp'); await mkdir(pkg, { recursive: true, mode: 0o700 })
    await writeFile(join(pkg, 'package.json'), scenario.package.startsWith('{') ? scenario.package : JSON.stringify({ version: scenario.package }), { mode: 0o600 })
    if (!scenario.noCli) await writeFile(join(pkg, 'cli.js'), 'must not execute', { mode: 0o600 })
  }
  return { scratch, home, user, browserHome, chrome, prefix }
}
async function run(kind, scenario, locale, json, fixture) {
  const { scratch, home, user, browserHome, chrome, prefix } = fixture
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PULT_') && key !== 'NODE_OPTIONS'))
  Object.assign(env, { HOME: user, PULT_HOME: kind === 'node' ? home : join(scratch, 'protected'), PULT_LANG: locale, PULT_TEST: '1', PULT_TEST_BROWSER_HOME: browserHome })
  if (scenario.chrome) env.PULT_TEST_BROWSER_CHROME_FILE = chrome
  let server, error; const sockets = new Set(), requests = []
  if (scenario.online) {
    await writeFile(join(home, 'run/token'), token, { mode: 0o600 })
    server = net.createServer(socket => {
      sockets.add(socket); let buffer = ''
      socket.on('error', () => {})
      socket.on('data', chunk => { try {
        buffer += chunk; assert.ok(Buffer.byteLength(buffer) < 1024 * 1024)
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n'), frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
          if (frame.type === 'hello') { assert.equal(frame.token, token); socket.write('{"type":"hello_ok","protocol":1}\n') }
          else {
            requests.push(frame); assert.equal(requests.length, 1); assert.equal(frame.method, 'daemon.status'); assert.deepEqual(frame.params, kind === 'node' ? undefined : {}); assert.equal(frame.locale, locale)
            const wire = JSON.stringify({ id: frame.id, result: { ...scenario.statusExtra, ...(scenario.browser === undefined ? {} : { browser: scenario.browser }), unrelated: { retainedByDaemon: true } } })
            socket.write((scenario.browserRaw ? wire.replace('"browser":0', '"browser":' + scenario.browserRaw) : wire) + '\n')
          }
        }
      } catch (e) { error ??= e; socket.destroy() } })
    })
    await new Promise(resolve => server.listen(join(home, 'run/pultd.sock'), resolve))
  }
  let child, timer
  try {
    const base = kind === 'node' ? ['--import', join(root, 'rust/tests/fixtures/browser_status_preload.mjs'), entry] : ['--home', home]
    const args = [...base, 'browser', ...(scenario.alias ? [] : ['status']), ...(json ? ['--json'] : [])]
    child = spawn(kind === 'node' ? process.execPath : rust, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []; let size = 0
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', b => { size += b.length; assert.ok(size < 2 * 1024 * 1024); chunks.push(b) })
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) }); timer = setTimeout(() => child.kill('SIGKILL'), 8000) })
    assert.equal(status.signal, null); assert.equal(status.code, 0); assert.ifError(error); assert.equal(requests.length, scenario.online ? 1 : 0)
    const result = { code: status.code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }; assert.equal(result.stderr, '')
    if (json) assert.deepEqual(JSON.parse(result.stdout), { installed: scenario.expectedInstalled ?? (scenario.package === version && !scenario.noCli), version, path: prefix, chrome: scenario.chrome ? chrome : null, daemon: scenario.browser ?? null })
    else { const lines = result.stdout.trimEnd().split('\n'); assert.equal(lines.length, 2); assert.ok(lines[0].startsWith(`[${scenario.browser?.state === 'failed' || (!['installed','installing'].includes(scenario.browser?.state) && scenario.browser?.sessions > 0) ? 'warn' : 'ok  '}] ${locale === 'ru' ? 'Браузер агента' : 'Agent browser'}:`)); assert.ok(lines[1].includes(locale === 'ru' ? 'Chrome для браузера агента' : 'Chrome for agent browser')) }
    return result
  } finally {
    clearTimeout(timer)
    if (child?.exitCode === null && child?.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)) }
    for (const socket of sockets) socket.destroy()
    if (server) await new Promise(resolve => server.close(resolve))
  }
}
let count = 0
for (const scenario of scenarios) {
  const fixture = await setup(scenario)
  try { for (const locale of ['en', 'ru']) for (const json of scenario.textOnly ? [false] : [false, true]) {
    const node = await run('node', scenario, locale, json, fixture)
    if (rust) assert.deepEqual(await run('rust', scenario, locale, json, fixture), node, scenario.name)
    count++
  } } finally { await rm(fixture.scratch, { recursive: true, force: true }) }
}
// Historical side effect is explicit; Rust status intentionally creates no
// layout. Separate homes prevent Node from preparing paths for the Rust case.
for (const kind of rust ? ['node', 'rust'] : ['node']) {
  const fixture = await setup({ package: null }, false)
  try {
    assert.deepEqual((await readdir(fixture.home)).sort(), ['.rust-core-scratch'])
    await run(kind, { package: null, alias: true }, 'en', true, fixture)
    assert.deepEqual((await readdir(fixture.home)).sort(), kind === 'node' ? ['.rust-core-scratch', 'events', 'logs', 'run'] : ['.rust-core-scratch'])
  } finally { await rm(fixture.scratch, { recursive: true, force: true }) }
}
// Production executable metadata follows a legitimate Chrome symlink. The
// public Node oracle records that candidate independently; Rust's production
// metadata helper has a matching actual-filesystem unit test. The deliberately
// strict PULT_TEST fake-file seam is not presented as production discovery.
{
  const scenario = { package: null, chrome: true }
  const fixture = await setup(scenario)
  try {
    await rename(fixture.chrome, fixture.chrome + '-real')
    await symlink(fixture.chrome + '-real', fixture.chrome)
    for (const locale of ['en', 'ru']) for (const json of [false, true]) await run('node', scenario, locale, json, fixture)
  } finally { await rm(fixture.scratch, { recursive: true, force: true }) }
}
console.log(`browser status oracle: ${count} ${rust ? 'paired Node/Rust' : 'Node-only'} cases + explicit layout profile + 4 Node production Chrome symlink observations`)
