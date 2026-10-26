#!/usr/bin/env node
// record-claude-fixtures.mjs — запись СЫРЫХ потоков настоящего `claude` в test/fixtures/claude/.
//
//   npm run build && node scripts/record-claude-fixtures.mjs [сценарий …]
//
// Сценарии: simple warm resume permission subagent api-retry  (без аргументов — все).
// В CI не запускается НИКОГДА: нужен залогиненный `claude`, сеть до api.anthropic.com и квота.
// Запускает лид руками, когда фикстуры надо перезаписать под новую версию CLI.
//
// ПРАВИЛА ЗАПИСИ:
//   * страж страны выхода — ТОТ ЖЕ код, что у адаптера (`dist/env/net.js`): страна из
//     списка-стража или неизвестна → ни один ход не запускается, скрипт выходит с кодом 4;
//   * cwd ходов — одноразовый git-репозиторий под os.tmpdir(), который скрипт сам создаёт
//     (`git init` + один коммит) и сам сносит; рабочее дерево Пульта ходы не видят;
//   * модель haiku, усилие low, `--setting-sources user` — самый дешёвый профиль;
//   * строки пишутся ДОСЛОВНО, кроме редакции: адрес почты заменяется на `<email>`, домашняя
//     папка (и её кодировка `-Users-<логин>-` в путях проектов Claude) — на `/Users/you`
//     (страж утечек CI сканирует отслеживаемые файлы, а фикстуры отслеживаются). Каждая
//     редакция печатается в отчёте — молча не режем ничего. Состав `system/init` (свои агенты,
//     плагины, подключённые сервисы) редакция НЕ трогает: перед коммитом его чистят руками;
//   * рядом с каждым `<имя>.jsonl` кладётся `<имя>.timing.json` — смещения в мс по строкам;
//     по нему фальшивый `claude` в тестах отыгрывает поток с настоящим ритмом.
//
// Фикстуры 08 (не залогинен) и 09 (блок аккаунта или региона) СИНТЕТИЧЕСКИЕ: первую нельзя
// снять, не разлогинив владельца, вторую — не дождавшись отказа платформы. Их пишет
// scripts/synth-claude-fixtures.mjs, и в README они помечены как синтетические.

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig } from '../dist/core/config.js'
import { buildChildEnv } from '../dist/env/allowlist.js'
import { checkNetwork, netLine } from '../dist/env/net.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, 'test', 'fixtures', 'claude')
const STUB = join(HERE, 'record-mcp-stub.mjs')
const CLAUDE_BIN = process.env.PULT_CLAUDE_BIN || '/opt/homebrew/bin/claude'
const NODE_BIN = process.execPath

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

const HOME = homedir()
const HOME_ENC = HOME.replace(/[^A-Za-z0-9]/g, '-')

let redactions = 0
function redact(line) {
  const out = line.replace(EMAIL_RE, () => { redactions++; return '<email>' })
  const home = out.split(HOME).join('/Users/you').split(HOME_ENC).join('-Users-you')
  if (home !== out) redactions++
  return home
}

// --- запись ------------------------------------------------------------------
class Recorder {
  constructor(name) {
    this.name = name
    this.lines = []
    this.timing = []
    this.t0 = Date.now()
  }
  add(line) {
    this.lines.push(redact(line))
    this.timing.push(Date.now() - this.t0)
  }
  /** Точка «сюда доиграли»: помечает, что следующая строка относится к новому ходу. */
  save() {
    mkdirSync(OUT, { recursive: true })
    const file = join(OUT, `${this.name}.jsonl`)
    writeFileSync(file, this.lines.map((l) => l + '\n').join(''))
    writeFileSync(join(OUT, `${this.name}.timing.json`), JSON.stringify(this.timing) + '\n')
    console.log(`   ${this.name}.jsonl — ${this.lines.length} строк, ${this.timing[this.timing.length - 1] ?? 0} мс`)
    return file
  }
}

