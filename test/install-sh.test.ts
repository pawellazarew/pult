// install.sh (docs/08 §5) — настоящим `sh` на настоящем тарболе: временный HOME, локальный тарбол,
// `--no-service` и отдельно — со службой на фальшивом менеджере служб (швы PULT_TEST=1). Путь
// «системного node нет» — фальшивым `node` v18, стоящим в PATH раньше настоящего, и фальшивым
// тарболом node (PULT_TEST_NODE_TARBALL): сеть не трогается.

import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { platformKey, runtimeName } from '../dist/update/runtime.js'
import type { PlatformKey } from '../dist/update/runtime.js'
import { FAKE_CLAUDE, FAKE_CODEX, reapFakeSupervisors, removeTree, waitFor } from './helpers.js'
import { BROKEN_DAEMON, fakeNodeTarball, fakePin, NODE_DIR, packPult, ROOT, runProc } from './pack-helpers.js'
import type { Run } from './pack-helpers.js'

const INSTALL_SH = join(ROOT, 'install.sh')
const FAKES = join(ROOT, 'test', 'fakes')
const USER = userInfo().username

let work = ''
let tgz = ''

before(() => {
  work = mkdtempSync(join(tmpdir(), 'pj-'))
  tgz = packPult(work, { version: '0.0.7' })
})
after(() => { rmSync(work, { recursive: true, force: true }) })

interface Box { dir: string; home: string; env: Record<string, string>; pids: Set<number> }

