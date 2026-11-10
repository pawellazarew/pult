// ДЕМО для скриншотов (docs/12 §5): реалистичное состояние на фальшивых CLI и полноэкранные кадры
// каждого экрана в светлой и тёмной теме — по ним визуал судит отдельный судья.
//
// Состояние: четыре агента —
//   ui-refactor  claude, ход ИДЁТ: Read закончен, субагент Explore ищет Grep-ом и «печатает»;
//   codex-review codex, ход ЗАКОНЧЕН (записанный сценарий с субагентом);
//   fix-limits   claude, ЖДЁТ разрешения на правку файла (Edit с диффом); с названием «Округление лимитов»;
//   codex-tests  codex, ЖДЁТ разрешения на команду;
// Inbox — два запроса, лимиты claude и codex — из событий ходов.
// Кадры: main, inbox, черновик нового чата и меню его чипов (шаг B), doctor, daemon-down × light, dark → test-results/screens/.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, openDoctor, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type Rec = { name: string; lastStatus: string }

describe('скриншоты экранов (демо)', () => {
  let h: Harness
  let c: Client
  const shots: string[] = []

  const both = async (name: string, ready?: () => Promise<void>): Promise<void> => {
    for (const sch of ['light', 'dark'] as const) {
      await h.scheme(sch)
      if (ready) await ready()
      shots.push(await h.screen(`${name}-${sch}`))
    }
    await h.scheme('light')
  }
  const list = async (): Promise<Rec[]> => ((await c.request('agent.list', {})) as { sessions: Rec[] }).sessions
  const statusOf = async (name: string): Promise<string | undefined> => (await list()).find((r) => r.name === name)?.lastStatus

  before(async () => {
    h = await launch({ name: 'screens' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
    h.codexConfig({ speed: 0, scenarioByDir: { 'codex-review': 'subagent', 'codex-tests': 'permission-accept' } })
  })
  after(async () => {
    if (c) {
      try {
        const left = (await c.request('perm.list', {})) as { pending: Array<{ id: string }> }
        for (const p of left.pending) await c.request('perm.resolve', { id: p.id, decision: 'deny', message: 'конец демо' })
      } catch { /* демон уже остановлен сценарием daemon-down */ }
    }
    await h?.close()
    process.stdout.write(`screens:\n${shots.map((s) => `  ${s}`).join('\n')}\n`)
  })

  it('заводит четыре агента в разных состояниях', async () => {
    const start = async (name: string, kind: 'claude' | 'codex', cwd: string, text: string, extra: Record<string, unknown> = {}): Promise<void> => {
      await c.request('agent.start', { name, kind, cwd, ...extra })
      await c.request('agent.prompt', { name, text })
    }
    await start('codex-review', 'codex', h.workDir('codex-review'), 'Проверь, что README объясняет запуск окна, и делегируй вычитку субагенту', { effort: 'medium' })
    assert.ok(await waitFor(async () => (await statusOf('codex-review')) === 'idle', 20_000), 'codex-review не закончил ход')

    await start('ui-refactor', 'claude', h.workDir('ui-refactor', { scenario: 'demo-working', speed: 1 }),
      'Шапка показывает 100 % лимита, хотя лимит не исчерпан. Разберись, где округление.', { model: 'sonnet', effort: 'medium' })
    await start('fix-limits', 'claude', h.workDir('fix-limits', { scenario: 'demo-edit', speed: 1 }),
      'Поправь округление в formatPct: 99,6 % не должно показываться как 100 %.', { model: 'fable', effort: 'xhigh', title: 'Округление лимитов' })
    await start('codex-tests', 'codex', h.workDir('codex-tests'), 'Прогони юнит-тесты интерфейса и запиши итог в x.txt', { effort: 'low' })

    assert.ok(await waitFor(async () => (await statusOf('fix-limits')) === 'blocked_permission', 20_000), 'fix-limits не спросил разрешения')
    assert.ok(await waitFor(async () => (await statusOf('codex-tests')) === 'blocked_permission', 20_000), 'codex-tests не спросил разрешения')
    assert.equal(await statusOf('ui-refactor'), 'working')
    assert.ok(await waitFor(async () => ((await h.win.getByTestId('inbox-count').textContent()) ?? '') === '2', 10_000), 'в Inbox не два запроса')
    // Ссылка без path открывает общий разговор. Недавние проекты доступны в компактном меню заголовка.
    await h.app.evaluate(({ app }) => {
      (app as unknown as { emit(e: string, ...a: unknown[]): boolean }).emit('open-url', { preventDefault() {} }, 'pult://new')
    })
    const d = h.win.getByTestId('draft')
    await d.getByTestId('draft-from-link').waitFor({ timeout: 3000 })
    assert.equal(await d.getByTestId('draft-chip-folder').getAttribute('data-path'), '', 'черновик не без папки')
    assert.equal(await d.getByTestId('draft-heading').textContent(), 'О чём поговорим?')
    await d.getByTestId('draft-chip-folder').click()
    assert.ok(await waitFor(async () => (await h.win.getByTestId('draft-folder-item').count()) > 0, 5000), 'нет недавних папок в меню проекта')
    assert.equal(await h.win.getByTestId('draft-folder-general').getAttribute('aria-checked'), 'true')
    await h.win.keyboard.press('Escape')
    await h.win.getByTestId('draft-menu-folder').waitFor({ state: 'detached', timeout: 3000 })
    await both('draft-no-folder')
    await h.win.keyboard.press('Escape')
    await d.waitFor({ state: 'detached', timeout: 3000 })
    // Субагент ui-refactor успел «напечатать» хвост до паузы.
    // Свёрнутая история субагента не рисуется — раскрываем её, сверяем текст и сворачиваем обратно для кадра.
    await h.win.locator('[data-testid="agent-row"][data-agent="ui-refactor"]').click()
    const history = h.win.locator('[data-testid="subagent"] .sub-body')
    await history.locator('> summary').click({ timeout: 15_000 })
    assert.ok(await waitFor(async () => ((await h.win.getByTestId('feed').textContent()) ?? '').includes('99,6'), 15_000), 'дельты субагента не дошли')
    await history.locator('> summary').click()
    assert.ok(await waitFor(async () => (await history.getAttribute('open')) === null, 3000), 'история субагента не свернулась')
  })

  it('главный экран: агент за работой (Inbox скрыт)', async () => {
    if (await h.win.getByTestId('inbox').count()) await h.win.keyboard.press('Meta+I')
    await h.win.getByTestId('inbox').waitFor({ state: 'detached', timeout: 3000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="ui-refactor"]').click()
    await h.win.getByTestId('subagent').waitFor({ timeout: 5000 })
    await both('main')
  })

  it('Inbox открыт: два запроса, у выбранного агента карточка ещё и в ленте', async () => {
    await h.win.keyboard.press('Meta+I')
    await h.win.getByTestId('inbox').waitFor({ timeout: 3000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="fix-limits"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="fix-limits"]').getByTestId('perm-card').waitFor({ timeout: 5000 })
    assert.equal(await h.win.getByTestId('inbox').getByTestId('perm-card').count(), 2)
    await both('inbox', async () => {
      // Раскладка Inbox: дифф переносится, а не уходит за край (оверлейные полосы macOS прокрутку
      // не показывают); время ожидания — на строке заголовка у КАЖДОЙ карточки.
      const layout = await h.win.evaluate(() => {
        const inbox = document.querySelector('[data-testid="inbox"]')!
        const diffs = Array.from(inbox.querySelectorAll<HTMLElement>('.diff')).map((d) => d.scrollWidth - d.clientWidth)
        const heads = Array.from(inbox.querySelectorAll<HTMLElement>('.perm-h')).map((h) => {
          const l = h.querySelector('.lbl')!.getBoundingClientRect()
          const w = h.querySelector('.waited')!.getBoundingClientRect()
          return Math.abs((l.top + l.bottom) / 2 - (w.top + w.bottom) / 2)
        })
        return { diffs, heads }
      })
      assert.ok(layout.diffs.length > 0, 'в Inbox нет диффа')
      for (const over of layout.diffs) assert.ok(over <= 1, `дифф в Inbox шире колонки на ${over}px`)
      for (const dy of layout.heads) assert.ok(dy <= 3, `«ждёт …» ушло со строки заголовка (${dy}px)`)
    })
  })

  it('меню сессии по правому клику', async () => {
    const row = h.win.locator('[data-testid="agent-row"]').first()
    await row.click({ button: 'right' })
    await h.win.getByTestId('session-menu-list').waitFor({ timeout: 3000 })
    shots.push(await h.screen('session-menu-light'))
    await h.win.keyboard.press('Escape')
  })

  it('черновик нового чата: поле закреплено снизу, проект в заголовке, меню у своего чипа', async () => {
    const dir = h.workDir('landing-copy')
    await h.stubPickFolder(dir)
    await h.win.keyboard.press('Meta+N')
    const d = h.win.getByTestId('draft')
    await d.waitFor({ timeout: 3000 })
    // При росте текста composer растёт вверх, а его нижняя граница остаётся на месте.
    await d.getByTestId('draft-chip-folder').click()
    await h.win.getByTestId('draft-folder-other').click()
    assert.ok(await waitFor(async () => (await d.getByTestId('draft-chip-folder').getAttribute('data-path')) === dir, 3000))
    const bottom = async (): Promise<number> => {
      const box = await d.locator('.draft-box').boundingBox()
      return box ? box.y + box.height : -1
    }
    const y0 = await bottom()
    await both('draft')
    await d.getByTestId('draft-input').fill('Перепиши первый экран лендинга короче: одна мысль, одна кнопка.')
    assert.equal(await bottom(), y0, 'нижняя граница поля сдвинулась при вводе')
    // Каждое меню встаёт у своего чипа (в прототипе меню доступа висело в правом верхнем углу — известный недочёт).
    for (const [chip, menu] of [['draft-chip-model', 'draft-menu-model'], ['draft-chip-effort', 'draft-menu-effort'], ['draft-chip-access', 'draft-menu-access'], ['draft-chip-more', 'draft-menu-more']] as const) {
      await d.getByTestId(chip).click()
      const m = h.win.getByTestId(menu)
      await m.waitFor({ timeout: 3000 })
      const c = (await d.getByTestId(chip).boundingBox())!
      const r = (await m.boundingBox())!
      assert.ok(Math.abs(r.x - c.x) <= 2 || r.x + r.width <= (h.win.viewportSize()?.width ?? 1e9), `${menu} не у чипа`)
      assert.ok(r.y >= c.y + c.height - 1 || r.y + r.height <= c.y + 1, `${menu} перекрывает свой чип`)
      assert.ok(Math.abs(r.x - c.x) <= 40, `${menu} далеко от чипа по горизонтали: ${r.x} против ${c.x}`)
      assert.equal(await bottom(), y0, `нижняя граница поля сдвинулась с открытым ${menu}`)
      if (menu === 'draft-menu-model' || menu === 'draft-menu-access') await both(menu)
      await h.win.keyboard.press('Escape')
      await m.waitFor({ state: 'detached', timeout: 3000 })
    }
    await d.getByTestId('draft-input').fill('')
    await h.win.keyboard.press('Escape')
    await d.waitFor({ state: 'detached', timeout: 3000 })
  })

  it('панель doctor', async () => {
    await openDoctor(h)
    const panel = h.win.getByTestId('doctor-panel')
    await panel.waitFor({ timeout: 3000 })
    assert.ok(await waitFor(async () => (await panel.getByTestId('doctor-item').count()) > 3, 20_000), 'пункты доктора не пришли')
    await waitFor(async () => (await panel.getByTestId('doctor-rerun').isEnabled()), 20_000)
    // Страж в тесте подменён (PULT_TEST_NET=ok): doctor не ходит в сеть по-настоящему.
    const net = (await panel.locator('[data-testid="doctor-item"]', { hasText: 'Сеть claude' }).textContent()) ?? ''
    assert.match(net, /loc=XX, 0 мс/, `doctor сходил в сеть по-настоящему: ${net}`)
    // Команда «почини» копируется через main (в тесте — не в системный буфер).
    const copyBtn = panel.getByTestId('doctor-copy').first()
    assert.ok(await copyBtn.count(), 'ни у одной строки нет команды «почини»')
    const code = copyBtn.locator('xpath=preceding-sibling::code')
    const before = [(await copyBtn.boundingBox())!.width, (await code.boundingBox())!.width]
    await copyBtn.click()
    const copied = await h.app.evaluate(() => (globalThis as { __pultTestClipboard?: string }).__pultTestClipboard ?? null)
    assert.ok(copied && copied.length > 0, 'команда не скопировалась')
    assert.equal(copied, await code.textContent(), 'копируется ровно команда из рамки')
    assert.ok(await waitFor(async () => /скопировано/.test((await copyBtn.textContent()) ?? ''), 2000))
    const after = [(await copyBtn.boundingBox())!.width, (await code.boundingBox())!.width]
    assert.deepEqual(after, before, '«скопировано» сдвинуло кнопку и рамку команды')
    await both('doctor')
    await h.win.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached', timeout: 3000 })
  })

  it('демон недоступен: плашка и кнопка «Запустить демона», последнее состояние приглушено', async () => {
    // Сначала снимаем ходы и вопросы — дети фальшивых CLI гаснут вместе с ними, а не висят сиротами.
    for (const p of ((await c.request('perm.list', {})) as { pending: Array<{ id: string }> }).pending) {
      await c.request('perm.resolve', { id: p.id, decision: 'deny', message: 'конец демо' })
    }
    await h.win.locator('[data-testid="agent-row"][data-agent="ui-refactor"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="ui-refactor"]').getByTestId('subagent').waitFor({ timeout: 5000 })
    await c.request('agent.stop', { name: 'ui-refactor' })
    // Ход прерван: tool_result после kill не придёт — спиннер субагента обязан погаснуть сам.
    assert.ok(await waitFor(async () => (await h.win.getByTestId('subagent').first().getByTestId('subagent-state').getAttribute('data-state')) === 'stopped', 5000),
      'субагент прерванного хода всё ещё «идёт»')
    await c.request('daemon.stop', {})
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'down', 15_000), 'окно не заметило остановку демона')
    await h.win.locator('[data-testid="health-menu"] summary').click()
    await h.win.getByTestId('conn-banner').waitFor({ timeout: 5000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="ui-refactor"]').click({ force: true }).catch(() => { /* строки неактивны */ })
    // Сводка Mac не выдаёт последнее известное за живое; ввод не зовёт печатать.
    const health = h.win.getByTestId('health-menu')
    assert.match((await health.locator('summary').getAttribute('class')) ?? '', /t-fail/)
    if (await health.getAttribute('open') === null) await health.locator('summary').click()
    assert.match((await health.locator('.health-popover').getAttribute('class')) ?? '', /hdr-stale/)
    assert.equal(await health.getByTestId('conn-state').isVisible(), true)
    assert.match((await h.win.getByTestId('composer').getAttribute('placeholder')) ?? '', /демон недоступен/)
    await both('daemon-down')
  })
})
