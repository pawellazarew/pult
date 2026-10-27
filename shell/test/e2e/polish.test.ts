import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

describe('полировка: фокус, управление у ввода и длинная беседа', () => {
  let h: Harness
  before(async () => {
    h = await launch({ name: 'polish' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000))
    h.codexConfig({ scenario: 'hang' })
    const c = await h.client()
    await c.request('agent.start', { name: 'polish', kind: 'codex', cwd: h.workDir('pult'), model: 'gpt-5-codex', approval: 'full', confirm: true })
    await c.request('agent.rename', { name: 'polish', title: 'Сделать настройки проще и понятнее' })
    const emit = (kind: string, data: Record<string, unknown>) => c.request('events.emit', { sessionId: 'polish', provider: 'codex', kind, data })
    for (let i = 0; i < 8; i++) {
      await emit('message.user', { text: `Проверь сохранение выбранной темы — шаг ${i + 1}.` })
      await emit('message.done', { text: 'Проверил экран настроек. Выбор темы сохраняется при переходе между разделами и после перезапуска приложения.\n\nИзменения остаются локальными до следующего подтверждения.' })
    }
    await emit('tool.called', { toolUseId: 'err', name: 'Bash', input: { command: 'echo LONG_INPUT_'.repeat(2000) } })
    await emit('tool.finished', { toolUseId: 'err', isError: true, exitCode: 2, content: Array.from({ length: 100 }, (_, i) => `строка ${i}`).join('\n') + '\nНе найден тестовый пакет. Установить зависимости?' })
    await emit('message.done', { text: 'Экран настроек готов.\n\n- Переключатель темы расположен рядом с предпросмотром.\n- Выбор сохраняется после перезапуска.\n- Перед проверкой тестов нужно установить зависимости.' })
    await c.request('agent.prompt', { name: 'polish', text: 'Проверь ещё режим доступа' })
    await h.win.locator('[data-testid="agent-row"][data-agent="polish"]').click()
    await h.win.getByTestId('composer').waitFor()
    await h.win.getByTestId('stop-turn').waitFor()
    assert.ok(await waitFor(async () => (await h.win.getByTestId('feed').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)) < 3), 'новая беседа не докручена до низа')
  })
  after(async () => { await h?.close() })

  it('ошибка компактна, полный лог закрыт, режим доступа и действия находятся в composer', async () => {
    const preview = h.win.getByTestId('tool-error-preview')
    assert.ok(await waitFor(async () => (await preview.count()) === 1))
    assert.doesNotMatch((await preview.textContent()) ?? '', /LONG_INPUT_|строка 0/)
    assert.match((await preview.textContent()) ?? '', /Не найден тестовый пакет/)
    assert.equal(await h.win.locator('.tool-raw').getAttribute('open'), null)
    for (const open of [true, false]) {
      await h.win.locator('.tool-raw').evaluate((el, value) => { (el as HTMLDetailsElement).open = value }, open)
      assert.ok(await waitFor(async () => (await h.win.getByTestId('feed').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)) < 3), 'изменение высоты оторвало ленту от низа')
    }
    await h.win.locator('.composer [data-testid="conv-settings"]').waitFor()
    assert.match((await h.win.locator('.composer [data-testid="conv-approval"]').textContent()) ?? '', /полный доступ/)
    assert.ok(await h.win.getByTestId('stop-turn').isVisible())
    await h.win.getByTestId('composer').fill('Проверь ещё контраст подписи')
    assert.equal(await h.win.getByTestId('send').isEnabled(), true)
    for (const scheme of ['light', 'dark'] as const) { await h.scheme(scheme); await h.screen(`polish-${scheme}`) }
  })

  it('⌘B освобождает место, ⌘K возвращает список и фокусирует поиск; вниз возвращает к новым', async () => {
    const width = () => h.win.getByTestId('feed').evaluate((el) => el.getBoundingClientRect().width)
    const before = await width()
    await h.win.keyboard.press('Meta+B')
    assert.ok(await waitFor(async () => !(await h.win.locator('.agents-col').isVisible())))
    assert.ok(await width() > before + 150)
    await h.screen('polish-focus')
    await h.win.keyboard.press('Meta+K')
    assert.ok(await waitFor(async () => await h.win.getByTestId('chat-filter').evaluate((el) => el === document.activeElement)))
    await h.win.getByTestId('chat-filter').fill('настройки')
    assert.equal(await h.win.getByTestId('agent-row').count(), 1)
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.getByTestId('chat-filter').inputValue(), '')
    assert.equal(await h.win.getByTestId('confirm-stop').count(), 0)
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.getByTestId('composer').evaluate((el) => el === document.activeElement), true)
    await h.win.keyboard.press('Meta+K')
    await h.win.getByTestId('chat-filter').fill('настройки')
    await h.win.keyboard.press('Enter')
    assert.ok(await waitFor(async () => await h.win.getByTestId('composer').evaluate((el) => el === document.activeElement)))
    await h.win.getByTestId('feed').evaluate((el) => { el.scrollTop = 0 })
    await h.win.getByTestId('jump-latest').waitFor()
    await h.win.getByTestId('jump-latest').click()
    await h.win.getByTestId('jump-latest').waitFor({ state: 'detached' })
    const gap = await h.win.getByTestId('feed').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    assert.ok(gap < 3)
    await h.win.getByTestId('chat-info').locator('summary').click()
    await h.win.keyboard.press('Escape')
    assert.equal(await h.win.getByTestId('chat-info').getAttribute('open'), null)
    assert.equal(await h.win.getByTestId('confirm-stop').count(), 0)
    assert.equal(await h.win.getByTestId('composer').inputValue(), 'Проверь ещё контраст подписи')
    assert.ok(await h.win.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  })

  it('в узком окне модальный диалог находится выше открытого Inbox', async () => {
    await h.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1024, 642) })
    await h.win.getByTestId('toggle-inbox').click()
    await h.win.keyboard.press('Meta+N')
    const dialog = h.win.getByTestId('new-agent-dialog')
    await dialog.waitFor()
    const pick = dialog.getByTestId('pick-folder')
    assert.ok(await pick.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }), 'Inbox перекрывает кнопку диалога')
    await h.win.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
  })
})
