// Доктор на фальшивках: ни одного настоящего CLI, ни одного запроса в сеть.
// Главный случай — `claude auth status --json` ВЫХОДИТ С КОДОМ 1, но печатает loggedIn: true.
// Так бывает (DELTA v0.4 §5 описывает обратную сторону: при loggedIn:false код тоже 1),
// и доктор обязан верить stdout, а не коду выхода.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { defaultConfig } from '../dist/core/config.js'
import type { DoctorDeps, DoctorItem } from '../dist/env/doctor.js'
import { claudeSubscription, codexLoginLine, formatDoctor, parseClaudeAuth, runDoctor } from '../dist/env/doctor.js'
import type { LocateDeps, LocatedTool, ToolName } from '../dist/env/locate.js'
import { locateAllAsync, locateTool, TOOLS } from '../dist/env/locate.js'
import type { NetCheck } from '../dist/env/net.js'
import { codexConfigPath, codexNetworkAccess, codexNetworkItems } from '../dist/env/codexConfig.js'
import { tempHome } from './helpers.js'

const tool = (name: ToolName, path: string | null, realpath?: string): LocatedTool => ({
  name,
  path,
  realpath: realpath ?? path,
  version: path ? `${name} 1.0.0` : null,
  versionExitCode: path ? 0 : null,
  viaPath: false,
  triedCount: 5,
})

const fakeTools = (over: Partial<Record<ToolName, LocatedTool>> = {}): Record<ToolName, LocatedTool> => ({
  claude: tool('claude', '/opt/homebrew/bin/claude'),
  codex: tool('codex', '/Users/user/.local/bin/codex', '/Applications/ChatGPT.app/Contents/Resources/codex'),
  opencode: tool('opencode', '/opt/homebrew/bin/opencode'),
  git: tool('git', '/usr/bin/git'),
  gh: tool('gh', '/opt/homebrew/bin/gh'),
  node: tool('node', '/opt/homebrew/bin/node'),
  npm: tool('npm', '/opt/homebrew/bin/npm'),
  ...over,
})

const netOk = (): NetCheck => ({
  provider: 'claude', mode: 'auto', path: 'proxy', proxy: 'http://127.0.0.1:3128', loc: 'FI',
  ok: true, reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 12,
  checkedAt: new Date().toISOString(), cached: false,
})

const netBlocked = (): NetCheck => ({ ...netOk(), path: 'none', loc: 'RU', ok: false, reason: 'blocked_country' })

function find(items: DoctorItem[], id: string): DoctorItem {
  const it = items.find((x) => x.id === id)
  assert.ok(it, `в отчёте нет строки ${id}`)
  return it
}

function deps(home: ReturnType<typeof tempHome>, over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    paths: home.paths,
    config: defaultConfig(),
    locate: () => fakeTools(),
    run: () => ({ status: 0, stdout: '', stderr: '' }),
    net: async () => netOk(),
    daemonStatus: async () => null,
    nodeVersion: 'v22.9.0',
    ...over,
  }
}

describe('разбор claude auth status', () => {
  it('код выхода 1 при loggedIn: true не мешает', () => {
    assert.deepEqual(parseClaudeAuth('{"loggedIn":true,"account":"скрыто"}').loggedIn, true)
  })
  it('мусор перед JSON не мешает', () => {
    assert.equal(parseClaudeAuth('шум\n{"loggedIn":false}').loggedIn, false)
  })
  it('пустой ответ — неизвестно', () => {
    assert.equal(parseClaudeAuth('   ').loggedIn, null)
  })
})

