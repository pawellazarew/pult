#!/usr/bin/env node
// fake-claude.mjs — фальшивый `claude` для герметичных тестов.
//
// Он НЕ имитирует модель: он проигрывает СЫРЫЕ записи настоящего CLI из test/fixtures/claude/.
// Поэтому тест проверяет переводчик и адаптер против того, что настоящий `claude` действительно
// прислал 21.09.2026, а не против того, как мы его себе представляем.
//
// ЧТО ОН УМЕЕТ:
//   * ЗАПИСАТЬ свой argv, cwd и окружение в файл (PULT_FAKE_ARGV_OUT) — по нему тесты
//     проверяют контракт argv и то, что ни одной ANTHROPIC_*/CLAUDE_* переменной не пришло;
//   * выбрать сценарий из PULT_FAKE_SCENARIO или из МЕТКИ в тексте реплики (`[[scenario]]`);
//   * читать реплики пользователя в формате stream-json со stdin и отыгрывать по одной
//     фикстуре на реплику: закрытие stdin → выход 0, SIGTERM → выход по сигналу;
//   * подменить в записи метку реплики (`command_uuid`, `user_message_uuids`) на `uuid`
//     пришедшей реплики — так, как это делает настоящий CLI (фикстуры 13 и 14);
//   * в сценарии `permission` ПО-НАСТОЯЩЕМУ поднять MCP-сервер, указанный в --mcp-config, и
//     вызвать его инструмент по stdio — так круг «claude → pult mcp-ask → демон → брокер»
//     прогоняется целиком, без единой заглушки на стороне Пульта.
//
// КАК ЕМУ ЗАДАЮТ СЦЕНАРИЙ. Окружение ребёнка Пульт строит по БЕЛОМУ СПИСКУ (инвариант 1), и
// никакая PULT_FAKE_* через него не проходит — это и правильно: тест не имеет права ослаблять
// проверяемый инвариант ради собственного удобства. Поэтому настройки лежат в файле
// `<cwd>/.pult-fake.json`, а cwd у сессии свой:
//   {"scenario": "...", "argvOut": "/путь/argv.jsonl", "speed": 0, "hang": 0, "hangAfterInit": 0}
// Переменные окружения с теми же именами работают тоже — для ручного запуска из оболочки.
//
// Окружение (ручной запуск):
//   PULT_FAKE_SCENARIO   simple|warm|resume|permission|bash-deny|subagent|api-retry|
//                        not-logged-in|account-block|no-conversation|resume-drain|resume-phantom|
//                        local-command|demo-working|demo-edit
//   PULT_FAKE_ARGV_OUT   файл: сюда дописывается JSON {argv, cwd, env, pid}
//   PULT_FAKE_SPEED      делитель пауз (по умолчанию 60; 0 — без пауз)
//   PULT_FAKE_HANG       мс: подождать столько перед первым событием (тест таймаутов)
//   PULT_FAKE_HANG_AFTER_INIT  мс: подождать столько СРАЗУ ПОСЛЕ `system/init`
//   PULT_FAKE_HANG_AFTER_TOOL  мс: подождать столько после строки с `tool_use` (инструмент «работает» — фаза хода, 0.3.5)
//   PULT_FAKE_DEAF       1: НЕ реагировать ни на SIGINT, ни на SIGTERM — так ведёт себя
//                        процесс, застрявший в сисколле. Уходит только по SIGKILL.
//   PULT_FAKE_KEEPALIVE  1: НЕ выходить по закрытию stdin — проверка добивающего сигнала.
//   PULT_FAKE_BG_END_MS  мс: фоновые задачи кончаются сами — столько тишины после хода, и процесс
//                        печатает записанный `background_tasks_changed` с пустым списком.

import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(HERE, '..', 'fixtures', 'claude')

let fileCfg = {}
try { fileCfg = JSON.parse(readFileSync(join(process.cwd(), '.pult-fake.json'), 'utf8')) } catch { fileCfg = {} }

