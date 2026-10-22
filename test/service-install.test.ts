// `pult daemon install|uninstall|status` и подъём по требованию при установленной службе —
// сквозь собранный CLI, на ФАЛЬШИВЫХ менеджерах служб (test/fakes/fake-launchctl.mjs,
// fake-systemctl.mjs, fake-loginctl.mjs). Настоящий launchctl/systemctl не вызывается никогда:
// без PULT_LAUNCHCTL/PULT_SYSTEMCTL при PULT_TEST=1 у CLI просто нет бинаря (см. context.ts).
//
// Фальшивка поднимает лаунчер из сгенерированного файла службы — то есть демон здесь НАСТОЯЩИЙ,
// из рабочей копии (`--dev`), и install честно ждёт его hello_ok. Каждый поднятый демон гасится
// в after: uninstall (bootout убивает), добивание pid из состояния фальшивки, daemon stop.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { VERSION } from '../dist/core/version.js'
import { stableNodePath } from '../dist/env/nodeBin.js'
import { connectClient } from '../dist/cli/client.js'
import type { DaemonHandle } from '../dist/daemon/server.js'
import { serviceContext } from '../dist/service/context.js'
import { serviceDoctorItems } from '../dist/service/doctor.js'
import { installService } from '../dist/service/install.js'
import { acquireLock } from '../dist/core/lock.js'
import { load, queryState, start } from '../dist/service/manager.js'
import { renderService } from '../dist/service/render.js'
import { stopDaemon } from '../dist/service/stop.js'
import { FAKE_CLAUDE, FAKE_CODEX, reapFakeSupervisors, removeTree, sleep, startTestDaemon, tempHome, waitFor } from './helpers.js'

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))
const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const FAKES = join(ROOT, 'test', 'fakes')
const USER = userInfo().username

type Platform = 'darwin' | 'linux'

interface Svc {
  dir: string
  paths: PultPaths
  fakeHome: string
  svcDir: string
  log: string
  state: string
  platform: Platform
  env: Record<string, string>
  file: string
}

function makeSvc(platform: Platform, extra: Record<string, string> = {}): Svc {
  // Короткий префикс: путь сокета упирается в 104 байта sun_path на macOS.
  const dir = mkdtempSync(join(tmpdir(), 'ps-'))
  const paths = layout(join(dir, 'h'))
  const fakeHome = join(dir, 'home')
  mkdirSync(fakeHome, { recursive: true })
  const svcDir = join(dir, 'svc')
  const log = join(dir, 'fake.jsonl')
  const state = join(dir, 'fake-state.json')
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: fakeHome,
    USER,
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
    PULT_HOME: paths.home,
    PULT_TEST: '1',
    PULT_SERVICE_PLATFORM: platform,
    PULT_SERVICE_DIR: svcDir,
    PULT_LAUNCHCTL: join(FAKES, 'fake-launchctl.mjs'),
    PULT_SYSTEMCTL: join(FAKES, 'fake-systemctl.mjs'),
    PULT_LOGINCTL: join(FAKES, 'fake-loginctl.mjs'),
    PULT_CLAUDE_BIN: FAKE_CLAUDE,
    PULT_CODEX_BIN: FAKE_CODEX,
    FAKE_SVC_LOG: log,
    FAKE_SVC_STATE: state,
    // Демону «службы» — те же фальшивые CLI, иначе он пошёл бы искать настоящие claude/codex.
    FAKE_SVC_EXTRA_ENV: JSON.stringify({ PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX, PULT_TEST: '1' }),
    ...extra,
  }
  const file = join(svcDir, platform === 'darwin' ? 'dev.pult.daemon.plist' : 'pultd.service')
  return { dir, paths, fakeHome, svcDir, log, state, platform, env, file }
}

interface CliRun { code: number | null; stdout: string; stderr: string }

function runCli(svc: Svc, args: string[], extra: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...svc.env, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Строка журнала фальшивок: вызов (argv) или событие надзирателя launchd (exit/respawn). */
interface FakeCall { tool: string; argv: string[]; event?: string; pid?: number | null; code?: number | null; signal?: string | null }

function fakeCalls(svc: Svc): FakeCall[] {
  if (!existsSync(svc.log)) return []
  return readFileSync(svc.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeCall)
}

const called = (svc: Svc, pred: (argv: string[]) => boolean): boolean => fakeCalls(svc).some((c) => pred(c.argv))

function statePids(svc: Svc): number[] {
  if (!existsSync(svc.state)) return []
  const st = JSON.parse(readFileSync(svc.state, 'utf8')) as { jobs: Record<string, { pid: number | null }> }
  return Object.values(st.jobs).map((j) => j.pid).filter((p): p is number => typeof p === 'number')
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function status(svc: Svc): Promise<Record<string, unknown>> {
  const r = await runCli(svc, ['daemon', 'status', '--json'])
  return JSON.parse(r.stdout) as Record<string, unknown>
}

/** Снять службу, добить всё, что подняла фальшивка, остановить демона по требованию, стереть дом. */
async function teardown(svc: Svc): Promise<void> {
  const pids = statePids(svc)
  if (existsSync(svc.file)) await runCli(svc, ['daemon', 'uninstall'])
  await runCli(svc, ['daemon', 'stop'])
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* ушёл */ } }
  await waitFor(() => !existsSync(svc.paths.lock) && pids.every((p) => !alive(p)), 10_000)
  // Надзиратель фальшивого launchd отсоединён и после смерти процесса службы ещё пишет состояние и
  // журнал в этот дом: стирать дом можно только после его выхода (ENOTEMPTY на CI macOS, 22.10.2026).
  await reapFakeSupervisors(svc.log)
  removeTree(svc.dir)
}

