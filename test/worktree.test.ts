// `--worktree` (docs/08-PLAN-F1-M4.md §6) на НАСТОЯЩЕМ git во временных репозиториях.
//
// Две части. Первая зовёт `prepareWorktree`/`removeWorktree` напрямую — там все ветвления
// решения (новая ветка, существующая, переиспользование, «выписана в другом месте», имена,
// подкаталог, пробелы в пути, одинаковые basename). Вторая — сквозной прогон CLI против
// настоящего демона с фальшивыми `claude` и `codex`: cwd сессии, реестр после рестарта,
// `agent rm [--worktree]` и инвариант 8 (снимок временного HOME до и после).
//
// ГЕРМЕТИЧНОСТЬ git. Окружение теста чистится от `GIT_*`: прогон `npm test` из git-хука
// (pre-push) несёт `GIT_DIR`/`GIT_INDEX_FILE`, и `git init`/`commit` теста ушли бы в репозиторий
// самого Пульта. HOME — временный: глобальный ~/.gitconfig машины (хуки, init.defaultBranch)
// на тест не влияет. Имя и почта автора — в конфиге САМОГО временного репо.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ProviderAdapter } from '../dist/adapters/types.js'
import { defaultConfig } from '../dist/core/config.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { createStore } from '../dist/core/store.js'
import { createBroker } from '../dist/perm/broker.js'
import { createManager } from '../dist/sessions/manager.js'
import type { SessionManager } from '../dist/sessions/manager.js'
import { prepareWorktree, removeWorktree, repoWorktreesDir, WorktreeError, worktreeSlug } from '../dist/sessions/worktree.js'
import { FAKE_CLAUDE, FAKE_CODEX, sleep, tempHome, waitFor } from './helpers.js'
import type { TempHome } from './helpers.js'

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))

/** Окружение без `GIT_*` и с временным HOME — для git самого теста и для демона. */
function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  env['HOME'] = home
  env['GIT_CONFIG_NOSYSTEM'] = '1'
  return env
}

function gitIn(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Репозиторий с одним коммитом: корень + подкаталог sub/x. `files` — что ещё положить. */
function makeRepo(env: NodeJS.ProcessEnv, dir: string, files: Record<string, string> = {}): string {
  mkdirSync(join(dir, 'sub', 'x'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env })
  gitIn(env, dir, ['config', 'user.name', 'pult-test'])
  gitIn(env, dir, ['config', 'user.email', 'pult-test@example.invalid'])
  writeFileSync(join(dir, 'README'), 'корень\n')
  writeFileSync(join(dir, 'sub', 'x', 'f.txt'), 'файл\n')
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body)
  gitIn(env, dir, ['add', '-A'])
  gitIn(env, dir, ['commit', '-q', '-m', 'init'])
  return realpathSync(dir)
}