const cfg = {
  scenario: process.env.PULT_FAKE_SCENARIO ?? fileCfg.scenario ?? 'simple',
  argvOut: process.env.PULT_FAKE_ARGV_OUT ?? fileCfg.argvOut ?? null,
  stdinOut: fileCfg.stdinOut ?? null,
  speed: Number(process.env.PULT_FAKE_SPEED ?? fileCfg.speed ?? 60) || 0,
  hang: Number(process.env.PULT_FAKE_HANG ?? fileCfg.hang ?? 0) || 0,
  hangAfterInit: Number(process.env.PULT_FAKE_HANG_AFTER_INIT ?? fileCfg.hangAfterInit ?? 0) || 0,
  hangAfterTool: Number(process.env.PULT_FAKE_HANG_AFTER_TOOL ?? fileCfg.hangAfterTool ?? 0) || 0,
  oneshot: (process.env.PULT_FAKE_ONESHOT ?? String(fileCfg.oneshot ?? '')) === '1',
  deaf: (process.env.PULT_FAKE_DEAF ?? String(fileCfg.deaf ?? '')) === '1',
  keepAlive: (process.env.PULT_FAKE_KEEPALIVE ?? String(fileCfg.keepAlive ?? '')) === '1',
  // О3: спросить разрешение от имени ЭТОГО инструмента (например `mcp__browser__browser_navigate`) вместо
  // записанного в фикстуре — так проверяется, что вызов браузера идёт тем же кругом через Inbox.
  askTool: process.env.PULT_FAKE_ASK_TOOL ?? fileCfg.askTool ?? null,
  // Конец фоновых задач без новой реплики. Без него сценарий `background-live` держит задачи, пока не придёт
  // следующая реплика (ходы 3–4 записи отыгрываются только после неё), и тест «реплика ждёт конца фоновых
  // задач» дожидался лишь страховки `guard` — 60 с, после которых процесс просто выходил.
  bgEndMs: Number(process.env.PULT_FAKE_BG_END_MS ?? fileCfg.bgEndMs ?? 0) || 0,
}
const SPEED = cfg.speed

const argv = process.argv.slice(2)
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }) + '\n')
  process.exit(0)
}

// --- контракт argv: пишем всё, что получили ----------------------------------
if (cfg.argvOut) {
  try {
    appendFileSync(cfg.argvOut, JSON.stringify({
      argv,
      cwd: process.cwd(),
      env: process.env,
      pid: process.pid,
      at: Date.now(),
    }) + '\n')
  } catch { /* тест увидит отсутствие строки */ }
}

const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

/**
 * Каждая фикстура — один или несколько ходов. Ход = все строки до `result` включительно.
 * Сценарий говорит, какие файлы брать и сколько ходов из них отдавать.
 */
