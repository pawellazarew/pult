// Адаптер Codex на ФАЛЬШИВОМ app-server, который проигрывает записанные потоки.
// Ни одного настоящего хода, ни одного обращения в сеть: страж и сверка схемы инъецируются.
//
// ГЛАВНОЕ ОТЛИЧИЕ ОТ ТЕСТОВ CLAUDE: процесс здесь ОДИН НА ВСЕХ, поэтому почти каждый тест
// заодно проверяет, что соседняя сессия не пострадала.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createCodexAdapter } from '../dist/adapters/codex/adapter.js'
import { checkCodexSchema, hashSchemaDir, CODEX_SCHEMA_SHA256 } from '../dist/adapters/codex/schema.js'
import type { ProviderAdapter } from '../dist/adapters/types.js'
import { defaultConfig } from '../dist/core/config.js'
import type { PultConfig } from '../dist/core/config.js'
import type { EventDraft } from '../dist/core/events.js'
import { createLogger } from '../dist/core/log.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { NetCheck } from '../dist/env/net.js'
import { clearNetCache } from '../dist/env/net.js'
import { createBroker } from '../dist/perm/broker.js'
import type { PermBroker } from '../dist/perm/broker.js'
import { FAKE_CODEX, sleep, waitFor } from './helpers.js'

/** Все pid фальшивых серверов, которые видел этот файл: после прогона все обязаны быть мертвы. */
const seenPids: number[] = []

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

const okCheck = (over: Partial<NetCheck> = {}): NetCheck => ({
  provider: 'codex', mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true,
  reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1,
  checkedAt: '2026-09-21T10:00:00.000Z', cached: false, ...over,
})

interface Rig {
  adapter: ProviderAdapter
  drafts: EventDraft[]
  broker: PermBroker
  cwd: string
  /** Сообщения, которые адаптер прислал фальшивому серверу. */
  client(): Array<{ msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown } }>
  /** Методы клиента по порядку. */
  methods(): string[]
  /** Сколько раз фальшивый сервер стартовал: один процесс на всех — значит обычно 1. */
  boots(): number
  /** Окружение и argv первого запуска — по ним видно, что пришло ребёнку. */
  boot(): { argv: string[]; env: Record<string, string>; cwd: string }
  pids(): number[]
  /** Переписать настройку фальшивого сервера (действует со следующего запуска процесса). */
  retune(cfg: Record<string, unknown>): void
  remove(): void
}

