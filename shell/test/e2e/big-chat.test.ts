// e2e «большой чат»: сессия формы настоящего долгого хода Codex — одна реплика человека, ~30 ответов
// Markdown, ~400 вызовов инструментов пачками и пять субагентов со своими инструментами. Такой ход
// целиком ложится на первую страницу истории (≈1000 событий), и открытие чата раньше занимало секунды:
// лента монтировала каждую строку инструмента, даже свёрнутую в «N действий». Журнал синтетический.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { launch, waitFor } from './harness.js'
import type { Harness } from './harness.js'

type Client = Awaited<ReturnType<Harness['client']>>

/** Ответ модели в Markdown: абзацы, список, код и таблица — то, что парсит и рисует Markdown.tsx. */
const answer = (i: number): string => [
  `### Шаг ${i}`,
  `Проверил модуль \`core/step${i}.ts\`: ${'вывод сходится с ожиданием, '.repeat(4)}детали ниже.`,
  `- пункт первый для шага ${i}\n- пункт второй с **жирным** и [ссылкой](https://docs.example/step${i})\n- пункт третий`,
  '```ts\n' + Array.from({ length: 8 }, (_, j) => `const v${j} = compute(${i}, ${j}) // строка ${j}`).join('\n') + '\n```',
  '| файл | строк |\n|---|---|\n' + Array.from({ length: 4 }, (_, j) => `| src/f${j}.ts | ${j * 10 + i} |`).join('\n'),
].join('\n\n')

/** Вывод команды: несколько килобайт, как у grep/ls по репозиторию. */
const output = (i: number): string => Array.from({ length: 40 }, (_, j) => `src/dir${i % 7}/file${j}.ts:${j + 1}: match line ${i}-${j}`).join('\n')

