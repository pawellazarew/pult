import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync, chmodSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { Maintenance, installation, providerPlan } from '../../src/maintenance.js'
import type { ProviderInventory } from '../../src/maintenance.js'
import type { LocatedTool } from '../../../src/env/locate.js'
import { execAsync } from '../../../src/env/exec.js'

const tool = (name: LocatedTool['name'], file: string | null, real = file): LocatedTool => ({ name, path: file, realpath: real, version: '1.0', versionExitCode: 0, viaPath: false, triedCount: 1 })
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'pm-'))
  chmodSync(home, 0o700)
  const bin = path.join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const inventory: ProviderInventory = { claude: tool('claude', path.join(bin, 'claude')), codex: tool('codex', path.join(bin, 'codex')), npm: tool('npm', '/usr/bin/npm'), home, pathEntries: [bin, '/usr/bin', '/bin'] }
  const info = { home, packageRoot: '/pult', node: '/node', logs: path.join(home, 'logs'), serviceLog: path.join(home, 'logs/service.log') }
  const env = { HOME: home, PATH: inventory.pathEntries.join(':'), PULT_TEST: '1', CODEX_HOME: '/wrong-codex', CLAUDE_CONFIG_DIR: '/wrong-claude', ANTHROPIC_BASE_URL: 'https://wrong.invalid' }
  return { home, bin, inventory, info, env, close: () => rmSync(home, { recursive: true, force: true }) }
}
const unusedRun = async () => ({ status: 0, stdout: '', stderr: '' })

