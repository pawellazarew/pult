import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { launch, REPO, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import type { TemporaryListReply, TemporaryReadReply, TemporarySnapshot, TemporaryStartReply } from '../../../src/temporary/types.js'

function assertNoPrivateFiles(root: string, needles: readonly string[]): void {
  for (const leaf of readdirSync(root)) {
    const file = path.join(root, leaf)
    let stat
    try { stat = lstatSync(file) } catch { continue }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) { assertNoPrivateFiles(file, needles); continue }
    if (!stat.isFile()) continue
    let bytes: Buffer
    try { bytes = readFileSync(file) } catch { continue } // Chromium can rotate a cache file concurrently.
    for (const needle of needles) assert.equal(bytes.includes(Buffer.from(needle)) || bytes.includes(Buffer.from(needle, 'utf16le')), false, `private text or id was written to ${path.relative(root, file)}`)
  }
}

describe('temporary chats: private memory, real UI and reconnect', () => {
  let h: Harness
  let client: Awaited<ReturnType<Harness['client']>>
  const secret = `private-e2e-${randomUUID()}`
  const draftSecret = `private-draft-${randomUUID()}`
  let identity: { epoch: string; id: string }

  before(async () => {
    h = await launch({ name: 'temporary-chats', env: { PULT_TEST_TEMPORARY_CLAUDE_BIN: path.join(REPO, 'test/fakes/fake-temporary-claude.mjs') } })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    client = await h.client()
  })
  after(async () => { await h?.close() })
  afterEach(async () => {
    if (!h) return
    const cleanup = await h.client()
    const listing = await cleanup.request('temporary.list') as TemporaryListReply
    for (const chat of listing.chats) await cleanup.request('temporary.remove', { epoch: listing.epoch, id: chat.id })
  })

  const snapshot = async (): Promise<TemporarySnapshot> => {
    const reply = await client.request('temporary.read', identity) as TemporaryReadReply
    assert.equal(reply.unchanged, false)
    return (reply as Extract<TemporaryReadReply, { unchanged: false }>).snapshot
  }
  const selected = () => h.win.getByTestId('temporary-chat')
  const assertNoStorage = async (needles: readonly string[]): Promise<void> => {
    const storage = await h.win.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    for (const needle of needles) assert.equal(storage.includes(needle), false, 'temporary data entered browser persistence')
  }

  it('starts outside saved chats, sends two turns and restores the daemon draft after closing the client', async () => {
    await h.win.getByTestId('temporary-new-menu').click()
    assert.ok(await waitFor(() => h.win.getByTestId('temporary-new').isEnabled(), 15_000))
    await h.win.getByTestId('temporary-new').click()
    await selected().waitFor()
    const id = await selected().getAttribute('data-temporary-id')
    assert.ok(id)
    const listing = await client.request('temporary.list') as TemporaryListReply
    identity = { epoch: listing.epoch, id }
    assert.equal(listing.chats.length, 1)
    assert.equal(await h.win.getByTestId('temporary-provider').locator('option[value="codex"]').isDisabled(), true)
    assert.equal(await selected().locator('[data-testid="attachment-picker"], [data-testid="dictation-toggle"], [data-testid="composer"]').count(), 0)
    await h.win.getByTestId('temporary-input').fill(secret)
    await h.win.getByTestId('temporary-send').click()
    assert.ok(await waitFor(async () => (await snapshot()).status === 'idle', 15_000))
    assert.ok(await waitFor(async () => (await h.win.getByTestId('temporary-assistant').innerText()).includes(secret)))
    await h.win.getByTestId('temporary-input').fill('Remember the first message')
    await h.win.getByTestId('temporary-send').click()
    assert.ok(await waitFor(async () => (await snapshot()).messages.length === 4 && (await snapshot()).status === 'idle'))
    assert.ok(await waitFor(async () => (await h.win.getByTestId('temporary-assistant').last().innerText()).includes('First message:')))
    assert.ok((await h.win.getByTestId('temporary-assistant').last().innerText()).includes(secret))
    assert.deepEqual((await client.request('agent.list') as { sessions: unknown[] }).sessions, [])
    await h.win.getByTestId('new-agent').click()
    await h.win.getByTestId('draft-input').fill('A normal saved draft')
    await h.win.getByTestId('temporary-row').click()
    await h.win.getByTestId('temporary-input').fill(draftSecret)
    assert.ok(await waitFor(async () => (await snapshot()).draft.text === draftSecret))
    await h.reopen()
    await h.win.getByTestId('temporary-row').waitFor()
    assert.doesNotMatch(await h.win.getByTestId('temporary-row').innerText(), /private-e2e|private-draft/)
    await h.win.getByTestId('temporary-row').click()
    assert.ok(await waitFor(async () => await h.win.getByTestId('temporary-input').inputValue() === draftSecret))
    assert.equal(await h.win.getByTestId('temporary-user').count(), 2)
    await assertNoStorage([secret, draftSecret, identity.id])
    assertNoPrivateFiles(h.home, [secret, draftSecret, identity.id])
    await h.scheme('dark')
    assert.ok(await waitFor(async () => await h.win.locator('html').getAttribute('data-theme') === 'dark'))
    await h.screen('temporary-chat-dark')
    await h.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w?.setMinimumSize(240, 320); w?.setContentSize(390, 812) })
    assert.ok(await waitFor(async () => await h.win.evaluate(() => innerWidth === 390)))
    assert.equal(await h.win.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await h.screen('temporary-chat-390-dark')
    await h.win.getByTestId('temporary-end').click()
    await h.win.getByTestId('temporary-end-confirm').waitFor()
    await h.win.getByTestId('confirm-ok').click()
    assert.ok(await waitFor(async () => (await client.request('temporary.list') as TemporaryListReply).chats.length === 0))
    await selected().waitFor({ state: 'detached' })
    await assertNoStorage([secret, draftSecret, identity.id])
    assertNoPrivateFiles(h.home, [secret, draftSecret, identity.id])
  })

  it('stops a live answer without losing the next draft and can continue in the same ephemeral process', async () => {
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 788))
    const listing = await client.request('temporary.list') as TemporaryListReply
    const started = await client.request('temporary.start', { epoch: listing.epoch, requestId: randomUUID(), provider: 'claude', model: 'pult-test-hang-once' }) as TemporaryStartReply
    identity = { epoch: listing.epoch, id: started.snapshot.id }
    const row = h.win.locator(`[data-testid="temporary-row"][data-temporary-id="${identity.id}"]`)
    await row.waitFor(); await row.click()
    await h.win.getByTestId('temporary-input').fill('A streaming temporary turn')
    await h.win.getByTestId('temporary-send').click()
    assert.ok(await waitFor(async () => (await h.win.getByTestId('temporary-assistant').innerText()).includes('ready')))
    await h.win.getByTestId('temporary-input').fill('The next private draft')
    assert.ok(await waitFor(async () => (await snapshot()).draft.text === 'The next private draft'))
    await h.win.getByTestId('temporary-stop').click()
    assert.ok(await waitFor(async () => (await snapshot()).status === 'interrupted'))
    assert.equal(await h.win.getByTestId('temporary-input').inputValue(), 'The next private draft')
    await h.win.getByTestId('temporary-send').click()
    assert.ok(await waitFor(async () => (await snapshot()).messages.length === 4 && (await snapshot()).status === 'idle'))
    await h.win.getByTestId('temporary-end').click()
    await h.win.getByTestId('confirm-ok').click()
    assert.ok(await waitFor(async () => (await client.request('temporary.list') as TemporaryListReply).chats.length === 0))
  })

  it('discards temporary history and browser state after the daemon is killed and restarted', async () => {
    await h.win.getByTestId('temporary-new-menu').click(); await h.win.getByTestId('temporary-new').click()
    await selected().waitFor()
    const listing = await client.request('temporary.list') as TemporaryListReply
    identity = { epoch: listing.epoch, id: (await selected().getAttribute('data-temporary-id'))! }
    await h.win.getByTestId('temporary-input').fill(draftSecret)
    assert.ok(await waitFor(async () => (await snapshot()).draft.text === draftSecret))
    const pid = h.daemonPid(); assert.ok(pid); process.kill(pid, 'SIGKILL')
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') !== 'up'))
    await h.startDaemonExternally()
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    await selected().waitFor({ state: 'detached' })
    const fresh = await h.client()
    const after = await fresh.request('temporary.list') as TemporaryListReply
    assert.notEqual(after.epoch, identity.epoch)
    assert.deepEqual(after.chats, [])
    await assert.rejects(fresh.request('temporary.read', identity), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'temporary_expired')
    await assertNoStorage([secret, draftSecret, identity.id])
    assertNoPrivateFiles(h.home, [secret, draftSecret, identity.id])
  })
})
