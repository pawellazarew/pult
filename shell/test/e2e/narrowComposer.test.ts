// A desktop Files panel can leave a phone-width chat without activating viewport media queries.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

let h: Harness
let client: Awaited<ReturnType<Harness['client']>>
const DRAFT = 'Черновик остаётся при открытой панели файлов'
const PREFERENCES = ['conv-settings', 'conv-effort', 'conv-access', 'conv-speed'] as const

before(async () => {
  h = await launch({ name: 'narrow-composer' })
  assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
  h.codexConfig({ scenario: 'hang' })
  client = await h.client()
  const cwd = h.workDir('composer')
  writeFileSync(path.join(cwd, 'README.md'), '# Проверка панели файлов\n\nНастройки поля ввода остаются доступны рядом с файлом.')
  await client.request('agent.start', { name: 'narrow', kind: 'codex', cwd, model: 'gpt-6.1-sol', effort: 'high', approval: 'full', confirm: true, grant: 'cli-once' })
  await h.win.locator('[data-testid="agent-row"][data-agent="narrow"]').click()
  await h.win.getByTestId('composer').fill(DRAFT)
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800))
  assert.ok(await waitFor(async () => h.win.evaluate(() => innerWidth > 1000)))
})
after(async () => {
  const ownedProcess = h?.app.process()
  await h?.close()
  if (ownedProcess) assert.equal(ownedProcess.exitCode, 0, 'owned Electron did not close cleanly')
})

const settle = async (): Promise<void> => {
  await h.win.evaluate(async () => { await document.fonts.ready; await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))) })
}

const geometry = async (expectedTitle = 'narrow'): Promise<void> => {
  const result = await h.win.locator('.composer .box').evaluate((box) => {
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    return {
      viewport: innerWidth, box: rect(box), column: rect(document.querySelector('.conv-col')!),
      controls: Array.from(box.querySelectorAll<HTMLElement>('.composer-toolbar button, .chat-info > summary')).filter((el) => el.checkVisibility()).map((el) => {
        const r = rect(el), hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
        return { id: el.dataset.testid ?? el.getAttribute('aria-label') ?? el.title, ...r, hit: !!hit && el.contains(hit) }
      }),
      labels: Array.from(box.querySelectorAll<HTMLElement>('[data-testid="conv-model"], .effort-picker > span, [data-testid="conv-approval"]')).map((el) => ({ text: el.textContent, visible: el.checkVisibility(), width: el.clientWidth, content: el.scrollWidth })),
    }
  })
  assert.ok(result.viewport > 1000, `not a desktop viewport: ${JSON.stringify(result)}`)
  assert.ok(result.column.width >= 319 && result.column.width <= 321, `Files panel did not narrow the actual chat: ${JSON.stringify(result)}`)
  assert.ok(result.controls.length >= 9, `missing composer controls: ${JSON.stringify(result)}`)
  for (const control of result.controls) {
    assert.ok(control.left >= result.box.left - 1 && control.right <= result.box.right + 1 && control.top >= result.box.top - 1 && control.bottom <= result.box.bottom + 1,
      `control outside composer: ${JSON.stringify({ control, box: result.box })}`)
    assert.ok(control.width >= 19 && control.height >= 24 && control.hit, `control is not reachable: ${JSON.stringify(control)}`)
  }
  for (const label of result.labels) assert.ok(label.text && label.visible && label.content <= label.width + 1, `preference label is hidden or clipped: ${JSON.stringify(label)}`)
  assert.equal(await h.win.getByTestId('composer').inputValue(), DRAFT)
  const header = await h.win.locator('.conv-head').evaluate((head) => {
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    return {
      box: rect(head),
      elements: Array.from(head.querySelectorAll<HTMLElement>('[data-testid="conv-title"], [data-testid="conv-access-pill"], [data-testid="conv-status"], .conv-location, .workspace-actions button, [data-testid="conv-menu"]')).map((el) => {
        const r = rect(el), hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)
        return { id: el.dataset.testid!, text: el.textContent?.trim(), visible: el.checkVisibility(), button: el.tagName === 'BUTTON', ...r, hit: !!hit && el.contains(hit) }
      }),
    }
  })
  assert.equal(header.elements.length, 8, `missing header controls or status: ${JSON.stringify(header)}`)
  for (const el of header.elements) {
    assert.ok(el.visible && el.width > 10 && el.height > 10, `hidden or collapsed header item: ${JSON.stringify(el)}`)
    assert.ok(el.left >= header.box.left - 1 && el.right <= header.box.right + 1 && el.top >= header.box.top - 1 && el.bottom <= header.box.bottom + 1,
      `header item outside chat: ${JSON.stringify({ el, box: header.box })}`)
    if (el.button) assert.ok(el.width >= 24 && el.height >= 24 && el.hit, `header action is not reachable: ${JSON.stringify(el)}`)
  }
  for (let i = 0; i < header.elements.length; i++) for (let j = i + 1; j < header.elements.length; j++) {
    const a = header.elements[i]!, b = header.elements[j]!
    assert.ok(Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1,
      `header items overlap: ${JSON.stringify({ a, b })}`)
  }
  assert.equal(header.elements.find((el) => el.id === 'conv-title')?.text, expectedTitle)
  assert.ok(header.elements.find((el) => el.id === 'conv-access-pill')?.text)
  assert.ok(header.elements.find((el) => el.id === 'conv-status')?.text)
}

