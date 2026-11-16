import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'
import type { ElectronApplication } from 'playwright-core'
import { REPO, SHELL_DIR, waitFor } from './harness.js'

interface Scenario { session?: string; end?: number; lite?: boolean; output?: string; language?: 'ru' | 'en'; running?: boolean; success?: boolean }
declare global {
  interface Window {
    __toolStability: { show(s: Scenario): void; requests(): number; resolve(index: number): void; reject(index: number): void }
    __toolStabilityRow?: Element | null
    __toolStabilityHeader?: Element | null
  }
}

it('mounted compact tool error survives lite history without leaking into another result', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pult-tool-preview-'))
  let app: ElectronApplication | undefined
  let passed = false
  let joined = false
  let closed = false
  try {
    await build({
      entryPoints: [path.join(SHELL_DIR, 'test/fixtures/toolResultStability.tsx')], outfile: path.join(dir, 'fixture.js'),
      bundle: true, format: 'iife', platform: 'browser', target: ['chrome140'], jsx: 'automatic', minify: true,
      define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(REPO, 'node_modules')], logLevel: 'warning',
    })
    writeFileSync(path.join(dir, 'index.html'), '<meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
    writeFileSync(path.join(dir, 'main.cjs'), `
      const { app, BrowserWindow, session } = require('electron');
      const path = require('node:path'); const { pathToFileURL } = require('node:url');
      app.setPath('userData', path.join(__dirname, 'userData'));
      app.commandLine.appendSwitch('use-mock-keychain');
      app.whenReady().then(() => {
        const isolated = session.fromPartition('tool-preview-private');
        const prefix = pathToFileURL(__dirname + path.sep).href;
        isolated.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(prefix) && !d.url.startsWith('data:') && d.url !== 'about:blank' }));
        const w = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: {
          nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, session: isolated,
        } });
        w.loadFile(path.join(__dirname, 'index.html'));
      });
      app.on('window-all-closed', () => app.quit());
    `)
    mkdirSync(path.join(dir, 'home'))
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)('electron') as string,
      args: [path.join(dir, 'main.cjs')],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: path.join(dir, 'home'), TMPDIR: tmpdir(), LANG: 'ru_RU.UTF-8' },
    })
    const child = app.process()
    const exited = once(child, 'exit')
    try {
      const page = await app.firstWindow()
      const preview = page.getByTestId('tool-error-preview')
      const has = async (text: string): Promise<boolean> => (await preview.textContent())?.includes(text) ?? false
      const loading = async (): Promise<boolean> => (await page.getByTestId('tool-detail-loading').count()) === 1
      const show = async (s: Scenario): Promise<void> => {
        await page.evaluate((value) => window.__toolStability.show(value), s)
        assert.ok(await waitFor(async () => await page.locator('[data-fixture-session]').evaluate((el, value) =>
          el.getAttribute('data-fixture-session') === (value.session ?? 'fixture') && el.getAttribute('data-fixture-end') === String(value.end ?? 2)
          && el.getAttribute('data-fixture-lite') === String(Boolean(value.lite)), s)), 'scenario did not commit')
      }
      const settle = async (index: number, reject = false): Promise<void> => {
        await page.evaluate(({ index, reject }) => reject ? window.__toolStability.reject(index) : window.__toolStability.resolve(index), { index, reject })
        assert.ok(await waitFor(async () => !(await loading())), 'details did not settle')
      }
      assert.ok(await waitFor(() => has('Не найден тестовый пакет')), 'full baseline missing original diagnostic')
      await page.evaluate(() => { window.__toolStabilityRow = document.querySelector('[data-testid="tool-row"]') })
      await show({ lite: true })
      assert.ok(await waitFor(loading), 'controlled details request not pending')
      assert.equal(await page.evaluate(() => window.__toolStabilityRow === document.querySelector('[data-testid="tool-row"]')), true)
      assert.equal(await has('Не найден тестовый пакет'), true, 'original diagnostic disappeared while same-row details pending')
      await settle(0)
      assert.equal(await has('Не найден тестовый пакет'), true)
      assert.equal(await page.locator('.tool-raw').getAttribute('open'), null)
      t.diagnostic('same-row full/lite pending/resolved original diagnostic: PASS')

      // Rejection must keep only the committed compact diagnostic, not the raw output.
      await show({ session: 'reject' })
      assert.ok(await waitFor(() => has('Не найден тестовый пакет')))
      await show({ session: 'reject', lite: true })
      assert.ok(await waitFor(loading))
      await settle(1, true)
      assert.equal(await has('Не найден тестовый пакет'), true)
      assert.equal(await page.locator('.tool-raw').textContent().then((s) => s?.includes('Не найден тестовый пакет')), false)
      t.diagnostic('details rejection retains compact presentation without retaining raw output: PASS')

      // Same numeric event ids in another session must not inherit the old presentation.
      await show({ session: 'other', lite: true, output: 'CURRENT_RESULT' })
      assert.ok(await waitFor(loading))
      assert.equal(await has('Не найден тестовый пакет'), false)
      await settle(2)
      assert.equal(await has('CURRENT_RESULT'), true)
      t.diagnostic('cross-session result isolation: PASS')

      // A new completion resets presentation; a late old request cannot overwrite it.
      await show({ session: 'stale', lite: true, output: 'STALE_RESULT' })
      assert.ok(await waitFor(loading))
      await show({ session: 'stale', end: 3, lite: true, output: 'NEW_RESULT' })
      assert.ok(await waitFor(async () => await page.evaluate(() => window.__toolStability.requests()) === 5))
      await page.evaluate(() => window.__toolStability.resolve(3))
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      assert.equal(await loading(), true)
      assert.equal(await has('STALE_RESULT'), false)
      await settle(4)
      assert.equal(await has('NEW_RESULT'), true)
      await show({ session: 'stale', end: 4, lite: true, output: 'LATEST_RESULT' })
      assert.ok(await waitFor(loading))
      assert.equal(await has('NEW_RESULT'), false)
      await settle(5)
      t.diagnostic('new completion reset and stale request isolation: PASS')

      // Locale changes cannot reuse a translated classifier from the old locale.
      await show({ session: 'locale' })
      assert.ok(await waitFor(() => has('Команда не выполнена')))
      await show({ session: 'locale', lite: true, language: 'en' })
      assert.ok(await waitFor(loading))
      assert.equal(await has('Команда не выполнена'), false)
      await settle(6, true)
      t.diagnostic('locale isolation: PASS')

      await show({ session: 'caps', output: 'OLD_PREFIX\n0\n1\n2\n3\n4\n' + 'x'.repeat(2000) + 'LAST' })
      assert.ok(await waitFor(() => has('LAST')))
      await show({ session: 'caps', lite: true })
      assert.ok(await waitFor(loading))
      const tail = (await preview.locator('pre').textContent()) ?? ''
      assert.equal(tail.length, 1600)
      assert.ok(tail.split('\n').length <= 6)
      assert.ok(tail.endsWith('LAST') && !tail.includes('OLD_PREFIX'))
      await settle(7, true)
      await show({ session: 'line-cap', output: Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n') })
      assert.ok(await waitFor(() => has('line-29')))
      await show({ session: 'line-cap', lite: true })
      assert.ok(await waitFor(loading))
      assert.equal(((await preview.locator('pre').textContent()) ?? '').split('\n').length, 6)
      assert.equal(await has('line-0'), false)
      await settle(8, true)
      t.diagnostic('retained preview 1600 UTF16 / six nonempty lines bounds: PASS')
      // Opening a running tool is independent of the completion's details owner.
      await show({ session: 'running-open', running: true, lite: true })
      assert.equal(await page.locator('button.tool-row').getAttribute('aria-expanded'), 'false')
      await page.locator('button.tool-row').click()
      assert.equal(await page.locator('button.tool-row').evaluate((el) => document.activeElement === el), true)
      await page.evaluate(() => { window.__toolStabilityHeader = document.querySelector('button.tool-row') })
      assert.ok(await waitFor(loading))
      await show({ session: 'running-open', end: 3, success: true, lite: true, output: 'SUCCESS_RESULT' })
      assert.ok(await waitFor(async () => await page.evaluate(() => window.__toolStability.requests()) === 11))
      assert.equal(await page.locator('button.tool-row').getAttribute('aria-expanded'), 'true', 'completion collapsed manually opened running tool')
      assert.equal(await page.evaluate(() => window.__toolStabilityHeader === document.querySelector('button.tool-row')), true, 'completion replaced the header DOM')
      assert.equal(await page.evaluate(() => document.activeElement === window.__toolStabilityHeader), true, 'completion dropped keyboard focus')
      await page.evaluate(() => window.__toolStability.resolve(9))
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      assert.equal(await loading(), true, 'stale running details replaced pending completion details')
      await settle(10)
      assert.ok((await page.locator('.tool-raw').textContent())?.includes('SUCCESS_RESULT'))
      t.diagnostic('running tool preserves open state, header DOM and keyboard focus on success; fresh completion loaded: PASS')
      passed = true
    } finally {
      await app.close()
      const exit = await Promise.race([exited, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('owned component Electron exit unconfirmed')), 5000)
        timer.unref()
      })])
      joined = child.exitCode !== null || child.signalCode !== null
      assert.equal(joined, true)
      assert.equal(exit[0], 0)
      closed = true
      t.diagnostic('owned component Electron main exit joined: PASS')
    }
  } finally {
    if (passed && joined && closed) rmSync(dir, { recursive: true, force: true })
  }
})