// --- процесс claude ----------------------------------------------------------
function startClaude({ args, cwd, env, rec }) {
  const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []
  const listeners = new Set()
  let buf = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      rec.add(line)
      let evt
      try { evt = JSON.parse(line) } catch { continue }
      events.push(evt)
      for (const l of [...listeners]) { try { l(evt, events.length - 1) } catch { /* слушатель не роняет разбор */ } }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => { stderr += c })
  child.stdin.on('error', () => { /* труба закрылась под нами */ })
  const exited = new Promise((res) => child.on('close', (code, signal) => res({ code, signal, stderr })))
  return {
    child, events, exited,
    get stderr() { return stderr },
    mark: () => events.length,
    on: (l) => listeners.add(l),
    off: (l) => listeners.delete(l),
    send: (text) => {
      try {
        return child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
      } catch { return false }
    },
    endStdin: () => { try { child.stdin.end() } catch { /* закрыт */ } },
    kill: (sig = 'SIGKILL') => { try { child.kill(sig) } catch { /* мёртв */ } },
    alive: () => child.exitCode === null && child.signalCode === null,
  }
}

function waitForResult(s, ms = 180000, from = 0) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); s.off(handler); resolve(v) }
    const handler = (evt, idx) => { if (idx >= from && evt.type === 'result') finish(evt) }
    const timer = setTimeout(() => finish({ type: 'result', is_error: true, timeout: true }), ms)
    s.on(handler)
    for (let i = from; i < s.events.length && !done; i++) handler(s.events[i], i)
    s.exited.then(() => finish({ type: 'result', is_error: true, exited_without_result: true }))
  })
}

function baseArgs({ sessionId, resume, extra = [], permissionPrompts = 'none' }) {
  const a = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--forward-subagent-text',
  ]
  if (resume) a.push('--resume', resume)
  else if (sessionId) a.push('--session-id', sessionId)
  a.push('--model', 'haiku', '--effort', 'low', '--setting-sources', 'user')
  if (permissionPrompts) a.push('--permission-prompts', permissionPrompts)
  return a.concat(extra)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const summary = (r) => ({
  is_error: r && r.is_error,
  terminal_reason: r && r.terminal_reason,
  num_turns: r && r.num_turns,
  duration_ms: r && r.duration_ms,
  total_cost_usd: r && r.total_cost_usd,
  subagent_stats: r && r.subagent_stats,
  permission_denials: r && r.permission_denials,
  text: typeof (r && r.result) === 'string' ? r.result.slice(0, 200) : null,
})

