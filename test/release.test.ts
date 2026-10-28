// Инструменты релиза (M8c): scripts/release-keygen.mjs и сухой прогон scripts/release.mjs.
// Всё — во временных папках: HOME подменён, настоящий ~/.config/pult-release не трогается; `gh` в PATH —
// заглушка, которая оставила бы след, если бы её позвали.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { WINDOW_MIN_VERSION } from '../dist/core/version.js'
import { keyIdOf, rawPublicKey, verifyEnvelope } from '../dist/update/manifest.js'
import { NODE_DIR, ROOT } from './pack-helpers.js'

const KEYGEN = join(ROOT, 'scripts', 'release-keygen.mjs')
const RELEASE = join(ROOT, 'scripts', 'release.mjs')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const SHELL_VERSION = (JSON.parse(readFileSync(join(ROOT, 'shell', 'package.json'), 'utf8')) as { version: string }).version

// 0.3.16: один номер на пакет и окно. Дешёвая сверка в гейте: разъехались — релиз откажет, а окно и пакет в плашке
// показывали бы два номера.
describe('один номер: пакет и окно', () => {
  it('shell/package.json и package.json — одна версия (и в lock-файлах)', () => {
    assert.equal(SHELL_VERSION, VERSION, `окно ${SHELL_VERSION}, пакет ${VERSION} — подними обе версии вместе`)
    const lock = (f: string): string => (JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as { version: string }).version
    assert.equal(lock('package-lock.json'), VERSION)
    assert.equal(lock(join('shell', 'package-lock.json')), VERSION)
  })
})

/** Info.plist окна с номером версии. */
const plistOf = (v: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>\n`

/** Минимальный zip (без сжатия) с одним файлом — `unzip -p` его читает на macOS и Linux. */
function storedZip(name: string, text: string): Buffer {
  const data = Buffer.from(text, 'utf8')
  const n = Buffer.from(name, 'utf8')
  const crc = zlib.crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28)
  const cdOff = local.length + n.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(cdOff, 16)
  return Buffer.concat([local, n, data, central, n, end])
}

let dir = ''
let env: Record<string, string> = {}
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pr-'))
  mkdirSync(join(dir, 'home'))
  mkdirSync(join(dir, 'bin'))
  // Заглушка gh: сухой прогон не должен её звать НИКОГДА.
  writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(dir, 'gh-called'))}\n`)
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
  env = {
    PATH: `${join(dir, 'bin')}:${NODE_DIR}:/usr/bin:/bin`,
    HOME: join(dir, 'home'),
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
  }
})
after(() => { rmSync(dir, { recursive: true, force: true }) })

const node = (script: string, args: string[], extra: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } => {
  const r = spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 180_000, cwd: dir })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('release-keygen.mjs', () => {
  it('ключ в ~/.config/pult-release (каталог 700, файл 600); на экран — только открытый ключ и keyId', () => {
    const r = node(KEYGEN, [])
    assert.equal(r.code, 0, r.stderr)
    const file = join(dir, 'home', '.config', 'pult-release', 'ed25519.pem')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, 'home', '.config', 'pult-release')).mode & 0o777, 0o700)
    const pem = readFileSync(file, 'utf8')
    assert.match(pem, /^-----BEGIN PRIVATE KEY-----/)
    // Ни заголовка закрытого ключа, ни его тела на экране — ни в stdout, ни в stderr.
    const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
    for (const s of [r.stdout, r.stderr]) {
      assert.doesNotMatch(s, /PRIVATE KEY/)
      assert.ok(!s.replace(/\s+/g, '').includes(body.slice(-40)), 'тело закрытого ключа на экране')
    }
    const pub = /открытый ключ \(base64\): (\S+)/.exec(r.stdout)?.[1] ?? ''
    const id = /keyId: ([0-9a-f]{8})/.exec(r.stdout)?.[1] ?? ''
    assert.equal(keyIdOf(rawPublicKey(pub)), id)
    assert.match(r.stdout, /сохрани ~\/\.config\/pult-release\/ed25519\.pem в менеджер паролей/)
    assert.match(r.stdout, new RegExp(`\\{ id: '${id}', publicKey: '${pub.replace(/[+/]/g, '\\$&')}' \\}`))
  })

  it('ключ уже есть — отказ, файл не тронут', () => {
    const file = join(dir, 'home', '.config', 'pult-release', 'ed25519.pem')
    const before = readFileSync(file)
    const r = node(KEYGEN, [])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /уже есть — не перезаписываю/)
    assert.deepEqual(readFileSync(file), before)
  })
})

