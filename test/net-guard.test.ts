// 0.3.6: «Страж сети» — правило `network.guard {mode: deny|allow, countries}`. Перенос прежнего `guardCountries`,
// строгий разбор `settings.set`, матрица решений (deny/allow × в списке / не в списке / неизвестно), смена правила
// без рестарта демона (кэш и поколение проверок), `doctor`, `pult net guard`.

// Страж в демоне теста отвечает выходом DE и решает НАСТОЯЩИМ правилом из конфига (server.ts, PULT_TEST_NET=ok).
process.env['PULT_TEST_NET'] = 'ok'
process.env['PULT_TEST_NET_LOC'] = 'DE'

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { configToFile, defaultConfig, loadConfig, validateConfig, writeConfig } from '../dist/core/config.js'
import { COUNTRY_CODES, DEFAULT_GUARD_COUNTRIES, GuardError, guardLine, guardVerdict, parseGuardLenient, parseGuardStrict } from '../dist/core/guard.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { checkNetwork, clearNetCache, lastNetExits, netGeneration, resetNetState } from '../dist/env/net.js'
import type { ProbeFn } from '../dist/env/net.js'
import { CLI_ENTRY, FAKE_CLAUDE, FAKE_CODEX_SCRIPTED, startTestDaemon, tempHome, waitFor } from './helpers.js'

const code = (want: string) => (e: { code?: string }): boolean => e.code === want
const probeLoc = (loc: string | null): { fn: ProbeFn; calls: () => number } => {
  let n = 0
  return {
    fn: async () => { n++; return loc ? { status: 0, stdout: `loc=${loc}\n`, stderr: '' } : { status: 7, stdout: '', stderr: 'curl: (7)' } },
    calls: () => n,
  }
}

beforeEach(() => resetNetState())

describe('правило стража: коды, строгий и мягкий разбор', () => {
  it('список кодов — ISO 3166-1 alpha-2 заглавными, без повторов, с XK (Косово у Cloudflare)', () => {
    assert.equal(COUNTRY_CODES.length, 250)
    assert.equal(new Set(COUNTRY_CODES).size, COUNTRY_CODES.length)
    assert.ok(COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c)))
    for (const c of ['DE', 'FI', 'US', 'XK', ...DEFAULT_GUARD_COUNTRIES]) assert.ok(COUNTRY_CODES.includes(c), c)
    assert.ok(!COUNTRY_CODES.includes('XX'))
  })

  it('строгий разбор: ровно {mode, countries}; кривой код, нижний регистр, пустой allow, лишние поля — отказ', () => {
    assert.deepEqual(parseGuardStrict({ mode: 'allow', countries: ['DE', 'FI', 'DE'] }), { mode: 'allow', countries: ['DE', 'FI'] })
    assert.deepEqual(parseGuardStrict({ mode: 'deny', countries: [] }), { mode: 'deny', countries: [] }, 'пустой deny — пускать всех известных')
    const bad: unknown[] = [
      null, [], 'deny', { mode: 'deny' }, { countries: ['DE'] },
      { mode: 'block', countries: ['DE'] },
      { mode: 'allow', countries: [] },
      { mode: 'allow', countries: ['de'] },
      { mode: 'allow', countries: ['GER'] },
      { mode: 'allow', countries: ['XX'] },
      { mode: 'allow', countries: [49] },
      { mode: 'allow', countries: 'DE' },
      { mode: 'allow', countries: ['DE'], proxy: 'http://127.0.0.1:9' },
    ]
    for (const b of bad) assert.throws(() => parseGuardStrict(b), GuardError, JSON.stringify(b))
  })

  it('мягкий разбор (файл): регистр прощается, чужие коды — пропуск с предупреждением; allow без стран — закрыто', () => {
    assert.deepEqual(parseGuardLenient({ mode: 'allow', countries: [' de', 'fi', 'GER'] }).rule, { mode: 'allow', countries: ['DE', 'FI'] })
    assert.equal(parseGuardLenient({ mode: 'allow', countries: [' de', 'fi', 'GER'] }).warnings.length, 1)
    const empty = parseGuardLenient({ mode: 'allow', countries: ['GER'] })
    assert.deepEqual(empty.rule, { mode: 'allow', countries: [] }, 'не подменяется запретительным списком')
    assert.ok(empty.warnings.some((w) => /все ходы запрещены/.test(w)))
    assert.equal(parseGuardLenient({ mode: 'whatever', countries: [] }).rule, null)
  })

  it('матрица решений: deny/allow × в списке / не в списке / неизвестно', () => {
    const deny = { mode: 'deny' as const, countries: ['RU'] }
    const allow = { mode: 'allow' as const, countries: ['DE'] }
    assert.deepEqual(guardVerdict(deny, 'RU'), { ok: false, reason: 'blocked_country' })
    assert.deepEqual(guardVerdict(deny, 'DE'), { ok: true, reason: 'ok' })
    assert.deepEqual(guardVerdict(deny, null), { ok: false, reason: 'unknown_location' }, 'deny: неизвестно — отказ, как раньше')
    assert.deepEqual(guardVerdict(allow, 'DE'), { ok: true, reason: 'ok' })
    assert.deepEqual(guardVerdict(allow, 'de'), { ok: true, reason: 'ok' })
    assert.deepEqual(guardVerdict(allow, 'RU'), { ok: false, reason: 'not_allowed_country' })
    assert.deepEqual(guardVerdict(allow, null), { ok: false, reason: 'unknown_location' }, 'allow: неизвестно — закрыто')
    assert.equal(guardLine(allow), 'разрешать только: DE')
    assert.equal(guardLine({ mode: 'deny', countries: [] }), 'запрещать: (пусто)')
  })
})

