// e2e ноги 2 (docs/12 §3, §5): окно как рабочий инструмент на фальшивых CLI. Завести агента
// диалогом и получить ответ; разрешение из Inbox — «разрешить» (⌘Enter) и «отказать» с причиной;
// «Стоп» посреди хода; закрыть окно посреди хода — ход дошёл, после открытия история на месте.

import assert from 'node:assert/strict'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Page } from 'playwright-core'
import { launch, ONE_PX_PNG, sleep, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type Rec = { name: string; title?: string; lastStatus: string; model?: string; effort?: string }
type Ev = { id: number; kind: string; sessionId: string; data: Record<string, unknown> }

describe('окно: рабочие сценарии', () => {
  let h: Harness
  let c: Client

  before(async () => {
    h = await launch({ name: 'flows' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
    await h.win.getByTestId('toggle-inbox').click()
  })
  after(async () => {
    // Гигиена: ни одного неотвеченного вопроса брокера после прогона.
    if (c) {
      const left = (await c.request('perm.list', {})) as { pending: Array<{ id: string }> }
      for (const p of left.pending) await c.request('perm.resolve', { id: p.id, decision: 'deny', message: 'конец теста' })
    }
    await h?.close()
  })

  const list = async (): Promise<Rec[]> => ((await c.request('agent.list', {})) as { sessions: Rec[] }).sessions
  const statusOf = async (name: string): Promise<string | undefined> => (await list()).find((r) => r.name === name)?.lastStatus
  const journal = async (sessionId: string): Promise<Ev[]> =>
    ((await c.request('events.tail', { since: 0, sessionId })) as { events: Ev[] }).events
  const feedText = async (win: Page = h.win): Promise<string> => (await win.getByTestId('feed').textContent()) ?? ''
  const select = async (name: string): Promise<void> => {
    await h.win.locator(`[data-testid="agent-row"][data-agent="${name}"]`).click()
    await h.win.locator(`[data-testid="conversation"][data-agent="${name}"]`).waitFor({ timeout: 10_000 })
  }
  const inboxCount = async (): Promise<string> => (await h.win.getByTestId('inbox-count').textContent()) ?? ''

  it('⌘N → диалог: папка системным выбором, модель и усилие, первая реплика → ответ в ленте', async () => {
    const dir = h.workDir('alpha', { scenario: 'simple' })
    await h.stubPickFolder(dir)
    await h.win.keyboard.press('Meta+N')
    const dlg = h.win.getByTestId('new-agent-dialog')
    await dlg.waitFor({ timeout: 5000 })
    await dlg.getByTestId('pick-folder').click()
    assert.ok(await waitFor(async () => (await dlg.getByTestId('new-agent-cwd').getAttribute('data-path')) === dir, 5000), 'папка не выбралась')
    assert.equal(await dlg.getByTestId('new-agent-name').inputValue(), 'alpha', 'имя берётся из папки')
    await dlg.getByRole('group', { name: 'Модель' }).getByRole('button', { name: 'haiku' }).click()
    await dlg.getByRole('group', { name: 'Усилие' }).getByRole('button', { name: 'low' }).click()
    await dlg.getByTestId('new-agent-prompt').fill('Скажи одно слово')
    await dlg.getByTestId('new-agent-submit').click()
    await dlg.waitFor({ state: 'detached', timeout: 10_000 })

    await h.win.locator('[data-testid="conversation"][data-agent="alpha"]').waitFor({ timeout: 10_000 })
    assert.ok(await waitFor(async () => (await feedText()).includes('PULT'), 15_000), 'ответ модели не появился в ленте')
    assert.match(await feedText(), /Скажи одно слово/)
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-status').textContent()) === 'готов', 10_000))
    const rec = (await list()).find((r) => r.name === 'alpha')
    assert.deepEqual([rec?.model, rec?.effort], ['haiku', 'low'])
    // Контекстное окно в шапке разговора: фикстура 01 — 23 392 токена подсказки из окна 200 000.
    const ctx = async (): Promise<string | null> => h.win.getByTestId('conv-context').textContent({ timeout: 500 }).catch(() => null)
    assert.ok(await waitFor(async () => (await ctx()) === 'контекст 23k / 200k · 12%', 10_000), `индикатор контекста: ${await ctx()}`)
  })

  it('реплика из поля ввода: Enter отправляет, Shift+Enter — новая строка', async () => {
    const box = h.win.getByTestId('composer')
    await box.fill('первая строка')
    await box.press('Shift+Enter')
    await box.pressSequentially('вторая')
    assert.equal(await box.inputValue(), 'первая строка\nвторая')
    await box.press('Enter')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('msg-user').count()) === 2, 10_000), 'вторая реплика не ушла')
    assert.ok(await waitFor(async () => (await statusOf('alpha')) === 'idle', 15_000))
    const users = (await journal('alpha')).filter((e) => e.kind === 'message.user').map((e) => e.data['text'])
    assert.deepEqual(users, ['Скажи одно слово', 'первая строка\nвторая'])
  })

  it('⌘V на файлах из Finder кладёт в поле полные пути всех файлов, а не имя первого', async () => {
    // Chromium отдаёт в paste тип `Files` и только первый файл; все пути main читает из буфера.
    await h.app.evaluate((_e, paths) => { (globalThis as { __pultTestClipboardPaths?: string[] }).__pultTestClipboardPaths = paths },
      ['/srv/p/Отчёт 1.txt', '/tmp/b.txt'])
    const box = h.win.getByTestId('composer')
    await box.fill('глянь ')
    await box.evaluate((el) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'Отчёт 1.txt', { type: 'text/plain' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    assert.ok(await waitFor(async () => (await box.inputValue()) === "глянь '/srv/p/Отчёт 1.txt' /tmp/b.txt", 3000), `в поле: ${await box.inputValue()}`)
    await h.app.evaluate(() => { delete (globalThis as { __pultTestClipboardPaths?: string[] }).__pultTestClipboardPaths })
    await box.fill('')
  })

  it('⌘V картинки без файла (скриншот): PNG в PULT_HOME/attachments, путь — в поле реплики и в «первую реплику»', async () => {
    // Системный буфер тест не трогает: картинку (байты PNG) кладёт в main, а paste несёт то, что Chromium отдаёт для
    // битмапа, — `Files` с image.png без пути на диске.
    await h.app.evaluate((_e, b64) => { (globalThis as { __pultTestClipboardImage?: Uint8Array }).__pultTestClipboardImage = Buffer.from(b64, 'base64') }, ONE_PX_PNG)
    const pasteImage = async (testId: string): Promise<void> => {
      await h.win.getByTestId(testId).evaluate((el) => {
        const dt = new DataTransfer()
        dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' }))
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })
    }
    const attachments = path.join(h.home, 'attachments')
    const escRe = (x: string): string => x.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&')
    const re = (session: string): RegExp => new RegExp(`^глянь ${escRe(path.join(attachments, session))}/\\d{4}-\\d{2}-\\d{2}/paste-\\d{6}-[0-9a-f]{6}\\.png$`)
    try {
      const box = h.win.getByTestId('composer')
      await box.fill('глянь ')
      await pasteImage('composer')
      // Поле разговора сессии alpha — папка attachments/alpha (своя у сессии: --add-dir claude только на неё).
      assert.ok(await waitFor(async () => re('alpha').test(await box.inputValue()), 5000), `в поле: ${await box.inputValue()}`)
      const p1 = (await box.inputValue()).slice('глянь '.length)
      assert.ok(existsSync(p1), `файла нет: ${p1}`)
      assert.equal(statSync(p1).mode & 0o777, 0o600)
      await box.fill('')

      await h.win.keyboard.press('Meta+N')
      const dlg = h.win.getByTestId('new-agent-dialog')
      await dlg.waitFor({ timeout: 5000 })
      const prompt = dlg.getByTestId('new-agent-prompt')
      // Без имени — отказ словами: папку картинке даёт имя будущей сессии.
      await dlg.getByTestId('new-agent-name').fill('')
      await sleep(1100)
      await prompt.fill('глянь ')
      await pasteImage('new-agent-prompt')
      assert.ok(await waitFor(async () => /сессия/.test((await dlg.getByTestId('new-agent-paste-notice').textContent({ timeout: 500 }).catch(() => null)) ?? ''), 5000), 'нет заметки «нужно имя»')
      assert.equal(await prompt.inputValue(), 'глянь ')
      await dlg.getByTestId('new-agent-name').fill('pic')
      await sleep(1100)
      await pasteImage('new-agent-prompt')
      assert.ok(await waitFor(async () => re('pic').test(await prompt.inputValue()), 5000), `в «первой реплике»: ${await prompt.inputValue()}`)
      const p2 = (await prompt.inputValue()).slice('глянь '.length)
      assert.ok(existsSync(p2) && p2 !== p1, `второй файл: ${p2}`)
      await h.win.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached', timeout: 5000 })
    } finally {
      await h.app.evaluate(() => { delete (globalThis as { __pultTestClipboardImage?: Uint8Array }).__pultTestClipboardImage })
    }
    // Буфер без картинки: отказ словами под полем, поле не тронуто.
    await sleep(1100)
    const box = h.win.getByTestId('composer')
    await box.fill('abc')
    await pasteImage('composer')
    assert.ok(await waitFor(async () => ((await h.win.getByTestId('paste-notice').textContent({ timeout: 500 }).catch(() => null)) ?? '').includes('нет картинки'), 5000), 'нет заметки об отказе')
    assert.equal(await box.inputValue(), 'abc')
    await box.fill('')
  })

  it('«+ Сессия»: файлы, брошенные в первую реплику, — их пути; папка на форму — папка сессии; файл на папку — подсказка', async () => {
    // Настоящий бросок из Finder: CDP `Input.dispatchDragEvent` с путями на диске — Chromium строит из них
    // DataTransfer как от системы (File с путём, webkitGetAsEntry), чего синтетический DragEvent не умеет.
    const dir = h.workDir('drop proj')
    const fileA = path.join(dir, 'Отчёт 1.txt')
    const fileB = path.join(dir, 'b.txt')
    writeFileSync(fileA, 'a')
    writeFileSync(fileB, 'b')
    const cdp = await h.win.context().newCDPSession(h.win)
    const dlg = h.win.getByTestId('new-agent-dialog')
    // На маленьком экране (раннер CI) тело диалога прокручивается: цель сначала — в видимую часть, иначе точка
    // броска попадёт мимо неё (boundingBox отдаёт и спрятанное прокруткой).
    const at = async (testId: string): Promise<{ x: number; y: number }> => {
      await dlg.getByTestId(testId).scrollIntoViewIfNeeded()
      const box = await dlg.getByTestId(testId).boundingBox()
      assert.ok(box, `${testId}: нет на экране`)
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const drag = (type: 'dragEnter' | 'dragOver' | 'drop' | 'dragCancel', p: { x: number; y: number }, files: string[]): Promise<unknown> =>
      cdp.send('Input.dispatchDragEvent', { type, ...p, data: { items: [], files, dragOperationsMask: 1 } })
    // Настоящая система шлёт dragover каждые ~50 мс, а Chromium принимает следующий, только ответив на прошлый:
    // одиночный dragOver из CDP на медленной машине теряется. Поэтому — повторять, пока цель не ответит.
    const hover = async (p: { x: number; y: number }, files: string[], until: () => Promise<boolean>, what: string): Promise<void> => {
      assert.ok(await waitFor(async () => { await drag('dragOver', p, files); return until() }, 5000, 100), what)
    }
    const lit = async (testId: string): Promise<string | null> => dlg.getByTestId(testId).getAttribute('data-drop')
    /** Бросок: вход, наведение до подсветки цели, бросок. */
    const dropAt = async (testId: string, files: string[]): Promise<void> => {
      const p = await at(testId)
      await drag('dragEnter', p, files)
      await hover(p, files, async () => (await lit(testId)) === '1', `${testId}: цель броска не подсвечена`)
      await drag('drop', p, files)
    }
    try {
      await h.win.keyboard.press('Meta+N')
      await dlg.waitFor({ timeout: 5000 })
      const prompt = dlg.getByTestId('new-agent-prompt')
      await prompt.fill('глянь ')
      // Наведение подсвечивает цель: над репликой — поле, над остальной формой — папку; уход и бросок гасят подсветку.
      const overPrompt = await at('new-agent-prompt')
      await drag('dragEnter', overPrompt, [fileA])
      await hover(overPrompt, [fileA], async () => (await lit('new-agent-prompt')) === '1', 'поле реплики не подсвечено')
      assert.equal(await lit('new-agent-cwd'), null)
      await hover(await at('new-agent-cwd'), [fileA], async () => (await lit('new-agent-cwd')) === '1' && (await lit('new-agent-prompt')) === null, 'папка не подсвечена')
      await hover({ x: 4, y: 4 }, [fileA], async () => (await lit('new-agent-cwd')) === null, 'подсветка папки не погасла вне диалога')
      await drag('dragCancel', { x: 4, y: 4 }, [fileA])

      await dropAt('new-agent-prompt', [fileA, fileB])
      // Путь с пробелом — в одинарных кавычках, как в поле реплики разговора.
      const want = `глянь '${fileA}' '${fileB}'`
      assert.ok(await waitFor(async () => (await prompt.inputValue()) === want, 3000), `в поле: ${await prompt.inputValue()}`)
      assert.ok(await waitFor(async () => (await lit('new-agent-prompt')) === null, 3000), 'подсветка поля не погасла после броска')
      const cwd = dlg.getByTestId('new-agent-cwd')
      const before = await cwd.getAttribute('data-path')
      assert.notEqual(before, dir, 'бросок файлов в реплику папку не меняет')

      await dropAt('new-agent-cwd', [fileB])
      assert.ok(await waitFor(async () => (await dlg.getByTestId('new-agent-drop-hint').count()) === 1, 3000), 'нет подсказки про файл на папке')
      assert.equal(await cwd.getAttribute('data-path'), before, 'файл не стал папкой сессии')

      await dropAt('new-agent-cwd', [dir])
      assert.ok(await waitFor(async () => (await cwd.getAttribute('data-path')) === dir, 3000), `папка: ${await cwd.getAttribute('data-path')}`)
      assert.equal(await dlg.getByTestId('new-agent-name').inputValue(), 'drop-proj', 'имя из брошенной папки')
      assert.equal(await dlg.getByTestId('new-agent-drop-hint').count(), 0, 'подсказка ушла')
      assert.equal(await prompt.inputValue(), want, 'реплика не тронута')
    } finally {
      // Упал посреди — не оставлять следующим тестам ни перетаскивания, ни открытого диалога.
      await drag('dragCancel', { x: 4, y: 4 }, []).catch(() => {})
      await cdp.detach().catch(() => {})
      if (await dlg.count()) await h.win.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached', timeout: 5000 })
    }
  })

  it('разрешение из Inbox: ⌘Enter разрешает выделенный запрос, ход доходит до конца', async () => {
    const dir = h.workDir('beta', { scenario: 'demo-edit' })
    await c.request('agent.start', { name: 'beta', kind: 'claude', cwd: dir })
    await c.request('agent.prompt', { name: 'beta', text: 'Поправь округление' })
    assert.ok(await waitFor(async () => (await inboxCount()) === '1', 15_000), 'запрос не дошёл до Inbox')
    const card = h.win.getByTestId('inbox').getByTestId('perm-card')
    await card.waitFor({ timeout: 5000 })
    assert.match((await card.textContent()) ?? '', /Правка файла.*beta/)
    assert.match((await card.textContent()) ?? '', /Math\.floor/, 'дифф правки виден в карточке')
    // Строка ждущей сессии подсвечена (в своём проекте она первая). Ждём: карточка приходит событием
    // сразу, а строку окно берёт из `agent.list` с задержкой 150 мс.
    const betaRow = h.win.locator('[data-testid="agent-row"][data-agent="beta"]')
    assert.ok(await waitFor(async () => (await betaRow.getAttribute('data-needs')) === '1', 5000), 'строка beta не подсвечена как ждущая')

    await h.win.keyboard.press('Meta+Enter')
    assert.ok(await waitFor(async () => (await inboxCount()) === '0', 10_000), 'Inbox не опустел')
    assert.ok(await waitFor(async () => (await statusOf('beta')) === 'idle', 15_000))
    const resolved = (await journal('beta')).filter((e) => e.kind === 'permission.resolved')
    // 0.3.7: `by` — клиент и номер соединения, ответившего на вопрос (окно — `shell#N`).
    assert.deepEqual(resolved.map((e) => [e.data['decision'], e.data['scope']]), [['allow', 'once']])
    assert.match(String(resolved[0]?.data['by']), /^shell#\d+$/)
    await select('beta')
    assert.ok(await waitFor(async () => (await feedText()).includes('99 %'), 10_000), 'ход после разрешения не дошёл до ленты')
    assert.match(await feedText(), /Разрешено/)
  })

  it('M8d: Codex предложил «всегда» — кнопка с префиксом команды; ⌘Enter всё равно ОДИН раз, кнопка — правилом', async () => {
    // Фикстура 03 (живой codex): availableDecisions = accept, {acceptWithExecpolicyAmendment}, cancel — «на сессию» нет.
    h.codexConfig({ speed: 0, scenarioByDir: { 'cx-perm': 'permission-accept' } })
    await c.request('agent.start', { name: 'cxperm', kind: 'codex', cwd: h.workDir('cx-perm') })
    const ask = async (): Promise<void> => {
      await c.request('agent.prompt', { name: 'cxperm', text: 'Запиши hi в x.txt' })
      assert.ok(await waitFor(async () => (await inboxCount()) === '1', 15_000), 'запрос codex не дошёл до Inbox')
    }
    const settled = async (): Promise<Ev[]> => {
      assert.ok(await waitFor(async () => (await inboxCount()) === '0', 10_000), 'Inbox не опустел')
      assert.ok(await waitFor(async () => (await statusOf('cxperm')) === 'idle', 15_000))
      return (await journal('cxperm')).filter((e) => e.kind === 'permission.resolved')
    }
    await ask()
    const card = h.win.getByTestId('inbox').getByTestId('perm-card')
    const rule = card.getByTestId('perm-approve-rule')
    await rule.waitFor({ timeout: 5000 })
    assert.match((await rule.textContent()) ?? '', /Всегда: команды, начинающиеся с.*echo hi > x\.txt/)
    assert.equal(await card.getByTestId('perm-approve-session').count(), 0, '«в этой сессии» сервер не предлагал')
    // Открыта сессия beta, и фокус в её поле реплики: оттуда ⌘Enter карточку ДРУГОЙ сессии не разрешает (после #13).
    // Человек выбирает карточку в Inbox — фокус уходит из поля, и ⌘Enter разрешает её.
    await card.locator('.perm-h').click()
    await h.win.keyboard.press('Meta+Enter')
    assert.deepEqual((await settled()).map((e) => e.data['scope']), ['once'], '⌘Enter — всегда один раз')

    await ask()
    await h.win.getByTestId('inbox').getByTestId('perm-approve-rule').click()
    const both = await settled()
    assert.deepEqual(both.map((e) => e.data['scope']), ['once', 'rule'])
    assert.deepEqual(both[1]?.data['rule'], { kind: 'execpolicy', label: "/bin/zsh -lc 'echo hi > x.txt'" })
    // Лишняя папка в дереве удлиняет его, и меню архива в тесте ниже закрывается прокруткой — убираем за собой.
    await c.request('agent.rm', { name: 'cxperm' })
  })

  it('M8d: «Убрать из списка…» у папки с сессиями — вопрос, сессии в архив, папка пропадает; новая сессия её возвращает', async () => {
    const dir = h.workDir('hideme', { scenario: 'simple' })
    await c.request('agent.start', { name: 'hideme', kind: 'claude', cwd: dir })
    const proj = h.win.locator(`[data-testid="project"][data-project="${dir}"]`)
    await proj.waitFor({ timeout: 10_000 })
    await proj.hover()
    await proj.getByTestId('project-menu').click()
    await h.win.getByTestId('project-menu-list').getByTestId('project-hide').click()
    const dlg = h.win.getByTestId('confirm-hide')
    await dlg.waitFor({ timeout: 5000 })
    assert.match((await dlg.textContent()) ?? '', /1 сессия уйдёт в архив.*папка на диске не трогается/)
    await dlg.getByTestId('confirm-ok').click()
    await proj.waitFor({ state: 'detached', timeout: 10_000 })
    const rec = ((await c.request('agent.list', {})) as { sessions: Array<{ name: string; archived?: boolean }> }).sessions.find((r) => r.name === 'hideme')
    assert.equal(rec?.archived, true)
    await c.request('agent.start', { name: 'hideme2', kind: 'claude', cwd: dir })
    await proj.waitFor({ timeout: 10_000 })
    await c.request('agent.rm', { name: 'hideme2' })
    await c.request('agent.rm', { name: 'hideme' })
  })

  it('отказ с причиной из Inbox: причина уходит агенту, ход доигрывается веткой отказа', async () => {
    await c.request('agent.prompt', { name: 'beta', text: 'Ещё раз, но аккуратнее' })
    assert.ok(await waitFor(async () => (await inboxCount()) === '1', 15_000))
    const card = h.win.getByTestId('inbox').getByTestId('perm-card')
    await card.getByTestId('perm-deny').click()
    await card.getByTestId('perm-reason').fill('сначала тест')
    await card.getByTestId('perm-deny-confirm').click()
    assert.ok(await waitFor(async () => (await inboxCount()) === '0', 10_000))
    assert.ok(await waitFor(async () => (await statusOf('beta')) === 'idle', 15_000))
    const last = (await journal('beta')).filter((e) => e.kind === 'permission.resolved').at(-1)
    assert.deepEqual([last?.data['decision'], last?.data['message']], ['deny', 'сначала тест'])
    assert.ok(await waitFor(async () => (await feedText()).includes('правку не вношу'), 10_000))
    assert.match(await feedText(), /Отказано.*сначала тест/)
  })

  it('«Стоп» посреди хода: Esc → подтверждение → ход прерван, в ленте причина', async () => {
    const dir = h.workDir('gamma', { scenario: 'simple', hangAfterInit: 30_000 })
    await c.request('agent.start', { name: 'gamma', kind: 'claude', cwd: dir })
    await c.request('agent.prompt', { name: 'gamma', text: 'Долгая задача' })
    await select('gamma')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-status').textContent()) === 'идёт', 10_000),
      `статус в окне: ${await h.win.getByTestId('conv-status').textContent()}, в демоне: ${await statusOf('gamma')}; лента: ${await feedText()}; журнал: ${(await journal('gamma')).map((e) => (e.kind === 'status.changed' ? `${e.kind}:${String(e.data['status'])}` : e.kind)).join(' ')}`)
    await h.win.getByTestId('stop-turn').waitFor({ timeout: 5000 })
    await h.win.keyboard.press('Escape')
    await h.win.getByTestId('confirm-stop').waitFor({ timeout: 5000 })
    await h.win.getByTestId('confirm-ok').click()
    assert.ok(await waitFor(async () => (await statusOf('gamma')) === 'interrupted', 10_000), 'ход не прервался')
    assert.ok(await waitFor(async () => (await feedText()).includes('Ход остановлен'), 5000))
    assert.equal(await h.win.getByTestId('stop-turn').count(), 0, 'кнопка «Стоп» ушла вместе с ходом')
  })

  it('очередь реплик (О2): Enter во время хода — в очередь и уходит сама; ⌘Enter — прервать и сказать', async () => {
    const dir = h.workDir('zeta', { scenario: 'simple', speed: 0, hang: 1500 })
    await c.request('agent.start', { name: 'zeta', kind: 'claude', cwd: dir })
    await c.request('agent.prompt', { name: 'zeta', text: 'Первая' })
    await select('zeta')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-status').textContent()) === 'идёт', 10_000))
    const box = h.win.getByTestId('composer')
    const users = async (): Promise<unknown[]> => (await journal('zeta')).filter((e) => e.kind === 'message.user').map((e) => e.data['text'])
    await box.fill('Вторая')
    await box.press('Enter')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('queue-item').count()) === 1, 5000), 'реплика не встала в очередь под полем')
    assert.match((await h.win.getByTestId('queue-item').textContent()) ?? '', /Вторая/)
    assert.equal(await box.inputValue(), '', 'поле очищено')
    assert.ok(await waitFor(async () => (await users()).includes('Вторая'), 15_000), 'реплика из очереди не ушла сама')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('queue-item').count()) === 0, 10_000), 'очередь под полем не опустела')

    // Идёт ход «Вторая»: ⌘Enter — стоп и сразу «Вместо», без вопроса и без «разрешить запрос».
    assert.ok(await waitFor(async () => (await statusOf('zeta')) === 'working', 10_000))
    await box.fill('Вместо')
    await box.press('Meta+Enter')
    assert.ok(await waitFor(async () => (await users()).includes('Вместо'), 15_000), '«прервать и сказать» не отправило реплику')
    const kinds = (await journal('zeta')).filter((e) => e.kind === 'status.changed').map((e) => e.data['status'])
    assert.ok(kinds.includes('interrupted'), `ход не прерван: ${kinds.join(' ')}`)
    assert.deepEqual(await users(), ['Первая', 'Вторая', 'Вместо'])
    assert.ok(await waitFor(async () => (await statusOf('zeta')) === 'idle', 15_000))
  })

  it('правка реплики в очереди: «Изменить» держит очередь, Enter сохраняет; Esc отменяет; убранная — текст в поле', async () => {
    const dir = h.workDir('qedit', { scenario: 'simple', speed: 0, hang: 1500 })
    await c.request('agent.start', { name: 'qedit', kind: 'claude', cwd: dir })
    await c.request('agent.prompt', { name: 'qedit', text: 'Первая' })
    await select('qedit')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-status').textContent()) === 'идёт', 10_000))
    const box = h.win.getByTestId('composer')
    const editor = h.win.getByTestId('queue-edit-text')
    const users = async (): Promise<unknown[]> => (await journal('qedit')).filter((e) => e.kind === 'message.user').map((e) => e.data['text'])
    const queued = async (): Promise<Array<{ id: string; text: string }>> =>
      ((await list()).find((r) => r.name === 'qedit') as unknown as { queue?: Array<{ id: string; text: string }> } | undefined)?.queue ?? []

    // Сохранить: ход кончается, пока правка открыта, — реплика ждёт; Enter — уходит исправленный текст.
    await box.fill('Вторая')
    await box.press('Enter')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('queue-item').count()) === 1, 5000), 'реплика не встала в очередь')
    await h.win.getByTestId('queue-edit').click()
    await editor.waitFor({ timeout: 5000 })
    assert.equal(await editor.inputValue(), 'Вторая')
    assert.ok(await waitFor(async () => (await statusOf('qedit')) === 'idle', 15_000), 'первый ход не кончился')
    await new Promise((r) => setTimeout(r, 700))
    assert.deepEqual(await users(), ['Первая'], 'правка не удержала очередь')
    await editor.fill('Вторая, исправленная')
    await editor.press('Shift+Enter')
    await editor.pressSequentially('ещё строка')
    await editor.press('Enter')
    assert.ok(await waitFor(async () => (await users()).length === 2, 10_000), 'исправленная реплика не ушла')
    assert.deepEqual(await users(), ['Первая', 'Вторая, исправленная\nещё строка'])
    // Журнал демона опережает перерисовку окна: ждём, а не проверяем мгновенно (на раннере CI окно отстаёт).
    assert.ok(await waitFor(async () => (await editor.count()) === 0, 5000), 'правка закрыта')
    assert.ok(await waitFor(async () => (await statusOf('qedit')) === 'idle', 15_000))

    // Esc — правка брошена (а не «Стоп» хода), уходит прежний текст.
    await c.request('agent.prompt', { name: 'qedit', text: 'Третья' })
    await box.fill('Четвёртая')
    await box.press('Enter')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('queue-item').count()) === 1, 5000))
    await h.win.getByTestId('queue-edit').click()
    await editor.waitFor({ timeout: 5000 })
    await editor.fill('не то')
    await editor.press('Escape')
    assert.ok(await waitFor(async () => (await editor.count()) === 0, 5000), 'Esc не закрыл правку')
    assert.equal(await h.win.getByTestId('confirm-stop').count(), 0, 'Esc ушёл в «Стоп»')
    assert.ok(await waitFor(async () => (await users()).includes('Четвёртая'), 15_000), 'после отмены реплика не ушла')
    assert.ok(!(await users()).includes('не то'))
    assert.ok(await waitFor(async () => (await statusOf('qedit')) === 'idle', 15_000))

    // Реплику убрали (CLI), пока правка открыта: «Сохранить» — «уже удалена», исправленное — в поле над набранным.
    await c.request('agent.prompt', { name: 'qedit', text: 'Пятая' })
    await box.fill('Шестая')
    await box.press('Enter')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('queue-item').count()) === 1, 5000))
    await h.win.getByTestId('queue-edit').click()
    await editor.waitFor({ timeout: 5000 })
    await editor.fill('Шестая, исправленная')
    const [item] = await queued()
    assert.ok(item, 'в очереди нет реплики')
    await c.request('agent.queue.remove', { name: 'qedit', id: item.id })
    await box.fill('черновик')
    await h.win.getByTestId('queue-edit-save').click()
    assert.ok(await waitFor(async () => /уже удалена/.test((await h.win.getByTestId('queue-notice').textContent({ timeout: 500 }).catch(() => '')) ?? ''), 5000),
      'нет заметки «уже удалена»')
    assert.ok(await waitFor(async () => (await box.inputValue()) === 'Шестая, исправленная\n\nчерновик', 5000), `поле: ${await box.inputValue()}`)
    assert.equal(await editor.count(), 0)
    assert.ok(await waitFor(async () => (await statusOf('qedit')) === 'idle', 15_000))
    assert.ok(!(await users()).some((t) => String(t).startsWith('Шестая')), 'убранная реплика ушла')
    await box.fill('')
  })

  it('название агента: правка в шапке посреди хода, Esc бросает правку (а не зовёт «Стоп»), пустое — снять', async () => {
    const dir = h.workDir('eps', { scenario: 'simple', hangAfterInit: 30_000 })
    await c.request('agent.start', { name: 'eps', kind: 'claude', cwd: dir })
    await c.request('agent.prompt', { name: 'eps', text: 'Долгая задача' })
    await select('eps')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-status').textContent()) === 'идёт', 10_000))
    const title = h.win.getByTestId('conv-title')
    const input = h.win.getByTestId('rename-input')
    const titleOf = async (): Promise<string | undefined> => (await list()).find((r) => r.name === 'eps')?.title
    assert.equal(await title.textContent(), 'eps')

    await h.win.getByTestId('rename-agent').click()
    assert.equal(await input.inputValue(), 'eps', 'правка начинается с того, что написано в шапке')
    await input.fill('Починить округление')
    // ⌘Enter — горячая клавиша окна, не «сохранить название»: правка остаётся открытой.
    await input.press('Meta+Enter')
    assert.equal(await input.count(), 1)
    assert.equal(await titleOf(), undefined)
    await input.press('Enter')
    assert.ok(await waitFor(async () => (await title.count()) === 1 && (await title.textContent()) === 'Починить округление', 5000), 'название не сменилось')
    assert.ok(await waitFor(async () => h.win.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'composer'), 2000), 'после Enter фокус не вернулся в поле реплики')
    assert.equal(await titleOf(), 'Починить округление')
    assert.equal(await h.win.locator('[data-testid="agent-row"][data-agent="eps"] .ag-name').textContent(), 'Починить округление')
    // Имя — ключ для демона и CLI — не тронуто и остаётся на виду; ход идёт как шёл.
    assert.equal(await h.win.getByTestId('conv-name').textContent(), 'eps')
    assert.equal(await statusOf('eps'), 'working')

    // Esc в поле названия: правка брошена, окно «Остановить ход?» НЕ открылось (ход идёт).
    await title.dblclick()
    await input.fill('это не сохранится')
    await input.press('Escape')
    await input.waitFor({ state: 'detached', timeout: 3000 })
    assert.equal(await h.win.getByTestId('confirm-stop').count(), 0, 'Esc из поля названия дошёл до «Стоп»')
    assert.equal(await title.textContent(), 'Починить округление')
    assert.equal(await titleOf(), 'Починить округление')

    // Уход фокуса сохраняет (щёлкнул мимо — не потерял набранное) и фокус у человека не отбирает.
    await title.dblclick()
    await input.fill('Округление вниз')
    await h.win.getByTestId('feed').click()
    assert.ok(await waitFor(async () => (await titleOf()) === 'Округление вниз', 5000), 'уход фокуса не сохранил название')
    assert.equal(await h.win.getByTestId('confirm-stop').count(), 0)

    // Названия не уникальны — в «Остановить ход?» рядом с названием стоит имя.
    await h.win.keyboard.press('Escape')
    const stop = h.win.getByTestId('confirm-stop')
    await stop.waitFor({ timeout: 3000 })
    assert.match((await stop.textContent()) ?? '', /Округление вниз \(eps\)/)
    await h.win.keyboard.press('Escape')
    await stop.waitFor({ state: 'detached', timeout: 3000 })

    // Стёр название — оно снято: в шапке и списке снова имя.
    await h.win.getByTestId('rename-agent').click()
    await input.fill('')
    await input.press('Enter')
    assert.ok(await waitFor(async () => (await title.count()) === 1 && (await title.textContent()) === 'eps', 5000), 'название не снялось')
    assert.equal(await titleOf(), undefined)
    assert.equal(await h.win.getByTestId('conv-name').count(), 0)
    await c.request('agent.stop', { name: 'eps' })
    assert.ok(await waitFor(async () => (await statusOf('eps')) === 'interrupted', 10_000))
  })

  it('горячие клавиши: ⌘I прячет и показывает Inbox, ⌘1…9 выбирают беседы в видимом списке', async () => {
    assert.equal(await h.win.getByTestId('inbox').count(), 1)
    await h.win.keyboard.press('Meta+I')
    await h.win.getByTestId('inbox').waitFor({ state: 'detached', timeout: 3000 })
    await h.win.keyboard.press('Meta+I')
    await h.win.getByTestId('inbox').waitFor({ timeout: 3000 })
    const second = await h.win.locator('.chat-section [data-testid="agent-row"]').nth(1).getAttribute('data-agent')
    assert.ok(second, 'бесед меньше двух')
    await h.win.keyboard.press('Meta+2')
    await h.win.locator(`[data-testid="conversation"][data-agent="${second}"]`).waitFor({ timeout: 3000 })
  })

  it('справка по клавишам: ⌘/ и «?» в подвале открывают, Esc закрывает', async () => {
    await h.win.keyboard.press('Meta+Slash')
    const help = h.win.getByTestId('hotkeys-help')
    await help.waitFor({ timeout: 3000 })
    assert.match((await help.textContent()) ?? '', /Shift\+Enter/)
    await h.win.keyboard.press('Escape')
    await help.waitFor({ state: 'detached', timeout: 3000 })
    await h.win.getByTestId('chat-info').locator('summary').click()
    await h.win.getByTestId('hotkeys-open').click()
    await help.waitFor({ timeout: 3000 })
    await h.win.keyboard.press('Escape')
    await help.waitFor({ state: 'detached', timeout: 3000 })
  })

  it('проекты: добавление и новая беседа в папке; единый список без вкладок, открепление не удаляет беседу', async () => {
    const dir = h.workDir('proj', { scenario: 'simple' })
    await h.stubPickFolder(dir)
    await h.win.getByTestId('add-project').click()
    const proj = h.win.locator(`[data-testid="project"][data-project="${dir}"]`)
    await proj.waitFor({ timeout: 5000 })
    assert.equal(await proj.getAttribute('data-pinned'), '1')
    await proj.hover()
    await proj.getByTestId('project-new-session').click()
    const dlg = h.win.getByTestId('new-agent-dialog')
    await dlg.waitFor({ timeout: 5000 })
    assert.equal(await dlg.getByTestId('new-agent-cwd').getAttribute('data-path'), dir, 'папка проекта не подставилась')
    assert.equal(await dlg.getByTestId('new-agent-name').inputValue(), 'proj')
    await dlg.getByTestId('new-agent-submit').click()
    await dlg.waitFor({ state: 'detached', timeout: 10_000 })
    const row = h.win.locator('.chat-section [data-testid="agent-row"][data-agent="proj"]')
    await row.waitFor({ timeout: 10_000 })
    assert.equal(await row.getAttribute('aria-selected'), 'true', 'новая беседа выбрана в списке')
    assert.equal(await h.win.getByTestId('session-tab').count(), 0, 'второй навигации по тем же беседам нет')
    // Убрать проект из списка (меню «⋯» проекта) — сессия не теряется: её папка становится неявным проектом.
    await proj.hover()
    await proj.getByTestId('project-menu').click()
    await h.win.getByTestId('project-menu-list').getByTestId('project-unpin').click()
    assert.ok(await waitFor(async () => (await proj.getAttribute('data-pinned')) === '0', 5000), 'проект не открепился')
    assert.equal(await h.win.locator('.chat-section [data-testid="agent-row"][data-agent="proj"]').count(), 1)
  })

  it('меню сессии: правый клик → переименовать; «В архив» прячет в «Архив», «Вернуть» возвращает; Esc закрывает меню', async () => {
    const row = (): ReturnType<typeof h.win.locator> => h.win.locator('[data-testid="agent-row"][data-agent="proj"]')
    await row().click({ button: 'right' })
    const menu = h.win.getByTestId('session-menu-list')
    await menu.waitFor({ timeout: 3000 })
    await h.win.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached', timeout: 3000 })

    await row().click({ button: 'right' })
    await menu.getByTestId('row-rename').click()
    const dlg = h.win.getByTestId('rename-dialog')
    await dlg.waitFor({ timeout: 3000 })
    await dlg.getByTestId('rename-dialog-input').fill('Проект из меню')
    await dlg.getByTestId('rename-dialog-input').press('Enter')
    await dlg.waitFor({ state: 'detached', timeout: 5000 })
    assert.ok(await waitFor(async () => ((await row().locator('.ag-name').textContent()) ?? '') === 'Проект из меню', 8000), 'название не сменилось')

    await row().hover()
    await row().getByTestId('row-menu').click()
    await menu.getByTestId('row-archive').click()
    const archive = h.win.getByTestId('archive-section')
    await archive.waitFor({ timeout: 8000 })
    assert.equal(await h.win.locator('.chat-section [data-testid="agent-row"][data-agent="proj"]').count(), 0, 'архивная сессия осталась в проекте')
    await archive.locator('.proj-h').click()
    await archive.locator('[data-testid="agent-row"][data-agent="proj"]').click({ button: 'right' })
    await menu.getByTestId('row-unarchive').click()
    await archive.waitFor({ state: 'detached', timeout: 8000 })
    await h.win.locator('.chat-section [data-testid="agent-row"][data-agent="proj"]').waitFor({ timeout: 5000 })
  })

  it('закрыть окно посреди хода: ход дошёл без окна, после открытия история на месте', async () => {
    const dir = h.workDir('delta', { scenario: 'simple', hang: 2500 })
    await c.request('agent.start', { name: 'delta', kind: 'claude', cwd: dir })
    await select('delta')
    const box = h.win.getByTestId('composer')
    await box.fill('Реплика перед закрытием окна')
    await box.press('Enter')
    assert.ok(await waitFor(async () => (await statusOf('delta')) === 'working', 10_000))

    // Окно закрыто — демон и агент живут дальше: ход доходит до конца без окна.
    const win = await h.reopen(async () => {
      assert.ok(await waitFor(async () => (await statusOf('delta')) === 'idle', 15_000), 'ход не дошёл без окна')
    })
    assert.ok(await waitFor(async () => (await win.getAttribute('.app', 'data-conn')) === 'up', 20_000))
    await win.locator('[data-testid="agent-row"][data-agent="delta"]').click()
    assert.ok(await waitFor(async () => (await feedText(win)).includes('PULT'), 10_000), 'ответ не восстановился после открытия')
    assert.match(await feedText(win), /Реплика перед закрытием окна/)
    await h.shot('reopened')
  })
})
