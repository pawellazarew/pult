// Свой node Пульта (src/update/runtime.ts, 0.2.18): пин, установка из тарбола со сверкой суммы,
// указатель runtime/active, уборка, лаунчер службы и пункт доктора про node демона.
//
// Сеть не трогается никогда: «node» — sh-скрипт в тарболе, собранном тут же. На `-v` он отвечает
// версией пина, на остальное — exec настоящего node этого теста.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { daemonNodeItem } from '../dist/env/doctor.js'
import { daemonNode, daemonNodeInfo, fileId, readActiveRuntime } from '../dist/env/nodeBin.js'
import {
  ensureRuntime, mirrorOf, parsePin, platformKey, pruneRuntimes, readPin, runtimeName, RuntimeError,
} from '../dist/update/runtime.js'
import type { PlatformKey, RuntimePin } from '../dist/update/runtime.js'
import { CLI, fakeNodeTarball, ROOT, runProc } from './pack-helpers.js'

// Страховка: даже вызов ensureRuntime с `env: {}` не уходит в сеть (runtime.ts fetchTarball).
process.env['PULT_TEST'] = '1'

const LAUNCH = fileURLToPath(new URL('../service/pultd-launch', import.meta.url))
const KEY = platformKey() as PlatformKey

const pinFor = (version: string, sha: string): RuntimePin => ({ version, sha256: { [KEY]: sha } })

describe('runtime.env: пин', () => {
  it('настоящий runtime.env пакета разбирается: версия x.y.z и суммы всех четырёх платформ', () => {
    const pin = readPin(ROOT)
    assert.ok(pin)
    assert.match(pin.version, /^\d+\.\d+\.\d+$/)
    assert.deepEqual(Object.keys(pin.sha256).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
    for (const s of Object.values(pin.sha256)) assert.match(s, /^[0-9a-f]{64}$/)
  })

  it('комментарии и пустые строки пропускаются, незнакомые ключи и платформы — тоже', () => {
    const pin = parsePin(['# x', '', 'PULT_NODE_VERSION=24.1.2', `PULT_NODE_SHA256_DARWIN_ARM64=${'a'.repeat(64)}`,
      `PULT_NODE_SHA256_WIN_X64=${'b'.repeat(64)}`, 'OTHER=1'].join('\n'))
    assert.deepEqual(pin, { version: '24.1.2', sha256: { 'darwin-arm64': 'a'.repeat(64) } })
  })

  it('кривое — ошибка, а не тихий «не тот node»: нет версии, версия не x.y.z, сумма не hex, строка не KEY=VALUE', () => {
    assert.throws(() => parsePin(''), RuntimeError)
    assert.throws(() => parsePin('PULT_NODE_VERSION=24'), /не x\.y\.z/)
    assert.throws(() => parsePin(`PULT_NODE_VERSION=24.1.2\nPULT_NODE_SHA256_LINUX_X64=${'z'.repeat(64)}`), /64 hex/)
    assert.throws(() => parsePin('просто строка'), /не KEY=VALUE/)
  })

  it('пакета без runtime.env (версия старше 0.2.18) — null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rp-'))
    try { assert.equal(readPin(dir), null) } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('платформы: четыре поддержаны, остальное — null', () => {
    assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64')
    assert.equal(platformKey('linux', 'x64'), 'linux-x64')
    assert.equal(platformKey('win32', 'x64'), null)
    assert.equal(platformKey('linux', 'ia32'), null)
  })

  it('зеркало: по умолчанию nodejs.org, своё — только https', () => {
    assert.equal(mirrorOf({}), 'https://nodejs.org/dist')
    assert.equal(mirrorOf({ PULT_NODE_MIRROR: 'https://m.example/node/' }), 'https://m.example/node')
    assert.throws(() => mirrorOf({ PULT_NODE_MIRROR: 'http://m.example' }), /только https/)
  })
})

