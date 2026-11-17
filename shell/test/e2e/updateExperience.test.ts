import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { build } from 'esbuild'
import { launch, REPO, SHELL_DIR, sleep, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import type { UpdateStatus } from '../../../src/core/rpc.js'

declare global { interface Window { __updateExperienceFixture: { setStatus(value: UpdateStatus): void; delay(ms: number): void; stats(): { calls: number; active: number; peak: number }; unmount(): void } } }

it('signed in-app notes, preserved settings, real-percent transport snapshots, focus and closed-dialog polling', async (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'pult-update-ui-'))
  const fixture = path.join(scratch, 'package'), channel = path.join(scratch, 'channel')
  let h: Harness | undefined
  try {
    mkdirSync(fixture); mkdirSync(channel)
    cpSync(path.join(REPO, 'dist'), path.join(fixture, 'dist'), { recursive: true })
    cpSync(path.join(REPO, 'service'), path.join(fixture, 'service'), { recursive: true })
    cpSync(path.join(REPO, 'package.json'), path.join(fixture, 'package.json'))
    const ui = path.join(fixture, 'dist', 'ui')
    await build({ entryPoints: [path.join(SHELL_DIR, 'test/fixtures/updateExperience.tsx')], outfile: path.join(ui, 'fixture.js'), bundle: true, format: 'iife', platform: 'browser', target: ['chrome140'], jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(REPO, 'node_modules')], logLevel: 'warning' })
    writeFileSync(path.join(ui, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
    const key = generateKeyPairSync('ed25519').privateKey
    const pub = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url')
    const version = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string
    const payload = Buffer.from(JSON.stringify({ schema: 1, version: '9.9.9', released: '2026-11-17T10:00:00.000Z', notes: 'https://github.com/pawellazarew/pult/releases/tag/v9.9.9', changelog: '# Pult9.9.9\n\n## English\n- English only note\n\n## Русский\n- **Изменение релиза**\n- Загрузка с настоящим процентом.\n\n![inert](/tmp/not-read.png) [inert file](/tmp/not-read.txt)\n\n<script>window.badRelease=true</script>', package: { url: 'https://example.invalid/pult-9.9.9.tgz', sha256: 'e'.repeat(64), size: 100 }, app: { version, minVersion: '0.1.13' } }))
    writeFileSync(path.join(channel, 'latest.json'), JSON.stringify({ schema: 1, keyId: createHash('sha256').update(pub).digest('hex').slice(0, 8), payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }))
    h = await launch({ name: 'update-experience', env: { PULT_UI_ROOT: fixture, PULT_UPDATE_URL: 'https://example.invalid/latest.json', PULT_TEST_UPDATE_DIR: channel, PULT_TEST_RELEASE_KEY: pub.toString('base64'), PULT_TEST_UPDATE_FIRST_MS: '0' } })
    const win = h.win
    assert.ok(await waitFor(async () => await win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    await win.getByTestId('update-indicator').click()
    const dialog = win.getByTestId('update-dialog')
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /Пульт 9\.9\.9/)
    assert.match(await win.getByTestId('release-notes').innerText(), /Изменение релиза/)
    assert.doesNotMatch(await win.getByTestId('release-notes').innerText(), /English only note/)
    assert.equal(await dialog.locator('img, iframe, script, [data-testid="file-link"]').count(), 0)
    assert.equal(await win.getByTestId('update-dialog-apply').innerText(), 'Перезапустить и обновить')
    await win.getByTestId('update-dialog-apply').focus()
    await win.keyboard.press('Tab')
    assert.ok(await dialog.locator('button').first().evaluate((el) => el === document.activeElement))
    await win.keyboard.press('Shift+Tab')
    assert.ok(await win.getByTestId('update-dialog-apply').evaluate((el) => el === document.activeElement))
    for (const theme of ['dark', 'light'] as const) { await h.scheme(theme); await h.screen(`update-experience-notes-${theme}`) }
    await win.keyboard.press('Escape')
    assert.equal(await dialog.count(), 0)
    assert.ok(await waitFor(async () => win.getByTestId('update-indicator').evaluate((el) => el === document.activeElement)))

    await win.getByTestId('open-settings').click()
    await win.getByTestId('settings-nav-updates').click()
    const auto = win.getByTestId('settings-update-auto')
    const before = await auto.isChecked()
    await auto.setChecked(!before)
    await win.getByTestId('settings-update-notes').click()
    await dialog.waitFor()
    assert.equal(await win.getByTestId('settings-dialog').isVisible(), false)
    await win.keyboard.press('Escape')
    assert.equal(await win.getByTestId('settings-dialog').isVisible(), true)
    assert.equal(await auto.isChecked(), !before, 'unsaved setting disappeared when notes closed')
    await win.keyboard.press('Escape')
    await win.locator('.settings-discard').waitFor()
    await win.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click()
    t.diagnostic('actual signed manifest notes + real Console modal/settings path qualified')

    const client = await h.client()
    const base = await client.request('update.status') as UpdateStatus
    const stage = { ...base, apply: { state: 'idle' as const }, staged: { to: '9.9.9', state: 'downloading' as const, error: null, at: 'x', progress: { received: 37, total: 100, percent: 37, artifact: 'package' as const } } }
    await win.evaluate((u) => { window.__updateExperienceFixture.setStatus(u); window.dispatchEvent(new Event('focus')) }, stage)
    assert.ok(await waitFor(async () => await win.getByTestId('update-indicator-percent').innerText().catch(() => '') === '37%', 5_000))
    await win.getByTestId('update-indicator').click()
    assert.equal(await win.getByTestId('update-dialog-percent').innerText(), '37%')
    assert.equal(await win.getByTestId('update-dialog-progress').getAttribute('aria-valuenow'), '37')
    await win.getByTestId('update-dialog-close').click()
    stage.staged.progress = { received: 58, total: 100, percent: 58, artifact: 'package' }
    await win.evaluate((u) => window.__updateExperienceFixture.setStatus(u), stage)
    const tracksClosed = await waitFor(async () => await win.getByTestId('update-indicator-percent').innerText().catch(() => '') === '58%', 5_000)
    if (!tracksClosed) t.diagnostic('closed-progress-failure ' + JSON.stringify(await win.evaluate(() => ({ stats: window.__updateExperienceFixture.stats(), conn: document.querySelector('.app')?.getAttribute('data-conn'), visibility: document.visibilityState, indicator: document.querySelector('[data-testid="update-indicator"]')?.getAttribute('data-state'), percent: document.querySelector('[data-testid="update-indicator-percent"]')?.textContent }))))
    assert.ok(tracksClosed, 'closed-dialog icon did not follow local status polling')
    await h.screen('update-experience-closed-progress')
    await win.getByTestId('update-indicator').click()
    assert.equal(await win.getByTestId('update-dialog-percent').innerText(), '58%')
    const waiting = { ...stage, apply: { state: 'waiting' as const, to: '9.9.9', since: 'x', turns: 2 } }
    await win.evaluate((u) => window.__updateExperienceFixture.setStatus(u), waiting)
    assert.ok(await waitFor(async () => await win.getByTestId('update-dialog-state').getAttribute('data-state') === 'waiting', 5_000))
    assert.match(await win.getByTestId('update-dialog-state').innerText(), /после окончания ходов/ )
    assert.equal(await win.getByTestId('update-dialog-percent').innerText(), '58%')
    assert.equal(await win.getByTestId('update-dialog-apply').innerText(), 'Сейчас')
    await win.evaluate((u) => window.__updateExperienceFixture.setStatus(u), stage)
    assert.ok(await waitFor(async () => await win.getByTestId('update-dialog-state').getAttribute('data-state') === 'downloading', 5_000))
    for (const theme of ['dark', 'light'] as const) { await h.scheme(theme); await h.screen(`update-experience-progress-${theme}`) }
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setMinimumSize(1, 1); BrowserWindow.getAllWindows()[0]!.setContentSize(320, 720) })
    assert.ok(await waitFor(async () => win.evaluate(() => innerWidth === 320)))
    await h.screen('update-experience-progress-320')
    assert.ok(await dialog.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth + 1 }))
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 760))
    stage.staged.progress = { received: 100, total: 100, percent: 100, artifact: 'package' }
    await win.evaluate((u) => window.__updateExperienceFixture.setStatus(u), stage)
    assert.ok(await waitFor(async () => await win.getByTestId('update-dialog-state').getAttribute('data-state') === 'preparing', 5_000))
    assert.equal(await win.getByTestId('update-dialog-percent').count(), 0)
    assert.equal(await win.getByTestId('update-indicator-percent').count(), 0)
    assert.match(await win.getByTestId('update-dialog-state').innerText(), /Подготавливаю пакет Пульта/)
    const unknown: UpdateStatus = structuredClone(stage); if (unknown.staged) delete unknown.staged.progress
    await win.evaluate((u) => window.__updateExperienceFixture.setStatus(u), unknown)
    assert.ok(await waitFor(async () => await win.getByTestId('update-dialog-state').getAttribute('data-state') === 'downloading', 5_000))
    assert.equal(await win.getByTestId('update-dialog-progress').getAttribute('aria-valuenow'), null)
    assert.equal(await win.getByTestId('update-dialog-percent').count(), 0)
    await win.evaluate(() => { window.__updateExperienceFixture.delay(1500); for (let n = 0; n < 5; n++) window.dispatchEvent(new Event('focus')) })
    await sleep(1800)
    assert.equal(await win.evaluate(() => window.__updateExperienceFixture.stats().peak), 1, 'status requests overlapped')
    await win.evaluate(() => window.__updateExperienceFixture.unmount())
    const calls = await win.evaluate(() => window.__updateExperienceFixture.stats().calls)
    await sleep(1300)
    assert.equal(await win.evaluate(() => window.__updateExperienceFixture.stats().calls), calls, 'unmounted Console kept polling')
    t.diagnostic('percent cases use explicit UI transport snapshots; actual file-byte/verification progress is qualified by backend integration tests')
  } finally { await h?.close(); rmSync(scratch, { recursive: true, force: true }) }
})
