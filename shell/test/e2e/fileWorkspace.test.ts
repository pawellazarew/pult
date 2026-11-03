import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'
import { pdfFixture } from './pdfFixture.js'

const codeSample = ['#!/usr/bin/env python3', '', 'def greet():', '\treturn "Привет"', `    # ${'x'.repeat(240)}`, 'greet()', ''].join('\n')

describe('файлы проекта рядом с беседой', () => {
  let h: Harness
  let cwd: string
  let pdf: string
  before(async () => {
    h = await launch({ name: 'file-workspace' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    cwd = h.workDir('project')
    mkdirSync(path.join(cwd, 'src'))
    writeFileSync(path.join(cwd, 'layout.py'), codeSample)
    writeFileSync(path.join(cwd, 'src/main.ts'), 'export function preview() {\n  return "Hello Pult"\n}\n')
    writeFileSync(path.join(cwd, 'README.md'), '# План релиза\n\nФайлы рядом с разговором.\n\n- Проверить интерфейс\n- Сохранить черновик\n\n[Исходный код](src/main.ts)\n')
    writeFileSync(path.join(cwd, 'demo.html'), '<script>window.__pultViewerPwned = 1</script>')
    writeFileSync(path.join(cwd, 'tiny.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64'))
    mkdirSync(path.join(h.home, 'Downloads'))
    pdf = path.join(h.home, 'Downloads/Project overview.pdf')
    writeFileSync(pdf, pdfFixture())
    const c = await h.client()
    await c.request('agent.start', { name: 'viewer', kind: 'claude', cwd })
    await c.request('events.emit', { kind: 'message.done', sessionId: 'viewer', provider: 'claude', data: { text: `Документ готов:\n\n:codex-file-citation{path=${JSON.stringify(pdf)} purpose="output"}` } })
    await h.win.locator('[data-testid="agent-row"][data-agent="viewer"]').click()
    await h.win.getByTestId('composer').fill('Этот черновик должен сохраниться')
  })
  after(async () => { await h?.close() })

  it('дерево → Markdown → исходник; относительная ссылка открывает код; HTML остаётся текстом', async () => {
    await h.win.getByTestId('toggle-files').click()
    await h.win.locator('[data-testid="workspace-file"][data-path="README.md"]').click()
    await h.win.getByTestId('file-markdown').getByRole('heading', { name: 'План релиза' }).waitFor()
    await h.win.getByTestId('file-source-toggle').click()
    assert.match(await h.win.getByTestId('file-source').textContent() ?? '', /# План релиза/)
    await h.win.getByTestId('file-source-toggle').click()
    await h.win.getByTestId('file-markdown').getByTestId('file-link').click()
    assert.ok(await waitFor(async () => (await h.win.getByTestId('file-source').textContent())?.includes('Hello Pult') === true))
    const rows = await h.win.getByTestId('file-source').locator('.file-code-line').evaluateAll((lines) =>
      lines.map((line) => ({ top: line.getBoundingClientRect().top, number: line.querySelector('.file-line-number')?.textContent })))
    assert.deepEqual(rows.map((row) => row.number), ['1', '2', '3', '4'])
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i]!.top > rows[i - 1]!.top + 1, `Строки ${i} и ${i + 1} должны идти друг под другом: ${JSON.stringify(rows)}`)
    }

    await h.win.locator('[data-testid="workspace-file"][data-path="demo.html"]').click()
    assert.ok(await waitFor(async () => (await h.win.getByTestId('file-source').textContent())?.includes('<script>') === true))
    assert.equal(await h.win.evaluate(() => (window as unknown as { __pultViewerPwned?: number }).__pultViewerPwned), undefined)
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Этот черновик должен сохраниться')
  })

  it('код сохраняет пустые строки, отступы и нумерацию при горизонтальной прокрутке', async () => {
    await h.win.keyboard.press('Meta+P')
    await h.win.locator('[data-testid="workspace-file"][data-path="layout.py"]').click()
    const source = h.win.getByTestId('file-source')
    assert.ok(await waitFor(async () => (await source.textContent())?.includes('#!/usr/bin/env python3') === true))
    const lines = source.locator('.file-code-line')
    assert.deepEqual(await lines.locator(':scope > span:last-of-type').allTextContents(), codeSample.split('\n').map((line) => line || ' '))
    const geometry = await lines.evaluateAll((items) => items.map((line) => {
      const r = line.getBoundingClientRect()
      return { top: r.top, height: r.height, gutter: line.querySelector('.file-line-number')!.getBoundingClientRect().left }
    }))
    for (let i = 1; i < geometry.length; i++) {
      assert.ok(Math.abs(geometry[i]!.top - geometry[i - 1]!.top - geometry[i - 1]!.height) < 1, 'каждая строка начинается сразу под предыдущей')
      assert.ok(Math.abs(geometry[i]!.height - geometry[0]!.height) < 1, 'длинные строки не переносятся, пустые не схлопываются')
    }
    assert.deepEqual(await source.locator('.file-line-number').allTextContents(), ['1', '2', '3', '4', '5', '6', '7'])
    await source.evaluate((el) => { el.scrollLeft = el.scrollWidth - el.clientWidth })
    assert.ok(await source.evaluate((el) => el.scrollLeft > 100), 'длинный код прокручивается внутри просмотра')
    const gutters = await source.locator('.file-line-number').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().left))
    gutters.forEach((left, i) => assert.ok(Math.abs(left - geometry[i]!.gutter) < 1, `номер строки ${i + 1} остаётся у левого края`))
    assert.ok(await h.win.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'код не растягивает окно')
    await source.evaluate((el) => { el.scrollLeft = 0 })
    await h.scheme('light'); await h.screen('workspace-code-lines-light')
    await h.scheme('dark'); await h.screen('workspace-code-lines-dark')
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Этот черновик должен сохраниться')
  })

  it('изображение видно, внешняя ссылка PDF открывается в Пульте; страницы и zoom работают', async () => {
    await h.win.keyboard.press('Meta+P')
    await h.win.locator('[data-testid="workspace-file"][data-path="tiny.png"]').click()
    await h.win.getByTestId('file-image').waitFor()
    assert.ok(await h.win.getByTestId('file-image').evaluate((el) => (el as HTMLImageElement).naturalWidth === 1))
    await h.win.keyboard.press('Escape')
    await h.win.getByTestId('file-link').filter({ hasText: 'Project overview.pdf' }).click()
    const ready = h.win.locator('[data-testid="pdf-preview"][data-state="ready"]')
    await ready.waitFor({ timeout: 20_000 })
    assert.ok(await h.win.getByTestId('pdf-canvas').evaluate((el) => (el as HTMLCanvasElement).width > 100))
    await h.win.getByTestId('pdf-next').click()
    await ready.waitFor()
    assert.ok(await waitFor(async () => (await h.win.getByTestId('pdf-preview').textContent())?.includes('SECOND PAGE') === true))
    await h.win.getByTestId('pdf-zoom-in').click()
    await ready.waitFor()
    await h.scheme('light'); await h.screen('workspace-pdf-light')
    await h.scheme('dark'); await h.screen('workspace-pdf-dark')
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Этот черновик должен сохраниться')
  })

  it('нецитированный внешний файл и чужая папка недоступны; на 900 px просмотр разворачивается', async () => {
    const uncited = path.join(h.home, 'Downloads/not-shared.txt')
    writeFileSync(uncited, 'not part of this conversation')
    const denied = await h.win.evaluate(async (source) => { try { await window.pult!.previewFile!('viewer', source); return false } catch { return true } }, uncited)
    assert.equal(denied, true)
    const listDenied = await h.win.evaluate(async (source) => { try { await window.pult!.listFiles!('viewer', source); return false } catch { return true } }, path.dirname(pdf))
    assert.equal(listDenied, true)
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(900, 560) })
    await h.win.keyboard.press('Meta+P')
    assert.ok(await waitFor(async () => await h.win.locator('.grid.files-focused').count() === 1))
    assert.equal(await h.win.locator('.conv-col').isVisible(), false)
    await h.win.getByTestId('files-close').click()
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Этот черновик должен сохраниться')
    assert.ok(await h.win.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  })
})