const branchExists = (env: NodeJS.ProcessEnv, repo: string, b: string): boolean => {
  try { gitIn(env, repo, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`]); return true } catch { return false }
}

async function rejectsCode(p: Promise<unknown>, code: string, re?: RegExp): Promise<WorktreeError> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof WorktreeError, `ждали WorktreeError, пришло ${String(e)}`)
    assert.equal(e.code, code, e.message)
    if (re) assert.match(e.message, re)
    return e
  }
  assert.fail(`ждали отказ с кодом ${code}`)
}

describe('worktree: решения prepareWorktree на настоящем git', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let home: string
  let repo: string

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-wtu-')))
    mkdirSync(join(dir, 'home'))
    env = cleanEnv(join(dir, 'home'))
    home = join(dir, 'ph')
    mkdirSync(home)
    repo = makeRepo(env, join(dir, 'repo'))
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  const prep = (o: { cwd?: string; branch: string; base?: string; inUseBy?: (p: string) => string | null }) =>
    prepareWorktree({ home, cwd: o.cwd ?? repo, branch: o.branch, env, ...(o.base ? { base: o.base } : {}), ...(o.inUseBy ? { inUseBy: o.inUseBy } : {}) })

  it('ветки нет — заводится от HEAD, папка в PULT_HOME/worktrees/<basename>-<8 hex>/<slug>', async () => {
    const r = await prep({ branch: 'feat/a' })
    assert.equal(r.action, 'created')
    assert.equal(r.worktree.branch, 'feat/a')
    assert.equal(r.worktree.repo, repo)
    assert.equal(r.worktree.path, join(repoWorktreesDir(home, repo), 'feat-a'))
    assert.match(r.worktree.path, new RegExp(`/worktrees/repo-[0-9a-f]{8}/feat-a$`))
    assert.equal(r.cwd, r.worktree.path)
    assert.equal(gitIn(env, r.worktree.path, ['branch', '--show-current']).trim(), 'feat/a')
    // Исходное дерево чистое: папка worktree вне репозитория.
    assert.equal(gitIn(env, repo, ['status', '--porcelain']), '')
    assert.equal(statSync(join(home, 'worktrees')).mode & 0o777, 0o700)
  })

  it('та же ветка ещё раз — папка переиспользуется; занята агентом — отказ с его именем', async () => {
    const r = await prep({ branch: 'feat/a' })
    assert.equal(r.action, 'reused')
    assert.equal(r.worktree.path, join(repoWorktreesDir(home, repo), 'feat-a'))
    await rejectsCode(prep({ branch: 'feat/a', inUseBy: () => 'w1' }), 'invalid_params', /занят агентом w1/)
  })

  it('ветка есть и нигде не выписана — выписывается без новой ветки; --base игнорируется и об этом сказано', async () => {
    gitIn(env, repo, ['branch', 'old'])
    const r = await prep({ branch: 'old', base: 'HEAD' })
    assert.equal(r.action, 'checked-out')
    assert.equal(r.baseIgnored, true)
    assert.equal(gitIn(env, r.worktree.path, ['branch', '--show-current']).trim(), 'old')
  })

  it('ветка выписана в другом месте — отказ с этим путём, --force не зовётся', async () => {
    await rejectsCode(prep({ branch: 'main' }), 'invalid_params', new RegExp(`уже выписана в ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    // Выписанная ручным `git worktree add` снаружи PULT_HOME — то же самое.
    const outside = join(dir, 'manual')
    gitIn(env, repo, ['worktree', 'add', '-q', '-b', 'manual', outside])
    await rejectsCode(prep({ branch: 'manual' }), 'invalid_params', /уже выписана в .*manual/)
  })

  it('недопустимые имена веток отвергаются, ничего не создаётся', async () => {
    const before = readdirSync(join(home, 'worktrees'), { recursive: true }).length
    for (const bad of ['a..b', '-x', 'a b', 'x~1', 'a.lock', '@{-1}', '']) {
      await rejectsCode(prep({ branch: bad }), 'invalid_params', /недопустимое имя ветки/)
    }
    assert.equal(readdirSync(join(home, 'worktrees'), { recursive: true }).length, before)
  })

  it('cwd не в репозитории — invalid_params', async () => {
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    await rejectsCode(prep({ cwd: plain, branch: 'feat/z' }), 'invalid_params', /не внутри git-репозитория/)
  })

  it('cwd в подкаталоге — сессия встаёт в тот же подкаталог внутри worktree', async () => {
    const r = await prep({ cwd: join(repo, 'sub', 'x'), branch: 'feat/sub' })
    assert.equal(r.cwd, join(r.worktree.path, 'sub', 'x'))
    assert.ok(existsSync(join(r.cwd, 'f.txt')))
  })

  it('подкаталога нет в выписанной ветке — отказ, пустую папку не выдумываем', async () => {
    mkdirSync(join(repo, 'fresh'))
    writeFileSync(join(repo, 'fresh', 'n.txt'), 'n\n')
    gitIn(env, repo, ['add', 'fresh'])
    gitIn(env, repo, ['commit', '-q', '-m', 'fresh'])
    gitIn(env, repo, ['branch', 'before-fresh', 'HEAD~1'])
    await rejectsCode(prep({ cwd: join(repo, 'fresh'), branch: 'before-fresh' }), 'invalid_params', /нет подкаталога fresh/)
  })

  it('--base: новая ветка от указанной ревизии; неизвестная база и база-опция отвергаются', async () => {
    const first = gitIn(env, repo, ['rev-parse', 'HEAD~1']).trim()
    const r = await prep({ branch: 'from-base', base: 'HEAD~1' })
    assert.equal(r.action, 'created')
    assert.equal(gitIn(env, r.worktree.path, ['rev-parse', 'HEAD']).trim(), first)
    await rejectsCode(prep({ branch: 'nobase', base: 'нет-такой' }), 'invalid_params', /не найдена/)
    await rejectsCode(prep({ branch: 'optbase', base: '--orphan' }), 'invalid_params', /не найдена/)
    assert.equal(branchExists(env, repo, 'nobase'), false)
    assert.equal(branchExists(env, repo, 'optbase'), false)
  })

  it('путь репозитория с пробелами работает', async () => {
    const spaced = makeRepo(env, join(dir, 'my repo & co'))
    const r = await prep({ cwd: spaced, branch: 'feat/s' })
    assert.equal(r.worktree.repo, spaced)
    assert.match(r.worktree.path, /\/worktrees\/my repo & co-[0-9a-f]{8}\/feat-s$/)
    assert.equal(gitIn(env, r.worktree.path, ['branch', '--show-current']).trim(), 'feat/s')
  })

  it('два репозитория с одинаковым basename не делят папку', async () => {
    const a = makeRepo(env, join(dir, 'one', 'app'))
    const b = makeRepo(env, join(dir, 'two', 'app'))
    const ra = await prep({ cwd: a, branch: 'feat/same' })
    const rb = await prep({ cwd: b, branch: 'feat/same' })
    assert.notEqual(ra.worktree.path, rb.worktree.path)
    assert.equal(ra.action, 'created')
    assert.equal(rb.action, 'created')
  })

  it('имя папки занято другой веткой (a/b и a-b) — второй достаётся папка с хэшем', async () => {
    assert.equal(worktreeSlug('a/b'), 'a-b')
    assert.equal(worktreeSlug('ж/б'), '_-_')
    const r1 = await prep({ branch: 'a/b' })
    const r2 = await prep({ branch: 'a-b' })
    assert.notEqual(r1.worktree.path, r2.worktree.path)
    assert.match(r2.worktree.path, /\/a-b-[0-9a-f]{8}$/)
    // И повторный старт второй ветки находит ту же папку.
    assert.equal((await prep({ branch: 'a-b' })).worktree.path, r2.worktree.path)
  })

  it('removeWorktree: чистое дерево уходит, ветка остаётся; грязное — отказ текстом git', async () => {
    const clean = await prep({ branch: 'rm/clean' })
    await removeWorktree(clean.worktree, env)
    assert.equal(existsSync(clean.worktree.path), false)
    assert.equal(branchExists(env, repo, 'rm/clean'), true, 'ветка не удаляется никогда')

    const dirty = await prep({ branch: 'rm/dirty' })
    writeFileSync(join(dirty.worktree.path, 'README'), 'правка агента\n')
    await rejectsCode(removeWorktree(dirty.worktree, env), 'git_failed', /modified or untracked|изменённые|--force/)
    assert.ok(existsSync(join(dirty.worktree.path, 'README')), 'грязное дерево обязано остаться')

    const untracked = await prep({ branch: 'rm/untracked' })
    writeFileSync(join(untracked.worktree.path, 'new.txt'), 'новый файл\n')
    await rejectsCode(removeWorktree(untracked.worktree, env), 'git_failed')
    assert.ok(existsSync(join(untracked.worktree.path, 'new.txt')))
  })
})

