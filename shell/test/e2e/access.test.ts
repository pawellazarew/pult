// e2e быстрого старта, шаги A и B: доступ (design/2026-11-02-quick-start/DESIGN-REVIEW.md §3.6–§3.9).
//   * черновик (⌘N) → «Полный доступ» без согласия — диалог согласия; фокус на «Оставить как было», Enter и Esc —
//     оставить; «Разрешить» — согласие в PULT_HOME/consent.json (0600), черновик живёт дальше;
//   * чат с полным доступом: плашка в шапке, щит в сайдбаре, красный чип и рамка поля, «Стоп» во время хода;
//     действующий режим — из system/init (bypassPermissions);
//   * понижение во время хода: «Спрашивать · после хода», «полный доступ · до конца хода», строка под полем;
//   * «Настройки → Доступ» → «Отозвать»: следующий ход идёт в явном «Спрашивать» (manual), в ленте — почему;
//   * шаг B: память доступа папки — ⌘N → текст → ↵ сразу с запомненным; брошенный черновик и «Только этот чат» её не
//     пишут; ключ — настоящая папка (симлинк — та же); черновик из ссылки полный сам не включает.
// Кадры (светлая тема) — test-results/screens/access-*.png.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Locator } from 'playwright-core'
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

  const draft = (): Locator => h.win.getByTestId('draft')
  const accessChip = (): Locator => draft().getByTestId('draft-chip-access')
  const pickAccess = async (level: string): Promise<void> => {
    await accessChip().click()
    await h.win.locator(`[data-testid="draft-access-item"][data-value="${level}"]`).click()
  }
  const memory = async (cwd: string): Promise<string | undefined> =>
    ((await c.request('agent.preflight', { cwd })) as { folder?: { access?: string } }).folder?.access

  it('черновик: полный доступ — диалог согласия; Enter и Esc оставляют как было, «Разрешить» пишет consent.json', async () => {
    // Ход висит после init: метки видны, пока он идёт, и «Стоп» на месте.
    const dir = h.workDir('full', { scenario: 'simple', hangAfterInit: 60_000, argvOut: argvOut() })
    await h.stubPickFolder(dir)
    await h.win.keyboard.press('Meta+N')
    await draft().waitFor({ timeout: 5000 })
    await draft().getByTestId('draft-pick-folder').click()
    assert.ok(await waitFor(async () => (await draft().getByTestId('draft-chip-folder').getAttribute('data-path')) === dir, 5000), 'папка не выбралась')
    assert.equal(await accessChip().getAttribute('data-approval'), 'workspace', 'новая папка — «Правки в папке» (решение Павла)')
    await pickAccess('full')
    const consent = h.win.getByTestId('consent-dialog')
    await consent.waitFor({ timeout: 5000 })
    assert.equal(await h.win.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'consent-keep', 'фокус — на «Оставить как было»')
    const body = (await consent.textContent()) ?? ''
    assert.match(body, /Полный доступ: Claude, Codex и ZCode/)
    assert.match(body, /bypassPermissions/)
    assert.match(body, /danger-full-access/)
    assert.match(body, /Твои MCP-серверы и shell — нет/)
    // Случайный Enter — «Оставить как было»: уровень не меняется, черновик на месте.
    await h.win.keyboard.press('Enter')
    assert.ok(await waitFor(async () => (await consent.count()) === 0, 5000), 'Enter не закрыл диалог')
    assert.equal(await accessChip().getAttribute('data-approval'), 'workspace')
    await pickAccess('full')
    await consent.waitFor({ timeout: 5000 })
    await h.win.keyboard.press('Escape')
    assert.ok(await waitFor(async () => (await consent.count()) === 0, 5000), 'Esc не закрыл диалог')
    assert.equal(await draft().count(), 1, 'Esc закрыл только диалог согласия, а не черновик')
    assert.equal(await accessChip().getAttribute('data-approval'), 'workspace')
    await pickAccess('full')
    await consent.waitFor({ timeout: 5000 })
    await h.screen('access-consent-light')
    await h.win.getByTestId('consent-grant').click()
    assert.ok(await waitFor(async () => (await consent.count()) === 0, 5000))
    assert.equal(await accessChip().getAttribute('data-approval'), 'full')
    assert.equal(await draft().locator('.draft-box').getAttribute('data-access-full'), '1', 'красная рамка поля')
    const file = JSON.parse(readFileSync(h.paths.consent, 'utf8')) as { version: number; rev: number; providers: string[] }
    assert.deepEqual([file.version, file.rev, file.providers], [1, 1, ['claude', 'codex', 'zcode']])
    assert.equal(statSync(h.paths.consent).mode & 0o777, 0o600)

    await draft().getByTestId('draft-input').fill('Поправь пагинацию и прогони миграцию')
    await draft().getByTestId('draft-input').press('Enter')
    await draft().waitFor({ state: 'detached', timeout: 10_000 })
    await h.win.locator('[data-testid="conversation"][data-agent="full"]').waitFor({ timeout: 10_000 })
    assert.equal((await rec('full'))?.approval, 'full')
    assert.equal(await memory(dir), 'full', 'явный выбор при отправке — в память папки')
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
    await h.win.getByTestId('settings-nav-access').click()
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
  it('шаг B: память папки — «Только чтение» запоминается; ⌘N → текст → ↵ сразу с ним; брошенный черновик и «Только этот чат» не пишут', async () => {
    const dir = h.workDir('mem', { scenario: 'simple' })
    await h.stubPickFolder(dir)
    await h.win.locator('[data-testid="agent-row"][data-agent="full"]').click()
    await h.win.keyboard.press('Meta+N')
    await draft().waitFor({ timeout: 5000 })
    await draft().getByTestId('draft-chip-folder').click()
    await h.win.getByTestId('draft-folder-other').click()
    assert.ok(await waitFor(async () => (await draft().getByTestId('draft-chip-folder').getAttribute('data-path')) === dir, 5000), 'папка не выбралась')
    await pickAccess('read-only')
    assert.ok(await waitFor(async () => (await accessChip().getAttribute('data-approval')) === 'read-only', 5000), `доступ: ${await accessChip().getAttribute('data-approval')}`)
    await h.win.keyboard.type('раз')
    assert.equal(await accessChip().getAttribute('data-approval'), 'read-only', 'ввод сбросил доступ')
    await h.win.keyboard.press('Enter')
    await h.win.locator('[data-testid="conversation"][data-agent="mem"]').waitFor({ timeout: 10_000 })
    assert.equal((await rec('mem'))?.approval, 'read-only')
    assert.equal(await memory(dir), 'read-only')

    // Следующий ⌘N в этой папке: доступ из памяти, ни одного клика — ⌘N, текст, ↵.
    await h.win.keyboard.press('Meta+N')
    await draft().waitFor({ timeout: 5000 })
    assert.ok(await waitFor(async () => (await accessChip().getAttribute('data-approval')) === 'read-only', 5000), 'память папки не подставилась')
    await h.win.keyboard.type('два')
    await h.win.keyboard.press('Enter')
    await h.win.locator('[data-testid="conversation"][data-agent="mem-2"]').waitFor({ timeout: 10_000 })
    assert.equal((await rec('mem-2'))?.approval, 'read-only')

    // Брошенный пустой черновик: выбор доступа не пишется, сам черновик исчезает.
    await h.win.keyboard.press('Meta+N')
    await draft().waitFor({ timeout: 5000 })
    await pickAccess('workspace')
    await h.win.locator('[data-testid="agent-row"][data-agent="mem"]').click()
    await draft().waitFor({ state: 'detached', timeout: 5000 })
    assert.equal(await h.win.getByTestId('draft-row').count(), 0, 'пустой черновик не остался в списке')
    assert.equal(await memory(dir), 'read-only', 'брошенный черновик память не пишет')

    // «Только этот чат»: уровень — этому чату, память папки не трогается.
    await h.win.keyboard.press('Meta+N')
    await draft().waitFor({ timeout: 5000 })
    await accessChip().click()
    await h.win.getByTestId('draft-access-chat-only').click()
    await h.win.locator('[data-testid="draft-access-item"][data-value="ask"]').click()
    await h.win.keyboard.type('три')
    await h.win.keyboard.press('Enter')
    await h.win.locator('[data-testid="conversation"][data-agent="mem-3"]').waitFor({ timeout: 10_000 })
    assert.equal((await rec('mem-3'))?.approval ?? 'ask', 'ask')
    assert.equal(await memory(dir), 'read-only', '«Только этот чат» память не пишет')
  })

  it('шаг B: черновик с текстом при уходе остаётся у демона и переживает переоткрытие окна; ключ папки — через симлинк', async () => {
    const dir = h.workDir('mem')
    await h.win.keyboard.press('Meta+N')
    await draft().waitFor({ timeout: 5000 })
    const id = (await draft().getAttribute('data-draft')) as string
    await h.win.keyboard.type('черновик на потом')
    assert.match((await draft().getByTestId('draft-esc-hint').textContent()) ?? '', /черновик сохранится, если уйти/)
    await h.win.locator('[data-testid="agent-row"][data-agent="mem"]').click()
    await draft().waitFor({ state: 'detached', timeout: 5000 })
    await h.win.locator(`[data-testid="draft-row"][data-draft="${id}"]`).waitFor({ timeout: 5000 })
    const file = join(h.home, 'drafts', `${id}.json`)
    assert.ok(await waitFor(() => existsSync(file), 5000), 'черновик не записан у демона')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    await h.reopen()
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000))
    const row = h.win.locator(`[data-testid="draft-row"][data-draft="${id}"]`)
    await row.waitFor({ timeout: 10_000 })
    await row.click()
    assert.equal(await draft().getByTestId('draft-input').inputValue(), 'черновик на потом')
    // Новое окно — новый владелец (id свой у каждого окна, ревью Codex 8): пока пульс прежнего не протух, черновик
    // «открыт в другом окне», «Забрать» — сразу.
    if (await draft().getByTestId('draft-foreign').count()) {
      await draft().getByTestId('draft-claim').click()
      assert.ok(await waitFor(async () => (await draft().getByTestId('draft-foreign').count()) === 0, 5000), '«Забрать» не сработало')
    }
    assert.equal(await draft().getByTestId('draft-input').inputValue(), 'черновик на потом')
    await row.click({ button: 'right' })
    await h.win.getByTestId('draft-menu-list').getByTestId('draft-remove').click()
    await draft().waitFor({ state: 'detached', timeout: 5000 })
    assert.ok(await waitFor(() => !existsSync(file), 5000), 'файл черновика не удалён')

    // Симлинк на ту же папку — тот же ключ памяти: «Только чтение» на месте.
    const alias = join(h.home, 'mem-alias')
    symlinkSync(dir, alias)
    await h.stubPickFolder(alias)
    await h.win.keyboard.press('Meta+N')
    await draft().waitFor({ timeout: 5000 })
    await draft().getByTestId('draft-chip-folder').click()
    await h.win.getByTestId('draft-folder-other').click()
    assert.ok(await waitFor(async () => (await draft().getByTestId('draft-chip-folder').getAttribute('data-path')) === alias, 5000))
    assert.ok(await waitFor(async () => (await accessChip().getAttribute('data-approval')) === 'read-only', 5000), 'память по симлинку не нашлась')
    await h.win.keyboard.press('Escape')
    await draft().waitFor({ state: 'detached', timeout: 5000 })
    assert.deepEqual(readdirSync(join(h.home, 'drafts')), [], 'пустые черновики у демона не копятся')
  })

  it('шаг B: черновик из ссылки в папке с запомненным полным доступом — «Спрашивать», включить — только кликом в нём', async () => {
    const dir = h.workDir('mem')
    // Полный доступ для папки: явный выбор в черновике (согласие снова — его отозвали выше) и отправка.
    await h.win.locator('[data-testid="agent-row"][data-agent="mem"]').click()
    await h.win.keyboard.press('Meta+N')
    await draft().waitFor({ timeout: 5000 })
    await pickAccess('full')
    await h.win.getByTestId('consent-grant').click()
    assert.ok(await waitFor(async () => (await accessChip().getAttribute('data-approval')) === 'full', 5000))
    await h.win.keyboard.type('четыре')
    await h.win.keyboard.press('Enter')
    await h.win.locator('[data-testid="conversation"][data-agent="mem-4"]').waitFor({ timeout: 10_000 })
    assert.equal(await memory(dir), 'full')
    // ⌘N в той же папке — полный сразу, без диалога (C2).
    await h.win.keyboard.press('Meta+N')
    await draft().waitFor({ timeout: 5000 })
    assert.ok(await waitFor(async () => (await accessChip().getAttribute('data-approval')) === 'full', 5000), 'полный из памяти не подставился')
    await h.win.keyboard.press('Escape')
    await draft().waitFor({ state: 'detached', timeout: 5000 })

    await h.app.evaluate(({ app }, u) => {
      (app as unknown as { emit(e: string, ...a: unknown[]): boolean }).emit('open-url', { preventDefault() {} }, u)
    }, `pult://new?path=${encodeURIComponent(dir)}&prompt=${encodeURIComponent('Собери changelog')}`)
    await draft().waitFor({ timeout: 10_000 })
    await draft().getByTestId('draft-from-link').waitFor({ timeout: 3000 })
    await draft().getByTestId('draft-link-full').waitFor({ timeout: 5000 })
    assert.equal(await accessChip().getAttribute('data-approval'), 'ask', 'ссылка полный сам не включает')
    await h.screen('access-link-draft-light')
    await draft().getByTestId('draft-link-full-enable').click()
    assert.equal(await accessChip().getAttribute('data-approval'), 'full', '«Включить для этого чата» — без диалога: согласие есть')
    assert.equal(await h.win.getByTestId('consent-dialog').count(), 0)
    const id = (await draft().getAttribute('data-draft')) as string
    await h.win.locator(`[data-testid="draft-row"][data-draft="${id}"]`).click({ button: 'right' })
    await h.win.getByTestId('draft-menu-list').getByTestId('draft-remove').click()
    await draft().waitFor({ state: 'detached', timeout: 5000 })
  })
})