for (const platform of ['darwin', 'linux'] as const) {
  describe(`служба ${platform} — полный круг на фальшивом менеджере`, () => {
    let svc: Svc
    let firstPid = 0

    before(() => { svc = makeSvc(platform) })
    after(async () => { await teardown(svc) })

    it('--print печатает файл службы и команды и НИЧЕГО не пишет', async () => {
      const r = await runCli(svc, ['daemon', 'install', '--print'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, platform === 'darwin' ? /<key>Label<\/key>/ : /^\[Service\]$/m)
      assert.match(r.stdout, platform === 'darwin' ? /launchctl bootstrap gui\/\d+ / : /systemctl --user enable --now pultd\.service/)
      const j = await runCli(svc, ['daemon', 'install', '--print', '--json'])
      const parsed = JSON.parse(j.stdout) as { content: string; commands: string[]; file: string }
      assert.equal(parsed.file, svc.file)
      assert.ok(parsed.content.includes(svc.paths.home))
      assert.ok(!existsSync(svc.paths.home), '--print создал PULT_HOME')
      assert.ok(!existsSync(svc.svcDir), '--print создал каталог служб')
      assert.deepEqual(fakeCalls(svc), [], '--print вызвал менеджер служб')
    })

    it('без активной версии — отказ с подсказкой про --dev и update --from, файла службы нет', async () => {
      const r = await runCli(svc, ['daemon', 'install'])
      assert.equal(r.code, 1)
      assert.match(r.stderr, /pult daemon install --dev/)
      assert.match(r.stderr, /pult update --from/)
      assert.ok(!existsSync(svc.file))
      assert.deepEqual(fakeCalls(svc), [])
    })

    it('--dev: связывает рабочую копию, кладёт лаунчер и node-path, грузит службу, демон отвечает', async () => {
      const r = await runCli(svc, ['daemon', 'install', '--dev'])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stdout, /служба установлена/)

      const versionDir = join(svc.paths.versions, `${VERSION}-dev`)
      assert.ok(lstatSync(versionDir).isSymbolicLink())
      assert.equal(realpathSync(versionDir), realpathSync(ROOT))
      assert.ok(lstatSync(svc.paths.current).isSymbolicLink())
      assert.equal(readlinkSync(svc.paths.current), join('versions', `${VERSION}-dev`))

      assert.equal(statSync(svc.paths.launcher).mode & 0o777, 0o755)
      assert.deepEqual(readFileSync(svc.paths.launcher), readFileSync(join(ROOT, 'service', 'pultd-launch')))
      assert.equal(readFileSync(svc.paths.nodePath, 'utf8').trim(), stableNodePath(process.execPath))
      assert.equal(statSync(svc.file).mode & 0o777, 0o644)
      assert.equal(statSync(svc.paths.bin).mode & 0o777, 0o700)
      // Инвариант 8 (редакция В4): install пишет только в PULT_HOME и в каталог служб. Домашний
      // каталог (здесь временный HOME) остаётся нетронутым — ни ~/.local/bin, ни ~/.config.
      assert.deepEqual(readdirSync(svc.fakeHome), [], 'install записал что-то в HOME')

      assert.ok(await waitFor(() => (platform === 'darwin'
        ? called(svc, (a) => a[0] === 'bootstrap' && a[2] === svc.file)
        : called(svc, (a) => a.includes('enable') && a.includes('--now') && a.includes('pultd.service')))))
      if (platform === 'linux') {
        assert.ok(await waitFor(() => called(svc, (a) => a[0] === 'enable-linger' && a[1] === USER)))
      }

      const st = await status(svc)
      assert.equal(st['running'], true)
      assert.equal(st['mode'], 'service')
      const service = st['service'] as { installed: boolean; ours: boolean; launcherOk: boolean; manager: { pid: number; loaded: boolean } }
      assert.equal(service.installed, true)
      assert.equal(service.ours, true)
      assert.equal(service.launcherOk, true)
      assert.equal(service.manager.loaded, true)
      assert.equal(service.manager.pid, st['pid'])
      firstPid = st['pid'] as number

      const text = await runCli(svc, ['daemon', 'status'])
      assert.match(text.stdout, /режим service/)
      assert.match(text.stdout, new RegExp(`служба: установлена .* загружена · pid ${firstPid}`))
    })

    it('повторный install идемпотентен: тот же файл, служба перезагружена, новый демон отвечает', async () => {
      const r = await runCli(svc, ['daemon', 'install', '--dev'])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stdout, /остановлен/)
      assert.deepEqual(readdirSync(svc.svcDir).filter((f) => !f.includes('.tmp-')), [platform === 'darwin' ? 'dev.pult.daemon.plist' : 'pultd.service'])
      const st = await status(svc)
      assert.equal(st['mode'], 'service')
      assert.notEqual(st['pid'], firstPid)
      assert.ok(!alive(firstPid), 'старый демон службы остался жив')
    })

    it('после daemon stop демона поднимает МЕНЕДЖЕР СЛУЖБ, а не отсоединённый спавн', async () => {
      const stop = await runCli(svc, ['daemon', 'stop'])
      assert.equal(stop.code, 0)
      assert.ok(await waitFor(() => !existsSync(svc.paths.lock), 10_000))
      const r = await runCli(svc, ['events', 'tail', '--json', '--no-follow'])
      assert.equal(r.code, 0, r.stderr)
      assert.ok(!/не запустилась/.test(r.stderr), r.stderr)
      assert.ok(await waitFor(() => (platform === 'darwin'
        ? called(svc, (a) => a[0] === 'kickstart' && !a.includes('-k') && a[1] === `gui/${process.getuid?.()}/dev.pult.daemon`)
        : called(svc, (a) => a.includes('start') && a.includes('pultd.service') && !a.includes('enable')))))
      const st = await status(svc)
      assert.equal(st['mode'], 'service')
    })

    it('uninstall снимает службу, демон гаснет, повторный uninstall — код 0 «службы нет»', async () => {
      const before = await status(svc)
      const pid = before['pid'] as number
      const r = await runCli(svc, ['daemon', 'uninstall'])
      assert.equal(r.code, 0, r.stderr)
      assert.ok(!existsSync(svc.file))
      assert.ok(existsSync(svc.paths.home), 'PULT_HOME не удаляется')
      assert.ok(await waitFor(() => !alive(pid), 10_000), 'демон службы жив после uninstall')
      assert.ok(await waitFor(() => (platform === 'darwin'
        ? called(svc, (a) => a[0] === 'bootout')
        : called(svc, (a) => a.includes('disable') && a.includes('--now')))))
      if (platform === 'linux') assert.match(r.stdout, /linger не трогаю/)
      const again = await runCli(svc, ['daemon', 'uninstall'])
      assert.equal(again.code, 0)
      assert.match(again.stdout, /службы нет/)
    })
  })
}

