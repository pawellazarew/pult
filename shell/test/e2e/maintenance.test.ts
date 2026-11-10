import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { launch, sleep, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('window maintenance controls', () => {
  let h: Harness
  before(async () => { h = await launch({ name: 'maintenance', backoff: '100,400' }) })
  after(async () => { await h?.close() })
  const dialog = async (response: number) => h.app.evaluate(({ dialog }, value) => {
    dialog.showMessageBox = (async () => ({ response: value, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, response)

  it('opens a discoverable panel with selected CLI paths and daemon status', async () => {
    await h.win.getByTestId('open-maintenance').click()
    await h.win.getByTestId('maintenance-panel').waitFor()
    assert.ok(await waitFor(async () => (await h.win.getByTestId('maintenance-daemon-state').textContent()) === 'Работает'))
    assert.ok(await waitFor(async () => (await h.win.getByTestId('maintenance-path-claude').textContent())?.includes('fake-claude.mjs') ?? false))
    assert.ok(await waitFor(async () => (await h.win.getByTestId('maintenance-path-codex').textContent())?.includes('fake-codex-app-server.mjs') ?? false))
    assert.equal(await h.win.getByTestId('maintenance-start').isDisabled(), true)
    assert.equal(await h.win.getByTestId('maintenance-restart').isEnabled(), true)
    await h.shot('control-center')
    await h.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      window.setMinimumSize(240, 320)
      window.setContentSize(390, 812)
    })
    assert.ok(await waitFor(async () => h.win.evaluate(() => innerWidth === 390)))
    const bounds = await h.win.getByTestId('maintenance-panel').boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390)
    await h.shot('control-center-phone')
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 788))
    assert.ok(await waitFor(async () => h.win.evaluate(() => innerWidth === 1280)))
    await h.win.setViewportSize({ width: 760, height: 720 })
    await h.shot('control-center-narrow')
    await h.win.setViewportSize({ width: 1280, height: 820 })
  })

  it('restart cancellation preserves the process and confirmation waits for a new daemon', async () => {
    const old = h.daemonPid()
    assert.ok(old)
    await dialog(1)
    await h.win.getByTestId('maintenance-restart').click()
    assert.ok(await waitFor(async () => await h.win.getByTestId('maintenance-restart').isEnabled()))
    assert.equal(h.daemonPid(), old)
    await dialog(0)
    await h.win.getByTestId('maintenance-restart').click()
    assert.ok(await waitFor(async () => {
      const pid = h.daemonPid()
      return !!pid && pid !== old && await h.win.getAttribute('.app', 'data-conn') === 'up'
    }, 25_000), 'restart did not reconnect to a new process')
    assert.equal(await h.win.getByTestId('maintenance-error').count(), 0)
  })

  it('intentional stop stays stopped and offline doctor still returns a report', async () => {
    await h.win.getByTestId('maintenance-doctor').click()
    assert.ok(await waitFor(async () => await h.win.getByTestId('maintenance-copy-report').isEnabled(), 25_000))
    await h.win.getByTestId('maintenance-copy-report').click()
    assert.ok(await waitFor(async () => (await h.app.evaluate(() => (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard ?? '')).includes('\"items\"')))
    const before = JSON.parse(await h.app.evaluate(() => (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard ?? '')) as { generatedAt: string }
    await dialog(0)
    await h.win.getByTestId('maintenance-stop').click()
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'down'))
    await sleep(800)
    assert.equal(h.daemonPid(), null)
    await h.win.getByTestId('maintenance-doctor').click()
    assert.ok(await waitFor(async () => {
      if (await h.win.getByTestId('maintenance-doctor').textContent() !== 'Запустить диагностику') return false
      await h.win.getByTestId('maintenance-copy-report').click()
      const text = await h.app.evaluate(() => (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard ?? '')
      try { return (JSON.parse(text) as { generatedAt: string }).generatedAt !== before.generatedAt } catch { return false }
    }, 25_000), 'offline doctor did not produce a fresh report')
    assert.equal(h.daemonPid(), null, 'doctor must not start the daemon')
    assert.equal(await h.win.getByTestId('maintenance-error').count(), 0)
    const copied = await h.app.evaluate(() => (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard ?? '')
    const report = JSON.parse(copied) as { home: string; generatedAt: string; items: Array<{ id: string; status: string }> }
    assert.equal(report.home, h.home)
    assert.notEqual(report.generatedAt, before.generatedAt)
    assert.notEqual(report.items.find(item => item.id === 'daemon')?.status, 'ok')
    await h.shot('offline-diagnostics')
    await h.win.getByTestId('maintenance-start').click()
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 25_000))
  })

  it('provider enum actions preserve cancellation and report an isolated Terminal handoff', async () => {
    await dialog(1)
    await h.win.getByTestId('maintenance-login-claude').click()
    assert.equal(await h.win.getByTestId('maintenance-operation').count(), 0)
    await dialog(0)
    await h.win.getByTestId('maintenance-login-claude').click()
    assert.ok(await waitFor(async () => await h.win.getByTestId('maintenance-operation').getAttribute('data-state') === 'succeeded'))
    const scripts = await h.app.evaluate(() => (globalThis as { __pultTestMaintenanceScripts?: string[] }).__pultTestMaintenanceScripts ?? [])
    assert.equal(scripts.length, 1)
    assert.match(readFileSync(scripts[0]!, 'utf8'), /auth login/)
    assert.match(readFileSync(scripts[0]!, 'utf8'), /env -i/)
    await h.win.getByTestId('maintenance-panel').getByRole('button', { name: 'Готово', exact: true }).click()
    await h.win.getByTestId('open-maintenance').click()
    assert.ok(await waitFor(async () => await h.win.getByTestId('maintenance-operation').getAttribute('data-state') === 'succeeded'))
    const denied = await h.win.evaluate(async () => {
      try { await window.pult!.providerAction!('claude' as 'claude', 'arbitrary' as 'login'); return null }
      catch (error) { return (error as { code?: string }).code }
    })
    assert.equal(denied, 'invalid_params')
  })
})
