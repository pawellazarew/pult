import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('memory settings with a daemon without shared memory support', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'memory-unavailable' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
  })
  after(async () => { await h?.close() })

  it('offers a discoverable section with an explicit unavailable state', async () => {
    await h.win.keyboard.press('Meta+,')
    await h.win.getByTestId('settings-dialog').waitFor()
    await h.win.getByTestId('settings-nav-memory').click()
    const section = h.win.getByTestId('settings-memory')
    assert.equal(await section.getByTestId('settings-memory-open').isDisabled(), true)
    assert.match(await section.innerText(), /Claude, Codex и ZCode/)
    assert.ok((await section.getByRole('status').innerText()).length > 0)
    assert.equal(await h.win.getByTestId('memory-dialog').count(), 0)
    await h.shot('unavailable')
    await h.win.keyboard.press('Escape')
    await h.win.getByTestId('settings-dialog').waitFor({ state: 'detached' })
  })
})