// `auto: true` — ходы этой фикстуры идут ПОДРЯД, без новой реплики пользователя. Так ведёт
// себя настоящий `claude` после фонового субагента: второй ход приходит сам (измерено).
const SCENARIOS = {
  simple: { files: ['01-simple-turn'] },
  warm: { files: ['02-warm-two-turns'] },
  resume: { files: ['03-resume-turn1', '03-resume-turn2'] },
  permission: { files: ['04-permission-deny-allow'] },
  'bash-deny': { files: ['05-permission-bash-deny'] },
  subagent: { files: ['06-subagent'], auto: true },
  'api-retry': { files: ['07-api-retry-storm'] },
  'not-logged-in': { files: ['08-not-logged-in'] },
  'account-block': { files: ['09-account-region-block'] },
  // Ответ на `--resume` по несуществующему разговору. Первая строка фикстуры — НЕ JSON,
  // именно так его и печатает настоящий CLI; проигрывается дословно.
  'no-conversation': { files: ['10-resume-no-conversation'] },
  // `--resume` после хода, чей фоновый субагент не дожил до конца процесса (записано 07.10.2026,
  // CLI 2.1.291): ДО ответа на реплику CLI отыгрывает застрявшее уведомление —
  // `system/task_notification` → `init` → `result` с `num_turns: 0` и пустым текстом, — и лишь
  // потом второй `init` и настоящий ответ. Оба «хода» — на ОДНУ реплику, поэтому `auto`.
  'resume-drain': { files: ['11-resume-after-background'], auto: true },
  // Та же запись без `auto`: разгрузка пришла, а ответа на реплику CLI так и не начал.
  'resume-drain-stuck': { files: ['11-resume-after-background'] },
  // Живой процесс с фоновым субагентом (записано 07.10.2026, CLI 2.1.291, без stream_event):
  // ход 1 — запуск субагента и ответ STARTED; ход 2 — реплика PONG, пока субагент работает;
  // ходы 3–4 CLI отыгрывает САМ — итоги фоновых задач. `autoFrom: 2` — с третьего хода без реплики.
  'background-live': { files: ['12-background-live'], autoFrom: 2 },
  // `--resume` после процесса, снятого при ДВУХ живых фоновых субагентах (записано 08.10.2026,
  // CLI 2.1.294, реплика с `uuid`): `task_notification` ×2 → `command_lifecycle queued` → `init`
  // → `result` (`num_turns: 0`, без `user_message_uuids`) → `command_lifecycle started` → `init`
  // → ответ PONG с `user_message_uuids: [метка]` → `completed`. Оба «хода» — на одну реплику.
  'resume-phantom': { files: ['13-resume-phantom-result'], auto: true },
  // Та же запись без `auto`: чужой result пришёл, а ответа на реплику CLI так и не начал.
  'resume-phantom-stuck': { files: ['13-resume-phantom-result'] },
  // ФОРМА ИЗ ЖУРНАЛА (07.10.2026 20:59, сессия liquid_glass; 08.10.2026 12:02, review): ДВА
  // пустых `result` подряд (228 и 5 мс) до ответа. Настоящей записи такой формы нет, поэтому это
  // ПЕРЕИГРОВКА 13: `order` — порядок ходов записи; повтор хода идёт без `task_notification`
  // (уведомление CLI разгружает один раз) — ровно на нём прежняя примета закрывала ход.
  'resume-phantom-twice': { files: ['13-resume-phantom-result'], auto: true, order: [0, 0, 1] },
  // Локальная команда `/cost` (08.10.2026, CLI 2.1.294): НАСТОЯЩИЙ ответ с `num_turns: 0`,
  // помеченный меткой реплики. Ход обязан закрыться по нему.
  'local-command': { files: ['14-local-command'] },
  // ДЕМО окна (Ф2): синтетика из scripts/synth-claude-fixtures.mjs. `askInline` — спросить
  // разрешение на СВОЕЙ строке tool_use, а не до всего хода: окно видит сначала реплику модели,
  // потом запрос. `onDeny` — чем продолжить ход, если человек отказал.
  'demo-working': { files: ['90-demo-working'] },
  'demo-edit': { files: ['91-demo-edit'], askInline: true, onDeny: '91-demo-edit-denied' },
}
// Своя запись из `.pult-fake.json`: `{"scenario": "custom", "files": ["/абс/путь/без/.jsonl"], "askInline": true}`.
// Её пишут кадры README (shell/test/readme) — сцене нужны свои реплики, а не реплики тестовых записей.
if (Array.isArray(fileCfg.files) && fileCfg.files.length) {
  SCENARIOS.custom = { files: fileCfg.files, ...(fileCfg.askInline === true ? { askInline: true } : {}) }
}

