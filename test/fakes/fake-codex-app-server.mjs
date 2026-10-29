#!/usr/bin/env node
// fake-codex-app-server.mjs — фальшивый `codex app-server` для герметичных тестов.
//
// Он НЕ имитирует модель: он проигрывает СЫРЫЕ записи настоящего app-server из
// test/fixtures/codex/ (спайк 20.09.2026 и проба В3 21.09.2026). Поэтому тест проверяет
// демультиплексор, переводчик и адаптер против того, что сервер действительно прислал.
//
// ОДИН ПРОЦЕСС НА ВСЕ ТРЕДЫ — как в бою: сценарий выбирается НА ХОД по метке `[[имя]]` в
// реплике, поэтому две сессии в одном процессе могут играть разные сценарии одновременно.
//
// НАСТРОЙКА лежит в файле `<cwd>/.pult-fake-codex.json`, а cwd общего процесса — это
// PULT_HOME. Через окружение настройку не передать: оно строится по белому списку
// (инвариант 1), и тест не имеет права ослаблять проверяемый инвариант ради удобства.
//   {
//     "scenario": "simple",      сценарий по умолчанию
//     "speed": 0,                делитель пауз записи (0 — без пауз)
//     "logOut": "/путь/log.jsonl", сюда дописывается КАЖДОЕ сообщение клиента + строка boot
//     "handshakeDelayMs": 0,     задержка ответа на initialize (медленное рукопожатие)
//     "deaf": false,             не реагировать на SIGTERM (только SIGKILL)
//     "resumeFails": false,      thread/resume всегда отвечает «no rollout found»
//     "startFails": false,       thread/start отвечает ошибкой
//     "limited": false,          account/rateLimits/read отдаёт снимок ИСЧЕРПАННОГО лимита
//     "garbage": false,          перед первым ответом выплюнуть мусор и строку-переросток
//     "scenarioByDir": {}        сценарий по имени папки треда (последняя часть cwd)
//   }
//
// СЦЕНАРИИ ХОДА (метка в реплике важнее настройки):
//   simple · permission-decline · permission-accept · subagent · retry-storm · usage-limit
//   resume-turn · slow · hang · crash · crash-kill · unknown-thread · limits

import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(HERE, '..', 'fixtures', 'codex')

let cfg = {}
try { cfg = JSON.parse(readFileSync(join(process.cwd(), '.pult-fake-codex.json'), 'utf8')) } catch { cfg = {} }
const SPEED = Number(cfg.speed ?? 0) || 0
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  process.stderr.write(cfg.loggedOut ? 'Not logged in\n' : 'Logged in using ChatGPT\n')
  process.exit(cfg.loggedOut ? 1 : 0)
}
const LOG = cfg.logOut ?? null

const log = (o) => { if (LOG) { try { appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + '\n') } catch { /* тест увидит пропуск */ } } }
log({ ev: 'boot', argv: process.argv.slice(2), cwd: process.cwd(), env: process.env })

const out = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCENARIOS = {
  simple: ['01-simple-turn'],
  'permission-decline': ['02-permission-decline'],
  'permission-accept': ['03-permission-accept'],
  subagent: ['04-subagent'],
  'retry-storm': ['05-error-retry-storm'],
  'resume-turn': ['06-resume-turn'],
  'usage-limit': ['08-usage-limit-error'],
  // Разреженные лимиты, а следом обычный ход: иначе ходу нечем закончиться.
  limits: ['10-rate-limits-sparse', '01-simple-turn'],
  slow: ['01-simple-turn'],
  hang: null,
  crash: ['01-simple-turn'],
  'crash-kill': ['01-simple-turn'],
  'unknown-thread': ['01-simple-turn'],
  // Фикстуры нет: ход сразу закрывается сервером как interrupted с `Turn.error` (playTurn).
  'server-interrupt': [],
  // Свои записи из настройки: `"scenarios": {"имя": ["/абс/путь/без/.jsonl"]}` — так кадры README
  // (shell/test/readme) ставят сцене свою команду, не трогая тестовые записи.
  ...(cfg.scenarios && typeof cfg.scenarios === 'object' ? cfg.scenarios : {}),
}