// ---------------------------------------------------------------------------------------------

interface Run { code: number; stdout: string; stderr: string }

/** Снимок дерева: путь → «тип:размер:mtime». Пропускаются поддеревья из `skip`. */
function snapshot(root: string, skip: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (skip.some((s) => p === s || p.startsWith(s + '/'))) continue
      const st = statSync(p)
      out.set(p, `${st.isDirectory() ? 'd' : 'f'}:${st.isDirectory() ? '' : st.size}:${st.mtimeMs}`)
      if (st.isDirectory()) walk(p)
    }
  }
  walk(root)
  return out
}

function diff(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = []
  for (const [k, v] of a) if (b.get(k) !== v) out.push(`${b.has(k) ? 'изменён' : 'исчез'}: ${k}`)
  for (const k of b.keys()) if (!a.has(k)) out.push(`появился: ${k}`)
  return out
}

describe('worktree: сквозной прогон CLI с фальшивыми claude и codex', () => {
  let dir: string
  let fakeHome: string
  let paths: PultPaths
  let repo: string
  let env: NodeJS.ProcessEnv
  let argvLog: string
  let serverLog: string

  function runCli(args: string[], timeoutMs = 25_000): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: {
          ...env, PULT_HOME: paths.home, PULT_TEST: '1', PULT_TEST_NET: 'ok',
          PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pult ${args.join(' ')} не завершился`)) }, timeoutMs)
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
    })
  }

  const claudeCwds = (): string[] => existsSync(argvLog)
    ? readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((l) => String((JSON.parse(l) as { cwd: string }).cwd))
    : []
  const threadCwds = (): string[] => existsSync(serverLog)
    ? readFileSync(serverLog, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { ev?: string; msg?: { method?: string; params?: { cwd?: string } } })
      .filter((r) => r.ev === 'client' && (r.msg?.method === 'thread/start' || r.msg?.method === 'thread/resume'))
      .map((r) => String(r.msg?.params?.cwd))
    : []
  const list = async (): Promise<Array<{ name: string; cwd: string; worktree?: { path: string; branch: string; repo: string } }>> =>
    (JSON.parse((await runCli(['agent', 'list', '--json'])).stdout) as { sessions: Array<{ name: string; cwd: string; worktree?: { path: string; branch: string; repo: string } }> }).sessions

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-wt-')))
    fakeHome = join(dir, 'home')
    mkdirSync(fakeHome)
    env = cleanEnv(fakeHome)
    paths = layout(join(fakeHome, '.pult'))
    ensureLayout(paths)
    argvLog = join(dir, 'claude-argv.jsonl')
    serverLog = join(dir, 'server.jsonl')
    // Настройка фальшивого claude едет В РЕПОЗИТОРИИ: он читает её из своего cwd, а cwd — это
    // worktree. Закоммичена — значит, дерево worktree чистое, и `rm --worktree` его уберёт.
    const fake = JSON.stringify({ scenario: 'simple', speed: 0, argvOut: argvLog })
    repo = makeRepo(env, join(fakeHome, 'repo'), { '.pult-fake.json': fake, 'sub/x/.pult-fake.json': fake })
    writeFileSync(join(paths.home, '.pult-fake-codex.json'), JSON.stringify({ scenario: 'simple', speed: 0, logOut: serverLog }))
  })
  after(async () => {
    await runCli(['daemon', 'stop'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('ИНВАРИАНТ 8: agent start --worktree пишет только в PULT_HOME и .git исходного репо', async () => {
    // Демон поднимаем ЗАРАНЕЕ: его собственная раскладка PULT_HOME в снимок не входит, но
    // первый старт по требованию — отдельное событие, которое этот тест не проверяет.
    assert.equal((await runCli(['daemon', 'start'])).code, 0)
    const skip = [paths.home, join(repo, '.git')]
    const before = snapshot(fakeHome, skip)
    const r = await runCli(['agent', 'start', 'c1', '--kind', 'claude', '--cwd', join(repo, 'sub', 'x'), '--worktree', 'feat/one'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(diff(before, snapshot(fakeHome, skip)), [], 'запись вне PULT_HOME и .git исходного репо')
    assert.equal(gitIn(env, repo, ['status', '--porcelain']), '', 'исходное дерево не тронуто')
    assert.ok(readdirSync(join(repo, '.git', 'worktrees')).length > 0, 'git записал служебные файлы worktree')
  })

  it('agent start печатает worktree; list --json и list хранят {path, branch, repo}; cwd — подкаталог внутри', async () => {
    const s = (await list()).find((x) => x.name === 'c1')
    assert.ok(s?.worktree)
    assert.equal(s.worktree.branch, 'feat/one')
    assert.equal(s.worktree.repo, repo)
    assert.ok(s.worktree.path.startsWith(realpathSync(paths.home) + '/worktrees/repo-'), s.worktree.path)
    assert.equal(s.cwd, join(s.worktree.path, 'sub', 'x'))
    const text = await runCli(['agent', 'list'])
    assert.match(text.stdout, /c1 .* worktree .*feat-one \(feat\/one\)/)
  })

  it('claude: ход идёт в cwd worktree; agent read показывает worktree', async () => {
    const r = await runCli(['agent', 'prompt', 'c1', 'скажи PULT', '--wait'])
    assert.equal(r.code, 0, r.stderr)
    const wt = (await list()).find((x) => x.name === 'c1')?.worktree
    assert.ok(wt)
    assert.ok(await waitFor(() => claudeCwds().length >= 1))
    assert.deepEqual(claudeCwds(), [join(wt.path, 'sub', 'x')])
    const read = await runCli(['agent', 'read', 'c1'])
    assert.equal(read.code, 0)
    assert.match(read.stdout, /PULT/)
    assert.match(read.stderr, /worktree .*feat-one · ветка feat\/one/)
  })

  it('рестарт демона: реестр помнит worktree, ленивый resume идёт в ту же папку', async () => {
    assert.equal((await runCli(['daemon', 'stop'])).code, 0)
    const r = await runCli(['agent', 'prompt', 'c1', 'ещё раз', '--wait'])
    assert.equal(r.code, 0, r.stderr)
    const wt = (await list()).find((x) => x.name === 'c1')?.worktree
    assert.equal(wt?.branch, 'feat/one')
    assert.ok(await waitFor(() => claudeCwds().length >= 2))
    assert.deepEqual(claudeCwds(), [join(wt.path, 'sub', 'x'), join(wt.path, 'sub', 'x')])
  })

  it('codex: тред заводится с cwd worktree', async () => {
    const r = await runCli(['agent', 'start', 'x1', '--kind', 'codex', '--cwd', repo, '--worktree', 'feat/cx'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /worktree .*feat-cx · ветка feat\/cx \(новая ветка\)/)
    const p = await runCli(['agent', 'prompt', 'x1', 'скажи OK', '--wait'])
    assert.equal(p.code, 0, p.stderr)
    const wt = (await list()).find((x) => x.name === 'x1')?.worktree
    assert.ok(wt)
    assert.ok(await waitFor(() => threadCwds().length >= 1))
    assert.deepEqual(threadCwds(), [wt.path])
  })

  it('agent rm без --worktree оставляет папку и печатает путь; повторный start её переиспользует', async () => {
    const wt = (await list()).find((x) => x.name === 'c1')?.worktree
    assert.ok(wt)
    const rm = await runCli(['agent', 'rm', 'c1'])
    assert.equal(rm.code, 0, rm.stderr)
    assert.ok(rm.stdout.includes(`worktree оставлен: ${wt.path} (ветка feat/one)`), rm.stdout)
    assert.match(rm.stdout, /убрать: git -C .* worktree remove /)
    assert.ok(existsSync(wt.path))

    const again = await runCli(['agent', 'start', 'c2', '--kind', 'claude', '--cwd', join(repo, 'sub', 'x'), '--worktree', 'feat/one'])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /папка переиспользована/)
    assert.equal((await list()).find((x) => x.name === 'c2')?.worktree?.path, wt.path)
  })

  it('второй агент в занятый worktree не пускается', async () => {
    const r = await runCli(['agent', 'start', 'c3', '--kind', 'claude', '--cwd', repo, '--worktree', 'feat/one'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /занят агентом c2/)
    assert.equal((await list()).some((x) => x.name === 'c3'), false)
  })

  it('agent rm --worktree: грязное дерево — код 1 с текстом git, сессия и папка на месте; чистое — уходит, ветка остаётся', async () => {
    const wt = (await list()).find((x) => x.name === 'c2')?.worktree
    assert.ok(wt)
    const dirtyFile = join(wt.path, 'sub', 'x', 'f.txt')
    writeFileSync(dirtyFile, 'правка агента\n')
    const refused = await runCli(['agent', 'rm', 'c2', '--worktree'])
    assert.equal(refused.code, 1, refused.stdout)
    assert.match(refused.stderr, /git_failed/)
    assert.match(refused.stderr, /modified or untracked|--force/)
    assert.ok((await list()).some((x) => x.name === 'c2'), 'сессия не удаляется, если git отказал')
    assert.ok(existsSync(dirtyFile))

    gitIn(env, wt.path, ['checkout', '--', 'sub/x/f.txt'])
    const ok = await runCli(['agent', 'rm', 'c2', '--worktree'])
    assert.equal(ok.code, 0, ok.stderr)
    assert.match(ok.stdout, /worktree .* убран; ветка feat\/one осталась/)
    assert.equal(existsSync(wt.path), false)
    assert.equal(branchExists(env, repo, 'feat/one'), true)
    assert.equal((await list()).some((x) => x.name === 'c2'), false)
  })

  it('rm --worktree у агента без worktree — отказ, агент остаётся', async () => {
    const plain = join(dir, 'plain')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0 }))
    assert.equal((await runCli(['agent', 'start', 'p1', '--cwd', plain])).code, 0)
    const r = await runCli(['agent', 'rm', 'p1', '--worktree'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /без --worktree/)
    assert.equal((await runCli(['agent', 'rm', 'p1'])).code, 0)
  })

  it('отказы CLI: ветка выписана в репо, cwd не в репо, кривое имя, --worktree без значения, --base без --worktree', async () => {
    const main = await runCli(['agent', 'start', 'e1', '--cwd', repo, '--worktree', 'main'])
    assert.equal(main.code, 1)
    assert.ok(main.stderr.includes(`ветка main уже выписана в ${repo}`), main.stderr)

    const plain = join(dir, 'plain')
    const notRepo = await runCli(['agent', 'start', 'e2', '--cwd', plain, '--worktree', 'feat/q'])
    assert.equal(notRepo.code, 1)
    assert.match(notRepo.stderr, /invalid_params .*не внутри git-репозитория/)

    const bad = await runCli(['agent', 'start', 'e3', '--cwd', repo, '--worktree', 'a b'])
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /invalid_params .*недопустимое имя ветки/)

    const bare = await runCli(['agent', 'start', 'e4', '--cwd', repo, '--worktree'])
    assert.equal(bare.code, 1)
    assert.match(bare.stderr, /--worktree требует имя ветки/)

    const baseOnly = await runCli(['agent', 'start', 'e5', '--cwd', repo, '--base', 'HEAD'])
    assert.equal(baseOnly.code, 1)
    assert.match(baseOnly.stderr, /--base имеет смысл только вместе с --worktree/)

    // `--worktree=` с пустым значением (скрипт подставил пустую $BRANCH) — тот же отказ, что и
    // голый `--worktree`: раньше пустая строка проходила проверку `=== true`, а flagStr её
    // выбрасывал, и агент молча заводился в общей папке репо с кодом 0.
    const emptyWt = await runCli(['agent', 'start', 'e6', '--cwd', repo, '--worktree='])
    assert.equal(emptyWt.code, 1, `ожидали отказ, получили ${emptyWt.code}: ${emptyWt.stdout}`)
    assert.match(emptyWt.stderr, /--worktree требует имя ветки/)
    const emptyBase = await runCli(['agent', 'start', 'e7', '--cwd', repo, '--worktree', 'feat/e7', '--base='])
    assert.equal(emptyBase.code, 1, `ожидали отказ, получили ${emptyBase.code}: ${emptyBase.stdout}`)
    assert.match(emptyBase.stderr, /--base требует ревизию/)
    assert.equal(branchExists(env, repo, 'feat/e7'), false, 'ветка заведена от HEAD вместо отказа')

    const names = (await list()).map((x) => x.name)
    for (const n of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']) assert.equal(names.includes(n), false, n)
  })

  it('ветка/база на «-»: отказ с этим значением, а не «требует имя ветки»', async () => {
    // Значение есть — просто начинается с «-». Разбор его не берёт (защита от опций git), и раньше
    // CLI говорил «--worktree требует имя ветки», хотя имя человек дал.
    const cases: Array<[string[], RegExp]> = [
      [['--worktree', '-x'], /ветка не может начинаться с «-»: -x/],
      [['--worktree', '--upload-pack=x'], /ветка не может начинаться с «-»: --upload-pack=x/],
      [['--worktree=-x'], /ветка не может начинаться с «-»: -x/],
      [['--worktree', 'feat/d1', '--base', '-x'], /--base: ревизия не может начинаться с «-»: -x/],
      [['--worktree', 'feat/d1', '--base=--upload-pack=x'], /--base: ревизия не может начинаться с «-»: --upload-pack=x/],
    ]
    for (const [flags, re] of cases) {
      const r = await runCli(['agent', 'start', 'd1', '--cwd', repo, ...flags])
      assert.equal(r.code, 1, `${flags.join(' ')}: ожидали отказ, получили ${r.code}: ${r.stdout}`)
      assert.match(r.stderr, re, `${flags.join(' ')}: ${r.stderr}`)
    }
    // Настоящий флаг Пульта следом — это по-прежнему «значения нет».
    const missing = await runCli(['agent', 'start', 'd1', '--cwd', repo, '--worktree', '--json'])
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /--worktree требует имя ветки/)
    assert.equal(branchExists(env, repo, 'feat/d1'), false)
    assert.equal((await list()).some((x) => x.name === 'd1'), false)
  })
})

// ---------------------------------------------------------------------------------------------

describe('worktree: гонки agent.start в менеджере (адаптер на затворе)', () => {
  // Затвор в `startSession` держит первый старт МЕЖДУ worktree и записью в реестр — ровно в
  // том окне, где раньше проходили гонки. Сквозным прогоном CLI окно ловится только случайно.
  let dir: string
  let env: NodeJS.ProcessEnv
  let repo: string

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-wtr-')))
    mkdirSync(join(dir, 'home'))
    env = cleanEnv(join(dir, 'home'))
    repo = makeRepo(env, join(dir, 'repo'))
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  function gatedManager(home: TempHome): { manager: SessionManager; open(): void; entered: () => number; close(): void } {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    let entered = 0
    const adapter = {
      async startSession(spec: { name: string }) { entered++; await gate; return { providerSessionId: `p-${spec.name}` } },
      async send() { throw new Error('не нужен') },
      async respondPermission() {},
      async interrupt() {},
      async resume() {},
      async close() {},
      blocked: () => ({ blocked: false }),
      reset() {},
      async shutdown() {},
    } as unknown as ProviderAdapter
    const store = createStore(home.paths)
    const manager = createManager({
      paths: home.paths, config: defaultConfig(), logger: home.logger, store,
      publish: (d) => store.append(d),
      adapters: { claude: adapter },
      broker: createBroker({ emit: () => {} }),
      env,
    })
    return { manager, open: () => release(), entered: () => entered, close: () => store.close() }
  }

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try { await p; return 'ok' } catch (e) { return String((e as { code?: string }).code) }
  }

  it('два старта одной ветки разом: второй не садится в папку первого', async () => {
    const home = tempHome()
    const g = gatedManager(home)
    try {
      const first = codeOf(g.manager.start({ name: 'r1', kind: 'claude', cwd: repo, worktree: 'feat/race' }))
      assert.ok(await waitFor(() => g.entered() === 1), 'первый старт дошёл до адаптера')
      // Первый уже получил папку, но в реестр ещё не записан. Старый код пускал второго в ту же
      // папку, и тот вставал на затворе адаптера — отсюда ожидание с потолком, а не голый await.
      const second = await Promise.race([
        codeOf(g.manager.start({ name: 'r2', kind: 'claude', cwd: repo, worktree: 'feat/race' })),
        sleep(5000).then(() => 'дошёл до адаптера'),
      ])
      g.open()
      assert.equal(await first, 'ok')
      assert.equal(second, 'invalid_params')
      assert.deepEqual(g.manager.list().map((s) => s.name), ['r1'])
    } finally { g.open(); g.close(); home.remove() }
  })

  it('два старта одного имени разом: заводится ровно один, второй — отказ', async () => {
    const home = tempHome()
    const g = gatedManager(home)
    try {
      // `codeOf` навешивается СРАЗУ: отказ второго приходит раньше, чем его кто-то ждёт, и
      // неподхваченный отказ node:test засчитал бы тесту как unhandledRejection.
      const first = codeOf(g.manager.start({ name: 'n1', kind: 'claude', cwd: repo, worktree: 'feat/n-a' }))
      const second = codeOf(g.manager.start({ name: 'n1', kind: 'claude', cwd: repo, worktree: 'feat/n-b' }))
      assert.ok(await waitFor(() => g.entered() >= 1))
      await sleep(300)
      g.open()
      const codes = [await first, await second]
      assert.deepEqual(codes, ['ok', 'invalid_params'])
      assert.equal(g.entered(), 1, 'второй старт не имеет права дойти до адаптера')
      assert.equal(g.manager.list().length, 1)
      // Ветку второго никто не заводил.
      assert.equal(branchExists(env, repo, 'feat/n-b'), false)
    } finally { g.open(); g.close(); home.remove() }
  })
})

describe('worktree: гонка agent rm --worktree и agent prompt в менеджере', () => {
  // Git здесь медленный НАРОЧНО: обёртка в PATH менеджера перед `worktree remove` оставляет
  // метку и ждёт файла-разрешения — ровно то окно, в котором раньше `prompt` заводил новый ход в
  // папке, которую `rm --worktree` в этот момент удалял. Окно держит СОБЫТИЕ (тест кладёт
  // разрешение после своих проверок), а не `sleep 1`: под нагрузкой секунды могло не хватить.
  // По умолчанию разрешение лежит, и остальные тесты блока идут без задержки.
  let dir: string
  let env: NodeJS.ProcessEnv
  let slowEnv: NodeJS.ProcessEnv
  let repo: string
  let marker: string
  let release: string

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-wtx-')))
    mkdirSync(join(dir, 'home'))
    env = cleanEnv(join(dir, 'home'))
    repo = makeRepo(env, join(dir, 'repo'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    marker = join(dir, 'remove-entered')
    release = join(dir, 'remove-release')
    writeFileSync(release, '')
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { env, encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      // Потолок ожидания 60 с (1200 × 0,05 с): забытое разрешение не вешает прогон навсегда.
      `if [ "$3" = worktree ] && [ "$4" = remove ]; then : > '${marker}'; i=0; while [ ! -e '${release}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; fi`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'))
    chmodSync(join(bin, 'git'), 0o755)
    slowEnv = { ...env, PATH: `${bin}:${env['PATH'] ?? '/usr/bin:/bin'}` }
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  function turnManager(home: TempHome, resumeGate?: Promise<void>): { manager: SessionManager; sends: () => number; resumes: () => number; close(): void } {
    let sends = 0
    let resumes = 0
    const adapter = {
      async startSession(spec: { name: string }) { return { providerSessionId: `p-${spec.name}` } },
      async send() {
        sends++
        const turnId = `t${sends}`
        return { turnId, done: Promise.resolve({ turnId, ok: true }) }
      },
      async respondPermission() {},
      async interrupt() {},
      async resume() { resumes++; if (resumeGate) await resumeGate },
      async close() {},
      blocked: () => ({ blocked: false }),
      reset() {},
      async shutdown() {},
    } as unknown as ProviderAdapter
    const store = createStore(home.paths)
    const manager = createManager({
      paths: home.paths, config: defaultConfig(), logger: home.logger, store,
      publish: (d) => store.append(d),
      adapters: { claude: adapter },
      broker: createBroker({ emit: () => {} }),
      env: slowEnv,
    })
    return { manager, sends: () => sends, resumes: () => resumes, close: () => store.close() }
  }

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try { await p; return 'ok' } catch (e) { return String((e as { code?: string }).code) }
  }

  it('prompt посреди git worktree remove — отказ, ход не заводится; rm доходит до конца', async () => {
    const home = tempHome()
    const t = turnManager(home)
    try {
      rmSync(marker, { force: true })
      rmSync(release, { force: true })
      await t.manager.start({ name: 'x1', kind: 'claude', cwd: repo, worktree: 'feat/rm-race' })
      const rm = codeOf(t.manager.rm('x1', { worktree: true }))
      assert.ok(await waitFor(() => existsSync(marker), 10_000), 'rm не дошёл до git worktree remove')
      const pr = await codeOf(t.manager.prompt('x1', 'ход в удаляемой папке'))
      assert.equal(pr, 'invalid_params', `prompt во время rm --worktree: ${pr}`)
      assert.equal(t.sends(), 0, 'новый ход заведён в папке, которую удаляет git worktree remove')
      writeFileSync(release, '')
      assert.equal(await rm, 'ok')
      assert.deepEqual(t.manager.list(), [])
    } finally { writeFileSync(release, ''); t.close(); home.remove() }
  })

  it('rm --worktree, пока prompt заводит ход (ещё до inflight), — отказ «делает ход», папка на месте', async () => {
    const home = tempHome()
    let open: () => void = () => {}
    const gate = new Promise<void>((r) => { open = r })
    const t = turnManager(home, gate)
    try {
      const rec = await t.manager.start({ name: 'x2', kind: 'claude', cwd: repo, worktree: 'feat/rm-race-2' })
      const wtPath = (rec as { worktree?: { path: string } }).worktree?.path ?? ''
      const pr = codeOf(t.manager.prompt('x2', 'ход'))
      assert.ok(await waitFor(() => t.resumes() === 1), 'prompt не дошёл до adapter.resume')
      const rm = await Promise.race([codeOf(t.manager.rm('x2', { worktree: true })), sleep(5000).then(() => 'висит')])
      assert.equal(rm, 'invalid_params', `rm --worktree посреди старта хода: ${rm}`)
      assert.ok(existsSync(wtPath), 'worktree удалён из-под заводящегося хода')
      open()
      assert.equal(await pr, 'ok')
      assert.equal(t.sends(), 1)
    } finally { open(); t.close(); home.remove() }
  })

  it('git отказал (грязное дерево) — бронь снята: следующий prompt проходит', async () => {
    const home = tempHome()
    const t = turnManager(home)
    try {
      const rec = await t.manager.start({ name: 'x3', kind: 'claude', cwd: repo, worktree: 'feat/rm-race-3' })
      writeFileSync(join((rec as { worktree?: { path: string } }).worktree?.path ?? '', 'dirty.txt'), 'правка\n')
      assert.equal(await codeOf(t.manager.rm('x3', { worktree: true })), 'git_failed')
      assert.equal(await codeOf(t.manager.prompt('x3', 'после отказа git')), 'ok')
      assert.equal(t.sends(), 1)
    } finally { t.close(); home.remove() }
  })
})

