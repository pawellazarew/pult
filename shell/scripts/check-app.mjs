#!/usr/bin/env node
// check-app.mjs — проверка собранного Pult.app (docs/12 §2, §4 О3).
//
//   node scripts/check-app.mjs            статика: fuses, подпись, Info.plist (со схемой pult://), состав
//                                         app.asar (со значком строки меню), arm64, иконка
//   node scripts/check-app.mjs --launch   ещё и живой прогон во временном PULT_HOME (PULT_TEST=1,
//                                         фальшивые CLI): окно встаёт на app://pult, демон видит клиента
//                                         `shell`, значок строки меню загружен из app.asar; fuses
//                                         проверяются делом (ELECTRON_RUN_AS_NODE, NODE_OPTIONS,
//                                         --inspect не срабатывают; подменённый app.asar не
//                                         запускается). Снимок окна — test-results/packaged-app.png.
//
// Приложение ищется в out/mac-arm64/Pult.app (или первым аргументом). В /Applications скрипт
// ничего не кладёт. Свои процессы убираются в конце; при провале дом с доказательствами сохраняется.
// Запущенные бандлы (проверенный и временная копия с подменённым app.asar) в конце снимаются с учёта
// LaunchServices (`lsregister -u`, scripts/lsregister.mjs), иначе они остаются претендентами на pult://.
// Приложение из /Applications или ~/Applications с учёта не снимается никогда.

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses'
import { appsToUnregister, isInstalledApp, unregisterApps } from './lsregister.mjs'

const SHELL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(SHELL, '..')
const LAUNCH = process.argv.includes('--launch')
const APP = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.join(SHELL, 'out', 'mac-arm64', 'Pult.app'))
const BIN = path.join(APP, 'Contents', 'MacOS', 'Pult')

let failed = 0
const ok = (msg) => process.stdout.write(`   ок   ${msg}\n`)
const bad = (msg) => { failed++; process.stdout.write(`   ПРОВАЛ ${msg}\n`) }
const check = (cond, msg) => (cond ? ok(msg) : bad(msg))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Предел первого запуска; debug server ещё не означает готовое окно или завершённый boot.
const FIRST_LAUNCH_MS = 90_000
async function waitFor(fn, timeoutMs = 15_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await fn()) return true } catch { /* ещё не готово */ }
    await sleep(stepMs)
  }
  return false
}

if (process.platform !== 'darwin') { process.stdout.write('check-app: только macOS — пропущено\n'); process.exit(0) }
if (!existsSync(BIN)) { process.stderr.write(`check-app: нет ${BIN} — сначала npm run dist:mac\n`); process.exit(1) }

// ------------------------------------------------------------------ статика
process.stdout.write(`== Pult.app: ${APP}\n`)

const wire = await getCurrentFuseWire(APP)
const fuse = (opt) => wire[opt]
// FuseState: 0x30 '0' — выключен, 0x31 '1' — включён (как их пишет @electron/fuses).
const ON = 49
const OFF = 48
check(wire.version === FuseVersion.V1 || wire.version === String(FuseVersion.V1), `версия fuses ${wire.version}`)
check(fuse(FuseV1Options.RunAsNode) === OFF, 'fuse RunAsNode выключен')
check(fuse(FuseV1Options.EnableNodeOptionsEnvironmentVariable) === OFF, 'fuse EnableNodeOptionsEnvironmentVariable выключен')
check(fuse(FuseV1Options.EnableNodeCliInspectArguments) === OFF, 'fuse EnableNodeCliInspectArguments выключен')
check(fuse(FuseV1Options.EnableEmbeddedAsarIntegrityValidation) === ON, 'fuse EnableEmbeddedAsarIntegrityValidation включён')
check(fuse(FuseV1Options.OnlyLoadAppFromAsar) === ON, 'fuse OnlyLoadAppFromAsar включён')
check(fuse(FuseV1Options.GrantFileProtocolExtraPrivileges) === OFF, 'fuse GrantFileProtocolExtraPrivileges выключен (file:// окну не нужен)')

