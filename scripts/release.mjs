#!/usr/bin/env node
// release.mjs — релиз Пульта в GitHub Releases (M8c). Запускает владелец на своей машине: закрытый ключ
// подписи живёт только у него (~/.config/pult-release/ed25519.pem) и в CI не едет никогда.
//
//   node scripts/release.mjs 0.2.27              # СУХОЙ прогон: собрать release/0.2.27/, подписать, проверить,
//                                                # напечатать команды gh — ничего не публикуется
//   node scripts/release.mjs 0.2.27 --publish    # то же и выложить: черновик → файлы → публикация
//
// Шаги (каждый — проверка, без которой релиз выходил бы битым):
//   1. версия в package.json = аргумент (иначе тарбол назовёт другую версию, и `pult update` его отвергнет);
//      дерево чистое, ветка main и HEAD = origin/main после `git fetch` (релизится то, что видят все, и
//      `gh --target` получает этот коммит, а не «main, какой он будет на GitHub в момент публикации»);
//      тега v<x> нет ни здесь, ни на origin; ключ подписи есть в keys.ts ПРЕДЫДУЩЕГО релиза (иначе стоящие
//      Пульты этот latest.json отвергнут — ротация идёт через релиз, подписанный старым ключом);
//   2. `PULT_E2E=1 ./scripts/ci-check.sh` — тот же гейт, что у PR;
//   3. `npm run clean && npm run build` — в тарбол не попадёт устаревший dist/*.js от удалённого исходника;
//      `npm pack` → pult-<v>.tgz и его копия pult.tgz (постоянное имя для install.sh);
//   4. Pult.app (`cd shell && npm ci && electron install && npm run dist:mac`) → `ditto -c -k --keepParent` →
//      Pult-<v>-arm64.zip и его копия Pult-arm64.zip (постоянное имя для README: releases/latest/download/…).
//      С 0.3.16 у окна тот же номер, что у пакета: shell/package.json другой версии — отказ, `app.version` = `version`,
//      и `--publish` без окна (`--no-app`) — отказ: окно обновляется той же кнопкой, что пакет, и релиз без него
//      оставил бы стоящие окна без пары;
//   5. манифест → подпись Ed25519 → latest.json. Подписывает и проверяет код ИЗ СОБРАННОГО ТАРБОЛА
//      (dist/update/manifest.js и keys.js): релиз проверяется ровно тем, чем его проверят люди. Ключ
//      подписи не из keys.ts этой сборки — отказ: такой latest.json отвергнет каждый стоящий Пульт;
//   6. publish: `gh release create --draft` с файлами, потом `gh release edit --draft=false`. Черновик —
//      чтобы `releases/latest` не указывал на релиз, у которого ещё нет тарбола.
//
// Флаги для проверки самого скрипта (тест, репетиция): --out DIR, --key PATH (или PULT_RELEASE_KEY),
// --skip-checks (без шагов 1–2 и пересборки, кроме сверки версии), --no-app (без шага 4), --app-zip <zip> (шаг 4
// не собирает окно, а берёт готовый zip), --trust <открытый ключ> (доверять ещё и ему при самопроверке).
// --skip-checks, --app-zip и --trust с --publish — отказ.

import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_SLUG = 'pawellazarew/pult'

// Отказ — исключение, а не process.exit: временные каталоги убирает finally, а exit их бы бросил.
class Fail extends Error {}
const die = (msg) => { throw new Fail(msg) }
const say = (msg) => process.stdout.write(`${msg}\n`)

