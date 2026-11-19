import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron } from 'playwright-core'
import type { ElectronApplication } from 'playwright-core'
import { REPO, SHELL_DIR, waitFor } from './harness.js'

interface Trace {
  calls: Array<{ id: number; pid: number; version: string | null }>
  restartCalls: Array<{ id: number; outcome: string }>
  otherCalls: string[]
  heldInventory: number[]
  heldRestart: number[]
  acknowledged: string[]
  refreshStatusCalls: number
  clock: number
}
declare global {
  interface Window {
    __providerUpdatesFixture: {
      snapshot(): Trace
      setDaemon(pid: number, version: number): void
      setInventory(version: number): void
      holdNextInventory(): void
      releaseInventory(id: number): void
      setRestart(outcome: 'cancel' | 'confirm' | 'lost', hold: boolean): void
      releaseRestart(id: number): void
      advance(ms: number): void
      focusBurst(count: number): void
    }
  }
}

it('provider update hook joins old probes, throttles focus and only acknowledges retained installation state', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pult-provider-hook-'))
  let app: ElectronApplication | undefined
  let exited: Promise<unknown> | undefined
  try {
    console.info('provider-hook: build mounted fixture')
    await build({ entryPoints: [path.join(SHELL_DIR, 'test/fixtures/providerUpdates.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, format: 'iife', platform: 'browser', target: ['chrome140'], jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(REPO, 'node_modules')], logLevel: 'warning' })
    writeFileSync(path.join(dir, 'index.html'), '<meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
    writeFileSync(path.join(dir, 'main.cjs'), `
      const { app, BrowserWindow, session } = require('electron');
      const path = require('node:path'); const { pathToFileURL } = require('node:url');
      app.setPath('userData', path.join(__dirname, 'userData'));
      app.commandLine.appendSwitch('use-mock-keychain');
      app.whenReady().then(() => {
        const isolated = session.fromPartition('provider-updates-private');
        const prefix = pathToFileURL(__dirname + path.sep).href;
        isolated.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(prefix) && !d.url.startsWith('data:') && d.url !== 'about:blank' }));
        const window = new BrowserWindow({ width: 900, height: 700, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, session: isolated } });
        window.loadFile(path.join(__dirname, 'index.html'));
      }); app.on('window-all-closed', () => app.quit());
    `)
    mkdirSync(path.join(dir, 'home'))
    console.info('provider-hook: launch isolated Electron')
    app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron') as string, args: [path.join(dir, 'main.cjs')], timeout: 10000, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: path.join(dir, 'home'), TMPDIR: tmpdir(), LANG: 'ru_RU.UTF-8', PULT_TEST: '1' } })
    exited = once(app.process(), 'exit')
    const page = await app.firstWindow({ timeout: 5000 })
    page.on('pageerror', error => console.info(`provider-hook: renderer error: ${error.message}`))
    page.setDefaultTimeout(5000)
    console.info('provider-hook: wait for initial owned probe')
    const snapshot = () => page.evaluate(() => window.__providerUpdatesFixture.snapshot())
    const state = page.getByTestId('fixture-provider-state')
    const notices = page.getByTestId('fixture-provider-notice')
    const changed = page.locator('[data-testid="fixture-provider-notice"][data-action="reconnect"]')
    const observation = async (): Promise<{ daemon: string; tools: Array<{ version: string }>; baseline: Record<string, string> } | null> => JSON.parse(await page.getByTestId('fixture-provider-observation').textContent() ?? 'null')
    const settled = () => waitFor(async () => await state.getAttribute('data-checking') === '0' && await state.getAttribute('data-reconnecting') === '0', 5000)
    await state.waitFor({ state: 'attached' })
    assert.ok(await waitFor(async () => (await snapshot()).heldInventory.includes(1), 5000))
    const daemonA = await state.getAttribute('data-daemon')
    await page.evaluate(() => {
      window.__providerUpdatesFixture.setInventory(2)
      window.__providerUpdatesFixture.holdNextInventory()
      window.__providerUpdatesFixture.setDaemon(2, 2)
    })
    assert.ok(await waitFor(async () => await state.getAttribute('data-daemon') !== daemonA, 5000))
    await page.evaluate(() => window.__providerUpdatesFixture.focusBurst(20))
    assert.equal((await snapshot()).calls.length, 1, 'daemon switch launched a competing probe before old ownership joined')
    await page.evaluate(() => window.__providerUpdatesFixture.releaseInventory(1))
    assert.ok(await waitFor(async () => (await snapshot()).heldInventory.includes(2), 5000))
    assert.equal(await observation(), null, 'old daemon result became a new daemon observation while the fresh probe was held')
    assert.ok(!(await snapshot()).acknowledged.includes(daemonA!))
    assert.deepEqual((await snapshot()).calls.map(call => call.pid), [1, 2])
    await page.evaluate(() => window.__providerUpdatesFixture.releaseInventory(2))
    assert.ok(await settled())
    const observedB = await observation()
    assert.equal(observedB?.daemon, await state.getAttribute('data-daemon'))
    assert.equal(observedB?.tools[0]?.version, 'codex-cli 2.0')
    assert.match(observedB?.baseline['codex'] ?? '', /codex-2/)
    assert.equal(await notices.count(), 0)
    console.info('provider-hook: old daemon reply discarded; fresh probe acknowledged')

    // The real hook sees a controlled wall clock; this never sleeps through the 60-second poll.
    await page.evaluate(() => {
      window.__providerUpdatesFixture.focusBurst(20)
      window.__providerUpdatesFixture.advance(14999)
      window.__providerUpdatesFixture.focusBurst(20)
    })
    assert.equal((await snapshot()).calls.length, 2)
    await page.evaluate(() => {
      window.__providerUpdatesFixture.advance(1)
      window.__providerUpdatesFixture.holdNextInventory()
      window.__providerUpdatesFixture.focusBurst(20)
    })
    assert.ok(await waitFor(async () => (await snapshot()).heldInventory.includes(3), 5000))
    assert.equal((await snapshot()).calls.length, 3, 'focus burst bypassed single-flight')
    await page.evaluate(() => window.__providerUpdatesFixture.focusBurst(20))
    assert.equal((await snapshot()).calls.length, 3)
    await page.evaluate(() => window.__providerUpdatesFixture.releaseInventory(3))
    assert.ok(await settled())
    console.info('provider-hook: focus throttle and single-flight passed')

    await page.evaluate(() => window.__providerUpdatesFixture.setInventory(3))
    await page.getByTestId('fixture-provider-refresh').click()
    assert.ok(await waitFor(async () => (await snapshot()).calls.length === 4 && await changed.count() === 1, 5000))
    assert.equal(await notices.first().getAttribute('data-action'), 'reconnect')
    assert.match(await notices.first().innerText(), /codex-cli 3.0/)
    assert.equal((await snapshot()).restartCalls.length, 0, 'inventory discovery restarted a provider automatically')

    await page.evaluate(() => window.__providerUpdatesFixture.setRestart('cancel', false))
    await page.getByTestId('fixture-provider-reconnect').click()
    assert.ok(await settled())
    assert.equal((await snapshot()).restartCalls.length, 1)
    assert.equal((await snapshot()).refreshStatusCalls, 0)
    assert.equal(await notices.count(), 1, 'cancelling restart acknowledged the update')
    console.info('provider-hook: discovery never restarts; explicit cancellation retained update')

    await page.evaluate(() => {
      window.__providerUpdatesFixture.setRestart('confirm', true)
      const button = document.querySelector<HTMLButtonElement>('[data-testid="fixture-provider-reconnect"]')!
      button.click(); button.click()
    })
    assert.ok(await waitFor(async () => (await snapshot()).heldRestart.includes(2), 5000))
    assert.equal((await snapshot()).restartCalls.length, 2, 'duplicate reconnect started a second owned restart')
    assert.equal(await state.getAttribute('data-reconnecting'), '1')
    assert.equal(await notices.count(), 1)
    await page.evaluate(() => window.__providerUpdatesFixture.releaseRestart(2))
    assert.ok(await settled())
    assert.equal((await snapshot()).refreshStatusCalls, 1)
    assert.equal(await notices.count(), 1, 'a true restart reply alone acknowledged a CLI file')
    console.info('provider-hook: duplicate restart guarded; true reply did not acknowledge a file')

    await page.evaluate(() => window.__providerUpdatesFixture.setDaemon(3, 2))
    assert.ok(await waitFor(async () => (await observation())?.daemon === await state.getAttribute('data-daemon') && (await snapshot()).calls.length === 6 && await state.getAttribute('data-checking') === '0', 5000))
    assert.equal(await notices.count(), 1, 'new daemon PID with the old retained installation acknowledged the update')
    await page.evaluate(() => window.__providerUpdatesFixture.setDaemon(4, 3))
    assert.ok(await waitFor(async () => (await snapshot()).calls.length === 7 && await notices.count() === 0 && await state.getAttribute('data-checking') === '0', 5000))
    console.info('provider-hook: only new daemon retained fingerprint acknowledged update')

    await page.evaluate(() => window.__providerUpdatesFixture.setInventory(4))
    await page.getByTestId('fixture-provider-refresh').click()
    assert.ok(await waitFor(async () => (await snapshot()).calls.length === 8 && await notices.count() === 1, 5000))
    await page.evaluate(() => window.__providerUpdatesFixture.setRestart('lost', false))
    await page.getByTestId('fixture-provider-reconnect').click()
    assert.ok(await waitFor(async () => (await page.getByTestId('fixture-provider-error').textContent())?.includes('не подтверждено') === true, 5000))
    assert.equal((await snapshot()).restartCalls.length, 3)
    assert.equal((await snapshot()).refreshStatusCalls, 1)
    assert.equal(await notices.filter({ hasText: 'Не удалось проверить подключение CLI' }).getAttribute('data-action'), 'check')
    assert.equal(await notices.filter({ hasText: 'CLI изменился' }).count(), 1, 'lost restart reply cleared the update')
    assert.deepEqual((await snapshot()).otherCalls, [], 'observation invoked auth, installer, doctor or an unrelated RPC')
  } finally {
    await app?.close()
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
})