function makeBox(extra: Record<string, string> = {}): Box {
  const dir = mkdtempSync(join(tmpdir(), 'pi-'))
  const home = join(dir, 'u')
  mkdirSync(home, { recursive: true })
  const env: Record<string, string> = {
    PATH: `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    USER,
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
    PULT_TEST: '1',
    PULT_CLAUDE_BIN: FAKE_CLAUDE,
    PULT_CODEX_BIN: FAKE_CODEX,
    ...extra,
  }
  return { dir, home, env, pids: new Set() }
}

const sh = (box: Box, args: string[], extra: Record<string, string> = {}): Promise<Run> =>
  runProc('/bin/sh', [INSTALL_SH, ...args], { ...box.env, ...extra }, box.dir).done

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function daemonStatus(box: Box, pultBin: string, pultHome: string): Promise<Record<string, unknown>> {
  const r = await runProc(pultBin, ['daemon', 'status', '--json'], { ...box.env, PULT_HOME: pultHome }).done
  const j = JSON.parse(r.stdout) as Record<string, unknown>
  if (typeof j['pid'] === 'number') box.pids.add(j['pid'])
  return j
}

/** Фальшивый системный node СТАРШЕ 22, первым в PATH: годного системного node «нет». */
function oldNodePath(box: Box): string {
  const dir = join(box.dir, 'oldnode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'node'), '#!/bin/sh\necho v18.19.0\n', { mode: 0o755 })
  return `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`
}

async function teardown(box: Box, pultHome: string): Promise<void> {
  // Лаунчер команды первым: на машине «без node» npm-ссылке current/bin/pult нечем запуститься.
  const launcher = join(pultHome, 'bin', 'pult')
  const cli = existsSync(launcher) ? launcher : join(pultHome, 'current', 'bin', 'pult')
  if (existsSync(cli)) {
    await runProc(cli, ['daemon', 'uninstall'], { ...box.env, PULT_HOME: pultHome }).done
    await runProc(cli, ['daemon', 'stop'], { ...box.env, PULT_HOME: pultHome }).done
  }
  const state = box.env['FAKE_SVC_STATE']
  if (state && existsSync(state)) {
    const st = JSON.parse(readFileSync(state, 'utf8')) as { jobs: Record<string, { pid: number | null }> }
    for (const j of Object.values(st.jobs)) if (typeof j.pid === 'number') box.pids.add(j.pid)
  }
  for (const pid of box.pids) { try { process.kill(pid, 'SIGKILL') } catch { /* ушёл */ } }
  await waitFor(() => !existsSync(join(pultHome, 'run', 'pultd.lock')) && [...box.pids].every((p) => !alive(p)), 10_000)
  // Надзиратель фальшивого launchd пишет в этот дом и после смерти процесса службы — сначала его выход.
  await reapFakeSupervisors(join(box.dir, 'fake.jsonl'))
  removeTree(box.dir)
}

describe('install.sh: скачивание только по https', () => {
  // Фальшивый curl первым в PATH пишет свой argv в файл и отвечает ошибкой: сети нет, но видно,
  // звался ли curl вообще и с какими флагами. Раньше `http://` принимался наравне с `https://`,
  // и подменённый по дороге тарбол исполнялся `node …/dist/cli/main.js update` под пользователем.
  function fakeCurl(box: Box): string {
    const bin = join(box.dir, 'fake-bin')
    mkdirSync(bin, { recursive: true })
    const log = join(box.dir, 'curl-argv')
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexit 22\n`)
    chmodSync(join(bin, 'curl'), 0o755)
    box.env['PATH'] = `${bin}:${box.env['PATH'] ?? ''}`
    return log
  }

  it('http:// — отказ до всякого скачивания, curl не зовётся', async () => {
    const box = makeBox()
    const log = fakeCurl(box)
    try {
      const r = await sh(box, ['--from', 'http://127.0.0.1:9/pult-0.0.7.tgz', '--no-service'])
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stderr, /только https/)
      assert.doesNotMatch(r.stdout, /скачиваю/)
      assert.equal(existsSync(log), false, 'curl вызван для http://')
      assert.equal(existsSync(join(box.home, '.pult')), false)
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  })

  it('https:// — curl с --proto =https и --tlsv1.2 (редирект на http не проходит)', async () => {
    const box = makeBox()
    const log = fakeCurl(box)
    try {
      const r = await sh(box, ['--from', 'https://example.invalid/pult-0.0.7.tgz', '--no-service'])
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stderr, /не скачался/)
      const argv = readFileSync(log, 'utf8').split('\n')
      const at = argv.indexOf('--proto')
      assert.ok(at >= 0 && argv[at + 1] === '=https', `у curl нет --proto =https: ${argv.join(' ')}`)
      assert.ok(argv.includes('--tlsv1.2'), argv.join(' '))
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  })
})

describe('install.sh', () => {
  it('--no-service: ~/.pult по умолчанию, симлинк в ~/.local/bin, pult --version, doctor, подсказка про PATH', async () => {
    const box = makeBox()
    const pultHome = join(box.home, '.pult')
    try {
      const r = await sh(box, ['--from', tgz, '--no-service'])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.equal(readlinkSync(join(pultHome, 'current')), join('versions', '0.0.7'))
      const link = join(box.home, '.local', 'bin', 'pult')
      assert.ok(lstatSync(link).isSymbolicLink())
      // Симлинк — на лаунчер команды, а не на npm-ссылку с `#!/usr/bin/env node`.
      assert.equal(readlinkSync(link), join(pultHome, 'bin', 'pult'))
      assert.match(r.stdout, new RegExp(`pult: .* -> ${join(pultHome, 'bin', 'pult')}`))
      const v = await runProc(link, ['--version'], box.env).done
      assert.equal(v.stdout.trim(), '0.0.7', v.stderr)
      assert.match(r.stdout, /pult doctor · /)
      assert.match(r.stdout, /Активная версия: current → versions\/0\.0\.7: pult 0\.0\.7/)
      assert.match(r.stdout, /нет в PATH — добавь/)
      assert.match(r.stdout, /служба не ставится \(--no-service\)/)
      assert.match(r.stdout, /готово: 0\.0\.7/)
      // Инвариант 8: вне PULT_HOME — только <bin-dir>/pult.
      assert.deepEqual(readdirSync(box.home).sort(), ['.local', '.pult'])
      assert.deepEqual(readdirSync(join(box.home, '.local')), ['bin'])
      assert.deepEqual(readdirSync(join(box.home, '.local', 'bin')), ['pult'])
      // Службы нет и демона до не было — установка демона не оставляет.
      assert.equal((await daemonStatus(box, link, pultHome))['running'], false)
      // Совместимость: прежний симлинк на current/bin/pult (так ставил install.sh до 0.2.21) работает
      // по-прежнему — на системном node из PATH.
      const oldLink = join(box.dir, 'old-pult')
      symlinkSync(join(pultHome, 'current', 'bin', 'pult'), oldLink)
      const old = await runProc(oldLink, ['--version'], box.env).done
      assert.equal(old.stdout.trim(), '0.0.7', old.stderr)
      // Повторный запуск идемпотентен: «уже стоит», симлинк переложен — и прежний на current/bin/pult
      // тоже переводится на лаунчер; удалённый лаунчер «уже стоит» возвращает из активной версии.
      symlinkSync(join(pultHome, 'current', 'bin', 'pult'), `${link}.tmp`)
      renameSync(`${link}.tmp`, link)
      rmSync(join(pultHome, 'bin', 'pult'))
      const again = await sh(box, ['--from', tgz, '--no-service'])
      assert.equal(again.code, 0, again.stderr)
      assert.match(again.stdout, /уже стоит: 0\.0\.7 активна/)
      assert.equal(readlinkSync(link), join(pultHome, 'bin', 'pult'))
      assert.equal(statSync(join(pultHome, 'bin', 'pult')).mode & 0o777, 0o755)
    } finally {
      await teardown(box, pultHome)
    }
  })

  it('со службой на фальшивом launchd: --home, --bin-dir, служба установлена и отвечает демон 0.0.7', async () => {
    const box = makeBox()
    const pultHome = join(box.dir, 'h')
    const binDir = join(box.dir, 'bin')
    Object.assign(box.env, {
      PULT_SERVICE_PLATFORM: 'darwin',
      PULT_SERVICE_DIR: join(box.dir, 'svc'),
      PULT_LAUNCHCTL: join(FAKES, 'fake-launchctl.mjs'),
      PULT_SYSTEMCTL: join(FAKES, 'fake-systemctl.mjs'),
      PULT_LOGINCTL: join(FAKES, 'fake-loginctl.mjs'),
      FAKE_SVC_LOG: join(box.dir, 'fake.jsonl'),
      FAKE_SVC_STATE: join(box.dir, 'fake-state.json'),
      FAKE_SVC_EXTRA_ENV: JSON.stringify({ PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX, PULT_TEST: '1' }),
      PATH: `${binDir}:${box.env['PATH'] ?? ''}`,
    })
    try {
      const r = await sh(box, ['--from', tgz, '--home', pultHome, '--bin-dir', binDir])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stdout, /служба установлена/)
      assert.doesNotMatch(r.stdout, /нет в PATH/)
      assert.match(r.stdout, /PULT_HOME не по умолчанию/)
      assert.ok(existsSync(join(box.dir, 'svc', 'dev.pult.daemon.plist')))
      const st = await daemonStatus(box, join(binDir, 'pult'), pultHome)
      assert.equal(st['running'], true)
      assert.equal(st['version'], '0.0.7')
      assert.equal(st['mode'], 'service')
      assert.deepEqual(readdirSync(box.home), [], 'install.sh записал что-то в HOME')
    } finally {
      await teardown(box, pultHome)
    }
  })

  it('node < 22 и пакет без runtime.env (старше 0.2.18) — код 1 и подсказка, ничего не поставлено', async () => {
    const box = makeBox()
    try {
      const r = await sh(box, ['--from', tgz, '--no-service'], { PATH: oldNodePath(box) })
      assert.equal(r.code, 1)
      assert.match(r.stderr, /системный node v18\.19\.0 старше 22, а в пакете нет runtime\.env/)
      assert.match(r.stderr, /brew install node/)
      assert.deepEqual(readdirSync(box.home), [])
      const noArgs = await sh(box, [])
      assert.equal(noArgs.code, 1)
      assert.match(noArgs.stderr, /нужен --from/)
      const missing = await sh(box, ['--from', join(box.dir, 'нет.tgz')])
      assert.equal(missing.code, 1)
      assert.match(missing.stderr, /нет файла/)
    } finally {
      await teardown(box, join(box.home, '.pult'))
    }
  })
})