try {
  // --- аргументы ----------------------------------------------------------------------------
  const argv = process.argv.slice(2)
  const opt = { publish: false, skipChecks: false, noApp: false, appZip: null, out: null, key: null, trust: [], repo: REPO_SLUG }
  let version = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => argv[++i] ?? die(`${a}: нужно значение`)
    if (a === '--publish') opt.publish = true
    else if (a === '--skip-checks') opt.skipChecks = true
    else if (a === '--no-app') opt.noApp = true
    else if (a === '--app-zip') opt.appZip = val()
    else if (a === '--out') opt.out = val()
    else if (a === '--key') opt.key = val()
    else if (a === '--trust') opt.trust.push(val())
    else if (a === '--repo') opt.repo = val()
    else if (a === '-h' || a === '--help') { say('node scripts/release.mjs <x.y.z> [--publish] [--out DIR] [--key PATH] [--no-app | --app-zip ZIP] [--skip-checks] [--trust PUB]'); process.exit(0) }
    else if (a.startsWith('-')) die(`незнакомый флаг «${a}»`)
    else if (version === null) version = a
    else die(`лишний аргумент «${a}»`)
  }
  if (!version) die('нужна версия: node scripts/release.mjs <x.y.z>')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) die(`«${version}» — не x.y.z: пререлизы каналом не ходят`)
  if (opt.publish && opt.skipChecks) die('--skip-checks с --publish нельзя: публикуется только то, что прошло гейт')
  if (opt.publish && opt.trust.length) die('--trust с --publish нельзя: релиз проверяется только ключами из сборки')
  if (opt.publish && opt.appZip) die('--app-zip с --publish нельзя: публикуется только окно, собранное этим прогоном')
  if (opt.noApp && opt.appZip) die('--no-app и --app-zip вместе не бывают')
  if (opt.publish && opt.noApp) die('--no-app с --publish нельзя: у окна тот же номер, что у пакета, и релиз выходит только с ним')
  if (opt.appZip && !existsSync(opt.appZip)) die(`--app-zip: нет файла ${opt.appZip}`)
  if (!/^[\w.-]+\/[\w.-]+$/.test(opt.repo)) die(`--repo «${opt.repo}» — не owner/name`)

  function run(cmd, args, o = {}) {
    const r = spawnSync(cmd, args, { cwd: o.cwd ?? ROOT, encoding: 'utf8', stdio: o.inherit ? 'inherit' : 'pipe', env: o.env ?? process.env, maxBuffer: 64 * 1024 * 1024 })
    if (r.error || r.status !== 0) {
      const why = o.inherit ? '' : `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').slice(-6).join('\n')
      die(`${cmd} ${args.join(' ')} — код ${r.status ?? r.error?.message}${why ? `\n${why}` : ''}`)
    }
    return (r.stdout ?? '').trim()
  }

  const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

  /**
   * id ключей из текста keys.ts прошлого релиза; null — не прочитался или не похож на список ключей.
   * Строки в обоих видах кавычек; число найденных id обязано совпасть с числом полей `id:` в массиве.
   */
  function parsePrevKeys(r) {
    if (r.status !== 0 || typeof r.stdout !== 'string') return null
    const arr = /RELEASE_KEYS[^=]*=\s*\[([\s\S]*?)\]/.exec(r.stdout)
    if (!arr) return null
    const ids = [...arr[1].matchAll(/\bid\s*:\s*(['"])([0-9a-f]{8})\1/g)].map((m) => m[2])
    const fields = [...arr[1].matchAll(/\bid\s*:/g)].length
    return ids.length === fields ? ids : null
  }
  /** owner/name из адреса GitHub (https или ssh); иначе null. */
  function githubSlug(url) {
    const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
    return m ? m[1] : null
  }

  // Версия x.y.z для сортировки тегов.
  const triple = (v) => v.split('.').map(Number)
  const older = (a, b) => { const x = triple(a); const y = triple(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false }

  // --- ключ подписи (до проверок: keyId нужен для сверки с прошлым релизом) -------------------
  const keyPath = resolve(opt.key ?? ((process.env.PULT_RELEASE_KEY ?? '').trim() || join(homedir(), '.config', 'pult-release', 'ed25519.pem')))
  if (!existsSync(keyPath)) die(`нет ключа подписи ${keyPath} — заведи: node scripts/release-keygen.mjs (или --key / PULT_RELEASE_KEY)`)
  if ((statSync(keyPath).mode & 0o077) !== 0) die(`${keyPath} доступен не только тебе (${(statSync(keyPath).mode & 0o777).toString(8)}) — chmod 600`)
  let privateKey
  try { privateKey = createPrivateKey(readFileSync(keyPath)) } catch (e) { die(`${keyPath} не разбирается как закрытый ключ: ${e.message}`) }
  if (privateKey.asymmetricKeyType !== 'ed25519') die(`${keyPath}: ключ ${privateKey.asymmetricKeyType}, нужен Ed25519`)
  const signingKeyId = createHash('sha256').update(Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url')).digest('hex').slice(0, 8)

  // --- 1. дерево, версия, теги ----------------------------------------------------------------
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (pkg.version !== version) die(`в package.json ${pkg.version}, а релиз ${version} — подними версию (npm version ${version} --no-git-tag-version) и закоммить`)
  // 0.3.16: один номер на пакет и окно.
  const shellVersion = JSON.parse(readFileSync(join(ROOT, 'shell', 'package.json'), 'utf8')).version
  if (shellVersion !== version) die(`в shell/package.json ${shellVersion}, а релиз ${version} — у окна тот же номер, что у пакета: подними обе версии`)
  const tag = `v${version}`
  if (!opt.skipChecks) {
    if (run('git', ['status', '--porcelain'])) die('дерево грязное — релиз собирается только из закоммиченного')
    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch !== 'main') die(`ветка ${branch}, а релиз — только с main`)
    run('git', ['fetch', '--quiet', '--tags', 'origin'])
    const head = run('git', ['rev-parse', 'HEAD'])
    const remote = run('git', ['rev-parse', 'refs/remotes/origin/main'])
    if (head !== remote) die(`HEAD ${head.slice(0, 12)} не совпадает с origin/main ${remote.slice(0, 12)} — релизится только то, что уже на GitHub (git push / git pull)`)
    if (spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { cwd: ROOT }).status === 0) die(`тег ${tag} уже есть локально — версия выпущена; подними версию`)
    if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) die(`тег ${tag} уже есть на origin — версия выпущена; подними версию`)
    // Ротация: подписывать можно только ключом, которому уже доверяют стоящие Пульты, — тем, что лежит в
    // keys.ts прошлого релиза. Сверять не с чем только в двух случаях: прошлого тега нет или в его keys.ts
    // нет файла / пустой список (канала тогда не было). Файл есть, но не читается или не разбирается — при
    // --publish отказ: «не смог прочитать» не должно молча означать «можно».
    const prev = run('git', ['tag', '-l', 'v*']).split('\n').map((t) => t.trim())
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t) && older(t.slice(1), version))
      .sort((a, b) => (older(a.slice(1), b.slice(1)) ? 1 : -1))[0]
    if (prev) {
      const spec = `${prev}:src/update/keys.ts`
      const exists = spawnSync('git', ['cat-file', '-e', spec], { cwd: ROOT }).status === 0
      const prevKeys = exists ? parsePrevKeys(spawnSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8' })) : []
      if (prevKeys === null) {
        const msg = `keys.ts прошлого релиза ${prev} не прочитать или не разобрать — не могу проверить, что стоящие Пульты примут ключ ${signingKeyId}`
        if (opt.publish) die(msg)
        say(`внимание: ${msg} (сухой прогон идёт дальше; --publish откажет)`)
      } else if (prevKeys.length && !prevKeys.includes(signingKeyId)) {
        die(`ключ подписи ${signingKeyId} не из keys.ts прошлого релиза ${prev} (${prevKeys.join(', ')}) — стоящие Пульты отвергнут latest.json. Сначала выпусти релиз, подписанный старым ключом, с новым ключом в keys.ts`)
      }
    }
    // Проверки HEAD и тегов шли против origin — публиковать в другой репозиторий значит выпустить непроверенное.
    if (opt.publish) {
      const origin = githubSlug(spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? '')
      if (origin !== opt.repo) die(`--repo ${opt.repo}, а origin — ${origin ?? 'не GitHub-адрес'}: проверки HEAD и тегов шли против origin, публикую только туда`)
    }
  }
  // `gh --target` — точный коммит: ветка main на GitHub могла уехать, пока шли гейт и сборка.
  const target = run('git', ['rev-parse', 'HEAD'])
  if (!opt.skipChecks) {
    // --- 2. гейт --------------------------------------------------------------------------------
    say('гейт: PULT_E2E=1 ./scripts/ci-check.sh …')
    run('./scripts/ci-check.sh', [], { inherit: true, env: { ...process.env, PULT_E2E: '1' } })
    // --- 3а. чистая сборка: dist/ без хвостов от удалённых исходников -------------------------
    say('npm run clean && npm run build …')
    run('npm', ['run', 'clean'])
    run('npm', ['run', 'build'])
  }

  // --- куда -----------------------------------------------------------------------------------
  const out = resolve(opt.out ?? join(ROOT, 'release', version))
  if (existsSync(out) && readdirSync(out).length) die(`${out} уже не пуст — убери его: файлы двух сборок в одном релизе не смешиваем`)
  mkdirSync(out, { recursive: true })

  // --- 3. тарбол ------------------------------------------------------------------------------
  const npmHome = mkdtempSync(join(tmpdir(), 'pult-release-npm-'))
  const work = mkdtempSync(join(tmpdir(), 'pult-release-'))
  try {
    say('npm pack …')
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', out, ROOT], {
      env: { ...process.env, npm_config_cache: join(npmHome, 'cache'), npm_config_update_notifier: 'false' },
    })
    const tgzName = `pult-${version}.tgz`
    const tgz = join(out, tgzName)
    if (!existsSync(tgz)) die(`npm pack не положил ${tgz}`)
    copyFileSync(tgz, join(out, 'pult.tgz'))
    copyFileSync(join(ROOT, 'install.sh'), join(out, 'install.sh'))

    // Код проверки — из собранного тарбола, а не из рабочей копии.
    run('tar', ['-xzf', tgz, '-C', work])
    const built = join(work, 'package')
    const builtPkg = JSON.parse(readFileSync(join(built, 'package.json'), 'utf8'))
    if (builtPkg.version !== version) die(`в тарболе версия ${builtPkg.version}, ждали ${version}`)
    const manifestMod = await import(pathToFileURL(join(built, 'dist', 'update', 'manifest.js')).href)
    const { RELEASE_KEYS } = await import(pathToFileURL(join(built, 'dist', 'update', 'keys.js')).href)
    const { WINDOW_MIN_VERSION } = await import(pathToFileURL(join(built, 'dist', 'core', 'version.js')).href)

    // --- 4. окно ----------------------------------------------------------------------------
    const appVersion = version
    let appAsset = null
    const appZipName = `Pult-${appVersion}-arm64.zip`
    // Постоянное имя для README и ссылки releases/latest/download/Pult-arm64.zip: ссылка на «последнее окно» без
    // номера. Те же байты; в манифесте — имя с версией.
    const appAliasName = 'Pult-arm64.zip'
    // Номер окна — из Info.plist самого бандла (CFBundleShortVersionString), а не из shell/package.json: собранное или
    // поданное окно другой версии каждый Пульт отверг бы при замене («версия в архиве …»).
    const bundleVersion = (plistText, where) => {
      const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plistText ?? '')
      if (!m) die(`${where}: в Info.plist нет CFBundleShortVersionString (или plist не XML)`)
      if (m[1] !== version) die(`${where}: окно ${m[1]}, а релиз ${version} — у окна тот же номер, что у пакета`)
    }
    if (opt.appZip) {
      bundleVersion(run('unzip', ['-p', resolve(opt.appZip), 'Pult.app/Contents/Info.plist']), `--app-zip ${opt.appZip}`)
      const zip = join(out, appZipName)
      copyFileSync(resolve(opt.appZip), zip)
      copyFileSync(zip, join(out, appAliasName))
      appAsset = zip
    } else if (!opt.noApp) {
      if (process.platform !== 'darwin') die('Pult.app собирается только на macOS (или --no-app)')
      say('Pult.app: npm ci, electron, dist:mac …')
      const shellDir = join(ROOT, 'shell')
      run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: shellDir })
      run('node', ['node_modules/electron/install.js'], { cwd: shellDir })
      run('npm', ['run', 'dist:mac'], { cwd: shellDir })
      const app = join(shellDir, 'out', 'mac-arm64', 'Pult.app')
      if (!existsSync(app)) die(`после dist:mac нет ${app}`)
      bundleVersion(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'), app)
      const zip = join(out, appZipName)
      run('ditto', ['-c', '-k', '--keepParent', app, zip])
      copyFileSync(zip, join(out, appAliasName))
      appAsset = zip
    }

    // --- 5. манифест и подпись ---------------------------------------------------------------
    const base = `https://github.com/${opt.repo}/releases/download/v${version}`
    const asset = (file, name) => ({ url: `${base}/${name}`, sha256: sha256(file), size: statSync(file).size })
    const manifest = {
      schema: 1,
      version,
      released: new Date().toISOString(),
      notes: `https://github.com/${opt.repo}/releases/tag/v${version}`,
      package: asset(tgz, tgzName),
      app: {
        version: appVersion,
        // Заморожено (src/core/version.ts): нужно только разбору манифеста у Пультов старше 0.3.16.
        minVersion: WINDOW_MIN_VERSION,
        ...(appAsset ? { 'darwin-arm64': asset(appAsset, appZipName) } : {}),
      },
    }
    const latest = manifestMod.signEnvelope(Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), privateKey)
    const latestFile = join(out, 'latest.json')
    writeFileSync(latestFile, latest)

    // --- самопроверка ------------------------------------------------------------------------
    const { keyId } = manifestMod.publicOf(privateKey)
    const extra = opt.trust.map((t) => ({ id: manifestMod.keyIdOf(manifestMod.rawPublicKey(t)), publicKey: t }))
    const keys = [...RELEASE_KEYS, ...extra]
    if (!keys.some((k) => k.id === keyId)) {
      die(`ключ подписи ${keyId} не из доверенных этой сборки (${RELEASE_KEYS.map((k) => k.id).join(', ') || 'в keys.ts пусто'}) — каждый Пульт отвергнет этот latest.json. Добавь открытый ключ в src/update/keys.ts`)
    }
    let checked
    try { checked = manifestMod.verifyEnvelope(readFileSync(latestFile), keys) } catch (e) { die(`самопроверка latest.json: ${e.message}`) }
    if (checked.app?.version !== checked.version) die(`самопроверка: окно ${checked.app?.version} и пакет ${checked.version} — номера должны совпадать`)
    for (const [file, a] of [[tgz, checked.package], [join(out, 'pult.tgz'), checked.package], ...(appAsset ? [[appAsset, checked.app['darwin-arm64']], [join(out, appAliasName), checked.app['darwin-arm64']]] : [])]) {
      if (sha256(file) !== a.sha256 || statSync(file).size !== a.size) die(`самопроверка: ${file} не сходится с манифестом`)
    }
    say(`latest.json подписан ключом ${keyId} и проверен кодом из ${tgzName}`)

    // --- 6. публикация ----------------------------------------------------------------------
    const files = readdirSync(out).sort().map((f) => join(out, f))
    const create = ['release', 'create', tag, '--repo', opt.repo, '--target', target, '--title', `Пульт ${version}`, '--generate-notes', '--draft', ...files]
    const publish = ['release', 'edit', tag, '--repo', opt.repo, '--draft=false', '--latest']
    const quote = (s) => (/^[\w./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
    if (!opt.publish) {
      say(`сухой прогон: файлы релиза в ${out}`)
      for (const f of files) say(`  ${f.slice(out.length + 1)}  ${statSync(f).size} байт`)
      say('выложить (или запусти с --publish):')
      say(`  gh ${create.map(quote).join(' ')}`)
      say(`  gh ${publish.map(quote).join(' ')}`)
    } else {
      say(`публикую ${tag} в ${opt.repo} …`)
      run('gh', create, { inherit: true })
      run('gh', publish, { inherit: true })
      say(`готово: https://github.com/${opt.repo}/releases/tag/${tag}`)
    }
  } finally {
    rmSync(npmHome, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
} catch (e) {
  if (!(e instanceof Fail)) throw e
  process.stderr.write(`release: ${e.message}\n`)
  process.exitCode = 1
}
