// e2e 0.3.4, окно обновляется само. Демон с тестовым «релизом» (PULT_TEST_UPDATE_DIR, свой ключ): в канале окно
// 0.1.16, «поставлено» фальшивое Pult.app 0.1.15 во временной папке (PULT_TEST_APP_DIRS — настоящий /Applications
// тестовый демон не видит). Плашка «Доступно новое окно», ⌘, → «Окно: 0.1.15 → доступно 0.1.16 · Обновить окно» →
// демон качает zip, проверяет (настоящий ditto, подпись — тестовая), меняет бандл и «открывает» его (в тестовом
// режиме open, lsregister и сигналы только пишутся в журнал — окно теста никто не закрывает). Новое окно не
// здоровается — откат: прежний бандл на месте, «вернул 0.1.15» в «Настройках». Плюс черновик поля реплики
// переживает закрытие окна.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('окно обновляется само: «Обновить окно» → новое не поднялось → откат', () => {
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

  it('плашка «Доступно новое окно 0.1.16», ⌘, → строка «Окно: 0.1.15 → доступно 0.1.16 · Обновить окно»', async () => {
    const banner = h.win.getByTestId('update-app')
    await banner.waitFor({ timeout: 25_000 })
    assert.match(await banner.innerText(), /Доступно новое окно 0\.1\.16 \(стоит 0\.1\.15\)/)
    await h.win.getByTestId('update-apply-app').waitFor({ timeout: 2000 })
    await h.win.keyboard.press('Meta+,')
    await h.win.getByTestId('settings-dialog').waitFor({ timeout: 5000 })
    const row = h.win.getByTestId('settings-app-update')
    await row.waitFor({ timeout: 5000 })
    assert.equal(await row.getAttribute('data-state'), 'available')
    assert.match((await row.innerText()).replace(/\s+/g, ' '), /Окно: 0\.1\.15 → доступно 0\.1\.16 Обновить окно/)
    assert.match((await h.win.getByTestId('settings-update-versions').innerText()).replace(/\s+/g, ' '), /окно 0\.1\.15/)
    await h.shot('settings-app-available')
  })

  it('«Обновить окно»: демон меняет бандл, новое не здоровается — откат, «вернул 0.1.15», окно и демон на месте', async () => {
    const pid = h.daemonPid()
    const c = await h.client()
    await h.win.getByTestId('settings-app-apply').click()
    type St = { app?: { applying: unknown; last: { result: string; message: string } | null; bad: boolean } }
    assert.ok(await waitFor(async () => {
      const st = (await c.request('update.status')) as St
      return st.app?.applying === null && st.app.last !== null
    }, 30_000), 'обновление окна не завершилось')
    const st = (await c.request('update.status')) as St
    assert.equal(st.app?.last?.result, 'rolled_back', st.app?.last?.message)
    assert.match(st.app?.last?.message ?? '', /не подключилось.*вернул 0\.1\.15/)
    assert.equal(st.app?.bad, true)
    assert.equal(versionAt(installed), '0.1.15', 'прежний бандл на месте')
    const tools = readFileSync(path.join(h.home, 'test-app-tools.log'), 'utf8')
    assert.equal(tools.split('\n').filter((l) => l === `open ${installed}`).length, 2, tools)
    assert.match(tools, new RegExp(`lsregister -f ${installed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.equal(h.daemonPid(), pid, 'демон не перезапускался')
    // «Проверить сейчас» — свежий статус в окне без 15-секундного опроса.
    await h.win.getByTestId('settings-update-check').click()
    const row = h.win.getByTestId('settings-app-update')
    assert.ok(await waitFor(async () => (await row.getAttribute('data-state')) === 'rolledback', 15_000), `строка окна: ${await row.getAttribute('data-state')} · ${await row.innerText()}`)
    assert.match(await row.innerText(), /вернул 0\.1\.15/)
    assert.equal(await h.win.getAttribute('.app', 'data-conn'), 'up')
    await h.shot('settings-app-rolledback')
  })
})

describe('черновик поля реплики переживает закрытие окна', () => {
  let h: Harness

  before(async () => {
    h = await launch({ name: 'drafts' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
  })
  after(async () => { await h?.close() })

  it('набрал, окно закрыто (как при обновлении окна) — новое окно ставит черновик в поле той же сессии', async () => {
    const c = await h.client()
    await c.request('agent.start', { name: 'dr', kind: 'claude', cwd: h.workDir('dr') })
    await h.win.locator('[data-testid="agent-row"][data-agent="dr"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="dr"]').waitFor({ timeout: 10_000 })
    const box = h.win.getByTestId('composer')
    await box.fill('черновик до закрытия окна')
    // Закрыть окно так, как его закрывает человек (⌘W) или выход приложения: BrowserWindow.close() — с pagehide.
    const old = h.win
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() })
    assert.ok(await waitFor(() => old.isClosed(), 10_000), 'окно не закрылось')
    const win = await h.reopen()
    assert.ok(await waitFor(async () => (await win.getAttribute('.app', 'data-conn')) === 'up', 20_000))
    await win.locator('[data-testid="agent-row"][data-agent="dr"]').click()
    await win.locator('[data-testid="conversation"][data-agent="dr"]').waitFor({ timeout: 10_000 })
    assert.equal(await win.getByTestId('composer').inputValue(), 'черновик до закрытия окна')
  })
})