describe('release.mjs: сухой прогон', () => {
  let key = ''
  let pub = ''
  before(() => {
    key = join(dir, 'k', 'test.pem')
    const r = node(KEYGEN, ['--out', key])
    assert.equal(r.code, 0, r.stderr)
    pub = /открытый ключ \(base64\): (\S+)/.exec(r.stdout)?.[1] ?? ''
  })

  it('собирает релиз, latest.json проверяется тестовым ключом, gh не зовётся', () => {
    const out = join(dir, 'out')
    const r = node(RELEASE, [VERSION, '--skip-checks', '--no-app', '--out', out, '--key', key, '--trust', pub])
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.deepEqual(readdirSync(out).sort(), ['install.sh', 'latest.json', `pult-${VERSION}.tgz`, 'pult.tgz'])
    assert.deepEqual(readFileSync(join(out, 'pult.tgz')), readFileSync(join(out, `pult-${VERSION}.tgz`)))
    assert.deepEqual(readFileSync(join(out, 'install.sh')), readFileSync(join(ROOT, 'install.sh')))

    const m = verifyEnvelope(readFileSync(join(out, 'latest.json')), [{ id: keyIdOf(rawPublicKey(pub)), publicKey: pub }])
    assert.equal(m.version, VERSION)
    const tgz = readFileSync(join(out, `pult-${VERSION}.tgz`))
    assert.equal(m.package.sha256, createHash('sha256').update(tgz).digest('hex'))
    assert.equal(m.package.size, tgz.length)
    assert.equal(m.package.url, `https://github.com/pawellazarew/pult/releases/download/v${VERSION}/pult-${VERSION}.tgz`)
    assert.equal(m.notes, `https://github.com/pawellazarew/pult/releases/tag/v${VERSION}`)
    // Окно — тем же номером, что пакет; minVersion заморожен для Пультов старше 0.3.16.
    assert.deepEqual(m.app, { version: VERSION, minVersion: WINDOW_MIN_VERSION })

    assert.match(r.stdout, new RegExp(`gh release create v${VERSION.replace(/\./g, '\\.')} --repo pawellazarew/pult --target [0-9a-f]{40} .*--draft`))
    assert.match(r.stdout, /gh release edit v[\d.]+ --repo pawellazarew\/pult --draft=false --latest/)
    assert.equal(existsSync(join(dir, 'gh-called')), false, 'сухой прогон позвал gh')
  })

  it('окно: Pult-<v>-arm64.zip и те же байты под постоянным именем Pult-arm64.zip; в манифесте — имя с версией', () => {
    const out = join(dir, 'out-app')
    const zip = join(dir, 'fake-app.zip')
    // Настоящий zip с одним Info.plist: release.mjs сверяет CFBundleShortVersionString окна с версией релиза.
    writeFileSync(zip, storedZip('Pult.app/Contents/Info.plist', plistOf(VERSION)))
    const r = node(RELEASE, [VERSION, '--skip-checks', '--app-zip', zip, '--out', out, '--key', key, '--trust', pub])
    assert.equal(r.code, 0, r.stderr + r.stdout)
    const versioned = `Pult-${VERSION}-arm64.zip`
    assert.deepEqual(readdirSync(out).sort(), ['Pult-arm64.zip', versioned, 'install.sh', 'latest.json', `pult-${VERSION}.tgz`, 'pult.tgz'].sort())
    assert.deepEqual(readFileSync(join(out, 'Pult-arm64.zip')), readFileSync(zip))
    assert.deepEqual(readFileSync(join(out, versioned)), readFileSync(zip))
    const m = verifyEnvelope(readFileSync(join(out, 'latest.json')), [{ id: keyIdOf(rawPublicKey(pub)), publicKey: pub }])
    assert.deepEqual(m.app?.['darwin-arm64'], {
      url: `https://github.com/pawellazarew/pult/releases/download/v${VERSION}/${versioned}`,
      sha256: createHash('sha256').update(readFileSync(zip)).digest('hex'),
      size: statSync(zip).size,
    })
    assert.match(r.stdout, /Pult-arm64\.zip/)
    // Готовый zip — только для репетиции: публикуется окно, собранное этим прогоном.
    assert.match(node(RELEASE, [VERSION, '--publish', '--app-zip', zip]).stderr, /--app-zip с --publish нельзя/)
    assert.match(node(RELEASE, [VERSION, '--skip-checks', '--no-app', '--app-zip', zip, '--key', key]).stderr, /--no-app и --app-zip вместе не бывают/)
    // Ревью: окно другой версии в zip — отказ (каждый Пульт отверг бы такую замену).
    const old = join(dir, 'old-app.zip')
    writeFileSync(old, storedZip('Pult.app/Contents/Info.plist', plistOf('0.1.21')))
    const bad = node(RELEASE, [VERSION, '--skip-checks', '--app-zip', old, '--out', join(dir, 'out-old'), '--key', key, '--trust', pub])
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, new RegExp(`окно 0\\.1\\.21, а релиз ${VERSION.replace(/\./g, '\\.')} — у окна тот же номер, что у пакета`))
    // Релиз без окна не публикуется: окно обновляется той же кнопкой, что пакет.
    assert.match(node(RELEASE, [VERSION, '--publish', '--no-app']).stderr, /--no-app с --publish нельзя/)
    assert.equal(m.app?.version, m.version)
    assert.equal(existsSync(join(dir, 'gh-called')), false)
  })

  it('ключ подписи не из доверенных сборки (keys.ts пуст, без --trust) — отказ', () => {
    const r = node(RELEASE, [VERSION, '--skip-checks', '--no-app', '--out', join(dir, 'out2'), '--key', key])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /не из доверенных этой сборки/)
  })

  it('отказы до сборки: не та версия, --publish с --skip-checks или --trust, открытый всем ключ', () => {
    const wrong = node(RELEASE, ['9.9.9', '--skip-checks', '--no-app', '--out', join(dir, 'out3'), '--key', key])
    assert.equal(wrong.code, 1)
    assert.match(wrong.stderr, /в package\.json .*, а релиз 9\.9\.9/)
    const pre = node(RELEASE, ['1.0.0-rc.1', '--key', key])
    assert.match(pre.stderr, /пререлизы каналом не ходят/)
    assert.match(node(RELEASE, [VERSION, '--publish', '--skip-checks']).stderr, /--skip-checks с --publish нельзя/)
    assert.match(node(RELEASE, [VERSION, '--publish', '--trust', pub]).stderr, /--trust с --publish нельзя/)
    chmodSync(key, 0o644)
    try {
      const open = node(RELEASE, [VERSION, '--skip-checks', '--no-app', '--out', join(dir, 'out4'), '--key', key, '--trust', pub])
      assert.equal(open.code, 1)
      assert.match(open.stderr, /доступен не только тебе \(644\)/)
    } finally {
      chmodSync(key, 0o600)
    }
    assert.equal(existsSync(join(dir, 'gh-called')), false)
  })
})

