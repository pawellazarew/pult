// Кадры README: нейтральная «живая» сцена на фальшивых CLI и снимки ОКНА (не экрана) в светлой и тёмной теме.
//
//   cd shell && npm run shots:readme        → docs/images/*.png (сжатые), сырые — test-results/readme/
//
// В обычный гейт не входит: `npm test` берёт dist-test/unit, `npm run e2e` — dist-test/e2e, этот файл
// собирается в dist-test/readme. Сцена:
//   acme-api   fix-pagination  claude opus · high  — ход закончен: реплика, три инструмента, ответ в Markdown;
//              rate-limits     claude              — ход идёт;
//              api-tests       codex               — ждёт разрешения на `npm test`;
//   docs-site  install-guide   claude              — ждёт ответа на вопрос (AskUserQuestion);
//              changelog       codex               — готов, не прочитан;
//   mobile-app release-notes   claude              — готов, не прочитан.
// Пути нейтральные: папки проектов — /Users/Shared/src/<проект> (окно сокращает их до ~/src/<проект>); их
// создаёт и убирает сам прогон. Если /Users/Shared/src уже есть (чужое), папки идут во временный PULT_HOME.
// HOME окна и демона — тоже временная папка: настройки владельца (~/.claude) в кадр не попадают.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { launch, REPO, RESULTS, waitFor } from '../e2e/harness.js'
import type { Harness } from '../e2e/harness.js'

type Client = Awaited<ReturnType<Harness['client']>>
type Rec = { name: string; lastStatus: string }

// 1440×900 — экран MacBook по умолчанию; в нём диалог «+ Сессия» помещается целиком.
const W = 1440
const H = 900
const OUT = path.join(RESULTS, 'readme')
const SHARED = '/Users/Shared/src'
const CLAUDE_FIX = path.join(REPO, 'test', 'fixtures', 'claude')
const CODEX_FIX = path.join(REPO, 'test', 'fixtures', 'codex')
const MODEL = 'claude-opus-4-6'

const HERO_PROMPT = 'На /orders вторая страница начинается с 21-й записи, а не с 11-й. Найди причину и почини — тесты должны пройти.'
const HERO_ANSWER = [
  'Причина нашлась: `page` в запросе считается с единицы, а смещение — как будто с нуля, поэтому вторая страница пропускает целую страницу записей.',
  '',
  'Что поменял:',
  '- `src/routes/orders.ts` — смещение теперь `(page - 1) * limit`;',
  '- добавил тест на границу первой и второй страницы;',
  '- `npm test` — 48 тестов, все зелёные.',
  '',
  '```ts',
  'const offset = (page - 1) * limit',
  'const rows = await listOrders({ offset, limit })',
  '```',
  '',
  'Если хочешь, переведу список на курсорную пагинацию — она не съезжает, когда заказы добавляются между запросами.',
].join('\n')