describe('local provider maintenance', () => {
  it('targets the active Homebrew prefix, formula/cask and npm prefix', () => {
    const f = fixture()
    try {
      f.inventory.codex = tool('codex', '/usr/local/bin/codex', '/usr/local/Cellar/codex/0.1/bin/codex')
      assert.equal(providerPlan('codex', 'update', f.inventory, '/opt/homebrew/bin/brew').command, "'/usr/local/bin/brew' upgrade --formula codex")
      f.inventory.claude = tool('claude', '/opt/homebrew/bin/claude', '/opt/homebrew/Caskroom/claude-code@latest/2/claude')
      assert.equal(providerPlan('claude', 'update', f.inventory, '/usr/local/bin/brew').command, "'/opt/homebrew/bin/brew' upgrade --cask claude-code@latest")
      f.inventory.codex = tool('codex', '/old/bin/codex', '/old/lib/node_modules/@openai/codex/bin/codex.js')
      assert.equal(providerPlan('codex', 'update', f.inventory, null).command, "'/usr/bin/npm' install -g --prefix '/old' @openai/codex@latest")
      f.inventory.codex = tool('codex', '/alias/codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
      const app = providerPlan('codex', 'update', f.inventory, null)
      assert.equal(app.handoff, '/Applications/ChatGPT.app')
      assert.equal(app.command, "/usr/bin/open '/Applications/ChatGPT.app'")
      assert.doesNotMatch(app.command, /npm|brew/)
      f.inventory.codex = tool('codex', path.join(f.home, '.local/bin/codex'), path.join(f.home, '.codex/packages/standalone/0.1/codex'))
      assert.equal(installation(f.inventory.codex), 'native')
      assert.equal(providerPlan('codex', 'update', f.inventory, null).command, `'${f.home}/.local/bin/codex' update`)
    } finally { f.close() }
  })

  it('login uses the exact selected executable and the provider child environment policy', async () => {
    const f = fixture()
    try {
      const output = path.join(f.home, 'observed')
      const weird = path.join(f.bin, "chosen ' CLI $(touch injected)")
      writeFileSync(weird, `#!/bin/bash\nprintf '%s|%s|%s|%s|%s' "$HOME" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$ANTHROPIC_BASE_URL" "$*" > '${output}'\n`, { mode: 0o700 })
      f.inventory.claude = tool('claude', weird)
      const controller = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, run: unusedRun,
        launch: async (file) => { const r = await execAsync('/bin/bash', [file], { timeoutMs: 5_000, env: { ...f.env, HOME: '/different-terminal-home' } }); assert.equal(r.status, 0, r.stderr) } })
      const result = await controller.start('claude', 'login', await controller.prepare('claude', 'login'))
      assert.equal(result.state, 'succeeded')
      assert.equal(readFileSync(output, 'utf8'), `${f.home}||||auth login`)
      assert.equal(existsSync(path.join(f.home, 'injected')), false)
    } finally { f.close() }
  })

  it('a failed download pipeline is reported as failure rather than an empty successful shell', async () => {
    const f = fixture()
    try {
      f.inventory.claude = tool('claude', null)
      writeFileSync(path.join(f.bin, 'curl'), '#!/bin/bash\nexit 22\n', { mode: 0o700 })
      const controller = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, run: unusedRun,
        launch: async (file) => { await execAsync('/bin/bash', [file], { timeoutMs: 5_000, env: f.env }) } })
      const result = await controller.start('claude', 'install', await controller.prepare('claude', 'install'))
      assert.equal(result.state, 'failed')
      assert.equal(result.exitCode, 22)
    } finally { f.close() }
  })

  it('two previously prepared actions cannot start concurrently for one provider', async () => {
    const f = fixture()
    try {
      const controller = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, run: unusedRun, launch: async () => {} })
      const prepared = await Promise.all([controller.prepare('claude', 'login'), controller.prepare('claude', 'login')])
      await controller.start('claude', 'login', prepared[0]!)
      await assert.rejects(controller.start('claude', 'login', prepared[1]!), /уже выполняется/)
    } finally { f.close() }
  })

  it('late completion is observable after an unknown outcome and retry warns about it', async () => {
    const f = fixture()
    try {
      let now = 0
      let script = ''
      const controller = new Maintenance({ info: f.info, env: f.env, now: () => now, inventory: async () => f.inventory, run: unusedRun, launch: async file => { script = file } })
      const result = await controller.start('codex', 'login', await controller.prepare('codex', 'login'))
      now = 16 * 60_000
      assert.equal(controller.operation(result.id).state, 'unknown')
      assert.equal((await controller.prepare('codex', 'login')).uncertain, true)
      writeFileSync(path.join(path.dirname(script), 'result'), '0\n', { mode: 0o600 })
      assert.equal(controller.operation(result.id).state, 'succeeded')
    } finally { f.close() }
  })

  it('private operation paths reject symlinks and result readers reject substituted or oversized files', async () => {
    const f = fixture()
    try {
      mkdirSync(path.join(f.home, 'run'), { mode: 0o700 })
      const outside = path.join(f.home, 'outside')
      mkdirSync(outside, { mode: 0o700 })
      symlinkSync(outside, path.join(f.home, 'run/maintenance'))
      const controller = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, run: unusedRun, launch: async () => {} })
      await assert.rejects(controller.start('claude', 'login', await controller.prepare('claude', 'login')), /приватным/)
      rmSync(path.join(f.home, 'run/maintenance'))
      let script = ''
      const reader = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, run: unusedRun, launch: async file => { script = file } })
      const result = await reader.start('claude', 'login', await reader.prepare('claude', 'login'))
      const secret = path.join(outside, 'secret')
      writeFileSync(secret, 'private', { mode: 0o600 })
      symlinkSync(secret, path.join(path.dirname(script), 'result'))
      assert.equal(reader.operation(result.id).state, 'failed')
      assert.equal(readFileSync(secret, 'utf8'), 'private')
      const large = await reader.start('codex', 'login', await reader.prepare('codex', 'login'))
      writeFileSync(path.join(path.dirname(script), 'result'), '0'.repeat(1_000), { mode: 0o600 })
      assert.equal(reader.operation(large.id).state, 'failed')
    } finally { f.close() }
  })

  it('offline doctor runs the existing CLI without starting a daemon and accepts a failing health report', async () => {
    const f = fixture()
    try {
      let runs = 0
      const report = { ok: false, generatedAt: '2026-11-11T00:00:00Z', home: f.home, items: [], counts: { ok: 0, warn: 0, fail: 1 } }
      const controller = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, launch: async () => {},
        run: async (file, args) => { runs++; assert.equal(file, '/node'); assert.deepEqual(args, ['/pult/dist/cli/main.js', 'doctor', '--json', '--no-net']); await new Promise(resolve => setImmediate(resolve)); return { status: 1, stdout: JSON.stringify(report), stderr: '' } } })
      const [first, second] = await Promise.all([controller.doctor(), controller.doctor()])
      assert.deepEqual(first, report)
      assert.deepEqual(second, report)
      assert.equal(runs, 1)
    } finally { f.close() }
  })
  it('blocked network cannot launch Terminal and an approved proxy stays out of the displayed command', async () => {
    const f = fixture()
    try {
      let launched = 0
      const blocked = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, run: unusedRun,
        network: async () => { throw Object.assign(new Error('blocked country'), { code: 'blocked_network' }) }, launch: async () => { launched++ } })
      await assert.rejects(blocked.prepare('claude', 'login'), error => (error as { code?: string }).code === 'blocked_network')
      assert.equal(launched, 0)
      const output = path.join(f.home, 'proxy-seen')
      const proxy = 'http://user:private-proxy-password@127.0.0.1:8118'
      writeFileSync(f.inventory.claude.path!, `#!/bin/bash\nprintf '%s' "$HTTPS_PROXY" > '${output}'\n`, { mode: 0o700 })
      let script = ''
      const approved = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, run: unusedRun,
        network: async () => ({ HTTPS_PROXY: proxy, NO_PROXY: 'localhost' }), launch: async file => {
          script = file
          assert.doesNotMatch(readFileSync(file, 'utf8'), /private-proxy-password/)
          const result = await execAsync('/bin/bash', [file], { timeoutMs: 5_000, env: f.env })
          assert.equal(result.status, 0, result.stderr)
        } })
      const result = await approved.start('claude', 'login', await approved.prepare('claude', 'login'))
      assert.equal(result.state, 'succeeded')
      assert.equal(readFileSync(output, 'utf8'), proxy)
      assert.doesNotMatch(result.command, /private-proxy-password/)
      assert.equal(existsSync(path.join(path.dirname(script), 'network.env')), false)
    } finally { f.close() }
  })

  it('old Codex self-update falls back only for the standard selected native launcher', async () => {
    const f = fixture()
    try {
      const controller = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, launch: async () => {},
        run: async (_file, args) => { assert.deepEqual(args, ['update', '--help']); return { status: 2, stdout: '', stderr: 'unknown command' } } })
      assert.equal((await controller.prepare('codex', 'update')).plan.command, 'curl -fsSL https://chatgpt.com/codex/install.sh | sh')
      f.inventory.codex = tool('codex', path.join(f.home, 'frozen-codex'), path.join(f.home, '.local/share/codex/old/codex'))
      await assert.rejects(controller.prepare('codex', 'update'), /нестандартный native launcher/)
    } finally { f.close() }
  })

  it('rechecks the route after confirmation and refuses a newly blocked network', async () => {
    const f = fixture()
    try {
      let allowed = true
      let launched = false
      const controller = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, run: unusedRun,
        network: async () => {
          if (!allowed) throw Object.assign(new Error('blocked country'), { code: 'blocked_network' })
          return { HTTPS_PROXY: 'http://127.0.0.1:8118' }
        },
        launch: async () => { launched = true },
      })
      const prepared = await controller.prepare('claude', 'login')
      allowed = false
      await assert.rejects(controller.start('claude', 'login', prepared), error => (error as { code?: string }).code === 'blocked_network')
      assert.equal(launched, false)
    } finally { f.close() }
  })

  it('removes proxy credentials if preparing the command script fails', async () => {
    const f = fixture()
    const original = fs.writeFileSync
    let launched = false
    const failure = mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).endsWith('.command')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      return original(...args)
    })
    syncBuiltinESMExports()
    try {
      const controller = new Maintenance({ info: f.info, env: f.env, inventory: async () => f.inventory, run: unusedRun,
        network: async () => ({ HTTPS_PROXY: 'http://fixture:fake-secret@127.0.0.1:8118' }),
        launch: async () => { launched = true },
      })
      await assert.rejects(controller.start('claude', 'login', await controller.prepare('claude', 'login')), /ENOSPC/)
      assert.equal(launched, false)
      const directory = path.join(f.home, 'run/maintenance')
      for (const id of readdirSync(directory)) assert.equal(existsSync(path.join(directory, id, 'network.env')), false)
    } finally {
      failure.mock.restore()
      syncBuiltinESMExports()
      f.close()
    }
  })

})
