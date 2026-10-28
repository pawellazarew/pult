// Канал обновлений в демоне (M8c): расписание проверок, `updates.check: false`, «Обновить», которое ждёт
// конца ходов, и `force`. Сеть — подставная функция запроса, `pult update` — подставной ребёнок.

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { ClientError } from '../dist/cli/client.js'
import type { DaemonStatus, UpdateStatus } from '../dist/core/rpc.js'
import { APPLY_PASS, ApplyError, applyArgv, applyEnv, CHECK_INTERVAL_MS, CHECK_JITTER_MS, createUpdateChecker, FIRST_CHECK_MS, MIN_AUTO_GAP_MS, openUpdateLog } from '../dist/update/checker.js'
import type { ApplyChild, CheckerOptions } from '../dist/update/checker.js'
import type { HttpGet } from '../dist/update/fetch.js'
import { publicOf, signEnvelope } from '../dist/update/manifest.js'
import { writeState } from '../dist/update/versions.js'
import { channelDoctorItem } from '../dist/update/doctor.js'
import { sleep, startTestDaemon, tempHome, waitFor } from './helpers.js'
import type { TempHome } from './helpers.js'

const { privateKey } = generateKeyPairSync('ed25519')
const pub = publicOf(privateKey)
const KEYS = [{ id: pub.keyId, publicKey: pub.raw.toString('base64') }]
const URL_LATEST = 'https://example.invalid/latest.json'

function latestJson(version: string): Buffer {
  const m = {
    schema: 1, version, released: '2026-10-19T10:00:00.000Z',
    notes: `https://github.com/pawellazarew/pult/releases/tag/v${version}`,
    package: { url: `https://example.invalid/pult-${version}.tgz`, sha256: 'c'.repeat(64), size: 10 },
    app: { version: '0.1.14', minVersion: '0.1.13' },
  }
  return Buffer.from(signEnvelope(Buffer.from(JSON.stringify(m)), privateKey))
}

/** Подставной канал: отдаёт latest.json нужной версии и считает запросы. */
function channel(version: () => string): { http: HttpGet; calls: () => number } {
  let n = 0
  return {
    calls: () => n,
    http: async (url) => {
      n++
      if (url !== URL_LATEST) return { status: 404, header: () => null, body: null }
      const b = latestJson(version())
      return { status: 200, header: () => null, body: (async function* () { yield b })() }
    },
  }
}

class FakeChild extends EventEmitter implements ApplyChild {}

function checker(home: TempHome, over: Partial<CheckerOptions> = {}): ReturnType<typeof createUpdateChecker> {
  return createUpdateChecker({
    paths: home.paths,
    config: { ...home.config, updates: { check: true, url: URL_LATEST } },
    logger: home.logger,
    current: '0.2.27',
    keys: KEYS,
    runningTurns: () => 0,
    schedule: false,
    // Фоновую подготовку (0.3.16) тесты этого файла включают явно — иначе ручная проверка запустила бы настоящий CLI.
    stage: false,
    ...over,
  })
}

