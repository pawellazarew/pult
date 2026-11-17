import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('composer selection when switching conversations', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'composer-selection' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
    const client = await h.client()
    for (const name of ['selection-a', 'selection-b']) {
      await client.request('agent.start', { name, kind: 'claude', cwd: h.workDir(name) })
    }
  })
  after(async () => { await h?.close() })
  const select = async (name: string): Promise<void> => {
    await h.win.locator(`[data-testid="agent-row"][data-agent="${name}"]`).click()
    await h.win.locator(`[data-testid="conversation"][data-agent="${name}"]`).waitFor()
  }
  const selection = async () => h.win.getByTestId('composer').evaluate((element: HTMLTextAreaElement) => ({
    start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection,
    focused: document.activeElement === element,
  }))

  it('restores each chat caret and inserts the next character at the saved position', async () => {
    const text = 'Первая строка 🙂 и продолжение'
    await select('selection-a')
    const box = h.win.getByTestId('composer')
    await box.fill(text)
    await box.press('ArrowLeft')
    await box.press('ArrowLeft')
    const position = text.length - 2
    const saved = await selection()
    assert.equal(saved.start, position)
    assert.equal(saved.end, position)
    await select('selection-b')
    await box.fill('Другой черновик')
    const other = await selection()
    await select('selection-a')
    assert.deepEqual(await selection(), saved)
    await box.pressSequentially('X')
    assert.equal(await box.inputValue(), text.slice(0, position) + 'X' + text.slice(position))
    await select('selection-b')
    assert.deepEqual(await selection(), other)
  })

  it('restores a backward selection and replaces exactly the selected text', async () => {
    await select('selection-a')
    const box = h.win.getByTestId('composer')
    await box.fill('Начало середина конец')
    await box.press('ArrowLeft')
    for (let i = 0; i < 5; i++) await box.press('Shift+ArrowLeft')
    const saved = await selection()
    assert.ok(saved.end > saved.start)
    assert.equal(saved.direction, 'backward')
    await select('selection-b')
    await select('selection-a')
    assert.deepEqual(await selection(), saved)
    await box.pressSequentially('X')
    assert.equal(await box.inputValue(), 'Начало середина конец'.slice(0, saved.start) + 'X' + 'Начало середина конец'.slice(saved.end))
  })

  it('opens an older draft at its end and preserves an intentionally placed caret at zero', async () => {
    await select('selection-b')
    await h.win.evaluate(() => {
      const drafts = JSON.parse(localStorage.getItem('pult.drafts') ?? '{}')
      drafts['selection-a'] = { text: 'Старый черновик', at: Date.now() }
      localStorage.setItem('pult.drafts', JSON.stringify(drafts))
    })
    await select('selection-a')
    const box = h.win.getByTestId('composer')
    assert.equal(await box.inputValue(), 'Старый черновик')
    assert.equal((await selection()).start, 'Старый черновик'.length)
    await box.press('Meta+ArrowLeft')
    const saved = await selection()
    assert.equal(saved.start, 0)
    assert.equal(saved.end, 0)
    await select('selection-b')
    await select('selection-a')
    assert.deepEqual(await selection(), saved)
  })
})
