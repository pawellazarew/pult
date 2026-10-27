// Окружение: белый список, разбор логин-шелла, поиск CLI на фальшивой файловой системе.

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildChildEnv, ENV_ALLOWLIST } from '../dist/env/allowlist.js'
import { execAsync } from '../dist/env/exec.js'
import { resolveChildNode, stableNodePath } from '../dist/env/nodeBin.js'
import { locateAll, locateAllAsync, locateTool, locateToolAsync, locateToolPath, codexInsideChatGPTApp, TOOLS } from '../dist/env/locate.js'
import type { LocateDeps } from '../dist/env/locate.js'
import {
  captureLoginEnv, parseNulEnv, readEnvCache, sanitizePathEntries, toCacheFile, writeEnvCache,
} from '../dist/env/loginShell.js'
import { tempHome } from './helpers.js'
import { daemonSpawnEnv } from '../dist/cli/startOnDemand.js'
import { layout } from '../dist/core/paths.js'

it('тестовая задержка обновления доходит до демона и не проходит вне PULT_TEST=1', () => {
  const paths = layout('/tmp/pult-env-test')
  assert.equal(daemonSpawnEnv(paths, { PULT_TEST: '1', PULT_TEST_UPDATE_HOLD_MS: '8000' })['PULT_TEST_UPDATE_HOLD_MS'], '8000')
  assert.equal(daemonSpawnEnv(paths, { PULT_TEST_UPDATE_HOLD_MS: '8000' })['PULT_TEST_UPDATE_HOLD_MS'], undefined)
})

/**
 * Пульс событийного цикла: самый длинный промежуток между тиками таймера, пока идёт `fn`.
 * Синхронный запуск процесса (`spawnSync`) виден здесь как промежуток длиной во весь запуск.
 */
async function maxLoopGap<T>(fn: () => Promise<T>): Promise<{ value: T; gap: number; ms: number }> {
  let last = Date.now()
  let gap = 0
  const beat = setInterval(() => { const now = Date.now(); gap = Math.max(gap, now - last); last = now }, 10)
  const t0 = Date.now()
  try {
    const value = await fn()
    gap = Math.max(gap, Date.now() - last)
    return { value, gap, ms: Date.now() - t0 }
  } finally {
    clearInterval(beat)
  }
}