describe('демон: расписание проверок', () => {
  it('первая проверка — через firstDelay, дальше каждые interval; итог в update-check.json', async () => {
    const home = tempHome()
    const ch = channel(() => '0.2.28')
    const c = checker(home, { http: ch.http, schedule: true, firstDelayMs: 40, intervalMs: 120, jitterMs: 0, tickMs: 20 })
    try {
      await sleep(20)
      assert.equal(ch.calls(), 0, 'раньше firstDelay — ни одного запроса')
      assert.ok(await waitFor(() => ch.calls() >= 1, 2000))
      assert.ok(await waitFor(() => ch.calls() >= 3, 3000), `за ~400 мс ожидалось ≥ 3 проверок, было ${ch.calls()}`)
      const st = c.status()
      assert.equal(st.available, true)
      assert.equal(st.latest?.version, '0.2.28')
      assert.equal(st.error, null)
      const saved = JSON.parse(readFileSync(home.paths.updateCheck, 'utf8')) as { latest: { version: string } }
      assert.equal(saved.latest.version, '0.2.28')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('сутки считаются по стенным часам: сон ноутбука не откладывает проверку', async () => {
    const home = tempHome()
    const ch = channel(() => '0.2.28')
    let clock = 1_000_000
    const c = checker(home, { http: ch.http, schedule: true, firstDelayMs: 0, intervalMs: 24 * 3_600_000, jitterMs: 0, tickMs: 15, now: () => clock })
    try {
      assert.ok(await waitFor(() => ch.calls() === 1, 2000))
      await sleep(100)
      assert.equal(ch.calls(), 1, 'до суток — тишина')
      clock += 24 * 3_600_000 + 1 // «проснулись» через сутки: монотонный таймер этого не видел бы
      assert.ok(await waitFor(() => ch.calls() === 2, 2000), 'проверка не пришла после скачка стенных часов')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('updates.check: false — ни одного запроса сам, старый итог не всплывает; ручная проверка работает', async () => {
    const home = tempHome()
    writeFileSync(home.paths.updateCheck, JSON.stringify({ checkedAt: '2026-01-01T00:00:00Z', error: null, latest: { version: '9.9.9', released: '2026-01-01T00:00:00Z', notes: 'https://x.example/n' } }))
    const ch = channel(() => '0.2.28')
    const c = createUpdateChecker({
      paths: home.paths, config: { ...home.config, updates: { check: false, url: URL_LATEST } }, logger: home.logger,
      current: '0.2.27', keys: KEYS, runningTurns: () => 0, stage: false, http: ch.http, firstDelayMs: 0, tickMs: 10,
    })
    try {
      await sleep(150)
      assert.equal(ch.calls(), 0)
      const st = c.status()
      assert.equal(st.enabled, false)
      assert.equal(st.latest, null)
      assert.equal((await c.check()).latest?.version, '0.2.28')
      assert.equal(ch.calls(), 1)
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('сбой сети не прячет уже известное обновление: error рядом с прежним latest', async () => {
    const home = tempHome()
    let fail = false
    const http: HttpGet = async (url, signal) => {
      if (fail) throw new Error('getaddrinfo ENOTFOUND')
      return channel(() => '0.2.28').http(url, signal)
    }
    const c = checker(home, { http })
    try {
      await c.check()
      fail = true
      const st = await c.check()
      assert.equal(st.latest?.version, '0.2.28')
      assert.equal(st.available, true)
      assert.match(st.error ?? '', /ENOTFOUND/)
    } finally {
      c.stop()
      home.remove()
    }
  })
})

describe('демон: «Обновить» ждёт конца ходов', () => {
  it('ходы идут — waiting; число ходов следит за poke; последний кончился — запуск', async () => {
    const home = tempHome()
    let turns = 2
    const spawned: FakeChild[] = []
    const c = checker(home, { http: channel(() => '0.2.28').http, runningTurns: () => turns, spawnApply: () => { const k = new FakeChild(); spawned.push(k); return k } })
    try {
      assert.deepEqual(await c.apply(false), { waiting: 2 })
      assert.deepEqual({ ...c.status().apply, since: 'x' }, { state: 'waiting', turns: 2, since: 'x', to: '0.2.28' })
      turns = 1
      c.poke()
      await sleep(5) // poke пересчитывает на следующем обороте цикла
      const w = c.status().apply
      assert.equal(w.state === 'waiting' ? w.turns : -1, 1)
      assert.equal(spawned.length, 0)
      turns = 0
      c.poke()
      await sleep(5)
      assert.equal(spawned.length, 1)
      assert.equal(c.status().apply.state, 'applying')
      // Повторное «Обновить» во время установки — не второй процесс.
      assert.deepEqual(await c.apply(false), { applying: true, to: '0.2.28' })
      assert.equal(spawned.length, 1)
      // pult update вышел с ошибкой (демон жив) — провал виден окну.
      spawned[0]?.emit('exit', 1, null)
      const st = c.status().apply
      assert.equal(st.state, 'failed')
      assert.match(st.state === 'failed' ? st.error : '', /с кодом 1 — подробности: .*update\.log/)
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('force — запуск сразу, хотя ходы идут', async () => {
    const home = tempHome()
    let spawned = 0
    const c = checker(home, { http: channel(() => '0.2.28').http, runningTurns: () => 3, spawnApply: () => { spawned++; return new FakeChild() } })
    try {
      assert.deepEqual(await c.apply(true), { applying: true, to: '0.2.28' })
      assert.equal(spawned, 1)
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('ставить нечего или версия bad — отказ, ничего не запущено', async () => {
    const home = tempHome()
    let spawned = 0
    const same = checker(home, { http: channel(() => '0.2.27').http, spawnApply: () => { spawned++; return new FakeChild() } })
    try {
      await assert.rejects(same.apply(false), /ставить нечего: 0\.2\.27 — последняя/)
      writeState(home.paths, { current: null, previous: null, bad: ['0.2.28'], installed: {}, last: null })
      const bad = checker(home, { http: channel(() => '0.2.28').http, spawnApply: () => { spawned++; return new FakeChild() } })
      await bad.check()
      assert.equal(bad.status().available, false)
      assert.equal(bad.status().bad, true)
      await assert.rejects(bad.apply(false), /уже не прошла пробу на этой машине.*pult update --to 0\.2\.28/)
      bad.stop()
      assert.equal(spawned, 0)
    } finally {
      same.stop()
      home.remove()
    }
  })
})

describe('командная строка и окружение pult update из демона', () => {
  it('лаунчер команды, иначе node + свой CLI; --expect версии; Linux под службой — своя scope-группа systemd', () => {
    const base = { node: '/n/node', cliEntry: '/p/dist/cli/main.js', systemdRun: '/usr/bin/systemd-run', expect: '1.0.3' }
    const tail = ['update', '--expect', '1.0.3']
    assert.deepEqual(applyArgv({ ...base, launcher: '/h/bin/pult', platform: 'darwin', service: true }), ['/h/bin/pult', ...tail])
    assert.deepEqual(applyArgv({ ...base, launcher: null, platform: 'darwin', service: false }), ['/n/node', '/p/dist/cli/main.js', ...tail])
    assert.deepEqual(applyArgv({ ...base, launcher: '/h/bin/pult', platform: 'linux', service: true }),
      ['/usr/bin/systemd-run', '--user', '--scope', '--collect', '--quiet', '--', '/h/bin/pult', ...tail])
    assert.deepEqual(applyArgv({ ...base, launcher: '/h/bin/pult', platform: 'linux', service: false }), ['/h/bin/pult', ...tail])
    assert.deepEqual(applyArgv({ ...base, systemdRun: null, launcher: '/h/bin/pult', platform: 'linux', service: true }), ['/h/bin/pult', ...tail])
  })

  it('окружение ребёнка: шина пользователя Linux (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS) есть, чужого нет', () => {
    const home = tempHome()
    try {
      const env = applyEnv(home.paths, {
        PATH: '/usr/bin:/bin', HOME: '/home/user', USER: 'u',
        XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        PULT_SERVICE_NAME: 'pult-x', XDG_CONFIG_HOME: '/home/user/.cfg', PULT_NODE_MIRROR: 'https://n.example/dist', PULT_UPDATE_URL: 'https://m.example/l.json',
        PULT_SERVICE: '1', ANTHROPIC_API_KEY: 'sk-test', PULT_TEST_UPDATE_HOLD_MS: '5',
      })
      assert.equal(env['XDG_RUNTIME_DIR'], '/run/user/1000')
      assert.equal(env['DBUS_SESSION_BUS_ADDRESS'], 'unix:path=/run/user/1000/bus')
      assert.equal(env['PULT_SERVICE_NAME'], 'pult-x')
      assert.equal(env['XDG_CONFIG_HOME'], '/home/user/.cfg')
      assert.equal(env['PULT_UPDATE_URL'], 'https://m.example/l.json')
      assert.equal(env['PULT_HOME'], home.paths.home)
      // Метка «я — демон службы» ребёнку не нужна; ключи провайдеров — тем более; тестовый шов — только под PULT_TEST.
      for (const k of ['PULT_SERVICE', 'ANTHROPIC_API_KEY', 'PULT_TEST_UPDATE_HOLD_MS']) assert.equal(env[k], undefined, k)
      for (const k of APPLY_PASS) assert.ok(k in env, k)
      // Попытка в update.json узнает, что вывод — в файле, а не в терминале.
      assert.equal(env['PULT_UPDATE_LOG'], home.paths.updateLog)
    } finally {
      home.remove()
    }
  })

  it('logs/update.log больше 1 МБ — уходит в update.log.1, новый с нуля', () => {
    const home = tempHome()
    try {
      writeFileSync(home.paths.updateLog, 'x'.repeat(200))
      closeSync(openUpdateLog(home.paths, 100))
      assert.equal(readFileSync(`${home.paths.updateLog}.1`, 'utf8').length, 200)
      assert.equal(readFileSync(home.paths.updateLog, 'utf8'), '')
      writeFileSync(home.paths.updateLog, 'y'.repeat(50))
      closeSync(openUpdateLog(home.paths, 100))
      assert.equal(readFileSync(home.paths.updateLog, 'utf8').length, 50, 'маленький не трогаем')
    } finally {
      home.remove()
    }
  })
})

describe('демон целиком: update.* по сокету и настоящие ходы', () => {
  it('update.check → daemon.status.update; update.apply ждёт идущий ход и запускается после стопа; force — сразу', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-upd-'))
    // Ход держится открытым: `hang` до первого события (fake-claude, настройка через файл в папке сессии).
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, hang: 60_000 }))
    let spawned = 0
    home.config.updates = { check: true, url: URL_LATEST }
    const d = await startTestDaemon(home, {
      updates: { http: channel(() => '99.0.0').http, keys: KEYS, schedule: false, spawnApply: () => { spawned++; return new FakeChild() } },
    })
    const c = await connectClient(home.paths)
    try {
      const before = (await c.request('update.status')) as UpdateStatus
      assert.equal(before.latest, null)
      const checked = (await c.request('update.check')) as UpdateStatus
      assert.equal(checked.latest?.version, '99.0.0')
      assert.equal(checked.available, true)
      const st = (await c.request('daemon.status')) as DaemonStatus
      assert.equal(st.update?.latest?.version, '99.0.0')
      assert.equal(st.protocol, 1)

      await c.request('agent.start', { name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await c.request('agent.prompt', { name: 'w', text: 'долгий ход' })
      assert.ok(await waitFor(() => d.manager.list().some((r) => r.lastStatus === 'working'), 10_000), 'ход не начался')

      assert.deepEqual(await c.request('update.apply'), { waiting: 1 })
      assert.equal(((await c.request('daemon.status')) as DaemonStatus).update?.apply.state, 'waiting')
      await sleep(100)
      assert.equal(spawned, 0, 'обновление не должно стартовать посреди хода')

      await c.request('agent.stop', { name: 'w' })
      assert.ok(await waitFor(() => spawned === 1, 10_000), 'после конца хода обновление не запустилось')
      assert.equal(((await c.request('update.status')) as UpdateStatus).apply.state, 'applying')

      await assert.rejects(c.request('update.apply', { force: 'да' }), (e: unknown) => e instanceof ClientError && e.code === 'invalid_params')
    } finally {
      c.close()
      await d.stop('тест')
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('force: true — запуск сразу, хотя ход идёт', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-upd-'))
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, hang: 60_000 }))
    let spawned = 0
    home.config.updates = { check: true, url: URL_LATEST }
    const d = await startTestDaemon(home, {
      updates: { http: channel(() => '99.0.0').http, keys: KEYS, schedule: false, spawnApply: () => { spawned++; return new FakeChild() } },
    })
    const c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await c.request('agent.prompt', { name: 'w', text: 'долгий ход' })
      assert.ok(await waitFor(() => d.manager.list().some((r) => r.lastStatus === 'working'), 10_000))
      assert.deepEqual(await c.request('update.apply', { force: true }), { applying: true, to: '99.0.0' })
      assert.equal(spawned, 1)
    } finally {
      c.close()
      await d.stop('тест')
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('тестовый демон без шва расписания не заводит: ни запроса, ни файла итога', async () => {
    const home = tempHome()
    const d = await startTestDaemon(home)
    try {
      await sleep(100)
      assert.equal(existsSync(home.paths.updateCheck), false)
      assert.equal(d.status().update?.checking, false)
    } finally {
      await d.stop('тест')
      home.remove()
    }
  })
})

describe('ревью M8c: гонки, откат, рабочая копия, повторы проверки', () => {
  it('два «Обновить» разом, пока идёт проверка, — один ребёнок, один итог', async () => {
    const home = tempHome()
    let spawned = 0
    // Канал отвечает не сразу: оба вызова застают «available: false» и ждут проверку.
    const slow: HttpGet = async (url, signal) => { await sleep(50); return channel(() => '0.2.28').http(url, signal) }
    const c = checker(home, { http: slow, spawnApply: () => { spawned++; return new FakeChild() } })
    try {
      const [a, b] = await Promise.all([c.apply(false), c.apply(false)])
      assert.deepEqual(a, { applying: true, to: '0.2.28' })
      assert.deepEqual(b, a)
      assert.equal(spawned, 1)
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('stop() во время проверки: итог не пишется в дом, «Обновить» ребёнка не запускает', async () => {
    const home = tempHome()
    let spawned = 0
    const slow: HttpGet = async (url, signal) => { await sleep(80); return channel(() => '0.2.28').http(url, signal) }
    const c = checker(home, { http: slow, spawnApply: () => { spawned++; return new FakeChild() } })
    try {
      const checking = c.check()
      const applying = c.apply(false)
      await sleep(10)
      c.stop()
      await checking
      await assert.rejects(applying, (e: Error) => e instanceof ApplyError && /останавливается/.test(e.message))
      assert.equal(existsSync(home.paths.updateCheck), false, 'проверка после stop() записала update-check.json')
      assert.equal(spawned, 0)
    } finally {
      home.remove()
    }
  })

  it('выход ПРЕЖНЕГО ребёнка не трогает состояние нового', async () => {
    const home = tempHome()
    const kids: FakeChild[] = []
    const c = checker(home, { http: channel(() => '0.2.28').http, spawnApply: () => { const k = new FakeChild(); kids.push(k); return k } })
    try {
      await c.apply(false)
      kids[0]?.emit('exit', 1, null)
      assert.equal(c.status().apply.state, 'failed')
      await c.apply(false) // «Повторить»
      assert.equal(kids.length, 2)
      kids[0]?.emit('error', new Error('запоздалое'))
      kids[0]?.emit('exit', 1, null)
      assert.equal(c.status().apply.state, 'applying', 'прежний ребёнок затёр состояние нового')
      kids[1]?.emit('exit', 1, null)
      assert.equal(c.status().apply.state, 'failed')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('N1: «ставится» кончилось, демон жив — onApplyEnd (будит очереди): провал, удачный выход, ошибка спавна', async () => {
    const home = tempHome()
    const kids: FakeChild[] = []
    let ends = 0
    const c = createUpdateChecker({
      paths: home.paths, config: { ...home.config, updates: { check: true, url: URL_LATEST } }, logger: home.logger,
      current: '0.2.27', keys: KEYS, runningTurns: () => 0, stage: false, schedule: false, http: channel(() => '0.2.28').http,
      spawnApply: () => { const k = new FakeChild(); kids.push(k); return k }, onApplyEnd: () => { ends++ },
    })
    try {
      await c.apply(false)
      assert.equal(ends, 0)
      kids[0]?.emit('exit', 1, null)
      assert.equal(ends, 1)
      await c.apply(false)
      kids[1]?.emit('exit', 0, null)
      assert.equal(ends, 2)
      await c.apply(false)
      kids[2]?.emit('error', new Error('ENOENT'))
      assert.equal(ends, 3)
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('applying() — пока ребёнок жив; выход — снова можно', async () => {
    const home = tempHome()
    const kids: FakeChild[] = []
    const c = checker(home, { http: channel(() => '0.2.28').http, spawnApply: () => { const k = new FakeChild(); kids.push(k); return k } })
    try {
      assert.equal(c.applying(), false)
      await c.apply(true)
      assert.equal(c.applying(), true)
      kids[0]?.emit('exit', 2, null)
      assert.equal(c.applying(), false)
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('проба не прошла и откат (update.json, action channel) — status.failure; иные попытки — нет', async () => {
    const home = tempHome()
    const c = checker(home, { http: channel(() => '0.2.28').http })
    try {
      const last = { at: '2026-10-19T11:00:00Z', action: 'channel' as const, version: '0.2.28', was: '0.2.27', result: 'rolled_back' as const, message: 'не прошла пробу', log: home.paths.updateLog }
      writeState(home.paths, { current: '0.2.27', previous: null, bad: ['0.2.28'], installed: {}, last })
      await c.check()
      const st = c.status()
      assert.equal(st.available, false)
      assert.deepEqual(st.failure, { to: '0.2.28', back: '0.2.27', at: last.at, result: 'rolled_back', message: 'не прошла пробу', log: home.paths.updateLog })
      writeState(home.paths, { current: '0.2.27', previous: null, bad: [], installed: {}, last: { ...last, action: 'from' } })
      assert.equal(c.status().failure, null, '--from руками — не дело плашки канала')
      // Канал из терминала: файла журнала у попытки нет — окно скажет «в терминале».
      const { log: _drop, ...noLog } = last
      writeState(home.paths, { current: '0.2.27', previous: null, bad: [], installed: {}, last: noLog })
      assert.equal(c.status().failure?.log, null)
      writeState(home.paths, { current: '0.2.27', previous: null, bad: [], installed: {}, last: { ...last, result: 'failed', message: 'проба идёт (прервана?)' } })
      assert.equal(c.status().failure, null, 'идущая проба — ещё не итог')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('рабочая копия (daemon install --dev) — «Доступна» не показывается', async () => {
    const home = tempHome()
    const copy = mkdtempSync(join(tmpdir(), 'pt-dev-'))
    writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'pult', version: '0.2.27' }))
    mkdirSync(home.paths.versions, { recursive: true })
    symlinkSync(copy, join(home.paths.versions, '0.2.27-dev'))
    symlinkSync(join('versions', '0.2.27-dev'), home.paths.current)
    const c = checker(home, { http: channel(() => '0.2.28').http })
    try {
      const st = await c.check()
      assert.equal(st.latest?.version, '0.2.28')
      assert.equal(st.available, false)
      await assert.rejects(c.apply(false), /ставить нечего/)
    } finally {
      c.stop()
      rmSync(copy, { recursive: true, force: true })
      home.remove()
    }
  })

  it('неудачная проверка повторяется через 15 мин, 1 ч, 6 ч, потом раз в сутки; удача сбрасывает', async () => {
    const home = tempHome()
    let clock = 0
    let fail = true
    let calls = 0
    const http: HttpGet = async (url, signal) => { calls++; if (fail) throw new Error('ENOTFOUND'); return channel(() => '0.2.28').http(url, signal) }
    const min = 60_000
    const c = checker(home, { http, schedule: true, firstDelayMs: 0, intervalMs: 24 * 60 * min, jitterMs: 0, tickMs: 5, now: () => clock })
    const settle = async (n: number): Promise<void> => { assert.ok(await waitFor(() => calls === n, 2000), `ждали ${n} проверок, было ${calls}`); await sleep(30) }
    try {
      await settle(1)
      clock += 14 * min; await sleep(40); assert.equal(calls, 1, 'раньше 15 мин — тишина')
      clock += 1 * min; await settle(2)
      clock += 59 * min; await sleep(40); assert.equal(calls, 2)
      clock += 1 * min; await settle(3)
      clock += 6 * 60 * min; await settle(4)
      clock += 6 * 60 * min; await sleep(40); assert.equal(calls, 4, 'после трёх повторов — снова сутки')
      fail = false
      clock += 18 * 60 * min; await settle(5)
      clock += 15 * min; await sleep(40); assert.equal(calls, 5, 'удача — следующая через сутки')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('pult doctor: ошибка канала — warn «канал обновлений: …», а не fail', () => {
    const st = (u: Partial<UpdateStatus>): DaemonStatus => ({ update: { enabled: true, current: '0.2.27', checking: false, checkedAt: null, error: null, latest: null, available: false, bad: false, apply: { state: 'idle' }, failure: null, ...u } } as unknown as DaemonStatus)
    const err = channelDoctorItem(st({ error: 'latest.json: … ответил HTTP 404 — релизов в канале нет или адрес недоступен' }))
    assert.equal(err?.status, 'warn')
    assert.match(err?.detail ?? '', /^канал обновлений: latest\.json/)
    assert.equal(channelDoctorItem(st({}))?.status, 'ok')
    assert.equal(channelDoctorItem(null), null)
    const latest = { version: '0.2.28', released: 'x', notes: 'https://x.example/n' }
    assert.match(channelDoctorItem(st({ latest, available: true }))?.detail ?? '', /доступна 0\.2\.28 .* pult update/)
  })
})

describe('пока ставится обновление, новые ходы не заводятся', () => {
  it('agent.prompt (и «прервать и сказать») — отказ updating с русской причиной; после провала ребёнка — снова можно', async () => {
    const home = tempHome()
    home.config.updates = { check: true, url: URL_LATEST }
    const cwd = mkdtempSync(join(tmpdir(), 'pt-upd-'))
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0 }))
    const kids: FakeChild[] = []
    const d = await startTestDaemon(home, {
      updates: { http: channel(() => '99.0.0').http, keys: KEYS, schedule: false, spawnApply: () => { const k = new FakeChild(); kids.push(k); return k } },
    })
    const c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd, mode: 'turn' })
      assert.deepEqual(await c.request('update.apply'), { applying: true, to: '99.0.0' })
      for (const params of [{ name: 'w', text: 'привет' }, { name: 'w', text: 'привет', interrupt: true }]) {
        await assert.rejects(c.request('agent.prompt', params), (e: unknown) =>
          e instanceof ClientError && e.code === 'updating' && /Пульт обновляется — отправь после перезапуска/.test(e.message), JSON.stringify(params))
      }
      // Окно шлёт `queue` на каждый Enter: свободной сессии — тот же отказ (черновик остаётся в поле).
      await assert.rejects(c.request('agent.prompt', { name: 'w', text: 'привет', queue: true }), (e: unknown) => e instanceof ClientError && e.code === 'updating')
      assert.equal(d.manager.list()[0]?.lastStatus !== 'working', true)
      kids[0]?.emit('exit', 1, null)
      await c.request('agent.prompt', { name: 'w', text: 'теперь можно' })
      assert.ok(await waitFor(() => d.manager.list()[0]?.lastStatus === 'idle', 10_000))
    } finally {
      c.close()
      await d.stop('тест')
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })
})

describe('обновление из окна: срок 6 ч, проверка по фокусу, флаг из «Настроек»', () => {
  const min = 60_000
  const hour = 60 * min

  it('сроки по умолчанию: первая через 60 с, дальше раз в 6 ч ± 30 мин; удачная ручная сдвигает плановую', async () => {
    assert.equal(FIRST_CHECK_MS, 60_000)
    assert.equal(CHECK_INTERVAL_MS, 6 * hour)
    assert.equal(CHECK_JITTER_MS, 30 * min)
    assert.equal(MIN_AUTO_GAP_MS, 10 * min)
    const home = tempHome()
    const ch = channel(() => '0.2.28')
    let clock = 1_000_000
    // random 0.5 — разброс ровно ноль; остальные сроки — по умолчанию.
    const c = checker(home, { http: ch.http, schedule: true, tickMs: 5, now: () => clock, random: () => 0.5 })
    const calls = async (n: number, what: string): Promise<void> => { assert.ok(await waitFor(() => ch.calls() === n, 2000), `${what}: ждали ${n}, было ${ch.calls()}`); await sleep(20) }
    try {
      clock += 59_000; await sleep(40); assert.equal(ch.calls(), 0, 'раньше минуты — тишина')
      clock += 1_000; await calls(1, 'первая через 60 с')
      clock += 6 * hour - 1; await sleep(40); assert.equal(ch.calls(), 1, 'раньше 6 ч — тишина')
      clock += 1; await calls(2, 'вторая через 6 ч')
      clock += 5 * hour
      await c.check() // ручная за час до плановой
      assert.equal(ch.calls(), 3)
      clock += 1 * hour; await sleep(40); assert.equal(ch.calls(), 3, 'плановая сдвинута ручной на полный срок')
      clock += 5 * hour; await calls(4, 'плановая через 6 ч после ручной')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('по фокусу окна: только если последняя попытка старше просимого; не чаще раза в 10 мин; ручная — без предела', async () => {
    const home = tempHome()
    const ch = channel(() => '0.2.28')
    let clock = 1_000_000
    const c = checker(home, { http: ch.http, schedule: true, firstDelayMs: 100 * hour, now: () => clock })
    try {
      const st = await c.checkIfStale(hour)
      assert.equal(ch.calls(), 1, 'проверок ещё не было — идём в сеть')
      assert.equal(st.latest?.version, '0.2.28')
      await Promise.all([c.checkIfStale(hour), c.checkIfStale(0), c.checkIfStale(hour)])
      assert.equal(ch.calls(), 1, 'только что проверяли — без сети')
      clock += 30 * min
      await c.checkIfStale(hour)
      assert.equal(ch.calls(), 1, 'моложе часа — без сети')
      await c.checkIfStale(0)
      assert.equal(ch.calls(), 2, 'старше 10 мин и просят «любую давность» — в сеть')
      clock += 5 * min
      await c.checkIfStale(0)
      await c.checkIfStale(-1)
      assert.equal(ch.calls(), 2, 'предел 10 мин держит любого просящего')
      await c.check()
      await c.check()
      assert.equal(ch.calls(), 4, 'ручная «Проверить сейчас» предела не знает')
      // Много окон разом, давно не проверяли — один запрос.
      clock += 2 * hour
      await Promise.all([c.checkIfStale(hour), c.checkIfStale(hour), c.checkIfStale(hour)])
      assert.equal(ch.calls(), 5)
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('по фокусу без автопроверки (updates.check: false или тестовый демон без шва) — сети нет', async () => {
    const home = tempHome()
    const ch = channel(() => '0.2.28')
    const off = createUpdateChecker({
      paths: home.paths, config: { ...home.config, updates: { check: false, url: URL_LATEST } }, logger: home.logger,
      current: '0.2.27', keys: KEYS, runningTurns: () => 0, stage: false, http: ch.http, firstDelayMs: 100 * hour,
    })
    const noSeam = checker(home, { http: ch.http, schedule: false })
    try {
      assert.equal((await off.checkIfStale(0)).enabled, false)
      await noSeam.checkIfStale(0)
      assert.equal(ch.calls(), 0)
    } finally {
      off.stop()
      noSeam.stop()
      home.remove()
    }
  })

  it('setEnabled на лету: включили — расписание с первой проверки; выключили — ни запроса сам', async () => {
    const home = tempHome()
    const ch = channel(() => '0.2.28')
    let clock = 1_000_000
    const c = createUpdateChecker({
      paths: home.paths, config: { ...home.config, updates: { check: false, url: URL_LATEST } }, logger: home.logger,
      current: '0.2.27', keys: KEYS, runningTurns: () => 0, stage: false, http: ch.http, tickMs: 5, now: () => clock, random: () => 0.5,
    })
    try {
      clock += 2 * min; await sleep(40)
      assert.equal(ch.calls(), 0)
      c.setEnabled(true)
      assert.equal(c.status().enabled, true)
      clock += 59_000; await sleep(40); assert.equal(ch.calls(), 0)
      clock += 1_000; assert.ok(await waitFor(() => ch.calls() === 1, 2000), 'после включения первая проверка не пришла')
      c.setEnabled(false)
      assert.equal(c.status().enabled, false)
      clock += 24 * hour; await sleep(60)
      assert.equal(ch.calls(), 1, 'выключено — ни одного запроса сам')
      assert.equal(ch.calls(), (await c.checkIfStale(0), ch.calls()), 'и по фокусу — тоже')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('демон: settings.set принимает только updates.check (true/false); адрес канала и прочее — отказ, файл не тронут', async () => {
    const home = tempHome()
    const url = 'https://mirror.example/latest.json'
    writeFileSync(home.paths.config, JSON.stringify({ version: 1, updates: { check: true, url }, custom: 1 }))
    home.config.updates = { check: true, url }
    const d = await startTestDaemon(home, { updates: { http: channel(() => '0.2.28').http, keys: KEYS, schedule: false } })
    const c = await connectClient(home.paths)
    const bad = (e: unknown): boolean => e instanceof ClientError && e.code === 'invalid_params'
    const ns = { rememberLast: true, defaults: { claude: {}, codex: {} } }
    try {
      assert.deepEqual(((await c.request('settings.get')) as { updates: unknown }).updates, { check: true })
      const before = readFileSync(home.paths.config, 'utf8')
      for (const params of [
        { updates: { url: 'https://evil.example/latest.json' } },
        { updates: { check: false, url: 'https://evil.example/latest.json' } },
        { updates: { check: 'false' } },
        { updates: { check: 0 } },
        { updates: {} },
        { updates: true },
        { updates: null },
        { updates: [false] },
        { newSession: ns, updates: { check: 'нет' } },
        { updates: { check: false }, network: { claude: { mode: 'off' } } },
        { updates: { check: false }, notify: { sound: false } },
      ]) {
        await assert.rejects(c.request('settings.set', params), bad, JSON.stringify(params))
      }
      assert.equal(readFileSync(home.paths.config, 'utf8'), before, 'отказ — файл не тронут')
      await assert.rejects(c.request('update.check', { ifOlderThanMs: 'час' }), bad)

      const r = (await c.request('settings.set', { updates: { check: false } })) as { updates: unknown; newSession: unknown }
      assert.deepEqual(r.updates, { check: false })
      const file = JSON.parse(readFileSync(home.paths.config, 'utf8')) as Record<string, unknown>
      assert.deepEqual(file['updates'], { check: false, url }, 'url остался прежним')
      assert.equal(file['custom'], 1)
      assert.equal(((await c.request('update.status')) as UpdateStatus).enabled, false)
      // Вместе с newSession — одним вызовом.
      await c.request('settings.set', { newSession: ns, updates: { check: true } })
      assert.deepEqual((JSON.parse(readFileSync(home.paths.config, 'utf8')) as Record<string, unknown>)['updates'], { check: true, url })
      assert.equal(((await c.request('daemon.status')) as DaemonStatus).update?.enabled, true)
    } finally {
      c.close()
      await d.stop('тест')
      home.remove()
    }
  })
})

// 0.3.16: фоновая подготовка. Проверка нашла новую версию — демон сразу готовит её (ребёнок `pult update --stage`,
// окно — `app.stage`), только при автопроверке или по ручной проверке; «Перезапустить» посреди подготовки ждёт её.
describe('0.3.16: фоновая подготовка и «Перезапустить»', () => {
  const staging = (home: TempHome, over: Partial<CheckerOptions> = {}): { c: ReturnType<typeof createUpdateChecker>; stages: FakeChild[]; applies: FakeChild[]; launched: string[] } => {
    const stages: FakeChild[] = []
    const applies: FakeChild[] = []
    const launched: string[] = []
    const c = checker(home, {
      http: channel(() => '0.2.28').http,
      stage: true,
      spawnStage: () => { const k = new FakeChild(); stages.push(k); return k },
      spawnApply: () => { const k = new FakeChild(); applies.push(k); return k },
      onLaunch: (to) => { launched.push(to) },
      ...over,
    })
    return { c, stages, applies, launched }
  }

  it('ручная проверка: «скачиваю в фоне» → ребёнок вышел 0 → «готово»; повторная проверка второй раз не готовит', async () => {
    const home = tempHome()
    const { c, stages } = staging(home)
    try {
      const st = await c.check()
      assert.equal(stages.length, 1, 'pult update --stage не запущен')
      assert.deepEqual([st.staged?.to, st.staged?.state], ['0.2.28', 'downloading'])
      stages[0]?.emit('exit', 0, null)
      assert.ok(await waitFor(() => c.status().staged?.state === 'ready', 2000))
      await c.check()
      assert.equal(stages.length, 1, 'готовое не готовится заново')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('автопроверка выключена — плановая/фокусная проверка не готовит, ручная готовит; подготовка выключена — никогда', async () => {
    const home = tempHome()
    const off = staging(home, { config: { ...home.config, updates: { check: false, url: URL_LATEST } }, schedule: true })
    try {
      await off.c.checkIfStale(0)
      assert.equal(off.stages.length, 0)
      await off.c.check()
      assert.equal(off.stages.length, 1, 'ручная «Проверить сейчас» готовит всегда')
    } finally {
      off.c.stop()
    }
    const never = staging(home, { stage: false })
    try {
      await never.c.check()
      assert.equal(never.stages.length, 0)
      assert.equal(never.c.status().staged, null)
    } finally {
      never.c.stop()
      home.remove()
    }
  })

  it('провал подготовки — тихо: staged failed с причиной; плановая не повторяет раньше срока, ручная — сразу', async () => {
    const home = tempHome()
    const { c, stages } = staging(home, { schedule: true, firstDelayMs: 3_600_000, retryMs: [3_600_000] })
    try {
      await c.check()
      stages[0]?.emit('exit', 1, null)
      assert.ok(await waitFor(() => c.status().staged?.state === 'failed', 2000))
      const st = c.status()
      assert.match(st.staged?.error ?? '', /подготовка вышла с кодом 1 — подробности: .*update\.log/)
      assert.equal(st.apply.state, 'idle', 'провал подготовки — не провал обновления')
      assert.equal(st.failure, null)
      await c.checkIfStale(0) // по фокусу: раньше срока повтора — без подготовки
      assert.equal(stages.length, 1)
      await c.check()
      assert.equal(stages.length, 2, 'ручная проверка повторяет сразу')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('«Перезапустить» посреди подготовки ждёт её, потом запускает pult update; с окном — сначала журнал (onLaunch)', async () => {
    const home = tempHome()
    const { c, stages, applies, launched } = staging(home)
    try {
      await c.check()
      const r = await c.apply(false, true)
      assert.deepEqual(r, { applying: true, to: '0.2.28' })
      assert.equal(c.status().apply.state, 'applying')
      assert.equal(applies.length, 0, 'pult update не должен идти поверх --stage (общий update.lock)')
      assert.equal(c.applying(), true, 'ходы уже придержаны')
      stages[0]?.emit('exit', 0, null)
      assert.ok(await waitFor(() => applies.length === 1, 2000))
      assert.deepEqual(launched, ['0.2.28'])
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('без окна (target package) — журнала нет; подготовка не начинается, пока идёт «Перезапустить»', async () => {
    const home = tempHome()
    const { c, stages, applies, launched } = staging(home)
    try {
      await c.check()
      stages[0]?.emit('exit', 0, null)
      assert.ok(await waitFor(() => c.status().staged?.state === 'ready', 2000))
      await c.apply(false)
      assert.equal(applies.length, 1)
      assert.deepEqual(launched, [])
      await c.check()
      assert.equal(stages.length, 1, 'во время установки не готовим')
    } finally {
      c.stop()
      home.remove()
    }
  })

  it('окно готовится вместе с пакетом: ready — только когда готово и то и другое; окно одно (пакет последний) — без ребёнка', async () => {
    const home = tempHome()
    let release: () => void = () => {}
    const staged: string[] = []
    const app = {
      wanted: (v: string) => v === '0.1.14',
      ready: () => false,
      stage: async (m: { app?: { version: string } }) => { staged.push(m.app?.version ?? '?'); await new Promise<void>((r) => { release = r }) },
    }
    // В манифесте у окна должен быть архив — иначе готовить нечего.
    const withZip: HttpGet = async (url) => {
      if (url !== URL_LATEST) return { status: 404, header: () => null, body: null }
      const m = {
        schema: 1, version: '0.2.27', released: '2026-10-19T10:00:00.000Z', notes: 'https://github.com/pawellazarew/pult/releases/tag/v0.2.27',
        package: { url: 'https://example.invalid/pult-0.2.27.tgz', sha256: 'c'.repeat(64), size: 10 },
        app: { version: '0.1.14', minVersion: '0.1.13', 'darwin-arm64': { url: 'https://example.invalid/Pult.zip', sha256: 'd'.repeat(64), size: 10 } },
      }
      const b = Buffer.from(signEnvelope(Buffer.from(JSON.stringify(m)), privateKey))
      return { status: 200, header: () => null, body: (async function* () { yield b })() }
    }
    const { c, stages } = staging(home, { http: withZip, app })
    try {
      await c.check()
      assert.equal(stages.length, 0, 'пакет 0.2.27 — последний: ребёнка нет')
      assert.ok(await waitFor(() => staged.length === 1, 2000))
      assert.equal(c.status().staged?.state, 'downloading')
      release()
      assert.ok(await waitFor(() => c.status().staged?.state === 'ready', 2000))
    } finally {
      c.stop()
      home.remove()
    }
  })
})
