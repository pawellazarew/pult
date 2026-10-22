// `pult update` на НАСТОЯЩЕМ npm и НАСТОЯЩИХ тарболах (docs/08 §9), только `--offline`.
//
// Тарболы собираются один раз на файл из временной копии пакета:
//   A 0.0.1, B 0.0.2 — исправные; C 0.0.3 — демон выходит с кодом 1 сразу;
//   D 0.0.4 — демон отвечает hello_ok и падает через секунду (ловит только «жив через 2 с»);
//   E 0.0.5 — исправная, для хранения; X — пакет с чужим именем.
// Каждое обновление после первого делает CLI ПРЕДЫДУЩЕЙ версии (`current/bin/pult`) — ровно как у
// человека через ~/.local/bin/pult. Это и есть проверка ловушки: старый CLI обязан поднять демона
// НОВОЙ версии из current, а не из своего ../daemon/main.js.
// Каждый поднятый демон гасится в after/finally; сирот нет.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import type { DaemonStatus } from '../dist/core/rpc.js'
import { rotateToken } from '../dist/core/token.js'
import { stopRunningDaemon } from '../dist/service/install.js'
import { versionDoctorItems } from '../dist/update/doctor.js'
import { daemonStatusOnce } from '../dist/update/probe.js'
import { compareVersions, isVersionName } from '../dist/update/versions.js'
import { FAKE_CLAUDE, FAKE_CODEX, reapFakeSupervisors, removeTree, waitFor } from './helpers.js'
import { BROKEN_DAEMON, CLI, CRASH_AFTER_HELLO, fakeNodeTarball, fakePin, NODE_DIR, packPult, ROOT, runProc } from './pack-helpers.js'
import { platformKey, runtimeName } from '../dist/update/runtime.js'
import type { PlatformKey } from '../dist/update/runtime.js'
import type { Run } from './pack-helpers.js'

const FAKES = join(ROOT, 'test', 'fakes')
const USER = userInfo().username

interface Tarballs { A: string; B: string; C: string; D: string; E: string; X: string }

let work = ''
let tb: Tarballs

before(() => {
  work = mkdtempSync(join(tmpdir(), 'pk-'))
  tb = {
    A: packPult(work, { version: '0.0.1' }),
    B: packPult(work, { version: '0.0.2' }),
    C: packPult(work, { version: '0.0.3', daemonMain: BROKEN_DAEMON }),
    D: packPult(work, { version: '0.0.4', appendToDaemon: CRASH_AFTER_HELLO }),
    E: packPult(work, { version: '0.0.5' }),
    X: packPult(work, { version: '0.0.1', name: 'not-pult' }),
  }
})
after(() => { rmSync(work, { recursive: true, force: true }) })

interface Home {
  dir: string
  paths: PultPaths
  fakeHome: string
  env: Record<string, string>
  pids: Set<number>
}

