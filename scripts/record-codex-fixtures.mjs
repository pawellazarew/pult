#!/usr/bin/env node
// record-codex-fixtures.mjs — запись СЫРОГО протокола `codex app-server` в test/fixtures/codex/.
//
//   npm run build && node scripts/record-codex-fixtures.mjs [--probe] [--schema] [сценарий …]
//
// Сценарии с ходами модели: simple permission-decline permission-accept subagent resume-turn
// (без аргументов — все пять; это пять крошечных ходов на усилии low).
//
//   --probe   БЕЗ ЕДИНОГО ХОДА МОДЕЛИ: рукопожатие, `thread/start`, `thread/resume` треда без
//             ходов, `turn/interrupt` без хода, `thread/unsubscribe`, `account/rateLimits/read`.
//             Пишет `07-rate-limits-read-limited.json` и `09-handshake-and-control.jsonl`.
//             Этим же режимом снята текущая пара фикстур 21.09.2026.
//   --schema  печатает слепок схемы протокола (его значение живёт в
//             src/adapters/codex/schema.ts) и версию CLI. Тоже без ходов.
//
// В CI не запускается НИКОГДА: нужен залогиненный `codex`, сеть и квота. Запускает лид руками.
//
// ПРАВИЛА ЗАПИСИ:
//   * страж страны выхода — ТОТ ЖЕ код, что у адаптера (`dist/env/net.js`): страна из
//     списка-стража или неизвестна → ни один ход не запускается, выход с кодом 4;
//   * cwd ходов — одноразовый git-репозиторий под os.tmpdir(), скрипт сам его создаёт и сносит;
//   * записывается ДОСЛОВНО всё, что пришло по проводу, кроме редакции (`redactString` плюс
//     `accountId` и id кредитов сброса); каждая редакция печатается в отчёте;
//   * за собой прибирается и в `~/.codex/sessions`: удаляются ТОЛЬКО те `rollout-*.jsonl`,
//     чьё имя содержит `threadId`, заведённый этим прогоном;
//   * `account/rateLimitResetCredit/consume` не вызывается ни при каких условиях.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig } from '../dist/core/config.js'
import { redactString } from '../dist/core/log.js'
import { buildChildEnv } from '../dist/env/allowlist.js'
import { checkNetwork, netLine } from '../dist/env/net.js'
import { checkCodexSchema } from '../dist/adapters/codex/schema.js'
import { MUTED_NOTIFICATIONS } from '../dist/adapters/codex/adapter.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, 'test', 'fixtures', 'codex')
const CODEX_BIN = process.env.PULT_CODEX_BIN || join(homedir(), '.local', 'bin', 'codex')

const args = process.argv.slice(2)
const PROBE_ONLY = args.includes('--probe')
const SCHEMA_ONLY = args.includes('--schema')
const wanted = args.filter((a) => !a.startsWith('--'))

const report = []
const say = (line) => { console.log(line); report.push(line) }

let redactions = 0
function clean(text) {
  const before = text
  let out = redactString(text)
  // Идентификаторы аккаунта и кредитов сброса — не секреты в смысле токена, но и в репозитории
  // им делать нечего.
  out = out.replace(/"accountId":\s*"[^"]*"/g, '"accountId": "<redacted>"')
  out = out.replace(/"id":\s*"RateLimitResetCredit_[^"]*"/g, '"id": "<redacted>"')
  // Домашняя папка записавшего — в путях сессий, плагинов и хуков; в репозитории — заглушка.
  out = out.split(homedir()).join('/Users/you')
  if (out !== before) redactions++
  return out
}

// --- крошечный клиент app-server ------------------------------------------------
class Server {
  constructor(cwd, recorder) {
    this.recorder = recorder
    this.pending = new Map()
    this.id = 0
    this.exited = null
    this.proc = spawn(CODEX_BIN, ['app-server'], {
      cwd,
      env: buildChildEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.on('exit', (code, sig) => { this.exited = { code, sig } })
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (!line.trim()) return
      this.recorder?.(line)
      let m
      try { m = JSON.parse(line) } catch { return }
      if (m.id !== undefined && m.method === undefined) {
        const p = this.pending.get(m.id)
        if (p) { this.pending.delete(m.id); p(m) }
      }
      if (m.id !== undefined && m.method !== undefined && this.onServerRequest) this.onServerRequest(m)
    })
    createInterface({ input: this.proc.stderr }).on('line', (l) => say(`    stderr: ${clean(l).slice(0, 160)}`))
  }
  send(obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n') }
  request(method, params, timeoutMs = 240_000) {
    const id = ++this.id
    const p = new Promise((res) => {
      this.pending.set(id, res)
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res({ error: { message: `timeout ${method}` } }) } }, timeoutMs).unref?.()
    })
    this.send({ jsonrpc: '2.0', id, method, params })
    return p
  }
  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }) }
  async init() {
    const r = await this.request('initialize', {
      clientInfo: { name: 'pult-recorder', version: '0.1.0' },
      capabilities: { optOutNotificationMethods: [...MUTED_NOTIFICATIONS] },
    }, 60_000)
    this.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    return r
  }
  async close() {
    try { this.proc.stdin.end() } catch { /* закрыт */ }
    await new Promise((res) => { const t = setTimeout(res, 3000); this.proc.on('exit', () => { clearTimeout(t); res() }) })
    try { this.proc.kill('SIGKILL') } catch { /* мёртв */ }
  }
}

