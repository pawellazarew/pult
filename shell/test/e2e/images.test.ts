import assert from 'node:assert/strict'
import { cpSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, REPO, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('изображения: живой ответ, просмотр и история', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'images' })
    // Демона поднимает окно уже после загрузки страницы: под нагрузкой клиент теста раньше него
    // ловил «нет файла токена — демон не запущен». Ждём подключения окна, как остальные наборы.
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
  })
  after(async () => { await h?.close() })
  it('три локальных изображения видны, увеличиваются и остаются после перезапуска окна', async () => {
    const c = await h.client()
    const cwd = h.workDir('images')
    for (const [file, fixture] of [['A.png', 'hero-light.png'], ['B.png', 'hero-dark.png'], ['C.png', 'inbox-light.png']]) {
      cpSync(path.join(REPO, 'docs/images', fixture!), path.join(cwd, file!))
    }
    writeFileSync(path.join(cwd, 'broken.png'), 'not an image')
    await c.request('agent.start', { name: 'images', kind: 'claude', cwd })
    const emit = (kind: string, data: Record<string, unknown>) => c.request('events.emit', { sessionId: 'images', provider: 'claude', kind, data })
    await emit('message.done', { text: 'Выбери вариант:\n\n![A](A.png) ![B](B.png) ![C](C.png)' })
    await emit('tool.finished', { toolUseId: 'preview', name: 'imageGeneration', images: [path.join(cwd, 'A.png')] })
    await emit('message.done', { text: '![Нет файла](missing.png) ![Повреждён](broken.png)' })
    await h.win.locator('[data-testid="agent-row"][data-agent="images"]').click()
    const cards = h.win.getByTestId('image-card')
    await cards.nth(5).waitFor({ state: 'attached' })
    for (let i = 0; i < 6; i++) {
      const card = cards.nth(i)
      await card.scrollIntoViewIfNeeded()
      assert.ok(await waitFor(async () => (await card.locator('img').count()) > 0 || (await card.textContent())?.includes('недоступно') === true, 5000))
    }
    const loaded = () => h.win.locator('.image-thumb img').evaluateAll((imgs) => imgs.length === 4 && imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0))
    assert.ok(await waitFor(loaded, 15_000), 'изображения не загружены в ленте')
    assert.equal(await h.win.locator('[data-testid="image-card"]').count(), 6)
    assert.ok(await waitFor(async () => (await h.win.locator('.image-placeholder').allTextContents()).every((s) => s.includes('недоступно')), 5000))
    await h.win.getByRole('button', { name: 'Увеличить: A', exact: true }).click()
    const dlg = h.win.getByRole('dialog', { name: 'A', exact: true })
    await dlg.waitFor()
    await dlg.getByRole('button', { name: 'Увеличить масштаб', exact: true }).click()
    assert.equal(await dlg.getByRole('button', { name: '125%', exact: true }).count(), 1)
    await h.shot('viewer')
    await h.win.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })
    assert.equal(await h.win.getByTestId('confirm-dialog').count(), 0, 'Esc просмотра ушёл в остановку агента')
    await h.scheme('light')
    await h.screen('redesign-images-light')
    await h.scheme('dark')
    await h.screen('redesign-images-dark')
    await h.reopen()
    await h.win.getByTestId('image-card').nth(5).waitFor({ state: 'attached' })
    for (let i = 0; i < 4; i++) {
      await h.win.getByTestId('image-card').nth(i).scrollIntoViewIfNeeded()
      await h.win.getByTestId('image-card').nth(i).locator('img').waitFor()
    }
    assert.ok(await waitFor(loaded, 15_000), 'изображения пропали после повторного открытия окна')
    const over = await h.win.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    assert.ok(over <= 1, `изображения раздвигают окно на ${over}px`)
  })
})
