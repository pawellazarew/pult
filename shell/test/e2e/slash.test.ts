// «/» в поле ввода (docs/19): список скиллов и команд над полем, в границах его рамки; клавиатура и мышь.
// Список даёт демон (`agent.commands`): у fake-claude — записанный ответ `initialize` CLI 2.1.318, у fake codex —
// ответ `skills/list` в форме codex-cli 0.166.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor, RESULTS } from './harness.js'
import type { Harness } from './harness.js'

describe('«/» в поле ввода', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'slash' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000), 'окно ещё не подключилось к демону')
    const c = await h.client()
    await c.request('agent.start', { name: 'sl-claude', kind: 'claude', cwd: h.workDir('sl-claude') })
    await c.request('agent.start', { name: 'sl-codex', kind: 'codex', cwd: h.workDir('sl-codex') })
  })
  after(async () => { await h?.close() })

  const open = async (name: string): Promise<void> => {
    await h.win.locator(`[data-testid="agent-row"][data-agent="${name}"]`).click()
    await h.win.getByTestId('composer').waitFor()
  }

  it('Claude: «/» открывает список в рамке поля, фильтр, ↓ и Enter вставляют /name, Esc закрывает', async () => {
    await open('sl-claude')
    const box = h.win.getByTestId('composer')
    await box.fill('')
    await box.press('/')
    const menu = h.win.getByTestId('slash-menu')
    await menu.waitFor()
    assert.ok(await waitFor(async () => (await menu.getByTestId('slash-item').count()) > 5), 'список загрузился')
    const names = await menu.locator('.slash-name').allTextContents()
    assert.ok(names.includes('/hello-pult') && names.includes('/compact'), names.join(' '))
    assert.ok(!names.includes('/clear') && !names.includes('/model'), 'неработающие без терминала скрыты')
    // Список — в границах рамки поля (до пикселя: якорь выносит его на отступ и рамку .box).
    const frame = await h.win.locator('.composer .box').boundingBox()
    const pop = await menu.boundingBox()
    assert.ok(frame && pop)
    assert.ok(Math.abs(pop.x - frame.x) <= 1 && Math.abs(pop.x + pop.width - (frame.x + frame.width)) <= 1, `${JSON.stringify(pop)} vs ${JSON.stringify(frame)}`)
    assert.ok(pop.y + pop.height <= frame.y, 'над полем')
    // Строки фиксированной высоты, описание обрезано многоточием.
    const heights = new Set(await menu.getByTestId('slash-item').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height))))
    assert.deepEqual([...heights], [34])
    await h.win.screenshot({ path: join(RESULTS, 'slash-claude.png') })

    await box.pressSequentially('hel')
    assert.equal(await menu.locator('.slash-name').first().textContent(), '/hello-pult')
    // Playwright fill('') selects text, then sends Delete in another renderer turn.
    // Pin a pending slash RAF between those steps: it must not collapse the newer selection.
    await box.evaluate((el: HTMLTextAreaElement & { __slashFrames?: { flush(): void; restore(): void } }) => {
      const original = window.requestAnimationFrame
      const originalCancel = window.cancelAnimationFrame
      const pending = new Map<number, FrameRequestCallback>()
      let nextId = -1
      window.requestAnimationFrame = (callback) => {
        const id = nextId--
        pending.set(id, callback)
        return id
      }
      window.cancelAnimationFrame = (id) => {
        if (!pending.delete(id)) originalCancel.call(window, id)
      }
      el.__slashFrames = {
        flush: () => {
          const callbacks = [...pending.values()]
          pending.clear()
          for (const callback of callbacks) callback(performance.now())
        },
        restore: () => {
          window.requestAnimationFrame = original
          window.cancelAnimationFrame = originalCancel
          for (const callback of pending.values()) original.call(window, callback)
          pending.clear()
          delete el.__slashFrames
        },
      }
    })
    try {
      await box.press('Enter')
      assert.equal(await box.inputValue(), '/hello-pult ')
      assert.equal(await menu.count(), 0, 'после вставки список закрыт')
      await box.evaluate((el: HTMLTextAreaElement & { __slashFrames?: { flush(): void } }) => {
        el.selectionStart = 0
        el.selectionEnd = el.value.length
        el.focus()
        el.__slashFrames?.flush()
      })
      await box.press('Delete')
      assert.equal(await box.inputValue(), '', 'отложенная каретка предыдущей вставки не отменяет новое выделение для удаления')
    } finally {
      await box.evaluate((el: HTMLTextAreaElement & { __slashFrames?: { restore(): void } }) => el.__slashFrames?.restore())
    }
    await box.press('/')
    await menu.waitFor()
    await box.pressSequentially('co')
    const first = await menu.locator('.slash-name').first().textContent()
    await box.press('ArrowDown')
    const second = await menu.locator('.slash-row.is-active .slash-name').textContent()
    assert.notEqual(first, second)
    await box.press('Tab')
    assert.equal(await box.inputValue(), `${second} `)
    assert.ok(await waitFor(async () => await menu.count() === 0), 'вставка Tab завершена, список закрыт')

    // Re-selecting the same command still commits its caret, even if the text is unchanged.
    await box.press('End')
    await box.press('ArrowLeft')
    await menu.waitFor()
    assert.equal(await menu.locator('.slash-name').first().textContent(), second)
    await box.press('Enter')
    assert.equal(await box.inputValue(), `${second} `)
    assert.equal(await menu.count(), 0, 'повторный выбор той же команды закрывает список')
    assert.deepEqual(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
      [(`${second} `).length, (`${second} `).length], 'каретка после пробела, хотя текст не изменился')

    await box.fill('/')
    await menu.waitFor()
    assert.equal(await box.inputValue(), '/', 'перед Escape поле содержит только проверяемую команду')
    await box.press('Escape')
    assert.equal(await menu.count(), 0)
    assert.equal(await box.inputValue(), '/', 'Esc только закрывает список')
    await box.fill('')
  })

  it('мышь: наведение выделяет, щелчок вставляет; пустой результат — слова, Enter тогда отправляет как есть', async () => {
    await open('sl-claude')
    const box = h.win.getByTestId('composer')
    await box.fill('')
    await box.press('/')
    const menu = h.win.getByTestId('slash-menu')
    await menu.waitFor()
    await box.pressSequentially('cont')
    const row = menu.getByTestId('slash-item').filter({ hasText: '/context' })
    await row.hover()
    assert.equal(await row.getAttribute('aria-selected'), 'true')
    await row.click()
    assert.equal(await box.inputValue(), '/context ')
    await box.fill('')
    await box.press('/')
    await box.pressSequentially('zzzq')
    await menu.getByTestId('slash-status').getByText('Нет команд по «zzzq»').waitFor()
  })

  it('Codex: скиллы app-server, вставка $name', async () => {
    await open('sl-codex')
    const box = h.win.getByTestId('composer')
    await box.fill('')
    await box.press('/')
    const menu = h.win.getByTestId('slash-menu')
    await menu.waitFor()
    assert.ok(await waitFor(async () => (await menu.getByTestId('slash-item').count()) === 2))
    assert.deepEqual(await menu.locator('.slash-name').allTextContents(), ['$codex-hello', '$imagegen'])
    await h.win.screenshot({ path: join(RESULTS, 'slash-codex.png') })
    await box.pressSequentially('cod')
    await box.press('Enter')
    assert.equal(await box.inputValue(), '$codex-hello ')
    await box.fill('')
  })
})
