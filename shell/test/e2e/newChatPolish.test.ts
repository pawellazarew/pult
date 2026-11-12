import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('new chat composer and compact draft sidebar', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'new-chat-polish' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
    const client = await h.client()
    await client.request('project.add', { path: h.workDir('alpha') })
    await client.request('project.add', { path: h.workDir('beta') })
    await h.win.reload()
    assert.ok(await waitFor(async () => await h.win.getByTestId('project').count() === 2))
    await h.win.getByTestId('new-agent').click()
    await h.win.getByTestId('draft-input').waitFor()
  })
  after(async () => { await h?.close() })

  it('shows slash skills before the first message in a conversation without a project', async () => {
    const box = h.win.getByTestId('draft-input')
    await box.fill('/')
    assert.ok(await waitFor(async () => await h.win.getByTestId('slash-item').count() > 0, 1800), 'new-chat slash skill suggestions must load')
    await box.pressSequentially('hello')
    await h.win.getByTestId('slash-item').filter({ hasText: '/hello-pult' }).click()
    assert.equal(await box.inputValue(), '/hello-pult ')
    assert.equal(await h.win.getByTestId('slash-menu').count(), 0)
    await box.fill('/')
    await h.win.getByTestId('slash-menu').waitFor()
    await box.press('Escape')
    assert.equal(await h.win.getByTestId('slash-menu').count(), 0)
    assert.equal(await h.win.getByTestId('confirm-discard-draft').count(), 0)
    await box.fill('')
  })

  it('keeps a short draft list immediately above the projects', async () => {
    const draftList = h.win.getByTestId('drafts')
    await draftList.waitFor()
    // Reproduce the original flex inheritance for a before/after diagnostic image.
    await draftList.evaluate((el: HTMLElement) => { el.style.flex = '1'; el.style.maxHeight = 'none' })
    await h.shot('sidebar-baseline-css')
    await draftList.evaluate((el: HTMLElement) => { el.style.removeProperty('flex'); el.style.removeProperty('max-height') })
    await h.shot('sidebar-after-polish')
    const gap = await draftList.evaluate((el) => {
      const last = el.lastElementChild?.getBoundingClientRect()
      return last ? el.getBoundingClientRect().bottom - last.bottom : 0
    })
    assert.ok(gap <= 12, `draft list leaves ${gap}px of empty space below its last row`)
  })

  it('supports Codex slash discovery and native dollar skill insertion before a session exists', async () => {
    await h.win.getByTestId('draft-chip-model').click()
    await h.win.locator('[data-testid="draft-model-item"][data-value^="codex:"]').first().click()
    const box = h.win.getByTestId('draft-input')
    await box.fill('/')
    await h.win.getByTestId('slash-item').filter({ hasText: '$codex-hello' }).waitFor()
    await h.shot('codex-slash-after-polish')
    await h.win.getByTestId('slash-item').filter({ hasText: '$codex-hello' }).click()
    assert.equal(await box.inputValue(), '$codex-hello ')
    await box.fill('')
    assert.deepEqual(await (await h.client()).request('agent.list', {}), { sessions: [] })
    const client = await h.client()
    await client.request('agent.start', { name: 'alpha-chat', kind: 'claude', cwd: h.workDir('alpha') })
    await client.request('agent.start', { name: 'beta-chat', kind: 'claude', cwd: h.workDir('beta') })
    assert.ok(await waitFor(async () => await h.win.getByTestId('agent-row').count() === 2))
    await h.win.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await box.fill('/')
    await h.win.getByTestId('slash-menu').waitFor()
    await h.shot('codex-slash-dark-projects-after-polish')
    await box.fill('')
    await h.win.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  })

  it('lets model popovers handle Escape first and ignores IME Escape', async () => {
    await h.win.getByTestId('draft-chip-model').click()
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.getByTestId('draft-menu-model').count(), 0)
    assert.equal(await h.win.getByTestId('draft').count(), 1)
    await h.win.getByTestId('draft-input').evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })))
    assert.equal(await h.win.getByTestId('draft').count(), 1)
    assert.equal(await h.win.getByTestId('confirm-discard-draft').count(), 0)
  })

  it('protects attachment-only drafts and preserves attachments when cancelling', async () => {
    await h.win.getByTestId('draft-attachment-picker').setInputFiles({ name: 'idea.txt', mimeType: 'text/plain', buffer: Buffer.from('important idea') })
    await h.win.getByTestId('attachment-card').waitFor()
    const box = h.win.getByTestId('draft-input')
    assert.equal(await box.inputValue(), '')
    await box.press('Escape')
    await h.win.getByTestId('confirm-discard-draft').waitFor()
    assert.match(await h.win.evaluate(() => document.activeElement?.textContent ?? ''), /Отмена/)
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.getByTestId('attachment-card').count(), 1)
    await box.press('Escape')
    await h.win.getByTestId('confirm-ok').click()
    await h.win.getByTestId('new-agent').click()
    await h.win.getByTestId('draft-input').waitFor()
  })

  it('closes an empty draft immediately and asks before discarding a written message', async () => {
    const box = h.win.getByTestId('draft-input')
    await box.fill('  \n\t ')
    await box.press('Escape')
    assert.ok(await waitFor(async () => await h.win.getByTestId('draft').count() === 0), 'empty draft must close')
    await h.win.getByTestId('new-agent').click()
    await h.win.getByTestId('draft-input').fill('Сохранить важную мысль')
    await h.win.getByTestId('draft-input').press('Escape')
    assert.ok(await waitFor(async () => await h.win.getByTestId('confirm-discard-draft').count() === 1, 1200), 'written draft must ask before discarding')
    await h.win.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await h.shot('escape-confirm-dark-after-polish')
    await h.win.getByTestId('confirm-discard-draft').getByRole('button', { name: /Отмена/ }).click()
    await h.win.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    assert.equal(await h.win.getByTestId('draft-input').inputValue(), 'Сохранить важную мысль')
    await h.win.getByTestId('draft-input').press('Escape')
    await h.win.getByTestId('confirm-discard-draft').getByTestId('confirm-ok').click()
    assert.ok(await waitFor(async () => await h.win.getByTestId('draft').count() === 0))
  })

  it('keeps many drafts scrollable and the project heading visible on a small desktop', async () => {
    for (let i = 0; i < 14; i++) {
      await h.win.getByTestId('new-agent').click()
      await h.win.getByTestId('draft-input').fill(`draft ${i}`)
    }
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(900, 560))
    const metrics = await h.win.getByTestId('drafts').evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }))
    assert.ok(metrics.scroll > metrics.height, JSON.stringify(metrics))
    assert.ok(metrics.height > 30 && metrics.height < 180, JSON.stringify(metrics))
    const heading = await h.win.locator('.projects-heading').boundingBox()
    assert.ok(heading && heading.y + heading.height < 500)
    await h.shot('many-drafts-900-after-polish')
  })
})