function makeHome(extra: Record<string, string> = {}): Home {
  // Короткий префикс: путь сокета упирается в 104 байта sun_path на macOS.
  const dir = mkdtempSync(join(tmpdir(), 'pu-'))
  const paths = layout(join(dir, 'h'))
  const fakeHome = join(dir, 'home')
  mkdirSync(fakeHome, { recursive: true })
  const env: Record<string, string> = {
    PATH: `${NODE_DIR}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
    HOME: fakeHome,
    USER,
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
    PULT_HOME: paths.home,
    PULT_TEST: '1',
    PULT_CLAUDE_BIN: FAKE_CLAUDE,
    PULT_CODEX_BIN: FAKE_CODEX,
    ...extra,
  }
  return { dir, paths, fakeHome, env, pids: new Set() }
}

/** CLI активной версии — как у человека: через симлинк current, а не через рабочую копию. */
const currentCli = (h: Home): string => join(h.paths.current, 'bin', 'pult')

function cli(h: Home, args: string[], entry = CLI, extra: Record<string, string> = {}): Promise<Run> {
  return runProc(process.execPath, [entry, ...args], { ...h.env, ...extra }).done
}

async function status(h: Home): Promise<DaemonStatus | null> {
  const r = await cli(h, ['daemon', 'status', '--json'])
  const j = JSON.parse(r.stdout) as DaemonStatus & { running: boolean }
  if (!j.running) return null
  h.pids.add(j.pid)
  return j
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function teardown(h: Home): Promise<void> {
  await cli(h, ['daemon', 'stop'])
  for (const pid of h.pids) { try { process.kill(pid, 'SIGKILL') } catch { /* ушёл */ } }
  await waitFor(() => !existsSync(h.paths.lock) && [...h.pids].every((p) => !alive(p)), 10_000)
  // Надзиратель фальшивого launchd отсоединён и после смерти процесса службы ещё пишет состояние и
  // журнал в этот дом: стирать дом можно только после его выхода (ENOTEMPTY на CI macOS, 22.10.2026).
  await reapFakeSupervisors(join(h.dir, 'fake.jsonl'))
  removeTree(h.dir)
}

const state = (h: Home): { current: string | null; previous: string | null; bad: string[]; last: { result: string } | null } =>
  JSON.parse(readFileSync(h.paths.updateState, 'utf8')) as { current: string | null; previous: string | null; bad: string[]; last: { result: string } | null }

const onDisk = (h: Home): string[] => readdirSync(h.paths.versions).sort()

/** Командная строка процесса: доказательство, ИЗ КАКОГО файла поднят демон. */
function commandOf(pid: number): string {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  return (r.stdout ?? '').trim()
}

describe('pult update: A → B → C (откат) → D (откат) → --to A → --list → хранение', () => {
  let h: Home
  before(() => { h = makeHome() })
  after(async () => { await teardown(h) })

  it('A: первая установка — current, лаунчер, update.json; демона до не было — после пробы его нет', async () => {
    const r = await cli(h, ['update', '--from', tb.A])
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /pult 0\.0\.1 установлен/)
    assert.match(r.stdout, /прошёл пробу/)
    assert.equal(readlinkSync(h.paths.current), join('versions', '0.0.1'))
    assert.ok(existsSync(join(h.paths.versions, '0.0.1', 'bin', 'pultd')))
    assert.equal(statSync(h.paths.versions).mode & 0o777, 0o700)
    assert.equal(statSync(h.paths.launcher).mode & 0o777, 0o755)
    assert.deepEqual(readFileSync(h.paths.launcher), readFileSync(join(h.paths.versions, '0.0.1', 'lib', 'node_modules', 'pult', 'service', 'pultd-launch')))
    // Лаунчер команды `pult` (на своём node Пульта) — копия из пакета, как лаунчер службы.
    assert.equal(statSync(h.paths.cliLauncher).mode & 0o777, 0o755)
    assert.deepEqual(readFileSync(h.paths.cliLauncher), readFileSync(join(h.paths.versions, '0.0.1', 'lib', 'node_modules', 'pult', 'service', 'pult')))
    const st = state(h)
    assert.equal(st.current, '0.0.1')
    assert.equal(st.last?.result, 'ok')
    // Демона до обновления не было и службы нет — после удачной пробы его нет и сейчас.
    assert.ok(await waitFor(() => !existsSync(h.paths.lock), 10_000), 'проверочный демон не остановлен')
    // Инвариант 8: npm шёл с HOME=PULT_HOME и кэшем внутри него — настоящий (здесь временный) HOME пуст.
    assert.deepEqual(readdirSync(h.fakeHome), [], 'update записал что-то в HOME')
    assert.ok(!onDisk(h).some((n) => n.endsWith('.partial')))
  })

  it('B: обновляет СТАРЫЙ CLI (0.0.1) — демон 0.0.2 поднят из current, а не из ../daemon/main.js старого', async () => {
    const start = await cli(h, ['daemon', 'start'], currentCli(h))
    assert.equal(start.code, 0, start.stderr)
    const before = await status(h)
    assert.equal(before?.version, '0.0.1')

    const r = await cli(h, ['update', '--from', tb.B], currentCli(h))
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /pult обновлён: 0\.0\.1 → 0\.0\.2/)
    const now = await status(h)
    assert.equal(now?.version, '0.0.2', 'демон работает на старой версии: CLI поднял свой ../daemon/main.js')
    assert.notEqual(now?.pid, before?.pid)
    assert.ok(!alive(before?.pid ?? 0), 'старый демон жив')
    // Файл, из которого поднят демон, — через current (так же его запустит служба).
    assert.match(commandOf(now?.pid ?? 0), new RegExp(`${h.paths.current}/lib/node_modules/pult/dist/daemon/main\\.js`))
    assert.equal(readlinkSync(h.paths.current), join('versions', '0.0.2'))
    const st = state(h)
    assert.equal(st.current, '0.0.2')
    assert.equal(st.previous, '0.0.1')
  })

  it('C (демон выходит с кодом 1): откат на 0.0.2 — демон B снова отвечает, C помечена bad и лежит на диске', async () => {
    const r = await cli(h, ['update', '--from', tb.C], currentCli(h))
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stderr, /0\.0\.3 не прошла пробу: демон вышел \(код 1\)/)
    assert.match(r.stderr, /откат на 0\.0\.2/)
    assert.match(r.stderr, /C: сломанная сборка/, 'в тексте нет хвоста вывода новой версии')
    // Процесс вышел, не ответив hello_ok, — детерминированное падение: повтор не поможет (решение лида 23.09).
    assert.match(r.stderr, /проба 1\/3: демон вышел \(код 1\)/)
    assert.doesNotMatch(r.stderr, /проба 2\/3/, 'после выхода процесса до hello_ok проба повторялась')
    assert.equal(readlinkSync(h.paths.current), join('versions', '0.0.2'))
    const now = await status(h)
    assert.equal(now?.version, '0.0.2')
    assert.ok(existsSync(join(h.paths.versions, '0.0.3', 'lib', 'node_modules', 'pult', 'package.json')), 'сломанная версия удалена')
    const st = state(h)
    assert.deepEqual(st.bad, ['0.0.3'])
    assert.equal(st.current, '0.0.2')
    assert.equal(st.previous, '0.0.1', 'откат испортил previous')
    assert.equal(st.last?.result, 'rolled_back')
    assert.deepEqual(readFileSync(h.paths.launcher), readFileSync(join(h.paths.versions, '0.0.2', 'lib', 'node_modules', 'pult', 'service', 'pultd-launch')))
  })

  it('D (ответила и упала через секунду): ловится проверкой «жив через 2 с», откат на 0.0.2', async () => {
    const r = await cli(h, ['update', '--from', tb.D], currentCli(h))
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stderr, /0\.0\.4 не прошла пробу: демон 0\.0\.4 \(pid \d+\) ответил, но через 2 с уже не отвечает/)
    assert.match(r.stderr, /откат на 0\.0\.2/)
    assert.match(r.stderr, /D: ответила и падаю/)
    assert.equal(readlinkSync(h.paths.current), join('versions', '0.0.2'))
    assert.equal((await status(h))?.version, '0.0.2')
    assert.deepEqual(state(h).bad, ['0.0.3', '0.0.4'])
  })

  it('doctor: current и версия демона; демон ≠ current — «перезапусти демона»', async () => {
    const st = await status(h)
    // Плюс пункт канала обновлений (M8c): демон этой версии его знает, тестовый — «ещё не проверялся».
    const all = versionDoctorItems(h.paths, st)
    assert.equal(all.find((i) => i.id === 'update.channel')?.status, 'ok')
    const ok = all.filter((i) => i.id !== 'update.channel')
    assert.equal(ok.length, 1)
    assert.equal(ok[0]?.status, 'ok')
    assert.match(ok[0]?.detail ?? '', /current → versions\/0\.0\.2: pult 0\.0\.2; откат — 0\.0\.1; bad: 0\.0\.3, 0\.0\.4/)
    const other = versionDoctorItems(h.paths, { ...(st as DaemonStatus), version: '0.0.1' })
    const warn = other.find((i) => i.id === 'version.daemon')
    assert.equal(warn?.status, 'warn')
    assert.match(warn?.detail ?? '', /работает демон 0\.0\.1 .*current — 0\.0\.2: перезапусти демона/)
    assert.equal(warn?.fixCmd, 'pult daemon stop && pult daemon start', 'команда починки копируется из окна')
    // Через CLI доктор идёт до конца и показывает пункт (агентские CLI при PULT_TEST=1 не запускаются).
    const d = await cli(h, ['doctor', '--no-net', '--json'], currentCli(h))
    const report = JSON.parse(d.stdout) as { items: Array<{ id: string; status: string }> }
    assert.equal(report.items.find((i) => i.id === 'version.current')?.status, 'ok')
  })

  it('--reinstall активной версии — отказ, ничего не тронуто', async () => {
    const r = await cli(h, ['update', '--from', tb.B, '--reinstall'], currentCli(h))
    assert.equal(r.code, 1)
    assert.match(r.stderr, /0\.0\.2 активна — её не переставляю/)
    const again = await cli(h, ['update', '--from', tb.B], currentCli(h))
    assert.equal(again.code, 0)
    assert.match(again.stdout, /уже стоит: 0\.0\.2 активна/)
  })

  it('--to 0.0.1: ручной откат с пробой; хранение — bad уходят первыми, current и previous на месте', async () => {
    const r = await cli(h, ['update', '--to', '0.0.1'], currentCli(h))
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /pult обновлён: 0\.0\.2 → 0\.0\.1/)
    assert.equal((await status(h))?.version, '0.0.1')
    const st = state(h)
    assert.equal(st.current, '0.0.1')
    assert.equal(st.previous, '0.0.2')
    // Кандидаты на «ещё одну» — только bad C и D: исправных нет, место достаётся последней из них.
    assert.match(r.stdout, /убраны старые версии: 0\.0\.3/)
    assert.deepEqual(onDisk(h), ['0.0.1', '0.0.2', '0.0.4'])
    assert.deepEqual(st.bad, ['0.0.4'])
    const miss = await cli(h, ['update', '--to', '9.9.9'], currentCli(h))
    assert.equal(miss.code, 1)
    assert.match(miss.stderr, /версии 9\.9\.9 на диске нет/)
    const bad = await cli(h, ['update', '--to', '../x'], currentCli(h))
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /не имя версии/)
  })

  it('--list: версии, current, previous, bad — текстом и JSON', async () => {
    const j = await cli(h, ['update', '--list', '--json'], currentCli(h))
    assert.equal(j.code, 0, j.stderr)
    const l = JSON.parse(j.stdout) as { current: string; previous: string; bad: string[]; versions: Array<{ name: string; current: boolean; previous: boolean; bad: boolean }> }
    assert.equal(l.current, '0.0.1')
    assert.equal(l.previous, '0.0.2')
    assert.deepEqual(l.versions.map((v) => v.name), ['0.0.4', '0.0.2', '0.0.1'])
    assert.deepEqual(l.versions.map((v) => [v.current, v.previous, v.bad]), [[false, false, true], [false, true, false], [true, false, false]])
    const t = await cli(h, ['update', '--list'], currentCli(h))
    assert.match(t.stdout, /\* 0\.0\.1\s+current/)
    assert.match(t.stdout, /0\.0\.2\s+previous/)
    assert.match(t.stdout, /0\.0\.4\s+bad/)
  })

  it('E: удачная установка — запасное место исправной версии, bad удалена; current и previous не тронуты', async () => {
    const r = await cli(h, ['update', '--from', tb.E], currentCli(h))
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.equal((await status(h))?.version, '0.0.5')
    // current 0.0.5, previous 0.0.1; кандидаты — исправная 0.0.2 и bad 0.0.4: bad уходит первой.
    assert.deepEqual(onDisk(h), ['0.0.1', '0.0.2', '0.0.5'])
    assert.deepEqual(state(h).bad, [])
    // Версия есть на диске, но не активна — переключение без переустановки.
    const back = await cli(h, ['update', '--from', tb.B], currentCli(h))
    assert.equal(back.code, 0, back.stderr + back.stdout)
    assert.match(back.stdout, /0\.0\.2 уже лежит .* переключаюсь без переустановки/)
    assert.doesNotMatch(back.stdout, /поставлена/)
    assert.equal((await status(h))?.version, '0.0.2')
  })
})

describe('pult update: отказы и следы прерванных установок', () => {
  it('тарбол не пакета pult — отказ, в versions ничего нет, current нет', async () => {
    const h = makeHome()
    try {
      const r = await cli(h, ['update', '--from', tb.X])
      assert.equal(r.code, 1)
      assert.match(r.stderr, /это пакет «not-pult», а не pult — не ставлю/)
      assert.deepEqual(onDisk(h), [])
      assert.ok(!existsSync(h.paths.current))
      const none = await cli(h, ['update', '--from', join(h.dir, 'нет-такого.tgz')])
      assert.equal(none.code, 1)
      assert.match(none.stderr, /нет файла/)
      const junk = join(h.dir, 'junk.tgz')
      writeFileSync(junk, 'не тарбол')
      const j = await cli(h, ['update', '--from', junk])
      assert.equal(j.code, 1)
      assert.match(j.stderr, /не тарбол npm-пакета/)
    } finally {
      await teardown(h)
    }
  })

  it('первая установка сломанной версии — current снят, версия bad и на диске, код 1', async () => {
    const h = makeHome()
    try {
      const r = await cli(h, ['update', '--from', tb.C])
      assert.equal(r.code, 1)
      assert.match(r.stderr, /откатываться некуда \(первая установка\): current снят/)
      assert.ok(!existsSync(h.paths.current) && !isSymlink(h.paths.current))
      assert.ok(existsSync(join(h.paths.versions, '0.0.3')))
      assert.deepEqual(state(h).bad, ['0.0.3'])
      assert.equal(state(h).current, null)
    } finally {
      await teardown(h)
    }
  })

  it('.partial от убитой установки версией не считается и убирается; та же версия ставится заново', async () => {
    const h = makeHome()
    try {
      // Установка, убитая посреди npm: каталог есть, пакета в нём половина.
      mkdirSync(join(h.paths.versions, '0.0.1.partial', 'lib', 'node_modules', 'pult'), { recursive: true })
      writeFileSync(join(h.paths.versions, '0.0.1.partial', 'lib', 'node_modules', 'pult', 'package.json'), '{"name":"pult","version":"0.0.1"}')
      mkdirSync(join(h.paths.versions, '7.7.7.partial'), { recursive: true })
      const l = JSON.parse((await cli(h, ['update', '--list', '--json'])).stdout) as { versions: unknown[]; leftovers: string[] }
      assert.deepEqual(l.versions, [], '.partial показан как версия')
      assert.deepEqual(l.leftovers.sort(), ['0.0.1.partial', '7.7.7.partial'])
      const to = await cli(h, ['update', '--to', '0.0.1'])
      assert.equal(to.code, 1, '--to переключился на .partial')

      const r = await cli(h, ['update', '--from', tb.A])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stdout, /убраны следы прерванных установок/)
      assert.deepEqual(onDisk(h), ['0.0.1'])
      assert.equal(readlinkSync(h.paths.current), join('versions', '0.0.1'))
    } finally {
      await teardown(h)
    }
  })

  it('два pult update разом — второй отказывает по run/update.lock, первый доходит до конца', async () => {
    const h = makeHome()
    try {
      const first = runProc(process.execPath, [CLI, 'update', '--from', tb.A], h.env)
      assert.ok(await waitFor(() => existsSync(h.paths.updateLock), 10_000), 'первый не взял lock')
      const second = await cli(h, ['update', '--from', tb.B])
      assert.equal(second.code, 1)
      assert.match(second.stderr, /уже идёт другое обновление \(pid \d+/)
      const r = await first.done
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.ok(!existsSync(h.paths.updateLock), 'lock не снят')
      assert.equal(readlinkSync(h.paths.current), join('versions', '0.0.1'))
      // Мёртвый держатель lock — не помеха: следующий update его снимает.
      writeFileSync(h.paths.updateLock, JSON.stringify({ pid: 999_999, startedAt: '', started: 'x', cmd: 'pult update' }))
      const after = await cli(h, ['update', '--list'])
      assert.equal(after.code, 0)
      const again = await cli(h, ['update', '--from', tb.A])
      assert.equal(again.code, 0, again.stderr)
      assert.match(again.stdout, /уже стоит/)
    } finally {
      await teardown(h)
    }
  })
})

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

interface SvcFakes {
  statePids: () => number[]
  calls: () => string[][]
}

/** Служба на фальшивом менеджере для дома `h`: окружение, чтение состояния и журнала фальшивки. */
function withFakeService(h: Home, platform: 'darwin' | 'linux'): SvcFakes {
  const log = join(h.dir, 'fake.jsonl')
  const stateFile = join(h.dir, 'fake-state.json')
  Object.assign(h.env, {
    PULT_SERVICE_PLATFORM: platform,
    PULT_SERVICE_DIR: join(h.dir, 'svc'),
    PULT_LAUNCHCTL: join(FAKES, 'fake-launchctl.mjs'),
    PULT_SYSTEMCTL: join(FAKES, 'fake-systemctl.mjs'),
    PULT_LOGINCTL: join(FAKES, 'fake-loginctl.mjs'),
    FAKE_SVC_LOG: log,
    FAKE_SVC_STATE: stateFile,
    FAKE_SVC_EXTRA_ENV: JSON.stringify({ PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX, PULT_TEST: '1' }),
  })
  return {
    statePids: () => {
      if (!existsSync(stateFile)) return []
      const st = JSON.parse(readFileSync(stateFile, 'utf8')) as { jobs: Record<string, { pid: number | null }> }
      return Object.values(st.jobs).map((j) => j.pid).filter((p): p is number => typeof p === 'number')
    },
    // Только вызовы: события надзирателя фальшивого launchd (exit/respawn) идут с пустым argv.
    calls: () => (existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv).filter((a) => a.length > 0)
      : []),
  }
}

async function svcTeardown(h: Home, f: SvcFakes): Promise<void> {
  for (const pid of f.statePids()) h.pids.add(pid)
  if (existsSync(join(h.dir, 'svc'))) await cli(h, ['daemon', 'uninstall'], existsSync(currentCli(h)) ? currentCli(h) : CLI)
  await teardown(h)
}

// Перезапуск службы в `pult update` (решение лида 23.09.2026, B2 повторной приёмки): launchd —
// перезагрузка bootout + bootstrap, а не `kickstart -k` (после падения тот придержан ThrottleInterval
// на 10–18 с за вызов); systemd — `systemctl --user restart`.
const RESTART = { darwin: 'launchctl bootout \\S+ \\+ bootstrap', linux: 'systemctl --user restart' } as const
const isReloadCall = (platform: 'darwin' | 'linux', a: string[]): boolean => (platform === 'darwin'
  ? a[0] === 'bootstrap'
  : a.includes('restart') && a.includes('pultd.service'))

describe('pult update под службой (фальшивый менеджер служб)', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform}: перезапуск через ${platform === 'darwin' ? 'bootout + bootstrap' : 'systemctl --user restart'}, демон службы — новой версии`, async () => {
      const h = makeHome()
      const f = withFakeService(h, platform)
      try {
        assert.equal((await cli(h, ['update', '--from', tb.A])).code, 0)
        const inst = await cli(h, ['daemon', 'install'], currentCli(h))
        assert.equal(inst.code, 0, inst.stderr + inst.stdout)
        const before = await status(h)
        assert.equal(before?.mode, 'service')
        assert.equal(before?.version, '0.0.1')
        const mark = f.calls().length

        const r = await cli(h, ['update', '--from', tb.B], currentCli(h))
        assert.equal(r.code, 0, r.stderr + r.stdout)
        assert.ok(await waitFor(() => f.calls().slice(mark).some((a) => isReloadCall(platform, a))), 'служба не перезапущена через менеджер')
        assert.ok(!f.calls().some((a) => a[0] === 'kickstart' && a.includes('-k')), 'launchd перезапускался через kickstart -k')
        const now = await status(h)
        assert.equal(now?.version, '0.0.2')
        assert.equal(now?.mode, 'service')
        assert.ok(!alive(before?.pid ?? 0))
      } finally {
        await svcTeardown(h, f)
      }
    })
  }
})