describe('worktree: папка сессии над PULT_HOME проверяется по настоящей папке сессии', () => {
  // Репозиторий в папке, которая накрывает PULT_HOME (как git в `~` при PULT_HOME = ~/.pult): `--cwd` без
  // worktree — отказ; с worktree агент живёт в PULT_HOME/worktrees/…, а не в `--cwd`, — ложного отказа нет.
  let dir: string
  let env: NodeJS.ProcessEnv
  let repo: string
  let paths: PultPaths

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-wth-')))
    mkdirSync(join(dir, 'home'))
    env = cleanEnv(join(dir, 'home'))
    repo = makeRepo(env, join(dir, 'repo'))
    paths = layout(join(repo, 'ph'))
    ensureLayout(paths)
  })
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('без worktree — отказ; с worktree — сессия в PULT_HOME/worktrees', async () => {
    const adapter = {
      async startSession(spec: { name: string }) { return { providerSessionId: `p-${spec.name}` } },
      async send() { throw new Error('не нужен') },
      async respondPermission() {},
      async interrupt() {},
      async resume() {},
      async close() {},
      blocked: () => ({ blocked: false }),
      reset() {},
      async shutdown() {},
    } as unknown as ProviderAdapter
    const logs = tempHome()
    const store = createStore(paths)
    const manager = createManager({
      paths, config: defaultConfig(), logger: logs.logger, store,
      publish: (d) => store.append(d),
      adapters: { claude: adapter },
      broker: createBroker({ emit: () => {} }),
      env,
    })
    try {
      await assert.rejects(() => manager.start({ name: 'plain', kind: 'claude', cwd: repo }),
        (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /возьми папку проекта/.test(e.message ?? ''))
      const rec = await manager.start({ name: 'wt', kind: 'claude', cwd: repo, worktree: 'feat/home' })
      assert.ok(rec.cwd.startsWith(join(paths.home, 'worktrees') + '/'), rec.cwd)
      // И дальше: смена режима на «правки без вопросов» проверяет папку worktree, а не `--cwd`.
      const r = await manager.configure({ name: 'wt', approval: 'workspace' })
      assert.equal(r.record.approval, 'workspace')
      await manager.rm('wt', { worktree: true })
    } finally {
      await manager.shutdown()
      store.close()
      logs.remove()
    }
  })
})
