import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('регулируемые границы рабочего места', () => {
  let h: Harness
  // Exercise the CI-sized screen locally without changing the production window or common harness.
  const forced = process.env.PULT_TEST_RESIZE_VIEWPORT?.match(/^(\d+)x(\d+)$/)
  const requested = forced ? [Number(forced[1]), Number(forced[2])] : [1280, 800]
  before(async () => {
    h = await launch({ name: 'panel-resize' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
    const cwd = h.workDir('resize')
    writeFileSync(path.join(cwd, 'README.md'), '# Пример\n\nФайл для проверки ширины просмотра.')
    await (await h.client()).request('agent.start', { name: 'resize', kind: 'claude', cwd })
    await h.win.locator('[data-testid="agent-row"][data-agent="resize"]').click()
  })
  after(async () => { await h?.close() })
  const width = async (selector: string): Promise<number> => h.win.locator(selector).evaluate((el) => el.getBoundingClientRect().width)
  const height = async (selector: string): Promise<number> => h.win.locator(selector).evaluate((el) => el.getBoundingClientRect().height)
  const settle = async (): Promise<void> => { await h.win.evaluate(async () => { await document.fonts.ready; await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))) }) }
  const resetWorkspace = async (): Promise<void> => {
    // Every case has its own panel state, including when the preceding assertion failed mid-interaction.
    await h.win.mouse.up()
    await h.app.evaluate(({ BrowserWindow }, [w, hh]) => BrowserWindow.getAllWindows()[0]?.setContentSize(w!, hh!), requested)
    await h.win.evaluate(() => localStorage.clear())
    await h.win.reload()
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up'))
    await h.win.locator('[data-testid="agent-row"][data-agent="resize"]').click()
    await h.win.getByTestId('composer').fill('')
    await settle()
  }
  beforeEach(resetWorkspace)
  afterEach(resetWorkspace)
  const limits = async (id: string) => {
    await settle()
    const separator = h.win.getByTestId(id)
    return {
      value: Number(await separator.getAttribute('aria-valuenow')),
      min: Number(await separator.getAttribute('aria-valuemin')),
      max: Number(await separator.getAttribute('aria-valuemax')),
    }
  }
  const drag = async (id: string, dx: number, dy = 0): Promise<void> => {
    const box = await h.win.getByTestId(id).boundingBox()
    assert.ok(box)
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await h.win.mouse.move(x, y); await h.win.mouse.down()
    try { await h.win.mouse.move(x + dx, y + dy, { steps: 8 }) }
    finally { await h.win.mouse.up() }
    await settle()
  }
  const expectDrag = async (id: string, axis: 'x' | 'y', delta: number, direction: 1 | -1, measure: () => Promise<number>): Promise<number> => {
    const bounds = await limits(id), before = await measure()
    assert.ok(Math.abs(before - bounds.value) < 2, `${id}: separator does not reflect the current panel size`)
    const expected = Math.min(bounds.max, Math.max(bounds.min, before + delta * direction))
    await drag(id, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0)
    assert.ok(await waitFor(async () => Math.abs(await measure() - expected) < 2), `${id}: requested ${before + delta * direction}, expected ${expected} within ${bounds.min}…${bounds.max}, got ${await measure()}`)
    return measure()
  }

  it('поле само растёт с текстом до ручного изменения; сброс возвращает автоматическую высоту', async () => {
    const input = h.win.getByTestId('composer'), inputHeight = () => height('[data-testid="composer"]')
    const long = Array.from({ length: 20 }, (_, i) => `Строка ${i}`).join('\n')
    const short = await inputHeight()
    await input.fill(long)
    const automatic = Math.min(240, (await limits('composer-resize')).max)
    assert.ok(await waitFor(async () => Math.abs(await inputHeight() - automatic) < 2))
    assert.ok(await inputHeight() > short + 30, 'long text should grow the automatic input')
    const manual = await expectDrag('composer-resize', 'y', -30, -1, inputHeight)
    assert.equal(await h.win.locator('.resizable-composer').getAttribute('data-input-resized'), '1')
    await input.fill('Короткая реплика')
    assert.ok(Math.abs(await inputHeight() - manual) < 2)
    await h.win.getByTestId('composer-resize').dblclick()
    assert.ok(await waitFor(async () => await inputHeight() <= 100))
    assert.equal(await h.win.locator('.resizable-composer').getAttribute('data-input-resized'), null)
    await input.fill(long)
    assert.ok(await waitFor(async () => Math.abs(await inputHeight() - Math.min(240, automatic)) < 2))
    await input.fill('')
    assert.ok(await waitFor(async () => await inputHeight() <= 100))
  })

  it('ширина проектов меняется без скачка, сохраняется; скрытие не оставляет пустую колонку', async () => {
    const original = await width('.agents-col')
    await expectDrag('sidebar-resize', 'x', 70, 1, () => width('.agents-col'))
    const splitter = h.win.getByTestId('sidebar-resize')
    await splitter.focus(); await splitter.press('ArrowLeft')
    const chosen = await width('.agents-col')
    await h.win.reload()
    assert.ok(await waitFor(async () => Math.abs(await width('.agents-col') - chosen) < 2))
    await h.win.keyboard.press('Meta+B')
    assert.equal(await splitter.count(), 0)
    assert.ok(Math.abs(await width('.conv-col') - await width('.grid')) < 2, 'hidden sidebar must release its entire grid column')
    await h.win.keyboard.press('Meta+B')
    await h.win.getByTestId('sidebar-resize').dblclick()
    assert.ok(Math.abs(await width('.agents-col') - original) < 2)
  })

  it('границы ответов, файлов и дерева имеют собственные сохранённые размеры', async () => {
    await h.win.getByTestId('toggle-inbox').click()
    await expectDrag('right-panel-resize', 'x', -70, -1, () => width('.inbox'))
    await h.win.getByTestId('right-panel-resize').focus(); await h.win.getByTestId('right-panel-resize').press('ArrowRight')
    const savedInbox = await width('.inbox')
    await h.win.getByTestId('toggle-files').click()
    await settle()
    const focused = await h.win.locator('.grid.files-focused').count() === 1
    const viewport = await h.win.evaluate(() => innerWidth)
    assert.equal(focused, viewport < 1200)
    if (focused) {
      assert.equal(await h.win.getByTestId('right-panel-resize').count(), 0, 'focused files have no neighbouring chat boundary')
      assert.equal(await h.win.locator('.conv-col').isVisible(), false)
      assert.ok(Math.abs(await width('.files-pane') - (await width('.grid') - await width('.agents-col'))) < 2)
    } else {
      assert.equal(await h.win.locator('.conv-col').isVisible(), true)
      await expectDrag('right-panel-resize', 'x', -50, -1, () => width('.files-pane'))
    }
    await expectDrag('file-tree-resize', 'x', 35, 1, () => width('.file-tree'))
    const savedTree = await width('.file-tree'), savedFiles = await width('.files-pane')
    await h.win.reload()
    await h.win.getByTestId('toggle-files').click()
    assert.ok(await waitFor(async () => Math.abs(await width('.file-tree') - savedTree) < 2 && Math.abs(await width('.files-pane') - savedFiles) < 2))
    await h.win.getByTestId('files-close').click()
    await h.win.getByTestId('toggle-inbox').click()
    assert.ok(Math.abs(await width('.inbox') - savedInbox) < 2)
    await h.win.getByTestId('right-panel-resize').dblclick()
    await h.win.getByTestId('toggle-inbox').click()
  })

  it('поле ввода растёт вверх; узкое и низкое окно сохраняет место ленте', async () => {
    await h.win.getByTestId('composer').fill('Черновик остаётся при изменении размеров')
    const chosen = await expectDrag('composer-resize', 'y', -90, -1, () => height('[data-testid="composer"]'))
    await h.win.reload()
    assert.ok(await waitFor(async () => Math.abs(await height('[data-testid="composer"]') - chosen) < 2))
    await h.win.getByTestId('sidebar-resize').focus(); await h.win.getByTestId('sidebar-resize').press('End')
    await h.win.getByTestId('toggle-inbox').click()
    await h.win.getByTestId('right-panel-resize').focus(); await h.win.getByTestId('right-panel-resize').press('End')
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(900, 560))
    await settle()
    assert.ok(await waitFor(async () => h.win.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)))
    assert.ok(await width('.conv-col') >= 319)
    assert.ok(await height('.feed') >= 95)
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Черновик остаётся при изменении размеров')
    await h.shot('resize-900')
  })

  it('диагностика расширяется по двум осям и сохраняет выбранный размер', async () => {
    await h.win.getByTestId('open-doctor').click()
    await h.win.getByTestId('doctor-panel').waitFor()
    const chosen = await expectDrag('doctor-width-resize', 'x', 130, 1, () => width('[data-testid="doctor-panel"]'))
    await h.win.getByTestId('doctor-height-resize').focus(); await h.win.getByTestId('doctor-height-resize').press('Home')
    assert.ok(Math.abs(await height('[data-testid="doctor-panel"]') - 260) < 2)
    await h.win.getByTestId('doctor-panel').getByRole('button', { name: 'Закрыть', exact: true }).click()
    await h.win.getByTestId('open-doctor').click()
    assert.ok(Math.abs(await width('[data-testid="doctor-panel"]') - chosen) < 2)
    assert.ok(Math.abs(await height('[data-testid="doctor-panel"]') - 260) < 2)
    await h.shot('resize-doctor')
  })
})