// Регрессии 30.09.2026 (настоящий launchd, служба владельца, `pult update --from pult-0.2.1.tgz`):
// проба 1/3 не дождалась hello_ok за 10 с (демон стартовал 11 с), вторая перезагрузка пришлась на
// ещё не выгруженную службу — «Bootstrap failed: 5: Input/output error», обновление подняло демона
// напрямую, напечатало «pult обновлён» и оставило службу НЕ загруженной, ни словом об этом не сказав.
describe('pult update под launchd: перезагрузка службы и честный итог', () => {
  it('bootout вернулся раньше конца выгрузки — update ждёт и грузит службу с первого bootstrap', async () => {
    const h = makeHome()
    const f = withFakeService(h, 'darwin')
    try {
      assert.equal((await cli(h, ['update', '--from', tb.A])).code, 0)
      assert.equal((await cli(h, ['daemon', 'install'], currentCli(h))).code, 0)
      assert.equal((await status(h))?.mode, 'service')
      const mark = f.calls().length

      // Фальшивый launchd держит службу загруженной 3 с после bootout — дольше прежних повторов (2 с).
      const r = await cli(h, ['update', '--from', tb.B], currentCli(h), { FAKE_SVC_BOOTOUT_LINGER_MS: '3000' })
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.doesNotMatch(r.stderr, /поднимаю демона напрямую|Bootstrap failed|ВНИМАНИЕ/, r.stderr)
      assert.equal(f.calls().slice(mark).filter((a) => a[0] === 'bootstrap').length, 1, `bootstrap повторялся: ${r.stderr}`)
      assert.match(r.stdout, /демон 0\.0\.2 прошёл пробу: pid \d+, режим service/)
      const now = await status(h)
      assert.equal(now?.version, '0.0.2')
      assert.equal(now?.mode, 'service')
    } finally {
      await svcTeardown(h, f)
    }
  })

  it('служба не загрузилась — демон поднят напрямую, и update говорит: служба НЕ загружена, вернуть — pult daemon install', async () => {
    const h = makeHome()
    const f = withFakeService(h, 'darwin')
    try {
      assert.equal((await cli(h, ['update', '--from', tb.A])).code, 0)
      assert.equal((await cli(h, ['daemon', 'install'], currentCli(h))).code, 0)
      assert.equal((await status(h))?.mode, 'service')

      const r = await cli(h, ['update', '--from', tb.B], currentCli(h), { FAKE_SVC_FAIL: 'bootstrap' })
      // Версия переключена и проверена — код 0; но про службу сказано прямо, с командой.
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stderr, /служба dev\.pult\.daemon не перезапустилась .*Bootstrap failed: 5.* — поднимаю демона напрямую/)
      assert.match(r.stdout, /демон 0\.0\.2 прошёл пробу: pid \d+, режим on-demand/)
      assert.match(r.stderr, /ВНИМАНИЕ: служба dev\.pult\.daemon осталась НЕ ЗАГРУЖЕННОЙ: демон поднят напрямую \(режим on-demand\)/)
      assert.match(r.stderr, /вернуть службу: pult daemon install/)
      const direct = await status(h)
      assert.equal(direct?.mode, 'on-demand')
      const line = await cli(h, ['daemon', 'status'], currentCli(h))
      assert.match(line.stdout, /не загружена \(загрузить: pult daemon install\)/)

      // Названная команда возвращает демона под службу — той же версии.
      const back = await cli(h, ['daemon', 'install'], currentCli(h))
      assert.equal(back.code, 0, back.stderr + back.stdout)
      const now = await status(h)
      assert.equal(now?.mode, 'service')
      assert.equal(now?.version, '0.0.2')
      assert.ok(!alive(direct?.pid ?? 0), 'демон, поднятый напрямую, остался жив')
    } finally {
      await svcTeardown(h, f)
    }
  })

  it('файл службы записан прежней версией (ProcessType Background) — update подсказывает pult daemon install', async () => {
    const h = makeHome()
    const f = withFakeService(h, 'darwin')
    try {
      assert.equal((await cli(h, ['update', '--from', tb.A])).code, 0)
      assert.equal((await cli(h, ['daemon', 'install'], currentCli(h))).code, 0)
      const plist = join(h.dir, 'svc', 'dev.pult.daemon.plist')
      const fresh = readFileSync(plist, 'utf8')
      writeFileSync(plist, fresh.replace('<string>Standard</string>', '<string>Background</string>'))

      const r = await cli(h, ['update', '--from', tb.B], currentCli(h))
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stderr, /файл службы .*dev\.pult\.daemon\.plist записан прежней версией — ProcessType Background.*Обнови: pult daemon install/)
      // Сам update файл службы не трогает (инвариант 8): переписывает его только явный install.
      assert.match(readFileSync(plist, 'utf8'), /<string>Background<\/string>/)
      assert.equal((await status(h))?.mode, 'service')
    } finally {
      await svcTeardown(h, f)
    }
  })
})