describe('ensureRuntime', () => {
  let work = ''
  let paths: PultPaths
  before(() => { work = mkdtempSync(join(tmpdir(), 'rt-')) })
  after(() => { rmSync(work, { recursive: true, force: true }) })
  const freshHome = (): PultPaths => layout(mkdtempSync(join(work, 'h-')))

  it('из тарбола: сумма → распаковка → node -v → каталог и указатель; повтор — без тарбола', () => {
    paths = freshHome()
    const { tgz, sha } = fakeNodeTarball(work, '24.21.0')
    const r = ensureRuntime(paths, pinFor('24.21.0', sha), { from: tgz })
    const node = join(paths.runtime, runtimeName('24.21.0', KEY), 'bin', 'node')
    assert.deepEqual(r, { node, name: runtimeName('24.21.0', KEY), version: '24.21.0', fetched: true })
    assert.equal(readFileSync(paths.runtimeActive, 'utf8'), `${node}\n`)
    assert.equal(readActiveRuntime(paths.runtimeActive), node)
    assert.ok(!existsSync(join(paths.runtime, runtimeName('24.21.0', KEY), 'include')), 'заголовки C не вырезаны')
    // Следов распаковки нет.
    assert.deepEqual(readdirSync(paths.runtime).sort(), ['active', runtimeName('24.21.0', KEY)])
    // Уже стоит — тарбол не нужен вовсе (ни сети, ни from).
    const again = ensureRuntime(paths, pinFor('24.21.0', sha), { env: { PULT_TEST: '1' } })
    assert.equal(again.fetched, false)
  })

  it('сумма не совпала — отказ: ни каталога, ни указателя, ни следов', () => {
    const p = freshHome()
    const { tgz } = fakeNodeTarball(work, '24.21.0')
    assert.throws(() => ensureRuntime(p, pinFor('24.21.0', 'f'.repeat(64)), { from: tgz }), /sha256 .* не совпадает/)
    assert.ok(!existsSync(p.runtimeActive))
    assert.deepEqual(readdirSync(p.runtime), [])
  })

  it('node в тарболе отвечает не той версией — отказ, прежний указатель цел', () => {
    const p = freshHome()
    const good = fakeNodeTarball(work, '24.21.0')
    ensureRuntime(p, pinFor('24.21.0', good.sha), { from: good.tgz })
    const before = readFileSync(p.runtimeActive, 'utf8')
    const liar = fakeNodeTarball(work, '24.22.0', { answers: 'v18.0.0' })
    assert.throws(() => ensureRuntime(p, pinFor('24.22.0', liar.sha), { from: liar.tgz }), /ответил: v18\.0\.0/)
    assert.equal(readFileSync(p.runtimeActive, 'utf8'), before)
    assert.ok(!existsSync(join(p.runtime, runtimeName('24.22.0', KEY))))
  })

  it('PULT_TEST=1: сеть не трогается — без PULT_TEST_NODE_TARBALL отказ, с ним — «скачивание» из файла', () => {
    const p = freshHome()
    const { tgz, sha } = fakeNodeTarball(work, '24.21.0')
    assert.throws(() => ensureRuntime(p, pinFor('24.21.0', sha), { env: { PULT_TEST: '1' } }), /сеть в тестах не трогается/)
    const said: string[] = []
    const r = ensureRuntime(p, pinFor('24.21.0', sha), { env: { PULT_TEST: '1', PULT_TEST_NODE_TARBALL: tgz }, progress: (s) => said.push(s) })
    assert.equal(r.fetched, true)
    assert.match(said.join('\n'), new RegExp(`https://nodejs\\.org/dist/v24\\.21\\.0/${runtimeName('24.21.0', KEY)}\\.tar\\.gz`))
  })

  it('платформа без пина или неподдержанная — отказ с объяснением', () => {
    const p = freshHome()
    assert.throws(() => ensureRuntime(p, { version: '24.21.0', sha256: {} }), /нет суммы/)
    assert.throws(() => ensureRuntime(p, pinFor('24.21.0', 'a'.repeat(64)), { platform: 'win32', arch: 'x64' }), /под win32-x64 нет/)
  })

  it('уборка: остаются нужные пакетам и тот, на который смотрит указатель; следы и лишние — прочь', () => {
    const p = freshHome()
    const a = fakeNodeTarball(work, '24.20.0')
    const b = fakeNodeTarball(work, '24.21.0')
    ensureRuntime(p, pinFor('24.20.0', a.sha), { from: a.tgz })
    ensureRuntime(p, pinFor('24.21.0', b.sha), { from: b.tgz })
    mkdirSync(join(p.runtime, `${runtimeName('24.19.0', KEY)}.partial-123`))
    mkdirSync(join(p.runtime, runtimeName('1.0.0', KEY)))
    const removed = pruneRuntimes(p, new Set([runtimeName('24.20.0', KEY)])).sort()
    assert.deepEqual(removed, [`${runtimeName('24.19.0', KEY)}.partial-123`, runtimeName('1.0.0', KEY)].sort())
    assert.ok(existsSync(join(p.runtime, runtimeName('24.20.0', KEY))), 'нужный пакету удалён')
    assert.ok(existsSync(join(p.runtime, runtimeName('24.21.0', KEY))), 'активный удалён')
  })
})