function rig(opts: {
  scenario?: string
  config?: Partial<PultConfig>
  net?: () => Promise<NetCheck>
  fake?: Record<string, unknown>
  bin?: string
  permTimeoutMs?: number
  controlTimeoutMs?: number
} = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'pt-cx-'))
  const paths = layout(join(dir, 'h'))
  ensureLayout(paths)
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const logOut = join(dir, 'server.jsonl')
  const fakeCfg = { scenario: opts.scenario ?? 'simple', speed: 0, logOut, ...(opts.fake ?? {}) }
  // Настройка ищется в cwd ОБЩЕГО процесса, а это PULT_HOME: через окружение она не пройдёт —
  // оно строится по белому списку (инвариант 1).
  writeFileSync(join(paths.home, '.pult-fake-codex.json'), JSON.stringify(fakeCfg))
  const drafts: EventDraft[] = []
  const broker = createBroker({
    emit: (d) => { drafts.push(d) },
    ...(opts.permTimeoutMs !== undefined ? { timeoutMs: opts.permTimeoutMs } : {}),
  })
  const adapter = createCodexAdapter({
    paths,
    config: { ...defaultConfig(), ...(opts.config ?? {}) },
    logger: createLogger(paths.logFile),
    bin: opts.bin ?? FAKE_CODEX,
    emit: (d) => { drafts.push(d) },
    askPermission: (req) => broker.request(req),
    cancelPermissions: (sessionId, reason) => {
      let n = 0
      for (const p of broker.list(sessionId)) {
        if (broker.resolve(p.id, { behavior: 'deny', message: reason }, 'provider_gone')) n++
      }
      return n
    },
    netCheck: opts.net ?? (async () => okCheck()),
    schemaCheck: () => ({ status: 'ok', expected: 'x', actual: 'x', files: 310, detail: 'тест' }),
    ...(opts.controlTimeoutMs !== undefined ? { controlTimeoutMs: opts.controlTimeoutMs } : {}),
  })
  const read = (): Array<Record<string, unknown>> => (existsSync(logOut)
    ? readFileSync(logOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [])
  return {
    adapter,
    drafts,
    broker,
    cwd,
    client: () => read().filter((r) => r['ev'] === 'client') as never,
    methods: () => read().filter((r) => r['ev'] === 'client').map((r) => String(((r['msg'] as { method?: string }) ?? {}).method ?? '')),
    boots: () => read().filter((r) => r['ev'] === 'boot').length,
    boot: () => (read().find((r) => r['ev'] === 'boot') ?? { argv: [], env: {}, cwd: '' }) as never,
    pids: () => [...new Set(read().map((r) => Number(r['pid'])))],
    retune: (cfg) => { writeFileSync(join(paths.home, '.pult-fake-codex.json'), JSON.stringify({ speed: 0, logOut, ...cfg })) },
    remove: () => {
      for (const pid of read().filter((r) => r['ev'] === 'boot').map((r) => Number(r['pid']))) seenPids.push(pid)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const spec = (r: Rig, over: Record<string, unknown> = {}) => ({
  name: 'w', cwd: r.cwd, model: 'gpt-6-astra', effort: 'low', mode: 'turn' as const, broker: true, ...over,
})

const statuses = (r: Rig, session = 'w'): string[] => r.drafts
  .filter((d) => d.kind === 'status.changed' && d.sessionId === session)
  .map((d) => String((d.data as { status?: unknown }).status))

const texts = (r: Rig, session = 'w'): string[] => r.drafts
  .filter((d) => d.kind === 'message.done' && d.sessionId === session)
  .map((d) => String((d.data as { text: string }).text))

after(() => {
  const survivors = seenPids.filter((pid) => alive(pid))
  assert.deepEqual(survivors, [], `фальшивые app-server пережили тесты: ${survivors.join(', ')}`)
})

describe('адаптер codex: один процесс на всех', () => {
  it('две сессии идут параллельно в ОДНОМ процессе; спавн ровно один', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, { name: 'a' }))
      await r.adapter.startSession(spec(r, { name: 'b' }))
      const [ta, tb] = await Promise.all([r.adapter.send('a', 'привет'), r.adapter.send('b', 'привет')])
      const [oa, ob] = await Promise.all([ta.done, tb.done])
      assert.equal(oa.ok, true, oa.message)
      assert.equal(ob.ok, true, ob.message)
      assert.equal(oa.text, 'OK')
      assert.equal(ob.text, 'OK')
      assert.equal(r.boots(), 1, 'app-server обязан быть ОДИН на обе сессии')
      // Тред у каждой сессии свой: два thread/start, два turn/start. Лог пишет ФЕЙК в СВОЁМ
      // процессе; ждём, пока обе записи долетят, а не читаем сразу после done().
      assert.ok(await waitFor(() => r.methods().filter((m) => m === 'thread/start').length >= 2, 5000))
      assert.equal(r.methods().filter((m) => m === 'thread/start').length, 2)
      assert.ok(await waitFor(() => r.methods().filter((m) => m === 'turn/start').length >= 2, 5000))
      assert.equal(r.methods().filter((m) => m === 'turn/start').length, 2)
      // И события не перепутались.
      assert.deepEqual(texts(r, 'a'), ['OK'])
      assert.deepEqual(texts(r, 'b'), ['OK'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('обычный ход: session.started по turn/started, текст из item/completed, расход в журнале', async () => {
    const r = rig()
    try {
      const started = await r.adapter.startSession(spec(r))
      // `providerSessionId` на старте ПУСТ: тред ещё не заведён, а выдуманный id ничего не
      // возобновляет (измерено пробой В3).
      assert.equal(started.providerSessionId, '')
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, true)
      assert.equal(outcome.text, 'OK')

      const start = r.drafts.find((d) => d.kind === 'session.started')
      assert.ok(start, 'session.started обязан прийти по первому turn/started')
      const threadId = (start.data as { providerSessionId: string }).providerSessionId
      assert.match(threadId, /^01a0c000-thread/)
      // Сразу после session.started рабочий статус подтверждается заново: иначе в журнале
      // была бы секунда «idle» посреди идущего хода.
      assert.deepEqual(statuses(r), ['working', 'working', 'idle'])

      const usage = r.drafts.filter((d) => d.kind === 'usage.updated')
      assert.ok(usage.some((d) => (d.data as { source: string }).source === 'result'))
      const result = usage.find((d) => (d.data as { source: string }).source === 'result')
      assert.equal((result?.data as { usage: { input_tokens: number } }).usage.input_tokens, 18632)

      // Контекстное окно своего треда: last.totalTokens и modelContextWindow записи B1.
      const ctx = r.drafts.filter((d) => d.kind === 'context.updated').map((d) => d.data)
      assert.deepEqual(ctx, [{ used: 18637, window: 258400, model: 'gpt-6-astra' }])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('модель в context.updated — из ответа thread/start, даже если на старте её не задали', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, { model: undefined }))
      assert.equal((await (await r.adapter.send('w', 'привет')).done).ok, true)
      // Фальшивка, как и настоящий сервер, называет модель треда в ответе (поле обязательное).
      const ctx = r.drafts.filter((d) => d.kind === 'context.updated').map((d) => (d.data as { model: unknown }).model)
      assert.deepEqual(ctx, ['gpt-6-astra'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ИНВАРИАНТ 1: ни одной ANTHROPIC_*/CLAUDE_*/OPENAI_*/CODEX_* переменной родителя у app-server', async () => {
    const r = rig()
    const saved = { ...process.env }
    process.env['ANTHROPIC_BASE_URL'] = 'https://подменённый.example.com'
    process.env['OPENAI_API_KEY'] = 'sk-' + 'x'.repeat(40)
    // CODEX_HOME особенно важен: он увёл бы общий процесс в чужой каталог сессий.
    process.env['CODEX_HOME'] = '/чужой/.codex'
    try {
      await r.adapter.startSession(spec(r))
      await (await r.adapter.send('w', 'привет')).done
      process.env = saved
      const env = r.boot().env
      const leaked = Object.keys(env).filter((k) => /^(ANTHROPIC|CLAUDE|OPENAI|CODEX)/i.test(k))
      assert.deepEqual(leaked, [], `утекли: ${leaked.join(', ')}`)
      assert.ok(env['PATH'] && env['HOME'])
    } finally { process.env = saved; await r.adapter.shutdown(); r.remove() }
  })

  it('промпт уходит в ТЕЛЕ turn/start, а не в argv процесса', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      await (await r.adapter.send('w', 'СЕКРЕТНАЯ РЕПЛИКА про деньги')).done
      assert.deepEqual(r.boot().argv, ['app-server'])
      const turn = r.client().find((c) => c.msg.method === 'turn/start')
      const input = (turn?.msg.params as { input: Array<{ text: string }> }).input
      assert.equal(input[0]?.text, 'СЕКРЕТНАЯ РЕПЛИКА про деньги')
      assert.equal((turn?.msg.params as { effort: string }).effort, 'low')
      assert.equal((turn?.msg.params as { model: string }).model, 'gpt-6-astra')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('адаптер codex: разрешения', () => {
  it('КРУГ ЦЕЛИКОМ через настоящий брокер: отказ доезжает до сервера как decline', async () => {
    const r = rig({ scenario: 'permission-decline' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'правь файл')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 10_000), 'вопрос обязан попасть в Inbox')
      const pending = r.broker.list('w')[0]
      assert.equal(pending?.toolName, 'commandExecution')
      assert.match(String((pending?.input as { command: string }).command), /echo hi > x\.txt/)
      assert.deepEqual((pending?.input as { availableDecisions: string[] }).availableDecisions, ['accept', 'cancel'])
      r.broker.resolve(pending!.id, { behavior: 'deny', message: 'нельзя' })
      const outcome = await turn.done
      assert.equal(outcome.ok, true, 'отказ НЕ проваливает ход — измерено спайком B2')
      const answer = r.client().find((c) => c.msg.result !== undefined && c.msg.id !== undefined)
      assert.deepEqual(answer?.msg.result, { decision: 'decline' })
      assert.ok(r.drafts.some((d) => d.kind === 'permission.requested'))
      assert.ok(r.drafts.some((d) => d.kind === 'permission.resolved'))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('разрешение доезжает как accept — и только потому, что сервер его предложил', async () => {
    const r = rig({ scenario: 'permission-accept' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'правь файл')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 10_000))
      r.broker.resolve(r.broker.list('w')[0]!.id, { behavior: 'allow' })
      assert.equal((await turn.done).ok, true)
      const answer = r.client().find((c) => c.msg.result !== undefined && c.msg.id !== undefined)
      assert.deepEqual(answer?.msg.result, { decision: 'accept' })
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('МОЛЧАНИЕ = ОТКАЗ: истёк таймаут брокера — на сервер уходит decline', async () => {
    const r = rig({ scenario: 'permission-decline', permTimeoutMs: 200 })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'правь файл')
      const outcome = await turn.done
      assert.equal(outcome.ok, true)
      const answer = r.client().find((c) => c.msg.result !== undefined && c.msg.id !== undefined)
      assert.deepEqual(answer?.msg.result, { decision: 'decline' })
      const resolved = r.drafts.find((d) => d.kind === 'permission.resolved')
      assert.equal((resolved?.data as { by: string }).by, 'timeout')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ОСТАНОВКА ДЕМОНА = ОТКАЗ: brokers.shutdown отвечает за всех ожидающих', async () => {
    const r = rig({ scenario: 'permission-decline' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'правь файл')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 10_000))
      assert.equal(r.broker.shutdown('демон останавливается'), 1)
      assert.equal((await turn.done).ok, true)
      const answer = r.client().find((c) => c.msg.result !== undefined && c.msg.id !== undefined)
      assert.deepEqual(answer?.msg.result, { decision: 'decline' })
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ПАДЕНИЕ ПРОЦЕССА = ОТКАЗ: вопрос уходит из Inbox, а не висит от покойника', async () => {
    const r = rig({ scenario: 'permission-decline' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'правь файл')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 10_000))
      // Убиваем общий процесс ровно в тот момент, когда человек ещё думает.
      for (const pid of r.pids()) { try { process.kill(pid, 'SIGKILL') } catch { /* уже мёртв */ } }
      const outcome = await turn.done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'provider_unavailable')
      assert.ok(await waitFor(() => r.broker.list('w').length === 0, 5_000), 'вопрос обязан был уйти из Inbox')
      const resolved = r.drafts.filter((d) => d.kind === 'permission.resolved')
      assert.equal((resolved[0]?.data as { decision: string }).decision, 'deny')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('сессия без хозяина разрешений получает тред с approvalPolicy never', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, { broker: false }))
      await (await r.adapter.send('w', 'привет')).done
      const start = r.client().find((c) => c.msg.method === 'thread/start')
      assert.equal((start?.msg.params as { approvalPolicy: string }).approvalPolicy, 'never')
      assert.equal((start?.msg.params as { sandbox: string }).sandbox, 'workspace-write')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('адаптер codex: стоп посреди хода', () => {
  it('ход закрывается как interrupted, адаптер молчит о статусе, соседняя сессия цела', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, { name: 'a' }))
      await r.adapter.startSession(spec(r, { name: 'b' }))
      // `hang` — ход, который сам не кончится: стоп заведомо приходит ПОСРЕДИ работы.
      const hung = await r.adapter.send('a', 'думай долго [[hang]]')
      const ok = await r.adapter.send('b', 'привет')
      await r.adapter.interrupt('a')
      const outcome = await hung.done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'interrupted', 'не internal: ход сняли стопом')
      // Статус по стопу пишет менеджер: отсюда не должно уйти НИ ОДНОГО `interrupted`.
      assert.deepEqual(statuses(r, 'a').filter((s) => s === 'interrupted'), [])
      // Соседняя сессия в том же процессе доехала.
      assert.equal((await ok.done).ok, true)
      assert.equal(r.boots(), 1, 'стоп одной сессии НЕ гасит общий процесс')
      // `turn/interrupt` уходит фейку ПО ПРОВОДУ; лог пишет его собственный процесс — ждём
      // строку, а не читаем лог в тот же тик, что done().
      assert.ok(await waitFor(() => r.methods().includes('turn/interrupt'), 5000))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ход прервал СЕРВЕР (Turn.error у interrupted, codex 0.162): причина сервера в тексте, а не «агент остановлен»', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет [[server-interrupt]]')).done
      assert.equal(outcome.errorCode, 'interrupted')
      assert.match(outcome.message ?? '', /прерван: сервер перегружен, ход снят/)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('стоп ДО начала хода (страж сети ещё думает) не рождает ни треда, ни хода', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const r = rig({ net: async () => { await gate; return okCheck() } })
    try {
      await r.adapter.startSession(spec(r))
      const turn = r.adapter.send('w', 'привет')
      await r.adapter.interrupt('w')
      release()
      const outcome = await (await turn).done
      assert.equal(outcome.errorCode, 'interrupted')
      assert.equal(r.boots(), 0, 'процесс не должен был подниматься вовсе')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('close() снимает ход, отписывает тред и НЕ гасит общий процесс', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, { name: 'a' }))
      await r.adapter.startSession(spec(r, { name: 'b' }))
      await (await r.adapter.send('a', 'привет')).done
      const alive2 = await r.adapter.send('b', 'привет')
      await r.adapter.close('a')
      // Тот же эффект: `thread/unsubscribe` логирует фейк в СВОЁМ процессе.
      assert.ok(await waitFor(() => r.methods().includes('thread/unsubscribe'), 5000))
      assert.equal((await alive2.done).ok, true, 'соседняя сессия обязана доехать')
      assert.equal(r.boots(), 1)
      const ended = r.drafts.filter((d) => d.sessionId === 'a' && d.kind === 'status.changed')
      assert.equal(String((ended[ended.length - 1]?.data as { status: string }).status), 'done')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ход, переживший close(), не пишет НИ ОДНОГО события в журнал', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      void r.adapter.send('w', 'думай долго [[hang]]')
      assert.ok(await waitFor(() => r.methods().includes('turn/start'), 10_000))
      await r.adapter.close('w')
      const after = r.drafts.length
      await r.adapter.startSession(spec(r))
      await sleep(500)
      assert.deepEqual(r.drafts.slice(after), [], 'после close() записано лишнее')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('адаптер codex: падение и перезапуск app-server', () => {
  it('падение посреди хода: ход падает честно, следующий ход поднимает процесс и ВОЗОБНОВЛЯЕТ тред', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      // Первый ход доезжает — тред подтверждён и возобновляем.
      assert.equal((await (await r.adapter.send('w', 'привет')).done).ok, true)
      const threadId = (r.drafts.find((d) => d.kind === 'session.started')?.data as { providerSessionId: string }).providerSessionId

      const crashing = await r.adapter.send('w', 'упади [[crash]]')
      const outcome = await crashing.done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'provider_unavailable')
      assert.match(String(outcome.message), /app-server codex вышел/)

      const again = await (await r.adapter.send('w', 'ещё раз')).done
      assert.equal(again.ok, true, again.message)
      assert.equal(r.boots(), 2, 'процесс поднимается заново, и ровно один раз')
      const resume = r.client().find((c) => c.msg.method === 'thread/resume')
      assert.ok(resume, 'после рестарта тред обязан возобновляться, а не заводиться заново')
      assert.equal((resume.msg.params as { threadId: string }).threadId, threadId)
      assert.equal((resume.msg.params as { excludeTurns: boolean }).excludeTurns, true)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('SIGKILL процесса (а не мягкий выход) даёт тот же честный исход', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'умри [[crash-kill]]')).done
      assert.equal(outcome.errorCode, 'provider_unavailable')
      assert.match(String(outcome.message), /signal=SIGKILL/)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ПОТОЛОК ПЕРЕЗАПУСКОВ: после четвёртого падения за минуту провайдер остановлен, reset снимает', async () => {
    const r = rig({ scenario: 'crash' })
    try {
      await r.adapter.startSession(spec(r))
      let lastCode = ''
      for (let i = 0; i < 5; i++) {
        const o = await (await r.adapter.send('w', `падай ${i}`)).done
        lastCode = String(o.errorCode)
        if (r.adapter.blocked().blocked) break
      }
      assert.equal(r.adapter.blocked().blocked, true, `провайдер обязан был остановиться, последний код ${lastCode}`)
      assert.match(String(r.adapter.blocked().reason), /перезапускался/)
      assert.ok(r.drafts.some((d) => d.kind === 'provider.blocked'))
      // Пока остановлен — ни нового хода, ни новой сессии.
      assert.equal((await (await r.adapter.send('w', 'ещё')).done).errorCode, 'provider_unavailable')
      await assert.rejects(() => r.adapter.startSession(spec(r, { name: 'z' })))
      r.adapter.reset()
      assert.equal(r.adapter.blocked().blocked, false)
      r.retune({ scenario: 'simple' })
      assert.equal((await (await r.adapter.send('w', 'после сброса')).done).ok, true)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('СПАВН НЕ УДАЛСЯ: ход падает сам, адаптер жив', async () => {
    const r = rig({ bin: join(tmpdir(), 'нет-такого-бинаря-pult-codex') })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'provider_unavailable')
      assert.equal(statuses(r).pop(), 'failed')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('МЕДЛЕННОЕ РУКОПОЖАТИЕ: ход падает по таймауту, процесс не остаётся сиротой', async () => {
    const r = rig({ fake: { handshakeDelayMs: 3000 }, controlTimeoutMs: 250 })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, false)
      assert.match(String(outcome.message), /не ответил на initialize/)
      assert.ok(await waitFor(() => r.pids().every((pid) => !alive(pid)), 8000), 'молчащий процесс обязан быть снят')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('МУСОР И ПЕРЕРОСТОК на stdout: ход всё равно доезжает', async () => {
    const r = rig({ fake: { garbage: true } })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, true, outcome.message)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('уведомление по НЕЗНАКОМОМУ треду выбрасывается и ничего не ломает', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет [[unknown-thread]]')).done
      assert.equal(outcome.ok, true)
      assert.deepEqual(texts(r), ['OK'], 'текст чужого треда в сессию не попал')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('shutdown() гасит общий процесс лестницей, даже если он глух к SIGTERM', async () => {
    const r = rig({ fake: { deaf: true } })
    try {
      await r.adapter.startSession(spec(r))
      void r.adapter.send('w', 'привет [[hang]]')
      assert.ok(await waitFor(() => r.boots() === 1, 10_000))
      const pid = r.pids()[0] as number
      assert.ok(alive(pid))
      await r.adapter.shutdown()
      assert.ok(!alive(pid), `глухой app-server ${pid} пережил shutdown`)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('адаптер codex: страж сети, лимиты, самолечение', () => {
  it('страж страны выхода запрещает ход ДО спавна процесса', async () => {
    const r = rig({ net: async () => okCheck({ ok: false, reason: 'blocked_country', loc: 'RU', path: 'none' }) })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.errorCode, 'blocked_network')
      assert.equal(r.boots(), 0, 'процесс не должен был подниматься')
      assert.ok(r.drafts.some((d) => d.kind === 'net.blocked'))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('0.3.6: смена правила стража (clearNetCache → новое поколение) — следующий ход проверяется без простоя', async () => {
    let calls = 0
    let ok = true
    const r = rig({ net: async () => { calls++; return ok ? okCheck() : okCheck({ ok: false, reason: 'not_allowed_country', loc: 'FI', path: 'none' }) } })
    try {
      await r.adapter.startSession(spec(r))
      assert.equal((await (await r.adapter.send('w', 'раз')).done).ok, true)
      assert.equal((await (await r.adapter.send('w', 'два')).done).ok, true)
      assert.equal(calls, 1, 'без смены правила второй ход в пределах минуты стража не проходит')
      ok = false
      clearNetCache()
      const refused = await (await r.adapter.send('w', 'три')).done
      assert.deepEqual([refused.ok, refused.errorCode, calls], [false, 'blocked_network', 2])
      ok = true
      assert.equal((await (await r.adapter.send('w', 'четыре')).done).ok, true)
      assert.equal(calls, 3, 'после отказа поколение не запомнено — снова проверка')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('профиль сети прокси уезжает ребёнку как ALL_PROXY и HTTPS_PROXY', async () => {
    const r = rig({ net: async () => okCheck({ path: 'proxy', proxy: 'socks5h://127.0.0.1:3128' }) })
    try {
      await r.adapter.startSession(spec(r))
      await (await r.adapter.send('w', 'привет')).done
      const env = r.boot().env
      assert.equal(env['ALL_PROXY'], 'socks5h://127.0.0.1:3128')
      assert.equal(env['HTTPS_PROXY'], 'socks5h://127.0.0.1:3128')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ШТОРМ error/willRetry: ход прерван на третьем повторе, процесс жив', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет [[retry-storm]]')).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'blocked_network')
      assert.match(String(outcome.message), /3 подряд error\/willRetry/)
      const blocked = r.drafts.find((d) => d.kind === 'net.blocked')
      assert.equal((blocked?.data as { reason: string }).reason, 'error_retry_storm')
      // Ход снят МЕТОДОМ, а не смертью процесса. `turn/interrupt` здесь — `void
      // client.request(...)`, НЕ дожидаемый (adapter.ts, ветка `case 'retry'`): `ctx.finish()`
      // идёт следом синхронно, и done() может резолвиться раньше, чем фейк прочитал трубу
      // и записал строку в свой лог. Поэтому ждём строку явно, а не читаем лог сразу.
      assert.ok(await waitFor(() => r.methods().includes('turn/interrupt'), 5000))
      assert.equal(r.boots(), 1)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ЛИМИТ: статус limited, событие limit.hit, повторов нет', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет [[usage-limit]]')).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'limited')
      assert.match(String(outcome.message), /hit your usage limit/)
      const hit = r.drafts.find((d) => d.kind === 'limit.hit')
      assert.ok(hit)
      assert.equal((hit.data as { reason: string }).reason, 'usageLimitExceeded')
      assert.ok(statuses(r).includes('limited'))
      assert.ok(await waitFor(() => r.methods().filter((m) => m === 'turn/start').length >= 1, 5000))
      assert.equal(r.methods().filter((m) => m === 'turn/start').length, 1, 'лимит не повторяют')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('РАЗРЕЖЕННЫЕ лимиты сливаются: пропавшее поле не стирает, а явный null — стирает', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      await (await r.adapter.send('w', 'привет [[limits]]')).done
      interface Usage {
        status: string
        windows: {
          five_hour: { utilization: number; windowDurationMins: number } | null
          seven_day: { utilization: number; windowDurationMins: number } | null
        }
        codex: { planType: string | null }
      }
      const updates = r.drafts
        .filter((d) => d.kind === 'usage.updated' && (d.data as { source: string }).source === 'rate_limit_event')
        .map((d) => d.data as unknown as Usage)
      assert.ok(updates.length >= 5, `ожидались все пять обновлений, пришло ${updates.length}`)

      // #2 принесло только primary — недельное окно обязано было уцелеть целиком.
      assert.equal(updates[1]?.windows.five_hour?.utilization, 0.36)
      assert.equal(updates[1]?.windows.seven_day?.utilization, 0.41)
      // #3 принесло `secondary` БЕЗ длительности окна — она тоже обязана уцелеть, иначе
      // окно перестало бы раскладываться на «пять часов» и «неделю».
      assert.equal(updates[2]?.windows.seven_day?.utilization, 0.43)
      assert.equal(updates[2]?.windows.seven_day?.windowDurationMins, 10080)
      assert.equal(updates[2]?.windows.five_hour?.utilization, 0.36)
      assert.equal(updates[2]?.codex.planType, 'plus', 'planType не приходил — значит остаётся')
      // #4 — лимит достигнут: статус и событие про аккаунт.
      assert.equal(updates[3]?.status, 'limited')
      assert.equal(r.drafts.filter((d) => d.kind === 'limit.hit').length, 1, 'limit.hit — один раз на переход')
      // #5 — `rateLimitReachedType: null` СНИМАЕТ лимит: иначе сессия висела бы `limited`
      // до перезапуска демона.
      assert.equal(updates[4]?.status, 'allowed')
      assert.equal(updates[4]?.windows.five_hour?.utilization, 0.05)
      // #6 — ИЗМЕРЕННЫЙ 21.09.2026 снимок, где ОБА окна `null` (так сервер отвечает при
      // исчерпанном лимите). Он не имеет права обнулить известные проценты.
      assert.equal(updates[5]?.windows.five_hour?.utilization, 0.05)
      assert.equal(updates[5]?.windows.seven_day?.utilization, 0.43)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('САМОЛЕЧЕНИЕ: «no rollout found» на resume заводит новый тред в ТОМ ЖЕ ходе', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      assert.equal((await (await r.adapter.send('w', 'привет')).done).ok, true)
      const first = (r.drafts.find((d) => d.kind === 'session.started')?.data as { providerSessionId: string }).providerSessionId

      // Процесс умирает, а после перезапуска сервер «не помнит» тред — ровно как настоящий,
      // если хода на нём не случилось.
      r.retune({ scenario: 'simple', resumeFails: true })
      for (const pid of r.pids()) { try { process.kill(pid, 'SIGKILL') } catch { /* мёртв */ } }
      await waitFor(() => false, 200)

      const outcome = await (await r.adapter.send('w', 'ещё раз')).done
      assert.equal(outcome.ok, true, outcome.message)
      const starts = r.client().filter((c) => c.msg.method === 'thread/start')
      assert.equal(starts.length, 2, 'после отказа resume тред обязан заводиться заново')
      const second = r.drafts.filter((d) => d.kind === 'session.started')
      assert.equal(second.length, 2, 'новый тред обязан доехать до реестра')
      assert.notEqual((second[1]?.data as { providerSessionId: string }).providerSessionId, first)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('адаптер codex: resume и незнакомые сессии', () => {
  it('resume идемпотентен, ничего не спавнит и переживает рестарт демона', async () => {
    const r = rig()
    try {
      await r.adapter.resume('w', {
        name: 'w', provider: 'codex', cwd: r.cwd, model: 'gpt-6-astra', effort: 'low', mode: 'turn',
        providerSessionId: '01a0c000-thread-из-реестра',
        createdAt: '2026-09-21T10:00:00.000Z', lastStatus: 'cold', lastEventId: 0,
      })
      await r.adapter.resume('w', {
        name: 'w', provider: 'codex', cwd: r.cwd, mode: 'turn',
        createdAt: '2026-09-21T10:00:00.000Z', lastStatus: 'cold', lastEventId: 0,
      })
      assert.equal(r.boots(), 0, 'resume не имеет права ничего спавнить')
      // Записанный тред возобновляется, а не заводится заново: реестр хранит только
      // подтверждённый id.
      r.retune({ scenario: 'simple', resumeFails: true })
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, true)
      const resume = r.client().find((c) => c.msg.method === 'thread/resume')
      assert.equal((resume?.msg.params as { threadId: string }).threadId, '01a0c000-thread-из-реестра')
      assert.equal((resume?.msg.params as { cwd: string }).cwd, r.cwd)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('close() и interrupt() НЕЗНАКОМОЙ сессии проходят молча', async () => {
    const r = rig()
    try {
      await r.adapter.close('никакой')
      await r.adapter.interrupt('никакой')
      assert.equal(r.boots(), 0)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('второй ход по занятой сессии отвергается, а не смешивает потоки', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r))
      const first = await r.adapter.send('w', 'думай [[hang]]')
      const second = await (await r.adapter.send('w', 'и ещё')).done
      assert.equal(second.errorCode, 'invalid_params')
      await r.adapter.interrupt('w')
      await first.done
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('сверка схемы протокола codex', () => {
  it('совпадение слепка — ok; расхождение — предупреждение, а не отказ работать', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pt-schema-'))
    const mirror = join(home, 'зеркало')
    try {
      const workDir = join(home, 'run', 'codex-schema')
      const fakeRun = async (_f: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> => {
        const out = args[args.indexOf('--out') + 1] as string
        mkdirSync(join(out, 'v2'), { recursive: true })
        writeFileSync(join(out, 'ClientRequest.json'), '{"a":1}')
        writeFileSync(join(out, 'v2', 'Turn.json'), '{"b":2}')
        return { status: 0, stdout: '', stderr: '' }
      }
      const drift = await checkCodexSchema({ bin: '/фальшивый/codex', workDir, run: fakeRun })
      assert.equal(drift.status, 'drift')
      assert.equal(drift.files, 2)
      assert.match(drift.detail, /РАЗОШЛАСЬ/)
      // Временный каталог сносится всегда: после проверки в `run/` ничего не остаётся.
      assert.deepEqual(readdirSync(workDir), [])

      // Тот же слепок, но ожидаемый — совпадение.
      mkdirSync(join(mirror, 'v2'), { recursive: true })
      writeFileSync(join(mirror, 'ClientRequest.json'), '{"a":1}')
      writeFileSync(join(mirror, 'v2', 'Turn.json'), '{"b":2}')
      assert.equal(hashSchemaDir(mirror).sha256, drift.actual)
      assert.equal(hashSchemaDir(mirror).files, 2)

      const unavailable = await checkCodexSchema({
        bin: '/фальшивый/codex', workDir, run: async () => ({ status: 1, stdout: '', stderr: 'нет такой команды' }),
      })
      assert.equal(unavailable.status, 'unavailable')
      assert.match(unavailable.detail, /кодом 1/)

      const empty = await checkCodexSchema({ bin: '/фальшивый/codex', workDir, run: async () => ({ status: 0, stdout: '', stderr: '' }) })
      assert.equal(empty.status, 'unavailable')

      assert.equal((await checkCodexSchema({ bin: null, workDir })).status, 'unavailable')
      assert.match(CODEX_SCHEMA_SHA256, /^[0-9a-f]{64}$/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('ИНВАРИАНТ 8: сверка не пишет НИ ОДНОГО файла вне PULT_HOME, даже если TMPDIR подсунут', async () => {
    // Первая версия делала `mkdtempSync(join(tmpdir(), …))` — единственный `tmpdir()` в `src/`.
    const home = mkdtempSync(join(tmpdir(), 'pt-schema-home-'))
    const watched = mkdtempSync(join(tmpdir(), 'pt-schema-watch-'))
    const savedTmp = process.env['TMPDIR']
    process.env['TMPDIR'] = watched
    try {
      const workDir = join(home, 'run', 'codex-schema')
      let sawOut = ''
      await checkCodexSchema({
        bin: '/фальшивый/codex',
        workDir,
        run: async (_f, args) => {
          sawOut = args[args.indexOf('--out') + 1] as string
          mkdirSync(sawOut, { recursive: true })
          writeFileSync(join(sawOut, 'ClientRequest.json'), '{"a":1}')
          return { status: 0, stdout: '', stderr: '' }
        },
      })
      assert.ok(sawOut.startsWith(home), `схема писалась мимо PULT_HOME: ${sawOut}`)
      assert.deepEqual(readdirSync(watched), [], 'в TMPDIR не должно появиться ничего')
    } finally {
      if (savedTmp === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = savedTmp
      rmSync(home, { recursive: true, force: true })
      rmSync(watched, { recursive: true, force: true })
    }
  })

  it('ЗАВИСШИЙ codex добивается по таймауту: проверка возвращается, ребёнок мёртв', async () => {
    // Настоящий `spawn` (инъекции запуска НЕТ) — проверяется именно боевой запускатель.
    const home = mkdtempSync(join(tmpdir(), 'pt-schema-hang-'))
    try {
      const hang = join(home, 'вечный-codex.sh')
      const marker = join(home, 'pid.txt')
      // `exec`: pid в метке — сам `sleep`, и SIGKILL снимает именно его, без осиротевшего внука.
      writeFileSync(hang, `#!/bin/sh\necho $$ > ${marker}\nexec sleep 30\n`, { mode: 0o755 })
      // ГОТОВНОСТЬ — СОБЫТИЕ, А НЕ ВРЕМЯ. Раньше таймер добивания (3 с) взводился в момент `spawn`
      // и гонялся с запуском `sh`: под нагрузкой полного прогона SIGKILL прилетал раньше первой
      // строки скрипта, и тест падал «скрипт так и не запустился» (3 из 3 первых прогонов гейта).
      // Теперь боевой таймер взводится швом `armAfter` только после того, как скрипт записал
      // свой pid, — то есть добивается заведомо запущенный и висящий процесс. Бюджет ожидания
      // запуска (60 с) — только потолок: на свободной машине метка появляется за миллисекунды.
      // Готовность — метка с ЦЕЛОЙ строкой pid (`echo` дописал перевод строки), а не просто файл.
      const pidLine = (): string => { try { return readFileSync(marker, 'utf8') } catch { return '' } }
      const started = waitFor(() => /^\d+\n$/.test(pidLine()), 60_000)
      const running = checkCodexSchema({ bin: hang, workDir: join(home, 'run', 'codex-schema'), timeoutMs: 1000, armAfter: started })
      assert.ok(await started, 'скрипт так и не запустился — тест бессмысленен')
      const armedAt = Date.now()
      const check = await running
      const ms = Date.now() - armedAt
      assert.equal(check.status, 'unavailable')
      assert.match(check.detail, /добита по таймауту/)
      assert.ok(ms >= 900, `добит через ${ms} мс — раньше таймаута 1000 мс`)
      assert.ok(ms < 15_000, `проверка держалась ${ms} мс вместо ~1000`)
      const pid = Number(pidLine().trim())
      assert.ok(await waitFor(() => !alive(pid), 15_000), `зависший процесс ${pid} пережил таймаут`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