// --- одноразовый репозиторий --------------------------------------------------
function makeSandbox() {
  const run = execFileSync
  const dir = mkdtempSync(join(tmpdir(), 'pult-rec-'))
  writeFileSync(join(dir, 'README.md'), 'pult fixture sandbox\n')
  writeFileSync(join(dir, 'note.txt'), 'before\n')
  const env = buildChildEnv(process.env, { extra: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  run('git', ['init', '-q', '-b', 'main'], { cwd: dir, env })
  run('git', ['-c', 'user.name=pult', '-c', 'user.email=pult@localhost', 'add', '-A'], { cwd: dir, env })
  run('git', ['-c', 'user.name=pult', '-c', 'user.email=pult@localhost', 'commit', '-qm', 'fixture sandbox'], { cwd: dir, env })
  return dir
}

// --- страж --------------------------------------------------------------------
async function guard() {
  const cfg = defaultConfig()
  const check = await checkNetwork('claude', cfg.network.claude, cfg.guard, { fresh: true })
  console.log(`страж: ${netLine(check)}`)
  if (!check.ok) {
    console.error(`\nОТКАЗ (страж сети): ${check.reason}. Ни один ход не сделан.`)
    process.exit(4)
  }
  return check
}

// --- сценарии -----------------------------------------------------------------
const scenarios = {}

// (1) один успешный ход с частичными сообщениями
scenarios.simple = async (cwd) => {
  const rec = new Recorder('01-simple-turn')
  const s = startClaude({
    args: baseArgs({ sessionId: randomUUID() }),
    cwd, env: buildChildEnv(process.env), rec,
  })
  s.send('Reply with exactly the word PULT and nothing else.')
  s.endStdin()
  const r = await waitForResult(s)
  if (s.alive()) s.kill()
  await s.exited
  rec.save()
  return { turns: 1, result: summary(r) }
}

// (2) два хода в одном тёплом процессе (stdin не закрывается между ходами)
scenarios.warm = async (cwd) => {
  const rec = new Recorder('02-warm-two-turns')
  const s = startClaude({
    args: baseArgs({ sessionId: randomUUID() }),
    cwd, env: buildChildEnv(process.env), rec,
  })
  s.send('Remember the number 41. Reply with exactly OK.')
  const r1 = await waitForResult(s)
  const m2 = s.mark()
  const t = Date.now()
  s.send('What number did I ask you to remember? Reply with the digits only.')
  const r2 = await waitForResult(s, 180000, m2)
  const secondMs = Date.now() - t
  s.endStdin()
  if (s.alive()) s.kill()
  await s.exited
  rec.save()
  return { turns: 2, second_reply_ms: secondMs, result: [summary(r1), summary(r2)] }
}

// (3) процесс на ход: второй процесс поднимает тот же разговор через --resume
scenarios.resume = async (cwd) => {
  const sessionId = randomUUID()
  const rec1 = new Recorder('03-resume-turn1')
  const s1 = startClaude({ args: baseArgs({ sessionId }), cwd, env: buildChildEnv(process.env), rec: rec1 })
  s1.send('The codeword is MAYAK. Reply with exactly OK.')
  const r1 = await waitForResult(s1)
  s1.endStdin()
  if (s1.alive()) s1.kill()
  await s1.exited
  rec1.save()

  const rec2 = new Recorder('03-resume-turn2')
  const s2 = startClaude({ args: baseArgs({ resume: sessionId }), cwd, env: buildChildEnv(process.env), rec: rec2 })
  s2.send('What is the codeword? Reply with the word only.')
  const r2 = await waitForResult(s2)
  s2.endStdin()
  if (s2.alive()) s2.kill()
  await s2.exited
  rec2.save()
  return { turns: 2, session_id: sessionId, result: [summary(r1), summary(r2)] }
}

// (4)+(5) круг разрешений: отказ на Edit, разрешение на Edit, отказ на пишущий Bash.
// Три хода в одном процессе — но фикстуры режутся по `result`, чтобы 05 можно было
// проигрывать отдельно.
scenarios.permission = async (cwd) => {
  const rec = new Recorder('04-permission-deny-allow')
  const trace = join(OUT, '04-permission-mcp-trace.jsonl')
  mkdirSync(OUT, { recursive: true })
  try { rmSync(trace) } catch { /* первой записи ещё нет */ }
  const mcpConfigPath = join(cwd, '.pult-mcp.json')
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      pult: {
        command: NODE_BIN,
        args: [STUB],
        env: {
          PULT_REC_TRACE: trace,
          PULT_REC_SERVER: 'pult',
          PULT_REC_DECISIONS: JSON.stringify([
            { behavior: 'deny', message: 'pult: denied on purpose' },
            { behavior: 'allow', echoInput: true },
            { behavior: 'deny', message: 'pult: denied on purpose (bash)' },
          ]),
        },
      },
    },
  }, null, 2) + '\n')

  const args = baseArgs({
    sessionId: randomUUID(),
    permissionPrompts: 'host',
    extra: ['--mcp-config', mcpConfigPath, '--strict-mcp-config', '--permission-prompt-tool', 'mcp__pult__ask'],
  })
  const s = startClaude({ args, cwd, env: buildChildEnv(process.env), rec })

  s.send('Use the Edit tool on the file note.txt in the current directory: replace the text "before" with "DENIED". Then reply with one word.')
  const r1 = await waitForResult(s)
  const m2 = s.mark()
  s.send('Use the Edit tool on the file note.txt in the current directory: replace the text "before" with "OK". Then reply with one word.')
  const r2 = await waitForResult(s, 180000, m2)
  const cut = rec.lines.length
  const m3 = s.mark()
  s.send('Use the Bash tool to run exactly `touch probe.txt` in the current directory. Nothing else. Then reply with one word.')
  const r3 = await waitForResult(s, 180000, m3)
  s.endStdin()
  if (s.alive()) s.kill()
  await s.exited

  // 05 — хвост потока, начиная с третьего хода: отдельная фикстура «пишущий Bash спрашивает».
  const tailLines = rec.lines.slice(cut)
  const tailTiming = rec.timing.slice(cut).map((t) => t - (rec.timing[cut] ?? 0))
  rec.lines = rec.lines.slice(0, cut)
  rec.timing = rec.timing.slice(0, cut)
  rec.save()
  writeFileSync(join(OUT, '05-permission-bash-deny.jsonl'), tailLines.map((l) => l + '\n').join(''))
  writeFileSync(join(OUT, '05-permission-bash-deny.timing.json'), JSON.stringify(tailTiming) + '\n')
  console.log(`   05-permission-bash-deny.jsonl — ${tailLines.length} строк`)

  // Трассу JSON-RPC тоже прогоняем через редакцию: в ней лежат пути и аргументы инструментов.
  try {
    const t = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(redact)
    writeFileSync(trace, t.map((l) => l + '\n').join(''))
    console.log(`   04-permission-mcp-trace.jsonl — ${t.length} сообщений`)
  } catch { console.log('   трасса MCP не записалась') }
  try { rmSync(mcpConfigPath) } catch { /* уже нет */ }
  return { turns: 3, result: [summary(r1), summary(r2), summary(r3)] }
}