describe('кадры README', () => {
  let h: Harness
  let c: Client
  let root = SHARED
  let madeShared = false
  let fakeHome = ''
  const shots: string[] = []
  const dir = (p: string): string => path.join(root, p)

  const shoot = async (name: string, ready?: () => Promise<void>): Promise<void> => {
    // Курсор — в угол строки состояния: наведение не должно подчёркивать кнопки в кадре.
    await h.win.mouse.move(W - 2, H - 2)
    for (const sch of ['light', 'dark'] as const) {
      await h.scheme(sch)
      if (ready) await ready()
      await h.win.evaluate(() => document.fonts.ready.then(() => true))
      await new Promise((r) => setTimeout(r, 250))
      const file = path.join(OUT, `${name}-${sch}.png`)
      await h.win.screenshot({ path: file, animations: 'disabled', caret: 'hide' })
      shots.push(file)
    }
    await h.scheme('light')
  }
  const list = async (): Promise<Rec[]> => ((await c.request('agent.list', {})) as { sessions: Rec[] }).sessions
  const statusOf = async (name: string): Promise<string | undefined> => (await list()).find((r) => r.name === name)?.lastStatus
  const until = async (name: string, status: string): Promise<void> => {
    assert.ok(await waitFor(async () => (await statusOf(name)) === status, 20_000), `${name}: нет статуса ${status} (сейчас ${await statusOf(name)})`)
  }
  const fake = (project: string, cfg: Record<string, unknown>): void => {
    writeFileSync(path.join(dir(project), '.pult-fake.json'), JSON.stringify({ speed: 0, ...cfg }))
  }
  const start = async (name: string, kind: 'claude' | 'codex', project: string, text: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await c.request('agent.start', { name, kind, cwd: dir(project), ...extra })
    await c.request('agent.prompt', { name, text })
  }

  /** Запись Claude для сцены: init и конверт result — из настоящей записи 01, реплики — свои. */
  const claudeFixture = (file: string, sessionId: string, cwd: string, body: Array<Record<string, unknown>>, answer: string): string => {
    const sample = readFileSync(path.join(CLAUDE_FIX, '01-simple-turn.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    const init = { ...sample[0], cwd, session_id: sessionId, model: MODEL, memory_paths: {} }
    const base = sample.find((e) => e['type'] === 'result')!
    const usage = { input_tokens: 8, cache_creation_input_tokens: 5_200, cache_read_input_tokens: 41_800, output_tokens: 640 }
    const now = Math.floor(Date.now() / 1000)
    const rate = {
      type: 'rate_limit_event', session_id: sessionId,
      rate_limit_info: { status: 'allowed', resetsAt: now + 7_800, rateLimitType: 'five_hour', isUsingOverage: false,
        unifiedWindows: { five_hour: { utilization: 0.38, resetsAt: now + 7_800 }, seven_day: { utilization: 0.21, resetsAt: now + 3 * 86_400 } } },
    }
    let n = 0
    const wrap = (e: Record<string, unknown>): Record<string, unknown> => {
      n++
      const uuid = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
      if (e['role'] === 'user') return { type: 'user', message: { role: 'user', content: e['content'] }, parent_tool_use_id: null, session_id: sessionId, uuid }
      return { type: 'assistant', message: { model: MODEL, id: `msg_readme_${n}`, type: 'message', role: 'assistant', content: e['content'], stop_reason: null, usage },
        parent_tool_use_id: null, session_id: sessionId, uuid }
    }
    const result = {
      ...base, session_id: sessionId, result: answer, duration_ms: 41_200, duration_api_ms: 38_900, num_turns: 4, total_cost_usd: 0.41,
      usage: { ...usage, iterations: [] },
      modelUsage: { [MODEL]: { inputTokens: 8, outputTokens: 640, cacheReadInputTokens: 41_800, cacheCreationInputTokens: 5_200, webSearchRequests: 0, costUSD: 0.41, contextWindow: 200_000, maxOutputTokens: 32_000 } },
    }
    const events = [init, rate, ...body.map(wrap), result]
    const out = path.join(h.home, 'fixtures', file)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(`${out}.jsonl`, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    writeFileSync(`${out}.timing.json`, JSON.stringify(events.map((_, i) => i * 60)))
    return out
  }

  /** Запись Codex «ждёт разрешения на `npm test`» — из настоящей 03-permission-accept, команда и папка свои. */
  const codexFixture = (cwd: string, prompt: string): string => {
    const lines = readFileSync(path.join(CODEX_FIX, '03-permission-accept.jsonl'), 'utf8').split('\n').filter(Boolean)
    const out: string[] = []
    for (const raw of lines) {
      const msg = JSON.parse(raw) as { method?: string; params?: Record<string, unknown> }
      if (msg.method === 'hook/started' || msg.method === 'hook/completed') continue
      const p = msg.params ?? {}
      if (msg.method === 'item/commandExecution/requestApproval') {
        Object.assign(p, {
          command: 'npm test', cwd, commandActions: [{ type: 'unknown', command: 'npm test' }],
          reason: 'Тестам нужна сеть (поднимают локальную базу из образа) — запустить вне песочницы?',
          proposedExecpolicyAmendment: ['npm', 'test'],
          availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } }, 'cancel'],
        })
      }
      const item = p['item'] as Record<string, unknown> | undefined
      if (item?.['type'] === 'userMessage') item['content'] = [{ type: 'text', text: prompt, text_elements: [] }]
      if (item?.['type'] === 'commandExecution') Object.assign(item, { command: 'npm test', cwd, commandActions: [{ type: 'unknown', command: 'npm test' }] })
      out.push(JSON.stringify(msg).split('/Users/you/src/pult/spike/sandbox-a').join(cwd).split('echo hi > x.txt').join('npm test'))
    }
    const file = path.join(h.home, 'fixtures', 'codex-npm-test')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(`${file}.jsonl`, out.join('\n') + '\n')
    return file
  }

  before(async () => {
    mkdirSync(OUT, { recursive: true })
    for (const f of ['hero', 'inbox', 'new-session', 'settings-menu']) for (const s of ['light', 'dark']) rmSync(path.join(OUT, `${f}-${s}.png`), { force: true })
    fakeHome = mkdtempSync(path.join(tmpdir(), 'pr-home-'))
    h = await launch({
      name: 'readme',
      // Кадр в 2× и на экране без Retina.
      args: ['--force-device-scale-factor=2'],
      env: { PULT_TEST_PROVIDERS: 'run', HOME: fakeHome },
    })
    await h.app.evaluate(({ BrowserWindow }, [w, hh]) => { BrowserWindow.getAllWindows()[0]?.setContentSize(w, hh) }, [W, H] as [number, number])
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось')
    c = await h.client()
    if (existsSync(SHARED)) root = path.join(h.home, 'src')
    else madeShared = true
    for (const p of ['acme-api', 'docs-site', 'mobile-app']) mkdirSync(dir(p), { recursive: true })
  })

  after(async () => {
    if (c) {
      try {
        const left = (await c.request('perm.list', {})) as { pending: Array<{ id: string }> }
        for (const p of left.pending) await c.request('perm.resolve', { id: p.id, decision: 'deny', message: 'конец съёмки' })
      } catch { /* демон уже ушёл */ }
    }
    await h?.close()
    if (madeShared) rmSync(SHARED, { recursive: true, force: true })
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
    process.stdout.write(`readme shots:\n${shots.map((s) => `  ${s}`).join('\n')}\n`)
  })

  it('сцена: три проекта, шесть сессий в разных состояниях', async () => {
    h.codexConfig({
      speed: 0,
      models: [
        { id: 'gpt-5-codex', model: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
        { id: 'gpt-5', model: 'gpt-5', displayName: 'GPT-5', isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
      ],
      scenarios: { 'npm-test': [codexFixture(dir('acme-api'), 'Прогони тесты API и почини то, что упадёт.')] },
      scenarioByDir: { 'acme-api': 'npm-test', 'docs-site': 'simple' },
    })
    for (const p of ['acme-api', 'docs-site', 'mobile-app']) await c.request('project.add', { path: dir(p) })
    // Список проектов окно читает при подключении: чужой `project.add` оно не видит до перезагрузки.
    await h.win.reload()
    assert.ok(await waitFor(async () => (await h.win.getAttribute('.app', 'data-conn')) === 'up', 20_000), 'окно не подключилось после перезагрузки')

    // acme-api: ход закончен — его разговор и снимается.
    const hero = claudeFixture('hero', '00000000-0000-4000-8000-00000000a001', dir('acme-api'), [
      { content: [{ type: 'text', text: 'Посмотрю, как маршрут считает смещение страницы.' }] },
      { content: [{ type: 'tool_use', id: 'toolu_r1', name: 'Read', input: { file_path: 'src/routes/orders.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r1', content: '12\tconst offset = page * limit\n13\tconst rows = await db.orders.findMany({ skip: offset, take: limit })', is_error: false }] },
      { content: [{ type: 'tool_use', id: 'toolu_r2', name: 'Edit', input: { file_path: 'src/routes/orders.ts', old_string: 'const offset = page * limit', new_string: 'const offset = (page - 1) * limit' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r2', content: 'The file src/routes/orders.ts has been updated.', is_error: false }] },
      { content: [{ type: 'tool_use', id: 'toolu_r3', name: 'Bash', input: { command: 'npm test', description: 'Прогнать тесты' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r3', content: 'Tests: 48 passed, 48 total\nTime: 6.2 s', is_error: false }] },
      { content: [{ type: 'text', text: HERO_ANSWER }] },
    ], HERO_ANSWER)
    fake('acme-api', { scenario: 'custom', files: [hero] })
    await start('fix-pagination', 'claude', 'acme-api', HERO_PROMPT, { model: 'opus', effort: 'high' })
    await until('fix-pagination', 'idle')

    // acme-api: ход идёт (записанная демо-запись тянется долго — сессия «идёт» весь прогон).
    fake('acme-api', { scenario: 'demo-working', speed: 1 })
    await start('rate-limits', 'claude', 'acme-api', 'Добавь лимит запросов на /login: 5 попыток в минуту с одного адреса.', { model: 'sonnet', effort: 'medium' })
    await until('rate-limits', 'working')

    // acme-api: codex ждёт разрешения на `npm test`.
    await start('api-tests', 'codex', 'acme-api', 'Прогони тесты API и почини то, что упадёт.', { model: 'gpt-5-codex', effort: 'medium' })
    await until('api-tests', 'blocked_permission')

    // docs-site: claude спрашивает человека.
    const question = claudeFixture('question', '00000000-0000-4000-8000-00000000a002', dir('docs-site'), [
      { content: [{ type: 'text', text: 'Перед правкой уточню, как подать установку.' }] },
      { content: [{ type: 'tool_use', id: 'toolu_q1', name: 'AskUserQuestion', input: { questions: [{
        question: 'Как подать установку в «Быстром старте»?', header: 'Установка', multiSelect: false,
        options: [
          { label: 'Одной командой', description: 'npm i -g, остальное — по ссылке ниже' },
          { label: 'Пошагово', description: 'каждый шаг с командой проверки' },
          { label: 'Оба варианта', description: 'короткий путь сверху, подробный под ним' },
        ],
      }] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'Одной командой', is_error: false }] },
      { content: [{ type: 'text', text: 'Сделаю одной командой.' }] },
    ], 'Сделаю одной командой.')
    fake('docs-site', { scenario: 'custom', files: [question], askInline: true })
    await start('install-guide', 'claude', 'docs-site', 'Перепиши «Быстрый старт»: установка должна умещаться в один экран.', { model: 'sonnet', effort: 'medium' })
    assert.ok(await waitFor(async () => ['blocked_question', 'blocked_permission'].includes((await statusOf('install-guide')) ?? ''), 20_000), 'install-guide не спросил')

    // Готовые и непрочитанные.
    await start('changelog', 'codex', 'docs-site', 'Собери CHANGELOG за последний релиз из истории коммитов.', { model: 'gpt-5-codex', effort: 'low' })
    await until('changelog', 'idle')
    fake('mobile-app', { scenario: 'simple' })
    await start('release-notes', 'claude', 'mobile-app', 'Напиши заметки к релизу 2.4 для стора: коротко, без внутренних деталей.', { model: 'haiku', effort: 'low' })
    await until('release-notes', 'idle')

    // Статус провайдеров в шапке — после настройки фальшивого codex (его список моделей читается при проверке).
    await h.win.getByTestId('health-menu').locator('summary').click()
    for (const p of ['claude', 'codex'] as const) {
      const btn = h.win.getByTestId(`provider-status-${p}`)
      if (await btn.isEnabled()) await btn.click()
    }
    assert.ok(await waitFor(async () => /готов/.test((await h.win.getByTestId('provider-status-codex').textContent()) ?? '')
      && /готов/.test((await h.win.getByTestId('provider-status-claude').textContent()) ?? ''), 20_000), 'провайдеры не «готов»')

    await h.win.getByTestId('health-menu').locator('summary').click()

    // Лимиты — последним событием: записи несут прошедшие даты сброса, окно показало бы «—».
    const now = Math.floor(Date.now() / 1000)
    await c.request('events.emit', { kind: 'usage.updated', provider: 'claude', data: { status: 'allowed', windows: {
      five_hour: { utilization: 0.38, resetsAt: now + 7_800 }, seven_day: { utilization: 0.21, resetsAt: now + 3 * 86_400 + 4 * 3600 } } } })
    await c.request('events.emit', { kind: 'usage.updated', provider: 'codex', data: { status: 'allowed', windows: {
      five_hour: { utilization: 0.27, resetsAt: now + 3 * 3600 }, seven_day: { utilization: 0.44, resetsAt: now + 5 * 86_400 } } } })
    assert.ok(await waitFor(async () => ((await h.win.getByTestId('inbox-count').textContent()) ?? '') === '2', 10_000), 'в Inbox не два запроса')
  })

  it('hero: дерево проектов и разговор с ответом в Markdown', async () => {
    if (await h.win.getByTestId('inbox').count()) await h.win.keyboard.press('Meta+I')
    await h.win.getByTestId('inbox').waitFor({ state: 'detached', timeout: 3000 })
    await h.win.locator('[data-testid="agent-row"][data-agent="fix-pagination"]').click()
    const conv = h.win.locator('[data-testid="conversation"][data-agent="fix-pagination"]')
    await conv.waitFor({ timeout: 5000 })
    assert.ok(await waitFor(async () => ((await conv.textContent()) ?? '').includes('курсорную'), 10_000), 'ответ не дошёл')
    // Открытая сессия прочитана: без этого светлый кадр успевал снять синюю точку «непрочитано».
    assert.ok(await waitFor(async () => (await h.win.locator('[data-testid="agent-row"][data-agent="fix-pagination"]').getAttribute('data-unread')) === '0', 5000), 'fix-pagination осталась непрочитанной')
    await shoot('hero')
  })

  it('меню настроек сессии в подвале', async () => {
    await h.win.getByTestId('conv-settings').click()
    await h.win.getByTestId('settings-menu').waitFor({ timeout: 3000 })
    await shoot('settings-menu', async () => { await h.win.getByTestId('settings-menu').waitFor({ timeout: 3000 }) })
    await h.win.keyboard.press('Escape')
  })

  it('Inbox: разрешение codex и вопрос claude', async () => {
    await h.win.keyboard.press('Meta+I')
    const inbox = h.win.getByTestId('inbox')
    await inbox.waitFor({ timeout: 3000 })
    assert.ok(await waitFor(async () => (await inbox.getByTestId('perm-card').count()) === 2, 5000), 'в Inbox не две карточки')
    // Вопрос с выбранным вариантом: видно, как отвечают, и «Отправить ответ» не серая.
    await inbox.locator('[data-question="1"] .question-option').first().click()
    await shoot('inbox')
    await h.win.keyboard.press('Meta+I')
  })

  it('диалог «+ Сессия»', async () => {
    await h.stubPickFolder(dir('mobile-app'))
    await h.win.keyboard.press('Meta+N')
    const dlg = h.win.getByTestId('new-agent-dialog')
    await dlg.waitFor({ timeout: 3000 })
    await dlg.getByTestId('pick-folder').click()
    await waitFor(async () => (await dlg.getByTestId('new-agent-name').inputValue()) !== '', 3000)
    await dlg.getByTestId('new-agent-name').fill('push-settings')
    await dlg.getByRole('group', { name: 'Провайдер' }).getByRole('button', { name: 'claude', exact: true }).click()
    await dlg.getByRole('group', { name: 'Модель' }).getByRole('button', { name: 'opus', exact: true }).click()
    await dlg.getByRole('group', { name: 'Усилие' }).getByRole('button', { name: 'high', exact: true }).click()
    await dlg.getByTestId('new-agent-prompt').fill('Добавь экран настроек уведомлений: три переключателя и ссылка на системные настройки.')
    // Поле реплики в фокусе прокручивает диалог вниз — кадру нужен верх формы (провайдер, папка, подтверждения).
    await dlg.evaluate((el) => {
      (document.activeElement as HTMLElement | null)?.blur()
      for (const n of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) if (n.scrollHeight > n.clientHeight) n.scrollTop = 0
    })
    await shoot('new-session')
    await h.win.keyboard.press('Escape')
  })
})