class Fixture {
  constructor(name) { this.name = name; this.lines = []; this.timing = []; this.t0 = Date.now() }
  add(line) { this.lines.push(clean(line)); this.timing.push(Date.now() - this.t0) }
  write() {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, `${this.name}.jsonl`), this.lines.join('\n') + '\n')
    writeFileSync(join(OUT, `${this.name}.timing.json`), JSON.stringify(this.timing))
    say(`  записано ${this.name}.jsonl: ${this.lines.length} строк`)
  }
}

// --- уборка за собой ------------------------------------------------------------
const createdThreads = []
function sweepRollouts() {
  const base = join(homedir(), '.codex', 'sessions')
  if (!existsSync(base) || createdThreads.length === 0) return
  let removed = 0
  const walk = (dir) => {
    for (const entry of readdirSafe(dir)) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) { walk(p); continue }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      if (createdThreads.some((id) => entry.name.includes(id))) { unlinkSync(p); removed++ }
    }
  }
  walk(base)
  say(`уборка: удалено ${removed} записей разговоров, заведённых этим прогоном`)
}
function readdirSafe(dir) {
  try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

function sandbox() {
  const work = mkdtempSync(join(tmpdir(), 'pult-codex-rec-'))
  writeFileSync(join(work, 'README.md'), 'pult codex fixtures sandbox\n')
  writeFileSync(join(work, 'note.txt'), 'before\n')
  const env = buildChildEnv(process.env, { extra: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work, env })
  execFileSync('git', ['-c', 'user.name=pult', '-c', 'user.email=pult@localhost', 'add', '-A'], { cwd: work, env })
  execFileSync('git', ['-c', 'user.name=pult', '-c', 'user.email=pult@localhost', 'commit', '-qm', 'fixtures'], { cwd: work, env })
  return work
}

async function guard() {
  const cfg = defaultConfig()
  const check = await checkNetwork('codex', cfg.network.codex, cfg.guard, { fresh: true })
  say(`страж: ${netLine(check)}`)
  if (!check.ok) {
    console.error(`ОТКАЗ (страж сети): ${check.reason}. Ни один ход не сделан.`)
    process.exit(4)
  }
}

// --- режим --schema --------------------------------------------------------------
if (SCHEMA_ONLY) {
  const version = execFileSync(CODEX_BIN, ['--version'], { encoding: 'utf8', env: buildChildEnv(process.env) }).trim()
  const check = checkCodexSchema({ bin: CODEX_BIN })
  say(`CLI: ${version}`)
  say(`слепок: ${check.actual ?? '—'} (${check.files ?? '—'} файлов), состояние ${check.status}`)
  say(`ожидался: ${check.expected}`)
  process.exit(0)
}

// --- режим --probe: ни одного хода модели ------------------------------------------
async function probe() {
  const work = mkdtempSync(join(tmpdir(), 'pult-codex-probe-'))
  const fx = new Fixture('09-handshake-and-control')
  const client = []
  const srv = new Server(work, (line) => fx.add(line))
  const sendAndRecord = async (method, params) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: srv.id + 1, method, params })
    fx.add(body)
    client.push(method)
    return srv.request(method, params, 60_000)
  }
  try {
    await srv.init()
    const started = await sendAndRecord('thread/start', { cwd: work, sandbox: 'read-only', approvalPolicy: 'on-request' })
    const threadId = started.result?.thread?.id
    if (threadId) createdThreads.push(threadId)
    say(`тред заведён: ${threadId}`)

    const limits = await sendAndRecord('account/rateLimits/read', {})
    if (limits.result) {
      writeFileSync(join(OUT, '07-rate-limits-read-limited.json'), clean(JSON.stringify(limits.result, null, 2)) + '\n')
      say(`  записано 07-rate-limits-read-limited.json (ordinaryUsageAllowed=${limits.result.ordinaryUsageAllowed})`)
    }
    await sendAndRecord('turn/interrupt', { threadId, turnId: '00000000-0000-0000-0000-000000000000' })
    await sendAndRecord('thread/unsubscribe', { threadId })
    await sendAndRecord('thread/unsubscribe', { threadId })
  } finally {
    await srv.close()
  }

  // Второй процесс: тред без единого хода не возобновляется — эту ошибку и записываем.
  const srv2 = new Server(work, (line) => fx.add(line))
  try {
    await srv2.init()
    const id = createdThreads[createdThreads.length - 1]
    fx.add(JSON.stringify({ jsonrpc: '2.0', id: srv2.id + 1, method: 'thread/resume', params: { threadId: id, cwd: work, sandbox: 'read-only', approvalPolicy: 'on-request', excludeTurns: true } }))
    const r = await srv2.request('thread/resume', { threadId: id, cwd: work, sandbox: 'read-only', approvalPolicy: 'on-request', excludeTurns: true }, 60_000)
    say(`thread/resume треда без ходов: ${r.error ? r.error.message : 'ВНЕЗАПНО УДАЛСЯ — перепроверь вывод адаптера'}`)
  } finally {
    await srv2.close()
    fx.write()
    rmSync(work, { recursive: true, force: true })
  }
}