describe('служба: крайние случаи', () => {
  it('uninstall на чистом доме — код 0 «службы нет»', async () => {
    const svc = makeSvc('darwin')
    try {
      const r = await runCli(svc, ['daemon', 'uninstall'])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /службы нет/)
    } finally {
      await teardown(svc)
    }
  })

  it('install сначала мягко останавливает демона, поднятого по требованию', async () => {
    const svc = makeSvc('darwin')
    try {
      const start = await runCli(svc, ['daemon', 'start', '--json'])
      assert.equal(start.code, 0, start.stderr)
      const before = await status(svc)
      assert.equal(before['mode'], 'on-demand')
      const r = await runCli(svc, ['daemon', 'install', '--dev'])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stdout, new RegExp(`работающий демон \\(pid ${String(before['pid'])}\\) остановлен`))
      const after = await status(svc)
      assert.equal(after['mode'], 'service')
      assert.notEqual(after['pid'], before['pid'])
    } finally {
      await teardown(svc)
    }
  })

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform}: менеджер служб ответил ошибкой — спавн в обход с предупреждением`, async () => {
      const svc = makeSvc(platform)
      try {
        assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
        await runCli(svc, ['daemon', 'stop'])
        assert.ok(await waitFor(() => !existsSync(svc.paths.lock), 10_000))
        const r = await runCli(svc, ['events', 'tail', '--json', '--no-follow'], { FAKE_SVC_FAIL: platform === 'darwin' ? 'kickstart' : 'start' })
        assert.equal(r.code, 0, r.stderr)
        assert.match(r.stderr, /не запустилась .* поднимаю демона напрямую/)
        const st = await status(svc)
        assert.equal(st['mode'], 'on-demand')
      } finally {
        await teardown(svc)
      }
    })
  }

  it('linux: linger включить не дали — установка успешна, в тексте точная команда', async () => {
    const svc = makeSvc('linux', { FAKE_SVC_FAIL: 'enable-linger' })
    try {
      const r = await runCli(svc, ['daemon', 'install', '--dev'])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.ok(r.stderr.includes(`sudo loginctl enable-linger ${USER}`), r.stderr)
    } finally {
      await teardown(svc)
    }
  })

  it('чужая служба (другой PULT_HOME): install и uninstall отказывают, ensureDaemon её не трогает', async () => {
    const svc = makeSvc('darwin')
    try {
      const other = join(svc.dir, 'other-home')
      mkdirSync(svc.svcDir, { recursive: true })
      writeFileSync(svc.file, renderService({
        platform: 'darwin', name: 'dev.pult.daemon', launcher: join(other, 'bin', 'pultd-launch'), pultHome: other,
        serviceLog: join(other, 'logs', 'service.log'), home: svc.fakeHome, nodeExec: process.execPath,
      }))
      const before = readFileSync(svc.file, 'utf8')
      const inst = await runCli(svc, ['daemon', 'install', '--dev'])
      assert.equal(inst.code, 1)
      assert.match(inst.stderr, /другой PULT_HOME/)
      const un = await runCli(svc, ['daemon', 'uninstall'])
      assert.equal(un.code, 1)
      assert.equal(readFileSync(svc.file, 'utf8'), before, 'чужой файл службы изменён')
      const start = await runCli(svc, ['daemon', 'start'])
      assert.equal(start.code, 0, start.stderr)
      assert.equal((await status(svc))['mode'], 'on-demand')
      assert.deepEqual(fakeCalls(svc), [], 'CLI дёрнул менеджер служб ради чужой службы')
    } finally {
      rmSync(svc.file, { force: true })
      await teardown(svc)
    }
  })
})

describe('служба: install в процессе (ожидание, TCC)', () => {
  it('демон не ответил за отведённое время — код 1, хвост service.log, служба остаётся, подсказка uninstall; ~/Desktop — предупреждение', async () => {
    const svc = makeSvc('darwin', { FAKE_SVC_NOSPAWN: '1' })
    try {
      // Мини-пакет в фальшивом ~/Desktop: для --dev нужна рабочая копия там, где macOS спросит доступ.
      const pkg = join(svc.fakeHome, 'Desktop', 'dev', 'pult')
      mkdirSync(join(pkg, 'service'), { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'pult', version: '9.9.9' }))
      copyFileSync(join(ROOT, 'service', 'pultd-launch'), join(pkg, 'service', 'pultd-launch'))
      mkdirSync(dirname(svc.paths.serviceLog), { recursive: true })
      writeFileSync(svc.paths.serviceLog, 'строка из прошлого запуска\n')
      const out: string[] = []
      const err: string[] = []
      const code = await installService(svc.paths, { out: (s) => out.push(s), err: (s) => err.push(s) },
        { dev: true, devRoot: pkg, env: svc.env, waitMs: 400 })
      const errText = err.join('\n')
      assert.equal(code, 1)
      assert.match(errText, /не ответил hello_ok с версией 9\.9\.9/)
      assert.match(errText, /строка из прошлого запуска/)
      assert.match(errText, /pult daemon uninstall/)
      assert.match(errText, /Desktop.*системный диалог/s)
      assert.ok(existsSync(svc.file), 'служба должна остаться установленной')
    } finally {
      await teardown(svc)
    }
  })
})

describe('служба: CLI на своём node Пульта', () => {
  it('nodeExec внутри PULT_HOME/runtime (лаунчер bin/pult): node-path не пишется — это кэш системного node', async () => {
    const svc = makeSvc('darwin', { FAKE_SVC_NOSPAWN: '1' })
    try {
      const own = join(svc.paths.runtime, 'node-v24.21.0-darwin-arm64', 'bin', 'node')
      const code = await installService(svc.paths, { out: () => {}, err: () => {} },
        { dev: true, env: svc.env, waitMs: 200, nodeExec: own })
      assert.equal(code, 1, 'демона нет (FAKE_SVC_NOSPAWN) — установка не подтверждена')
      assert.equal(existsSync(svc.paths.nodePath), false, 'свой node записан в node-path')
      assert.ok(readFileSync(svc.file, 'utf8').includes(`<string>${dirname(own)}:`), 'PATH службы начинается не с каталога node CLI')
    } finally {
      await teardown(svc)
    }
  })
})

describe('служба: ответ не того демона', () => {
  it('hello_ok той же версии, но от демона «по требованию» — это НЕ успех установки', async () => {
    // Регрессия: демон «по требованию», поднятый чужой командой между остановкой и загрузкой,
    // отвечает той же версией и держит lock; служебный экземпляр при этом выходит с кодом 3.
    // Фальшивка здесь поднимает демона БЕЗ PULT_SERVICE — ровно такой ответ install и видит.
    const svc = makeSvc('darwin', { FAKE_SVC_DROP_ENV: 'PULT_SERVICE' })
    try {
      const out: string[] = []
      const err: string[] = []
      const code = await installService(svc.paths, { out: (s) => out.push(s), err: (s) => err.push(s) },
        { dev: true, env: svc.env, waitMs: 3000 })
      assert.equal(code, 1, out.join('\n'))
      assert.match(err.join('\n'), /режим on-demand/)
      assert.match(err.join('\n'), /lock держит демон «по требованию»/)
    } finally {
      await teardown(svc)
    }
  })
})

describe('pult doctor: пункты службы', () => {
  it('darwin: лаунчер, pid, node-path; выход 78 — FAIL с объяснением', async () => {
    const svc = makeSvc('darwin')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      const ok = serviceDoctorItems(svc.paths, svc.env)
      const byId = (items: typeof ok, id: string) => items.find((i) => i.id === id)
      assert.equal(byId(ok, 'service.launcher')?.status, 'ok')
      assert.equal(byId(ok, 'service')?.status, 'ok')
      assert.match(byId(ok, 'service')?.detail ?? '', /pid \d+/)
      assert.equal(byId(ok, 'service.node')?.status, 'ok')

      await runCli(svc, ['daemon', 'stop'])
      assert.ok(await waitFor(() => !existsSync(svc.paths.lock), 10_000))
      const bad = serviceDoctorItems(svc.paths, { ...svc.env, FAKE_SVC_LAST_EXIT: '78' })
      assert.equal(byId(bad, 'service')?.status, 'fail')
      assert.match(byId(bad, 'service')?.detail ?? '', /78.*несуществующий node или точку входа/)
      // Смерть от сигнала (настоящий launchd после kill -9: строки кода нет) — предупреждение с сигналом.
      const killed = serviceDoctorItems(svc.paths, { ...svc.env, FAKE_SVC_LAST_SIGNAL: 'Killed: 9' })
      assert.equal(byId(killed, 'service')?.status, 'warn')
      assert.match(byId(killed, 'service')?.detail ?? '', /spawn scheduled.*последний выход: сигнал 9 \(Killed\)/)

      // Лаунчер пропал — служба не стартует: FAIL с командой починки.
      rmSync(svc.paths.launcher)
      const gone = serviceDoctorItems(svc.paths, svc.env)
      assert.equal(byId(gone, 'service.launcher')?.status, 'fail')
      assert.equal(byId(gone, 'service.launcher')?.fix, 'pult daemon install')
      // Команда починки — ещё и fixCmd: окно рисует кнопку «копировать» только по нему.
      assert.equal(byId(gone, 'service.launcher')?.fixCmd, 'pult daemon install')
      writeFileSync(svc.paths.nodePath, '')
      const noNode = byId(serviceDoctorItems(svc.paths, svc.env), 'service.node')
      assert.equal(noNode?.status, 'warn')
      assert.equal(noNode?.fixCmd, 'pult daemon install')
    } finally {
      await teardown(svc)
    }
  })

  it('linux: linger выключен — предупреждение с точной командой; службы нет — ok и совет поставить', async () => {
    const svc = makeSvc('linux')
    try {
      const none = serviceDoctorItems(svc.paths, svc.env)
      assert.equal(none.length, 1)
      assert.equal(none[0]?.status, 'ok')
      assert.match(none[0]?.detail ?? '', /pult daemon install/)
      assert.equal(none[0]?.fix, undefined, 'у пункта ok не бывает «почини»')

      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'], { FAKE_SVC_FAIL: 'enable-linger' })).code, 0)
      const items = serviceDoctorItems(svc.paths, svc.env)
      const linger = items.find((i) => i.id === 'service.linger')
      assert.equal(linger?.status, 'warn')
      assert.equal(linger?.fix, `sudo loginctl enable-linger ${USER}`)
      assert.equal(linger?.fixCmd, `sudo loginctl enable-linger ${USER}`)
    } finally {
      await teardown(svc)
    }
  })
})

describe('демон под службой', () => {
  it('SIGTERM (bootout, systemctl stop) — чистый выход с кодом 0: KeepAlive/on-failure не воскрешают', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-'))
    const home = join(dir, 'h')
    const paths = layout(home)
    const entry = join(ROOT, 'dist', 'daemon', 'main.js')
    const child = spawn(process.execPath, [entry], {
      env: { PATH: process.env['PATH'] ?? '', HOME: dir, PULT_HOME: home, PULT_TEST: '1', PULT_SERVICE: '1', PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX },
      stdio: 'ignore',
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })))
    try {
      assert.ok(await waitFor(() => existsSync(paths.sock), 10_000), 'демон не поднялся')
      child.kill('SIGTERM')
      const res = await exited
      assert.deepEqual(res, { code: 0, signal: null })
      assert.ok(!existsSync(paths.lock), 'lock не снят')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('демон: сигнал посреди старта', () => {
  it('SIGTERM сразу после взятия lock (сокета ещё нет, старт идёт) — всё равно выход с кодом 0, lock снят', async () => {
    // Регрессия (ci-check 23.09.2026): обработчики SIGTERM ставились ПОСЛЕ startDaemon, и сигнал
    // в окне «lock взят, старт не закончен» убивал процесс сигналом — под launchd это «неуспешный
    // выход», служба поднимала бы демона, которого просили остановить. Ловим окно точно: lock
    // появляется в начале startDaemon, опрос — на каждом обороте цикла, а не раз в 20 мс.
    const dir = mkdtempSync(join(tmpdir(), 'pg-'))
    const home = join(dir, 'h')
    const paths = layout(home)
    const entry = join(ROOT, 'dist', 'daemon', 'main.js')
    const child = spawn(process.execPath, [entry], {
      env: { PATH: process.env['PATH'] ?? '', HOME: dir, PULT_HOME: home, PULT_TEST: '1', PULT_SERVICE: '1', PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX },
      stdio: 'ignore',
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })))
    try {
      const deadline = Date.now() + 10_000
      while (!existsSync(paths.lock) && Date.now() < deadline) await new Promise<void>((r) => setImmediate(r))
      assert.ok(existsSync(paths.lock), 'демон не взял lock')
      const sockAtSignal = existsSync(paths.sock)
      child.kill('SIGTERM')
      const res = await exited
      assert.deepEqual(res, { code: 0, signal: null }, `сокет в момент сигнала: ${sockAtSignal}`)
      assert.ok(!existsSync(paths.lock), 'lock не снят')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('демон: сигнал, пока node грузит граф модулей', () => {
  it('SIGTERM до загрузки кода демона — выход с кодом 0, lock не взят', async () => {
    // Регрессия B1 повторной приёмки В4 (23.09.2026, настоящий launchd): обработчики сигналов ставил
    // main() демона, а статические импорты dist/daemon/main.js вычисляются раньше него. SIGTERM в
    // это окно убивал процесс сигналом, и launchd (KeepAlive {SuccessfulExit: false}) поднимал демона
    // снова. Окно делаем долгим хуком загрузчика: загрузка server.js (он есть в графе демона при
    // любой раскладке точки входа) ждёт 3 с. Хук живёт в отдельном потоке — сигналы главного потока он не держит.
    const dir = mkdtempSync(join(tmpdir(), 'pg-'))
    const home = join(dir, 'h')
    const paths = layout(home)
    const mark = join(dir, 'loading')
    const hooks = join(dir, 'hooks.mjs')
    writeFileSync(hooks, [
      "import { writeFileSync } from 'node:fs'",
      'export async function load(url, context, next) {',
      "  if (url.endsWith('/dist/daemon/server.js')) {",
      "    writeFileSync(process.env.LOAD_MARK, 'x')",
      '    await new Promise((r) => setTimeout(r, 3000))',
      '  }',
      '  return next(url, context)',
      '}',
      '',
    ].join('\n'))
    const preload = join(dir, 'preload.mjs')
    writeFileSync(preload, `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hooks).href)})\n`)
    const entry = join(ROOT, 'dist', 'daemon', 'main.js')
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry], {
      env: { PATH: process.env['PATH'] ?? '', HOME: dir, PULT_HOME: home, PULT_TEST: '1', PULT_SERVICE: '1', PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX, LOAD_MARK: mark },
      stdio: 'ignore',
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })))
    try {
      assert.ok(await waitFor(() => existsSync(mark), 10_000), 'загрузка server.js не началась')
      child.kill('SIGTERM')
      assert.deepEqual(await exited, { code: 0, signal: null })
      assert.ok(!existsSync(paths.lock), 'демон взял lock, хотя его просили остановиться до старта')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dist/daemon/main.js без статических импортов: обработчики сигналов — первое, что исполняется', () => {
    const src = readFileSync(join(ROOT, 'dist', 'daemon', 'main.js'), 'utf8')
    const staticImports = src.split('\n').filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s*\(/.test(l))
    assert.deepEqual(staticImports, [])
    assert.ok(src.indexOf("process.on('SIGTERM'") < src.lastIndexOf('await import('), 'обработчики ставятся после загрузки демона')
  })
})

describe('pult daemon stop посреди старта демона', () => {
  // Регрессия приёмки лида (23.09.2026, настоящий launchd): после kill -9 демона launchd поднимает
  // нового, а в run/ ещё лежат сокет, lock и токен УБИТОГО. `pult daemon stop` в это окно не мог
  // подключиться и отвечал «демон не запущен — останавливать нечего» (код 0), а через 2 с
  // `daemon status` показывал живого демона с аптаймом 2 с.
  //
  // Медленный старт: лаунчер берёт точку входа из PULT_ENTRY (docs/08 §2), здесь это обёртка,
  // которая ждёт SLOW_MS до импорта настоящего демона. SIGTERM в ожидании — выход с кодом 0, как у
  // настоящего демона, ставящего обработчики до старта.
  const slowEntry = (dir: string): string => {
    const f = join(dir, 'pultd-slow.mjs')
    writeFileSync(f, [
      "import { pathToFileURL } from 'node:url'",
      "const onTerm = () => process.exit(0)",
      "process.on('SIGTERM', onTerm)",
      "await new Promise((r) => setTimeout(r, Number(process.env.SLOW_MS)))",
      "process.removeListener('SIGTERM', onTerm)",
      "await import(pathToFileURL(process.env.SLOW_MAIN).href)",
      '',
    ].join('\n'))
    return f
  }

  it('linux: служба поднимает демона, в run/ — сокет и lock убитого; stop дожидается сокета и гасит его daemon.stop', async () => {
    const svc = makeSvc('linux')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      const first = statePids(svc)[0] ?? 0
      assert.ok(first > 0 && alive(first))
      process.kill(first, 'SIGKILL')
      assert.ok(await waitFor(() => !alive(first)))
      assert.ok(existsSync(svc.paths.sock) && existsSync(svc.paths.lock) && existsSync(svc.paths.token), 'kill -9 не оставил следов')

      // Менеджер служб поднимает демона заново (Restart=on-failure) — медленно.
      const extra = {
        ...(JSON.parse(svc.env['FAKE_SVC_EXTRA_ENV'] ?? '{}') as Record<string, string>),
        PULT_ENTRY: slowEntry(svc.dir),
        SLOW_MAIN: join(ROOT, 'dist', 'daemon', 'main.js'),
        SLOW_MS: '3000',
      }
      const r = spawnSync(process.execPath, [join(FAKES, 'fake-systemctl.mjs'), '--user', 'start', 'pultd.service'], {
        env: { ...svc.env, FAKE_SVC_EXTRA_ENV: JSON.stringify(extra) }, encoding: 'utf8',
      })
      assert.equal(r.status, 0, r.stderr)
      let second = 0
      assert.ok(await waitFor(() => {
        second = statePids(svc).find((p) => p !== first && alive(p)) ?? 0
        return second > 0
      }), 'менеджер не поднял демона заново')

      const stop = await runCli(svc, ['daemon', 'stop'])
      assert.doesNotMatch(stop.stdout, /не запущен/, 'stop не увидел стартующего демона')
      assert.equal(stop.code, 0, stop.stderr + stop.stdout)
      assert.equal(stop.stdout.trim(), 'демон остановлен', 'стартующий демон должен быть остановлен штатно, через сокет')
      // stop отвечает, как только lock свободен, а lock демон снимает ПОСЛЕДНИМ шагом уборки — процесс
      // ещё выходит (и до того, как надзиратель фальшивки его пожнёт, kill(pid, 0) видит зомби).
      // Мгновенная проверка моргала на ubuntu CI (PR #9): ждём смерти с потолком, а не угадываем.
      assert.ok(await waitFor(() => !alive(second), 3000), `демон службы (pid ${second}) жив после stop`)
      assert.ok(!existsSync(svc.paths.lock), 'lock не снят')
    } finally {
      await teardown(svc)
    }
  })

  // Регрессия B1 (повторная приёмка лида 23.09.2026, настоящий launchd, 0.1.0-acc.4): kill -9 демона →
  // launchd поднимает нового → СРАЗУ `pult daemon stop` → через 25 с «служба не остановилась
  // (менеджер снова её запускает)», код 1, демон жив, `последний выход: сигнал 15`. stop слал
  // `launchctl kill SIGTERM` процессу в окне старта — лаунчеру (sh без trap) или node, ещё грузящему
  // граф импортов, до обработчиков сигналов. Смерть от сигнала — «неуспешный выход», KeepAlive
  // поднимал демона снова, stop бил и новый pid — петля. Прежняя фальшивка launchd не воскрешала
  // службу, и тест на неё проходил. Теперь надзиратель фальшивки (fake-launchd-job.mjs) воскрешает.
  //
  // Окно старта: точка входа (PULT_ENTRY) ждёт столько мс, сколько записано в SLOW_FILE, БЕЗ
  // обработчика SIGTERM — ровно как node, грузящий граф импортов, — и только потом грузит демона.
  const bareSlowEntry = (dir: string): { entry: string; slowFile: string } => {
    const entry = join(dir, 'pultd-bare-slow.mjs')
    const slowFile = join(dir, 'slow-ms')
    writeFileSync(entry, [
      "import { existsSync, readFileSync } from 'node:fs'",
      "import { pathToFileURL } from 'node:url'",
      'const ms = existsSync(process.env.SLOW_FILE) ? Number(readFileSync(process.env.SLOW_FILE, "utf8")) : 0',
      'if (ms > 0) await new Promise((r) => setTimeout(r, ms))',
      'await import(pathToFileURL(process.env.SLOW_MAIN).href)',
      '',
    ].join('\n'))
    return { entry, slowFile }
  }
  const bareSlowSvc = (): { svc: Svc; slowFile: string } => {
    const svc = makeSvc('darwin')
    const { entry, slowFile } = bareSlowEntry(svc.dir)
    svc.env['FAKE_SVC_EXTRA_ENV'] = JSON.stringify({
      ...(JSON.parse(svc.env['FAKE_SVC_EXTRA_ENV'] ?? '{}') as Record<string, string>),
      PULT_ENTRY: entry, SLOW_MAIN: join(ROOT, 'dist', 'daemon', 'main.js'), SLOW_FILE: slowFile,
    })
    return { svc, slowFile }
  }

  it('darwin: kill -9 → launchd поднял демона → stop в окне его старта — ждёт сокет и daemon.stop: код 0, воскрешений нет', async () => {
    const { svc, slowFile } = bareSlowSvc()
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      const first = statePids(svc)[0] ?? 0
      assert.ok(first > 0 && alive(first))
      writeFileSync(slowFile, '2500')
      process.kill(first, 'SIGKILL')
      let second = 0
      assert.ok(await waitFor(() => {
        second = statePids(svc).find((p) => p !== first && alive(p)) ?? 0
        return second > 0
      }, 10_000), 'фальшивый launchd не поднял демона после kill -9')

      const mark = fakeCalls(svc).length
      const stop = await runCli(svc, ['daemon', 'stop'])
      assert.equal(stop.code, 0, stop.stderr + stop.stdout)
      assert.match(stop.stdout, /демон остановлен/)
      assert.ok(await waitFor(() => fakeCalls(svc).slice(mark).some((c) => c.event === 'exit'), 10_000), 'надзиратель не увидел выхода демона')
      const exits = fakeCalls(svc).slice(mark).filter((c) => c.event === 'exit')
      assert.deepEqual(exits.map((c) => ({ code: c.code, signal: c.signal })), [{ code: 0, signal: null }], 'демон умер не чистым выходом')
      // ThrottleInterval фальшивки — 1 с: будь выход «неуспешным», воскрешение уже случилось бы.
      await sleep(1500)
      const after = fakeCalls(svc).slice(mark)
      assert.ok(!after.some((c) => c.event === 'respawn'), `launchd поднял демона после stop: ${JSON.stringify(after)}`)
      assert.ok(!after.some((c) => c.argv[0] === 'kill'), 'stop слал сигнал, хотя сокет появился')
      assert.deepEqual(statePids(svc).filter(alive), [], 'после stop жив процесс службы')
      assert.ok(!existsSync(svc.paths.lock), 'lock не снят')
    } finally {
      await teardown(svc)
    }
  })

  it('darwin: сокет не появился за 10 с — один SIGTERM через launchctl; воскрешён — честный код 1, без петли сигналов', async () => {
    const { svc, slowFile } = bareSlowSvc()
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      const first = statePids(svc)[0] ?? 0
      assert.ok(first > 0 && alive(first))
      writeFileSync(slowFile, '60000')
      process.kill(first, 'SIGKILL')
      assert.ok(await waitFor(() => statePids(svc).some((p) => p !== first && alive(p)), 10_000), 'фальшивый launchd не поднял демона после kill -9')

      const mark = fakeCalls(svc).length
      const t0 = Date.now()
      const stop = await runCli(svc, ['daemon', 'stop'])
      const took = Date.now() - t0
      assert.equal(stop.code, 1, stop.stdout)
      assert.match(stop.stderr, /снова запускает/, stop.stderr)
      const kills = fakeCalls(svc).slice(mark).filter((c) => c.argv[0] === 'kill')
      assert.equal(kills.length, 1, `сигналов через launchctl: ${kills.length}`)
      assert.ok(took >= 9_000 && took < 20_000, `stop занял ${took} мс`)
      // Lock убитого kill -9 так и лежит (новый демон до него не дошёл) — убираем для teardown.
      rmSync(svc.paths.lock, { force: true })
    } finally {
      await teardown(svc)
    }
  })

  it('darwin: служба в петле падений (spawn scheduled после кода 78, процесса нет) — stop не ждёт очередного падения', async () => {
    // Живого демона нет: launchd поднимет лаунчер, тот снова выйдет с кодом 78. Ждать pid такого
    // процесса до дедлайна (25 с) и отвечать ошибкой — неправда; «не запущен» — правда.
    const svc = makeSvc('darwin')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      assert.equal((await runCli(svc, ['daemon', 'stop'])).code, 0)
      assert.ok(await waitFor(() => !existsSync(svc.paths.lock), 10_000))
      const t0 = Date.now()
      const r = await runCli(svc, ['daemon', 'stop'], { FAKE_SVC_SPAWN_SCHEDULED: '1', FAKE_SVC_LAST_EXIT: '78' })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /не запущен/)
      assert.ok(Date.now() - t0 < 5000, `stop ждал ${Date.now() - t0} мс`)
    } finally {
      await teardown(svc)
    }
  })

  it('без службы: lock держит живой pultd, сокета нет — stop ждёт сокет, затем SIGTERM; не «не запущен»', async () => {
    const svc = makeSvc('darwin')
    // Держатель lock без сокета — окно «lock взят, listen ещё не было» у демона по требованию.
    const holderFile = join(svc.dir, 'pultd-holder.mjs')
    writeFileSync(holderFile, [
      `import { acquireLock } from ${JSON.stringify(pathToFileURL(join(ROOT, 'dist', 'core', 'lock.js')).href)}`,
      "import { mkdirSync } from 'node:fs'",
      "import { dirname } from 'node:path'",
      'mkdirSync(dirname(process.env.LOCK), { recursive: true })',
      'const r = acquireLock(process.env.LOCK)',
      'if (!r.ok) process.exit(3)',
      "process.on('SIGTERM', () => { r.lock.release(); process.exit(0) })",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'))
    const holder = spawn(process.execPath, [holderFile], { env: { ...svc.env, LOCK: svc.paths.lock }, stdio: 'ignore' })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => holder.on('exit', (code, signal) => res({ code, signal })))
    try {
      assert.ok(await waitFor(() => existsSync(svc.paths.lock), 10_000), 'держатель не взял lock')
      const stop = await runCli(svc, ['daemon', 'stop'])
      assert.doesNotMatch(stop.stdout, /не запущен/, 'stop не увидел держателя lock')
      assert.equal(stop.code, 0, stop.stderr + stop.stdout)
      assert.match(stop.stdout, /демон остановлен/)
      assert.deepEqual(await exited, { code: 0, signal: null })
      assert.ok(!existsSync(svc.paths.lock), 'lock не снят')
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
      await reapFakeSupervisors(svc.log)
      removeTree(svc.dir)
    }
  })
})

describe('pult daemon stop: сигнал — только подтверждённому pultd', () => {
  // Находка `codex review` дельты В4 (28.09.2026): для lock БЕЗ времени старта (старый формат или
  // `acquireLock` не смог прочитать `lstart`) stop решал «кому SIGTERM» осторожным вердиктом
  // «держатель жив»: pid жив, а `ps` упал или не ответил — значит, «наш». Для отказа брать lock это
  // верно, для сигнала — нет: номер протухшего lock мог достаться чужому процессу, и stop гасил его.
  //
  // Держатель здесь — безобидный node, pid которого «достался» протухшему lock. Сокета нет, службы
  // нет (PULT_TEST=1 без PULT_SERVICE_DIR), вердикт `ps` подменяется через `lockDeps`.
  const PULTD_CMD = '/usr/bin/node /opt/pult/dist/daemon/main.js'
  const fast = { sockWaitMs: 300, serviceWaitMs: 2000, lockWaitMs: 1500 }

  function stale(record: (pid: number) => Record<string, unknown>): { dir: string; paths: PultPaths; env: NodeJS.ProcessEnv; child: ReturnType<typeof spawn>; pid: number } {
    const dir = mkdtempSync(join(tmpdir(), 'pk-'))
    const paths = layout(join(dir, 'h'))
    mkdirSync(dirname(paths.lock), { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const pid = child.pid ?? 0
    assert.ok(pid > 0, 'безобидный процесс не запустился')
    writeFileSync(paths.lock, JSON.stringify(record(pid)), { mode: 0o600 })
    const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: join(dir, 'home'), PULT_HOME: paths.home, PULT_TEST: '1' }
    return { dir, paths, env, child, pid }
  }
  const signalled = (c: ReturnType<typeof spawn>): boolean => c.exitCode !== null || c.signalCode !== null
  function cleanup(t: { dir: string; child: ReturnType<typeof spawn> }): void {
    if (!signalled(t.child)) t.child.kill('SIGKILL')
    rmSync(t.dir, { recursive: true, force: true })
  }

  it('lock без времени старта, pid жив, `ps` не ответил — SIGTERM НЕ шлётся; failed с pid и подсказкой ps -p', async () => {
    const t = stale((pid) => ({ pid, startedAt: '', started: '', cmd: PULTD_CMD }))
    try {
      const r = await stopDaemon(t.paths, { env: t.env, ...fast, lockDeps: { processCommand: () => null } })
      // Отрицательное ожидание: процесс обязан пережить stop, а не просто ещё не успеть умереть.
      assert.equal(await waitFor(() => signalled(t.child), 500), false, `stop послал сигнал неопознанному процессу pid ${t.pid}: ${t.child.signalCode}`)
      assert.equal(r.result, 'failed', JSON.stringify(r))
      const message = r.result === 'failed' ? r.message : ''
      assert.match(message, new RegExp(`pid ${t.pid}\\b`))
      assert.match(message, new RegExp(`ps -p ${t.pid}\\b`))
    } finally {
      cleanup(t)
    }
  })

  it('lock без времени старта, `ps` видит pultd — SIGTERM шлётся (прежнее поведение)', async () => {
    const t = stale((pid) => ({ pid, startedAt: '', started: '', cmd: '' }))
    try {
      const r = await stopDaemon(t.paths, { env: t.env, ...fast, lockDeps: { processCommand: () => PULTD_CMD } })
      assert.ok(await waitFor(() => signalled(t.child), 3000), 'подтверждённый pultd не получил сигнала')
      assert.equal(t.child.signalCode, 'SIGTERM')
      assert.deepEqual(r, { result: 'stopped', via: 'signal', pid: t.pid })
    } finally {
      cleanup(t)
    }
  })

  it('время старта записано, но не совпало (pid переиспользован) — сигнала нет, «не запущен»', async () => {
    const t = stale((pid) => ({ pid, startedAt: '', started: 'Mon Sep 21 10:00:00 2026', cmd: PULTD_CMD }))
    try {
      const r = await stopDaemon(t.paths, {
        env: t.env, ...fast, lockDeps: { processStart: () => 'Tue Sep 22 11:11:11 2026', processCommand: () => PULTD_CMD },
      })
      assert.equal(await waitFor(() => signalled(t.child), 500), false, `stop послал сигнал переиспользованному pid ${t.pid}`)
      assert.deepEqual(r, { result: 'none' })
    } finally {
      cleanup(t)
    }
  })

  it('время старта записано, а `ps` его не отдал — сигнала нет; lock не считается свободным: failed с pid', async () => {
    const t = stale((pid) => ({ pid, startedAt: '', started: 'Mon Sep 21 10:00:00 2026', cmd: PULTD_CMD }))
    try {
      const r = await stopDaemon(t.paths, { env: t.env, ...fast, lockDeps: { processStart: () => null, processCommand: () => null } })
      assert.equal(await waitFor(() => signalled(t.child), 500), false, `stop послал сигнал неопознанному процессу pid ${t.pid}`)
      assert.equal(r.result, 'failed', JSON.stringify(r))
      assert.match(r.result === 'failed' ? r.message : '', new RegExp(`pid ${t.pid}\\b`))
    } finally {
      cleanup(t)
    }
  })
})

describe('тарбол пакета', () => {
  it('npm pack кладёт service/pultd-launch с битом исполнения', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-'))
    try {
      const sibling = join(dirname(process.execPath), 'npm')
      const npm = existsSync(sibling) ? sibling : 'npm'
      // HOME и кэш — во временной папке: npm пишет журналы в ~/.npm/_logs, а настоящий дом трогать нельзя.
      const r = spawnSync(npm, ['pack', '--dry-run', '--json', '--offline', '--ignore-scripts'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          PATH: `${dirname(process.execPath)}:${process.env['PATH'] ?? ''}`,
          HOME: dir,
          npm_config_cache: join(dir, 'cache'),
          npm_config_logs_dir: join(dir, 'logs'),
          npm_config_update_notifier: 'false',
        },
      })
      assert.equal(r.status, 0, r.stderr)
      const packed = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string; mode: number }> }>
      const files = packed[0]?.files ?? []
      const launcher = files.find((f) => f.path === 'service/pultd-launch')
      assert.ok(launcher, `в тарболе нет service/pultd-launch: ${files.map((f) => f.path).join(', ')}`)
      assert.equal(launcher.mode & 0o111, 0o111, `режим ${launcher.mode.toString(8)}`)
      assert.ok(files.some((f) => f.path === 'dist/daemon/main.js'))
      assert.ok(!files.some((f) => f.path.startsWith('test/') || f.path.startsWith('spike/')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('менеджер служб: окружение по белому списку (инвариант 1)', () => {
  it('launchctl получает белый список и шину пользователя, но не ANTHROPIC_*/CLAUDE_*/OPENAI_*', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-'))
    try {
      const dump = join(dir, 'env.txt')
      const fake = join(dir, 'launchctl-env')
      // Код 113 — «службы нет»: queryState принимает его как норму и не ругается.
      writeFileSync(fake, `#!/bin/sh\n/usr/bin/env > '${dump}'\nexit 113\n`)
      chmodSync(fake, 0o755)
      const ctx = serviceContext(layout(join(dir, 'h')), {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: dir, USER,
        PULT_TEST: '1', PULT_SERVICE_PLATFORM: 'darwin', PULT_LAUNCHCTL: fake,
        ANTHROPIC_API_KEY: 'sk-ant-утечка', ANTHROPIC_BASE_URL: 'https://example.invalid',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/чужая-сессия', OPENAI_API_KEY: 'sk-openai-утечка',
        XDG_RUNTIME_DIR: '/run/user/501', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
      })
      assert.equal(queryState(ctx).loaded, false)
      const keys = readFileSync(dump, 'utf8').split('\n').filter(Boolean).map((l) => l.slice(0, l.indexOf('=')))
      const leaked = keys.filter((k) => /^(ANTHROPIC_|CLAUDE_|OPENAI_)/.test(k))
      assert.deepEqual(leaked, [], `менеджеру служб ушли переменные родителя: ${leaked.join(', ')}`)
      // systemctl --user и loginctl без них не находят пользовательскую шину.
      assert.ok(keys.includes('XDG_RUNTIME_DIR') && keys.includes('DBUS_SESSION_BUS_ADDRESS'), keys.join(' '))
      assert.ok(keys.includes('PATH') && keys.includes('HOME'), keys.join(' '))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('doctor.run на демоне: медленный менеджер служб', () => {
  it('launchctl print думает 2 с — демон не встаёт: daemon.status другого клиента отвечает сразу', async () => {
    // Раньше serviceDoctorItems звал spawnSync прямо на событийном цикле демона: пока launchctl
    // думал (до 20 с таймаута), демон не отвечал НИКОМУ — ни статусу, ни агентам, ни подпискам.
    const home = tempHome()
    const svcDir = mkdtempSync(join(tmpdir(), 'psd-'))
    const keys = ['PULT_SERVICE_PLATFORM', 'PULT_SERVICE_DIR', 'PULT_LAUNCHCTL'] as const
    const saved = keys.map((k) => [k, process.env[k]] as const)
    let daemon: DaemonHandle | null = null
    try {
      mkdirSync(home.paths.bin, { recursive: true })
      writeFileSync(home.paths.launcher, '#!/bin/sh\nexit 0\n')
      chmodSync(home.paths.launcher, 0o755)
      writeFileSync(join(svcDir, 'dev.pult.daemon.plist'), renderService({
        platform: 'darwin', name: 'dev.pult.daemon', launcher: home.paths.launcher, pultHome: home.paths.home,
        serviceLog: home.paths.serviceLog, home: svcDir, nodeExec: process.execPath,
      }))
      const slow = join(svcDir, 'slow-launchctl')
      writeFileSync(slow, '#!/bin/sh\nif [ "$1" = print ]; then sleep 2; printf \'gui/501/dev.pult.daemon = {\\n\\tstate = not running\\n\\tlast exit code = 0\\n}\\n\'; fi\nexit 0\n')
      chmodSync(slow, 0o755)
      // Швы службы демон в тестовом режиме читает из process.env (демон — в этом же процессе).
      process.env['PULT_SERVICE_PLATFORM'] = 'darwin'
      process.env['PULT_SERVICE_DIR'] = svcDir
      process.env['PULT_LAUNCHCTL'] = slow
      daemon = await startTestDaemon(home, { testMode: true })
      const c1 = await connectClient(home.paths)
      const c2 = await connectClient(home.paths)
      try {
        const t0 = Date.now()
        let finished = false
        const doc = c1.request('doctor.run', { net: false }).finally(() => { finished = true })
        const lags: number[] = []
        while (!finished) {
          const t = Date.now()
          await c2.request('daemon.status')
          lags.push(Date.now() - t)
          await sleep(30)
        }
        const report = (await doc) as { items: Array<{ id: string; status: string; detail: string }> }
        const took = Date.now() - t0
        const svc = report.items.find((i) => i.id === 'service')
        assert.match(svc?.detail ?? '', /загружена, процесса нет/, JSON.stringify(report.items))
        assert.ok(took >= 1800, `doctor.run прошёл за ${took} мс — медленный launchctl не звался?`)
        assert.ok(Math.max(...lags) < 500, `daemon.status другого клиента ждал ${Math.max(...lags)} мс; ряд: ${JSON.stringify(lags)}`)
      } finally {
        c1.close()
        c2.close()
      }
    } finally {
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      if (daemon) await daemon.stop('конец теста')
      home.remove()
      rmSync(svcDir, { recursive: true, force: true })
    }
  })
})