describe('доктор', () => {
  it('claude auth status выходит с кодом 1, но говорит loggedIn: true → ok', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, {
        run: (file, args) => {
          if (file.endsWith('claude') && args[0] === 'auth') {
            return { status: 1, stdout: '{"loggedIn":true}', stderr: 'какой-то шум' }
          }
          return { status: 0, stdout: '', stderr: '' }
        },
      }))
      const item = find(report.items, 'login.claude')
      assert.equal(item.status, 'ok')
      assert.match(item.detail, /код выхода 1 игнорируется/)
    } finally {
      home.remove()
    }
  })

  it('loggedIn: false → fail и команда починки', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, {
        run: (file, args) => (file.endsWith('claude') && args[0] === 'auth'
          ? { status: 1, stdout: '{"loggedIn":false}', stderr: '' }
          : { status: 0, stdout: '', stderr: '' }),
      }))
      const item = find(report.items, 'login.claude')
      assert.equal(item.status, 'fail')
      assert.equal(item.fix, 'claude /login')
      // Команда — её окно рисует рамкой с «копировать».
      assert.equal(item.fixCmd, 'claude /login')
      assert.equal(report.ok, false)
    } finally {
      home.remove()
    }
  })

  it('codex судится по коду выхода', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, {
        run: (file, args) => (file.endsWith('codex') && args[0] === 'login'
          ? { status: 2, stdout: 'Not logged in', stderr: '' }
          : { status: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      }))
      const item = find(report.items, 'login.codex')
      assert.equal(item.status, 'fail')
      assert.equal(item.fix, 'codex login')
    } finally {
      home.remove()
    }
  })

  it('codex внутри ChatGPT.app — предупреждение, а не ошибка', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, { run: () => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' }) }))
      const item = find(report.items, 'cli.codex')
      assert.equal(item.status, 'warn')
      assert.match(item.detail, /ChatGPT\.app/)
    } finally {
      home.remove()
    }
  })

  it('codex внутри ChatGPT.app: совет зависит от того, найден бинарь через симлинк или напрямую', async () => {
    const home = tempHome()
    try {
      const NEW_APP = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
      const run = (): { status: number; stdout: string; stderr: string } => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' })
      const LINK = '/Users/user/.local/bin/codex'
      const seen: string[] = []
      const linkState = (state: 'symlink' | 'missing' | 'other') => (p: string): 'symlink' | 'missing' | 'other' => { seen.push(p); return state }
      // Симлинк жив: `ln -sf <его же цель> <он же>` ничего не чинит — совет без команды.
      const viaLink = find((await runDoctor(deps(home, {
        run, home: '/Users/user', linkState: linkState('symlink'),
        locate: () => fakeTools({ codex: tool('codex', LINK, NEW_APP) }),
      }))).items, 'cli.codex')
      assert.equal(viaLink.status, 'warn')
      assert.doesNotMatch(viaLink.fix ?? '', /ln -sf/)
      assert.match(viaLink.fix ?? '', /перезапусти pult doctor/)
      // Случай 26.924: симлинк повис, поиск провалился к бинарю внутри пакета (realpath = путь).
      // Доктор обязан напечатать ту команду, что чинит ПОВИСШИЙ симлинк: новый путь → ~/.local/bin/codex.
      const dangling = find((await runDoctor(deps(home, {
        run, home: '/Users/user', linkState: linkState('symlink'),
        locate: () => fakeTools({ codex: tool('codex', NEW_APP) }),
      }))).items, 'cli.codex')
      assert.equal(dangling.status, 'warn')
      assert.match(dangling.detail, /ChatGPT\.app/)
      assert.match(dangling.fix ?? '', /повис/)
      assert.ok((dangling.fix ?? '').endsWith(`ln -sf ${NEW_APP} ${LINK}`), dangling.fix)
      // В окно копируется только сама команда, без прозы перед ней.
      assert.equal(dangling.fixCmd, `ln -sf ${NEW_APP} ${LINK}`)
      assert.ok(seen.includes(LINK), 'смотрели не тот симлинк')
      // Симлинка нет вовсе — та же команда, с созданием каталога.
      const missing = find((await runDoctor(deps(home, {
        run, home: '/Users/user', linkState: linkState('missing'),
        locate: () => fakeTools({ codex: tool('codex', NEW_APP) }),
      }))).items, 'cli.codex')
      assert.ok((missing.fix ?? '').endsWith(`mkdir -p /Users/user/.local/bin && ln -sf ${NEW_APP} ${LINK}`), missing.fix)
      // На месте симлинка обычный файл — его не трогаем, совета с ln нет.
      const other = find((await runDoctor(deps(home, {
        run, home: '/Users/user', linkState: linkState('other'),
        locate: () => fakeTools({ codex: tool('codex', NEW_APP) }),
      }))).items, 'cli.codex')
      assert.doesNotMatch(other.fix ?? '', /ln -sf/)
      assert.match(other.fix ?? '', /обеим раскладкам/)
    } finally {
      home.remove()
    }
  })

  it('схема протокола codex: совпадение — ok, расхождение — warn с командой починки', async () => {
    const home = tempHome()
    try {
      // Сверка подменена целиком: настоящий `codex` не спавнится, на диск ничего не пишется.
      const report = await runDoctor(deps(home, {
        codexSchema: async (bin) => {
          assert.match(bin, /codex$/)
          return { status: 'drift', expected: 'ожидали', actual: 'стало', files: 7, detail: 'схема протокола РАЗОШЛАСЬ: тест' }
        },
      }))
      const item = find(report.items, 'codex.schema')
      assert.equal(item.status, 'warn', 'расхождение схемы — предупреждение, а не отказ работать')
      assert.match(item.detail, /РАЗОШЛАСЬ/)
      assert.match(item.fix ?? '', /CODEX_SCHEMA_SHA256/)
      assert.equal(report.ok, true, 'дрейф протокола не имеет права валить весь отчёт')
    } finally {
      home.remove()
    }
  })

  it('доктор НЕ морозит процесс на сверке схемы: она асинхронная', async () => {
    // Первая версия звала `spawnSync` — и на время генерации схемы вставал весь демон
    // (`doctor.run` идёт в том же процессе). Здесь сверка «идёт» 300 мс, а пульс обязан тикать.
    const home = tempHome()
    const gaps: number[] = []
    let last = Date.now()
    const beat = setInterval(() => { const now = Date.now(); gaps.push(now - last); last = now }, 20)
    try {
      await runDoctor(deps(home, {
        codexSchema: async () => {
          await new Promise<void>((r) => { setTimeout(r, 300) })
          return { status: 'ok', expected: 'x', actual: 'x', files: 310, detail: 'тест' }
        },
      }))
      clearInterval(beat)
      const maxGap = Math.max(...gaps)
      assert.ok(maxGap < 150, `событийный цикл вставал на ${maxGap} мс — сверка схемы снова синхронная?`)
    } finally {
      clearInterval(beat)
      home.remove()
    }
  })

  it('доктор НЕ морозит процесс на запуске CLI: версии и вход — асинхронные запуски', async () => {
    // КАК ЛОМАЛОСЬ (30.09.2026, настоящий launchd): семь `--version`, `claude auth status` и
    // `codex login status` шли через spawnSync подряд, а `doctor.run` живёт в процессе демона —
    // 19 с тишины на тестовой службе, 44–94 с на рабочей; `hello` четырёх команд CLI подряд
    // упал по таймауту. Здесь всё настоящее, кроме самих CLI: поиск и запуск — боевые (locateAllAsync,
    // run по умолчанию), а «CLI» — sh-скрипты, думающие по 0,3 с: девять запусков, и при spawnSync
    // пульс стоял бы не меньше 0,3 с на каждом. Что версии идут РАЗОМ, проверяет env.test.ts на
    // фальшивом запуске: по часам этого здесь не померить — первый запуск только что записанного
    // скрипта на macOS занимает сотни миллисекунд сверх его работы (семь скриптов — около 2 с).
    const home = tempHome()
    const bin = mkdtempSync(join(tmpdir(), 'pd-'))
    try {
      for (const name of TOOLS) {
        const body = name === 'claude'
          ? 'sleep 0.3\nif [ "$1" = auth ]; then echo \'{"loggedIn":true,"subscriptionType":"max","authMethod":"claude.ai"}\'; else echo "claude 9.9.9"; fi'
          : name === 'codex'
            ? 'sleep 0.3\nif [ "$1" = login ]; then echo "Logged in using ChatGPT" >&2; else echo "codex-cli 9.9.9"; fi'
            : `sleep 0.3\necho "${name} 9.9.9"`
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
        chmodSync(join(bin, name), 0o755)
      }
      const gaps: number[] = []
      let last = Date.now()
      const beat = setInterval(() => { const now = Date.now(); gaps.push(now - last); last = now }, 10)
      const t0 = Date.now()
      let report
      try {
        report = await runDoctor({
          paths: home.paths,
          config: defaultConfig(),
          // /usr/bin и /bin — ради `sleep` в самих скриптах: найденный CLI запускается с ЭТИМ PATH.
          pathEntries: [bin, '/usr/bin', '/bin'],
          // isExec пускает только в папку фальшивок: настоящие CLI машины тест не запускает никогда.
          locate: (d) => locateAllAsync({ ...d, isExec: (p) => dirname(p) === bin, realpath: (p) => p, home: '/нет-такого-дома' }),
          codexSchema: async () => ({ status: 'ok', expected: 'x', actual: 'x', files: 314, detail: 'тест' }),
          skipNet: true,
          daemonStatus: async () => null,
        })
      } finally {
        clearInterval(beat)
      }
      const took = Date.now() - t0
      const maxGap = Math.max(...gaps, Date.now() - last)
      assert.equal(find(report.items, 'cli.claude').data?.['version'], 'claude 9.9.9')
      assert.equal(find(report.items, 'login.claude').status, 'ok')
      assert.match(find(report.items, 'subscription.claude').detail, /^max, вход claude\.ai/)
      assert.match(find(report.items, 'login.codex').detail, /код выхода 0: Logged in using ChatGPT/)
      assert.ok(took >= 550, `фальшивые CLI не запускались? доктор прошёл за ${took} мс`)
      assert.ok(maxGap < 200, `событийный цикл стоял ${maxGap} мс — запуск CLI в докторе снова синхронный?`)
    } finally {
      rmSync(bin, { recursive: true, force: true })
      home.remove()
    }
  })

  it('проверки сети идут разом, а строки отчёта — в порядке провайдеров', async () => {
    const home = tempHome()
    try {
      let running = 0
      let peak = 0
      const report = await runDoctor(deps(home, {
        net: async (provider) => {
          peak = Math.max(peak, ++running)
          // Кто начал первым, кончает последним: порядок строк не должен зависеть от того, кто быстрее.
          await new Promise<void>((r) => { setTimeout(r, provider === 'claude' ? 120 : 40) })
          running--
          return { ...netOk(), provider }
        },
      }))
      assert.equal(peak, 3, 'три провайдера проверяются одновременно')
      assert.deepEqual(report.items.filter((i) => i.id.startsWith('net.')).map((i) => i.id), ['net.claude', 'net.codex', 'net.opencode'])
    } finally {
      home.remove()
    }
  })

  it('без CLI codex строки про схему в отчёте нет', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, { locate: () => fakeTools({ codex: tool('codex', null) }) }))
      assert.equal(report.items.some((i) => i.id === 'codex.schema'), false)
    } finally {
      home.remove()
    }
  })

  it('пропавший claude — fail; пропавший gh — всего лишь warn', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, {
        locate: () => fakeTools({ claude: tool('claude', null), gh: tool('gh', null) }),
      }))
      assert.equal(find(report.items, 'cli.claude').status, 'fail')
      // Совет словами — не команда: вставленный в терминал, он дал бы `command not found`.
      assert.match(find(report.items, 'cli.claude').fix ?? '', /^установи claude/)
      assert.equal(find(report.items, 'cli.claude').fixCmd, undefined)
      assert.equal(find(report.items, 'cli.gh').status, 'warn')
      // Без claude нет и строки про вход в него.
      assert.equal(report.items.some((i) => i.id === 'login.claude'), false)
    } finally {
      home.remove()
    }
  })

  it('старый node — fail с командой обновления', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, { nodeVersion: 'v20.11.0' }))
      const item = find(report.items, 'node.version')
      assert.equal(item.status, 'fail')
      assert.equal(item.fix, 'brew upgrade node')
    } finally {
      home.remove()
    }
  })

  it('заблокированная сеть — fail с подсказкой про VPN', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, { net: async () => netBlocked() }))
      const item = find(report.items, 'net.claude')
      assert.equal(item.status, 'fail')
      assert.match(item.fix ?? '', /подними VPN/)
      assert.equal(report.ok, false)
    } finally {
      home.remove()
    }
  })

  it('права PULT_HOME проверяются, демон без ответа — warn', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home))
      assert.equal(find(report.items, 'home.permissions').status, 'ok')
      assert.equal(find(report.items, 'daemon').status, 'warn')
      assert.equal(find(report.items, 'daemon').fix, 'pult daemon start')
    } finally {
      home.remove()
    }
  })

  it('кривые права дают warn с перечислением', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, { mode: (p) => (p === home.paths.run ? 0o755 : 0o700) }))
      const item = find(report.items, 'home.permissions')
      assert.equal(item.status, 'warn')
      assert.match(item.detail, /755/)
    } finally {
      home.remove()
    }
  })

  it('--no-net не трогает сеть вовсе', async () => {
    const home = tempHome()
    try {
      let netCalls = 0
      const report = await runDoctor(deps(home, {
        skipNet: true,
        net: async () => { netCalls++; return netOk() },
      }))
      assert.equal(netCalls, 0)
      assert.equal(report.items.some((i) => i.id.startsWith('net.')), false)
    } finally {
      home.remove()
    }
  })

  it('учётка из `codex login status` в отчёт не попадает', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, {
        run: (file, args) => (file.endsWith('codex') && args[0] === 'login'
          ? { status: 0, stdout: 'Logged in as ivan' + '@example.org (key sk-' + 'ant-api03-AAAAAAAAAAAAAAAA)', stderr: '' }
          : { status: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      }))
      const item = find(report.items, 'login.codex')
      const whole = JSON.stringify(report)
      assert.ok(!whole.includes('ivan' + '@example.org'), 'почта утекла в отчёт доктора')
      assert.ok(!whole.includes('sk-ant-api03'), 'ключ утёк в отчёт доктора')
      assert.match(item.detail, /<email>/)
    } finally {
      home.remove()
    }
  })

  it('прокси с логином и паролем не печатается целиком', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, {
        net: async () => ({ ...netOk(), proxy: 'http://vasya:hunter2@127.0.0.1:3128', ok: false, reason: 'proxy_dead', path: 'none', loc: null }),
      }))
      const whole = JSON.stringify(report)
      assert.ok(!whole.includes('hunter2'), 'пароль прокси утёк в отчёт доктора')
    } finally {
      home.remove()
    }
  })

  it('`required` без прокси — fail с подсказкой «укажи proxy или mode off», а не «подними прокси»', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, {
        net: async (provider) => ({ ...netOk(), provider, mode: 'required', proxy: null, ok: false, reason: 'no_proxy', path: 'none', loc: null }),
      }))
      const item = report.items.find((i) => i.id === 'net.claude')!
      assert.equal(item.status, 'fail')
      assert.match(String(item.fix), /network\.claude\.mode = "required" без proxy — ходы запрещены: укажи network\.claude\.proxy или поставь mode = "off"/)
    } finally {
      home.remove()
    }
  })

  it('PATH доходит до поиска CLI и до запуска найденного', async () => {
    // Модуль loginShell написан ради того, что 6 из 7 CLI не видны в PATH службы launchd,
    // но его никто не звал: PATH-ветка locateTool была мёртвым кодом, а CLI из nvm или
    // npm-prefix доктор объявлял пропавшим. Здесь проверяется сам путь данных до locateAll —
    // настоящий логин-шелл в тесте не запускается.
    const home = tempHome()
    try {
      let seen: LocateDeps | null = null
      await runDoctor(deps(home, {
        pathEntries: ['/фальшивый/bin', '/ещё/bin'],
        locate: (d) => { seen = d; return fakeTools() },
      }))
      const got = seen as LocateDeps | null
      assert.deepEqual(got?.pathEntries, ['/фальшивый/bin', '/ещё/bin'])
    } finally {
      home.remove()
    }
  })

  it('PATH-ветка поиска действительно находит CLI вне списка кандидатов', async () => {
    // Вторая половина того же: locateTool обязан взять бинарь из переданного PATH,
    // а доктор — сказать про это человеку.
    const t = locateTool('claude', {
      isExec: (p) => p === '/фальшивый/bin/claude',
      realpath: (p) => p,
      run: () => ({ status: 0, stdout: 'claude 9.9.9', stderr: '' }),
      home: '/фальшивый/дом',
      pathEntries: ['/фальшивый/bin'],
    })
    assert.equal(t.path, '/фальшивый/bin/claude')
    assert.equal(t.viaPath, true)

    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, { locate: () => fakeTools({ claude: t }) }))
      assert.match(find(report.items, 'cli.claude').detail, /PATH логин-шелла/)
    } finally {
      home.remove()
    }
  })

  it('текстовый вывод содержит итог и команды починки', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, { nodeVersion: 'v18.0.0' }))
      const text = formatDoctor(report)
      assert.match(text, /\[FAIL\] Node/)
      assert.match(text, /почини: brew upgrade node/)
      assert.match(text, /итог: ok \d+ · warn \d+ · fail \d+/)
    } finally {
      home.remove()
    }
  })

  // --- В5: какую подписку тратит Пульт (10-PLAN-hermes-ideas.md, «Попутно») -------------------
  // Ответ `claude auth status --json` несёт почту и организацию рядом с типом подписки.
  // Литералы собраны из кусков — иначе на них сработает страж утечек CI.
  const MAIL = 'ivan' + '@example.org'
  const ORG = 'Секретная Организация ООО'
  const ORG_ID = '0b1c2d3e-' + 'aaaa-bbbb-cccc-0123456789ab'
  const authJson = (over: Record<string, unknown> = {}): string => JSON.stringify({
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
    email: MAIL, orgId: ORG_ID, orgName: ORG, subscriptionType: 'team', ...over,
  })

  it('подписка claude: тип и способ входа — ok, почты и организации нет ни в тексте, ни в JSON', async () => {
    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, {
        run: (file, args) => (file.endsWith('claude') && args[0] === 'auth'
          ? { status: 0, stdout: authJson(), stderr: '' }
          : { status: 0, stdout: '', stderr: '' }),
      }))
      const item = find(report.items, 'subscription.claude')
      assert.equal(item.status, 'ok')
      assert.match(item.detail, /^team, вход claude\.ai — ходы агентов Пульта тратят лимиты ЭТОЙ подписки/)
      assert.deepEqual(item.data, { subscriptionType: 'team', authMethod: 'claude.ai' })
      const everything = JSON.stringify(report) + formatDoctor(report)
      for (const secret of [MAIL, ORG, ORG_ID, 'firstParty']) {
        assert.ok(!everything.includes(secret), `в отчёт доктора утекло: ${secret}`)
      }
    } finally {
      home.remove()
    }
  })

  it('подписка claude: в поле типа не идентификатор (адрес, имя с пробелами) — поле отбрасывается', () => {
    assert.deepEqual(claudeSubscription({ subscriptionType: MAIL, authMethod: ORG }), { subscriptionType: null, authMethod: null })
    assert.deepEqual(claudeSubscription({ subscriptionType: 'max', authMethod: 'claude.ai' }), { subscriptionType: 'max', authMethod: 'claude.ai' })
    assert.deepEqual(claudeSubscription('мусор'), { subscriptionType: null, authMethod: null })
    assert.deepEqual(claudeSubscription(null), { subscriptionType: null, authMethod: null })
  })

  it('подписка claude: тип не сообщён — warn; не вошёл — warn с claude /login', async () => {
    const home = tempHome()
    try {
      const unknown = await runDoctor(deps(home, {
        run: (file, args) => (file.endsWith('claude') && args[0] === 'auth'
          ? { status: 0, stdout: authJson({ subscriptionType: undefined }), stderr: '' }
          : { status: 0, stdout: '', stderr: '' }),
      }))
      const u = find(unknown.items, 'subscription.claude')
      assert.equal(u.status, 'warn')
      assert.match(u.detail, /тип подписки не сообщён, вход claude\.ai/)

      const out = await runDoctor(deps(home, {
        run: (file, args) => (file.endsWith('claude') && args[0] === 'auth'
          ? { status: 1, stdout: '{"loggedIn":false}', stderr: '' }
          : { status: 0, stdout: '', stderr: '' }),
      }))
      const o = find(out.items, 'subscription.claude')
      assert.equal(o.status, 'warn')
      assert.equal(o.fix, 'claude /login')

      // Ответ не разобран (CLI сменил формат): строка входа говорит «не разобран», и строка
      // подписки не имеет права утверждать «не вошёл» — отчёт противоречил бы сам себе.
      const junk = await runDoctor(deps(home, {
        run: (file, args) => (file.endsWith('claude') && args[0] === 'auth'
          ? { status: 0, stdout: 'совсем не JSON', stderr: '' }
          : { status: 0, stdout: '', stderr: '' }),
      }))
      const jl = find(junk.items, 'login.claude')
      assert.match(jl.detail, /ответ не разобран/)
      // Строка входа тоже не шлёт на /login при неразобранном ответе: иначе один отчёт даёт две
      // разные починки одного и того же неизвестного состояния.
      assert.equal(jl.fix, 'claude auth status')
      const j = find(junk.items, 'subscription.claude')
      assert.equal(j.status, 'warn')
      assert.doesNotMatch(j.detail, /не вошёл/)
      assert.match(j.detail, /вход не разобран — тип подписки неизвестен/)
      assert.equal(j.fix, 'claude auth status')
    } finally {
      home.remove()
    }
  })

  it('подписка codex: первая строка login status берётся и из stderr, ключ маскируется', async () => {
    // codex печатает «Logged in using …» в stderr: раньше доктор смотрел только stdout и строка пропадала.
    assert.equal(codexLoginLine({ status: 0, stdout: '', stderr: '\nLogged in using ChatGPT\nещё строка' }), 'Logged in using ChatGPT')
    assert.equal(codexLoginLine({ status: 0, stdout: 'из stdout\n', stderr: 'из stderr' }), 'из stdout')
    const key = 'sk-' + 'proj-' + 'A'.repeat(40)
    const line = codexLoginLine({ status: 0, stdout: '', stderr: `Logged in using an API key - ${key}` })
    assert.ok(!line.includes('A'.repeat(20)), `ключ утёк: ${line}`)
    assert.match(line, /<token>/)

    const home = tempHome()
    try {
      const report = await runDoctor(deps(home, {
        run: (file, args) => (file.endsWith('codex') && args[0] === 'login'
          ? { status: 0, stdout: '', stderr: `Logged in using ChatGPT (${MAIL})` }
          : { status: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      }))
      const item = find(report.items, 'subscription.codex')
      assert.equal(item.status, 'ok')
      assert.match(item.detail, /^Logged in using ChatGPT \(<email>\) — ходы агентов Пульта тратят/)
      assert.match(find(report.items, 'login.codex').detail, /код выхода 0: Logged in using ChatGPT/)
      assert.ok(!JSON.stringify(report).includes(MAIL), 'почта из codex login status утекла в отчёт')

      const loggedOut = await runDoctor(deps(home, {
        run: (file, args) => (file.endsWith('codex') && args[0] === 'login'
          ? { status: 1, stdout: '', stderr: 'Not logged in' }
          : { status: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      }))
      assert.equal(loggedOut.items.find((x) => x.id === 'subscription.codex'), undefined, 'без входа строки подписки нет')
      assert.match(find(loggedOut.items, 'login.codex').detail, /Not logged in/)
    } finally {
      home.remove()
    }
  })
})

describe('доктор: сеть в песочнице Codex (0.3.7)', () => {
  it('разбор config.toml: таблица, ключ с точкой, встроенная таблица, комментарии; профили не в счёт', () => {
    assert.equal(codexNetworkAccess('[sandbox_workspace_write]\nnetwork_access = true\n'), true)
    assert.equal(codexNetworkAccess('[sandbox_workspace_write]\nnetwork_access = false # выключено\n'), false)
    assert.equal(codexNetworkAccess('sandbox_workspace_write.network_access = true'), true)
    assert.equal(codexNetworkAccess('sandbox_workspace_write = { writable_roots = ["/x"], network_access = true }'), true)
    assert.equal(codexNetworkAccess('[ "sandbox_workspace_write" ]\n"network_access" = true'), true)
    assert.equal(codexNetworkAccess('# network_access = true\n[sandbox_workspace_write]\n# network_access = true'), null)
    assert.equal(codexNetworkAccess('[profiles.x.sandbox_workspace_write]\nnetwork_access = true'), null)
    assert.equal(codexNetworkAccess('[sandbox_workspace_write]\n[other]\nnetwork_access = true'), null)
    assert.equal(codexNetworkAccess('model = "gpt"\n'), null)
  })

  it('network_access = true — warn с подсказкой; false или нет ключа — ok; нет файла — пункта нет', async () => {
    const home = tempHome()
    try {
      const file = join(home.paths.home, 'codex-config.toml')
      writeFileSync(file, '[sandbox_workspace_write]\nnetwork_access = true\n')
      const warn = find((await runDoctor(deps(home, { codexConfig: file }))).items, 'codex.network')
      assert.equal(warn.status, 'warn')
      assert.match(warn.detail, /песочница Codex с сетью: агент сможет обратиться к демону Пульта/)
      assert.ok(warn.fix)
      writeFileSync(file, 'model = "x"\n')
      assert.equal(find((await runDoctor(deps(home, { codexConfig: file }))).items, 'codex.network').status, 'ok')
      const none = (await runDoctor(deps(home, { codexConfig: join(home.paths.home, 'нет.toml') }))).items
      assert.equal(none.some((i) => i.id === 'codex.network'), false)
      assert.equal((await runDoctor(deps(home))).items.some((i) => i.id === 'codex.network'), false, 'без пути файл машины не читается')
      assert.deepEqual(codexNetworkItems(file, () => { throw new Error('EACCES') }), [])
    } finally { home.remove() }
  })

  it('путь: $CODEX_HOME/config.toml, иначе ~/.codex/config.toml', () => {
    assert.equal(codexConfigPath({ CODEX_HOME: '/c' }, '/home/user'), '/c/config.toml')
    assert.equal(codexConfigPath({}, '/home/user'), '/home/user/.codex/config.toml')
  })
})