// --- режим записи ходов ------------------------------------------------------------
const TURNS = {
  'simple': { prompt: 'reply with the single word OK', sandbox: 'read-only', approval: 'never' },
  'permission-decline': { prompt: "Run the shell command `echo hi > x.txt` in the current working directory. Nothing else, no explanation.", sandbox: 'read-only', approval: 'on-request', answer: 'decline' },
  'permission-accept': { prompt: "Run the shell command `echo hi > x.txt` in the current working directory. Nothing else, no explanation.", sandbox: 'read-only', approval: 'on-request', answer: 'accept' },
  'subagent': { prompt: 'Use your agent-spawning tool to delegate one trivial task to a subagent: the subagent must reply with the single word PING. Report the subagent reply. Do not do the task yourself.', sandbox: 'read-only', approval: 'never' },
  'resume-turn': { prompt: 'What single word did you reply earlier? Answer with just that word.', sandbox: 'read-only', approval: 'never', resumeOf: 'simple' },
}
const FIXTURE_NAME = {
  'simple': '01-simple-turn',
  'permission-decline': '02-permission-decline',
  'permission-accept': '03-permission-accept',
  'subagent': '04-subagent',
  'resume-turn': '06-resume-turn',
}

async function recordTurn(name, work, threadToResume) {
  const def = TURNS[name]
  const fx = new Fixture(FIXTURE_NAME[name])
  let recording = false
  const srv = new Server(work, (line) => { if (recording) fx.add(line) })
  srv.onServerRequest = (msg) => {
    if (!def.answer) return
    say(`  запрос разрешения: ${msg.method} → отвечаем ${def.answer}`)
    srv.respond(msg.id, { decision: def.answer })
  }
  try {
    await srv.init()
    let threadId = threadToResume
    if (threadId) {
      const r = await srv.request('thread/resume', { threadId, cwd: work, sandbox: def.sandbox, approvalPolicy: def.approval, excludeTurns: true })
      if (r.error) throw new Error(`thread/resume: ${r.error.message}`)
    } else {
      const r = await srv.request('thread/start', { cwd: work, sandbox: def.sandbox, approvalPolicy: def.approval })
      threadId = r.result?.thread?.id
      if (!threadId) throw new Error('thread/start не вернул threadId')
      createdThreads.push(threadId)
    }
    recording = true
    const done = new Promise((res) => {
      const iv = setInterval(() => {
        if (fx.lines.some((l) => l.includes('"turn/completed"') && l.includes(threadId))) { clearInterval(iv); res(true) }
      }, 200)
      setTimeout(() => { clearInterval(iv); res(false) }, 240_000)
    })
    await srv.request('turn/start', { threadId, input: [{ type: 'text', text: def.prompt }], effort: 'low' })
    const ok = await done
    say(`  ход ${name}: ${ok ? 'завершён' : 'НЕ ДОЖДАЛИСЬ turn/completed'}`)
    return threadId
  } finally {
    await srv.close()
    fx.write()
  }
}

// --- прогон --------------------------------------------------------------------------
say(`CLI: ${CODEX_BIN}`)
if (PROBE_ONLY) {
  await probe()
} else {
  await guard()
  const work = sandbox()
  say(`cwd ходов=${work}`)
  const list = wanted.length ? wanted : ['simple', 'resume-turn', 'permission-decline', 'permission-accept', 'subagent']
  let simpleThread = null
  try {
    for (const name of list) {
      if (!TURNS[name]) { say(`пропущен незнакомый сценарий ${name}`); continue }
      say(`сценарий ${name}…`)
      const resumeOf = TURNS[name].resumeOf ? simpleThread : null
      if (TURNS[name].resumeOf && !resumeOf) { say('  нужен сценарий simple перед resume-turn — пропущено'); continue }
      const id = await recordTurn(name, work, resumeOf)
      if (name === 'simple') simpleThread = id
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
    sweepRollouts()
  }
}

say(`редакций: ${redactions}`)
console.log('\n=== ОТЧЁТ ЗАПИСИ ФИКСТУР CODEX ===')
console.log(report.join('\n'))
