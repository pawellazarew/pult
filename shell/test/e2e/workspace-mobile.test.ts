// CSS phone viewports in the real Electron renderer; no real provider or network requests.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

const WIDTHS = [390, 320] as const
const USER_TEXT = 'Разбери интерфейс разговора: проверь перенос длинных сообщений, читаемость текста и доступность действий на маленьком экране.'
const COMPOSER_TEXT = 'Черновик с телефона остаётся на месте'

describe('workspace phone viewports: readable messages and reachable controls', () => {
  let h: Harness
  let client: Awaited<ReturnType<Harness['client']>>
  before(async () => {
    h = await launch({ name: 'workspace-mobile' })
    assert.ok(await waitFor(async () => await h.win.getAttribute('.app', 'data-conn') === 'up', 20_000))
    h.codexConfig({ scenario: 'hang' })
    client = await h.client()
    await client.request('agent.start', { name: 'phone', kind: 'codex', cwd: h.workDir('phone'), model: 'gpt-6.1-sol', effort: 'high' })
    await client.request('events.emit', { sessionId: 'phone', provider: 'codex', kind: 'message.user', data: { text: USER_TEXT } })
    await client.request('events.emit', { sessionId: 'phone', provider: 'codex', kind: 'message.done', data: { text: 'Проверю читаемость сообщений и расположение элементов управления.', itemId: 'phone-answer' } })
    await h.win.getByTestId('agent-row').click()
    await h.win.getByTestId('composer').fill(COMPOSER_TEXT)
    // Desktop minimum size is a native-window policy. Lower it only in this test to exercise CSS at phone widths.
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setMinimumSize(240, 320))
  })
  after(async () => { await h?.close() })

  const viewport = async (width: number): Promise<void> => {
    await h.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setContentSize(w, 812), width)
    assert.ok(await waitFor(async () => h.win.evaluate((w) => innerWidth === w, width)), `renderer did not reach ${width}px`)
    await h.win.evaluate(async () => { await document.fonts.ready; await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))) })
  }

  const noOverflow = async (): Promise<void> => {
    const size = await h.win.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, app: document.querySelector('.app')!.scrollWidth }))
    assert.ok(size.document <= size.viewport + 1, `document overflow: ${JSON.stringify(size)}`)
    assert.ok(size.app <= size.viewport + 1, `workspace overflow: ${JSON.stringify(size)}`)
  }

  const quietChrome = async (): Promise<void> => {
    assert.equal(await h.win.locator('.app .kbd:visible').count(), 0, 'shortcut badges are visible outside Help')
    const hints = await h.win.evaluate(() => {
      const visible = (el: HTMLElement): boolean => el.checkVisibility()
      const roots = Array.from(document.querySelectorAll<HTMLElement>('.composer, .draft-compose, .conv-head, .sidebar-footer, .sidebar-top')).filter(visible)
      const text = roots.map((el) => el.innerText)
      const placeholders = roots.flatMap((root) => Array.from(root.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(visible).map((el) => el.placeholder))
      const tooltips = roots.flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>('button[title]')).filter(visible).map((el) => el.title))
      return [...text, ...placeholders, ...tooltips].join('\n')
    })
    assert.doesNotMatch(hints, /⌘|Ctrl\+|Meta\+|Alt\+|Shift\+|\bEnter\b|\bEscape\b|\bEsc\b/u, 'keyboard hints remain in workspace chrome')
  }

  const reachableButtons = async (selector: string, scrollable = false): Promise<void> => {
    const rects = await h.win.locator(selector).evaluate((root, clipped) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter((el) => {
      if (!el.checkVisibility()) return false
      if (!clipped) return true
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && el.contains(hit)
    }).map((el) => {
      const r = el.getBoundingClientRect()
      return { name: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.title ?? el.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, viewport: innerWidth }
    }), scrollable)
    assert.ok(rects.length >= (selector === '.conv-head' ? 2 : 4), `${selector} has too few visible controls`)
    for (const r of rects) {
      // Compact secondary controls are 20px wide; allow one pixel of fractional flex rounding.
      assert.ok(r.width >= 19 && r.height >= 24, `${r.name} collapsed: ${JSON.stringify(r)}`)
      assert.ok(r.left >= -1 && r.right <= r.viewport + 1, `${r.name} outside the viewport: ${JSON.stringify(r)}`)
    }
    for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
      const x = rects[a]!, y = rects[b]!
      const overlapX = Math.min(x.right, y.right) - Math.max(x.left, y.left)
      const overlapY = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top)
      assert.ok(overlapX <= 1 || overlapY <= 1, `controls overlap: ${x.name} / ${y.name}`)
    }
  }

  const conversationGeometry = async (): Promise<void> => {
    await noOverflow()
    await quietChrome()
    await reachableButtons('.conv-head')
    await reachableButtons('.composer-toolbar')
    const layout = await h.win.evaluate(() => {
      const bubble = document.querySelector<HTMLElement>('.it-user > .body')!.getBoundingClientRect()
      const composer = document.querySelector<HTMLElement>('.composer .box')!.getBoundingClientRect()
      const feed = document.querySelector<HTMLElement>('.feed')!.getBoundingClientRect()
      return { bubbleWidth: bubble.width, bubbleHeight: bubble.height, composerTop: composer.top, composerBottom: composer.bottom, feedHeight: feed.height, viewportWidth: innerWidth, viewportHeight: innerHeight }
    })
    assert.ok(layout.bubbleWidth >= layout.viewportWidth * .55, `user message shrank: ${JSON.stringify(layout)}`)
    assert.ok(layout.bubbleWidth <= layout.viewportWidth - 16, `user message is wider than the phone: ${JSON.stringify(layout)}`)
    assert.ok(layout.bubbleHeight < 300, `user message wrapped into a narrow column: ${JSON.stringify(layout)}`)
    assert.ok(layout.composerBottom <= layout.viewportHeight && layout.composerTop >= 50, `composer is outside the phone: ${JSON.stringify(layout)}`)
    assert.ok(layout.feedHeight >= 160, `composer consumed the conversation: ${JSON.stringify(layout)}`)
    assert.equal(await h.win.getByTestId('composer').inputValue(), COMPOSER_TEXT)
  }

  const screenshotThemes = async (name: string): Promise<void> => {
    for (const theme of ['light', 'dark'] as const) {
      await h.scheme(theme)
      await h.screen(`${name}-${theme}`)
    }
    await h.scheme('light')
  }

  it('idle Codex fits 390 and 320; the navigation drawer keeps the conversation draft', async () => {
    for (const width of WIDTHS) {
      await viewport(width)
      await screenshotThemes(`workspace-idle-${width}`)
      await conversationGeometry()
      assert.equal(await h.win.getByTestId('stop-turn').count(), 0)
      await h.win.getByTestId('toggle-sidebar').click()
      await h.win.locator('.navigation-scrim').waitFor()
      assert.equal(await h.win.getByTestId('new-agent').isVisible(), true)
      await quietChrome()
      await noOverflow()
      await h.screen(`workspace-navigation-${width}-light`)
      await h.win.getByTestId('agent-row').click()
      await h.win.locator('.navigation-scrim').waitFor({ state: 'detached' })
      assert.equal(await h.win.getByTestId('composer').inputValue(), COMPOSER_TEXT)
    }
  })

  it('working Codex keeps steer, stop and queue separate at both phone widths', async () => {
    await client.request('agent.prompt', { name: 'phone', text: 'Продолжай проверку интерфейса' })
    await h.win.getByTestId('stop-turn').waitFor()
    for (const width of WIDTHS) {
      await viewport(width)
      await screenshotThemes(`workspace-working-${width}`)
      assert.equal(await h.win.getByTestId('steer').isVisible(), true)
      assert.equal(await h.win.getByTestId('send').isVisible(), true)
      assert.equal(await h.win.getByTestId('stop-turn').isVisible(), true)
      // Presentation changes remain available while Codex is working and cannot interrupt its turn.
      for (const mode of ['focus', 'normal']) {
        await h.win.getByTestId('conv-menu').click()
        await h.win.getByTestId(`mode-${mode}`).click()
        assert.equal(await h.win.getAttribute('.app', 'data-interface-mode'), mode)
        assert.equal(await h.win.getByTestId('composer').inputValue(), COMPOSER_TEXT)
        assert.equal(await h.win.getByTestId('stop-turn').isVisible(), true)
        if (mode === 'focus') {
          await h.win.getByTestId('toggle-sidebar').click()
          const health = h.win.getByTestId('health-menu')
          await health.locator('summary').click()
          const popover = await health.locator('.health-popover').boundingBox()
          assert.ok(popover && popover.x >= 0 && popover.x + popover.width <= width, 'connection details extend beyond the phone screen')
          const scrim = h.win.locator('.navigation-scrim')
          const scrimBounds = await scrim.boundingBox()
          assert.ok(scrimBounds, 'navigation scrim is visible')
          await scrim.click({ position: { x: scrimBounds.width - 5, y: 5 } })
        }
      }
      await conversationGeometry()
    }
    await client.request('agent.stop', { name: 'phone' })
  })

  it('general draft fits 390 and 320 with native controls and no keyboard boilerplate', async () => {
    await h.win.getByTestId('toggle-sidebar').click()
    await h.win.getByTestId('new-agent').click()
    const draft = h.win.getByTestId('draft')
    await draft.waitFor()
    await draft.getByTestId('draft-input').fill('Идея для нового разговора\nВторая строка черновика')
    assert.equal(await draft.getByTestId('draft-chip-folder').getAttribute('data-path'), '')
    await draft.getByTestId('draft-chip-model').click()
    await h.win.locator('[data-testid="draft-model-item"][data-value^="codex:"]').first().click()
    await draft.getByTestId('draft-chip-speed').waitFor()
    for (const width of WIDTHS) {
      await viewport(width)
      await screenshotThemes(`workspace-draft-${width}`)
      await noOverflow()
      await quietChrome()
      await reachableButtons('.conv-head')
      await reachableButtons('.draft-tb', true)
      const geometry = await draft.locator('.draft-box').evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, viewport: innerHeight }
      })
      assert.ok(geometry.top >= 60 && geometry.bottom <= geometry.viewport, `draft outside the phone: ${JSON.stringify(geometry)}`)
      for (const [chip, menu] of [['draft-chip-model', 'draft-menu-model'], ['draft-chip-speed', 'draft-menu-speed']] as const) {
        await draft.getByTestId(chip).click()
        const popup = h.win.getByTestId(menu)
        await popup.waitFor()
        const bounds = await popup.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }
        })
        assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, `menu outside the phone: ${JSON.stringify(bounds)}`)
        await h.win.keyboard.press('Escape')
        await popup.waitFor({ state: 'detached' })
      }
      assert.equal(await draft.getByTestId('draft-input').inputValue(), 'Идея для нового разговора\nВторая строка черновика')
    }
  })
})