try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', APP], { stdio: 'pipe' })
  ok('codesign --verify --deep --strict')
} catch (e) { bad(`codesign --verify: ${String(e.stderr ?? e.message).trim()}`) }
const sig = (() => { try { return execFileSync('codesign', ['-dv', APP], { stdio: ['ignore', 'pipe', 'pipe'] }).toString() } catch (e) { return String(e.stderr ?? '') } })()
const sigErr = execFileSync('sh', ['-c', `codesign -dv "${APP}" 2>&1`]).toString()
check(/Signature=adhoc/.test(sig + sigErr), 'подпись ad-hoc')
// Hardened runtime: без него dyld исполняет DYLD_INSERT_LIBRARIES — чужой нативный код в main до JS.
check(/flags=0x\w+\([^)]*\bruntime\b[^)]*\)/.test(sigErr), `hardened runtime (${/flags=\S+/.exec(sigErr)?.[0] ?? 'нет flags'})`)
const ents = (() => { try { return execFileSync('codesign', ['-d', '--entitlements', ':-', APP], { stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch { return '' } })()
check(/com\.apple\.security\.cs\.allow-jit/.test(ents), 'entitlement allow-jit (V8)')
check(!/allow-dyld-environment-variables/.test(ents), 'нет entitlement allow-dyld-environment-variables')

const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(APP, 'Contents', 'Info.plist')]).toString())
check(plist.CFBundleExecutable === 'Pult' && plist.CFBundleName === 'Pult', `CFBundleName=${plist.CFBundleName}`)
check(typeof plist.ElectronAsarIntegrity?.['Resources/app.asar']?.hash === 'string', 'Info.plist: ElectronAsarIntegrity для app.asar')
check(plist.ElectronAsarIntegrity?.['Resources/default_app.asar'] === undefined, 'Info.plist: нет записи демо-приложения default_app.asar')
check(plist.NSAppTransportSecurity?.NSAllowsArbitraryLoads !== true, 'Info.plist: ATS без NSAllowsArbitraryLoads')
// Ссылки pult:// (docs/14 О3): схему объявляет Info.plist, иначе macOS не отдаст её приложению.
const urlTypes = Array.isArray(plist.CFBundleURLTypes) ? plist.CFBundleURLTypes : []
check(urlTypes.some((t) => Array.isArray(t?.CFBundleURLSchemes) && t.CFBundleURLSchemes.includes('pult')),
  `Info.plist: CFBundleURLTypes со схемой pult (${JSON.stringify(urlTypes.flatMap((t) => t?.CFBundleURLSchemes ?? []))})`)
check(existsSync(path.join(APP, 'Contents', 'Resources', plist.CFBundleIconFile ?? 'icon.icns')), `иконка ${plist.CFBundleIconFile}`)
const archs = execFileSync('lipo', ['-archs', BIN]).toString().trim()
check(archs === 'arm64', `архитектура ${archs}`)

const asar = await import('@electron/asar')
const listed = asar.listPackage(path.join(APP, 'Contents', 'Resources', 'app.asar'), { isPack: false }).map((p) => p.replace(/\\/g, '/')).sort()
// build/trayTemplate*.png — значок строки меню: main берёт его рядом с собой, из app.asar.
const want = ['/build', '/build/trayTemplate.png', '/build/trayTemplate@2x.png', '/dist', '/dist/main.js', '/dist/preload.cjs', '/package.json']
check(JSON.stringify(listed) === JSON.stringify(want), `app.asar: ${listed.join(' ')}`)
// Окно 0.1.16: канал вставки картинки — и в preload, и в main (собранное, а не старое из кэша).
{
  const archive = path.join(APP, 'Contents', 'Resources', 'app.asar')
  const read = (f) => { try { return asar.extractFile(archive, f).toString() } catch { return '' } }
  check(read('dist/preload.cjs').includes('pult:clipboard-image') && read('dist/main.js').includes('pult:clipboard-image'),
    'app.asar: канал pult:clipboard-image в preload и main (вставка картинки из буфера)')
}
check(!existsSync(path.join(APP, 'Contents', 'Resources', 'app')), 'рядом с app.asar нет папки app/')
check(!existsSync(path.join(APP, 'Contents', 'Resources', 'default_app.asar')), 'демо-приложение Electron default_app.asar не поставляется')

