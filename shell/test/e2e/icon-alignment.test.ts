import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

const COMPOSER_BUTTONS = [
  '[data-testid="send"]',
  '[data-testid="stop-turn"]',
  '[data-testid="steer"]',
  '.composer .attach-picker',
  '.composer .dictation-mic',
  '.composer .dictation-options',
] as const

describe('icon-only controls stay visually centered', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'icon-alignment' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    h.codexConfig({ scenario: 'hang' })
    const client = await h.client()
    await client.request('agent.start', { name: 'icons', kind: 'codex', cwd: h.workDir('icons') })
    await client.request('agent.prompt', { name: 'icons', text: 'Оставь ход активным для проверки кнопок.' })
    await h.win.locator('[data-testid="agent-row"][data-agent="icons"]').click()
    await h.win.getByTestId('steer').waitFor()
    await h.win.getByTestId('composer').fill('Проверка центрирования')
  })
  after(async () => { await h?.close() })

  const centered = async (selector: string): Promise<void> => {
    const boxes = await h.win.locator(selector).evaluateAll((elements, fallback) => elements.map(element => {
      const button = element as HTMLButtonElement
      const svg = button.querySelector('svg')
      if (!svg) return { missingSvg: true, name: button.getAttribute('aria-label') ?? fallback, dx: 0, dy: 0, width: 0, height: 0 }
      const b = button.getBoundingClientRect()
      const s = svg.getBoundingClientRect()
      return { missingSvg: false, name: button.getAttribute('aria-label') ?? button.getAttribute('data-testid') ?? fallback,
        dx: s.x + s.width / 2 - b.x - b.width / 2,
        dy: s.y + s.height / 2 - b.y - b.height / 2,
        width: s.width, height: s.height }
    }), selector)
    assert.ok(boxes.length, `${selector} was not rendered`)
    for (const box of boxes) {
      assert.equal(box.missingSvg, false, `${box.name} still uses a font glyph`)
      if (box.missingSvg) continue
      assert.ok(box.width > 0 && box.height > 0, `${box.name} icon has no geometry`)
      assert.ok(Math.abs(box.dx) <= 0.25 && Math.abs(box.dy) <= 0.25,
        `${box.name} icon is off-center: ${JSON.stringify(box)}`)
    }
  }

  it('centers composer, chrome, footer and dialog buttons while retaining text-button spacing', async () => {
    for (const selector of COMPOSER_BUTTONS) await centered(selector)
    await centered('.workspace-actions .chrome-icon')
    await centered('.sidebar-footer .footer-icon:has(svg)')
    await h.shot('composer-icons-desktop')
    await h.scheme('dark')
    for (const selector of COMPOSER_BUTTONS) await centered(selector)
    await h.shot('composer-icons-dark')
    await h.win.getByTestId('open-maintenance').click()
    await h.win.getByTestId('maintenance-panel').waitFor()
    await centered('.dlg-h > button[aria-label]')
    const textButton = await h.win.getByTestId('maintenance-doctor').evaluate(button => {
      const icon = button.querySelector('svg')!.getBoundingClientRect()
      const bounds = button.getBoundingClientRect()
      return { iconCenter: icon.x + icon.width / 2, buttonCenter: bounds.x + bounds.width / 2 }
    })
    assert.ok(textButton.iconCenter < textButton.buttonCenter - 5,
      'a labelled button lost its separate icon/text layout')
    await h.win.getByTestId('maintenance-panel').getByRole('button', { name: 'Закрыть', exact: true }).click()
  })

  it('keeps every composer control centered and reachable at a phone width', async () => {
    await h.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      window.setMinimumSize(240, 320)
      window.setContentSize(390, 812)
    })
    assert.ok(await waitFor(async () => h.win.evaluate(() => innerWidth === 390)))
    await h.win.evaluate(async () => { await document.fonts.ready })
    for (const selector of COMPOSER_BUTTONS) {
      await centered(selector)
      const rect = await h.win.locator(selector).boundingBox()
      assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 391, `${selector} left the viewport`)
    }
    await h.shot('composer-icons-phone')
  })
})