describe('config.json: перенос guardCountries → network.guard', () => {
  it('по умолчанию — запретительный список Пульта', () => {
    assert.deepEqual(defaultConfig().guard, { mode: 'deny', countries: [...DEFAULT_GUARD_COUNTRIES] })
  })

  it('прежний guardCountries читается как deny', () => {
    const { config, warnings } = validateConfig({ guardCountries: ['ru', ' by '] })
    assert.deepEqual(config.guard, { mode: 'deny', countries: ['RU', 'BY'] })
    assert.deepEqual(warnings, [])
  })

  it('есть оба — действует network.guard, одно предупреждение; профили провайдеров рядом с guard не ломаются', () => {
    const { config, warnings } = validateConfig({
      guardCountries: ['RU'],
      network: { claude: { mode: 'auto', proxy: 'http://127.0.0.1:9' }, guard: { mode: 'allow', countries: ['DE', 'FI'] } },
    })
    assert.deepEqual(config.guard, { mode: 'allow', countries: ['DE', 'FI'] })
    assert.deepEqual(config.network.claude, { mode: 'auto', proxy: 'http://127.0.0.1:9' })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /действует network\.guard/)
  })

  it('кривой network.guard — предупреждение, остаётся guardCountries', () => {
    const { config, warnings } = validateConfig({ guardCountries: ['RU'], network: { guard: { mode: 'maybe', countries: ['DE'] } } })
    assert.deepEqual(config.guard, { mode: 'deny', countries: ['RU'] })
    assert.equal(warnings.length, 1)
  })

  it('writeConfig пишет страж в network.guard, guardCountries в файле нет; читается обратно', () => {
    const home = tempHome()
    try {
      const cfg = defaultConfig()
      cfg.guard = { mode: 'allow', countries: ['FI'] }
      writeConfig(home.paths.config, cfg)
      const file = JSON.parse(readFileSync(home.paths.config, 'utf8')) as Record<string, unknown>
      assert.equal(file['guardCountries'], undefined)
      assert.equal(file['guard'], undefined)
      assert.deepEqual((file['network'] as Record<string, unknown>)['guard'], { mode: 'allow', countries: ['FI'] })
      assert.deepEqual(loadConfig(home.paths.config).config.guard, { mode: 'allow', countries: ['FI'] })
      assert.deepEqual(configToFile(defaultConfig())['network'], { ...defaultConfig().network, guard: { mode: 'deny', countries: [...DEFAULT_GUARD_COUNTRIES] } })
    } finally { home.remove() }
  })
})

