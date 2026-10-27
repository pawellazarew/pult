// e2e строки меню (docs/12 §2): значок со счётчиком ждущих запросов и меню над демоном. Нативное
// меню Playwright не открыть, поэтому тест читает модель последнего собранного меню из main
// (`__pultTestTray`) и жмёт пункт по id (`__pultTestTrayClick`) — тем же обработчиком, что и клик
// в меню. Значок и меню живут и без окна: закрыть окно ≠ потерять, кто ждёт тебя.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { TrayModel } from '../../src/tray.js'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type TrayIconInfo = { empty: boolean; template: boolean; width: number; height: number; scales: number[] }
type TrayGlobals = { __pultTestTray?: TrayModel; __pultTestTrayIcon?: TrayIconInfo; __pultTestTrayClick?: (id: string) => boolean }

describe('строка меню', () => {
  let h: Harness
  let c: Client

  before(async () => {
    h = await launch({ name: 'tray' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
  })
  after(async () => {
    if (c) {
      const left = (await c.request('perm.list', {})) as { pending: Array<{ id: string }> }
      for (const p of left.pending) await c.request('perm.resolve', { id: p.id, decision: 'deny', message: 'конец теста' })
    }
    await h?.close()
  })

  const tray = async (): Promise<TrayModel | null> => h.app.evaluate(() => (globalThis as TrayGlobals).__pultTestTray ?? null)
  const click = async (id: string): Promise<boolean> =>
    h.app.evaluate((_e, i) => (globalThis as TrayGlobals).__pultTestTrayClick?.(i) ?? false, id)
  const labelsOf = (m: TrayModel | null, prefix: string): string[] =>
    (m?.items ?? []).flatMap((i) => (i.kind === 'item' && i.id.startsWith(prefix) ? [i.label] : []))
  const pending = async (): Promise<Array<{ id: string; sessionId: string }>> =>
    ((await c.request('perm.list', {})) as { pending: Array<{ id: string; sessionId: string }> }).pending

  it('значок шаблонный 16 pt с @2x; в меню — демон с версией и режимом', async () => {
    const icon = await h.app.evaluate(() => (globalThis as TrayGlobals).__pultTestTrayIcon ?? null)
    assert.ok(icon, 'значок не создан')
    assert.deepEqual([icon.empty, icon.template, icon.width, icon.height], [false, true, 16, 16])
    assert.ok(icon.scales.includes(2), `нет варианта @2x: ${JSON.stringify(icon.scales)}`)
    assert.ok(await waitFor(async () => /^Демон \S+ · (служба|по требованию)$/.test(labelsOf(await tray(), 'daemon')[0] ?? ''), 10_000),
      `строка демона: ${JSON.stringify(labelsOf(await tray(), 'daemon'))}`)
    const m = await tray()
    assert.equal(m?.title, '')
    assert.deepEqual(labelsOf(m, 'open'), ['Открыть Пульт'])
    assert.deepEqual(labelsOf(m, 'quit'), ['Выйти из Пульта'])
  })

  it('запрос разрешения: счётчик 1, пункт «Ждут тебя» ведёт окно к запросу', async () => {
    await c.request('agent.start', { name: 'eta', kind: 'claude', cwd: h.workDir('eta', { scenario: 'simple' }) })
    await c.request('agent.start', { name: 'zeta', kind: 'claude', cwd: h.workDir('zeta', { scenario: 'demo-edit' }) })
    await c.request('agent.prompt', { name: 'zeta', text: 'Поправь округление' })
    assert.ok(await waitFor(async () => (await tray())?.title === '1', 15_000), `счётчик: ${JSON.stringify((await tray())?.title)}`)
    const [perm] = await pending()
    assert.ok(perm, 'запроса нет у демона')
    const m = await tray()
    assert.deepEqual(labelsOf(m, 'perm:'), ['zeta — Edit'])
    assert.ok(m?.items.some((i) => i.kind === 'header' && i.label === 'Ждут тебя'))
    assert.equal(labelsOf(m, 'session:')[0], '● zeta · ждёт тебя', 'ждущая сессия — первой')
    assert.match(m?.tooltip ?? '', /^Пульт · 1 ждёт тебя/)

    // Окно смотрит на другую сессию, Inbox спрятан: клик в меню обязан привести к запросу.
    if (await h.win.getByTestId('inbox').count()) await h.win.keyboard.press('Meta+I')
    await h.win.getByTestId('inbox').waitFor({ state: 'detached', timeout: 3000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="eta"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="eta"]').waitFor({ timeout: 5000 })

    assert.equal(await click(`perm:${perm.id}`), true, 'пункт запроса не нажался')
    await h.win.locator('[data-testid="conversation"][data-agent="zeta"]').waitFor({ timeout: 5000 })
    // Inbox снова открыт, и в нём выделен именно этот запрос (⌘Enter разрешит его).
    await h.win.getByTestId('inbox').locator(`[data-testid="perm-card"][data-perm-id="${perm.id}"][data-focused="true"]`).waitFor({ timeout: 5000 })
    assert.deepEqual(await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible())), [true])

    // Ответили из CLI — счётчик гаснет и пункт уходит без участия окна.
    await c.request('perm.resolve', { id: perm.id, decision: 'allow' })
    assert.ok(await waitFor(async () => (await tray())?.title === '' && labelsOf(await tray(), 'perm:').length === 0, 10_000), 'запрос не ушёл из меню')
  })

  it('окно закрыто: значок живёт и считает; пункт сессии открывает новое окно на ней', async () => {
    assert.ok(await waitFor(async () => !(await pending()).length && labelsOf(await tray(), 'session:eta').length > 0, 10_000))
    await h.win.close()
    assert.equal(h.app.windows().length, 0, 'окно не закрылось')

    await c.request('agent.prompt', { name: 'zeta', text: 'Ещё раз' })
    assert.ok(await waitFor(async () => (await tray())?.title === '1', 15_000), 'без окна счётчик не обновился')

    // Сессия eta — не та, на которую новое окно встало бы само (ждущая — zeta): переход — заслуга меню.
    const next = h.app.waitForEvent('window', { timeout: 15_000 })
    assert.equal(await click('session:eta'), true)
    const win = await next
    await win.waitForLoadState('domcontentloaded')
    // Новое окно грузится: кадр перехода main шлёт после загрузки, до подписки интерфейса его держит preload.
    await win.locator('[data-testid="conversation"][data-agent="eta"]').waitFor({ timeout: 15_000 })
    assert.equal(await win.locator('[data-testid="agent-row"][data-agent="zeta"]').getAttribute('data-needs'), '1', 'zeta по-прежнему ждёт')
  })
})
