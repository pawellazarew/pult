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
import { REPO, RESULTS, SHELL_DIR, waitFor } from './harness.js'

interface State { active: boolean; globalEscapes: number; calls: Array<{ method: string; params: Record<string, unknown> }> }
declare global {
  interface Window {
    __memoryDialog: { snapshot(): State; delayGet(id: string): void; releaseGet(): void; loseNextReply(): void; openAtLayout(): void }
  }
}

it('memory dialog preserves dirty edits, rejects stale reads and retries the exact committed command', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pult-memory-dialog-'))
  let app: ElectronApplication | undefined
  let exited: Promise<unknown> | undefined
  try {
    await build({ entryPoints: [path.join(SHELL_DIR, 'test/fixtures/memoryDialog.tsx')], outfile: path.join(dir, 'fixture.js'), bundle: true, format: 'iife', platform: 'browser', target: ['chrome140'], jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [path.join(REPO, 'node_modules')], logLevel: 'warning' })
    writeFileSync(path.join(dir, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
    writeFileSync(path.join(dir, 'main.cjs'), `
      const { app, BrowserWindow, session } = require('electron');
      const path = require('node:path'); const { pathToFileURL } = require('node:url');
      app.setPath('userData', path.join(__dirname, 'userData'));
      app.commandLine.appendSwitch('use-mock-keychain');
      app.whenReady().then(() => {
        const isolated = session.fromPartition('memory-dialog-private');
        const prefix = pathToFileURL(__dirname + path.sep).href;
        isolated.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(prefix) && !d.url.startsWith('data:') && d.url !== 'about:blank' }));
        const window = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, session: isolated } });
        window.loadFile(path.join(__dirname, 'index.html'));
      }); app.on('window-all-closed', () => app.quit());
    `)
    mkdirSync(path.join(dir, 'home'))
    app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron') as string, args: [path.join(dir, 'main.cjs')], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: path.join(dir, 'home'), TMPDIR: tmpdir(), LANG: 'ru_RU.UTF-8' } })
    exited = once(app.process(), 'exit')
    const page = await app.firstWindow()
    const dialog = page.getByTestId('memory-dialog')
    const row = (id: string) => page.locator(`[data-testid="memory-row"][data-memory-id="${id}"]`)
    const snapshot = () => page.evaluate(() => window.__memoryDialog.snapshot())
    await row('first').waitFor()
    await row('first').click()
    await page.getByTestId('memory-edit').click()
    await page.getByTestId('memory-name').fill('Мой черновик')
    await page.getByTestId('memory-reason').fill('Проверено')
    await page.keyboard.press('Escape')
    await page.getByTestId('memory-discard').waitFor()
    assert.equal((await snapshot()).globalEscapes, 0)
    await page.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click()
    assert.equal(await page.getByTestId('memory-name').inputValue(), 'Мой черновик')
    await row('second').click()
    await page.getByTestId('memory-discard').waitFor()
    await page.getByTestId('memory-discard-confirm').click()
    await page.getByTestId('memory-detail').getByRole('heading', { name: 'Вторая запись', exact: true }).waitFor()

    await page.evaluate(() => window.__memoryDialog.delayGet('first'))
    await row('first').click()
    await row('second').click()
    await page.getByTestId('memory-detail').getByRole('heading', { name: 'Вторая запись', exact: true }).waitFor()
    await page.evaluate(() => window.__memoryDialog.releaseGet())
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(await page.getByTestId('memory-detail').getByRole('heading', { name: 'Вторая запись', exact: true }).count(), 1)

    // A read already started belongs to this mounted dialog even while it is hidden.
    await page.evaluate(() => window.__memoryDialog.delayGet('first'))
    await row('first').click()
    await page.getByTestId('memory-close').click()
    await dialog.waitFor({ state: 'detached' })
    await page.evaluate(() => window.__memoryDialog.releaseGet())
    await page.getByTestId('fixture-memory-open').click()
    await page.getByTestId('memory-detail').getByRole('heading', { name: 'Первая запись', exact: true }).waitFor()
    await row('second').click()
    await page.getByTestId('memory-detail').getByRole('heading', { name: 'Вторая запись', exact: true }).waitFor()

    await page.getByTestId('memory-edit').click()
    await page.getByTestId('memory-name').fill('Сохранено однажды')
    await page.getByTestId('memory-reason').fill('Поправка')
    await page.evaluate(() => window.__memoryDialog.loseNextReply())
    await page.getByTestId('memory-save').click()
    await page.getByTestId('memory-pending').waitFor()
    assert.equal(await page.getByTestId('memory-save').isDisabled(), true)
    const firstRequest = (await snapshot()).calls.filter(call => call.method === 'memory.update')
    assert.equal(firstRequest.length, 1)
    await page.keyboard.press('Escape')
    await page.getByTestId('memory-discard-confirm').click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByTestId('fixture-memory-open').click()
    await page.getByTestId('memory-pending').waitFor()
    assert.equal(await page.getByTestId('memory-name').inputValue(), 'Сохранено однажды')
    await page.getByTestId('memory-pending-retry').click()
    await page.getByTestId('memory-notice').waitFor()
    assert.equal(await page.getByTestId('memory-pending').count(), 0)
    const updates = (await snapshot()).calls.filter(call => call.method === 'memory.update')
    assert.equal(updates.length, 2)
    assert.deepEqual(updates[1], updates[0], 'transport retry changed the command or payload')
    assert.equal(await page.getByTestId('memory-detail').getByRole('heading', { name: 'Сохранено однажды', exact: true }).count(), 1)

    await page.getByTestId('memory-close').focus()
    await page.keyboard.press('Tab')
    assert.equal(await dialog.locator('.dlg-h button').evaluate(element => element === document.activeElement), true)
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.getByTestId('memory-close').evaluate(element => element === document.activeElement), true)
    mkdirSync(RESULTS, { recursive: true })
    await page.screenshot({ path: path.join(RESULTS, 'memoryDialog-light.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: path.join(RESULTS, 'memoryDialog-dark.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(490, 760))
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.ok(await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight }))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.getByTestId('memory-close').click()
    await dialog.waitFor({ state: 'detached' })
    // Dialog detachment precedes its owned requestAnimationFrame focus restoration.
    assert.ok(await waitFor(async () => page.getByTestId('fixture-memory-open').evaluate(element => element === document.activeElement)), 'focus did not return to the opener after closing the dialog')
    await page.evaluate(() => window.__memoryDialog.openAtLayout())
    assert.ok(await waitFor(async () => !(await snapshot()).active))
    assert.equal((await snapshot()).globalEscapes, 0, 'layout-boundary Escape reached the underlying window')
  } finally {
    await app?.close()
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
})