describe('checkNetwork с правилом', () => {
  it('allow: в списке — пускает; не в списке — not_allowed_country и путь none; неизвестно — отказ', async () => {
    const profile = { mode: 'off' as const, proxy: '' }
    const allow = { mode: 'allow' as const, countries: ['DE'] }
    const ok = await checkNetwork('claude', profile, allow, { probe: probeLoc('DE').fn })
    assert.deepEqual([ok.ok, ok.reason, ok.path, ok.guardMode], [true, 'ok', 'direct', 'allow'])
    clearNetCache()
    const out = await checkNetwork('claude', profile, allow, { probe: probeLoc('US').fn })
    assert.deepEqual([out.ok, out.reason, out.path, out.loc], [false, 'not_allowed_country', 'none', 'US'])
    clearNetCache()
    const unknown = await checkNetwork('claude', profile, allow, { probe: probeLoc(null).fn })
    assert.deepEqual([unknown.ok, unknown.reason], [false, 'unknown_location'])
  })

  it('режим в ключе кэша: тот же список в другом режиме — новая проверка, а не старый ответ', async () => {
    const p = probeLoc('DE')
    const profile = { mode: 'off' as const, proxy: '' }
    const a = await checkNetwork('codex', profile, { mode: 'deny', countries: ['DE'] }, { probe: p.fn })
    const b = await checkNetwork('codex', profile, { mode: 'allow', countries: ['DE'] }, { probe: p.fn })
    assert.deepEqual([a.ok, b.ok, b.cached, p.calls()], [false, true, false, 2])
  })

  it('прежняя форма — список стран — это deny', async () => {
    const c = await checkNetwork('claude', { mode: 'off', proxy: '' }, ['de'], { probe: probeLoc('DE').fn })
    assert.deepEqual([c.ok, c.reason, c.guardMode], [false, 'blocked_country', 'deny'])
  })

  it('последний выход провайдера запоминается; clearNetCache двигает поколение, выходы не стирает', async () => {
    assert.deepEqual(lastNetExits(), {})
    await checkNetwork('claude', { mode: 'off', proxy: '' }, ['RU'], { probe: probeLoc('FI').fn })
    const gen = netGeneration()
    clearNetCache()
    assert.equal(netGeneration(), gen + 1)
    assert.deepEqual([lastNetExits().claude?.loc, lastNetExits().claude?.reason, lastNetExits().claude?.path], ['FI', 'ok', 'direct'])
  })
})

/** Ждём события сессии нужного вида, начиная с номера `since`. */
async function eventOf(c: Awaited<ReturnType<typeof connectClient>>, name: string, kind: string, since: number): Promise<Record<string, unknown> | null> {
  let found: Record<string, unknown> | null = null
  await waitFor(async () => {
    const evs = ((await c.request('events.tail', { since, sessionId: name })) as { events: Array<{ kind: string; data: Record<string, unknown> }> }).events
    found = evs.find((e) => e.kind === kind)?.data ?? null
    return found !== null
  }, 10_000)
  return found
}