function loadTurns(names) {
  const turns = []
  for (const name of names) {
    const base = isAbsolute(name) ? name : join(FIXTURES, name)
    const lines = readFileSync(`${base}.jsonl`, 'utf8').split('\n').filter((l) => l.trim())
    let timing = []
    try { timing = JSON.parse(readFileSync(`${base}.timing.json`, 'utf8')) } catch { timing = [] }
    // Метка реплики при записи: первая `command_uuid` файла. При игре она меняется на метку
    // пришедшей реплики — иначе адаптер справедливо счёл бы записанный ответ чужим.
    const tie = recordedTie(lines)
    let cur = []
    for (let i = 0; i < lines.length; i++) {
      cur.push({ line: lines[i], ms: timing[i] ?? i * 10, tie })
      let type = null
      try { type = JSON.parse(lines[i]).type } catch { type = null }
      if (type === 'result') { turns.push(cur); cur = [] }
    }
    // Хвост без `result` (шторм api_retry) — тоже ход: его обрывают снаружи.
    if (cur.length) turns.push(cur)
  }
  return turns
}

function recordedTie(lines) {
  for (const l of lines) {
    try {
      const e = JSON.parse(l)
      if (e.type === 'command_lifecycle' && typeof e.command_uuid === 'string') return e.command_uuid
    } catch { /* не JSON */ }
  }
  return null
}

/** Записанная метка реплики → метка пришедшей. Нет одной из них — строка как есть. */
const retie = (line, tie, uuid) => (tie && uuid ? line.split(tie).join(uuid) : line)

/** Метка в реплике важнее переменной: один тест может гонять несколько сценариев подряд. */
function scenarioFromText(text) {
  const m = /\[\[([a-z-]+)\]\]/.exec(String(text || ''))
  return m && SCENARIOS[m[1]] ? m[1] : null
}

let scenario = cfg.scenario
let turns = null
let turnIndex = 0
// Ходы записи, уже сыгранные в этом сценарии: повтор (`order`) идёт без `task_notification`.
const played = new Set()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (line) => process.stdout.write(line + '\n')

/** Та ли это строка, что заводит разговор на диске. Не-JSON строки (фикстура 10) — нет. */
function isInit(line) {
  try {
    const e = JSON.parse(line)
    return e.type === 'system' && e.subtype === 'init'
  } catch { return false }
}

// --- настоящий MCP-сервер для сценария разрешений ----------------------------
// Читаем ТОТ ЖЕ файл --mcp-config, который написал адаптер, спавним оттуда команду и
// разговариваем с ней по JSON-RPC построчно — как это делает настоящий `claude`.
function startMcp() {
  const cfgPath = flag('--mcp-config')
  if (!cfgPath) return null
  let cfg
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch { return null }
  // Заглушка разрешений — сервер `pult`; рядом могут лежать браузер и свои серверы (О3).
  const entry = (cfg.mcpServers || {}).pult ?? Object.values(cfg.mcpServers || {})[0]
  if (!entry) return null
  const child = spawn(entry.command, entry.args || [], {
    env: { ...process.env, ...(entry.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let buf = ''
  let id = 0
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const waiter = pending.get(msg.id)
      if (waiter) { pending.delete(msg.id); waiter(msg) }
    }
  })
  child.on('error', () => { /* тест увидит отказ */ })
  const call = (method, params) => new Promise((res) => {
    const myId = ++id
    pending.set(myId, res)
    try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n') } catch { res({ error: { message: 'stdin closed' } }) }
  })
  const notify = (method) => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') } catch { /* мёртв */ } }
  return { child, call, notify, close: () => { try { child.stdin.end() } catch { /* закрыт */ } try { child.kill('SIGTERM') } catch { /* мёртв */ } } }
}

let mcp = null

/**
 * Просит у MCP-сервера решение по инструменту. Возвращает разобранное решение или null,
 * если сервера нет или он ответил мусором.
 */
async function askPermission(toolName, input, toolUseId) {
  if (!mcp) return null
  const r = await mcp.call('tools/call', {
    name: 'ask',
    arguments: { tool_name: cfg.askTool ?? toolName, input, tool_use_id: toolUseId },
    _meta: { 'claudecode/toolUseId': toolUseId },
  })
  const text = r?.result?.content?.[0]?.text
  if (typeof text !== 'string') return null
  try { return JSON.parse(text) } catch { return null }
}

/** Из записанного хода достаём первый вызов инструмента — по нему и спрашиваем разрешение. */
function firstToolUse(turn) {
  for (const { line } of turn) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'assistant') continue
    for (const b of e.message?.content || []) {
      if (b.type === 'tool_use') return { name: b.name, input: b.input || {}, id: b.id }
    }
  }
  return null
}

