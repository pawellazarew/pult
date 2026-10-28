// e2e 0.3.4, окно обновляется само. Демон с тестовым «релизом» (PULT_TEST_UPDATE_DIR, свой ключ): в канале окно
// 0.1.16, «поставлено» фальшивое Pult.app 0.1.15 во временной папке (PULT_TEST_APP_DIRS — настоящий /Applications
// тестовый демон не видит). С 0.3.16 демон сразу готовит окно в фоне (настоящий ditto → apps/ready-0.1.16). Окно
// теста — рабочая копия Electron, НЕ из поставленного бандла: плашка про окно молчит (кнопка его не обновит), а
// «Настройки» говорят, где обновить (here: false). Обновление, запущенное из терминала (клиент теста), берёт
// подготовленное окно, сверяет бандл, кладёт новое окно рядом со старым и отказывает «закрой окно из …»: это окно
// пережило бы замену. Ничего не тронуто. Плюс черновик поля реплики переживает SIGTERM окна (так его
// закрывает обновление) и запуск НОВОГО процесса окна с тем же userData.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, REPO, waitFor } from './harness.js'
import type { Harness } from './harness.js'

const PKG_VERSION = (JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }).version
const BUNDLE_ID = 'io.github.pawellazarew.pult'

const plist = (version: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Pult</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>
`

/** Фальшивый Pult.app: plist и Mach-O с arm64 (копия /usr/bin/true — «толстый» x86_64 + arm64e). */
function bundle(dir: string, version: string): string {
  const app = path.join(dir, 'Pult.app')
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(version))
  copyFileSync('/usr/bin/true', path.join(app, 'Contents', 'MacOS', 'Pult'))
  return app
}

const versionAt = (app: string): string | null =>
  /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'))?.[1] ?? null

/** Подписанный latest.json с окном 0.1.16 — формат src/update/manifest.ts, собран здесь руками. */
function release(dir: string, zip: Buffer): string {
  const key = generateKeyPairSync('ed25519').privateKey
  const raw = Buffer.from((createPublicKey(key).export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  writeFileSync(path.join(dir, 'Pult-0.1.16-arm64.zip'), zip)
  const manifest = Buffer.from(JSON.stringify({
    schema: 1, version: PKG_VERSION, released: '2026-10-22T10:00:00.000Z',
    notes: `https://github.com/pawellazarew/pult/releases/tag/v${PKG_VERSION}`,
    package: { url: `https://example.invalid/pult-${PKG_VERSION}.tgz`, sha256: 'e'.repeat(64), size: 100 },
    app: {
      version: '0.1.16', minVersion: '0.1.13',
      'darwin-arm64': { url: 'https://example.invalid/Pult-0.1.16-arm64.zip', sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length },
    },
  }))
  writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({
    schema: 1,
    keyId: createHash('sha256').update(raw).digest('hex').slice(0, 8),
    payload: manifest.toString('base64'),
    signature: sign(null, manifest, key).toString('base64'),
  }))
  return raw.toString('base64')
}

