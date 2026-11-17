import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { closeSync, existsSync, ftruncateSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import type { PromptAttachment } from '../../../src/core/promptAttachments.js'

const BIG_BYTES = 27_282_841
const sparseFile = (file: string): void => { const fd = openSync(file, 'wx'); try { ftruncateSync(fd, BIG_BYTES) } finally { closeSync(fd) } }

describe('large local originals remain linked instead of being copied', () => {
  let h: Harness
  let client: Awaited<ReturnType<Harness['client']>>
  before(async () => {
    h = await launch({ name: 'linked-attachments' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    client = await h.client()
    h.codexConfig({ scenario: 'simple', logOut: path.join(h.home, 'linked-codex-wire.jsonl') })
    await client.request('agent.start', { name: 'linked', kind: 'codex', cwd: h.workDir('project') })
    await h.win.locator('[data-testid="agent-row"][data-agent="linked"]').click()
    await h.win.getByTestId('composer').waitFor()
  })
  after(async () => { await h?.close() })
  const cards = () => h.win.getByTestId('attachment-card')
  const originals = () => h.workDir('originals')
  const noLargeOwnedCopy = (): void => {
    const dir = path.join(h.home, 'attachments')
    const bytes = (root: string): number => !existsSync(root) ? 0 : readdirSync(root, { withFileTypes: true }).reduce((sum, e) => {
      const file = path.join(root, e.name)
      return sum + (e.isDirectory() ? bytes(file) : e.isFile() ? statSync(file).size : 0)
    }, 0)
    assert.ok(bytes(dir) < 64 * 1024, 'large original bytes appeared in managed attachment cache')
  }
  const messages = async (): Promise<Array<{ text?: string; attachments?: PromptAttachment[] }>> => {
    const tail = await client.request('events.tail', { since: 0, sessionId: 'linked' }) as { events: Array<{ kind: string; data: { text?: string; attachments?: PromptAttachment[] } }> }
    return tail.events.filter((e) => e.kind === 'message.user').map((e) => e.data)
  }
  const dropNative = async (source: string): Promise<void> => {
    await h.win.evaluate(() => {
      const picker = document.createElement('input'); picker.id = 'linked-drop-source'; picker.type = 'file'; document.body.append(picker)
    })
    await h.win.locator('#linked-drop-source').setInputFiles(source)
    await h.win.getByTestId('composer').evaluate((el) => {
      const picker = document.querySelector<HTMLInputElement>('#linked-drop-source')!
      const dt = new DataTransfer(); dt.items.add(picker.files![0]!)
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      picker.remove()
    })
  }

  it('picker/drop keep the original path, badge and size through reload/send; removing a chip never deletes it', async () => {
    const original = path.join(originals(), 'Large original.mov')
    sparseFile(original)
    const source = realpathSync(original)
    await h.win.getByTestId('composer').fill('Look at the original')
    await h.win.getByTestId('attachment-picker').setInputFiles(source)
    assert.ok(await waitFor(async () => await cards().count() === 1))
    assert.equal(await cards().getAttribute('data-kind'), 'file-reference')
    assert.equal(await cards().getAttribute('data-path'), source)
    assert.match(await cards().textContent() ?? '', /Ссылка.*26\.0 МБ/)
    assert.equal(await cards().locator('img').count(), 0)
    noLargeOwnedCopy()
    await h.win.getByTestId('attachment-remove').click()
    assert.equal(await cards().count(), 0)
    assert.equal(statSync(source).size, BIG_BYTES)
    await dropNative(source)
    assert.ok(await waitFor(async () => await cards().count() === 1))
    await h.win.reload()
    assert.ok(await waitFor(async () => await cards().count() === 1))
    assert.equal(await cards().getAttribute('data-kind'), 'file-reference')
    assert.equal(await cards().getAttribute('data-path'), source)
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Look at the original')
    await h.win.getByTestId('send').click()
    assert.ok(await waitFor(async () => (await messages()).some((m) => m.text === 'Look at the original' && m.attachments?.some((a) => a.kind === 'file-reference' && a.path === source))))
    const sent = h.win.getByTestId('user-attachment').filter({ hasText: 'Large original.mov' })
    assert.equal(await sent.getAttribute('data-kind'), 'file-reference')
    assert.match(await sent.textContent() ?? '', /Ссылка.*26\.0 МБ/)
    noLargeOwnedCopy()
    assert.equal(statSync(source).size, BIG_BYTES)
    unlinkSync(source)
    await sent.getByRole('button', { name: 'Открыть Large original.mov', exact: true }).click()
    assert.match(await sent.getByRole('status').textContent() ?? '', /Оригинал файла недоступен.*перемещён или удалён/)
  })

  it('Finder-style paste uses the same original reference without reading clipboard file bytes', async () => {
    const original = path.join(originals(), 'Clipboard original.mov')
    sparseFile(original)
    const source = realpathSync(original)
    await h.win.getByTestId('composer').fill('Keep pasted file context separate')
    await h.app.evaluate((_electron, file) => { (globalThis as { __pultTestClipboardPaths?: string[] }).__pultTestClipboardPaths = [file] }, source)
    try {
      await h.win.getByTestId('composer').evaluate((el) => {
        const dt = new DataTransfer(); dt.items.add(new File(['native clipboard path marker'], 'marker.txt'))
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })
      assert.ok(await waitFor(async () => await cards().count() === 1))
      assert.equal(await cards().getAttribute('data-kind'), 'file-reference')
      assert.equal(await cards().getAttribute('data-path'), source)
      assert.equal(await h.win.getByTestId('composer').inputValue(), 'Keep pasted file context separate')
      noLargeOwnedCopy()
      await h.win.getByTestId('attachment-remove').click()
      assert.equal(statSync(source).size, BIG_BYTES)
    } finally {
      await h.app.evaluate(() => { (globalThis as { __pultTestClipboardPaths?: string[] }).__pultTestClipboardPaths = [] })
    }
  })

  it('a moved original fails explicitly before send, retaining the text and reference chip', async () => {
    const original = path.join(originals(), 'Move me.mov')
    sparseFile(original)
    await h.win.getByTestId('composer').fill('Keep this unsent text')
    await h.win.getByTestId('attachment-picker').setInputFiles(original)
    assert.ok(await waitFor(async () => await cards().count() === 1))
    const moved = path.join(originals(), 'Moved.mov')
    renameSync(original, moved)
    await h.win.getByTestId('send').click()
    assert.ok(await waitFor(async () => /недоступ|перемещ|удал|прикрепи/i.test(await h.win.getByTestId('send-error').textContent().catch(() => '') ?? '')))
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Keep this unsent text')
    assert.equal(await cards().count(), 1)
    assert.equal(statSync(moved).size, BIG_BYTES)
    await h.win.getByTestId('attachment-remove').click()
    assert.equal(existsSync(moved), true)
    noLargeOwnedCopy()
  })

  it('small native files remain copies and pathless large blobs stay rejected without losing the draft', async () => {
    const original = path.join(originals(), 'small.txt')
    writeFileSync(original, 'small cached file')
    await h.win.getByTestId('attachment-picker').setInputFiles(original)
    assert.ok(await waitFor(async () => await cards().count() === 1))
    const copy = (await cards().getAttribute('data-path'))!
    assert.equal(await cards().getAttribute('data-kind'), 'file')
    assert.notEqual(copy, original)
    unlinkSync(original)
    assert.equal(readFileSync(copy, 'utf8'), 'small cached file')
    await h.win.getByTestId('composer').evaluate((el) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(26 * 1024 * 1024)], 'pathless-large.bin'))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    assert.ok(await waitFor(async () => /локального пути.*Сохрани его на диск/s.test(await h.win.getByTestId('paste-notice').textContent().catch(() => '') ?? '')))
    assert.equal(await cards().count(), 1)
    assert.equal(await cards().getAttribute('data-path'), copy)
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Keep this unsent text')
    noLargeOwnedCopy()
  })
  it('a new-chat draft restores a linked original and sends the same path after the session is created', async () => {
    const source = path.join(originals(), 'New chat original.mov')
    sparseFile(source)
    const canonical = realpathSync(source)
    const project = h.workDir('new-linked-project', { scenario: 'simple' })
    await h.stubPickFolder(project)
    await h.win.getByTestId('new-agent').click()
    const draft = h.win.getByTestId('draft')
    await draft.waitFor()
    await draft.getByTestId('draft-attachment-picker').setInputFiles(source)
    assert.ok(await waitFor(async () => await draft.getByTestId('attachment-card').count() === 1))
    const id = await draft.getAttribute('data-draft')
    await draft.getByTestId('draft-input').fill('Inspect this original')
    await h.win.locator('[data-testid="agent-row"][data-agent="linked"]').click()
    await h.win.locator(`[data-testid="draft-row"][data-draft="${id}"]`).click()
    assert.equal(await draft.getByTestId('attachment-card').getAttribute('data-path'), canonical)
    await draft.getByTestId('draft-chip-folder').click()
    await h.win.getByTestId('draft-folder-other').click()
    assert.ok(await waitFor(async () => await draft.getByTestId('draft-chip-folder').getAttribute('data-path') === project))
    await draft.getByTestId('draft-send').click()
    await draft.waitFor({ state: 'detached', timeout: 15_000 })
    assert.ok(await waitFor(async () => {
      const tail = await client.request('events.tail', { since: 0, sessionId: 'new-linked-project' }) as { events: Array<{ kind: string; data: { attachments?: PromptAttachment[] } }> }
      return tail.events.some((event) => event.kind === 'message.user' && event.data.attachments?.some((a) => a.kind === 'file-reference' && a.path === canonical))
    }, 15_000))
    assert.equal(statSync(source).size, BIG_BYTES)
    noLargeOwnedCopy()
    await h.screen('linked-attachments-new-chat')
  })

})