describe('окно: большой чат открывается быстро', () => {
  let h: Harness
  let c: Client
  const ids = { topNeedle: 0, nestedNeedle: 0, lastModel: 0 }

  before(async () => {
    h = await launch({ name: 'big-chat' })
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
    await c.request('agent.start', { name: 'small', kind: 'codex', cwd: h.workDir('small'), title: 'Малый' })
    await c.request('agent.start', { name: 'big', kind: 'codex', cwd: h.workDir('big'), title: 'Большой' })
    const emit = async (kind: string, data: Record<string, unknown>, parentId?: string): Promise<number> =>
      ((await c.request('events.emit', { kind, sessionId: 'big', provider: 'codex', data, ...(parentId ? { parentId } : {}) })) as { ids: number[] }).ids[0] as number
    let n = 0
    const tool = async (parentId?: string, marker = ''): Promise<number> => {
      const id = `call-${++n}`
      const at = await emit('tool.called', { toolUseId: id, name: 'commandExecution', input: { command: `rg -n "pattern${n}${marker}" src/ --glob '*.ts' | head -40`, cwd: '/w/big' } }, parentId)
      await emit('tool.finished', { toolUseId: id, name: 'commandExecution', content: output(n), exitCode: 0 }, parentId)
      return at
    }
    await emit('message.user', { text: 'Разбери репозиторий и почини найденное' })
    for (let step = 1; step <= 25; step++) {
      const m = await emit('message.done', { text: answer(step) })
      ids.lastModel = m
      // Метка для поиска — в середине пачки ранней части хода: строка свёрнута и далеко от низа ленты.
      for (let k = 0; k < 12; k++) {
        const at = await tool(undefined, step === 3 && k === 6 ? '-игла-сверху' : '')
        if (step === 3 && k === 6) ids.topNeedle = at
      }
      if (step % 5 === 0) {
        const useId = `agent-${step}`
        await emit('agent.spawned', { toolUseId: useId, subagentType: 'explorer', description: `Проверка части ${step}` })
        await emit('message.done', { text: answer(100 + step) }, useId)
        for (let k = 0; k < 20; k++) {
          const at = await tool(useId, step === 10 && k === 9 ? '-игла-внутри' : '')
          if (step === 10 && k === 9) ids.nestedNeedle = at
        }
        await emit('message.done', { text: answer(200 + step) }, useId)
        await emit('agent.finished', { toolUseId: useId })
      }
    }
    ids.lastModel = await emit('message.done', { text: answer(999) })
    await h.win.locator('[data-testid="agent-row"][data-agent="small"]').click()
    await h.win.locator('[data-testid="conversation"][data-agent="small"]').waitFor({ timeout: 10_000 })
  })
  after(async () => { await h?.close() })

  it('первое открытие: история загружена и нарисована быстро', async () => {
    // Время от щелчка до кадра, где последний ответ уже в ленте: загрузка истории, свёртка и отрисовка.
    const ms = await h.win.evaluate(async (lastModel) => {
      const row = document.querySelector<HTMLElement>('[data-testid="agent-row"][data-agent="big"]')
      if (!row) throw new Error('нет строки сессии')
      const t0 = performance.now()
      row.click()
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (document.querySelector(`[data-testid="conversation"][data-agent="big"] [data-event-id="${lastModel}"]`)) resolve()
          else requestAnimationFrame(check)
        }
        check()
      })
      // Кадр после коммита: в замер входит и раскладка.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      return performance.now() - t0
    }, ids.lastModel)
    const rows = await h.win.locator('[data-testid="conversation"][data-agent="big"] [data-testid="tool-row"]').count()
    console.log(`e2e big-chat: открытие ${Math.round(ms)} мс, строк инструментов в DOM ${rows}`)
    // Бюджет с запасом на медленный раннер; цель на машине разработчика — меньше 500 мс.
    assert.ok(ms < 1500, `большой чат открывался ${Math.round(ms)} мс`)
    // Лента прилипла к низу: последний ответ на экране.
    assert.ok(await waitFor(async () => h.win.evaluate(() => {
      const feed = document.querySelector('[data-testid="feed"]') as HTMLElement
      return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80
    }), 3000), 'лента не прокручена к низу')
  })
  /** ⌘⇧F → запрос → Enter: строка инструмента найдена, раскрыта, на экране и подсвечена. */
  const jump = async (query: string, eventId: number): Promise<void> => {
    await h.win.getByTestId('composer').focus()
    await h.win.keyboard.press('Meta+Shift+KeyF')
    const dlg = h.win.getByTestId('search-dialog')
    await dlg.waitFor({ timeout: 5000 })
    await dlg.getByTestId('search-input').fill(query)
    const hit = dlg.locator(`[data-testid="search-hit"][data-event-id="${eventId}"]`)
    await hit.waitFor({ timeout: 10_000 })
    await hit.click()
    await dlg.waitFor({ state: 'detached', timeout: 5000 })
    const row = h.win.locator(`[data-testid="conversation"][data-agent="big"] [data-testid="tool-row"][data-event-id="${eventId}"]`)
    await row.waitFor({ timeout: 10_000 })
    assert.ok(await waitFor(async () => (await row.getAttribute('class'))?.includes('it-flash') === true, 5000), 'строка не подсвечена')
    const inView = await row.evaluate((el) => {
      const f = (document.querySelector('[data-testid="feed"]') as HTMLElement).getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return r.top >= f.top - 1 && r.bottom <= f.bottom + 1
    })
    assert.ok(inView, 'строка не на экране')
  }

  it('переход из поиска к строке в свёрнутой пачке раскрывает пачку', async () => {
    await jump('игла-сверху', ids.topNeedle)
    const group = h.win.locator(`[data-testid="activity-group"]:has([data-event-id="${ids.topNeedle}"])`)
    assert.notEqual(await group.getAttribute('open'), null)
    // Раскрыта ровно одна пачка — остальные по-прежнему не смонтированы.
    assert.equal(await h.win.locator('[data-testid="conversation"][data-agent="big"] [data-testid="activity-group"][open]').count(), 1)
  })

  it('переход к строке субагента раскрывает историю субагента и пачку внутри неё', async () => {
    await jump('игла-внутри', ids.nestedNeedle)
    const sub = h.win.locator(`.sub-body:has([data-event-id="${ids.nestedNeedle}"])`)
    assert.notEqual(await sub.getAttribute('open'), null)
  })

  it('щелчок по заголовку пачки раскрывает и сворачивает её', async () => {
    const group = h.win.locator('[data-testid="conversation"][data-agent="big"] [data-testid="activity-group"]').last()
    const summary = group.locator('> summary')
    await summary.scrollIntoViewIfNeeded()
    assert.equal(await group.getAttribute('open'), null)
    assert.equal(await group.locator('[data-testid="tool-row"]').count(), 0)
    await summary.click()
    assert.ok(await waitFor(async () => (await group.locator('[data-testid="tool-row"]').count()) === 12), 'пачка не раскрылась')
    await summary.click()
    assert.ok(await waitFor(async () => (await group.locator('[data-testid="tool-row"]').count()) === 0), 'пачка не свернулась')
  })

  it('живой ход: новые вызовы встают в свёрнутую пачку, лента у низа, запрос разрешения на виду', async () => {
    await h.win.getByTestId('jump-latest').click().catch(() => { /* лента уже у низа */ })
    const atBottom = async (): Promise<boolean> => h.win.evaluate(() => {
      const feed = document.querySelector('[data-testid="feed"]') as HTMLElement
      return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80
    })
    assert.ok(await waitFor(atBottom, 3000), 'лента не у низа перед ходом')
    const emit = async (kind: string, data: Record<string, unknown>): Promise<number> =>
      ((await c.request('events.emit', { kind, sessionId: 'big', provider: 'codex', data })) as { ids: number[] }).ids[0] as number
    await emit('tool.called', { toolUseId: 'live-1', name: 'commandExecution', input: { command: 'npm test' } })
    await emit('tool.finished', { toolUseId: 'live-1', name: 'commandExecution', content: 'ok', exitCode: 0 })
    await emit('tool.called', { toolUseId: 'live-2', name: 'commandExecution', input: { command: 'npm run build' } })
    const last = h.win.locator('[data-testid="conversation"][data-agent="big"] [data-testid="activity-group"]').last()
    assert.ok(await waitFor(async () => /2 действия\s*· Команда npm run build/.test((await last.locator('> summary').textContent()) ?? ''), 5000), `живая пачка не обновилась: ${await last.locator('> summary').textContent()}`)
    assert.equal(await last.getAttribute('open'), null)
    const perm = await emit('permission.requested', { id: 'perm-big', toolName: 'commandExecution', input: { command: 'rm -rf build' } })
    const card = h.win.locator(`[data-testid="conversation"][data-agent="big"] .it-perm[data-event-id="${perm}"]`)
    await card.waitFor({ timeout: 5000 })
    assert.ok(await waitFor(atBottom, 3000), 'лента не прилипла к низу за живым ходом')
    assert.ok(await card.isVisible(), 'карточка разрешения не на виду')
  })
})
