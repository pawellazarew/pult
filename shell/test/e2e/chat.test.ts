// e2e M8e: поле ввода не ждёт демона (реплика «отправляется…»), реплика человека Markdown'ом, «Копировать» у реплики.
// Страж сети «думает» 2,5 с (PULT_TEST_NET_DELAY_MS, как curl до api.anthropic.com на медленной сети): ответ
// `agent.prompt` приходит только после него, а поле обязано очиститься сразу.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type Ev = { id: number; kind: string; sessionId: string; data: Record<string, unknown> }

const NET_DELAY_MS = 2500

describe('окно: чат M8e', () => {
  let h: Harness
  let c: Client

  before(async () => {
    h = await launch({ name: 'chat', env: { PULT_TEST_NET_DELAY_MS: String(NET_DELAY_MS) } })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
  })
  after(async () => { await h?.close() })

  const journal = async (sessionId: string): Promise<Ev[]> =>
    ((await c.request('events.tail', { since: 0, sessionId })) as { events: Ev[] }).events
  const users = async (name: string): Promise<unknown[]> => (await journal(name)).filter((e) => e.kind === 'message.user').map((e) => e.data['text'])
  const select = async (name: string): Promise<void> => {
    await h.win.locator(`[data-testid="agent-row"][data-agent="${name}"]`).click()
    await h.win.locator(`[data-testid="conversation"][data-agent="${name}"]`).waitFor({ timeout: 10_000 })
  }
  // Тестовый прогон системный буфер не трогает: main кладёт скопированное в `__pultTestClipboard`.
  const copied = async (): Promise<string | undefined> => h.app.evaluate(() => (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard)
  const TEXT = 'смотри https://example.com/a_b и snake_case_name в `cli.ts`\nвторая строка'

  it('Enter: поле пустое сразу, реплика в ленте сразу; ход — после стража; дубля нет; Markdown и переносы', async () => {
    await c.request('agent.start', { name: 'ux', kind: 'claude', cwd: h.workDir('ux', { scenario: 'simple' }) })
    await select('ux')
    const box = h.win.getByTestId('composer')
    await box.fill(TEXT)
    const t0 = Date.now()
    await box.press('Enter')
    assert.equal(await box.inputValue(), '', 'поле не очистилось сразу')
    const anyUser = h.win.locator('[data-testid="msg-user"], [data-testid="msg-user-pending"]')
    assert.ok(await waitFor(async () => (await anyUser.count()) === 1, 1000), 'реплика не встала в ленту сразу')
    const shownMs = Date.now() - t0
    assert.ok(shownMs < NET_DELAY_MS, `реплика в ленте только через ${shownMs} мс`)
    // Ответ демона ещё в пути: ход не начат (страж «думает»), а поле уже свободно.
    assert.ok(!(await journal('ux')).some((e) => e.kind === 'status.changed' && e.data['status'] === 'working'), 'ход начался раньше стража')
    await box.pressSequentially('пишу дальше')
    assert.equal(await box.inputValue(), 'пишу дальше')

    assert.ok(await waitFor(async () => ((await h.win.getByTestId('feed').textContent()) ?? '').includes('PULT'), 15_000), 'ответа нет')
    assert.equal(await h.win.getByTestId('msg-user').count(), 1, 'реплика человека задвоилась')
    assert.equal(await h.win.getByTestId('msg-user-pending').count(), 0, 'пузырь «отправляется…» не ушёл')
    assert.equal(await box.inputValue(), 'пишу дальше', 'успех не трогает поле')
    assert.deepEqual(await users('ux'), [TEXT])

    // Реплика человека — Markdown: ссылка живая, snake_case не курсив, код в строке, строки не склеены.
    const msg = h.win.getByTestId('msg-user')
    assert.equal(await msg.locator('a.md-a').getAttribute('href'), 'https://example.com/a_b')
    assert.equal(await msg.locator('em, strong').count(), 0)
    assert.equal(await msg.locator('code.md-icode').textContent(), 'cli.ts')
    assert.match(await msg.locator('.md').innerText(), /snake_case_name в cli\.ts\nвторая строка/)
    await h.shot('sent')
  })

  it('«Копировать» у реплики и у ответа кладёт в буфер исходный текст', async () => {
    const user = h.win.getByTestId('msg-user')
    await user.hover()
    await user.getByTestId('msg-copy').click()
    assert.ok(await waitFor(async () => (await copied()) === TEXT, 3000), `буфер не получил реплику: ${await copied()}`)
    // Буфер main пишет ДО ответа окну: отметка встаёт, когда ответ дойдёт и React перерисует кнопку, — ждём её.
    assert.ok(await waitFor(async () => (await user.getByTestId('msg-copy').getAttribute('aria-label')) === 'Скопировано', 3000),
      `нет отметки «Скопировано»: ${await user.getByTestId('msg-copy').getAttribute('aria-label')}`)

    const model = h.win.getByTestId('msg-model').last()
    await model.hover()
    await model.getByTestId('msg-copy').click()
    const done = (await journal('ux')).filter((e) => e.kind === 'message.done').map((e) => e.data['text']).pop()
    assert.equal(typeof done, 'string')
    assert.ok(await waitFor(async () => (await copied()) === done, 3000), `буфер не получил ответ: ${await copied()}`)

    // С клавиатуры: кнопка в порядке Tab и видна в фокусе.
    await user.getByTestId('msg-copy').focus()
    assert.equal(await user.getByTestId('msg-copy').evaluate((el) => getComputedStyle(el).opacity), '1')
  })

  it('⌘Enter посреди хода: пузырь «отправляется…», пока ход оседает, затем настоящая реплика без дубля', async () => {
    // Глухой fake (SIGINT/SIGTERM мимо): ход оседает секунды — столько и висит пузырь. Флаг fake — строка '1':
    // `deaf: true` fake молча пропускал, ход оседал за ~80 мс, и пузырь под нагрузкой не успевали прочесть.
    await c.request('agent.start', { name: 'ux2', kind: 'claude', cwd: h.workDir('ux2', { scenario: 'simple', hangAfterInit: 30_000, deaf: '1' }) })
    await c.request('agent.prompt', { name: 'ux2', text: 'Первая' })
    await select('ux2')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-status').textContent()) === 'идёт', 10_000),
      `статус в окне: ${await h.win.getByTestId('conv-status').textContent()}; журнал: ${(await journal('ux2')).map((e) => (e.kind === 'status.changed' ? `${e.kind}:${String(e.data['status'])}` : e.kind)).join(' ')}`)
    // «Идёт» ставится до спавна процесса. ⌘Enter раньше `session.started` (init глухого процесса) застаёт ход без
    // процесса, и он закрывается за миллисекунды. Ждём, пока глухой процесс поднимется: тогда ход оседает по
    // лестнице сигналов ~5 с (замер 20.10), и пузырь живёт столько же.
    assert.ok(await waitFor(async () => (await journal('ux2')).some((e) => e.kind === 'session.started'), 10_000), 'глухой процесс не поднялся')
    const box = h.win.getByTestId('composer')
    await box.fill('Вместо')
    await box.press('Meta+Enter')
    assert.equal(await box.inputValue(), '')
    const pending = h.win.getByTestId('msg-user-pending')
    await pending.waitFor({ timeout: 1000 })
    assert.match((await pending.textContent()) ?? '', /Вместо[\s\S]*отправляется…/)
    assert.equal(await pending.getByTestId('msg-copy').count(), 0)
    await h.shot('pending')
    assert.ok(await waitFor(async () => (await pending.count()) === 0, 20_000), 'пузырь не ушёл')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('msg-user').count()) === 2, 5000))
    assert.deepEqual(await users('ux2'), ['Первая', 'Вместо'])
    assert.match((await h.win.getByTestId('msg-user').last().textContent()) ?? '', /Вместо/)
    await c.request('agent.stop', { name: 'ux2' }).catch(() => undefined)
  })

  it('⌘Enter в поле сессии A прерывает A, а карточку сессии B из открытого Inbox не разрешает', async () => {
    // Сессия B ждёт разрешения — её карточка в открытом Inbox, и вне поля ⌘Enter разрешил бы её (выделена).
    await c.request('agent.start', { name: 'pb', kind: 'claude', cwd: h.workDir('pb', { scenario: 'demo-edit' }) })
    await c.request('agent.prompt', { name: 'pb', text: 'Поправь округление' })
    const inbox = h.win.getByTestId('inbox')
    if (!(await inbox.count())) await h.win.keyboard.press('Meta+i')
    const card = inbox.locator('[data-testid="perm-card"]')
    assert.ok(await waitFor(async () => (await card.count()) === 1, 15_000), 'запрос B не дошёл до Inbox')
    const permId = await card.getAttribute('data-perm-id')
    // Сессия A посреди хода (глухой fake: ход оседает секунды, как в тесте выше).
    await c.request('agent.start', { name: 'pa', kind: 'claude', cwd: h.workDir('pa', { scenario: 'simple', hangAfterInit: 30_000, deaf: '1' }) })
    await c.request('agent.prompt', { name: 'pa', text: 'Первая' })
    await select('pa')
    assert.ok(await waitFor(async () => (await journal('pa')).some((e) => e.kind === 'session.started'), 10_000), 'глухой процесс не поднялся')
    assert.ok(await waitFor(async () => (await h.win.getByTestId('conv-status').textContent()) === 'идёт', 10_000))
    // Предусловие: карточка B выделена — старое поле отдало бы ⌘Enter окну, и оно разрешило бы её.
    assert.equal(await card.getAttribute('data-focused'), 'true')
    const box = h.win.getByTestId('composer')
    await box.fill('Вместо')
    await box.press('Meta+Enter')
    assert.equal(await box.inputValue(), '', 'реплика не ушла «прервать и сказать»')
    assert.ok(await waitFor(async () => JSON.stringify(await users('pa')) === JSON.stringify(['Первая', 'Вместо']), 20_000), `реплики A: ${JSON.stringify(await users('pa'))}`)
    // B по-прежнему ждёт: ни решения в журнале, ни пропажи из perm.list.
    const pending = ((await c.request('perm.list', {})) as { pending: Array<{ id: string }> }).pending.map((p) => p.id)
    assert.ok(pending.includes(String(permId)), `запрос B снят: ${JSON.stringify(pending)}`)
    assert.equal((await journal('pb')).filter((e) => e.kind === 'permission.resolved').length, 0, 'запрос B получил решение')
    assert.equal(await card.count(), 1, 'карточка B ушла из Inbox')
    await h.shot('cmd-enter-other-session')
    await c.request('agent.stop', { name: 'pa' }).catch(() => undefined)
    await c.request('agent.stop', { name: 'pb' }).catch(() => undefined)
  })
})