/** Исполняемый sh-скрипт во временной папке: «CLI», который думает `sleepS` секунд. */
function script(dir: string, name: string, body: string): string {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

describe('белый список окружения', () => {
  it('ни одна переменная ANTHROPIC_*/CLAUDE_*/OPENAI_*/CODEX_* родителя не доходит до ребёнка', () => {
    const parent: NodeJS.ProcessEnv = {
      HOME: '/Users/кто-то',
      USER: 'кто-то',
      PATH: '/usr/bin:/bin',
      LANG: 'ru_RU.UTF-8',
      TERM: 'xterm',
      TMPDIR: '/tmp/',
      ANTHROPIC_BASE_URL: 'https://злой.example.com',
      ANTHROPIC_API_KEY: 'секрет',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/чужая-сессия.sock',
      CLAUDE_CODE_ENTRYPOINT: 'desktop',
      OPENAI_API_KEY: 'секрет',
      OPENAI_BASE_URL: 'https://злой.example.com',
      CODEX_HOME: '/чужой/codex',
      CODEX_SANDBOX: 'danger-full-access',
      npm_config_registry: 'https://злой.example.com',
    }
    const child = buildChildEnv(parent)
    const names = Object.keys(child)
    assert.deepEqual(names.sort(), [...ENV_ALLOWLIST].sort())
    for (const bad of names.filter((n) => /^(ANTHROPIC|CLAUDE|OPENAI|CODEX)/i.test(n))) {
      assert.fail(`переменная ${bad} просочилась ребёнку`)
    }
    assert.equal(child['ANTHROPIC_BASE_URL'], undefined)
    assert.equal(child['CLAUDE_CODE_MESSAGING_SOCKET'], undefined)
    assert.equal(child['OPENAI_API_KEY'], undefined)
    assert.equal(child['CODEX_HOME'], undefined)
  })

  it('профиль сети и явный PATH добавляются поверх', () => {
    const child = buildChildEnv({ HOME: '/h' }, {
      path: '/opt/homebrew/bin:/usr/bin',
      network: { HTTPS_PROXY: 'http://127.0.0.1:3128', NO_PROXY: 'localhost' },
    })
    assert.equal(child['PATH'], '/opt/homebrew/bin:/usr/bin')
    assert.equal(child['HTTPS_PROXY'], 'http://127.0.0.1:3128')
    assert.equal(child['NO_PROXY'], 'localhost')
  })

  it('без PATH у родителя подставляется запасной', () => {
    const child = buildChildEnv({ HOME: '/h' })
    assert.match(child['PATH'] as string, /\/usr\/bin/)
  })

  it('у объекта окружения нет прототипа: toString не станет переменной', () => {
    const child = buildChildEnv({ HOME: '/h' })
    assert.equal(Object.getPrototypeOf(child), null)
  })
})

describe('логин-шелл', () => {
  it('разбор env -0 переживает значение с переводом строки', () => {
    const raw = 'HOME=/Users/кто-то\0PATH=/usr/bin:/bin\0MULTI=первая\nвторая\0СЛОМАНО\0'
    const { vars, malformed } = parseNulEnv(raw)
    assert.equal(vars['HOME'], '/Users/кто-то')
    assert.equal(vars['MULTI'], 'первая\nвторая')
    assert.equal(malformed, 1)
  })

  it('PATH чистится от нераскрытых ~ и дублей, порядок сохраняется', () => {
    const r = sanitizePathEntries('/opt/homebrew/bin:~/bin:/usr/bin:/opt/homebrew/bin::/bin')
    assert.deepEqual(r.entries, ['/opt/homebrew/bin', '/usr/bin', '/bin'])
    assert.deepEqual(r.droppedTilde, ['~/bin'])
    assert.deepEqual(r.droppedDuplicates, ['/opt/homebrew/bin'])
  })

  it('захват идёт под env -i и с таймаутом 3 с', async () => {
    const calls: Array<{ file: string; args: string[]; timeout: number }> = []
    const env = await captureLoginEnv({
      shell: '/bin/zsh',
      home: '/Users/кто-то',
      user: 'кто-то',
      spawn: (file, args, timeout) => {
        calls.push({ file, args, timeout })
        return { status: 0, stdout: Buffer.from('PATH=/opt/homebrew/bin:~/bad:/usr/bin\0KEY_SECRET=шшш\0'), stderr: '' }
      },
    })
    assert.equal(calls[0]?.file, '/usr/bin/env')
    assert.equal(calls[0]?.args[0], '-i')
    assert.deepEqual(calls[0]?.args.slice(-3), ['/bin/zsh', '-ilc', 'env -0'])
    assert.equal(calls[0]?.timeout, 3000)
    assert.equal(env.ok, true)
    assert.deepEqual(env.pathEntries, ['/opt/homebrew/bin', '/usr/bin'])
    assert.deepEqual(env.droppedTilde, ['~/bad'])
  })

  it('провал шелла не роняет вызывающего', async () => {
    const env = await captureLoginEnv({
      spawn: () => ({ status: 1, stdout: '', stderr: 'rc-файл сломан' }),
    })
    assert.equal(env.ok, false)
    assert.match(env.error ?? '', /rc-файл сломан/)
  })

  it('в кэш попадают имена секретов, но не их значения', async () => {
    const home = tempHome()
    try {
      const env = await captureLoginEnv({
        spawn: () => ({
          status: 0,
          stdout: Buffer.from('PATH=/usr/bin\0ANTHROPIC_API_KEY=сверхсекрет\0LANG=ru_RU.UTF-8\0'),
          stderr: '',
        }),
      })
      const cache = toCacheFile(env)
      assert.deepEqual(cache.secretNames, ['ANTHROPIC_API_KEY'])
      assert.ok(!JSON.stringify(cache).includes('сверхсекрет'))

      writeEnvCache(home.paths.envCache, env)
      const back = readEnvCache(home.paths.envCache)
      assert.deepEqual(back?.pathEntries, ['/usr/bin'])
      assert.equal(readEnvCache(home.paths.envCache, 0), null, 'протухший кэш обязан отвергаться')
    } finally {
      home.remove()
    }
  })
})

describe('поиск CLI', () => {
  const fakeFs = (present: string[]): LocateDeps => ({
    isExec: (p) => present.includes(p),
    realpath: (p) => (p === '/Users/user/.local/bin/codex' ? '/Applications/ChatGPT.app/Contents/Resources/codex' : p),
    run: (file) => ({ status: 0, stdout: `версия для ${file}\n`, stderr: '' }),
    home: '/Users/user',
    pathEntries: ['/opt/homebrew/bin', '/usr/bin'],
  })

  it('claude ищется в /opt/homebrew/bin РАНЬШЕ ~/.claude/local', () => {
    const deps = fakeFs(['/opt/homebrew/bin/claude', '/Users/user/.claude/local/claude'])
    const t = locateTool('claude', deps)
    assert.equal(t.path, '/opt/homebrew/bin/claude')
    assert.equal(t.version, 'версия для /opt/homebrew/bin/claude')
  })

  it('codex находится в ~/.local/bin и распознаётся как бинарь внутри ChatGPT.app', () => {
    const t = locateTool('codex', fakeFs(['/Users/user/.local/bin/codex']))
    assert.equal(t.path, '/Users/user/.local/bin/codex')
    assert.equal(t.realpath, '/Applications/ChatGPT.app/Contents/Resources/codex')
    assert.equal(codexInsideChatGPTApp(t), true)
  })

  // ChatGPT.app 26.924 (27.09.2026) перенёс бинарь в Resources/codex-cli/bin/codex, и симлинк
  // ~/.local/bin/codex повис. Ниже — все три случая, которые это породило.
  const NEW_APP = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
  const OLD_APP = '/Applications/ChatGPT.app/Contents/Resources/codex'

  it('codex: симлинк повис — бинарь находится напрямую по новой раскладке ChatGPT.app', () => {
    // ~/.local/bin/codex «есть», но не исполним: statSync идёт по симлинку и падает.
    const t = locateTool('codex', fakeFs([NEW_APP]))
    assert.equal(t.path, NEW_APP)
    assert.equal(codexInsideChatGPTApp(t), true)
  })

  it('codex: новая раскладка стоит РАНЬШЕ старой, старая осталась для прежних версий', () => {
    assert.equal(locateTool('codex', fakeFs([OLD_APP, NEW_APP])).path, NEW_APP)
    const old = locateTool('codex', fakeFs([OLD_APP]))
    assert.equal(old.path, OLD_APP)
    assert.equal(codexInsideChatGPTApp(old), true)
  })

  it('codex: симлинк на новую раскладку распознаётся как бинарь внутри ChatGPT.app', () => {
    const deps = { ...fakeFs(['/Users/user/.local/bin/codex']), realpath: (p: string) => (p === '/Users/user/.local/bin/codex' ? NEW_APP : p) }
    const t = locateTool('codex', deps)
    assert.equal(t.realpath, NEW_APP)
    assert.equal(codexInsideChatGPTApp(t), true)
  })

  it('codex вне ChatGPT.app — не предупреждение', () => {
    const t = locateTool('codex', fakeFs(['/opt/homebrew/bin/codex']))
    assert.equal(codexInsideChatGPTApp(t), false)
  })

  it('чего нет — то null, и это не падение', () => {
    const t = locateTool('opencode', fakeFs([]))
    assert.equal(t.path, null)
    assert.equal(t.version, null)
    assert.ok(t.triedCount > 0)
  })

  it('PATH логин-шелла — запасной путь, когда кандидаты не подошли', () => {
    const t = locateTool('gh', fakeFs(['/usr/bin/gh']))
    assert.equal(t.path, '/usr/bin/gh')
    assert.equal(t.viaPath, true)
  })

  it('locateAll отвечает по всем семи инструментам', () => {
    const all = locateAll(fakeFs(['/opt/homebrew/bin/claude']))
    assert.deepEqual(Object.keys(all).sort(), ['claude', 'codex', 'gh', 'git', 'node', 'npm', 'opencode'])
  })

  it('префикс npm добавляет кандидата, если он задан', () => {
    const deps: LocateDeps = { ...fakeFs(['/opt/npm/bin/claude']), npmPrefix: '/opt/npm' }
    assert.equal(locateTool('claude', deps).path, '/opt/npm/bin/claude')
  })

  it('locateToolPath отдаёт путь, НЕ запуская CLI: это вход старта демона', () => {
    // 30.09.2026, настоящий launchd: демон до `listen` спрашивал `claude --version` и `codex --version`
    // через spawnSync — до 6 с под службой с фоновым приоритетом. Старту нужен путь, а не версия.
    const boom = (): never => { throw new Error('locateToolPath запустил процесс') }
    const deps: LocateDeps = { ...fakeFs(['/opt/homebrew/bin/claude', '/usr/bin/gh']), run: boom, runAsync: boom }
    assert.deepEqual(locateToolPath('claude', deps), { name: 'claude', path: '/opt/homebrew/bin/claude', viaPath: false, triedCount: 4 })
    assert.equal(locateToolPath('gh', deps).viaPath, true, 'PATH логин-шелла — запасной путь и здесь')
    assert.equal(locateToolPath('opencode', deps).path, null)
  })

  it('locateAllAsync: тот же ответ, что у locateAll, а версии спрашиваются разом', async () => {
    const present = ['/opt/homebrew/bin/claude', '/Users/user/.local/bin/codex', '/opt/homebrew/bin/opencode',
      '/usr/bin/git', '/opt/homebrew/bin/gh', '/opt/homebrew/bin/node', '/opt/homebrew/bin/npm']
    const deps = fakeFs(present)
    assert.deepEqual(await locateAllAsync(deps), locateAll(deps), 'синхронная фальшивка run годится и асинхронному входу')
    let running = 0
    let peak = 0
    const slow: LocateDeps = {
      ...deps,
      runAsync: async (file) => {
        peak = Math.max(peak, ++running)
        await new Promise<void>((r) => { setTimeout(r, 100) })
        running--
        return { status: 0, stdout: `версия для ${file}\n`, stderr: '' }
      },
    }
    const t0 = Date.now()
    const all = await locateAllAsync(slow)
    assert.equal(peak, TOOLS.length, 'семь --version должны идти одновременно')
    assert.ok(Date.now() - t0 < 500, `семь запусков по 100 мс заняли ${Date.now() - t0} мс — идут очередью?`)
    assert.equal(all.codex.version, 'версия для /Users/user/.local/bin/codex')
    assert.deepEqual(Object.keys(all), [...TOOLS], 'порядок инструментов — порядок строк доктора')
  })

  it('locateToolAsync с настоящим запуском не останавливает событийный цикл', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-'))
    try {
      const bin = script(dir, 'claude', 'sleep 0.4\necho "9.9.9 (фальшивый claude)"')
      // isExec пускает только в свою папку: настоящий claude машины в тесте не запускается никогда.
      const r = await maxLoopGap(() => locateToolAsync('claude', {
        isExec: (p) => p === bin, realpath: (p) => p, home: dir, pathEntries: [dir],
      }))
      assert.equal(r.value.path, bin)
      assert.equal(r.value.version, '9.9.9 (фальшивый claude)')
      assert.equal(r.value.versionExitCode, 0)
      assert.ok(r.ms >= 350, `фальшивый CLI не запускался? ${r.ms} мс`)
      assert.ok(r.gap < 200, `событийный цикл стоял ${r.gap} мс — --version снова через spawnSync?`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('запуск команды без остановки событийного цикла (execAsync)', () => {
  it('код выхода, оба потока и окружение по белому списку доходят как есть', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-'))
    try {
      const bin = script(dir, 'tool', 'echo "out:$1:$MARK"\necho "err" >&2\nexit 3')
      const r = await execAsync(bin, ['арг'], { timeoutMs: 5000, env: { PATH: '/usr/bin:/bin', MARK: 'm' } })
      assert.deepEqual(r, { status: 3, stdout: 'out:арг:m\n', stderr: 'err\n' })
      const missing = await execAsync(join(dir, 'нет-такого'), [], { timeoutMs: 5000 })
      assert.equal(missing.status, null)
      assert.match(missing.error ?? '', /ENOENT/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('процесс вышел, а трубу держит его фоновый ребёнок — ответ с кодом и выводом сразу, а не по таймауту', async () => {
    // Иначе захват логин-шелла с rc-файлом, который оставляет фоновый процесс, каждый раз ждал бы
    // весь таймаут и кончался «не удалось»: PATH логин-шелла не попадал бы ни в кэш, ни в поиск CLI.
    const dir = mkdtempSync(join(tmpdir(), 'pl-'))
    try {
      const bin = script(dir, 'rc', 'sleep 4 &\necho готово\nexit 0')
      const t0 = Date.now()
      const r = await execAsync(bin, [], { timeoutMs: 10_000 })
      assert.deepEqual(r, { status: 0, stdout: 'готово\n', stderr: '' })
      assert.ok(Date.now() - t0 < 3000, `ответ пришёл через ${Date.now() - t0} мс — ждали закрытия трубы внуком?`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('таймаут добивает и отвечает СРАЗУ, даже когда трубу держит внук', async () => {
    // rc-файл логин-шелла, оставивший фонового ребёнка: `close` у трубы не придёт, пока жив внук.
    const dir = mkdtempSync(join(tmpdir(), 'pl-'))
    try {
      const bin = script(dir, 'hang', 'sleep 5 &\nsleep 5')
      const t0 = Date.now()
      const r = await execAsync(bin, [], { timeoutMs: 200 })
      assert.equal(r.status, null)
      assert.match(r.error ?? '', /таймаут/)
      assert.ok(Date.now() - t0 < 2000, `ответ пришёл через ${Date.now() - t0} мс — ждали внука?`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('захват логин-шелла: настоящий запуск', () => {
  it('медленный rc-файл не останавливает событийный цикл', async () => {
    // Раньше захват шёл через spawnSync, а зовёт его доктор — то есть `doctor.run` демона: на всё
    // время логин-шелла демон не отвечал никому. /bin/sh с HOME во временной папке читает только
    // её .profile — rc-файлы хозяина машины тест не трогает.
    const home = mkdtempSync(join(tmpdir(), 'pl-'))
    try {
      writeFileSync(join(home, '.profile'), 'sleep 0.4\nPATH="/из/профиля:$PATH"\nexport PATH\n')
      const r = await maxLoopGap(() => captureLoginEnv({ shell: '/bin/sh', home, user: 'тест' }))
      assert.equal(r.value.ok, true, r.value.error)
      assert.equal(r.value.pathEntries[0], '/из/профиля')
      assert.ok(r.ms >= 350, `.profile не читался? ${r.ms} мс`)
      assert.ok(r.gap < 200, `событийный цикл стоял ${r.gap} мс — захват снова через spawnSync?`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('node для дочерних процессов (brew upgrade удаляет Cellar/<версия>)', () => {
  const fsWith = (...alive: string[]) => (p: string): boolean => alive.includes(p)

  it('Cellar → opt: путь, который Homebrew сам переводит на новую версию', () => {
    const isExec = fsWith('/opt/homebrew/opt/node/bin/node', '/usr/local/opt/node@22/bin/node')
    assert.equal(stableNodePath('/opt/homebrew/Cellar/node/26.10.0_2/bin/node', isExec), '/opt/homebrew/opt/node/bin/node')
    assert.equal(stableNodePath('/usr/local/Cellar/node@22/22.9.0/bin/node', isExec), '/usr/local/opt/node@22/bin/node')
  })

  it('не Homebrew или ссылки opt нет — путь как есть', () => {
    const isExec = fsWith()
    assert.equal(stableNodePath('/Users/user/.nvm/versions/node/v22.9.0/bin/node', isExec), '/Users/user/.nvm/versions/node/v22.9.0/bin/node')
    assert.equal(stableNodePath('/opt/homebrew/Cellar/node/26.10.0_2/bin/node', isExec), '/opt/homebrew/Cellar/node/26.10.0_2/bin/node')
  })

  it('свой node удалён — берётся node-path; мёртвы оба — null', () => {
    const dead = '/opt/homebrew/Cellar/node/26.10.0_2/bin/node'
    assert.equal(resolveChildNode(dead, '/opt/homebrew/bin/node', fsWith('/opt/homebrew/bin/node')), '/opt/homebrew/bin/node')
    assert.equal(resolveChildNode(dead, null, fsWith()), null)
    assert.equal(resolveChildNode(dead, '/тоже/мёртв', fsWith()), null)
  })

  it('свой node жив — он, в устойчивой форме', () => {
    const own = '/opt/homebrew/Cellar/node/26.11.0/bin/node'
    assert.equal(resolveChildNode(own, '/opt/homebrew/bin/node', fsWith(own, '/opt/homebrew/opt/node/bin/node')), '/opt/homebrew/opt/node/bin/node')
    assert.equal(resolveChildNode(own, null, fsWith(own)), own)
  })
})