it('desktop Files panel wraps every preference inside the 320px chat, keeping text and menus reachable', async () => {
  await settle()
  const wide = await h.win.locator('.composer-preferences > button').evaluateAll((buttons) => buttons.map((button) => { const r = button.getBoundingClientRect(); return r.top + r.height / 2 }))
  assert.ok(Math.max(...wide) - Math.min(...wide) < 1, 'wide composer should retain its single preference row')
  const wideHeader = await h.win.locator('.conv-head').evaluate((head) => Array.from(head.querySelectorAll('.conv-title, .workspace-actions, [data-testid="conv-menu"]')).map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }))
  assert.ok(Math.max(...wideHeader) - Math.min(...wideHeader) < 1, 'wide header should retain its single row')
  await h.win.getByTestId('toggle-files').click()
  await h.win.locator('[data-testid="workspace-file"][data-path="README.md"]').click()
  await h.win.getByTestId('file-markdown').getByRole('heading', { name: 'Проверка панели файлов' }).waitFor()
  await h.win.getByTestId('right-panel-resize').focus()
  await h.win.getByTestId('right-panel-resize').press('End')
  assert.ok(await waitFor(async () => h.win.locator('.conv-col').evaluate((el) => Math.abs(el.getBoundingClientRect().width - 320) < 1)))
  await settle()
  await h.screen('narrow-composer-files-idle')
  await geometry()
  for (const id of PREFERENCES) {
    const button = h.win.getByTestId(id)
    await button.click()
    assert.equal(await button.getAttribute('aria-expanded'), 'true', `${id} menu did not open`)
    await h.win.keyboard.press('Escape')
    assert.ok(await waitFor(async () => await button.getAttribute('aria-expanded') === 'false'), `${id} menu did not close`)
  }
  for (const theme of ['dark', 'light'] as const) { await h.scheme(theme); await h.screen(`narrow-composer-files-idle-${theme}`) }
})

it('the same narrow desktop chat keeps working-turn actions inside the composer', async () => {
  await client.request('agent.prompt', { name: 'narrow', text: 'Проверь пример интерфейса' })
  await h.win.getByTestId('stop-turn').waitFor()
  await h.win.getByTestId('conv-title').filter({ hasText: 'Проверь пример интерфейса' }).waitFor()
  await h.win.getByTestId('composer').fill(DRAFT)
  await settle()
  await h.screen('narrow-composer-files-working')
  await geometry('Проверь пример интерфейса')
  for (const id of ['steer', 'stop-turn', 'send']) await h.win.getByTestId(id).click({ trial: true })
})
