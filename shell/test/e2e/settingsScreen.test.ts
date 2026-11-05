import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('settings workspace: navigation, drafts and returning to work', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'settings-screen' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
    const c = await h.client()
    await c.request('agent.start', { name: 'settings-ux', kind: 'claude', cwd: h.workDir('settings-ux') })
    await h.win.getByTestId('agent-row').click()
    await h.win.getByTestId('composer').fill('Сохрани этот черновик')
  })
  after(async () => { await h?.close() })
  it('shows one section at a time; drafts survive navigation between providers', async () => {
    await h.win.getByTestId('open-settings').click()
    await h.win.getByTestId('settings-nav-sessions').click()
    assert.equal(await h.win.getByTestId('settings-new-session').isVisible(), true)
    assert.equal(await h.win.getByTestId('settings-claude').isVisible(), false)
    await h.win.getByTestId('settings-nav-providers').click()
    await h.win.getByTestId('settings-claude-model').selectOption('opus')
    await h.win.getByRole('button', { name: 'Codex', exact: true }).click()
    assert.equal(await h.win.getByTestId('settings-claude').isVisible(), false)
    await h.win.getByTestId('settings-nav-sessions').click()
    await h.win.getByTestId('settings-provider').selectOption('codex')
    await h.win.getByTestId('settings-nav-providers').click()
    await h.win.getByRole('button', { name: 'Claude', exact: true }).click()
    assert.equal(await h.win.getByTestId('settings-claude-model').inputValue(), 'opus')
  })
  it('Escape offers to keep editing; saving persists every section and returns to the original draft', async () => {
    await h.win.keyboard.press('Escape')
    await h.win.getByRole('button', { name: 'Продолжить настройку' }).click()
    await h.win.getByTestId('settings-nav-sessions').click()
    assert.equal(await h.win.getByTestId('settings-provider').inputValue(), 'codex')
    await h.win.getByTestId('settings-save').click()
    await h.win.getByTestId('settings-dialog').waitFor({ state: 'detached' })
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Сохрани этот черновик')
    const c = await h.client()
    const saved = await c.request('settings.get') as { newSession: { defaults: { claude: { model: string } } } }
    assert.equal((saved.newSession.defaults as any).provider, 'codex')
    assert.equal(saved.newSession.defaults.claude.model, 'opus')
  })
  it('fills the window, stays within the viewport in both themes, and keeps keyboard focus inside', async () => {
    await h.win.getByTestId('open-settings').click()
    for (const [width, height] of [[1280, 800], [900, 560]]) {
      await h.app.evaluate(({ BrowserWindow }, [w, hh]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w!, hh!), [width, height])
      assert.ok(await waitFor(async () => h.win.getByTestId('settings-dialog').evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.x === 0 && r.y === 0 && r.width === innerWidth && r.height === innerHeight && document.documentElement.scrollWidth <= innerWidth
      })))
      for (const theme of ['light', 'dark'] as const) {
        await h.win.emulateMedia({ colorScheme: theme })
        await h.shot(`settings-${theme}-${width}`)
      }
    }
    await h.win.locator('.settings-back').focus()
    await h.win.keyboard.press('Shift+Tab')
    assert.equal(await h.win.getByTestId('settings-save').evaluate((el) => document.activeElement === el), true)
    await h.win.keyboard.press('Tab')
    assert.equal(await h.win.locator('.settings-back').evaluate((el) => document.activeElement === el), true)
    await h.win.keyboard.press('Escape')
    await h.win.getByTestId('settings-dialog').waitFor({ state: 'detached' })
  })
})