// (6) субагент + ЭКСПЕРИМЕНТ: после первого `result` stdin держим ОТКРЫТЫМ до 90 с и
// записываем всё, что придёт. Открытый вопрос дизайна: приходит ли второй `result` или
// уведомление, когда фоновый субагент закончит?
scenarios.subagent = async (cwd) => {
  const rec = new Recorder('06-subagent')
  const s = startClaude({
    args: baseArgs({ sessionId: randomUUID(), extra: ['--allowedTools', 'Agent', 'Task'] }),
    cwd, env: buildChildEnv(process.env), rec,
  })
  s.send('Use the Agent tool to spawn exactly one subagent of type Explore whose entire job is to reply with the single word OK. Do not do the work yourself. When it returns, reply with the single word DONE.')
  const r = await waitForResult(s, 300000)
  const afterResultAt = Date.now()
  const linesAtResult = rec.lines.length
  console.log(`   первый result получен; держим stdin открытым 90 с и слушаем…`)
  const deadline = afterResultAt + 90_000
  while (Date.now() < deadline && s.alive()) await sleep(500)
  const arrived = rec.lines.slice(linesAtResult)
  const experiment = {
    lines_after_first_result: arrived.length,
    kinds_after_first_result: arrived.map((l) => { try { const e = JSON.parse(l); return `${e.type}${e.subtype ? '/' + e.subtype : ''}` } catch { return 'unparsable' } }),
    waited_ms: Date.now() - afterResultAt,
    child_alive_at_deadline: s.alive(),
    child_exit_code: s.child.exitCode,
    subagent_stats: r && r.subagent_stats,
  }
  s.endStdin()
  if (s.alive()) s.kill()
  await s.exited
  rec.save()
  writeFileSync(join(OUT, '06-subagent.experiment.json'), JSON.stringify(experiment, null, 2) + '\n')
  console.log(`   ЭКСПЕРИМЕНТ: ${JSON.stringify(experiment)}`)
  return { turns: 1, result: summary(r), experiment }
}

// (7) шторм api_retry: мёртвый прокси, НОЛЬ токенов. Пишем до третьего api_retry и убиваем.
scenarios['api-retry'] = async (cwd) => {
  const rec = new Recorder('07-api-retry-storm')
  const env = buildChildEnv(process.env, { network: { HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1,::1' } })
  const s = startClaude({ args: baseArgs({ sessionId: randomUUID() }), cwd, env, rec })
  let retries = 0
  const third = new Promise((resolve) => {
    s.on((evt) => {
      if (evt.type === 'system' && evt.subtype === 'api_retry') { retries++; if (retries >= 3) resolve('three') }
      if (evt.type === 'result') resolve('result')
    })
    setTimeout(() => resolve('timeout'), 120_000)
  })
  s.send('Reply with exactly OK.')
  const why = await third
  s.kill()
  await s.exited
  rec.save()
  return { turns: 0, retries, stopped_because: why }
}

// --- прогон -------------------------------------------------------------------
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const names = wanted.length ? wanted : ['simple', 'warm', 'resume', 'permission', 'subagent', 'api-retry']
for (const n of names) if (!scenarios[n]) { console.error(`неизвестный сценарий: ${n}`); process.exit(1) }

await guard()
const cwd = makeSandbox()
console.log(`песочница: ${cwd}`)
const report = {}
let turns = 0
try {
  for (const n of names) {
    console.log(`\n== ${n} ==`)
    const r = await scenarios[n](cwd)
    report[n] = r
    turns += r.turns || 0
  }
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
console.log(`\nходов потрачено: ${turns}; редакций почты: ${redactions}`)
console.log(JSON.stringify(report, null, 2))