// ------------------------------------------------------------------ живой прогон
if (LAUNCH) await launchChecks()

process.stdout.write(failed ? `\ncheck-app: ПРОВАЛ (${failed})\n` : '\ncheck-app: OK\n')
process.exit(failed ? 1 : 0)

async function launchChecks() {
  process.stdout.write('== живой прогон (PULT_TEST=1, временный PULT_HOME)\n')
  if (isInstalledApp(realpathSync(APP), homedir())) { bad('живой прогон установленного приложения запрещён'); return }
  const failuresBefore = failed
  const home = mkdtempSync(path.join(tmpdir(), 'pa-'))
  // Собранное приложение PULT_UI_ROOT не слушает (даже при PULT_TEST=1 — обе переменные из одного env),
  // поэтому пакет кладём так, как его ставит install.sh: PULT_HOME/current/lib/node_modules/pult →
  // симлинк на эту рабочую копию. PULT_UI_ROOT при этом указывает на «чужой» собранный пакет:
  // если бы main его послушал, в логе был бы via PULT_UI_ROOT, а не installed.
  const installed = path.join(home, 'current', 'lib', 'node_modules', 'pult')
  mkdirSync(path.dirname(installed), { recursive: true })
  symlinkSync(REPO, installed)
  const evil = path.join(home, 'evil')
  for (const f of ['package.json', 'dist/cli/startOnDemand.js', 'dist/ui/index.html']) {
    mkdirSync(path.dirname(path.join(evil, f)), { recursive: true })
    writeFileSync(path.join(evil, f), f.endsWith('.json') ? '{}\n' : '\n')
  }
  const appEnv = {
    PULT_TEST: '1',
    // Assertions below match RU diagnostics; don't inherit the caller/system locale.
    PULT_LANG: 'ru',
    PULT_HOME: home,
    PULT_UI_ROOT: evil,
    PULT_NODE: process.execPath,
    PULT_TEST_NET: 'ok',
    PULT_CLAUDE_BIN: path.join(REPO, 'test', 'fakes', 'fake-claude.mjs'),
    PULT_CODEX_BIN: path.join(REPO, 'test', 'fakes', 'fake-codex-app-server.mjs'),
    PULT_SERVICE_DIR: path.join(home, 'svc'),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  }
  const env = { ...process.env, ...appEnv }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const children = []
  const ownerTool = path.join(home, 'app-process-owner')
  const stdoutFile = path.join(home, 'app.stdout')
  const stderrFile = path.join(home, 'app.stderr')
  const phaseFile = path.join(home, 'phases.jsonl')
  const started = performance.now()
  let owner = null
  let daemonOwner = null
  let openChild = null
  let launched = false
  let launchedAt = null
  let browser = null
  let main = null
  let launcherError = null
  const launcher = { stdout: '', stderr: '' }
  const rawRuns = []
  let lastStderrBytes = -1
  const phase = (event, fields = {}) => appendFileSync(phaseFile,
    JSON.stringify({ event, elapsedMs: Math.round(performance.now() - started), ...fields }) + '\n', { mode: 0o600 })
  const textFile = (file) => { try { return readFileSync(file, 'utf8') } catch { return '' } }
  const ownerCall = (...args) => {
    const reply = JSON.parse(execFileSync(ownerTool, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024 }))
    if (reply.ok !== true) throw new Error('kernel process identity unavailable')
    return reply
  }
  const ownerList = (exe = BIN) => ownerCall('list', exe).matches
  const sameOwner = (a, b) => a.pid === b.pid && a.startSec === b.startSec && a.startUsec === b.startUsec && a.uid === b.uid
  const startedByLaunch = (identity) => launchedAt !== null && identity.startSec * 1000 + identity.startUsec / 1000 >= launchedAt
  const verified = (identity, exe = BIN) => {
    if (!identity) return false
    try { return sameOwner(identity, ownerCall('verify', exe, String(identity.pid), String(identity.startSec), String(identity.startUsec)).identity) }
    catch { return false }
  }
  const discover = () => {
    const matches = ownerList()
    if (matches.length > 1 || (owner && matches.some((p) => !sameOwner(p, owner)))) throw new Error('неоднозначный PID проверяемого приложения')
    if (matches.some((p) => !startedByLaunch(p))) throw new Error('PID проверяемого приложения старше запроса запуска')
    if (!owner && matches.length === 1) { owner = matches[0]; phase('app-owned', owner) }
    const bytes = Buffer.byteLength(textFile(stderrFile))
    if (bytes !== lastStderrBytes) { lastStderrBytes = bytes; phase('stderr-growth', { bytes }) }
  }
  // Discovery runs independently of DevTools, so even a pre-port failure has an owned PID.
  const waitPort = async (file) => {
    const deadline = Date.now() + FIRST_LAUNCH_MS
    while (Date.now() < deadline) {
      discover()
      if (existsSync(file)) return true
      if (launcherError || (openChild?.exitCode !== null && openChild?.exitCode !== undefined)) {
        phase('launcher-exited-before-port', { code: openChild.exitCode })
        return false
      }
      await sleep(100)
    }
    return false
  }
  const signalOwned = (identity, signal, exe = BIN) => {
    if (!verified(identity, exe)) return false
    // No await between the last kernel PID/start/path check and the signal.
    try { process.kill(identity.pid, signal); phase('owned-signal', { pid: identity.pid, signal }); return true }
    catch (e) { if (e.code === 'ESRCH') return false; throw e }
  }
  const appExited = () => !ownerList().some((p) => owner && sameOwner(p, owner))
  // Бандлы, которые этот прогон создал (копии во временном доме): их снимаем с учёта LaunchServices.
  const createdApps = []
  const run = (args, extraEnv = {}) => {
    const child = spawn(BIN, args, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = { stdout: '', stderr: '', code: undefined, signal: undefined }
    child.stdout.setEncoding('utf8').on('data', (d) => { out.stdout += d })
    child.stderr.setEncoding('utf8').on('data', (d) => { out.stderr += d })
    child.on('exit', (code, signal) => { out.code = code; out.signal = signal })
    children.push(child)
    const result = { child, out }
    rawRuns.push(result)
    return result
  }
  const exited = (r) => r.out.code !== undefined
  const daemonPid = () => { try { return Number(JSON.parse(readFileSync(path.join(home, 'run', 'pultd.lock'), 'utf8')).pid) || null } catch { return null } }
  const rememberDaemon = () => {
    const pid = daemonPid()
    if (!pid || daemonOwner) return
    daemonOwner = ownerList(process.execPath).find((p) => p.pid === pid && startedByLaunch(p)) ?? null
    phase('daemon-owner', { identity: daemonOwner })
  }
  try {
    phase('prepare')
    execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', path.join(SHELL, 'scripts', 'app-process-owner.c'), '-o', ownerTool], { timeout: 30_000, stdio: 'pipe' })
    if (ownerList().length !== 0) throw new Error('проверяемый бандл уже запущен — прогон не владеет этим процессом')
    for (const file of [stdoutFile, stderrFile]) writeFileSync(file, '', { mode: 0o600 })
    // 1. Как pult ui / updater: LaunchServices, точный путь, отдельный экземпляр.
    // open -W — лишь wait-процесс; его PID НЕ является PID Pult.
    const args = ['-n', '-W', '-a', APP, '--stdout', stdoutFile, '--stderr', stderrFile]
    // Only intentional test variables become argv; never copy ambient credentials into open's args.
    for (const [key, value] of Object.entries(appEnv)) args.push('--env', `${key}=${value}`)
    args.push('--args', '--remote-debugging-port=0')
    launchedAt = Date.now()
    openChild = spawn('/usr/bin/open', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    launched = true
    openChild.stdout.setEncoding('utf8').on('data', (data) => { launcher.stdout += data })
    openChild.stderr.setEncoding('utf8').on('data', (data) => { launcher.stderr += data })
    openChild.on('error', (e) => { launcherError = String(e.message).slice(0, 500); phase('launcher-error', { error: launcherError }) })
    openChild.on('exit', (code, signal) => { phase('launcher-exit', { code, signal }); writeFileSync(path.join(home, 'launcher.stderr'), launcher.stderr, { mode: 0o600 }) })
    main = { out: { get stdout() { return textFile(stdoutFile) }, get stderr() { return textFile(stderrFile) } } }
    phase('launch-services-requested', { launcherPid: openChild.pid ?? null })
    const portFile = path.join(home, 'shell-data', 'DevToolsActivePort')
    const portReady = await waitPort(portFile)
    check(portReady, 'debug server доступен (DevToolsActivePort)')
    phase('port-result', { portReady, owned: owner !== null, stderrBytes: Buffer.byteLength(main.out.stderr) })
    if (!portReady || !owner) throw new Error('LaunchServices не подтвердил debug server/PID; см. сохранённые логи')
    const found = await waitFor(() => /пакет найден/.test(main.out.stderr))
    check(found, 'main из app.asar нашёл пакет pult')
    phase('boot-result', { found, stderrBytes: Buffer.byteLength(main.out.stderr) })
    if (!found) process.stdout.write(`        stderr окна: ${main.out.stderr.trim().split('\n').slice(-5).join(' | ') || '—'}\n`)
    check(/пакет найден .*"via":"installed"/.test(main.out.stderr),
      `PULT_UI_ROOT при PULT_TEST=1 проигнорирован: пакет из PULT_HOME/current (${(/пакет найден (.*)/.exec(main.out.stderr) ?? [])[1] ?? '—'})`)
    const logFile = path.join(home, 'logs', 'pultd.log')
    check(await waitFor(() => /"client":"shell"/.test(readFileSync(logFile, 'utf8'))), 'демон поднят окном и видит клиента shell')
    rememberDaemon()
    const trayLine = /трей поднят (.*)/.exec(main.out.stderr)?.[1] ?? ''
    check(/"empty":false/.test(trayLine) && /"template":true/.test(trayLine) && /"scales":\[[^\]]*2/.test(trayLine),
      `значок строки меню загружен из app.asar, шаблонный, с @2x (${trayLine || '—'})`)
    const port = readFileSync(portFile, 'utf8').split('\n')[0]
    const { chromium } = await import('playwright-core')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const cdp = await browser.newBrowserCDPSession()
    const processes = await cdp.send('SystemInfo.getProcessInfo')
    const browserPid = processes.processInfo.find((p) => p.type === 'browser')?.id
    const ownedBrowser = browserPid === owner.pid && verified(owner)
    phase('cdp-owner', { browserPid: browserPid ?? null, ownedBrowser })
    check(ownedBrowser, 'CDP Browser PID совпадает с проверенным kernel PID/start/path')
    if (!ownedBrowser) { browser = null; throw new Error('CDP не принадлежит процессу этого прогона') }
    await cdp.detach()
    let page = null
    await waitFor(() => {
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://pult/')) ?? null
      return page !== null
    })
    check(page !== null, `страница ${page?.url() ?? '—'}`)
    if (page) {
      const bridge = await page.evaluate(() => ({ pult: typeof window.pult, require: typeof window.require, process: typeof window.process }))
      check(bridge.pult === 'object' && bridge.require === 'undefined' && bridge.process === 'undefined',
        `мост window.pult есть, require/process нет (${JSON.stringify(bridge)})`)
      // Окно 0.1.16: вставка картинки из буфера — метод моста без аргументов.
      const image = await page.evaluate(() => typeof window.pult?.clipboardImage?.save)
      check(image === 'function', `мост: clipboardImage.save есть (${image})`)
      // По data-testid, а не по тексту: «+ Агент» 07.10.2026 стал «+ Сессия», и проверка молча проваливалась.
      check(await waitFor(async () => page.evaluate(() => document.querySelector('[data-testid="new-agent"]') !== null)), 'интерфейс отрисован (кнопка новой сессии)')
      mkdirSync(path.join(SHELL, 'test-results'), { recursive: true })
      await page.screenshot({ path: path.join(SHELL, 'test-results', 'packaged-app.png') })
      ok('снимок test-results/packaged-app.png')
    }

    // 2. Fuses делом. Пока первое окно живо, второй запуск упирается в замок одного экземпляра и выходит —
    //    если бы fuse был включён, node-режим/--require/инспектор сработали бы раньше.
    const marker = path.join(home, 'node-options-ran')
    const req = path.join(home, 'probe.cjs')
    writeFileSync(req, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
    const asNode = run(['-e', "process.stdout.write('RAN_AS_NODE')"], { ELECTRON_RUN_AS_NODE: '1' })
    const nodeOpts = run([], { NODE_OPTIONS: `--require ${req}` })
    const inspect = run(['--inspect=0'])
    // DYLD_INSERT_LIBRARIES: пробная dylib пишет метку из конструктора. Hardened runtime обязан
    // её не загрузить (dyld вычищает DYLD_* у процесса с флагом runtime).
    const dylibMarker = path.join(home, 'dylib-ran')
    const dylibSrc = path.join(home, 'probe.c')
    const dylib = path.join(home, 'probe.dylib')
    writeFileSync(dylibSrc, `#include <stdio.h>\n__attribute__((constructor)) static void m(void){FILE*f=fopen(${JSON.stringify(dylibMarker)},"w");if(f){fputs("ran",f);fclose(f);}}\n`)
    let dyld = null
    try {
      execFileSync('cc', ['-dynamiclib', '-arch', 'arm64', '-o', dylib, dylibSrc], { stdio: 'ignore' })
      dyld = run([], { DYLD_INSERT_LIBRARIES: dylib })
    } catch { bad('не собрать пробную dylib (нет cc) — DYLD не проверен') }
    await waitFor(() => exited(asNode) && exited(nodeOpts) && exited(inspect) && (dyld === null || exited(dyld)), 20_000)
    if (dyld) check(!existsSync(dylibMarker), 'DYLD_INSERT_LIBRARIES не загружает чужую dylib')
    check(!asNode.out.stdout.includes('RAN_AS_NODE'), `ELECTRON_RUN_AS_NODE=1 не даёт node (выход ${asNode.out.code})`)
    check(!existsSync(marker), 'NODE_OPTIONS=--require не исполняется')
    check(!/Debugger listening/.test(inspect.out.stderr), '--inspect не открывает отладчик')

    // 3. Окно закрывается — демон живёт (закрыть окно ≠ остановить агентов).
    phase('before-termination-check', { owner, stderrBytes: Buffer.byteLength(main.out.stderr) })
    await browser.close().catch(() => {})
    browser = null
    const pid = daemonPid()
    check(signalOwned(owner, 'SIGTERM'), 'SIGTERM отправлен только проверенному PID/start/path')
    check(await waitFor(appExited, 15_000), 'окно вышло по SIGTERM')
    check(pid !== null && (() => { try { process.kill(pid, 0); return true } catch { return false } })(), `демон жив после выхода окна (pid ${pid})`)

    // 4. Подменённый app.asar: копия приложения с правкой заголовка той же длины — запуск обязан упасть.
    const copyDir = path.join(home, 'tampered')
    mkdirSync(copyDir)
    const copy = path.join(copyDir, 'Pult.app')
    createdApps.push(copy)
    execFileSync('cp', ['-Rc', APP, copy])
    const asarFile = path.join(copy, 'Contents', 'Resources', 'app.asar')
    const buf = readFileSync(asarFile)
    const at = buf.indexOf(Buffer.from('"preload.cjs"'))
    if (at < 0) { bad('в заголовке app.asar нет preload.cjs — подмену не сделать') } else {
      buf.write('"preloax.cjs"', at, 'utf8')
      writeFileSync(asarFile, buf)
      const t = spawn(path.join(copy, 'Contents', 'MacOS', 'Pult'), [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(t)
      let tErr = ''
      let tCode
      t.stderr.setEncoding('utf8').on('data', (d) => { tErr += d })
      t.on('exit', (code, signal) => { tCode = code ?? signal })
      const died = await waitFor(() => tCode !== undefined, 15_000)
      writeFileSync(path.join(home, 'tampered.stderr'), tErr, { mode: 0o600 })
      check(died && !/пакет найден/.test(tErr), `подменённый app.asar не запускается (выход ${String(tCode)}${/ntegrity/.test(tErr) ? ', integrity' : ''})`)
    }
  } catch (e) {
    bad(`живой прогон: ${String(e.message).slice(0, 500)}`)
    phase('failure', { error: String(e.message).slice(0, 500) })
  } finally {
    // Capture evidence BEFORE any close/signal: cleanup must not turn a late boot into readiness.
    phase('before-cleanup', { owner, ownedAppVerified: verified(owner), daemonOwner,
      stderrBytes: Buffer.byteLength(textFile(stderrFile)), launcherPid: openChild?.pid ?? null,
      launcherExitCode: openChild?.exitCode ?? null })
    for (const [index, result] of rawRuns.entries()) {
      writeFileSync(path.join(home, `raw-${index}.stdout`), result.out.stdout, { mode: 0o600 })
      writeFileSync(path.join(home, `raw-${index}.stderr`), result.out.stderr, { mode: 0o600 })
    }
    writeFileSync(path.join(home, 'launcher.stdout'), launcher.stdout, { mode: 0o600 })
    writeFileSync(path.join(home, 'launcher.stderr'), launcher.stderr, { mode: 0o600 })
    if (browser) await browser.close().catch(() => {})
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
    await waitFor(() => children.every((c) => c.exitCode !== null || c.signalCode !== null), 5_000)
    if (existsSync(ownerTool) && launched) {
      try {
        // Late discovery is still exact path + kernel start; no name/bundle-ID fallback.
        discover()
        if (verified(owner)) signalOwned(owner, 'SIGKILL')
        if (owner && !await waitFor(appExited, 5_000)) bad('проверяемый PID остался после уборки; дом сохранён')
        rememberDaemon()
      } catch (e) { bad(`уборка PID: ${String(e.message).slice(0, 500)}`) }
    }
    if (openChild && openChild.exitCode === null && openChild.signalCode === null) {
      phase('stop-open-waiter', { pid: openChild.pid })
      openChild.kill('SIGTERM') // Only our open -W child, never used as the Pult PID.
      if (!await waitFor(() => openChild.exitCode !== null || openChild.signalCode !== null, 5_000)) bad('open -W не завершился после уборки; дом сохранён')
    }
    // Демон, поднятый окном: штатная остановка через собранный CLI того же дома.
    try {
      execFileSync(process.execPath, [path.join(REPO, 'dist', 'cli', 'main.js'), 'daemon', 'stop'], { env, stdio: 'ignore', timeout: 15_000 })
    } catch { /* уже остановлен */ }
    try {
      const pid = daemonPid()
      const remaining = pid ? ownerList(process.execPath).find((p) => p.pid === pid) : null
      if (remaining) {
        // A daemon can appear during cleanup. Own it only via this home's lock,
        // pinned Node path, same UID and kernel start after our launch request.
        if (!daemonOwner && startedByLaunch(remaining)) { daemonOwner = remaining; phase('late-daemon-owned', remaining) }
        if (!daemonOwner || !sameOwner(daemonOwner, remaining)) bad('уборка демона не подтверждена: PID/start не принадлежит прогону')
        else {
          if (!signalOwned(daemonOwner, 'SIGKILL', process.execPath)) bad('уборка демона не подтверждена проверкой kernel identity')
          if (!await waitFor(() => !ownerList(process.execPath).some((p) => sameOwner(p, daemonOwner)), 5_000)) bad('свой демон остался после уборки; дом сохранён')
        }
      }
    } catch (e) { bad(`уборка демона не подтверждена: ${String(e.message).slice(0, 500)}`) }
    // Снять с учёта LaunchServices всё запущенное и созданное — ДО удаления временного дома.
    const gone = unregisterApps(appsToUnregister({ app: APP, launched, created: createdApps, home: homedir() }))
    for (const r of gone) process.stdout.write(`   ${r.ok ? 'ок  ' : 'warn'}   lsregister -u ${r.path}${r.ok ? '' : `: ${r.error}`}\n`)
    const retain = failed > failuresBefore || failuresBefore > 0
    phase('cleanup-complete', { failed: retain })
    if (retain) process.stdout.write(`   логи сохранены: ${home}\n`)
    else {
      // Успешный прогон: симлинк снимается ДО удаления дома; исходная рабочая копия не удаляется.
      try { unlinkSync(installed) } catch { /* уже нет */ }
      rmSync(home, { recursive: true, force: true })
    }
  }
}
