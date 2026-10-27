// e2e: границы окна (docs/12 §2) — app:// отдаёт только dist/ui, CSP стоит и заголовком,
// навигация и window.open запрещены, тема системная (снимки светлой и тёмной для судьи визуала).

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { CSP } from '../../src/contract.js'
import { launch, sleep, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('окно: границы безопасности и тема', () => {
  let h: Harness

  before(async () => { h = await launch({ name: 'security' }) })
  after(async () => { await h?.close() })

  it('app:// отдаёт файлы dist/ui с CSP и 404 на всё за его пределами', async () => {
    const r = await h.app.evaluate(async ({ net }) => {
      const get = async (u: string): Promise<{ status: number; csp: string | null; type: string | null }> => {
        const res = await net.fetch(u)
        return { status: res.status, csp: res.headers.get('content-security-policy'), type: res.headers.get('content-type') }
      }
      return {
        index: await get('app://pult/'),
        js: await get('app://pult/app.js'),
        font: await get('app://pult/fonts/onest-cyrillic-wght-normal.woff2'),
        escape1: await get('app://pult/..%2f..%2fpackage.json'),
        escape2: await get('app://pult/%2e%2e/%2e%2e/dist/cli/main.js'),
        escape3: await get('app://pult/..%2f..%2fdist%2fcli%2fmain.js'),
        otherHost: await get('app://evil/index.html'),
        missing: await get('app://pult/nope.html'),
      }
    })
    assert.equal(r.index.status, 200)
    assert.equal(r.index.csp, CSP)
    assert.match(r.index.type ?? '', /text\/html/)
    assert.equal(r.js.status, 200)
    assert.equal(r.font.status, 200)
    assert.equal(r.font.type, 'font/woff2')
    for (const k of ['escape1', 'escape2', 'escape3', 'otherHost', 'missing'] as const) assert.equal(r[k].status, 404, k)
  })

  it('навигация и window.open запрещены', async () => {
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000))
    const opened = await h.win.evaluate(() => window.open('https://example.com/') === null)
    assert.equal(opened, true)
    await h.win.evaluate(() => { location.href = 'https://example.com/' })
    await sleep(500)
    assert.equal(h.win.url(), 'app://pult/index.html')
    assert.equal(h.app.windows().length, 1)
  })

  it('CSP разрешает локальные PDF-ресурсы и блокирует внешний fetch', async () => {
    const blocked = await h.win.evaluate(async () => {
      try { await fetch('https://example.invalid/pult-csp-test'); return false } catch { return true }
    })
    assert.equal(blocked, true, 'connect-src self обязан блокировать внешний fetch')
    const local = await h.win.evaluate(async () => (await fetch('app://pult/pdf/pdf.worker.mjs')).ok)
    assert.equal(local, true, 'локальный PDF worker доступен без внешней сети')
  })

  it('тема системная: светлая и тёмная (снимки для судьи визуала)', async () => {
    for (const theme of ['light', 'dark'] as const) {
      // Playwright держит у страницы эмуляцию colorScheme, поэтому nativeTheme.themeSource до неё не
      // доходит — переключаем тему тем же способом, каким Chromium сообщает системную: медиазапросом.
      await h.win.emulateMedia({ colorScheme: theme })
      assert.ok(await waitFor(async () => (await h.win.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)) === (theme === 'dark')))
      const bg = await h.win.evaluate(() => getComputedStyle(document.body).backgroundColor)
      assert.equal(bg, theme === 'dark' ? 'rgb(25, 27, 29)' : 'rgb(250, 250, 249)')
      await sleep(100)
      await h.shot(theme)
    }
  })

  it('шрифты загружены локально', async () => {
    const fonts = await h.win.evaluate(async () => {
      await document.fonts.ready
      return ['Onest', 'Geologica', 'JetBrains Mono'].map((f) => document.fonts.check(`16px "${f}"`, 'Пульт'))
    })
    assert.deepEqual(fonts, [true, true, true])
  })
})