describe('демон: settings.get|set network.guard и применение без рестарта', () => {
  it('строгий отказ не трогает файл; запись — только network.guard; get отдаёт правило', async () => {
    const home = tempHome()
    const original = { version: 1, guardCountries: ['RU'], network: { claude: { mode: 'auto', proxy: 'http://127.0.0.1:9', noProxy: ['.corp.example'] } }, custom: 42 }
    const before = JSON.stringify(original, null, 2) + '\n'
    writeFileSync(home.paths.config, before)
    home.config = loadConfig(home.paths.config).config
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const got = (await c.request('settings.get')) as { network: { guard: unknown } }
      assert.deepEqual(got.network.guard, { mode: 'deny', countries: ['RU'] }, 'прежний guardCountries')
      const rejects: unknown[] = [
        { network: { guard: { mode: 'allow', countries: [] } } },
        { network: { guard: { mode: 'allow', countries: ['GER'] } } },
        { network: { guard: { mode: 'allow', countries: ['de'] } } },
        { network: { guard: { mode: 'allow', countries: ['DE'], extra: 1 } } },
        { network: { guard: { mode: 'allow', countries: ['DE'] }, claude: { mode: 'off' } } },
        { network: { claude: { proxy: 'http://evil.example' } } },
        { network: { guard: { mode: 'allow', countries: ['DE'] }, noProxy: ['x'] } },
        { network: {} },
        { network: null },
        { network: { guard: { mode: 'allow', countries: ['DE'] } }, guardCountries: ['RU'] },
        // Кривой раздел рядом с годным правилом — отказ целиком, правило не пишется.
        { network: { guard: { mode: 'allow', countries: ['DE'] } }, updates: { check: 'yes' } },
      ]
      for (const r of rejects) {
        await assert.rejects(c.request('settings.set', r as Record<string, unknown>), code('invalid_params'), JSON.stringify(r))
        assert.equal(readFileSync(home.paths.config, 'utf8'), before, `файл тронут: ${JSON.stringify(r)}`)
      }
      const set = (await c.request('settings.set', { network: { guard: { mode: 'allow', countries: ['FI', 'DE'] } } })) as { network: { guard: unknown } }
      assert.deepEqual(set.network.guard, { mode: 'allow', countries: ['FI', 'DE'] })
      // Побайтно то же, что было, кроме двух правок: добавлен network.guard, удалён перекрытый guardCountries.
      const { guardCountries: legacy, ...rest } = original
      assert.deepEqual(legacy, ['RU'])
      const expected = { ...rest, network: { ...original.network, guard: { mode: 'allow', countries: ['FI', 'DE'] } } }
      assert.equal(readFileSync(home.paths.config, 'utf8'), JSON.stringify(expected, null, 2) + '\n')
      assert.deepEqual(validateConfig(JSON.parse(readFileSync(home.paths.config, 'utf8'))).warnings, [], 'предупреждения «есть оба» больше нет')
      assert.deepEqual(((await c.request('settings.get')) as { network: { guard: unknown } }).network.guard, { mode: 'allow', countries: ['FI', 'DE'] })
      assert.deepEqual(loadConfig(home.paths.config).config.guard, { mode: 'allow', countries: ['FI', 'DE'] }, 'рестарт прочтёт то же')
    } finally { c.close(); await d.stop('конец теста'); home.remove() }
  })

  it('смена правила действует со следующего хода тёплой сессии без простоя; doctor показывает правило и отказ', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-guard-'))
    const cwd = join(root, 'w')
    mkdirSync(cwd)
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0 }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      // Тёплый процесс: без смены правила второй ход в пределах минуты стража не проходит вовсе.
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd, mode: 'warm' })
      await c.request('agent.prompt', { name: 'w', text: 'раз' })
      await c.request('agent.wait', { name: 'w', timeoutMs: 10_000 })
      const exits = ((await c.request('settings.get')) as { network: { exits: Record<string, { loc: string }> } }).network.exits
      assert.equal(exits['claude']?.loc, 'DE', 'выход виден окну без новой пробы')

      const since = ((await c.request('events.tail', { since: 0, sessionId: 'w' })) as { events: Array<{ id: number }> }).events.at(-1)!.id
      await c.request('settings.set', { network: { guard: { mode: 'allow', countries: ['FI'] } } })
      await c.request('agent.prompt', { name: 'w', text: 'два' }).catch(() => undefined)
      const blocked = await eventOf(c, 'w', 'net.blocked', since)
      assert.ok(blocked, 'ход после смены правила не проверен стражем')
      assert.deepEqual([blocked['reason'], blocked['loc'], blocked['guardMode'], blocked['guard']], ['not_allowed_country', 'DE', 'allow', ['FI']])

      const report = (await c.request('doctor.run', { net: true })) as { items: Array<{ id: string; status: string; detail: string; data?: Record<string, unknown> }> }
      const rule = report.items.find((i) => i.id === 'guard.rule')
      assert.equal(rule?.status, 'ok')
      assert.match(rule?.detail ?? '', /разрешать только: FI/)
      const net = report.items.find((i) => i.id === 'net.claude')
      assert.deepEqual([net?.status, net?.data?.['reason']], ['fail', 'not_allowed_country'])

      const since2 = ((await c.request('events.tail', { since: 0, sessionId: 'w' })) as { events: Array<{ id: number }> }).events.at(-1)!.id
      await c.request('settings.set', { network: { guard: { mode: 'allow', countries: ['FI', 'DE'] } } })
      await c.request('agent.prompt', { name: 'w', text: 'три' })
      await c.request('agent.wait', { name: 'w', timeoutMs: 10_000 })
      const evs = ((await c.request('events.tail', { since: since2, sessionId: 'w' })) as { events: Array<{ kind: string }> }).events
      assert.ok(!evs.some((e) => e.kind === 'net.blocked'), 'DE снова разрешена — ход идёт')
      assert.ok(evs.some((e) => e.kind === 'message.assistant' || e.kind === 'turn.completed' || e.kind === 'status.changed'))
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
})