async function holdFirstDraftPut(h: Harness): Promise<void> {
  await h.app.evaluate(({ ipcMain }) => {
    // Electron fixture only: delay the IPC reply, after the daemon has committed the write.
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const original = handlers.get('pult:call')
    if (!original) throw new Error('missing pult:call IPC handler')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const state = { held: false, committed: false, puts: [] as Array<{ baseRev: number | undefined }>, removes: [] as Array<string | undefined>, release, restore: () => { ipcMain.removeHandler('pult:call'); ipcMain.handle('pult:call', original) } }
    ;(globalThis as unknown as { __heldDraftPut: typeof state }).__heldDraftPut = state
    ipcMain.removeHandler('pult:call')
    ipcMain.handle('pult:call', async (...args: unknown[]) => {
      if (args[1] === 'draft.put') state.puts.push({ baseRev: (args[2] as { baseRev?: number }).baseRev })
      if (args[1] === 'draft.remove') state.removes.push((args[2] as { owner?: string }).owner)
      const hold = args[1] === 'draft.put' && !state.held
      if (hold) state.held = true
      const result = await original(...args)
      if (hold) { state.committed = true; await gate }
      return result
    })
  })
}

describe('discard while the first draft save acknowledgement is pending', () => {
  it('does not restore a discarded draft after a committed first put returns late', async () => {
    const h = await launch({ name: 'new-chat-pending-save' })
    try {
      assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
      await holdFirstDraftPut(h)
      await h.win.getByTestId('new-agent').click()
      const input = h.win.getByTestId('draft-input')
      await input.fill('A committed draft whose first ACK is still in flight')
      const id = await h.win.getByTestId('draft').getAttribute('data-draft')
      assert.ok(id)
      assert.ok(await waitFor(() => h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { committed: boolean } }).__heldDraftPut.committed), 5000), 'first put must have committed before Escape')
      const client = await h.client()
      const saved = await client.request('draft.get', { id }) as { draft: { rev: number; data: { text: string } } }
      assert.equal(saved.draft.rev, 1)
      assert.equal(saved.draft.data.text, await input.inputValue())
      await input.press('Escape')
      await h.win.getByTestId('confirm-discard-draft').getByTestId('confirm-ok').click()
      await h.win.getByTestId('draft').waitFor({ state: 'detached' })
      await h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { release(): void } }).__heldDraftPut.release())
      await h.win.reload()
      assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
      assert.ok(await waitFor(async () => {
        const list = await client.request('draft.list', {}) as { drafts: Array<{ id: string }> }
        return !list.drafts.some((draft) => draft.id === id)
      }, 2000), 'discarded draft must be removed even when its first save ACK returns late')
      assert.equal(await h.win.locator(`[data-testid="draft-row"][data-draft="${id}"]`).count(), 0, 'reload must not resurrect the discarded draft')
    } finally {
      await h.app.evaluate(() => {
        const state = (globalThis as unknown as { __heldDraftPut?: { release(): void; restore(): void } }).__heldDraftPut
        state?.release(); state?.restore()
      }).catch(() => {})
      await h.close()
    }
  })

  it('saves edits made during the pending ACK with the acknowledged base revision', async () => {
    const h = await launch({ name: 'new-chat-save-followup' })
    try {
      assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
      await holdFirstDraftPut(h)
      await h.win.getByTestId('new-agent').click()
      const input = h.win.getByTestId('draft-input')
      await input.fill('first version')
      const id = await h.win.getByTestId('draft').getAttribute('data-draft')
      assert.ok(id)
      assert.ok(await waitFor(() => h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { committed: boolean } }).__heldDraftPut.committed), 5000))
      await input.fill('second version typed while the first ACK was pending')
      // Let the edit's debounce expire while the first write is still awaiting its reply.
      await h.win.waitForTimeout(500)
      assert.deepEqual(await h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { puts: Array<{ baseRev: number }> } }).__heldDraftPut.puts), [{ baseRev: 0 }])
      await h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { release(): void } }).__heldDraftPut.release())
      const client = await h.client()
      assert.ok(await waitFor(async () => {
        const saved = await client.request('draft.get', { id }) as { draft: { rev: number; data: { text: string } } }
        return saved.draft.rev === 2 && saved.draft.data.text === 'second version typed while the first ACK was pending'
      }, 5000), 'pending edits must save with the new revision after the first ACK')
      assert.deepEqual(await h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { puts: Array<{ baseRev: number }> } }).__heldDraftPut.puts), [{ baseRev: 0 }, { baseRev: 1 }])
    } finally {
      await h.app.evaluate(() => {
        const state = (globalThis as unknown as { __heldDraftPut?: { release(): void; restore(): void } }).__heldDraftPut
        state?.release(); state?.restore()
      }).catch(() => {})
      await h.close()
    }
  })


  it('keeps owner checks when a discarded pending draft was claimed by another window', async () => {
    const h = await launch({ name: 'new-chat-save-owner' })
    try {
      assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
      await holdFirstDraftPut(h)
      await h.win.getByTestId('new-agent').click()
      const input = h.win.getByTestId('draft-input')
      await input.fill('draft claimed by another window')
      const id = await h.win.getByTestId('draft').getAttribute('data-draft')
      assert.ok(id)
      assert.ok(await waitFor(() => h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { committed: boolean } }).__heldDraftPut.committed), 5000))
      const client = await h.client()
      const before = await client.request('draft.get', { id }) as { draft: { owner: string } }
      const claimed = await client.request('draft.claim', { id, owner: 'other-window' }) as { draft: unknown }
      await input.press('Escape')
      await h.win.getByTestId('confirm-ok').click()
      await h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { release(): void } }).__heldDraftPut.release())
      assert.ok(await waitFor(async () => await h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { removes: unknown[] } }).__heldDraftPut.removes.length) === 2), 'immediate and late cleanup must both run')
      assert.deepEqual(await h.app.evaluate(() => (globalThis as unknown as { __heldDraftPut: { removes: unknown[] } }).__heldDraftPut.removes), [before.draft.owner, before.draft.owner])
      const after = await client.request('draft.get', { id }) as { draft: unknown }
      assert.deepEqual(after.draft, claimed.draft, 'cleanup must preserve another live owner and its revision')
    } finally {
      await h.app.evaluate(() => {
        const state = (globalThis as unknown as { __heldDraftPut?: { release(): void; restore(): void } }).__heldDraftPut
        state?.release(); state?.restore()
      }).catch(() => {})
      await h.close()
    }
  })

})