const cache = new Map()
function fixture(names) {
  const key = names.join('+')
  if (cache.has(key)) return cache.get(key)
  const msgs = []
  for (const name of names) {
    const file = isAbsolute(name) ? name : join(FIXTURES, name)
    const lines = readFileSync(`${file}.jsonl`, 'utf8').split('\n').filter((l) => l.trim())
    let timing = []
    try { timing = JSON.parse(readFileSync(`${file}.timing.json`, 'utf8')) } catch { timing = [] }
    const base = msgs.length ? (msgs[msgs.length - 1].ms + 5) : 0
    for (let i = 0; i < lines.length; i++) {
      msgs.push({ raw: lines[i], msg: JSON.parse(lines[i]), ms: base + (timing[i] ?? i * 5) })
    }
  }
  // Треды записи: первый встреченный — «свой», остальные (ребёнок субагента) получат
  // производные имена, чтобы два параллельных хода не столкнулись.
  const threads = []
  const turns = []
  for (const { msg } of msgs) {
    const p = msg.params ?? {}
    if (typeof p.threadId === 'string' && !threads.includes(p.threadId)) threads.push(p.threadId)
    if (typeof p.turnId === 'string' && !turns.includes(p.turnId)) turns.push(p.turnId)
    if (p.turn && typeof p.turn.id === 'string' && !turns.includes(p.turn.id)) turns.push(p.turn.id)
  }
  const entry = { msgs, threads, turns }
  cache.set(key, entry)
  return entry
}

let seq = 0
const uid = (prefix) => `${prefix}-${process.pid}-${++seq}`

const threads = new Map()   // threadId -> { cwd, subscribed, turn }
const FORK_ID = '05291e2f-16e8-4903-8312-8b8a67274299'
const pendingServer = new Map() // id запроса к клиенту -> resolve

let turnCounter = 0

function replyOk(id, result) { out({ jsonrpc: '2.0', id, result }) }
function replyErr(id, code, message) { out({ jsonrpc: '2.0', id, error: { code, message } }) }

/** Проигрывает фикстуру хода, подставляя живые threadId/turnId. */
async function playTurn(scenario, threadId, turnId, state) {
  if (scenario === 'server-interrupt') {
    // С 0.162 (схема 14.10.2026) прерванный СЕРВЕРОМ ход несёт `Turn.error`.
    out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'interrupted', error: { message: 'сервер перегружен, ход снят', codexErrorInfo: 'serverOverloaded' }, startedAt: 1, completedAt: 2, durationMs: 1 } } })
    return
  }
  // ВАЖНО `in`, а не `??`: у сценария `hang` значение именно `null`, и `??` подменил бы его
  // обычным ходом — ход, который обязан висеть, тихо завершался бы успехом.
  const names = scenario in SCENARIOS ? SCENARIOS[scenario] : SCENARIOS.simple
  if (names === null) {
    // Ход, который сам не кончится: его снимут `turn/interrupt` или смерть процесса.
    await new Promise(() => {})
    return
  }
  const { msgs, threads: recThreads, turns: recTurns } = fixture(names)
  const subst = new Map()
  recThreads.forEach((t, i) => subst.set(t, i === 0 ? threadId : `${threadId}-c${i}`))
  recTurns.forEach((t, i) => subst.set(t, i === 0 ? turnId : `${turnId}-t${i}`))

  if (scenario === 'unknown-thread') {
    out({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: `${threadId}-ЧУЖОЙ`, turnId, item: { type: 'agentMessage', id: 'msg-ghost', text: 'я из чужого треда', phase: 'final_answer' } } })
  }

  let prev = msgs.length ? msgs[0].ms : 0
  for (const { raw, ms } of msgs) {
    if (state.cancelled) return
    const gap = SPEED > 0 ? Math.max(0, Math.round((ms - prev) / SPEED)) : 0
    prev = ms
    if (gap > 0) await sleep(gap)
    if (scenario === 'slow') await sleep(40)
    let body = raw
    for (const [from, to] of subst) body = body.split(from).join(to)
    const msg = JSON.parse(body)

    if (msg.id !== undefined && msg.method !== undefined) {
      // Запрос сервера к клиенту (разрешение): ждём ответа, как настоящий сервер.
      const id = 10_000 + ++seq
      msg.id = id
      out(msg)
      const answer = await new Promise((res) => { pendingServer.set(id, res) })
      log({ ev: 'approval_answer', id, answer })
      out({ jsonrpc: '2.0', method: 'serverRequest/resolved', params: { threadId, requestId: id } })
      continue
    }
    if (scenario === 'crash' && msg.method === 'item/completed') {
      log({ ev: 'crash', threadId })
      process.exit(1)
    }
    if (scenario === 'crash-kill' && msg.method === 'item/completed') {
      log({ ev: 'crash-kill', threadId })
      process.kill(process.pid, 'SIGKILL')
      return
    }
    out(msg)
  }
}