// Регрессии 30.09.2026 (настоящий launchd, служба владельца): `pult update` получил
// «Bootstrap failed: 5: Input/output error» (bootstrap сразу за bootout, пока launchd доснимал
// службу), поднял демона напрямую и оставил службу НЕ загруженной; `pult daemon start` после этого
// отвечал `kickstart` → 113 «Could not find service» и снова шёл в обход. Вылечил только ручной
// `launchctl bootstrap`.
describe('launchd: служба установлена, но не загружена', () => {
  const launchctl = (svc: Svc, args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(FAKES, 'fake-launchctl.mjs'), ...args], { env: { ...svc.env, ...extra }, encoding: 'utf8' })
  const target = `gui/${process.getuid?.()}/dev.pult.daemon`

  it('pult daemon start грузит её (kickstart → 113 → bootstrap): демон поднимается под службой, а не в обход', async () => {
    const svc = makeSvc('darwin')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      const first = (await status(svc))['pid'] as number
      // Кто-то снял службу и не вернул: файл на месте, launchd о ней не знает.
      assert.equal(launchctl(svc, ['bootout', target]).status, 0)
      assert.ok(await waitFor(() => !alive(first) && !existsSync(svc.paths.lock), 10_000))
      const before = await runCli(svc, ['daemon', 'status'])
      assert.match(before.stdout, /не загружена \(загрузить: pult daemon install\)/)
      const mark = fakeCalls(svc).length

      const r = await runCli(svc, ['daemon', 'start'])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.doesNotMatch(r.stderr, /поднимаю демона напрямую/, r.stderr)
      assert.match(r.stdout, /демон запущен: pid \d+, режим service/)
      const verbs = fakeCalls(svc).slice(mark).map((c) => c.argv[0]).filter((v) => v === 'kickstart' || v === 'bootstrap')
      assert.deepEqual(verbs, ['kickstart', 'bootstrap'], 'незагруженную службу грузит bootstrap, а не один kickstart')
      const st = await status(svc)
      assert.equal(st['mode'], 'service')
      assert.equal((st['service'] as { manager: { loaded: boolean } }).manager.loaded, true)
    } finally {
      await teardown(svc)
    }
  })

  it('две команды разом грузят незагруженную службу — обе получают демона службы, ни одна не идёт в обход', async () => {
    // Окно и CLI поднимают демона одновременно: вторая `bootstrap` получает «уже загружена» (код 5).
    // Это не отказ менеджера служб — служба наша, и спавн в обход здесь дал бы второго демона.
    const svc = makeSvc('darwin')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      const first = (await status(svc))['pid'] as number
      assert.equal(launchctl(svc, ['bootout', target]).status, 0)
      assert.ok(await waitFor(() => !alive(first) && !existsSync(svc.paths.lock), 10_000))

      const runs = await Promise.all([runCli(svc, ['daemon', 'start']), runCli(svc, ['daemon', 'start']), runCli(svc, ['agent', 'list'])])
      for (const r of runs) {
        assert.equal(r.code, 0, r.stderr + r.stdout)
        assert.doesNotMatch(r.stderr, /поднимаю демона напрямую|ВНИМАНИЕ/, r.stderr)
      }
      const st = await status(svc)
      assert.equal(st['mode'], 'service')
      assert.deepEqual(statePids(svc), [st['pid']], 'демон один, и это процесс службы')
    } finally {
      await teardown(svc)
    }
  })

  it('bootstrap не удался — демон поднят напрямую, и команда говорит: служба НЕ загружена, вернуть — pult daemon install', async () => {
    const svc = makeSvc('darwin')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      const first = (await status(svc))['pid'] as number
      assert.equal(launchctl(svc, ['bootout', target]).status, 0)
      assert.ok(await waitFor(() => !alive(first) && !existsSync(svc.paths.lock), 10_000))

      const r = await runCli(svc, ['daemon', 'start'], { FAKE_SVC_FAIL: 'bootstrap' })
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stderr, /служба dev\.pult\.daemon не запустилась \(launchctl bootstrap .*код 5.*\) — поднимаю демона напрямую/)
      assert.match(r.stderr, /ВНИМАНИЕ: служба dev\.pult\.daemon осталась НЕ ЗАГРУЖЕННОЙ: демон поднят напрямую \(режим on-demand\)/)
      assert.match(r.stderr, /вернуть службу: pult daemon install/)
      assert.match(r.stdout, /режим on-demand/)

      // И названная команда действительно возвращает демона под службу.
      const back = await runCli(svc, ['daemon', 'install'])
      assert.equal(back.code, 0, back.stderr + back.stdout)
      assert.equal((await status(svc))['mode'], 'service')
    } finally {
      await teardown(svc)
    }
  })

  it('lock держит живой демон, поднятый напрямую, — службу поверх него не грузим', async () => {
    // Иначе процесс службы выходил бы с кодом 3, launchd поднимал бы его каждые 10 с, а после
    // `pult daemon stop` поднял бы демона, которого просили остановить.
    const svc = makeSvc('darwin')
    try {
      mkdirSync(svc.svcDir, { recursive: true })
      mkdirSync(svc.paths.run, { recursive: true })
      writeFileSync(svc.file, renderService({
        platform: 'darwin', name: 'dev.pult.daemon', launcher: svc.paths.launcher, pultHome: svc.paths.home,
        serviceLog: svc.paths.serviceLog, home: svc.fakeHome, nodeExec: process.execPath,
      }))
      // «Демон, поднятый напрямую» — этот тестовый процесс: lock его, сокета нет.
      const held = acquireLock(svc.paths.lock)
      assert.ok(held.ok)
      try {
        const st = start(serviceContext(svc.paths, svc.env))
        assert.equal(st.ok, false)
        assert.match(st.detail, new RegExp(`lock уже держит живой демон \\(pid ${process.pid}\\)`))
        assert.ok(!called(svc, (a) => a[0] === 'bootstrap'), 'служба загружена поверх живого демона')
      } finally {
        if (held.ok) held.lock.release()
      }
      // Lock свободен — та же служба грузится.
      const st = start(serviceContext(svc.paths, { ...svc.env, FAKE_SVC_NOSPAWN: '1' }))
      assert.equal(st.ok, true, st.detail)
      assert.ok(called(svc, (a) => a[0] === 'bootstrap'))
    } finally {
      await reapFakeSupervisors(svc.log)
      removeTree(svc.dir)
    }
  })

  it('демон поднят в обход, но ответил служебный — предупреждения нет; ответил свой — есть', async () => {
    // Менеджер служб ответил ошибкой, хотя процесс службы запустил: кто возьмёт lock — служебный
    // демон или поднятый напрямую — решает гонка. Предупреждение обязано говорить правду про того,
    // кто отвечает, а не про то, что CLI пытался сделать.
    const svc = makeSvc('darwin')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      await runCli(svc, ['daemon', 'stop'])
      assert.ok(await waitFor(() => !existsSync(svc.paths.lock), 10_000))
      const r = await runCli(svc, ['daemon', 'start', '--json'], { FAKE_SVC_FAIL: 'kickstart-after-start' })
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stderr, /не запустилась .* поднимаю демона напрямую/)
      const mode = (JSON.parse(r.stdout) as { status: { mode: string } }).status.mode
      assert.equal(/ВНИМАНИЕ: демон поднят напрямую/.test(r.stderr), mode === 'on-demand', `режим ${mode}, а сказано:\n${r.stderr}`)
    } finally {
      await teardown(svc)
    }
  })

  it('менеджер служб отказал по другой причине — то же предупреждение с командой возврата', async () => {
    const svc = makeSvc('darwin')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      await runCli(svc, ['daemon', 'stop'])
      assert.ok(await waitFor(() => !existsSync(svc.paths.lock), 10_000))
      const mark = fakeCalls(svc).length
      const r = await runCli(svc, ['daemon', 'start'], { FAKE_SVC_FAIL: 'kickstart' })
      assert.equal(r.code, 0, r.stderr)
      assert.ok(!fakeCalls(svc).slice(mark).some((c) => c.argv[0] === 'bootstrap'), 'служба загружена — bootstrap поверх неё не нужен')
      assert.match(r.stderr, /ВНИМАНИЕ: демон поднят напрямую \(режим on-demand\), в обход службы dev\.pult\.daemon: служба загружена/)
      assert.match(r.stderr, /вернуть службу: pult daemon install/)
    } finally {
      await teardown(svc)
    }
  })
})

