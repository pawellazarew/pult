// e2e M8f: подвал «модель · усилие · режим» — меню (со следующего хода, строка в ленте, «Полный доступ» — с вопросом),
// «Настройки» (⌘,) → умолчания «+ Сессия» записаны в config.json, последний выбор подставляется в форму.
// 0.3.6: «Страж сети» — режим allow и страна из поиска → config.json, doctor, отказ хода с причиной в ленте.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type Rec = { name: string; model?: string; effort?: string; approval?: string }

describe('окно: настройки сессии M8f', () => {
  let h: Harness
  let c: Client

  before(async () => {
    h = await launch({ name: 'settings' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
  })
  after(async () => { await h?.close() })

  const rec = async (name: string): Promise<Rec | undefined> =>
    ((await c.request('agent.list', {})) as { sessions: Rec[] }).sessions.find((r) => r.name === name)
  const select = async (name: string): Promise<void> => {
    await h.win.locator(`[data-testid="agent-row"][data-agent="${name}"]`).click()
    await h.win.locator(`[data-testid="conversation"][data-agent="${name}"]`).waitFor({ timeout: 10_000 })
  }

  it('подвал: меню → усилие и модель со следующего хода, строка в ленте; «Полный доступ» — только после вопроса', async () => {
    await c.request('agent.start', { name: 'sm', kind: 'claude', cwd: h.workDir('sm', { scenario: 'simple' }), model: 'haiku', effort: 'low' })
    await select('sm')
    const btn = h.win.getByTestId('conv-settings')
    await btn.click()
    const menu = h.win.getByTestId('settings-menu')
    await menu.waitFor({ timeout: 5000 })
    assert.equal(await h.win.getByTestId('settings-model-haiku').getAttribute('aria-checked'), 'true')
    await h.screen('m8f-footer-menu')
    await h.win.getByTestId('settings-effort-high').click()
    assert.ok(await waitFor(async () => (await rec('sm'))?.effort === 'high', 5000), 'усилие не сменилось')
    const feed = h.win.getByTestId('feed')
    assert.ok(await waitFor(async () => /усилие: low → high — со следующего хода/.test((await feed.textContent()) ?? ''), 5000), 'строки о смене нет в ленте')
    // С клавиатуры: меню открывается, фокус на отмеченном, ↓ и Enter.
    await btn.focus()
    await h.win.keyboard.press('Enter')
    await menu.waitFor({ timeout: 5000 })
    await h.win.getByTestId('settings-model-opus').click()
    assert.ok(await waitFor(async () => (await rec('sm'))?.model === 'opus', 5000))
    // Полный доступ: вопрос; «Отмена» — ничего не меняется.
    await btn.click()
    await h.win.getByTestId('settings-approval-full').click()
    await h.win.getByTestId('confirm-configure').waitFor({ timeout: 5000 })
    await h.win.keyboard.press('Escape')
    assert.equal((await rec('sm'))?.approval, undefined)
    await btn.click()
    await h.win.getByTestId('settings-approval-full').click()
    await h.win.getByTestId('confirm-ok').click()
    assert.ok(await waitFor(async () => (await rec('sm'))?.approval === 'full', 5000))
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-approval').getAttribute('data-approval')) === 'full', 5000))
  })

  it('⌘, → «Настройки»: умолчания записаны в config.json; «Подставлять последний выбор» выключен — «+ Сессия» с умолчаниями', async () => {
    await h.win.keyboard.press('Meta+,')
    const dlg = h.win.getByTestId('settings-dialog')
    await dlg.waitFor({ timeout: 5000 })
    assert.match((await h.win.getByTestId('settings-appearance').textContent()) ?? '', /после редизайна/)
    await h.screen('m8f-settings')
    await h.win.getByTestId('settings-claude-model').selectOption('opus')
    await h.win.getByTestId('settings-claude-effort').selectOption('high')
    await h.win.getByTestId('settings-claude-approval').selectOption('read-only')
    await h.win.getByTestId('settings-remember-last').uncheck()
    await h.win.getByTestId('settings-save').click()
    assert.ok(await waitFor(async () => (await dlg.count()) === 0, 5000), 'диалог не закрылся после сохранения')
    const cfg = JSON.parse(readFileSync(h.paths.config, 'utf8')) as { newSession?: { rememberLast: boolean; defaults: { claude: Record<string, unknown> } } }
    assert.equal(cfg.newSession?.rememberLast, false)
    assert.deepEqual(cfg.newSession?.defaults.claude, { model: 'opus', effort: 'high', approval: 'read-only' })
    // «+ Сессия» — с умолчаниями.
    await h.win.keyboard.press('Meta+N')
    const form = h.win.getByTestId('new-agent-dialog')
    await form.waitFor({ timeout: 5000 })
    assert.equal(await h.win.getByTestId('new-agent-approval').inputValue(), 'read-only')
    assert.equal(await h.win.locator('[aria-label="Модель"] button[aria-pressed="true"]').textContent(), 'opus')
    await h.win.keyboard.press('Escape')
  })

  it('«Страж сети»: разрешать только DE → config.json и doctor; выход XX — ход отказан, причина в ленте', async () => {
    await h.win.keyboard.press('Meta+,')
    const dlg = h.win.getByTestId('settings-dialog')
    await dlg.waitFor({ timeout: 5000 })
    await h.win.getByTestId('settings-net-guard').waitFor({ timeout: 5000 })
    // Тестовый страж (PULT_TEST_NET=ok) отвечает выходом XX. Выход известен по doctor при подключении окна; нет —
    // «Проверить сеть».
    const exit = h.win.getByTestId('guard-exit-claude')
    if ((await exit.getAttribute('data-ok')) !== 'true') await h.win.getByTestId('guard-check').click()
    assert.ok(await waitFor(async () => (await exit.getAttribute('data-ok')) === 'true', 15_000), `выход не проверен: ${await exit.textContent()}`)
    assert.match((await exit.textContent()) ?? '', /claude: выход XX — проходит/)
    await h.win.getByTestId('guard-mode-allow').check()
    assert.equal(await h.win.getByTestId('settings-save').isDisabled(), true, 'allow без стран сохранять нельзя')
    assert.match((await h.win.getByTestId('settings-error').textContent()) ?? '', /хотя бы одна страна/)
    await h.win.getByTestId('guard-search').fill('герм')
    await h.win.getByTestId('guard-add-DE').click()
    await h.win.locator('[data-testid="guard-chip"][data-code="DE"]').waitFor({ timeout: 5000 })
    assert.match((await h.win.getByTestId('guard-warning').textContent()) ?? '', /С этими правилами сейчас ходы не пойдут: claude \(выход XX\)/)
    assert.match((await exit.textContent()) ?? '', /не проходит/)
    await h.screen('net-guard-settings')
    await h.win.getByTestId('settings-save').click()
    assert.ok(await waitFor(async () => (await dlg.count()) === 0, 5000), 'диалог не закрылся после сохранения')
    const cfg = JSON.parse(readFileSync(h.paths.config, 'utf8')) as { network?: { guard?: unknown } }
    assert.deepEqual(cfg.network?.guard, { mode: 'allow', countries: ['DE'] })

    const report = (await c.request('doctor.run', { net: true })) as { items: Array<{ id: string; detail: string; data?: Record<string, unknown> }> }
    assert.match(report.items.find((i) => i.id === 'guard.rule')?.detail ?? '', /разрешать только: DE/)
    assert.equal(report.items.find((i) => i.id === 'net.claude')?.data?.['reason'], 'not_allowed_country')

    await c.request('agent.start', { name: 'ng', kind: 'claude', cwd: h.workDir('ng', { scenario: 'simple' }) })
    await select('ng')
    await c.request('agent.prompt', { name: 'ng', text: 'привет' }).catch(() => undefined)
    const feed = h.win.getByTestId('feed')
    assert.ok(await waitFor(async () => /Сеть заблокирована стражем — страны выхода нет в списке разрешённых/.test((await feed.textContent()) ?? ''), 10_000),
      `причины отказа нет в ленте: ${(await feed.textContent()) ?? ''}`)
  })

  it('«Страж сети»: правка из терминала видна при открытии; правка во время открытого диалога — отказ «изменилось снаружи»', async () => {
    const chip = (code: string) => h.win.locator(`[data-testid="guard-chip"][data-code="${code}"]`)
    // Окно читало allow DE; правило меняют мимо окна (как `pult net guard --deny CN`).
    await c.request('settings.set', { network: { guard: { mode: 'deny', countries: ['CN'] } } })
    await h.win.keyboard.press('Meta+,')
    const dlg = h.win.getByTestId('settings-dialog')
    await dlg.waitFor({ timeout: 5000 })
    await chip('CN').waitFor({ timeout: 5000 })
    assert.equal(await h.win.getByTestId('guard-mode-deny').isChecked(), true, 'диалог встал на свежее правило')
    assert.equal(await chip('DE').count(), 0)
    // Диалог открыт, а правило снова меняют снаружи; правка в устаревшем диалоге не затирает его.
    await c.request('settings.set', { network: { guard: { mode: 'deny', countries: ['IR'] } } })
    const before = readFileSync(h.paths.config, 'utf8')
    await h.win.getByTestId('guard-chip-remove-CN').click()
    await h.win.getByTestId('guard-search').fill('куба')
    await h.win.getByTestId('guard-add-CU').click()
    await h.win.getByTestId('settings-save').click()
    assert.ok(await waitFor(async () => /изменилось снаружи/.test((await h.win.getByTestId('settings-error').textContent().catch(() => '')) ?? ''), 5000), 'отказа нет')
    assert.equal(readFileSync(h.paths.config, 'utf8'), before, 'правило из терминала не затёрто')
    await h.win.keyboard.press('Escape')
    assert.ok(await waitFor(async () => (await dlg.count()) === 0, 5000))
  })
})
