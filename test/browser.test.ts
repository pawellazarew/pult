// О3: браузер для агента (Playwright MCP) и свои MCP-серверы владельца.
// Сеть не трогается: пакет Playwright MCP — фальшивый тарбол по своему lock-файлу, npm идёт `--offline`;
// Chrome не ищется на машине; `~/.claude.json` — файл во временном PULT_HOME; claude и codex — фальшивые.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildClaudeArgv, mcpConfigBody } from '../dist/adapters/claude/argv.js'
import { createClaudeMapper } from '../dist/adapters/claude/mapper.js'
import { CODEX_BROWSER_PENDING, createCodexAdapter, elicitationAnswer, isToolApproval, toolApprovalCall } from '../dist/adapters/codex/adapter.js'
import { createCodexMapper } from '../dist/adapters/codex/mapper.js'
import { connectClient } from '../dist/cli/client.js'
import { stripBlobs } from '../dist/core/blobs.js'
import { defaultConfig, validateConfig, writeMcpSelection } from '../dist/core/config.js'
import type { EventDraft, PultEvent } from '../dist/core/events.js'
import { fitEvent } from '../dist/core/history.js'
import { createLogger } from '../dist/core/log.js'
import { acquireLock } from '../dist/core/lock.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import type { NetCheck } from '../dist/env/net.js'
import {
  browserArgs, browserCli, browserCodexSpec, browserCommand, browserDirs, browserInstalled, BrowserInstallError, browserPermissions, browserPrefix,
  browserServerSpec, claudeDefaultMode, createBrowserInstaller, DENIED_BROWSER_TOOLS, discardDir, ensureBrowserDirs, findChrome, installBrowser,
  PACKAGED_LOCK_DIR, PLAYWRIGHT_MCP_VERSION, profileBusy, removeBrowserProfile, STANDARD_CHROME, sweepDeadBrowserDirs,
} from '../dist/mcp/browser.js'
import { browserDoctorItems, bypassDoctorItems, mcpDoctorItems } from '../dist/mcp/doctor.js'
import { createMcpExtras } from '../dist/mcp/session.js'
import { describeServer, listServers, readServersFile, selectedServers } from '../dist/mcp/servers.js'
import { createBroker } from '../dist/perm/broker.js'
import { parseBrowser, parseSessions } from '../dist/sessions/registry.js'
import type { SessionRecord } from '../dist/sessions/registry.js'
import { CLI_ENTRY, FAKE_CLAUDE, FAKE_CODEX_SCRIPTED, startTestDaemon, tempHome, waitFor } from './helpers.js'

// Страж сети тестового демона отвечает «ок» без curl (только вместе с testMode).
process.env['PULT_TEST_NET'] = 'ok'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const mode = (p: string): number => statSync(p).mode & 0o777
const B = 'pult_browser'

/**
 * Фальшивый @playwright/mcp и lock-файл под него (как `mcp/playwright-mcp/` пакета): package.json с
 * зависимостью `file:<тарбол>` и package-lock.json, где `resolved` — абсолютный путь (npm ci идёт из другой папки).
 */
