// e2e быстрого старта, шаг A: доступ (design/2026-11-02-quick-start/DESIGN-REVIEW.md §3.6).
//   * «Новая сессия» → «Полный доступ» без согласия — диалог согласия поверх формы; фокус на «Оставить как было»,
//     Enter и Esc — оставить; «Разрешить» — согласие в PULT_HOME/consent.json (0600), форма живёт дальше;
//   * чат с полным доступом: плашка в шапке, щит в сайдбаре, красный чип и рамка поля, «Стоп» во время хода;
//     действующий режим — из system/init (bypassPermissions);
//   * понижение во время хода: «Спрашивать · после хода», «полный доступ · до конца хода», строка под полем;
//   * «Настройки → Доступ» → «Отозвать»: следующий ход идёт в явном «Спрашивать» (manual), в ленте — почему.
// Кадры (светлая тема) — test-results/screens/access-*.png.

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type Rec = { name: string; approval?: string; lastStatus: string; access?: { red: boolean; pending: boolean; live: boolean; applied?: { reported: string | null; confirmed: boolean; full: boolean } } }

describe('окно: доступ — согласие один раз и метки по действующему режиму (шаг A)', () => {
  let h: Harness
  let c: Client

  before(async () => {
    h = await launch({ name: 'access' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
    await h.scheme('light')
  })
  after(async () => { await h?.close() })

  const rec = async (name: string): Promise<Rec | undefined> =>
    ((await c.request('agent.list', {})) as { sessions: Rec[] }).sessions.find((r) => r.name === name)
  const lastArgv = (file: string): string[] => (JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1) as string) as { argv: string[] }).argv
  const flag = (argv: string[], f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
  const argvOut = (): string => join(h.home, 'full-argv.jsonl')

  it('«Новая сессия»: полный доступ — диалог согласия; Enter и Esc оставляют как было, «Разрешить» пишет consent.json', async () => {
    // Ход висит после init: метки видны, пока он идёт, и «Стоп» на месте.
    const dir = h.workDir('full', { scenario: 'simple', hangAfterInit: 60_000, argvOut: argvOut() })
    await h.stubPickFolder(dir)
    await h.win.keyboard.press('Meta+N')
    const dlg = h.win.getByTestId('new-agent-dialog')
    await dlg.waitFor({ timeout: 5000 })
    await dlg.getByTestId('pick-folder').click()
    assert.ok(await waitFor(async () => (await dlg.getByTestId('new-agent-cwd').getAttribute('data-path')) === dir, 5000), 'папка не выбралась')
    const select = dlg.getByTestId('new-agent-approval')
    assert.equal(await select.inputValue(), 'ask')
    await select.selectOption('full')
    const consent = h.win.getByTestId('consent-dialog')
    await consent.waitFor({ timeout: 5000 })
    assert.equal(await h.win.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'consent-keep', 'фокус — на «Оставить как было»')
    const body = (await consent.textContent()) ?? ''
    assert.match(body, /Полный доступ: Claude и Codex/)
    assert.match(body, /bypassPermissions/)
    assert.match(body, /danger-full-access/)
    assert.match(body, /Твои MCP-серверы и shell — нет/)
    // Случайный Enter — «Оставить как было»: поле не меняется, форма открыта.
    await h.win.keyboard.press('Enter')
    assert.ok(await waitFor(async () => (await consent.count()) === 0, 5000), 'Enter не закрыл диалог')
    assert.equal(await select.inputValue(), 'ask')
    await select.selectOption('full')
    await consent.waitFor({ timeout: 5000 })
    await h.win.keyboard.press('Escape')
    assert.ok(await waitFor(async () => (await consent.count()) === 0, 5000), 'Esc не закрыл диалог')
    assert.equal(await dlg.count(), 1, 'Esc закрыл только диалог согласия, а не «Новую сессию»')
    assert.equal(await select.inputValue(), 'ask')
    await select.selectOption('full')
    await consent.waitFor({ timeout: 5000 })
    await h.screen('access-consent-light')
    await h.win.getByTestId('consent-grant').click()
    assert.ok(await waitFor(async () => (await consent.count()) === 0, 5000))
    assert.equal(await select.inputValue(), 'full')
    const file = JSON.parse(readFileSync(h.paths.consent, 'utf8')) as { version: number; rev: number; providers: string[] }
    assert.deepEqual([file.version, file.rev, file.providers], [1, 1, ['claude', 'codex']])
    assert.equal(statSync(h.paths.consent).mode & 0o777, 0o600)

    await dlg.getByTestId('new-agent-prompt').fill('Поправь пагинацию и прогони миграцию')
    await dlg.getByTestId('new-agent-submit').click()
    await dlg.waitFor({ state: 'detached', timeout: 10_000 })
    await h.win.locator('[data-testid="conversation"][data-agent="full"]').waitFor({ timeout: 10_000 })
    assert.equal((await rec('full'))?.approval, 'full')
  })

  it('чат с полным доступом: плашка, щит в сайдбаре, красный чип и рамка; режим подтверждён init-ом; «Стоп» виден', async () => {
    assert.ok(await waitFor(async () => (await rec('full'))?.access?.applied?.reported === 'bypassPermissions', 15_000), 'действующий режим не пришёл из system/init')
    assert.equal(flag(lastArgv(argvOut()), '--permission-mode'), 'bypassPermissions')
    const r = await rec('full')
    assert.deepEqual([r?.access?.red, r?.access?.live, r?.access?.applied?.confirmed, r?.access?.applied?.full], [true, true, true, true])
    await h.win.getByTestId('conv-access-pill').waitFor({ timeout: 5000 })
    assert.equal(await h.win.getByTestId('conv-access-pill').getAttribute('data-state'), 'full')
    await h.win.locator('[data-testid="agent-row"][data-agent="full"] [data-testid="row-access-full"]').waitFor({ timeout: 5000 })
    assert.match((await h.win.getByTestId('conv-approval').getAttribute('class')) ?? '', /t-fail/)
    assert.equal(await h.win.locator('.composer .box').getAttribute('data-access-full'), '1')
    await h.win.getByTestId('stop-turn').waitFor({ timeout: 10_000 })
    // Окно узнаёт действующий режим со следующим `agent.list` (раз в 4 с): до него чип честно пишет «ожидается».
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-approval').getAttribute('data-access-state')) === 'full', 8000), 'чип не подтвердил режим')
    await h.screen('access-badge-light')
  })

  it('понижение во время хода: «после хода», «до конца хода», строка под полем; после стопа метка гаснет', async () => {
    await h.win.getByTestId('conv-settings').click()
    await h.win.getByTestId('settings-menu').waitFor({ timeout: 5000 })
    await h.win.getByTestId('settings-approval-ask').click()
    assert.ok(await waitFor(async () => (await rec('full'))?.access?.pending === true, 5000), 'ожидающий режим не виден демону')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-approval').getAttribute('data-access-state')) === 'pending', 6000), 'чип не «после хода»')
    assert.match((await h.win.getByTestId('conv-access-suffix').textContent()) ?? '', /после хода/)
    assert.equal(await h.win.getByTestId('conv-access-pill').getAttribute('data-state'), 'until-turn-end')
    await h.win.getByTestId('access-pending-strip').waitFor({ timeout: 5000 })
    assert.ok(await waitFor(async () => /Доступ: Полный доступ → Спрашивать · применится, когда закончится текущий ход/.test((await h.win.getByTestId('feed').textContent()) ?? ''), 6000),
      'строки о понижении нет в ленте')
    await h.screen('access-pending-light')
    await c.request('agent.stop', { name: 'full' })
    assert.ok(await waitFor(async () => (await rec('full'))?.lastStatus === 'interrupted', 10_000), 'ход не остановился')
    assert.ok(await waitFor(async () => (await rec('full'))?.access?.red === false, 10_000), 'красная метка не погасла после стопа')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-access-pill').count()) === 0, 6000), 'плашка не ушла')
  })

  it('«Настройки → Доступ» → «Отозвать»: следующий ход полного доступа — в явном «Спрашивать» и заметка в ленте', async () => {
    // Обратно в полный — согласие есть, вопроса нет; потом отзыв.
    await h.win.getByTestId('conv-settings').click()
    await h.win.getByTestId('settings-approval-full').click()
    assert.ok(await waitFor(async () => (await rec('full'))?.approval === 'full', 5000))
    assert.equal(await h.win.getByTestId('consent-dialog').count(), 0, 'согласие уже есть — без диалога')
    await h.win.keyboard.press('Meta+,')
    const dlg = h.win.getByTestId('settings-dialog')
    await dlg.waitFor({ timeout: 5000 })
    assert.match((await h.win.getByTestId('access-consent-line').textContent()) ?? '', /Полный доступ разрешён \d\d\.\d\d\.\d{4}/)
    await h.win.getByTestId('access-revoke').click()
    assert.ok(await waitFor(async () => /отозван/.test((await h.win.getByTestId('access-consent-line').textContent()) ?? ''), 5000), 'строка не сменилась')
    await h.win.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached', timeout: 5000 })
    // Ход висеть больше не должен: тот же сценарий без паузы.
    h.workDir('full', { scenario: 'simple', argvOut: argvOut() })
    await c.request('agent.prompt', { name: 'full', text: 'дальше' })
    assert.ok(await waitFor(async () => (await rec('full'))?.lastStatus === 'idle', 15_000), 'ход не закончился')
    assert.equal(flag(lastArgv(argvOut()), '--permission-mode'), 'manual', 'после отзыва — явный «Спрашивать»')
    assert.ok(await waitFor(async () => /полный доступ отозван — ход в «Спрашивать»/.test((await h.win.getByTestId('feed').textContent()) ?? ''), 6000), 'заметки в ленте нет')
    assert.equal(await h.win.getByTestId('conv-approval').getAttribute('data-access-state'), 'blocked')
  })
})