describe('node демона: выбор и отчёт', () => {
  let work = ''
  before(() => { work = mkdtempSync(join(tmpdir(), 'rn-')) })
  after(() => { rmSync(work, { recursive: true, force: true }) })

  it('daemonNode: живой указатель под эту машину — свой node; нет, мёртвый или чужая платформа — запасной', () => {
    const active = join(work, 'active')
    assert.equal(daemonNode(active, '/fallback/node'), '/fallback/node')
    writeFileSync(active, `${join(work, 'нет-такого')}\n`)
    assert.equal(daemonNode(active, '/fallback/node'), '/fallback/node')
    const mine = join(work, 'runtime', `node-v24.21.0-${process.platform}-${process.arch}`, 'bin', 'node')
    const alien = join(work, 'runtime', 'node-v24.21.0-sunos-sparc', 'bin', 'node')
    for (const n of [mine, alien]) {
      mkdirSync(join(n, '..'), { recursive: true })
      writeFileSync(n, '#!/bin/sh\n')
      chmodSync(n, 0o755)
    }
    writeFileSync(active, `${mine}\n`)
    assert.equal(daemonNode(active, '/fallback/node'), mine)
    // PULT_HOME, перенесённый с другой архитектуры: «Bad CPU type» вместо демона — нет, запасной.
    writeFileSync(active, `${alien}\n`)
    assert.equal(daemonNode(active, '/fallback/node'), '/fallback/node')
  })

  it('daemonNodeInfo: свой — под runtime, удалённый — alive false', () => {
    const rt = join(work, 'runtime')
    mkdirSync(join(rt, 'node-v1', 'bin'), { recursive: true })
    const own = join(rt, 'node-v1', 'bin', 'node')
    writeFileSync(own, '')
    assert.deepEqual(daemonNodeInfo(rt, own, 'v1.0.0'), { path: own, version: 'v1.0.0', alive: true, own: true })
    // Новая версия по ТОМУ ЖЕ пути (установщик nodejs.org, apt): путь есть, а бинарь процесса — другой.
    // Живой демон держит свой бинарь открытым, поэтому старый inode занят и новый файл получает другой.
    // Открытый дескриптор здесь — ровно это: без него ext4 на Linux тут же отдаёт освобождённый inode
    // новому файлу, и «другой бинарь» в тесте совпадал бы с прежним по dev+ino.
    const startedAs = fileId(own)
    const held = openSync(own, 'r')
    try {
      rmSync(own)
      writeFileSync(own, '')
      assert.equal(daemonNodeInfo(rt, own, 'v1.0.0', startedAs).alive, false)
      assert.equal(daemonNodeInfo(rt, own, 'v1.0.0', fileId(own)).alive, true)
    } finally { closeSync(held) }
    assert.deepEqual(daemonNodeInfo(rt, '/opt/homebrew/Cellar/node/26.11.0/bin/node', 'v26.11.0'),
      { path: '/opt/homebrew/Cellar/node/26.11.0/bin/node', version: 'v26.11.0', alive: false, own: false })
  })

  it('doctor: удалённый node — fail с командой перезапуска; системный — warn; свой — ok', () => {
    const dead = daemonNodeItem({ path: '/x/node', version: 'v26.11.0', alive: false, own: false })
    assert.equal(dead.status, 'fail')
    assert.match(dead.detail, /удалён или заменён .*Desktop/)
    assert.equal(dead.fixCmd, 'pult daemon stop && pult daemon start')
    assert.equal(daemonNodeItem({ path: '/x/node', version: 'v26.11.1', alive: true, own: false }).status, 'warn')
    assert.equal(daemonNodeItem({ path: '/x/node', version: 'v24.21.0', alive: true, own: true }).status, 'ok')
  })
})

