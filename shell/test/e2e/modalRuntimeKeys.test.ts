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

type Trigger = 'none' | 'escape' | 'native'
interface State { expanded: boolean; modal: boolean; nativeVisible: boolean; discard: boolean; saves: number }
declare global {
  interface Window {
    __modalRuntimeKeys: { open(trigger: Trigger): void; probe(trigger: Trigger): void; nativeEscape(): void; snapshot(): State; probes(): Array<{ beforePassive: boolean; expanded: boolean; modal: boolean; nativeVisible: boolean }> }
  }
}

it('settings owns Escape at the modal layout commit before passive effects', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pult-modal-keys-'))
  let app: ElectronApplication | undefined
  let passed = false
  let joined = false
  let closed = false
  try {
    await build({
      entryPoints: [path.join(SHELL_DIR, 'test/fixtures/modalRuntimeKeys.tsx')], outfile: path.join(dir, 'fixture.js'),
      bundle: true, format: 'iife', platform: 'browser', target: ['chrome140'], jsx: 'automatic', minify: true,
      define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(REPO, 'node_modules')], logLevel: 'warning',
    })
    writeFileSync(path.join(dir, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
    writeFileSync(path.join(dir, 'main.cjs'), `
      const { app, BrowserWindow, session } = require('electron');
      const path = require('node:path'); const { pathToFileURL } = require('node:url');
      app.setPath('userData', path.join(__dirname, 'userData'));
      app.commandLine.appendSwitch('use-mock-keychain');
      app.whenReady().then(() => {
        const isolated = session.fromPartition('modal-keys-private');
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
      const snap = async () => page.evaluate(() => window.__modalRuntimeKeys.snapshot())
      const frames = async () => { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))) }
      const expand = page.getByTestId('runtime-expand')
      await expand.waitFor()
      await expand.click()
      assert.ok(await waitFor(async () => (await snap()).expanded && (await snap()).nativeVisible), 'expanded synthetic native view not ready')
      await page.evaluate(() => window.__modalRuntimeKeys.open('escape'))
      await frames()
      const probe = await page.evaluate(() => window.__modalRuntimeKeys.probes()[0])
      const after = await snap()
      t.diagnostic('layout Escape state ' + JSON.stringify({ probe, after }))
      assert.deepEqual(probe, { beforePassive: true, expanded: true, modal: true, nativeVisible: false })
      assert.equal(after.expanded, true, 'modal Escape folded the expanded browser')
      assert.equal(after.modal, false, 'modal Escape did not close settings')
      assert.equal(after.nativeVisible, true, 'native view did not restore after settings closed')
      t.diagnostic('modal layout Escape closes only settings and restores expanded view: PASS')
      await page.keyboard.press('Escape')
      await frames()
      assert.deepEqual(await snap(), { expanded: false, modal: false, nativeVisible: false, discard: false, saves: 0 })
      t.diagnostic('next Escape belongs to the browser again: PASS')

      await expand.click()
      assert.ok(await waitFor(async () => (await snap()).nativeVisible))
      await page.evaluate(() => window.__modalRuntimeKeys.open('native'))
      await frames()
      assert.equal((await snap()).expanded, true)
      assert.equal((await snap()).modal, true)
      assert.equal((await snap()).nativeVisible, false)
      await page.evaluate(() => window.__modalRuntimeKeys.nativeEscape())
      await frames()
      assert.equal((await snap()).expanded, true, 'late native Escape folded browser under settings')
      assert.equal((await snap()).modal, true)
      t.diagnostic('layout-boundary and later native IPC cannot fold an obstructed browser: PASS')

      await page.getByTestId('settings-nav-general').click()
      const language = page.getByTestId('settings-language')
      await language.selectOption('en')
      await page.keyboard.press('Escape')
      await frames()
      assert.equal((await snap()).discard, true)
      assert.equal((await snap()).modal, true)
      assert.equal((await snap()).expanded, true)
      assert.equal(await language.inputValue(), 'en', 'dirty modal lost draft content')
      await page.keyboard.press('Control+Enter')
      await frames()
      assert.equal((await snap()).saves, 1, 'save shortcut was lost or invoked twice')
      assert.equal((await snap()).expanded, true)
      assert.equal(await language.inputValue(), 'en')
      await page.keyboard.press('Control+Comma')
      await frames()
      assert.equal((await snap()).discard, true)
      assert.equal((await snap()).modal, true)
      await page.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click()
      await frames()
      assert.equal((await snap()).modal, false)
      assert.equal((await snap()).expanded, true)
      assert.equal((await snap()).nativeVisible, true)
      t.diagnostic('dirty settings retain discard confirmation/draft; save and close shortcuts keep priority: PASS')

      await page.evaluate(() => window.__modalRuntimeKeys.open('none'))
      await page.getByTestId('settings-dialog').waitFor()
      await page.keyboard.press('Control+Comma')
      await frames()
      assert.equal((await snap()).modal, false)
      assert.equal((await snap()).expanded, true)
      assert.equal((await snap()).nativeVisible, true)
      await page.evaluate(() => window.__modalRuntimeKeys.nativeEscape())
      await frames()
      assert.equal((await snap()).expanded, false, 'native IPC did not regain browser ownership after modal closed')
      t.diagnostic('clean settings close shortcut and unobstructed native IPC preserve normal ownership: PASS')
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
