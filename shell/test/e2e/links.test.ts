// e2e ссылок pult:// (docs/14 О3). macOS отдаёт ссылку событием `open-url` — тест шлёт его в main
// тем же `app.emit`, что и система; холодный старт — ссылкой в argv (так её отдаёт Linux), до ready.
// Главное: `pult://new` только открывает черновик (шаг B быстрого старта) — без «Отправить» демон не видит ни одной новой
// сессии, а папку подставляет, только если она уже знакома (проект или папка сессии). В тестовом прогоне
// оболочка обработчиком pult:// в системе не регистрируется. Предел частоты ссылок сжат до 400 мс.

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { NavTarget } from '../../src/contract.js'
import { launch, sleep, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type Rec = { name: string; cwd?: string; provider?: string }
type LinkGlobals = {
  __pultTestLinks?: Array<{ via: string; ok: boolean; reason?: string; target?: NavTarget }>
  __pultTestLinkDelivered?: NavTarget[]
  __pultTestProtocolClient?: boolean
}

const GAP_MS = 400
const COLD_PATH = '/nonexistent/холодный старт'
const COLD_PROMPT = 'Проверь README\nи «закоммить» c++ — 100% & готово?'
const COLD_URL = `pult://new?path=${encodeURIComponent(COLD_PATH)}&prompt=${encodeURIComponent(COLD_PROMPT)}&provider=codex`
const enc = encodeURIComponent

describe('ссылки pult://', () => {
  let h: Harness
  let c: Client

  before(async () => {
    h = await launch({ name: 'links', args: [COLD_URL], env: { PULT_TEST_LINK_GAP_MS: String(GAP_MS) } })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
  })
  after(async () => { await h?.close() })

  const list = async (): Promise<Rec[]> => ((await c.request('agent.list', {})) as { sessions: Rec[] }).sessions
  const links = async (): Promise<NonNullable<LinkGlobals['__pultTestLinks']>> =>
    h.app.evaluate(() => (globalThis as LinkGlobals).__pultTestLinks ?? [])
  const delivered = async (): Promise<NavTarget[]> => h.app.evaluate(() => (globalThis as LinkGlobals).__pultTestLinkDelivered ?? [])
  const openUrl = async (url: string): Promise<void> => {
    await h.app.evaluate(({ app }, u) => {
      (app as unknown as { emit(e: string, ...a: unknown[]): boolean }).emit('open-url', { preventDefault() {} }, u)
    }, url)
  }
  /** Следующая годная ссылка — не раньше предела частоты. */
  const gap = (): Promise<void> => sleep(GAP_MS + 100)

  /** Убрать черновик из списка (с текстом Esc его не трогает) — меню строки в сайдбаре. */
  const removeDraft = async (id: string): Promise<void> => {
    await h.win.locator(`[data-testid="draft-row"][data-draft="${id}"]`).click({ button: 'right' })
    await h.win.getByTestId('draft-menu-list').getByTestId('draft-remove').click()
    await h.win.locator(`[data-testid="draft-row"][data-draft="${id}"]`).waitFor({ state: 'detached', timeout: 5000 })
  }

  it('холодный старт по ссылке: черновик заполнен, чужая папка не подставлена, сессия не заведена', async () => {
    const d = h.win.getByTestId('draft')
    await d.waitFor({ timeout: 20_000 })
    await d.getByTestId('draft-from-link').waitFor({ timeout: 2000 })
    // Папки нет среди проектов и сессий (её и на диске нет) — чип пустой, человек выбирает сам.
    await d.getByTestId('draft-link-path-rejected').waitFor({ timeout: 2000 })
    assert.equal(await d.getByTestId('draft-chip-folder').getAttribute('data-path'), '')
    assert.equal(await d.getByTestId('draft-input').inputValue(), COLD_PROMPT, '`+` остался `+`')
    assert.equal(await d.getByTestId('draft-chip-model').getAttribute('data-provider'), 'codex')
    assert.notEqual(await d.getByTestId('draft-input').evaluate((el) => el === document.activeElement), true, 'черновик из ссылки фокус не берёт')
    const seen = await links()
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], { via: 'argv', ok: true, target: { newSession: { path: COLD_PATH, prompt: COLD_PROMPT, provider: 'codex' }, link: true } })
    assert.deepEqual(await delivered(), [{ newSession: { pathRejected: true, prompt: COLD_PROMPT, provider: 'codex' }, link: true }])
    assert.equal(await h.app.evaluate(() => (globalThis as LinkGlobals).__pultTestProtocolClient), false, 'PULT_TEST не регистрирует pult:// в системе')
    // Ничего не запущено без человека; ↵ без папки открывает меню папки, а не заводит чат.
    await sleep(1100)
    await d.getByTestId('draft-input').press('Enter')
    await d.getByTestId('draft-menu-folder').waitFor({ timeout: 3000 })
    await h.win.keyboard.press('Escape')
    await d.getByTestId('draft-menu-folder').waitFor({ state: 'detached', timeout: 3000 })
    assert.deepEqual(await list(), [])
    await removeDraft((await d.getAttribute('data-draft')) as string)
    await d.waitFor({ state: 'detached', timeout: 5000 })
    assert.deepEqual(await list(), [])
  })

  it('pult://session/<имя> ведёт окно к сессии: поле ввода без фокуса, клавиши полсекунды глотаются', async () => {
    await c.request('agent.start', { name: 'alpha', kind: 'claude', cwd: h.workDir('alpha') })
    await c.request('agent.start', { name: 'beta', kind: 'claude', cwd: h.workDir('beta') })
    await h.win.locator('[data-testid="agent-row"][data-agent="beta"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="beta"]').waitFor({ timeout: 10_000 })
    await gap()
    await openUrl('pult://session/alpha')
    // В той же оценке, что и ожидание перехода: окно защиты — полсекунды, ход Playwright туда-обратно его съел бы.
    const r = await h.win.evaluate(async () => {
      const t0 = Date.now()
      while (!document.querySelector('[data-testid="conversation"][data-agent="alpha"]') && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 5))
      await new Promise((res) => requestAnimationFrame(() => res(null)))
      const enter = !window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true }))
      const letter = !window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', cancelable: true }))
      const escape = !window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      return { arrived: Date.now() - t0 < 10_000, enter, letter, escape, active: document.activeElement?.getAttribute('data-testid') ?? null }
    })
    assert.deepEqual(r, { arrived: true, enter: true, letter: true, escape: false, active: null })
    assert.equal((await links()).at(-1)?.via, 'open-url')
    await sleep(600)
    const later = await h.win.evaluate(() => !window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', cancelable: true })))
    assert.equal(later, false, 'после окна защиты клавиши снова доходят')
  })

  it('pult://new с чужой папкой: папку не подставляет, выбор — системным диалогом', async () => {
    const dir = h.workDir('stranger', { scenario: 'simple' })
    await gap()
    await openUrl(`pult://new?path=${enc(dir)}`)
    const d = h.win.getByTestId('draft')
    await d.waitFor({ timeout: 5000 })
    await d.getByTestId('draft-link-path-rejected').waitFor({ timeout: 2000 })
    assert.equal(await d.getByTestId('draft-chip-folder').getAttribute('data-path'), '')
    await h.stubPickFolder(dir)
    await d.getByTestId('draft-pick-folder').click()
    assert.ok(await waitFor(async () => (await d.getByTestId('draft-chip-folder').getAttribute('data-path')) === dir, 5000), 'выбор папки не сработал')
    assert.equal(await d.getByTestId('draft-link-path-rejected').count(), 0, 'пометка ушла с выбором папки')
    // Пустой черновик Esc убирает.
    await h.win.keyboard.press('Escape')
    await d.waitFor({ state: 'detached', timeout: 5000 })
    assert.deepEqual((await list()).map((r) => r.name).sort(), ['alpha', 'beta'])
  })

  it('pult://new с папкой проекта (через симлинк): путь проекта; отправка заперта секунду; вторая ссылка — новый черновик', async () => {
    const dir = h.workDir('linked', { scenario: 'simple' })
    const added = (await c.request('project.add', { path: dir })) as { path: string }
    const alias = path.join(h.home, 'aliases', 'linked-alias')
    mkdirSync(path.dirname(alias), { recursive: true })
    symlinkSync(dir, alias)
    await gap()
    await openUrl(`pult://new?path=${enc(alias)}&prompt=${enc('Скажи одно слово')}`)
    const d = h.win.getByTestId('draft')
    await d.waitFor({ timeout: 5000 })
    const first = (await d.getAttribute('data-draft')) as string
    const submit = d.getByTestId('draft-send')
    assert.equal(await submit.isDisabled(), true, 'кнопка заперта сразу после ссылки')
    // В черновик идёт путь проекта, как его хранит демон, а не путь из ссылки.
    assert.equal(await d.getByTestId('draft-chip-folder').getAttribute('data-path'), added.path)
    assert.equal(await d.getByTestId('draft-location').getAttribute('title'), added.path, 'путь целиком — в подсказке')
    assert.equal(await d.getByTestId('draft-link-path-rejected').count(), 0)
    await sleep(500)
    assert.deepEqual((await list()).map((r) => r.name).sort(), ['alpha', 'beta'], 'ссылка сама ничего не завела')

    // Вторая ссылка открытый черновик не подменяет — заводит новый; первый остаётся в списке с текстом.
    await gap()
    await openUrl('pult://new?provider=codex&prompt=other')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('draft').getAttribute('data-draft')) !== first, 5000), 'нового черновика нет')
    const second = (await h.win.getByTestId('draft').getAttribute('data-draft')) as string
    assert.equal(await h.win.getByTestId('draft-input').inputValue(), 'other')
    assert.equal(await h.win.getByTestId('draft-row').count(), 2)
    await removeDraft(second)
    await h.win.locator(`[data-testid="draft-row"][data-draft="${first}"]`).click()
    await d.waitFor({ timeout: 5000 })
    assert.equal(await d.getByTestId('draft-input').inputValue(), 'Скажи одно слово')
    assert.ok(await waitFor(async () => !(await submit.isDisabled()), 3000), 'кнопка так и не открылась')
    await submit.click()
    await d.waitFor({ state: 'detached', timeout: 10_000 })
    await h.win.locator('[data-testid="conversation"][data-agent="linked"]').waitFor({ timeout: 10_000 })
    const rec = (await list()).find((r) => r.name === 'linked')
    assert.deepEqual([rec?.provider, rec?.cwd], ['claude', added.path])
    assert.ok(await waitFor(async () => /Скажи одно слово/.test((await h.win.getByTestId('feed').textContent()) ?? ''), 10_000), 'первая реплика не ушла')
    assert.equal(await h.win.getByTestId('draft-row').count(), 0, 'отправленный черновик ушёл из списка')
  })

  it('предел частоты: вторая годная ссылка следом — отброшена', async () => {
    await gap()
    const before = (await links()).length
    await openUrl('pult://session/alpha')
    await openUrl('pult://session/beta')
    const seen = (await links()).slice(before)
    assert.deepEqual(seen.map((l) => [l.ok, l.reason ?? null]), [[true, null], [false, 'частая ссылка']])
    await h.win.locator('[data-testid="conversation"][data-agent="alpha"]').waitFor({ timeout: 5000 })
    await sleep(300)
    assert.equal(await h.win.locator('[data-testid="conversation"][data-agent="beta"]').count(), 0)
  })

  it('злые и кривые ссылки отвергаются в main: ни диалога, ни перехода', async () => {
    await gap()
    const before = (await links()).length
    const bad = [
      'pult://new?path=/tmp/../etc&prompt=x',
      'pult://new?path=relative/dir',
      'pult://new?provider=bash',
      `pult://new?prompt=${'я'.repeat(10_001)}`,
      `pult://new?prompt=${enc('x\n'.repeat(200))}`,
      `pult://new?path=${enc('/tmp/‮exe.txt')}`,
      `pult://new?prompt=${enc('a​b')}`,
      `pult://new?prompt=${enc('a﻿b')}`,
      `pult://new?prompt=${enc('a\u0085b')}`,
      'pult://session/../beta',
      'pult://session/Beta',
      'pult://session:/beta',
      'pult://ses\nsion/beta',
      'pult://u:p@session/beta',
      'pult://session/beta#x',
      'pult://start?name=x',
      'pult:session/beta',
      'javascript:alert(1)',
      'https://example.com',
    ]
    for (const u of bad) await openUrl(u)
    const seen = (await links()).slice(before)
    assert.equal(seen.length, bad.length)
    assert.deepEqual(seen.filter((l) => l.ok), [], JSON.stringify(seen))
    assert.ok(seen.every((l) => typeof l.reason === 'string' && l.reason.length > 0 && l.reason !== 'частая ссылка'))
    await sleep(300)
    assert.equal(await h.win.getByTestId('draft').count(), 0)
    await h.win.locator('[data-testid="conversation"][data-agent="alpha"]').waitFor({ timeout: 2000 })
  })

  it('ссылка на сессию, которой нет, — строка в шапке', async () => {
    await gap()
    await openUrl('pult://session/ghost')
    assert.ok(await waitFor(async () => /ghost/.test((await h.win.getByTestId('action-error').textContent({ timeout: 500 }).catch(() => '')) ?? ''), 5000))
    await h.win.locator('[data-testid="conversation"][data-agent="alpha"]').waitFor({ timeout: 2000 })
  })

  it('окно закрыто: ссылка открывает новое окно сразу на сессии', async () => {
    await h.win.close()
    assert.equal(h.app.windows().length, 0, 'окно не закрылось')
    await gap()
    const next = h.app.waitForEvent('window', { timeout: 15_000 })
    await openUrl('pult://session/beta')
    const win = await next
    await win.waitForLoadState('domcontentloaded')
    await win.locator('[data-testid="conversation"][data-agent="beta"]').waitFor({ timeout: 15_000 })
  })
})