async function onRequest(id, method, params) {
  switch (method) {
    case 'model/list': {
      replyOk(id, { data: cfg.models ?? [
        { id: 'test-fast', model: 'test-fast', displayName: 'Test Fast', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
        { id: 'test-deep', model: 'test-deep', displayName: 'Test Deep', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] },
      ], nextCursor: null })
      return
    }
    case 'thread/list': {
      replyOk(id, { data: cfg.externalThreads ?? [], nextCursor: null })
      return
    }
    case 'thread/read': {
      const thread = (cfg.externalThreads ?? []).find((t) => t.id === params.threadId)
      if (!thread) { replyErr(id, -32600, 'thread not found'); return }
      replyOk(id, { thread })
      return
    }
    case 'thread/items/list': {
      replyOk(id, { data: [...(cfg.externalItems?.[params.threadId] ?? [])].reverse(), nextCursor: null })
      return
    }
    case 'thread/fork': {
      const source = (cfg.externalThreads ?? []).find((t) => t.id === params.threadId)
      if (!source) { replyErr(id, -32600, 'thread not found'); return }
      replyOk(id, { thread: { ...source, id: FORK_ID } })
      return
    }
    case 'initialize': {
      if (cfg.handshakeDelayMs) await sleep(Number(cfg.handshakeDelayMs))
      if (cfg.garbage) {
        process.stdout.write('это не JSON, а мусор из середины протокола\n')
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'noise', params: { blob: 'x'.repeat(17 * 1024 * 1024) } }) + '\n')
      }
      replyOk(id, {
        userAgent: `pult-fake/0.155.0-alpha.9.2 (fake; ${process.pid})`,
        codexHome: '/фальшивый/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      })
      return
    }
    case 'thread/start': {
      if (cfg.startFails) { replyErr(id, -32600, 'фальшивый app-server: thread/start запрещён настройкой'); return }
      const threadId = uid('01a0c000-thread')
      threads.set(threadId, { cwd: params.cwd, subscribed: true, turn: null })
      out({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: threadId, cwd: params.cwd, status: { type: 'idle' }, turns: [] } } })
      replyOk(id, {
        thread: { id: threadId, cwd: params.cwd, path: `/фальшивый/.codex/sessions/rollout-${threadId}.jsonl`, status: { type: 'idle' }, turns: [] },
        model: params.model ?? 'gpt-6-astra',
        modelProvider: 'openai',
        cwd: params.cwd,
        approvalPolicy: params.approvalPolicy ?? 'never',
        sandbox: { type: 'workspaceWrite', networkAccess: false },
        reasoningEffort: 'low',
      })
      return
    }
    case 'thread/resume': {
      // Чужие треды и копии от `thread/fork` у настоящего сервера лежат на диске (rollout), и их
      // возобновляет ЛЮБОЙ процесс app-server — измерено лидом 06.10.2026: копия, сделанная
      // одним процессом, возобновилась другим. Фальшивка держит треды в памяти, поэтому такие id
      // берёт из настройки.
      const onDisk = (cfg.externalThreads ?? []).some((t) => t.id === params.threadId) || params.threadId === FORK_ID
      if (onDisk && !threads.has(params.threadId)) threads.set(params.threadId, { cwd: params.cwd, subscribed: false, turn: null })
      const known = threads.has(params.threadId)
      if (cfg.resumeFails || !known) {
        // ИЗМЕРЕНО 21.09.2026: дословно так отвечает настоящий сервер на тред без хода.
        replyErr(id, -32600, `no rollout found for thread id ${params.threadId}`)
        return
      }
      const t = threads.get(params.threadId)
      t.subscribed = true
      replyOk(id, {
        thread: { id: params.threadId, cwd: params.cwd, status: { type: 'idle' }, turns: [] },
        model: params.model ?? 'gpt-6-astra',
        cwd: params.cwd,
        initialTurnsPage: { items: [] },
      })
      return
    }
    case 'turn/start': {
      const t = threads.get(params.threadId)
      if (!t) { replyErr(id, -32600, `unknown thread ${params.threadId}`); return }
      if (t.turn) { replyErr(id, -32600, 'activeTurnNotSteerable'); return }
      const text = Array.isArray(params.input) ? params.input.map((i) => i.text ?? '').join(' ') : ''
      const marked = /\[\[([a-z-]+)\]\]/.exec(text)
      // `scenarioByDir` — сценарий по имени папки треда: окну (Ф2) нужны разные сценарии у
      // разных агентов без меток в тексте реплики (метка видна на скриншоте).
      const byDir = cfg.scenarioByDir && typeof t.cwd === 'string' ? cfg.scenarioByDir[t.cwd.split('/').filter(Boolean).pop()] : undefined
      const scenario = marked && SCENARIOS[marked[1]] !== undefined ? marked[1] : (byDir ?? cfg.scenario ?? 'simple')
      const turnId = uid('01a0c000-turn')
      const state = { cancelled: false }
      t.turn = { id: turnId, state, scenario }
      turnCounter++
      replyOk(id, { turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } })
      t.capacityCalls = (t.capacityCalls ?? 0) + 1
      if (t.capacityCalls <= (cfg.capacityFailures ?? 0)) {
        const error = { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'other' }
        out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId, status: 'inProgress' } } })
        if (cfg.capacityAfterTool) out({ jsonrpc: '2.0', method: 'item/started', params: { threadId: params.threadId, turnId,
          item: { id: 'cmd-before-capacity', type: 'commandExecution', command: 'side-effect', status: 'inProgress' } } })
        out({ jsonrpc: '2.0', method: 'error', params: { threadId: params.threadId, turnId, error, willRetry: false } })
        out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'failed', error } } })
        t.turn = null
        return
      }
      void playTurn(scenario, params.threadId, turnId, state).then(() => {
        if (t.turn && t.turn.id === turnId) t.turn = null
      })
      return
    }
    case 'turn/interrupt': {
      const t = threads.get(params.threadId)
      if (!t || !t.turn || t.turn.id !== params.turnId) {
        // ИЗМЕРЕНО 21.09.2026 на настоящем сервере.
        replyErr(id, -32600, 'no active turn to interrupt')
        return
      }
      t.turn.state.cancelled = true
      const turnId = t.turn.id
      t.turn = null
      replyOk(id, {})
      out({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: params.threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'interrupted', error: null, startedAt: 1, completedAt: 2, durationMs: 1 } },
      })
      return
    }
    case 'thread/unsubscribe': {
      const t = threads.get(params.threadId)
      if (!t) { replyOk(id, { status: 'notLoaded' }); return }
      const status = t.subscribed ? 'unsubscribed' : 'notSubscribed'
      t.subscribed = false
      replyOk(id, { status })
      return
    }
    case 'account/rateLimits/read': {
      if (cfg.limited) {
        replyOk(id, JSON.parse(readFileSync(join(FIXTURES, '07-rate-limits-read-limited.json'), 'utf8')))
        return
      }
      replyOk(id, {
        ordinaryUsageAllowed: true,
        rateLimits: {
          limitId: 'codex', limitName: null, normalModelSlug: null,
          primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1789942749 },
          secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1789991059 },
          credits: { hasCredits: false, unlimited: false, balance: '0' },
          individualLimit: null, spendControlReached: false, planType: 'plus', rateLimitReachedType: null,
        },
        accountId: '<redacted>',
        rateLimitUpsell: null,
      })
      return
    }
    default:
      replyErr(id, -32601, `фальшивый app-server не умеет ${method}`)
  }
}

// --- разбор stdin --------------------------------------------------------------
let buf = ''
let queue = Promise.resolve()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    log({ ev: 'client', msg })
    if (msg.id !== undefined && msg.method === undefined) {
      // Ответ на наш запрос (решение по разрешению).
      const waiter = pendingServer.get(msg.id)
      if (waiter) { pendingServer.delete(msg.id); waiter(msg.result ?? msg.error ?? null) }
      continue
    }
    if (msg.method === 'initialized') continue
    if (msg.id === undefined) continue
    queue = queue.then(() => onRequest(msg.id, msg.method, msg.params ?? {}))
  }
})

// ИЗМЕРЕНО: настоящий app-server выходит с кодом 0 и по SIGTERM, и по закрытию stdin.
process.stdin.on('end', () => { if (!cfg.deaf) process.exit(0) })
if (cfg.deaf) {
  process.on('SIGTERM', () => {})
  process.on('SIGINT', () => {})
  setInterval(() => {}, 1000)
} else {
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
}
// Жёсткая страховка: фальшивый сервер не имеет права пережить тест.
setTimeout(() => process.exit(0), 120_000)