describe('launchd: bootout возвращается раньше, чем служба выгружена', () => {
  // Замер на настоящем launchd: после `bootout` (код 0, сразу) служба остаётся загруженной, пока её
  // процесс не вышел, — 1,3–5,1 с у демона, занятого стартом; `bootstrap` в это время отвечает кодом 5.
  // Прежние пять повторов по 400 мс (2 с) до конца выгрузки не доживали. Фальшивка держит службу 3 с.
  it('перезагрузка ждёт конца выгрузки и грузит службу с первого bootstrap', async () => {
    const svc = makeSvc('darwin')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      const first = (await status(svc))['pid'] as number
      const mark = fakeCalls(svc).length

      const r = await runCli(svc, ['daemon', 'install', '--dev'], { FAKE_SVC_BOOTOUT_LINGER_MS: '3000' })
      assert.equal(r.code, 0, r.stderr + r.stdout)
      const verbs = fakeCalls(svc).slice(mark).map((c) => c.argv[0]).filter((v): v is string => v === 'bootout' || v === 'print' || v === 'bootstrap')
      const boot = verbs.indexOf('bootstrap')
      assert.equal(verbs.filter((v) => v === 'bootstrap').length, 1, `bootstrap шёл, пока служба ещё выгружалась: ${verbs.join(' ')}`)
      assert.ok(verbs.slice(verbs.indexOf('bootout') + 1, boot).filter((v) => v === 'print').length >= 2,
        `между bootout и bootstrap службу не опрашивали: ${verbs.join(' ')}`)
      const st = await status(svc)
      assert.equal(st['mode'], 'service')
      assert.notEqual(st['pid'], first)
    } finally {
      await teardown(svc)
    }
  })

  for (const race of ['bootout', 'bootstrap'] as const) {
    it(`службу во время перезагрузки загрузила другая команда (${race === 'bootout' ? 'сразу после нашего bootout' : 'перед нашим bootstrap'}) — это успех, а не отказ`, async () => {
      // `ensureDaemon` любой команды и окна сам грузит незагруженную службу. Перезагрузка, заставшая
      // это, раньше ответила бы «менеджер служб не загрузил», а `pult update` поднял бы второго демона.
      const svc = makeSvc('darwin')
      try {
        assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
        const first = (await status(svc))['pid'] as number
        const mark = fakeCalls(svc).length
        const t0 = Date.now()
        const r = await runCli(svc, ['daemon', 'install', '--dev'], { FAKE_SVC_RACE: race })
        assert.equal(r.code, 0, r.stderr + r.stdout)
        assert.ok(Date.now() - t0 < 12_000, `перезагрузка ждала выгрузки службы, которую уже загрузили заново: ${Date.now() - t0} мс`)
        if (race === 'bootout') {
          assert.ok(!fakeCalls(svc).slice(mark).some((c) => c.argv[0] === 'bootstrap'), 'bootstrap поверх службы, загруженной другой командой')
        }
        const st = await status(svc)
        assert.equal(st['mode'], 'service')
        assert.notEqual(st['pid'], first)
      } finally {
        await teardown(svc)
      }
    })
  }

  it('служба так и не выгрузилась — честный отказ с причиной, а не bootstrap поверх живой', async () => {
    const svc = makeSvc('darwin')
    try {
      mkdirSync(svc.svcDir, { recursive: true })
      mkdirSync(svc.paths.bin, { recursive: true })
      writeFileSync(svc.paths.launcher, '#!/bin/sh\nexit 0\n')
      chmodSync(svc.paths.launcher, 0o755)
      writeFileSync(svc.file, renderService({
        platform: 'darwin', name: 'dev.pult.daemon', launcher: svc.paths.launcher, pultHome: svc.paths.home,
        serviceLog: svc.paths.serviceLog, home: svc.fakeHome, nodeExec: process.execPath,
      }))
      const ctx = serviceContext(svc.paths, { ...svc.env, FAKE_SVC_BOOTOUT_LINGER_MS: '60000' })
      assert.equal(load(ctx, svc.file).ok, true, 'первая загрузка')
      const t0 = Date.now()
      const again = load(ctx, svc.file, { unloadWaitMs: 600 })
      assert.equal(again.ok, false)
      assert.ok(Date.now() - t0 < 5000, `ожидание выгрузки не ограничено: ${Date.now() - t0} мс`)
      assert.match(again.steps.at(-1)?.detail ?? '', /служба не выгрузилась за \d+ с после bootout/)
      assert.ok(!again.steps.some((s) => s.cmd.startsWith('launchctl bootstrap')), 'bootstrap поверх невыгруженной службы')
    } finally {
      await reapFakeSupervisors(svc.log)
      removeTree(svc.dir)
    }
  })
})