function toolUseOf(line) {
  let e
  try { e = JSON.parse(line) } catch { return null }
  if (e.type !== 'assistant') return null
  for (const b of e.message?.content || []) {
    if (b.type === 'tool_use') return { name: b.name, input: b.input || {}, id: b.id }
  }
  return null
}

async function playTurn(uuid = null) {
  const def = SCENARIOS[scenario] || SCENARIOS.simple
  if (!turns) turns = loadTurns(def.files)
  const idx = def.order ? def.order[turnIndex] : Math.min(turnIndex, turns.length - 1)
  const total = def.order ? def.order.length : turns.length
  const repeat = played.has(idx)
  played.add(idx)
  const turn = idx === undefined ? undefined : turns[idx]?.filter(({ line }) => !(repeat && /"subtype":"task_notification"/.test(line)))
  turnIndex++
  if (!turn) return

  if (cfg.hang > 0) await sleep(cfg.hang)

  // Разрешения: спрашиваем НАСТОЯЩИЙ MCP-сервер до того, как отдать записанный поток.
  // Отказ или разрешение на форму потока не влияют — фикстура уже содержит оба исхода, —
  // но круг «запрос → брокер → человек → ответ» прогоняется целиком.
  if (mcp && !def.askInline) {
    const tool = firstToolUse(turn)
    if (tool) {
      const decision = await askPermission(tool.name, tool.input, tool.id)
      if (decision) out(JSON.stringify({ type: 'system', subtype: 'status', status: `permission:${decision.behavior}`, session_id: flag('--session-id') || flag('--resume') || 'fake' }))
    }
  }

  let prev = turn[0].ms
  for (const { line: raw, ms, tie } of turn) {
    const gap = SPEED > 0 ? Math.max(0, Math.round((ms - prev) / SPEED)) : 0
    prev = ms
    if (gap > 0) await sleep(gap)
    const line = retie(raw, tie, uuid)
    out(line)
    // `askInline`: вопрос уходит сразу после строки с tool_use — как у настоящего CLI, который
    // спрашивает, когда модель уже сказала, что собирается делать.
    if (def.askInline && mcp) {
      const tool = toolUseOf(line)
      if (tool) {
        const decision = await askPermission(tool.name, tool.input, tool.id)
        if (decision) out(JSON.stringify({ type: 'system', subtype: 'status', status: `permission:${decision.behavior}`, session_id: flag('--session-id') || flag('--resume') || 'fake' }))
        if (decision && decision.behavior !== 'allow' && def.onDeny) {
          for (const t of loadTurns([def.onDeny])) for (const r of t) out(r.line)
          return
        }
      }
    }
    // `hangAfterInit` — зеркало `hang`: замереть не ДО потока, а сразу ПОСЛЕ `system/init`.
    // Этим ловится разница, из-за которой ломался `--resume`: стоп до init разговора не
    // оставляет, стоп после init — оставляет.
    if (cfg.hangAfterInit > 0 && isInit(line)) await sleep(cfg.hangAfterInit)
    if (cfg.hangAfterTool > 0 && toolUseOf(line)) await sleep(cfg.hangAfterTool)
  }
  // Ход-уведомление: приходит сам, без реплики пользователя.
  if ((def.auto || (def.autoFrom !== undefined && turnIndex >= def.autoFrom)) && turnIndex < total) await playTurn(uuid)
}