describe('окно обновляется само: окно не из бандла — без кнопки, обновление отказывает «закрой окно из …»', () => {
  let h: Harness
  let root = ''
  let installed = ''

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'pe-app-'))
    const apps = path.join(root, 'Applications')
    mkdirSync(apps)
    installed = bundle(apps, '0.1.15')
    const src = path.join(root, 'src')
    mkdirSync(src)
    const next = bundle(src, '0.1.16')
    const zipFile = path.join(root, 'next.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', next, zipFile])
    const rel = path.join(root, 'rel')
    mkdirSync(rel)
    const pub = release(rel, readFileSync(zipFile))
    h = await launch({
      name: 'app-update',
      env: {
        PULT_UPDATE_URL: 'https://example.invalid/latest.json',
        PULT_TEST_UPDATE_DIR: rel,
        PULT_TEST_RELEASE_KEY: pub,
        PULT_TEST_UPDATE_FIRST_MS: '0',
        PULT_TEST_APP_DIRS: apps,
        PULT_TEST_APP_HELLO_MS: '1500',
      },
    })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
  })
  after(async () => {
    await h?.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('окно готовится в фоне (настоящий ditto); плашка молчит, «Настройки» говорят «закрой окно из …» — без кнопки', async () => {
    const c = await h.client()
    // Проверка через 0 мс после старта — и сразу подготовка окна: zip, разбор, ditto, проверки бандла.
    assert.ok(await waitFor(async () => ((await c.request('update.status')) as { app?: { ready?: string | null } }).app?.ready === '0.1.16', 25_000), 'окно не подготовилось')
    assert.equal(readdirSync(path.join(h.home, 'apps')).filter((n) => n.startsWith('stage-')).length, 0)
    assert.equal(versionAt(installed), '0.1.15', 'подготовка не трогает поставленное окно')
    assert.deepEqual(readdirSync(path.dirname(installed)), ['Pult.app'])
    await new Promise((r) => setTimeout(r, 2500))
    assert.equal(await h.win.getByTestId('update-available').count(), 0, 'кнопка не обновит это окно — плашки нет')
    await h.win.keyboard.press('Meta+,')
    await h.win.getByTestId('settings-dialog').waitFor({ timeout: 5000 })
    const row = h.win.getByTestId('settings-app-update')
    await row.waitFor({ timeout: 5000 })
    assert.equal(await row.getAttribute('data-state'), 'elsewhere')
    assert.match((await row.innerText()).replace(/\s+/g, ' '), /Окно 0\.1\.15 → 0\.1\.16 · закрой окно из .*Electron\.app и обнови из .*Pult\.app/)
    assert.equal(await h.win.getByTestId('settings-app-apply').count(), 0)
    // Окно другой версии, чем пакет, — номер окна мелко рядом с «Пульт X».
    assert.match((await h.win.getByTestId('settings-window-version').innerText()).replace(/\s+/g, ' '), /окно 0\.1\.15/)
    await h.shot('settings-app-elsewhere')
  })

  it('pult update --app при открытом окне рабочей копии: ditto и проверки проходят, затем отказ «закрой окно из …», ничего не тронуто', async () => {
    const pid = h.daemonPid()
    const c = await h.client()
    await c.request('update.apply', { target: 'app', expect: '0.1.16' })
    type St = { app?: { applying: unknown; last: { result: string; message: string } | null; bad: boolean } }
    assert.ok(await waitFor(async () => {
      const st = (await c.request('update.status')) as St
      return st.app?.applying === null && st.app.last !== null
    }, 30_000), 'обновление окна не завершилось')
    const st = (await c.request('update.status')) as St
    assert.equal(st.app?.last?.result, 'failed', st.app?.last?.message)
    assert.match(st.app?.last?.message ?? '', /закрой окно из .*Electron\.app.*ничего не тронуто/)
    assert.equal(st.app?.bad, false)
    assert.equal(versionAt(installed), '0.1.15', 'прежний бандл на месте')
    assert.deepEqual(readdirSync(path.dirname(installed)), ['Pult.app'], 'новое окно рядом убрано')
    const tools = readFileSync(path.join(h.home, 'test-app-tools.log'), 'utf8')
    assert.match(tools, /^codesign .*stage-0\.1\.16\/out\/Pult\.app$/m, 'бандл из настоящего ditto дошёл до проверки подписи при подготовке')
    assert.match(tools, /^codesign .*(ready|staging)-0\.1\.16\/Pult\.app$/m, 'перед заменой бандл проверен заново')
    assert.doesNotMatch(tools, /^open /m, 'окно никто не открывал')
    assert.equal(h.daemonPid(), pid, 'демон не перезапускался')
    await h.win.getByTestId('settings-update-check').click()
    const row = h.win.getByTestId('settings-app-update')
    assert.ok(await waitFor(async () => (await row.getAttribute('data-state')) === 'failed', 15_000), `строка окна: ${await row.getAttribute('data-state')} · ${await row.innerText()}`)
    assert.match(await row.innerText(), /закрой окно из/)
    assert.equal(await h.win.getAttribute('.app', 'data-conn'), 'up')
  })
})

describe('черновик поля реплики переживает SIGTERM окна и новый процесс', () => {
  let h1: Harness | null = null
  let h2: Harness | null = null
  after(async () => {
    await h1?.close()
    await h2?.close()
  })

  it('набрал → SIGTERM главному процессу Electron (как при обновлении окна) → новый процесс с тем же userData ставит черновик в поле', async () => {
    h1 = await launch({ name: 'drafts', keepHome: true })
    assert.ok(await waitFor(async () => (await h1!.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    const c = await h1.client()
    await c.request('agent.start', { name: 'dr', kind: 'claude', cwd: h1.workDir('dr') })
    await h1.win.locator('[data-testid="agent-row"][data-agent="dr"]').click()
    await h1.win.locator('[data-testid="conversation"][data-agent="dr"]').waitFor({ timeout: 10_000 })
    await h1.win.getByTestId('composer').fill('черновик до SIGTERM')
    await new Promise((r) => setTimeout(r, 800)) // запись по ходу набора — через полсекунды тишины
    const proc = h1.app.process()
    const exited = new Promise<void>((r) => proc.once('exit', () => r()))
    process.kill(proc.pid as number, 'SIGTERM')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))])
    assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'Electron не вышел по SIGTERM')
    const home = h1.home
    await h1.close()
    h1 = null
    h2 = await launch({ name: 'drafts-again', home })
    assert.ok(await waitFor(async () => (await h2!.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'новое окно не подключилось')
    await h2.win.locator('[data-testid="agent-row"][data-agent="dr"]').click()
    await h2.win.locator('[data-testid="conversation"][data-agent="dr"]').waitFor({ timeout: 10_000 })
    assert.equal(await h2.win.getByTestId('composer').inputValue(), 'черновик до SIGTERM')
  })
})
