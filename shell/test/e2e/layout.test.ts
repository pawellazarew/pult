// e2e раскладки: настоящая геометрия окна, а не разметка. Ход упал, за ним в очереди реплика — под полем
// ввода плашка «Очередь стоит» с «Продолжить». Плашка обязана быть одной компактной строкой: значок не больше
// 24×24, текст переносится обычно, кнопка справа и не налезает на текст, лента над полем видна. До починки
// значок без размера растягивался на всю беседу, текст сжимался в столбик, а поле ввода уезжало наверх.
// Проверка идёт на рабочем размере окна (1440×900) и на размере раннера CI (1024×705); кадры — в
// test-results/layout-*.png (снимок страницы окна, не экрана).

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type Rec = { name: string; lastStatus: string; queuePaused?: boolean; queue?: unknown[] }
type Box = { x: number; y: number; width: number; height: number }

describe('окно: раскладка', () => {
  let h: Harness
  let c: Client

  before(async () => {
    h = await launch({ name: 'layout' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
  })
  after(async () => { await h?.close() })

  const rec = async (name: string): Promise<Rec | undefined> =>
    ((await c.request('agent.list', {})) as { sessions: Rec[] }).sessions.find((r) => r.name === name)
  const box = async (sel: string): Promise<Box> => {
    const b = await h.win.locator(sel).first().boundingBox()
    assert.ok(b, `нет на экране: ${sel}`)
    return b
  }
  const resize = async (w: number, hh: number): Promise<{ width: number; height: number }> => {
    await h.app.evaluate(({ BrowserWindow }, [ww, wh]) => { BrowserWindow.getAllWindows()[0]?.setContentSize(ww, wh) }, [w, hh] as [number, number])
    // Экран меньше окна — macOS ужимает окно; дальше меряем то, что вышло на самом деле.
    await waitFor(async () => (await h.win.evaluate(() => window.innerWidth)) <= w, 3000)
    await h.win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    return h.win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  }

  it('ход упал, реплика в очереди: плашка «Очередь стоит» — компактная строка под полем, лента видна', async () => {
    const dir = h.workDir('qpause', { scenario: 'simple', speed: 0, hang: 700 })
    await c.request('agent.start', { name: 'qpause', kind: 'claude', cwd: dir })
    await c.request('agent.prompt', { name: 'qpause', text: 'Первая реплика' })
    await c.request('agent.wait', { name: 'qpause', until: ['idle'], timeoutMs: 20_000 })
    await c.request('agent.prompt', { name: 'qpause', text: 'упади [[not-logged-in]]' })
    await c.request('agent.prompt', { name: 'qpause', text: 'после падения', queue: true })
    assert.ok(await waitFor(async () => (await rec('qpause'))?.queuePaused === true, 15_000), 'очередь не встала после падения')

    await h.win.locator('[data-testid="agent-row"][data-agent="qpause"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="qpause"]').waitFor({ timeout: 10_000 })
    await h.win.getByTestId('queue-paused').waitFor({ timeout: 10_000 })
    await h.win.getByTestId('queue-item').waitFor({ timeout: 5000 })

    for (const [w, hh] of [[1440, 900], [1024, 705]] as const) {
      const size = await resize(w, hh)
      await h.shot(`queue-paused-${w}x${hh}`)
      const where = `окно ${size.width}×${size.height}`
      const icon = await box('[data-testid="queue-paused"] svg')
      const notice = await box('[data-testid="queue-paused"]')
      const textBox = await box('[data-testid="queue-paused"] .grow')
      const resume = await box('[data-testid="queue-resume"]')
      const composer = await box('.composer')
      const feed = await box('[data-testid="feed"]')

      assert.ok(icon.width <= 24 && icon.height <= 24, `${where}: значок ${icon.width}×${icon.height}, ждали не больше 24×24`)
      assert.ok(notice.height < 80, `${where}: плашка высотой ${notice.height}px`)
      assert.ok(textBox.width > notice.width / 2, `${where}: текст сжат в столбик ${textBox.width}px из ${notice.width}px`)
      assert.ok(resume.x >= textBox.x + textBox.width - 0.5, `${where}: «Продолжить» налезает на текст`)
      assert.ok(resume.y >= notice.y && resume.y + resume.height <= notice.y + notice.height + 0.5, `${where}: «Продолжить» вне строки плашки`)
      // Очередь живёт ПОД полем ввода (О2): поле, сразу под ним — очередь, и оба внизу окна, под лентой.
      assert.ok(composer.y >= feed.y + feed.height - 0.5, `${where}: поле ввода над лентой`)
      assert.ok(notice.y >= composer.y + composer.height - 0.5, `${where}: плашка не под полем ввода`)
      assert.ok(feed.height >= size.height * 0.4, `${where}: лента сжата до ${feed.height}px`)
      assert.ok(composer.y > size.height / 2, `${where}: поле ввода уехало наверх (y=${composer.y})`)

      // Ни один значок окна не вышел из своего размера (тот же класс ошибки в других плашках).
      const big = await h.win.evaluate(() => Array.from(document.querySelectorAll('svg'))
        .map((s) => ({ cls: s.getAttribute('class') ?? '', r: s.getBoundingClientRect() }))
        .filter((x) => x.r.width > 24 || x.r.height > 24)
        .map((x) => `${x.cls} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`))
      assert.deepEqual(big, [], `${where}: значки больше 24×24`)
    }
  })
})