function fakeLockDir(dir: string, version = PLAYWRIGHT_MCP_VERSION): string {
  const pkg = join(dir, 'src', 'package')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version, bin: { 'playwright-mcp': 'cli.js' } }))
  writeFileSync(join(pkg, 'cli.js'), '#!/usr/bin/env node\nprocess.stdin.resume()\n')
  const tgz = join(dir, `playwright-mcp-${version}.tgz`)
  execFileSync('tar', ['-czf', tgz, '-C', join(dir, 'src'), 'package'])
  const lock = join(dir, 'lock')
  mkdirSync(lock)
  writeFileSync(join(lock, 'package.json'), JSON.stringify({ name: 'pult-playwright-mcp', version: '0.0.0', private: true, dependencies: { '@playwright/mcp': `file:${tgz}` } }))
  execFileSync('npm', ['install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: lock, env: { ...process.env, npm_config_cache: join(dir, 'cache') }, stdio: 'ignore' })
  const lf = join(lock, 'package-lock.json')
  const l = JSON.parse(readFileSync(lf, 'utf8')) as { packages: Record<string, { resolved?: string }> }
  const entry = l.packages['node_modules/@playwright/mcp']
  if (entry) entry.resolved = `file:${tgz}`
  writeFileSync(lf, JSON.stringify(l, null, 2))
  return lock
}

/** «Поставленный» пакет без npm — для тестов, которым установка не важна. */
function fakeInstalled(p: PultPaths): void {
  mkdirSync(join(browserPrefix(p), 'node_modules', '@playwright', 'mcp'), { recursive: true })
  writeFileSync(join(browserPrefix(p), 'node_modules', '@playwright', 'mcp', 'package.json'), JSON.stringify({ version: PLAYWRIGHT_MCP_VERSION }))
  writeFileSync(browserCli(p), '')
}

const okNet = async (): Promise<NetCheck> => ({
  provider: 'codex', mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true, reason: 'ok', fellBack: false,
  guard: ['RU'], attempts: [], ms: 1, checkedAt: '2026-10-14T10:00:00.000Z', cached: false,
})

describe('config.json: mcp.servers', () => {
  it('по умолчанию пусто; кривые имена отброшены с предупреждением; не список — предупреждение', () => {
    assert.deepEqual(defaultConfig().mcp, { servers: [] })
    const ok = validateConfig({ mcp: { servers: ['github', 'Linear.app', 'github'] } })
    assert.deepEqual(ok.config.mcp.servers, ['github', 'Linear.app'])
    assert.equal(ok.warnings.length, 1, 'повтор отброшен — с предупреждением')
    const bad = validateConfig({ mcp: { servers: 'github' } })
    assert.deepEqual(bad.config.mcp.servers, [])
    assert.equal(bad.warnings.length, 1)
    assert.deepEqual(validateConfig({ mcp: { servers: ['a b', '', '-x', '__proto__', 'ok'] } }).config.mcp.servers, ['ok'])
  })

  it('writeMcpSelection: остальное в файле не трогается, файла нет — заводится, кривой JSON — отказ', () => {
    const dir = tmp('pt-mcpcfg-')
    try {
      const f = join(dir, 'config.json')
      writeMcpSelection(f, ['github'])
      assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { mcp: { servers: ['github'] } })
      assert.equal(mode(f), 0o600)
      writeFileSync(f, JSON.stringify({ autoTitle: false, unknownKey: { x: 1 }, mcp: { servers: ['a'], future: true } }))
      writeMcpSelection(f, ['b', 'c'])
      assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { autoTitle: false, unknownKey: { x: 1 }, mcp: { servers: ['b', 'c'], future: true } })
      writeFileSync(f, '{ сломано')
      assert.throws(() => writeMcpSelection(f, ['x']), /не разбирается/)
      assert.equal(readFileSync(f, 'utf8'), '{ сломано', 'чужой текст не переписан')
      assert.deepEqual(readdirSync(dir).sort(), ['config.json'], 'временных файлов не осталось')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('свои MCP-серверы: только ~/.claude.json', () => {
  it('нет файла — пусто; кривой — пусто с предупреждением; негодные записи пропущены; .mcp.json не читается', async () => {
    const dir = tmp('pt-mcpsrv-')
    try {
      assert.deepEqual({ ...(await readServersFile(join(dir, 'нет.json'))).servers }, {})
      writeFileSync(join(dir, 'bad.json'), '{')
      assert.match((await readServersFile(join(dir, 'bad.json'))).warning ?? '', /не разбирается/)
      writeFileSync(join(dir, 'arr.json'), JSON.stringify({ mcpServers: [] }))
      assert.match((await readServersFile(join(dir, 'arr.json'))).warning ?? '', /не объект/)
      writeFileSync(join(dir, 'ok.json'), JSON.stringify({
        projects: { '/x': { mcpServers: { local: { command: 'x' } } } },
        mcpServers: {
          github: { type: 'stdio', command: '/usr/local/bin/gh-mcp', args: ['--token', 'ghp_секрет'], env: { GITHUB_TOKEN: 'ghp_x' } },
          linear: { type: 'http', url: 'https://mcp.linear.app/sse?key=секрет', headers: { Authorization: 'Bearer x' } },
          plain: { command: 'npx', args: ['-y', 'pkg'] },
          sse: { type: 'sse', url: 'https://example.com/sse' },
          constructor: { command: 'ctor-mcp' },
          broken: { type: 'stdio' },
          'с пробелом': { command: 'x' },
          weird: 42,
        },
      }))
      const r = await readServersFile(join(dir, 'ok.json'))
      assert.deepEqual(Object.keys(r.servers).sort(), ['constructor', 'github', 'linear', 'plain', 'sse'])
      assert.equal(Object.getPrototypeOf(r.servers), null, 'словарь без прототипа')
      assert.equal(r.warning, undefined)
      // `.mcp.json` в папке — пока не наш источник: его серверов нет нигде.
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: './evil.sh' } } }))
      assert.ok(!(await listServers(join(dir, 'ok.json'), [])).servers.some((s) => s.name === 'evil'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('mcp.list и подключение: имена Пульта скрыты, ключи прототипа — не серверы, выбранного нет — пропуск без подстановки, секретов наружу нет', async () => {
    const dir = tmp('pt-mcplist-')
    try {
      const user = join(dir, 'claude.json')
      writeFileSync(user, JSON.stringify({ mcpServers: {
        github: { command: '/opt/bin/gh-mcp', args: ['--token', 'ghp_секрет'], env: { T: 'sk-ant-секрет' } },
        linear: { type: 'http', url: 'https://mcp.linear.app/path?key=секрет' },
        pult: { command: 'evil' },
        pult_browser: { command: 'evil' },
        browser: { command: 'own-browser' },
      } }))
      const l = await listServers(user, ['github', 'toString', 'hasOwnProperty', 'gone'])
      assert.deepEqual(l.servers.map((s) => s.name), ['github', 'linear', 'browser'], 'свой `browser` владельца — обычный сервер; pult, pult_browser — скрыты')
      assert.deepEqual(l.missing, ['toString', 'hasOwnProperty', 'gone'])
      const text = JSON.stringify(l)
      for (const secret of ['ghp_', 'sk-ant', 'key=', 'args', 'env', '/path', '/opt/bin', 'evil']) assert.ok(!text.includes(secret), `${secret} не должен уйти наружу: ${text}`)
      assert.equal(l.servers.find((s) => s.name === 'linear')?.detail, 'https://mcp.linear.app')
      assert.equal(describeServer({ command: '/opt/bin/gh-mcp' }), 'gh-mcp')

      const sel = await selectedServers(user, ['github', 'pult', 'pult_browser', 'toString', 'gone'])
      assert.deepEqual(Object.keys(sel.servers), ['github'])
      assert.equal(sel.servers['github']?.['command'], '/opt/bin/gh-mcp')
      assert.deepEqual(sel.missing, ['toString', 'gone'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('argv и --mcp-config: браузер и свои серверы', () => {
  it('--settings с правилами — только вместе с брокером; заглушка pult первой и не перебивается', () => {
    const dirs = { root: '/h/browser/w', profile: '/h/browser/w/profile', downloads: '/h/browser/w/downloads' }
    const permissions = browserPermissions(dirs)
    assert.deepEqual(permissions, {
      allow: ['Read(//h/browser/w/downloads/**)'],
      ask: [`mcp__${B}`],
      deny: DENIED_BROWSER_TOOLS.map((t) => `mcp__${B}__${t}`),
    })
    assert.ok(permissions.deny.includes(`mcp__${B}__browser_run_code_unsafe`) && permissions.deny.includes(`mcp__${B}__browser_evaluate`))
    const argv = buildClaudeArgv({ sessionId: 'u', resume: false, mcpConfigPath: '/x/mcp.json', permissions })
    assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings') + 1] as string), { permissions })
    // 0.3.7: правила папки run сливаются с правилами браузера в один --settings.
    const merged = buildClaudeArgv({ sessionId: 'u', resume: false, mcpConfigPath: '/x/mcp.json', permissions, protectDirs: ['/h/run'] })
    assert.equal(merged.filter((a) => a === '--settings').length, 1)
    assert.deepEqual(JSON.parse(merged[merged.indexOf('--settings') + 1] as string), { permissions: {
      allow: permissions.allow, ask: permissions.ask, deny: ['Read(//h/run/**)', 'Edit(//h/run/**)', ...permissions.deny],
    } })
    assert.ok(argv.includes('--strict-mcp-config'), 'набор серверов остаётся явным')
    assert.ok(!argv.includes('--add-dir'), 'папку скачиваний не даём целиком — только чтение правилом')
    assert.ok(!buildClaudeArgv({ sessionId: 'u', resume: false, permissions }).includes('--settings'), 'без брокера браузера нет')
    assert.ok(!buildClaudeArgv({ sessionId: 'u', resume: false, permissions, protectDirs: ['/h/run'] }).includes(`mcp__${B}`), 'без брокера правил браузера нет и при защите run')
    assert.ok(!buildClaudeArgv({ sessionId: 'u', resume: false, mcpConfigPath: '/x', permissions: {} }).includes('--settings'), 'пустые правила — без флага')

    const body = JSON.parse(mcpConfigBody({
      nodeBin: '/n/node', cliEntry: '/p/main.js', home: '/h', sessionName: 'w', askKey: 'k',
      servers: { pult: { command: 'подмена' }, [B]: { type: 'stdio', command: '/bin/sh', args: [] }, github: { command: 'gh' } },
    })) as { mcpServers: Record<string, { command: string; args?: string[] }> }
    assert.deepEqual(Object.keys(body.mcpServers), ['pult', B, 'github'])
    assert.deepEqual(body.mcpServers['pult']?.args, ['/p/main.js', 'mcp-ask'], 'заглушку разрешений не перебить')
    assert.deepEqual(Object.keys((JSON.parse(mcpConfigBody({ nodeBin: 'n', cliEntry: 'c', home: 'h', sessionName: 's', askKey: 'k' })) as { mcpServers: object }).mcpServers), ['pult'])
  })

  it('Playwright MCP: свой профиль, скачивания, абсолютные пути, без окна по умолчанию, cwd — папка скачиваний', () => {
    const dirs = { root: '/h/browser/w', profile: '/h/browser/w/profile', downloads: '/h/browser/w/downloads' }
    const std = STANDARD_CHROME['darwin'] as string
    const a = browserArgs({ nodeBin: 'n', cli: '/c/cli.js', dirs, headed: false, chrome: std, platform: 'darwin' })
    assert.deepEqual(a, ['/c/cli.js', '--browser', 'chrome', '--user-data-dir', dirs.profile, '--output-dir', dirs.downloads, '--file-paths', 'absolute', '--headless'])
    assert.ok(!a.includes('--allow-unrestricted-file-access'))
    const h = browserArgs({ nodeBin: 'n', cli: '/c/cli.js', dirs, headed: true, chrome: '/Users/you/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', platform: 'darwin' })
    assert.ok(!h.includes('--headless'))
    assert.equal(h[h.indexOf('--executable-path') + 1], '/Users/you/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    const cmd = browserCommand({ nodeBin: '/n/node', cli: '/c/cli.js', dirs, headed: false, chrome: null })
    assert.equal(cmd.command, '/bin/sh')
    assert.deepEqual(cmd.args.slice(0, 5), ['-c', 'cd -- "$1" && shift && exec "$@"', 'pult-browser', dirs.downloads, '/n/node'])
    // Обёртка настоящая: sh заходит в папку и отдаёт процесс команде.
    const d = tmp('pt-brwcwd-')
    try {
      const out = execFileSync('/bin/sh', ['-c', 'cd -- "$1" && shift && exec "$@"', 'pult-browser', d, process.execPath, '-e', 'process.stdout.write(process.cwd())'], { encoding: 'utf8' })
      assert.equal(out.replace(/^\/private/, ''), d.replace(/^\/private/, ''))
    } finally { rmSync(d, { recursive: true, force: true }) }
    assert.equal(browserServerSpec({ nodeBin: 'n', cli: 'c', dirs, headed: false, chrome: null })['command'], '/bin/sh')
    const cx = browserCodexSpec({ nodeBin: 'n', cli: 'c', dirs, headed: false, chrome: null })
    assert.equal(cx['default_tools_approval_mode'], 'prompt')
    assert.deepEqual(cx['disabled_tools'], [...DENIED_BROWSER_TOOLS])
  })

  it('Chrome: штатное место, ~/Applications на macOS, иначе null', () => {
    const has = (set: string[]) => (p: string): boolean => set.includes(p)
    assert.equal(findChrome({ platform: 'darwin', home: '/Users/you', exists: has([STANDARD_CHROME['darwin'] as string]) }), STANDARD_CHROME['darwin'])
    const mine = '/Users/you/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    assert.equal(findChrome({ platform: 'darwin', home: '/Users/you', exists: has([mine]) }), mine)
    assert.equal(findChrome({ platform: 'darwin', home: '/Users/you', exists: has([]) }), null)
    assert.equal(findChrome({ platform: 'linux', exists: has(['/usr/bin/google-chrome-stable']) }), '/usr/bin/google-chrome-stable')
    assert.equal(findChrome({ platform: 'win32', exists: () => true }), null)
  })

  it('режим разрешений Claude: старшие файлы перекрывают, кривые пропускаются', () => {
    const d = tmp('pt-mode-')
    try {
      const u = join(d, 'u.json'); const p = join(d, 'p.json'); const bad = join(d, 'bad.json')
      writeFileSync(u, JSON.stringify({ permissions: { defaultMode: 'auto' } }))
      writeFileSync(p, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
      writeFileSync(bad, '{')
      assert.equal(claudeDefaultMode([u]), 'auto')
      assert.equal(claudeDefaultMode([u, p, bad, join(d, 'нет')]), 'bypassPermissions')
      assert.equal(claudeDefaultMode([]), null)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('установка Playwright MCP без сети', () => {
  it('в пакете есть lock-файл с суммами: @playwright/mcp 0.0.83 и обе зависимости', () => {
    const lock = JSON.parse(readFileSync(join(PACKAGED_LOCK_DIR, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; integrity?: string; resolved?: string }> }
    const pkgs = Object.entries(lock.packages).filter(([k]) => k)
    assert.deepEqual(pkgs.map(([k]) => k).sort(), ['node_modules/@playwright/mcp', 'node_modules/playwright', 'node_modules/playwright-core'])
    assert.equal(lock.packages['node_modules/@playwright/mcp']?.version, PLAYWRIGHT_MCP_VERSION)
    for (const [k, v] of pkgs) {
      assert.match(v.integrity ?? '', /^sha512-/, k)
      assert.ok(v.resolved?.startsWith('https://registry.npmjs.org/'), k)
    }
    assert.equal((JSON.parse(readFileSync(join(PACKAGED_LOCK_DIR, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@playwright/mcp'], PLAYWRIGHT_MCP_VERSION)
  })

  it('PULT_TEST=1 без фальшивого lock-файла — отказ, а не поход в сеть', async () => {
    const home = tempHome()
    try {
      await assert.rejects(installBrowser(home.paths, { env: { ...process.env, PULT_TEST: '1', PULT_TEST_PLAYWRIGHT_MCP_LOCKDIR: '' } }), BrowserInstallError)
      assert.equal(browserInstalled(home.paths), false)
    } finally { home.remove() }
  })

  it('npm ci по lock-файлу → каталог версии; следы прерванных — прочь; чужой lock — busy; второй раз — «уже стоит»; не та версия — отказ без следов', async () => {
    const home = tempHome()
    const dir = tmp('pt-pwlock-')
    try {
      const env = { ...process.env, PULT_TEST: '1', PULT_TEST_PLAYWRIGHT_MCP_LOCKDIR: fakeLockDir(dir) }
      const held = acquireLock(home.paths.mcpInstallLock)
      assert.ok(held.ok)
      await assert.rejects(installBrowser(home.paths, { env }), (e: unknown) => e instanceof BrowserInstallError && e.code === 'busy')
      if (held.ok) held.lock.release()

      mkdirSync(join(home.paths.mcp, `playwright-mcp-${PLAYWRIGHT_MCP_VERSION}.partial-99999`), { recursive: true })
      mkdirSync(join(home.paths.mcp, `playwright-mcp-${PLAYWRIGHT_MCP_VERSION}.old-99999`), { recursive: true })
      const r = await installBrowser(home.paths, { env })
      assert.equal(r.installed, true)
      assert.ok(existsSync(browserCli(home.paths)))
      assert.equal(mode(home.paths.mcp), 0o700)
      assert.deepEqual(readdirSync(home.paths.mcp), [`playwright-mcp-${PLAYWRIGHT_MCP_VERSION}`], 'следы .partial/.old убраны')
      assert.ok(existsSync(join(browserPrefix(home.paths), 'package-lock.json')), 'стоит ровно по lock-файлу')
      assert.ok(!existsSync(join(home.paths.home, '.npm')), '~/.npm не трогается')
      assert.equal((await installBrowser(home.paths, { env })).installed, false)
      assert.ok(!existsSync(home.paths.mcpInstallLock), 'lock снят')
    } finally { home.remove(); rmSync(dir, { recursive: true, force: true }) }

    const home2 = tempHome()
    const dir2 = tmp('pt-pwlock2-')
    try {
      const env = { ...process.env, PULT_TEST: '1', PULT_TEST_PLAYWRIGHT_MCP_LOCKDIR: fakeLockDir(dir2, '0.0.1') }
      await assert.rejects(installBrowser(home2.paths, { env }), /нашлось: 0\.0\.1/)
      assert.equal(browserInstalled(home2.paths), false)
      assert.deepEqual(readdirSync(home2.paths.mcp), [], 'полуразложенный пакет не остался')
    } finally { home2.remove(); rmSync(dir2, { recursive: true, force: true }) }
  })

  it('демон: одна установка на всех; провал — failed и событие, повтор пробует снова; чужая установка — ждём и пробуем ещё раз', async () => {
    const home = tempHome()
    try {
      const drafts: EventDraft[] = []
      let calls = 0
      let fail = true
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => { release = r })
      const inst = createBrowserInstaller({
        paths: home.paths, logger: home.logger, emit: (d) => { drafts.push(d) },
        install: async (p) => {
          calls++
          await gate
          if (fail) throw new Error('npm ci не удался (код 1): ETIMEDOUT registry.npmjs.org')
          fakeInstalled(p)
          return { installed: true, version: PLAYWRIGHT_MCP_VERSION, path: browserPrefix(p) }
        },
      })
      assert.equal(inst.state().state, 'missing')
      const a = inst.ensure('a')
      const b = inst.ensure('b')
      assert.equal(inst.state().state, 'installing')
      release()
      assert.deepEqual(await Promise.all([a, b]), [false, false])
      assert.equal(calls, 1, 'две сессии — одна установка')
      const st = inst.state()
      assert.match(st.state === 'failed' ? st.error : '', /ETIMEDOUT/)
      assert.deepEqual(drafts.map((d) => d.data?.['state']), ['started', 'failed'])
      fail = false
      assert.equal(await inst.ensure('c'), true)
      assert.equal(inst.state().state, 'installed')
    } finally { home.remove() }

    // Чужая установка держит lock: ждём его освобождения, потом «стоит» — без второй установки.
    const home2 = tempHome()
    try {
      let calls = 0
      const held = acquireLock(home2.paths.mcpInstallLock)
      assert.ok(held.ok)
      const inst = createBrowserInstaller({
        paths: home2.paths, logger: home2.logger, emit: () => {}, busyWaitMs: 5000,
        install: async () => { calls++; throw new BrowserInstallError('уже идёт другая установка', 'busy') },
      })
      const r = inst.ensure('x')
      setTimeout(() => { fakeInstalled(home2.paths); if (held.ok) held.lock.release() }, 300)
      assert.equal(await r, true, 'чужая установка закончилась — браузер есть, ход не «упал»')
      assert.equal(calls, 1)
    } finally { home2.remove() }
  })
})

describe('серверы сессии (mcpExtras)', () => {
  const rec = (over: Partial<SessionRecord>): SessionRecord => ({
    name: 'w', provider: 'claude', cwd: '/', mode: 'turn', createdAt: '', lastStatus: 'cold', lastEventId: 0, ...over,
  })
  it('claude: браузер + выбранные свои + правила; codex: только браузер с prompt и disabled_tools; bypassPermissions — без браузера', async () => {
    const home = tempHome()
    try {
      const user = join(home.paths.home, 'claude.json')
      const settings = join(home.paths.home, 'claude-settings.json')
      writeFileSync(user, JSON.stringify({ mcpServers: { github: { command: 'gh' }, browser: { command: 'own' } } }))
      const installed = createBrowserInstaller({ paths: home.paths, logger: home.logger, emit: () => {}, install: async () => { throw new Error('не зовётся') } })
      fakeInstalled(home.paths)
      const records: Record<string, SessionRecord> = {
        w: rec({ browser: {} }),
        h: rec({ name: 'h', browser: { headed: true } }),
        c: rec({ name: 'c', provider: 'codex', browser: {} }),
        n: rec({ name: 'n' }),
      }
      const drafts: EventDraft[] = []
      const extras = createMcpExtras({
        paths: home.paths, logger: home.logger, installer: installed, record: (n) => records[n] ?? null,
        selected: () => ['github', 'browser'], userFile: user, claudeSettings: () => [settings], emit: (d) => { drafts.push(d) }, chrome: () => null,
      })
      const w = await extras('w', '/n/node')
      assert.deepEqual(Object.keys(w.servers).sort(), ['browser', 'github', B], 'свой `browser` владельца и наш `pult_browser` — разные')
      assert.deepEqual(w.permissions, browserPermissions(browserDirs(home.paths, 'w')))
      assert.ok((w.servers[B]?.['args'] as string[]).includes('--headless'))
      assert.equal(mode(browserDirs(home.paths, 'w').profile), 0o700, 'профиль — 0700')
      assert.ok(!((await extras('h', '/n/node')).servers[B]?.['args'] as string[]).includes('--headless'))
      const c = await extras('c', '/n/node')
      assert.deepEqual(Object.keys(c.servers), [B], 'свои серверы Codex берёт из ~/.codex/config.toml сам')
      assert.equal(c.servers[B]?.['default_tools_approval_mode'], 'prompt')
      assert.equal(c.permissions, undefined)
      assert.deepEqual({ ...(await extras('n', '/n/node')) }, { servers: { github: { command: 'gh' }, browser: { command: 'own' } } })
      assert.deepEqual(await extras('нет', '/n/node'), { servers: {} })

      writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
      const by = await extras('w', '/n/node')
      assert.equal(by.servers[B], undefined, 'в bypassPermissions браузера нет')
      assert.equal(by.permissions, undefined)
      assert.equal(drafts.at(-1)?.data?.['state'], 'skipped')
      assert.match(String(drafts.at(-1)?.data?.['reason']), /bypassPermissions/)
      assert.ok((await extras('c', '/n/node')).servers[B], 'режим Claude к Codex не относится')
    } finally { home.remove() }
  })

  it('пакет не поставился — ход без браузера и заметка в ленте сессии', async () => {
    const home = tempHome()
    try {
      const drafts: EventDraft[] = []
      const inst = createBrowserInstaller({ paths: home.paths, logger: home.logger, emit: () => {}, install: async () => { throw new Error('нет сети\nхвост') } })
      const extras = createMcpExtras({
        paths: home.paths, logger: home.logger, installer: inst, record: () => rec({ browser: {} }),
        selected: () => [], userFile: join(home.paths.home, 'claude.json'), claudeSettings: () => [], emit: (d) => { drafts.push(d) }, chrome: () => null,
      })
      assert.deepEqual(await extras('w', '/n/node'), { servers: {} })
      assert.equal(drafts[0]?.kind, 'browser.install')
      assert.equal(drafts[0]?.sessionId, 'w')
      assert.equal(drafts[0]?.data?.['state'], 'skipped')
      assert.match(String(drafts[0]?.data?.['reason']), /^Playwright MCP не поставился: нет сети — повтор/)
    } finally { home.remove() }
  })
})

describe('профиль и каталоги браузера', () => {
  it('ensureBrowserDirs: 0700 даже при широком umask; профиль занят, пока жив Chrome по SingletonLock', async () => {
    const home = tempHome()
    const prev = process.umask(0o022)
    try {
      const d = ensureBrowserDirs(home.paths, 'w')
      for (const p of [home.paths.browser, d.root, d.profile, d.downloads]) assert.equal(mode(p), 0o700, p)
      assert.equal(profileBusy(d.profile), false)
      symlinkSync(`host-${process.pid}`, join(d.profile, 'SingletonLock'))
      assert.equal(profileBusy(d.profile), true, 'pid жив — занят')
      const t0 = Date.now()
      await removeBrowserProfile(home.paths, 'w', 300)
      assert.ok(Date.now() - t0 >= 250, 'ждал выхода Chrome до потолка')
      assert.ok(!existsSync(d.profile))
      assert.ok(existsSync(d.downloads), 'скачивания остались')
      assert.deepEqual(readdirSync(d.root), ['downloads'], 'следов .dead нет')
      // Новая сессия со старым именем: прежний каталог — целиком прочь.
      writeFileSync(join(d.downloads, 'old.csv'), 'x')
      await discardDir(d.root)
      assert.ok(!existsSync(d.root))
      // Следы, не удалённые убитым демоном, добирает старт.
      mkdirSync(join(home.paths.browser, 'z.dead-1-1'), { recursive: true })
      mkdirSync(join(home.paths.browser, 'q', 'profile.dead-1-1'), { recursive: true })
      assert.equal(await sweepDeadBrowserDirs(home.paths), 2)
      assert.deepEqual(readdirSync(home.paths.browser), ['q'])
    } finally { process.umask(prev); home.remove() }
  })
})

describe('реестр: поле browser', () => {
  it('true/объект/мусор; переживает разбор файла', () => {
    assert.deepEqual(parseBrowser(true), {})
    assert.deepEqual(parseBrowser({ headed: true }), { headed: true })
    assert.deepEqual(parseBrowser({ headed: 'yes' }), {})
    assert.equal(parseBrowser(false), null)
    assert.equal(parseBrowser('on'), null)
    const [a, b] = parseSessions({ sessions: [
      { name: 'a', provider: 'claude', cwd: '/x', browser: { headed: true } },
      { name: 'b', provider: 'codex', cwd: '/x', browser: 'да' },
    ] })
    assert.deepEqual(a?.browser, { headed: true })
    assert.equal(b?.browser, undefined)
  })
})

describe('доктор: браузер и свои серверы', () => {
  it('браузер: не нужен — справка, нужен и нет — предупреждение; свои: выбранного нет — предупреждение; bypassPermissions', async () => {
    const home = tempHome()
    try {
      assert.deepEqual(browserDoctorItems({ paths: home.paths, wanted: 0, chrome: null }).map((i) => i.status), ['ok', 'ok'])
      const want = browserDoctorItems({ paths: home.paths, wanted: 2, chrome: null })
      assert.deepEqual(want.map((i) => i.status), ['warn', 'warn'])
      assert.equal(want[0]?.fixCmd, 'pult browser install')
      const failed = browserDoctorItems({ paths: home.paths, state: { state: 'failed', at: '', error: 'ETIMEDOUT\nхвост' }, wanted: 0, chrome: '/c' })
      assert.equal(failed[0]?.status, 'warn')
      assert.match(failed[0]?.detail ?? '', /ETIMEDOUT$/)
      const user = join(home.paths.home, 'claude.json')
      assert.equal((await mcpDoctorItems(user, []))[0]?.status, 'ok')
      writeFileSync(user, JSON.stringify({ mcpServers: { github: { command: 'gh' } } }))
      assert.equal((await mcpDoctorItems(user, ['github']))[0]?.status, 'ok')
      const miss = (await mcpDoctorItems(user, ['github', 'gone']))[0]
      assert.equal(miss?.status, 'warn')
      assert.match(miss?.detail ?? '', /gone/)
      writeFileSync(user, '{')
      assert.equal((await mcpDoctorItems(user, ['x']))[0]?.status, 'warn')
      assert.deepEqual(bypassDoctorItems('auto', 1), [])
      assert.equal(bypassDoctorItems('bypassPermissions', 1)[0]?.status, 'warn')
      assert.equal(bypassDoctorItems('bypassPermissions', 0)[0]?.status, 'ok')
    } finally { home.remove() }
  })
})

describe('картинки и великанские события', () => {
  it('stripBlobs: картинки MCP и Anthropic — в заглушку, длинный base64 — в заглушку, текст — как был', () => {
    const big = 'A'.repeat(200_000)
    assert.deepEqual(stripBlobs([{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data: big }]),
      [{ type: 'text', text: 'ok' }, { type: 'text', text: '[изображение, 146 КБ]' }])
    assert.deepEqual(stripBlobs({ type: 'image', source: { type: 'base64', data: big } }), { type: 'text', text: '[изображение, 146 КБ]' })
    assert.equal(stripBlobs(big), '[данные, 146 КБ]')
    assert.equal(stripBlobs('обычный текст'), 'обычный текст')
  })

  it('мапперы: скриншот в итоге инструмента уходит в журнал заглушкой (claude и codex)', () => {
    const big = 'B'.repeat(300_000)
    const cm = createClaudeMapper({ sessionId: 'w' })
    const out = cm.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] }] } })
    const fin = out.drafts.find((d) => d.kind === 'tool.finished')
    assert.ok(fin)
    assert.ok(JSON.stringify(fin).length < 2000)
    assert.match(JSON.stringify(fin), /изображение, 220 КБ/)

    const xm = createCodexMapper({ sessionId: 'c' })
    const started = xm.push('item/started', { threadId: 't', turnId: 'u', item: { type: 'mcpToolCall', id: 'm1', server: B, tool: 'browser_take_screenshot', arguments: { fullPage: true }, status: 'inProgress' } })
    assert.deepEqual(started.drafts[0]?.data, { toolUseId: 'm1', name: `mcp__${B}__browser_take_screenshot`, input: { fullPage: true } })
    const done = xm.push('item/completed', { threadId: 't', turnId: 'u', item: { type: 'mcpToolCall', id: 'm1', server: B, tool: 'browser_take_screenshot', arguments: {}, status: 'completed', result: { content: [{ type: 'image', data: big, mimeType: 'image/png' }] } } })
    const d = done.drafts[0]
    assert.equal(d?.kind, 'tool.finished')
    assert.ok(JSON.stringify(d).length < 2000)
    assert.match(JSON.stringify(d), /изображение, 220 КБ/)
  })

  it('fitEvent: событие больше предела строки уходит урезанным, обычное — как есть', () => {
    const ev: PultEvent = { id: 1, ts: '', sessionId: 'w', provider: 'claude', kind: 'tool.finished', data: { content: 'x'.repeat(2_000_000), toolUseId: 't' } }
    const fit = fitEvent(ev)
    assert.ok(Buffer.byteLength(JSON.stringify(fit)) <= 900 * 1024)
    assert.equal(fit.data['toolUseId'], 't')
    const small: PultEvent = { ...ev, data: { content: 'ok' } }
    assert.equal(fitEvent(small), small)
  })
})

describe('живая подписка: событие больше строки клиента', () => {
  it('приходит урезанным, соединение окна не рвётся, следующие события идут', async () => {
    const home = tempHome()
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const got: PultEvent[] = []
      let ended: unknown = null
      const sub = await c.subscribe({ since: d.store.lastId }, (ev) => { got.push(ev) }, (e) => { ended = e })
      d.emit({ sessionId: 'w', provider: 'claude', kind: 'tool.finished', data: { toolUseId: 't', content: 'x'.repeat(3_000_000) } })
      d.emit({ sessionId: 'w', provider: 'claude', kind: 'tool.finished', data: { toolUseId: 't2', content: 'ok' } })
      assert.ok(await waitFor(() => got.length >= 2, 5000), 'события не дошли — соединение порвалось?')
      assert.equal(ended, null)
      assert.equal(got[0]?.data['toolUseId'], 't')
      assert.ok(Buffer.byteLength(JSON.stringify(got[0])) <= 900 * 1024)
      assert.equal(got[1]?.data['content'], 'ok')
      void sub
      // Журнал не урезан: полное событие — по events.get (там свой бюджет строки).
      assert.equal((d.store.readIds([got[0]?.id as number])[0]?.data['content'] as string).length, 3_000_000)
    } finally { c.close(); await d.stop('конец теста'); home.remove() }
  })
})

describe('демон: agent.browser, mcp.list, mcp.select, ход с браузером', () => {
  it('старт, тумблер, bypass — отказ, выбор серверов, --settings на ходу, вызов браузера — через Inbox, файл конфига уходит, rm и повтор имени', async () => {
    const home = tempHome()
    const cwd = tmp('pt-brw-')
    const argvOut = join(cwd, 'argv.jsonl')
    let installs = 0
    // Остаток прошлого демона: файл --mcp-config с env своих серверов — убирается на старте.
    writeFileSync(join(home.paths.run, 'mcp-old.json'), '{"secret":true}')
    const d = await startTestDaemon(home, {
      browserInstall: async (p) => { installs++; fakeInstalled(p); return { installed: true, version: PLAYWRIGHT_MCP_VERSION, path: browserPrefix(p) } },
    })
    const c = await connectClient(home.paths)
    const code = (want: string) => (e: { code?: string }): boolean => e.code === want
    try {
      assert.ok(!existsSync(join(home.paths.run, 'mcp-old.json')), 'старый --mcp-config убран на старте')
      writeFileSync(join(home.paths.home, 'claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', env: { T: 'ghp_x' } } } }))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'node', args: ['db.js'] } } }))

      // bypassPermissions у владельца — браузер Claude не включается.
      writeFileSync(join(home.paths.home, 'claude-settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
      await assert.rejects(c.request('agent.start', { name: 'b', kind: 'claude', cwd, browser: true }), (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /bypassPermissions/.test(e.message ?? ''))
      writeFileSync(join(home.paths.home, 'claude-settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }))

      await assert.rejects(c.request('agent.start', { name: 'x', kind: 'claude', cwd, browser: 'yes' }), code('invalid_params'))
      const started = (await c.request('agent.start', { name: 'w', kind: 'claude', cwd, browser: { headed: true } })) as Record<string, unknown>
      assert.deepEqual(started['browser'], { headed: true })
      const dirs = browserDirs(home.paths, 'w')
      assert.equal(started['browserDownloads'], dirs.downloads)
      assert.equal(mode(dirs.profile), 0o700)
      assert.ok(await waitFor(() => installs === 1, 3000), 'установка запущена в фоне сразу')

      await assert.rejects(c.request('agent.browser', { name: 'w' }), code('invalid_params'))
      await assert.rejects(c.request('agent.browser', { name: 'w', on: true, headed: 'да' }), code('invalid_params'))
      const off = (await c.request('agent.browser', { name: 'w', on: false })) as Record<string, unknown>
      assert.equal(off['browser'], undefined)
      assert.equal(off['browserDownloads'], undefined)
      writeFileSync(join(home.paths.home, 'claude-settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))
      await assert.rejects(c.request('agent.browser', { name: 'w', on: true }), code('invalid_params'))
      rmSync(join(home.paths.home, 'claude-settings.json'))
      assert.deepEqual(((await c.request('agent.browser', { name: 'w', on: true })) as Record<string, unknown>)['browser'], {})

      // mcp.list / mcp.select — только ~/.claude.json; .mcp.json папки не виден.
      const l = (await c.request('mcp.list', { name: 'w' })) as { servers: Array<{ name: string }>; selected: string[] }
      assert.deepEqual(l.servers.map((s) => s.name), ['github'])
      await assert.rejects(c.request('mcp.select', { names: ['pult_browser'] }), code('invalid_params'))
      await assert.rejects(c.request('mcp.select', { names: ['a b'] }), code('invalid_params'))
      await assert.rejects(c.request('mcp.select', { names: 'github' }), code('invalid_params'))
      assert.deepEqual(await c.request('mcp.select', { names: ['github', 'db', 'github'] }), { selected: ['github', 'db'] })
      assert.deepEqual((JSON.parse(readFileSync(home.paths.config, 'utf8')) as { mcp: unknown }).mcp, { servers: ['github', 'db'] })

      const st = (await c.request('daemon.status')) as { browser?: { state: string; sessions: number } }
      assert.equal(st.browser?.state, 'installed')
      assert.equal(st.browser?.sessions, 1)
      const doc = (await c.request('doctor.run', { net: false })) as { items: Array<{ id: string; status: string; detail: string }> }
      for (const id of ['browser.mcp', 'browser.chrome', 'mcp.servers']) assert.ok(doc.items.some((i) => i.id === id), id)
      assert.match(doc.items.find((i) => i.id === 'mcp.servers')?.detail ?? '', /db/, 'выбранного db нет в ~/.claude.json — доктор говорит')

      // Ход: фальшивый claude спрашивает разрешение от имени инструмента браузера — тем же кругом через Inbox.
      writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'permission', speed: 0, argvOut, askTool: `mcp__${B}__browser_navigate` }))
      await c.request('agent.prompt', { name: 'w', text: 'открой страницу' })
      let pending: Array<{ id: string; toolName: string }> = []
      assert.ok(await waitFor(async () => {
        pending = ((await c.request('perm.list', { name: 'w' })) as { pending: Array<{ id: string; toolName: string }> }).pending
        return pending.length > 0
      }, 8000), 'вопрос браузера не дошёл до Inbox')
      assert.equal(pending[0]?.toolName, `mcp__${B}__browser_navigate`)
      const argv = (JSON.parse(readFileSync(argvOut, 'utf8').trim().split('\n')[0] as string) as { argv: string[] }).argv
      const cfgPath = argv[argv.indexOf('--mcp-config') + 1] as string
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, { command: string; args?: string[] }> }
      assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['github', 'pult', B], 'db из .mcp.json — нет')
      const ba = cfg.mcpServers[B]?.args ?? []
      assert.equal(ba[3], dirs.downloads, 'cwd сервера — папка скачиваний')
      assert.equal(ba[ba.indexOf('--user-data-dir') + 1], dirs.profile)
      assert.ok(ba.includes('--headless'))
      const bp = browserPermissions(dirs)
      const run = realpathSync(home.paths.run)
      const runRules = [...new Set([home.paths.run, run])].flatMap((x) => [`Read(/${x}/**)`, `Edit(/${x}/**)`])
      assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings') + 1] as string), { permissions: { allow: bp.allow, ask: bp.ask, deny: [...runRules, ...bp.deny] } })
      // 0.3.8: --add-dir — только картинки из буфера окна этой сессии (PULT_HOME/attachments/w), скачивания браузера — нет.
      const added = argv.slice(argv.indexOf('--add-dir') + 1).filter((_a, i, all) => !all.slice(0, i + 1).some((x) => x.startsWith('--')))
      assert.ok(added.length > 0 && added.every((d) => d.endsWith('/attachments/w')), added.join(' '))
      assert.ok(!added.some((d) => d.includes(dirs.downloads)))
      await c.request('perm.resolve', { id: pending[0]?.id, decision: 'deny', message: 'нет' })
      await c.request('agent.wait', { name: 'w', timeoutMs: 8000 })
      assert.ok(await waitFor(() => !existsSync(cfgPath), 5000), 'файл --mcp-config убран, когда процесс вышел')

      // rm: профиль уходит, скачивания остаются; новая сессия с тем же именем начинает с чистого листа.
      writeFileSync(join(dirs.downloads, 'report.csv'), 'a,b')
      await c.request('agent.rm', { name: 'w' })
      assert.ok(!existsSync(dirs.profile), 'профиль с куками снят вместе с сессией')
      assert.ok(existsSync(join(dirs.downloads, 'report.csv')), 'скачивания остались')
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd })
      assert.ok(!existsSync(dirs.root), 'прежние скачивания и профиль новой сессии не достались')
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true }) }
  })
})

describe('codex: браузер в конфиге треда и вопрос о вызове инструмента', () => {
  it('isToolApproval / toolApprovalCall / elicitationAnswer — на форме живого хода codex 0.162', () => {
    const live = {
      threadId: 't', turnId: 'u', serverName: B, mode: 'form', message: `Allow the ${B} MCP server to run tool "browser_navigate"?`,
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_description: 'Navigate to a URL', tool_params: { url: 'http://x/' }, tool_params_display: [] },
    }
    assert.equal(isToolApproval(live), true)
    assert.deepEqual(toolApprovalCall(live, () => null), { server: B, tool: 'browser_navigate', args: { url: 'http://x/' } })
    const bare = { ...live, message: 'что-то другое', _meta: { codex_approval_kind: 'mcp_tool_call' } }
    assert.deepEqual(toolApprovalCall(bare, (th, s) => (th === 't' && s === B ? { tool: 'browser_click', args: { target: 'e3' } } : null)),
      { server: B, tool: 'browser_click', args: { target: 'e3' } }, 'нет в вопросе — из item/started')
    assert.deepEqual(toolApprovalCall(bare, () => null), { server: B, tool: 'tool', args: null })
    assert.equal(isToolApproval({ mode: 'url', _meta: { codex_approval_kind: 'mcp_tool_call' } }), false)
    assert.equal(isToolApproval({ mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call' }, requestedSchema: { required: ['token'] } }), false)
    assert.equal(isToolApproval({ mode: 'form', message: 'нужен токен' }), false)
    assert.deepEqual(elicitationAnswer('allow'), { action: 'accept', content: {} })
    assert.deepEqual(elicitationAnswer('deny'), { action: 'decline' })
  })

  it('config.mcp_servers.pult_browser в thread/start; карточка с аргументами; код — отказ без вопроса; смена набора — заметка, тред не трогается', async () => {
    const dir = tmp('pt-cxbrw-')
    const paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    const cwd = join(dir, 'work')
    mkdirSync(cwd, { recursive: true })
    const logOut = join(dir, 'server.jsonl')
    writeFileSync(join(paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut }))
    const drafts: EventDraft[] = []
    const broker = createBroker({ emit: (dr) => { drafts.push(dr) } })
    let servers: Record<string, Record<string, unknown>> = { [B]: { command: '/bin/sh', args: ['-c', 'true'], default_tools_approval_mode: 'prompt', disabled_tools: [...DENIED_BROWSER_TOOLS] } }
    const adapter = createCodexAdapter({
      paths, config: defaultConfig(), logger: createLogger(paths.logFile), bin: FAKE_CODEX_SCRIPTED,
      emit: (dr) => { drafts.push(dr) },
      askPermission: (req) => broker.request(req),
      netCheck: okNet,
      schemaCheck: () => ({ status: 'ok', expected: 'x', actual: 'x', files: 1, detail: 'тест' }),
      mcpExtras: async () => ({ servers }),
    })
    type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }
    const client = (): Msg[] => (existsSync(logOut) ? readFileSync(logOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ev: string; msg: Msg }).filter((r) => r.ev === 'client').map((r) => r.msg) : [])
    const answerTo = (n: number): Msg[] => client().filter((m) => m.method === undefined && typeof m.result?.['action'] === 'string').slice(n)
    try {
      await adapter.startSession({ name: 'c', cwd, mode: 'turn', broker: true })
      for (const [scenario, wantArgs] of [['mcp-tool-approval', 'tool_params'], ['mcp-tool-approval-bare', 'item/started']] as const) {
        const seen = answerTo(0).length
        const turn = await adapter.send('c', `открой [[${scenario}]]`)
        let pending: Array<{ id: string; toolName: string; input: Record<string, unknown> }> = []
        assert.ok(await waitFor(() => { pending = broker.list('c') as typeof pending; return pending.length > 0 }, 5000), `${scenario}: вопрос не дошёл до Inbox`)
        assert.equal(pending[0]?.toolName, `mcp__${B}__browser_navigate`)
        assert.deepEqual(pending[0]?.input['arguments'], { url: 'http://127.0.0.1:1/' }, `аргументы — из ${wantArgs}`)
        broker.resolve(pending[0]?.id as string, { behavior: 'allow' })
        assert.equal((await turn.done).ok, true)
        assert.ok(await waitFor(() => answerTo(seen).length > 0, 3000))
        assert.deepEqual(answerTo(seen)[0]?.result, { action: 'accept', content: {} }, '«да» один раз — без persist')
      }
      // Скриншот итога вызова — в журнал заглушкой.
      const fin = drafts.filter((dr) => dr.kind === 'tool.finished' && dr.data?.['name'] === `mcp__${B}__browser_navigate`)
      assert.ok(fin.length && fin.every((dr) => JSON.stringify(dr).length < 5000 && /изображение/.test(JSON.stringify(dr))))

      // Запрещённый инструмент: отказ без вопроса человеку.
      const before = answerTo(0).length
      assert.equal((await (await adapter.send('c', 'код [[mcp-tool-approval-denied]]')).done).ok, true)
      assert.equal(broker.list('c').length, 0)
      assert.deepEqual(answerTo(before)[0]?.result, { action: 'decline' })

      const start = client().find((m) => m.method === 'thread/start')
      assert.deepEqual((start?.params?.['config'] as { mcp_servers: unknown }).mcp_servers, servers)
      // Браузер выключили: загруженный тред Codex набор не меняет (замер) — заметка в ленту, тред не трогаем.
      servers = {}
      assert.equal((await (await adapter.send('c', 'без браузера')).done).ok, true)
      assert.equal(client().filter((m) => m.method === 'thread/unsubscribe' || m.method === 'thread/resume').length, 0)
      const notes = drafts.filter((dr) => dr.kind === 'browser.install' && dr.data?.['state'] === 'pending')
      assert.equal(notes.length, 1)
      assert.equal(notes[0]?.data?.['reason'], CODEX_BROWSER_PENDING)
      assert.equal((await (await adapter.send('c', 'ещё раз')).done).ok, true)
      assert.equal(drafts.filter((dr) => dr.kind === 'browser.install').length, 1, 'заметка — один раз на смену')
    } finally { await adapter.shutdown(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('CLI: pult browser, pult agent browser, pult mcp', () => {
  const run = (home: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
        env: { ...process.env, PULT_HOME: home, PULT_TEST: '1', PULT_TEST_NET: 'ok', PULT_CLAUDE_BIN: FAKE_CLAUDE, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pult ${args.join(' ')} не завершился`)) }, 30_000)
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
    })

  it('install без сети, статус, сессия с --browser --headed, вкл/выкл, выбор серверов', async () => {
    const dir = tmp('pt-brcli-')
    const home = join(dir, 'h')
    const cwd = join(dir, 'work')
    mkdirSync(cwd, { recursive: true })
    const env = { PULT_TEST_PLAYWRIGHT_MCP_LOCKDIR: fakeLockDir(dir) }
    try {
      const st0 = JSON.parse((await run(home, ['browser', '--json'], env)).stdout) as { installed: boolean; version: string }
      assert.equal(st0.installed, false)
      assert.equal(st0.version, PLAYWRIGHT_MCP_VERSION)
      const inst = await run(home, ['browser', 'install'], env)
      assert.equal(inst.code, 0, inst.stderr)
      assert.match(inst.stdout, /поставлен/)
      assert.match((await run(home, ['browser', 'install'], env)).stdout, /уже стоит/)

      writeFileSync(join(home, 'claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }))
      const start = await run(home, ['agent', 'start', 'w', '--kind', 'claude', '--cwd', cwd, '--browser', '--headed'], env)
      assert.equal(start.code, 0, start.stderr)
      assert.match(start.stdout, /браузер для агента: скачивания — .*browser\/w\/downloads/)
      assert.match((await run(home, ['agent', 'browser', 'w', 'off'], env)).stdout, /выключен — со следующего хода/)
      assert.equal((await run(home, ['agent', 'browser', 'w', 'maybe'], env)).code, 1)

      assert.equal((await run(home, ['mcp', 'select'], env)).code, 1, 'без имён и без --none — отказ')
      assert.match((await run(home, ['mcp', 'select', 'github', 'gone'], env)).stdout, /github/)
      const ml = await run(home, ['mcp', 'list'], env)
      assert.match(ml.stdout, /● github +stdio +gh-mcp/)
      assert.match(ml.stdout, /не подключаются: gone/)
      assert.match((await run(home, ['mcp', 'select', '--none'], env)).stdout, /не подключаются/)
      const doc = await run(home, ['doctor', '--no-net', '--json'], env)
      const items = (JSON.parse(doc.stdout) as { items: Array<{ id: string }> }).items.map((i) => i.id)
      for (const id of ['browser.mcp', 'browser.chrome', 'mcp.servers']) assert.ok(items.includes(id), id)
    } finally {
      await run(home, ['daemon', 'stop'], env).catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