interface Run { code: number; stdout: string; stderr: string }
function runCli(paths: PultPaths, args: string[], timeoutMs = 25_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, PULT_HOME: paths.home, PULT_TEST: '1', PULT_TEST_NET: 'ok', PULT_TEST_NET_LOC: 'DE', PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX_SCRIPTED },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pult ${args.join(' ')} не завершился`)) }, timeoutMs)
    child.on('close', (n) => { clearTimeout(timer); resolve({ code: n ?? -1, stdout, stderr }) })
  })
}

describe('CLI: pult net guard и pult doctor', () => {
  it('показать, сменить через демона, отказы; doctor --no-net печатает правило', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-guard-cli-'))
    const paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    try {
      const show = await runCli(paths, ['net', 'guard'])
      assert.equal(show.code, 0, show.stderr)
      assert.match(show.stdout, /^страж сети: запрещать: RU, BY, CN, IR, KP, SY, CU$/m)
      const set = await runCli(paths, ['net', 'guard', '--allow', 'de, fi'])
      assert.equal(set.code, 0, set.stderr)
      assert.match(set.stdout, /^страж сети: разрешать только: DE, FI — со следующего хода$/m)
      const json = await runCli(paths, ['net', 'guard', '--json'])
      assert.deepEqual(JSON.parse(json.stdout), { mode: 'allow', countries: ['DE', 'FI'] })
      for (const bad of [['net', 'guard', '--allow'], ['net', 'guard', '--allow', 'GER'], ['net', 'guard', '--deny', 'RU', '--allow', 'DE'], ['net', 'nope']]) {
        const r = await runCli(paths, bad)
        assert.equal(r.code, 1, bad.join(' '))
      }
      assert.deepEqual((JSON.parse(readFileSync(paths.config, 'utf8')) as { network: { guard: unknown } }).network.guard, { mode: 'allow', countries: ['DE', 'FI'] }, 'отказ файл не тронул')
      const doc = await runCli(paths, ['doctor', '--no-net'])
      assert.match(doc.stdout, /Страж сети.*разрешать только: DE, FI/)
      // В файле allow без годных стран — закрыто: doctor объясняет и выходит с кодом 4.
      writeFileSync(paths.config, JSON.stringify({ version: 1, network: { guard: { mode: 'allow', countries: ['GER'] } } }))
      const closed = await runCli(paths, ['doctor', '--no-net'])
      assert.equal(closed.code, 4, closed.stdout)
      assert.match(closed.stdout, /разрешать только: \(пусто\) — все ходы запрещены/)
      assert.match(closed.stdout, /pult net guard --allow/)
    } finally {
      await runCli(paths, ['daemon', 'stop']).catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