/** Записанная строка «фоновых задач не осталось» текущего сценария: последний пустой `background_tasks_changed`. */
function recordedBgEnd() {
  const def = SCENARIOS[scenario] || SCENARIOS.simple
  let found = null
  for (const name of def.files) {
    for (const l of readFileSync(isAbsolute(name) ? `${name}.jsonl` : join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n')) {
      try {
        const e = JSON.parse(l)
        if (e.type === 'system' && e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks) && e.tasks.length === 0) found = l
      } catch { /* не JSON */ }
    }
  }
  return found
}

let bgEndTimer = null
const cancelBgEnd = () => { if (bgEndTimer) { clearTimeout(bgEndTimer); bgEndTimer = null } }
const scheduleBgEnd = () => {
  if (!(cfg.bgEndMs > 0)) return
  cancelBgEnd()
  bgEndTimer = setTimeout(() => {
    bgEndTimer = null
    const line = recordedBgEnd()
    if (line) out(line)
  }, cfg.bgEndMs)
}

// --- цикл по stdin ------------------------------------------------------------
let buf = ''
let queue = Promise.resolve()
let ended = false

// Глухой процесс: слушатель есть, а выхода нет — ровно так сигнал «проглатывается». SIGKILL
// перехватить нельзя ни в одном процессе, поэтому лестница адаптера доводит дело до конца.
if (cfg.deaf) {
  process.on('SIGTERM', () => {})
  process.on('SIGINT', () => {})
  // Без этого глухой процесс выйдет сам, как только stdin закроется и таймеров не останется.
  setInterval(() => {}, 1000)
} else {
  process.on('SIGTERM', () => process.exit(143))
  process.on('SIGINT', () => process.exit(130))
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (cfg.stdinOut) appendFileSync(cfg.stdinOut, JSON.stringify(msg) + '\n')
    const text = msg?.message?.content?.[0]?.text ?? ''
    const marked = scenarioFromText(text)
    if (marked && marked !== scenario) { scenario = marked; turns = null; turnIndex = 0; played.clear() }
    if ((scenario === 'permission' || SCENARIOS[scenario]?.askInline) && !mcp) {
      mcp = startMcp()
      if (mcp) {
        queue = queue.then(async () => {
          await mcp.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0.0.1' } })
          mcp.notify('notifications/initialized')
          await mcp.call('tools/list', {})
        })
      }
    }
    const uuid = typeof msg?.uuid === 'string' ? msg.uuid : null
    cancelBgEnd()
    queue = queue.then(() => playTurn(uuid)).then(scheduleBgEnd)
  }
})

process.stdin.on('end', () => {
  ended = true
  cancelBgEnd()
  // `keepAlive` — процесс, который закрытие stdin не убивает: его обязан добить сигнал.
  if (cfg.keepAlive) { setInterval(() => {}, 1000); return }
  queue = queue.then(async () => {
    if (mcp) mcp.close()
    // Даём stdout дописаться: process.exit() обрезал бы последний `result`.
    await new Promise((r) => process.stdout.write('', r))
    process.exit(0)
  })
})

// Страховка от вечного висения в тесте, который забыл закрыть stdin.
const guard = setTimeout(() => { if (!ended) process.exit(0) }, 60_000)
guard.unref()
// Глухой и живучий режимы сами держат цикл событий: без ЖЁСТКОГО предела такой процесс
// пережил бы и тест, и демона. Этот таймер намеренно не `unref`-нут.
if (cfg.deaf || cfg.keepAlive) setTimeout(() => process.exit(0), 60_000)

// Одноразовый запуск без stdin: PULT_FAKE_ONESHOT=1 проигрывает один ход сразу.
if (cfg.oneshot) {
  queue = queue.then(() => playTurn())
}