describe('pultd-launch: свой node Пульта', () => {
  let tmp = ''
  let pultHome = ''
  let entry = ''
  let shellStub = ''
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rl-'))
    pultHome = join(tmp, 'home', '.pult')
    mkdirSync(join(pultHome, 'runtime'), { recursive: true })
    mkdirSync(join(pultHome, 'logs'), { recursive: true })
    entry = join(tmp, 'entry.mjs')
    writeFileSync(entry, '')
    shellStub = join(tmp, 'login-shell')
    writeFileSync(shellStub, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(process.execPath)}\n`)
    chmodSync(shellStub, 0o755)
  })
  after(() => { rmSync(tmp, { recursive: true, force: true }) })

  function launch(): { code: number | null; stderr: string; dry: Record<string, unknown> } {
    const r = spawnSync('/bin/sh', [LAUNCH], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { HOME: join(tmp, 'home'), SHELL: shellStub, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PULT_HOME: pultHome, PULT_ENTRY: entry, PULT_DRY_RUN: '1' },
    })
    return { code: r.status, stderr: r.stderr ?? '', dry: JSON.parse((r.stdout ?? '').trim()) as Record<string, unknown> }
  }

  it('годный указатель — свой node первым, node-path не трогается', () => {
    const own = join(pultHome, 'runtime', 'node-v24.21.0-x', 'bin', 'node')
    mkdirSync(join(own, '..'), { recursive: true })
    writeFileSync(own, '#!/bin/sh\n[ "$1" = "-v" ] && echo v24.21.0 && exit 0\nexit 1\n')
    chmodSync(own, 0o755)
    writeFileSync(join(pultHome, 'runtime', 'active'), `${own}\n`)
    const r = launch()
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.dry['node'], own)
    assert.equal(r.dry['own'], true)
    assert.match(r.stderr, /свой node Пульта: /)
    assert.ok(!existsSync(join(pultHome, 'node-path')), 'свой node записан в node-path — кэш системного')
  })

  it('указатель на старый node — системный, с внятной строкой в журнале службы', () => {
    const old = join(tmp, 'old-node')
    writeFileSync(old, '#!/bin/sh\n[ "$1" = "-v" ] && echo v18.20.0 && exit 0\nexit 1\n')
    chmodSync(old, 0o755)
    writeFileSync(join(pultHome, 'runtime', 'active'), `${old}\n`)
    const r = launch()
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.dry['node'], process.execPath)
    assert.equal(r.dry['own'], false)
    assert.match(r.stderr, /свой node Пульта негоден: .*old-node — беру системный/)
    assert.equal(readFileSync(join(pultHome, 'node-path'), 'utf8').trim(), process.execPath)
  })
})

describe('pult runtime (CLI)', () => {
  let tmp = ''
  let env: Record<string, string> = {}
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rc-'))
    env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: join(tmp, 'home'), PULT_HOME: join(tmp, 'p'), PULT_TEST: '1' }
    mkdirSync(env['HOME'] as string, { recursive: true })
  })
  after(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('install --from чужого тарбола: сумма пакета не совпала — код 1, указателя нет', async () => {
    const { tgz } = fakeNodeTarball(tmp, readPin(ROOT)?.version ?? '0.0.0')
    const r = await runProc(process.execPath, [CLI, 'runtime', 'install', '--from', tgz], env).done
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stderr, /sha256 .* не совпадает/)
    assert.ok(!existsSync(join(env['PULT_HOME'] as string, 'runtime', 'active')))
  })

  it('--json: пин пакета, указателя нет, демона нет', async () => {
    const r = await runProc(process.execPath, [CLI, 'runtime', '--json'], env).done
    assert.equal(r.code, 0, r.stderr)
    const j = JSON.parse(r.stdout) as { pinned: string; active: string | null; daemon: unknown }
    assert.equal(j.pinned, readPin(ROOT)?.version)
    assert.equal(j.active, null)
    assert.equal(j.daemon, null)
  })
})