describe('pult update под службой: сломанная версия — быстрый откат с ходом пробы', () => {
  // Регрессия приёмки лида (23.09.2026, настоящий launchd): `pult update --from <C>` (демон C
  // падает при загрузке) молчал 81 с и только потом печатал откат. Под службой у пробы нет
  // ребёнка-спавна, и выход процесса ЭТОЙ попытки не замечался: каждая попытка ждала полные 10 с.
  //
  // Регрессия B2 повторной приёмки (там же): после быстрого провала откат всё равно шёл 65 с —
  // попытки 2 и 3 и подъём прежней версии делались `kickstart -k`, а его launchd после падения
  // придерживает на ThrottleInterval (18,7 с за вызов). Решение лида: процесс вышел до hello_ok —
  // проба кончается сразу (детерминированное падение повтор не лечит, launchd его и так повторил);
  // перезапуск под launchd — bootout + bootstrap. Фальшивый launchd моделирует и воскрешение, и
  // придержанный kickstart (FAKE_SVC_THROTTLE_MS).
  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform}: процесс службы вышел до hello_ok — одна попытка, откат ${platform === 'darwin' ? 'через bootout + bootstrap' : 'через restart'}, секунды`, async () => {
      const h = makeHome()
      const f = withFakeService(h, platform)
      try {
        assert.equal((await cli(h, ['update', '--from', tb.A])).code, 0)
        const inst = await cli(h, ['daemon', 'install'], currentCli(h))
        assert.equal(inst.code, 0, inst.stderr + inst.stdout)
        assert.equal((await status(h))?.mode, 'service')
        const mark = f.calls().length

        // systemd-фальшивка кода выхода отсоединённого процесса не знает — подсказываем окружением;
        // надзиратель фальшивого launchd видит настоящий код сам.
        const t0 = Date.now()
        const r = await cli(h, ['update', '--from', tb.C], currentCli(h), {
          FAKE_SVC_THROTTLE_MS: '3000',
          ...(platform === 'linux' ? { FAKE_SVC_LAST_EXIT: '1' } : {}),
        })
        const took = Date.now() - t0
        assert.equal(r.code, 1, r.stdout)
        assert.match(r.stderr, /0\.0\.3 не прошла пробу: демон вышел \(код 1\)/)
        assert.match(r.stderr, /откат на 0\.0\.1/)
        assert.match(r.stderr, new RegExp(`проба 1/3: ${RESTART[platform]}`), r.stderr)
        assert.match(r.stderr, /проба 1\/3: демон вышел \(код 1\) через/, r.stderr)
        assert.doesNotMatch(r.stderr, /проба 2\/3/, `после выхода процесса до hello_ok проба повторялась:\n${r.stderr}`)
        assert.match(r.stderr, new RegExp(`откат 1/1: ${RESTART[platform]}`), r.stderr)
        const after = f.calls().slice(mark)
        if (platform === 'darwin') {
          assert.ok(!after.some((a) => a[0] === 'kickstart' && a.includes('-k')), 'launchd перезапускался через kickstart -k')
          assert.equal(after.filter((a) => a[0] === 'bootstrap').length, 2, `проба и откат — по одной перезагрузке: ${JSON.stringify(after)}`)
        }
        // npm install входит в замер; одна попытка + откат — секунды, а не 3 × ThrottleInterval.
        assert.ok(took < 15_000, `откат занял ${took} мс:\n${r.stderr}`)
        const now = await status(h)
        assert.equal(now?.version, '0.0.1')
        assert.equal(now?.mode, 'service')
      } finally {
        await svcTeardown(h, f)
      }
    })
  }

  it('darwin: D (ответила hello_ok и упала) под службой — попытки остаются, затем откат', async () => {
    const h = makeHome()
    const f = withFakeService(h, 'darwin')
    try {
      assert.equal((await cli(h, ['update', '--from', tb.A])).code, 0)
      const inst = await cli(h, ['daemon', 'install'], currentCli(h))
      assert.equal(inst.code, 0, inst.stderr + inst.stdout)
      const r = await cli(h, ['update', '--from', tb.D], currentCli(h))
      assert.equal(r.code, 1, r.stdout)
      for (const i of [1, 2, 3]) assert.match(r.stderr, new RegExp(`проба ${i}/3: ${RESTART.darwin}`), `нет попытки ${i}:\n${r.stderr}`)
      assert.match(r.stderr, /0\.0\.4 не прошла пробу: демон 0\.0\.4 \(pid \d+\) ответил, но через 2 с уже не отвечает/)
      assert.match(r.stderr, /откат на 0\.0\.1/)
      const now = await status(h)
      assert.equal(now?.version, '0.0.1')
      assert.equal(now?.mode, 'service')
    } finally {
      await svcTeardown(h, f)
    }
  })
})

describe('pult update: свой node Пульта (runtime.env в пакете)', () => {
  const key = platformKey() as PlatformKey
  let h: Home
  let n1: { tgz: string; sha: string }
  let n2: { tgz: string; sha: string }
  let R1 = ''
  let R2 = ''
  before(() => {
    h = makeHome()
    n1 = fakeNodeTarball(work, '24.21.0')
    n2 = fakeNodeTarball(work, '24.99.0')
    R1 = packPult(work, { version: '0.1.1', runtimeEnv: fakePin('24.21.0', n1.sha) })
    R2 = packPult(work, { version: '0.1.2', daemonMain: BROKEN_DAEMON, runtimeEnv: fakePin('24.99.0', n2.sha) })
  })
  after(async () => { await teardown(h) })
  const nodeOf = (v: string): string => join(h.paths.runtime, runtimeName(v, key), 'bin', 'node')

  it('ставит свой node до пробы, поднимает на нём демона, лишние node убирает', async () => {
    const junk = join(h.paths.runtime, runtimeName('1.0.0', key))
    mkdirSync(junk, { recursive: true })
    const r = await cli(h, ['update', '--from', R1], CLI, { PULT_TEST_NODE_TARBALL: n1.tgz })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /свой node 24\.21\.0 поставлен/)
    assert.equal(readFileSync(h.paths.runtimeActive, 'utf8').trim(), nodeOf('24.21.0'))
    // Проба шла без службы — спавном; демона поднял именно свой node (он оставляет след).
    assert.ok(existsSync(join(h.paths.runtime, runtimeName('24.21.0', key), 'used')), 'демон поднят не своим node')
    assert.ok(!existsSync(junk), 'лишний node не убран')
    assert.match(r.stdout, /убраны старые node: node-v1\.0\.0/)
  })

  it('сломанная версия с другим пином: откат возвращает указатель на прежний node', async () => {
    const r = await cli(h, ['update', '--from', R2], currentCli(h), { PULT_TEST_NODE_TARBALL: n2.tgz })
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stderr, /0\.1\.2 не прошла пробу/)
    assert.equal(readFileSync(h.paths.runtimeActive, 'utf8').trim(), nodeOf('24.21.0'))
    assert.equal(state(h).current, '0.1.1')
  })

  it('node не скачался — обновление не валится: предупреждение и команда повтора', async () => {
    const R3 = packPult(work, { version: '0.1.3', runtimeEnv: fakePin('24.30.0', 'f'.repeat(64)) })
    const r = await cli(h, ['update', '--from', R3], currentCli(h), { PULT_TEST_NODE_TARBALL: n1.tgz })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.match(r.stderr, /свой node не поставлен — .*sha256/)
    assert.match(r.stderr, /pult runtime install/)
    // Указатель не тронут: демон живёт на прежнем своём node.
    assert.equal(readFileSync(h.paths.runtimeActive, 'utf8').trim(), nodeOf('24.21.0'))
  })

  it('перепроверка прерванной пробы провалилась — указатель из update.json, а не тот, что на диске', async () => {
    // pult update на 0.1.2 убит посреди пробы: current и указатель уже новые, прежний указатель —
    // только в update.json. Состояние собирается руками, как в соседнем describe.
    writeFileSync(h.paths.runtimeActive, `${nodeOf('24.99.0')}\n`)
    const st = JSON.parse(readFileSync(h.paths.updateState, 'utf8')) as Record<string, unknown>
    st['current'] = '0.1.2'
    st['previous'] = '0.1.3'
    st['last'] = { at: new Date().toISOString(), action: 'to', version: '0.1.2', was: '0.1.3', result: 'failed', message: 'проба идёт (прервана?)' }
    st['runtimeBefore'] = nodeOf('24.21.0')
    writeFileSync(h.paths.updateState, JSON.stringify(st))
    const tmp = `${h.paths.current}.t`
    rmSync(tmp, { force: true })
    symlinkSync(join('versions', '0.1.2'), tmp)
    renameSync(tmp, h.paths.current)

    const r = await cli(h, ['update', '--to', '0.1.2'], join(h.paths.versions, '0.1.3', 'bin', 'pult'))
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stderr, /0\.1\.2 не прошла пробу: .*откат на 0\.1\.3/)
    assert.equal(readFileSync(h.paths.runtimeActive, 'utf8').trim(), nodeOf('24.21.0'))
    assert.ok(!('runtimeBefore' in (JSON.parse(readFileSync(h.paths.updateState, 'utf8')) as object)), 'отметка не снята итогом')
  })
})

describe('версии: имена и порядок', () => {
  it('имя версии — только semver: путь из тарбола не уводит мимо versions/', () => {
    for (const ok of ['0.1.0', '1.2.3-rc.1', '1.2.3+build.5', '0.1.0-dev']) assert.ok(isVersionName(ok), ok)
    for (const bad of ['../x', '1.2', '1.2.3/..', '1.2.3-a.partial', '', 'v1.2.3', '1.2.3 ']) assert.ok(!isVersionName(bad), bad)
  })

  it('порядок semver: числа по-числовому, релиз старше пререлиза', () => {
    const sorted = ['0.10.0', '0.2.0', '0.2.0-rc.2', '0.2.0-rc.10', '1.0.0'].sort(compareVersions)
    assert.deepEqual(sorted, ['0.2.0-rc.2', '0.2.0-rc.10', '0.2.0', '0.10.0', '1.0.0'])
  })

  it('doctor: current нет — ok с подсказкой; current в пустоту — fail с командой', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pd-'))
    try {
      const paths = layout(dir)
      const none = versionDoctorItems(paths, null)
      assert.equal(none[0]?.status, 'ok')
      assert.match(none[0]?.detail ?? '', /pult update --from/)
      symlinkSync(join('versions', '0.9.9'), paths.current)
      const dangling = versionDoctorItems(paths, null)
      assert.equal(dangling[0]?.status, 'fail')
      assert.match(dangling[0]?.detail ?? '', /нет пакета pult: служба выйдет с кодом 78/)
      assert.equal(dangling[0]?.fix, 'pult update --list && pult update --to <версия>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pult update: проба, прерванная посреди (CLI убит после переключения current)', () => {
  // switchAndProbe пишет в update.json «проба идёт» ДО переключения `current`; kill -9 CLI между
  // переключением и концом пробы оставляет ровно это состояние. Раньше повтор той же команды
  // отвечал «уже стоит» с кодом 0, а doctor — ok: версия, ни разу не ответившая hello_ok,
  // считалась проверенной. Состояние собирается руками: убивать CLI в нужный миг — гонка.
  let h: Home
  before(() => { h = makeHome() })
  after(async () => { await teardown(h) })

  const interrupt = (v: string, was: string): void => {
    const st = JSON.parse(readFileSync(h.paths.updateState, 'utf8')) as Record<string, unknown>
    st['current'] = v
    st['previous'] = was
    st['last'] = { at: new Date().toISOString(), action: 'from', version: v, was, result: 'failed', message: 'проба идёт (прервана?)' }
    writeFileSync(h.paths.updateState, JSON.stringify(st))
    const tmp = `${h.paths.current}.t`
    rmSync(tmp, { force: true })
    symlinkSync(join('versions', v), tmp)
    renameSync(tmp, h.paths.current)
  }
  const currentItem = () => versionDoctorItems(h.paths, null).find((i) => i.id === 'version.current')

  it('doctor не ok; повтор --from и --to перепроверяют версию, а не «уже стоит»', async () => {
    assert.equal((await cli(h, ['update', '--from', tb.A])).code, 0)
    assert.equal((await cli(h, ['update', '--from', tb.B], currentCli(h))).code, 0)
    interrupt('0.0.2', '0.0.1')

    const cur = currentItem()
    assert.notEqual(cur?.status, 'ok', `doctor считает непроверенную версию исправной: ${JSON.stringify(cur)}`)
    assert.match(cur?.detail ?? '', /проба 0\.0\.2 прервана/)
    assert.equal(cur?.fix, 'pult update --to 0.0.2')

    const again = await cli(h, ['update', '--from', tb.B], currentCli(h))
    assert.equal(again.code, 0, again.stderr + again.stdout)
    assert.doesNotMatch(again.stdout, /уже стоит/, 'прерванная проба принята за готовую установку')
    assert.match(again.stdout, /демон 0\.0\.2 прошёл пробу/)
    assert.equal(state(h).last?.result, 'ok')
    assert.equal(state(h).previous, '0.0.1', 'перепроверка испортила previous')
    assert.equal(currentItem()?.status, 'ok')

    interrupt('0.0.2', '0.0.1')
    const to = await cli(h, ['update', '--to', '0.0.2'], currentCli(h))
    assert.equal(to.code, 0, to.stderr + to.stdout)
    assert.doesNotMatch(to.stdout, /уже активна/)
    assert.match(to.stdout, /демон 0\.0\.2 прошёл пробу/)
  })

  it('перепроверка провалилась — откат на previous из update.json, а не «на саму себя»', async () => {
    const bad = await cli(h, ['update', '--from', tb.C], currentCli(h))
    assert.equal(bad.code, 1, bad.stdout)
    interrupt('0.0.3', '0.0.2')
    const r = await cli(h, ['update', '--from', tb.C], join(h.paths.versions, '0.0.2', 'bin', 'pult'))
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stderr, /0\.0\.3 не прошла пробу: .*откат на 0\.0\.2/)
    assert.equal(readlinkSync(h.paths.current), join('versions', '0.0.2'))
    assert.equal(state(h).current, '0.0.2')
    assert.ok(state(h).bad.includes('0.0.3'))
  })
})

describe('pult update: тарбол с install-скриптами', () => {
  it('preinstall/postinstall тарбола не исполняются — код пакета запускают только проверка и проба', async () => {
    const h = makeHome()
    const marks = join(h.dir, 'marks')
    mkdirSync(marks)
    const tgz = packPult(h.dir, {
      version: '0.0.8',
      scripts: { preinstall: `touch '${join(marks, 'pre')}'`, postinstall: `touch '${join(marks, 'post')}'` },
    })
    try {
      const r = await cli(h, ['update', '--from', tgz])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.deepEqual(readdirSync(marks), [], 'npm исполнил install-скрипты тарбола до всякой проверки')
    } finally {
      await teardown(h)
    }
  })
})

describe('проба: демон ответил hello_ok и завис', () => {
  // Фальшивый демон: на hello отвечает hello_ok, на запросы — молчит и соединение не закрывает.
  // Раньше таймаут ограничивал только рукопожатие: `daemon.status` пробы и `daemon.stop` висели
  // вечно, ретраи и откат не наступали, run/update.lock оставался занятым.
  let dir = ''
  let paths: PultPaths
  let server: Server
  const sockets = new Set<Socket>()

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ph-'))
    paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    rotateToken(paths.token)
    server = createServer((s) => {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
      s.once('data', () => {
        s.write(`${JSON.stringify({ type: 'hello_ok', protocol: 1, daemon: { version: '0.0.0', pid: 1, startedAt: '' } })}\n`)
      })
    })
    await new Promise<void>((r) => server.listen(paths.sock, r))
  })
  after(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  /** Исход промиса или «висит» через `ms`; таймер снимается в обоих случаях. */
  async function within<T>(p: Promise<T>, ms: number): Promise<T | 'висит'> {
    let timer: NodeJS.Timeout | undefined
    const hung = new Promise<'висит'>((r) => { timer = setTimeout(() => r('висит'), ms) })
    try { return await Promise.race([p, hung]) } finally { clearTimeout(timer) }
  }

  it('daemonStatusOnce отвечает null по таймауту, а не висит', async () => {
    const t0 = Date.now()
    const r = await within(daemonStatusOnce(paths, 300), 5000)
    assert.equal(r, null, `daemonStatusOnce: ${String(r)}`)
    assert.ok(Date.now() - t0 < 3000, `daemonStatusOnce ждал ${Date.now() - t0} мс`)
  })

  it('stopRunningDaemon: daemon.stop без ответа — ограничен по времени', async () => {
    const r = await within(stopRunningDaemon(paths, 500).then(() => 'вернулся', (e: Error) => `отказ: ${e.message}`), 8000)
    assert.notEqual(r, 'висит', 'daemon.stop к зависшему демону ждёт вечно')
  })
})
