import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, ONE_PX_PNG, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('subagent projection safety and navigation', () => {
  let h: Harness
  let needleId = 0
  let permissionId = ''
  const parent = 'projection-parent'
  const openChild = async (): Promise<void> => {
    await h.win.getByTestId('subagents-open').click()
    await h.win.getByTestId('subagent-open').filter({ hasText: 'safety_audit' }).click()
    await h.win.getByTestId('subagent-view').waitFor()
  }
  const returnToParent = async (): Promise<void> => {
    await h.win.getByTestId('subagent-return').click()
    await h.win.getByTestId('composer').waitFor({ state: 'visible' })
  }
  before(async () => {
    h = await launch({ name: 'subagent-safety' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    h.codexConfig({ scenario: 'permission-accept', speed: 0 })
    const c = await h.client()
    await c.request('agent.start', { name: parent, kind: 'codex', cwd: h.workDir(parent) })
    const emit = async (kind: string, data: Record<string, unknown>, parentId?: string): Promise<number> =>
      ((await c.request('events.emit', { sessionId: parent, provider: 'codex', kind, data, ...(parentId ? { parentId } : {}) })) as { ids: number[] }).ids[0]!
    for (let i = 0; i < 40; i++) {
      const id = await emit('message.user', { text: i === 20 ? 'review-search-needle-middle' : `Parent message ${i}: ${'context '.repeat(12)}` })
      if (i === 20) needleId = id
    }
    await emit('agent.spawned', { toolUseId: 'safety-audit', subagentType: 'safety_audit', description: 'Existing child history' })
    for (let i = 0; i < 45; i++) await emit('message.done', { text: `Child result ${i}\n\n${'Useful existing context. '.repeat(16)}`, itemId: `child-${i}` }, 'safety-audit')
    await h.win.locator(`[data-testid="agent-row"][data-agent="${parent}"]`).click()
    await h.win.getByTestId('subagents-open').waitFor()
    await c.request('agent.prompt', { name: parent, text: 'Request permission in the parent' })
    assert.ok(await waitFor(async () => {
      const list = (await c.request('perm.list', {})) as { pending: Array<{ id: string; sessionId: string }> }
      permissionId = list.pending.find((p) => p.sessionId === parent)?.id ?? ''
      return !!permissionId
    }))
  })
  after(async () => { await h?.close() })

  it('does not approve an invisible parent request, but still permits the visible Inbox shortcut', async () => {
    const c = await h.client()
    await openChild()
    assert.equal(await h.win.locator('[data-testid="perm-card"]:visible').count(), 0)
    assert.equal(await h.win.getByTestId('composer').isVisible(), false)
    await h.win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await h.win.keyboard.press('Meta+Enter')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const pending = ((await c.request('perm.list', {})) as { pending: Array<{ id: string }> }).pending
    assert.ok(pending.some((p) => p.id === permissionId), 'child shortcut approved a hidden parent permission')
    await h.win.getByTestId('toggle-inbox').click()
    await h.win.locator(`[data-testid="inbox"] [data-testid="perm-card"][data-perm-id="${permissionId}"]`).waitFor()
    await h.win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await h.win.keyboard.press('Meta+Enter')
    assert.ok(await waitFor(async () => !((await c.request('perm.list', {})) as { pending: Array<{ id: string }> }).pending.some((p) => p.id === permissionId)))
    assert.ok(await h.win.getByTestId('subagent-view').isVisible())
    await h.win.getByTestId('toggle-inbox').click()
    await returnToParent()
  })

  it('restores child scroll after returning to the parent and keeps text and attachments across modes', async () => {
    await h.win.getByTestId('composer').fill('Parent draft and attachment stay together')
    await h.win.getByTestId('attachment-picker').setInputFiles({ name: 'audit.png', mimeType: 'image/png', buffer: Buffer.from(ONE_PX_PNG, 'base64') })
    await h.win.getByTestId('attachment-card').waitFor()
    await openChild()
    const childFeed = h.win.locator('.subagent-feed')
    await childFeed.evaluate((el) => { el.scrollTop = 256; el.dispatchEvent(new Event('scroll', { bubbles: true })) })
    const position = await childFeed.evaluate((el) => el.scrollTop)
    assert.ok(position > 0)
    await returnToParent()
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Parent draft and attachment stay together')
    assert.equal(await h.win.getByTestId('attachment-card').count(), 1)
    await openChild()
    assert.ok(await waitFor(async () => Math.abs(await childFeed.evaluate((el) => el.scrollTop) - position) < 2), 'child scroll was reset after reopening')
    for (const mode of ['focus', 'expanded', 'normal']) {
      await h.win.getByTestId('conv-menu').click()
      await h.win.getByTestId(`mode-${mode}`).click()
      assert.ok(await h.win.getByTestId('subagent-view').isVisible())
    }
    await returnToParent()
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Parent draft and attachment stay together')
    assert.equal(await h.win.getByTestId('attachment-card').count(), 1)
  })

  it('searches from a child and reveals the parent hit only after the parent feed is visible', async () => {
    await openChild()
    await h.win.keyboard.press('Meta+Shift+KeyF')
    const dialog = h.win.getByTestId('search-dialog')
    await dialog.getByTestId('search-input').fill('review-search-needle-middle')
    const hit = dialog.getByTestId('search-hit').first()
    await hit.waitFor()
    assert.equal(await hit.getAttribute('data-event-id'), String(needleId))
    await hit.click()
    assert.ok(await waitFor(async () => !await h.win.getByTestId('subagent-view').isVisible()))
    assert.ok(await waitFor(async () => h.win.evaluate((id) => {
      const feed = document.querySelector('[data-testid="feed"]')!
      const target = document.querySelector(`[data-testid="msg-user"][data-event-id="${id}"]`)!
      const f = feed.getBoundingClientRect(), r = target.getBoundingClientRect()
      return f.height > 0 && r.top >= f.top - 1 && r.top < f.bottom
    }, needleId)), 'search consumed the jump while the parent feed was hidden')
  })

  it('closes the mobile drawer when reopening an existing draft or opening Inbox', async () => {
    await h.win.setViewportSize({ width: 390, height: 844 })
    await h.win.keyboard.press('Meta+KeyN')
    await h.win.getByTestId('draft-input').fill('Existing mobile draft')
    await h.win.getByTestId('toggle-sidebar').click()
    await h.win.locator(`[data-testid="agent-row"][data-agent="${parent}"]`).click()
    await h.win.getByTestId('toggle-sidebar').click()
    await h.win.getByTestId('draft-row').filter({ hasText: 'Existing mobile draft' }).click()
    assert.equal(await h.win.getAttribute('.app', 'data-nav-open'), 'false')
    assert.ok(await h.win.getByTestId('draft-input').isVisible())
    await h.win.getByTestId('toggle-sidebar').click()
    await h.win.getByTestId('toggle-inbox').click()
    assert.equal(await h.win.getAttribute('.app', 'data-nav-open'), 'false')
    assert.ok(await h.win.getByTestId('inbox').isVisible())
  })
})