describe('release-keygen.mjs: чужой каталог', () => {
  it('каталог уже есть и открыт на запись всем — отказ одной строкой, без стека; права каталога не тронуты', () => {
    const open = join(dir, 'open-dir')
    mkdirSync(open)
    chmodSync(open, 0o777)
    const r = node(KEYGEN, ['--out', join(open, 'k.pem')])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /доступен на запись группе или всем \(777\)/)
    assert.equal(r.stderr.trim().split('\n').length, 1)
    assert.doesNotMatch(r.stderr, /\n\s+at /)
    assert.equal(statSync(open).mode & 0o777, 0o777)
    assert.equal(existsSync(join(open, 'k.pem')), false)
  })
})

describe('release.mjs: проверки git до гейта (временный репозиторий с origin)', () => {
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return (r.stdout ?? '').trim()
  }
  let repo = ''
  let key = ''
  let keyId = ''
  // `--publish` — с окном (без него отказ раньше проверок git); дальше гейта, где окно собиралось бы, прогон не доходит.
  const rel = (...extra: string[]): { code: number | null; stdout: string; stderr: string } =>
    node(join(repo, 'scripts', 'release.mjs'), ['0.0.5', '--key', key, ...(extra.includes('--publish') ? [] : ['--no-app']), ...extra])
  /** Переписать keys.ts и передвинуть на этот коммит тег прошлого релиза v0.0.4. */
  const retagPrev = (text: string): void => {
    writeFileSync(join(repo, 'src', 'update', 'keys.ts'), text)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'keys')
    git(repo, 'tag', '-f', 'v0.0.4')
    git(repo, 'push', '-q', '-f', 'origin', 'main', '--tags')
  }
  const keysTs = (ids: string[]): string => `export const RELEASE_KEYS = [${ids.map((i) => `{ id: '${i}', publicKey: 'x' }`).join(', ')}]\n`

  before(() => {
    const base = join(dir, 'gitrel')
    mkdirSync(base)
    git(base, 'init', '-q', '--bare', 'origin.git')
    git(base, 'clone', '-q', 'origin.git', 'repo')
    repo = join(base, 'repo')
    // origin — GitHub-адрес (его сверяет --publish с --repo), а ходит git в локальный bare через insteadOf.
    git(repo, 'config', `url.${join(base, 'origin.git')}.insteadOf`, 'https://github.com/pawellazarew/pult.git')
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/pawellazarew/pult.git')
    git(repo, 'checkout', '-q', '-b', 'main')
    mkdirSync(join(repo, 'scripts'))
    mkdirSync(join(repo, 'src', 'update'), { recursive: true })
    writeFileSync(join(repo, 'scripts', 'release.mjs'), readFileSync(RELEASE))
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'pult', version: '0.0.5' }))
    mkdirSync(join(repo, 'shell'))
    writeFileSync(join(repo, 'shell', 'package.json'), JSON.stringify({ name: 'pult-shell', version: '0.0.5' }))
    writeFileSync(join(repo, 'src', 'update', 'keys.ts'), keysTs(['00000000']))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'v0.0.4')
    git(repo, 'tag', 'v0.0.4')
    git(repo, 'push', '-q', 'origin', 'main', '--tags')
    key = join(dir, 'gitrel-key', 'k.pem')
    const r = node(KEYGEN, ['--out', key])
    keyId = /keyId: ([0-9a-f]{8})/.exec(r.stdout)?.[1] ?? ''
    assert.ok(keyId)
  })

  it('HEAD впереди origin/main — отказ', () => {
    writeFileSync(join(repo, 'note.txt'), 'x')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'не запушено')
    const r = rel()
    assert.equal(r.code, 1)
    assert.match(r.stderr, /HEAD [0-9a-f]{12} не совпадает с origin\/main/)
    git(repo, 'push', '-q', 'origin', 'main')
  })

  it('у окна другой номер (shell/package.json) — отказ до проверок git', () => {
    const file = join(repo, 'shell', 'package.json')
    const was = readFileSync(file)
    writeFileSync(file, JSON.stringify({ name: 'pult-shell', version: '0.1.21' }))
    try {
      const r = rel()
      assert.equal(r.code, 1)
      assert.match(r.stderr, /в shell\/package\.json 0\.1\.21, а релиз 0\.0\.5 — у окна тот же номер, что у пакета/)
    } finally {
      writeFileSync(file, was)
    }
  })

  it('ключ подписи не из keys.ts прошлого релиза (v0.0.4) — отказ ротации', () => {
    const r = rel()
    assert.equal(r.code, 1)
    assert.match(r.stderr, new RegExp(`ключ подписи ${keyId} не из keys\\.ts прошлого релиза v0\\.0\\.4 \\(00000000\\)`))
  })

  it('тег версии уже есть локально или на origin — отказ', () => {
    // Прошлый релиз доверяет нашему ключу — дальше проверки ротации проходим.
    writeFileSync(join(repo, 'src', 'update', 'keys.ts'), keysTs([keyId]))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'ключ')
    git(repo, 'tag', '-f', 'v0.0.4')
    git(repo, 'push', '-q', '-f', 'origin', 'main', '--tags')
    git(repo, 'tag', 'v0.0.5')
    assert.match(rel().stderr, /тег v0\.0\.5 уже есть локально/)
    git(repo, 'push', '-q', 'origin', 'v0.0.5')
    git(repo, 'tag', '-d', 'v0.0.5')
    // Тег только на origin: `git fetch --tags` его притягивает, и отказ — тот же (или по ls-remote).
    assert.match(rel().stderr, /тег v0\.0\.5 уже есть (локально|на origin)/)
    git(repo, 'push', '-q', 'origin', ':refs/tags/v0.0.5')
    git(repo, 'tag', '-d', 'v0.0.5')
  })

  it('всё сошлось — проверки пройдены, дальше гейт (в этом репо его нет); gh не звали', () => {
    const r = rel()
    assert.equal(r.code, 1)
    assert.match(r.stdout, /гейт: PULT_E2E=1 \.\/scripts\/ci-check\.sh/)
    assert.match(r.stderr, /ci-check\.sh/)
    assert.equal(existsSync(join(dir, 'gh-called')), false)
  })

  it('--publish в чужой --repo (проверки шли против origin) — отказ', () => {
    const r = rel('--publish', '--repo', 'someone/fork')
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--repo someone\/fork, а origin — pawellazarew\/pult/)
  })

  it('keys.ts прошлого релиза в двойных кавычках — ключ узнан, проверки пройдены', () => {
    retagPrev(`export const RELEASE_KEYS: readonly TrustedKey[] = [\n  { id: "${keyId}", publicKey: "x" },\n]\n`)
    const r = rel('--publish')
    assert.equal(r.code, 1)
    assert.match(r.stdout, /гейт: PULT_E2E=1/, r.stderr)
  })

  it('keys.ts прошлого релиза не разобрать — --publish отказ, сухой прогон предупреждает и идёт дальше', () => {
    retagPrev('export const RELEASE_KEYS = loadKeysFromSomewhere()\n')
    const pub = rel('--publish')
    assert.equal(pub.code, 1)
    assert.match(pub.stderr, /keys\.ts прошлого релиза v0\.0\.4 не прочитать или не разобрать/)
    assert.doesNotMatch(pub.stdout, /гейт:/)
    const dry = rel()
    assert.match(dry.stdout, /внимание: keys\.ts прошлого релиза v0\.0\.4 не прочитать или не разобрать/)
    assert.match(dry.stdout, /гейт:/)
    // id без кавычек (переменная) — тоже «не разобрать», а не «пусто — можно».
    retagPrev(`const K = '${keyId}'\nexport const RELEASE_KEYS = [{ id: K, publicKey: 'x' }]\n`)
    assert.match(rel('--publish').stderr, /не прочитать или не разобрать/)
    // Пустой список у прошлого релиза — единственный законный пропуск.
    retagPrev('export const RELEASE_KEYS: readonly TrustedKey[] = []\n')
    assert.match(rel('--publish').stdout, /гейт:/)
    assert.equal(existsSync(join(dir, 'gh-called')), false)
  })
})