describe('install.sh без системного node: свой node Пульта из runtime.env пакета', () => {
  const NODE_VER = '24.99.0'
  const key = platformKey() as PlatformKey
  const name = runtimeName(NODE_VER, key)
  let fake = { tgz: '', sha: '' }
  let pinned = ''

  before(() => {
    fake = fakeNodeTarball(work, NODE_VER, { npm: true })
    pinned = packPult(work, { version: '0.0.8', runtimeEnv: fakePin(NODE_VER, fake.sha) })
  })

  it('node v18 в PATH: свой node в PULT_HOME/runtime, на нём pult update, лаунчер и команда', async () => {
    const box = makeBox({ PULT_TEST_NODE_TARBALL: fake.tgz })
    const pultHome = join(box.home, '.pult')
    box.env['PATH'] = oldNodePath(box)
    try {
      const r = await sh(box, ['--from', pinned, '--no-service'])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stdout, /системный node v18\.19\.0 старше 22 — ставлю свой node Пульта 24\.99\.0/)
      const dir = join(pultHome, 'runtime', name)
      const node = join(dir, 'bin', 'node')
      assert.equal(readFileSync(join(pultHome, 'runtime', 'active'), 'utf8').trim(), node)
      assert.equal(statSync(join(pultHome, 'runtime', 'active')).mode & 0o777, 0o600)
      assert.equal(statSync(join(pultHome, 'runtime')).mode & 0o777, 0o700)
      assert.equal(existsSync(join(dir, 'include')), false, 'include/ не вырезан')
      assert.ok(existsSync(join(dir, 'used')), 'pult update шёл не на своём node')
      assert.deepEqual(readdirSync(join(pultHome, 'runtime')).sort(), ['active', name])
      assert.equal(readlinkSync(join(pultHome, 'current')), join('versions', '0.0.8'))
      // Команда — через лаунчер и без годного системного node в PATH.
      const link = join(box.home, '.local', 'bin', 'pult')
      assert.equal(readlinkSync(link), join(pultHome, 'bin', 'pult'))
      rmSync(join(dir, 'used'))
      const v = await runProc(link, ['--version'], box.env).done
      assert.equal(v.stdout.trim(), '0.0.8', v.stderr)
      assert.ok(existsSync(join(dir, 'used')), 'pult --version шёл не на своём node')
      assert.match(r.stdout, /готово: 0\.0\.8/)
      assert.deepEqual(readdirSync(box.home).sort(), ['.local', '.pult'])
      // Повтор: node уже лежит — не перекачивается и не переставляется. «Уже стоит» до своего node в
      // `pult update` не доходит — пропавший указатель возвращает install.sh.
      rmSync(join(pultHome, 'runtime', 'active'))
      const again = await sh(box, ['--from', pinned, '--no-service'])
      assert.equal(again.code, 0, again.stderr)
      assert.match(again.stdout, /свой node 24\.99\.0 уже лежит/)
      assert.match(again.stdout, /уже стоит: 0\.0\.8 активна/)
      assert.equal(readFileSync(join(pultHome, 'runtime', 'active'), 'utf8').trim(), node)
      // Живой указатель «уже стоит» не трогает, даже если он на другом node.
      writeFileSync(join(pultHome, 'runtime', 'active'), `${process.execPath}\n`)
      const third = await sh(box, ['--from', pinned, '--no-service'])
      assert.equal(third.code, 0, third.stderr)
      assert.equal(readFileSync(join(pultHome, 'runtime', 'active'), 'utf8').trim(), process.execPath)
    } finally {
      await teardown(box, pultHome)
    }
  })

  it('со службой на фальшивом launchd: лаунчер службы поднимает демона своим node', async () => {
    const box = makeBox({ PULT_TEST_NODE_TARBALL: fake.tgz })
    const pultHome = join(box.dir, 'h')
    Object.assign(box.env, {
      PULT_SERVICE_PLATFORM: 'darwin',
      PULT_SERVICE_DIR: join(box.dir, 'svc'),
      PULT_LAUNCHCTL: join(FAKES, 'fake-launchctl.mjs'),
      PULT_SYSTEMCTL: join(FAKES, 'fake-systemctl.mjs'),
      PULT_LOGINCTL: join(FAKES, 'fake-loginctl.mjs'),
      FAKE_SVC_LOG: join(box.dir, 'fake.jsonl'),
      FAKE_SVC_STATE: join(box.dir, 'fake-state.json'),
      FAKE_SVC_EXTRA_ENV: JSON.stringify({ PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX, PULT_TEST: '1' }),
    })
    const used = join(pultHome, 'runtime', name, 'used')
    try {
      // Свой node — на машине «без node» (v18 в PATH); служба — отдельной командой: фальшивые менеджеры
      // служб — node-скрипты, и им настоящий node в PATH нужен.
      const first = await sh(box, ['--from', pinned, '--home', pultHome, '--no-service'], { PATH: oldNodePath(box) })
      assert.equal(first.code, 0, first.stderr + first.stdout)
      rmSync(used, { force: true })
      const link = join(box.home, '.local', 'bin', 'pult')
      const r = await runProc(link, ['daemon', 'install'], { ...box.env, PULT_HOME: pultHome }).done
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stdout, /служба установлена/)
      const st = await daemonStatus(box, link, pultHome)
      assert.equal(st['running'], true)
      assert.equal(st['mode'], 'service')
      assert.ok(existsSync(used), 'служба подняла демона не своим node')
    } finally {
      await teardown(box, pultHome)
    }
  })

  it('node нет в PATH вовсе — то же самое', async (t) => {
    if (existsSync('/usr/bin/node') || existsSync('/bin/node')) { t.skip('на машине node в /usr/bin — PATH без node не собрать'); return }
    const box = makeBox({ PULT_TEST_NODE_TARBALL: fake.tgz, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
    const pultHome = join(box.home, '.pult')
    try {
      const r = await sh(box, ['--from', pinned, '--no-service'])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.match(r.stdout, /node не найден в PATH — ставлю свой node Пульта/)
      const v = await runProc(join(box.home, '.local', 'bin', 'pult'), ['--version'], box.env).done
      assert.equal(v.stdout.trim(), '0.0.8', v.stderr)
    } finally {
      await teardown(box, pultHome)
    }
  })

  it('провал пробы: откат возвращает указатель прежнего node — install.sh его до pult update не пишет', async () => {
    const box = makeBox({ PULT_TEST_NODE_TARBALL: fake.tgz })
    const pultHome = join(box.home, '.pult')
    box.env['PATH'] = oldNodePath(box)
    try {
      assert.equal((await sh(box, ['--from', pinned, '--no-service'])).code, 0)
      const before = readFileSync(join(pultHome, 'runtime', 'active'), 'utf8').trim()
      // Сломанная версия на ДРУГОМ node: install.sh раскладывает его, pult update переставляет указатель
      // и на откате возвращает прежний.
      const other = fakeNodeTarball(work, '24.98.0', { npm: true })
      const broken = packPult(work, { version: '0.0.10', daemonMain: BROKEN_DAEMON, runtimeEnv: fakePin('24.98.0', other.sha) })
      const r = await sh(box, ['--from', broken, '--no-service'], { PULT_TEST_NODE_TARBALL: other.tgz })
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stderr, /не прошла пробу/)
      assert.equal(readFileSync(join(pultHome, 'runtime', 'active'), 'utf8').trim(), before)
      assert.equal(readlinkSync(join(pultHome, 'current')), join('versions', '0.0.8'))
    } finally {
      await teardown(box, pultHome)
    }
  })

  it('пакет 0.2.18–0.2.21 (runtime.env есть, лаунчера команды нет) без системного node — отказ до установки', async () => {
    const old = packPult(work, { version: '0.0.11', runtimeEnv: fakePin(NODE_VER, fake.sha), noCliLauncher: true })
    const box = makeBox({ PULT_TEST_NODE_TARBALL: fake.tgz })
    box.env['PATH'] = oldNodePath(box)
    try {
      const r = await sh(box, ['--from', old, '--no-service'])
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stderr, /команде pult нужен системный node \(лаунчер service\/pult — с 0\.2\.22\)/)
      assert.match(r.stderr, /brew install node/)
      assert.deepEqual(readdirSync(box.home), [])
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  })

  it('runtime.env разбирается так же строго, как parsePin: x.y.z, KEY=VALUE, 64 hex, последний повтор', async () => {
    const box = makeBox({ PULT_TEST_NODE_TARBALL: fake.tgz })
    box.env['PATH'] = oldNodePath(box)
    const k = key.replace('-', '_').toUpperCase()
    try {
      const cases: Array<[string, RegExp]> = [
        [`PULT_NODE_VERSION=24.1\nPULT_NODE_SHA256_${k}=${fake.sha}\n`, /runtime\.env:1: версия node «24\.1» — не x\.y\.z/],
        [`PULT_NODE_VERSION=${NODE_VER}\nмусор\n`, /runtime\.env:2: не KEY=VALUE — «мусор»/],
        [`PULT_NODE_VERSION=${NODE_VER}\nPULT_NODE_SHA256_LINUX_ARM64=abc\n`, /runtime\.env:2: sha256 в PULT_NODE_SHA256_LINUX_ARM64 — не 64 hex/],
        [`# только комментарий\nPULT_NODE_SHA256_${k}=${fake.sha}\n`, /runtime\.env: нет PULT_NODE_VERSION/],
      ]
      for (const [pin, want] of cases) {
        const tb = packPult(work, { version: '0.0.12', runtimeEnv: pin })
        const r = await sh(box, ['--from', tb, '--no-service'])
        assert.equal(r.code, 1, `${pin}: ${r.stdout}`)
        assert.match(r.stderr, want)
      }
      // Повтор ключа — побеждает последний, пробелы и CRLF обрезаются, незнакомые ключи пропускаются:
      // сумма из пина сходится с тарболом только у последней строки версии.
      const tb = packPult(work, {
        version: '0.0.12',
        runtimeEnv: `PULT_NODE_VERSION=1.2.3\r\n  PULT_NODE_VERSION=${NODE_VER}  \r\nPULT_FUTURE_KEY=x\r\nPULT_NODE_SHA256_${k}=${'0'.repeat(64)}\r\nPULT_NODE_SHA256_${k}=${fake.sha}\r\n`,
      })
      const r = await sh(box, ['--from', tb, '--no-service'])
      assert.equal(r.code, 0, r.stderr + r.stdout)
      assert.ok(existsSync(join(box.home, '.pult', 'runtime', name, 'bin', 'node')))
    } finally {
      await teardown(box, join(box.home, '.pult'))
    }
  })

  it('сумма не совпала с runtime.env — код 1, node не разложен, указателя нет', async () => {
    const bad = packPult(work, { version: '0.0.9', runtimeEnv: fakePin(NODE_VER, '0'.repeat(64)) })
    const box = makeBox({ PULT_TEST_NODE_TARBALL: fake.tgz })
    box.env['PATH'] = oldNodePath(box)
    try {
      const r = await sh(box, ['--from', bad, '--no-service'])
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stderr, /sha256 [0-9a-f]{64} не совпадает с runtime\.env/)
      assert.deepEqual(readdirSync(join(box.home, '.pult', 'runtime')), [])
      assert.equal(existsSync(join(box.home, '.pult', 'current')), false)
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  })

  it('PULT_TEST=1 без PULT_TEST_NODE_TARBALL — в сеть не идёт, код 1', async () => {
    const box = makeBox()
    box.env['PATH'] = oldNodePath(box)
    try {
      const r = await sh(box, ['--from', pinned, '--no-service'])
      assert.equal(r.code, 1, r.stdout)
      assert.match(r.stderr, /сеть в тестах не трогается — нужен PULT_TEST_NODE_TARBALL/)
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  })

  it('зеркало: только https; curl — с --proto =https и --tlsv1.2, адрес nodejs.org-формы', async () => {
    // Без PULT_TEST: до настоящей сети не доходит — фальшивый curl пишет argv и отвечает ошибкой.
    const box = makeBox({ PULT_TEST: '' })
    const bin = join(box.dir, 'fake-bin')
    mkdirSync(bin, { recursive: true })
    const log = join(box.dir, 'curl-argv')
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexit 22\n`, { mode: 0o755 })
    box.env['PATH'] = `${bin}:${oldNodePath(box)}`
    try {
      const http = await sh(box, ['--from', pinned, '--no-service'], { PULT_NODE_MIRROR: 'http://mirror.invalid/dist' })
      assert.equal(http.code, 1, http.stdout)
      assert.match(http.stderr, /PULT_NODE_MIRROR=http:\/\/mirror\.invalid\/dist: только https/)
      assert.equal(existsSync(log), false, 'curl вызван для http-зеркала')

      const https = await sh(box, ['--from', pinned, '--no-service'], { PULT_NODE_MIRROR: 'https://mirror.invalid/dist/' })
      assert.equal(https.code, 1, https.stdout)
      const url = `https://mirror.invalid/dist/v${NODE_VER}/${name}.tar.gz`
      assert.match(https.stderr, new RegExp(`не скачался: ${url.replace(/[.]/g, '\\.')}`))
      const argv = readFileSync(log, 'utf8').split('\n')
      const at = argv.indexOf('--proto')
      assert.ok(at >= 0 && argv[at + 1] === '=https', argv.join(' '))
      assert.ok(argv.includes('--tlsv1.2'), argv.join(' '))
      assert.ok(argv.includes(url), argv.join(' '))
    } finally {
      rmSync(box.dir, { recursive: true, force: true })
    }
  })
})