describe('pult doctor: файл службы прежней версии', () => {
  it('ProcessType Background в plist — предупреждение с командой pult daemon install; свежий файл — без него', async () => {
    // Файл службы `pult update` не переписывает (инвариант 8), поэтому смена шаблона доходит до
    // установленной службы только повторным install — доктор обязан это сказать.
    const svc = makeSvc('darwin')
    try {
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      assert.equal(serviceDoctorItems(svc.paths, svc.env).find((i) => i.id === 'service.file'), undefined)
      const fresh = readFileSync(svc.file, 'utf8')
      assert.match(fresh, /<key>ProcessType<\/key>\s*<string>Standard<\/string>/)
      writeFileSync(svc.file, fresh.replace('<string>Standard</string>', '<string>Background</string>'))
      const item = serviceDoctorItems(svc.paths, svc.env).find((i) => i.id === 'service.file')
      assert.equal(item?.status, 'warn')
      assert.match(item?.detail ?? '', /записан прежней версией — ProcessType Background.*фоновым приоритетом/)
      assert.equal(item?.fixCmd, 'pult daemon install')
      // Повторный install переписывает файл — предупреждение уходит.
      assert.equal((await runCli(svc, ['daemon', 'install', '--dev'])).code, 0)
      assert.equal(serviceDoctorItems(svc.paths, svc.env).find((i) => i.id === 'service.file'), undefined)
    } finally {
      await teardown(svc)
    }
  })
})
