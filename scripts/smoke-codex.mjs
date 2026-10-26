#!/usr/bin/env node
// smoke-codex.mjs — дымовой прогон В3 на НАСТОЯЩЕМ `codex`.
//
//   npm run smoke:codex            семь крошечных ходов (базовый набор)
//   npm run smoke:codex -- --full   плюс субагент и дерево (восьмой ход)
//
// В CI не входит и входить не должен: нужен залогиненный `codex`, сеть и квота подписки.
//
// ЭТОТ СКРИПТ ОБЯЗАН УМЕТЬ ПАДАТЬ. Первая версия печатала красивый отчёт и выходила с кодом 0,
// даже когда ПЯТЬ шагов из восемнадцати вернули код 1 с пустым ответом: она записывала только
// `stdout`, и причина каждого провала терялась — по восьмидесяти строкам лога нельзя было
// отличить исчерпанный лимит от мёртвого прокси. Теперь:
//   * у КАЖДОГО шага есть явное ожидание (`check(...)`), и невыполненное ожидание — провал;
//   * при провале печатаются `stderr` шага и последние события журнала этой сессии;
//   * в конце строка «N/M шагов прошло» и НЕНУЛЕВОЙ код выхода, если провалился хоть один;
//   * «запрос разрешения не появился» — это ПРОВАЛ, а не «ВНИМАНИЕ».
//
// ЧЕМ ВЫЗЫВАЕТСЯ ЗАПРОС РАЗРЕШЕНИЯ (измерено лидом 22.09.2026 на 0.155.0-alpha.9.2): запись
// ФАЙЛА ВНЕ рабочей папки при `sandbox: workspace-write` + `approvalPolicy: on-request`.
// Безобидная команда внутри песочницы не спрашивает ничего. Поэтому шаги разрешений пишут
// файл с уникальным именем в домашний каталог и сносят его в `finally`.
//
// БЮДЖЕТ. Один крошечный ход стоит ~20 тысяч входных токенов; десяток ходов сдвинул
// пятичасовое окно с 8 % до 45 %. Поэтому ходов ровно столько, сколько нужно для приёмки:
// 7 (или 8 с `--full`).
//
// БЕЗОПАСНОСТЬ: PULT_HOME во временной папке (короткий путь — у unix-сокета на macOS предел
// 104 байта), cwd ходов — одноразовые git-репозитории под os.tmpdir(). Настоящий ~/.pult не
// трогается. Страж страны выхода — тот же код, что у адаптера.
// `account/rateLimitResetCredit/consume` не зовётся ни при каких условиях.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig } from '../dist/core/config.js'
import { buildChildEnv } from '../dist/env/allowlist.js'
import { checkNetwork, netLine } from '../dist/env/net.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = join(ROOT, 'dist', 'cli', 'main.js')
const FULL = process.argv.includes('--full')

const home = mkdtempSync(join(tmpdir(), 'ps-cx-'))
const works = []
// Файл-приманка ВНЕ песочницы: именно запись сюда заставляет codex спросить разрешение.
const bait = join(homedir(), `pult-smoke-${process.pid}-${Date.now()}.txt`)

const report = []
const say = (line) => { console.log(line); report.push(line) }

let stepNo = 0
let passed = 0
let failed = 0
/** Последний запуск CLI — из него берутся stderr и код выхода при разборе провала. */
let lastRun = null

function run(file, args, opts = {}) {
  try {
    const stdout = execFileSync(file, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

function pult(args, { timeoutMs = 300_000 } = {}) {
  const t0 = Date.now()
  const r = run(process.execPath, [CLI, ...args], { env: { ...process.env, PULT_HOME: home }, timeout: timeoutMs })
  lastRun = { args, ...r, ms: Date.now() - t0 }
  return lastRun
}

class Failed extends Error {}
const check = (cond, message) => { if (!cond) throw new Failed(message) }

/** Последние события журнала сессии — единственное, что объясняет непонятный провал. */
function tailJournal(session, n = 12) {
  const r = pult(['agent', 'read', session, '--format', 'json'], { timeoutMs: 30_000 })
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  return lines.slice(-n).map((l) => {
    try {
      const ev = JSON.parse(l)
      return `      #${ev.id} ${ev.kind} ${JSON.stringify(ev.data).slice(0, 200)}`
    } catch { return `      ${l.slice(0, 200)}` }
  })
}

/**
 * Шаг с ЯВНЫМ ожиданием. `fn` возвращает строку для отчёта; невыполненное ожидание внутри
 * (`check`) или любое исключение — провал шага, а не «предупреждение».
 */
function step(title, fn, { session = null } = {}) {
  stepNo += 1
  try {
    const detail = fn() ?? ''
    passed += 1
    say(`${String(stepNo).padStart(2)}. OK   ${title}${detail ? ` — ${detail}` : ''}`)
    return true
  } catch (e) {
    failed += 1
    say(`${String(stepNo).padStart(2)}. ПРОВАЛ ${title} — ${e.message}`)
    if (lastRun) {
      say(`      команда: pult ${lastRun.args.join(' ')}`)
      say(`      код ${lastRun.code}, ${lastRun.ms} мс`)
      if (lastRun.stdout.trim()) say(`      stdout: ${lastRun.stdout.trim().split('\n').slice(0, 3).join(' | ').slice(0, 400)}`)
      // Вот этой строки и не хватало в прошлой версии.
      if (lastRun.stderr.trim()) say(`      stderr: ${lastRun.stderr.trim().split('\n').slice(0, 5).join(' | ').slice(0, 600)}`)
    }
    if (session) {
      say('      хвост журнала сессии:')
      for (const line of tailJournal(session)) say(line)
    }
    return false
  }
}

function sandbox(tag) {
  const work = mkdtempSync(join(tmpdir(), `pult-smoke-codex-${tag}-`))
  writeFileSync(join(work, 'README.md'), 'pult codex smoke sandbox\n')
  const env = buildChildEnv(process.env, { extra: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work, env })
  execFileSync('git', ['-c', 'user.name=pult', '-c', 'user.email=pult@localhost', 'add', '-A'], { cwd: work, env })
  execFileSync('git', ['-c', 'user.name=pult', '-c', 'user.email=pult@localhost', 'commit', '-qm', 'smoke'], { cwd: work, env })
  works.push(work)
  return work
}

function cleanup() {
  pult(['daemon', 'stop'], { timeoutMs: 30_000 })
  rmSync(home, { recursive: true, force: true })
  for (const w of works) rmSync(w, { recursive: true, force: true })
  if (existsSync(bait)) { try { unlinkSync(bait) } catch { /* и так нет */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPending(ms = 120_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const r = pult(['perm', 'list', '--json'], { timeoutMs: 30_000 })
    try {
      const parsed = JSON.parse(r.stdout)
      if (parsed.pending?.length) return parsed.pending[0]
    } catch { /* демон ещё поднимается */ }
    if (Date.now() > deadline) return null
    await sleep(500)
  }
}

// --- прогон -------------------------------------------------------------------
const cfg = defaultConfig()
const guard = await checkNetwork('codex', cfg.network.codex, cfg.guard, { fresh: true })
say(`страж: ${netLine(guard)}`)
if (!guard.ok) {
  console.error(`ОТКАЗ (страж сети): ${guard.reason}. Ни один ход не сделан.`)
  cleanup()
  process.exit(4)
}
say(`PULT_HOME=${home}`)
say(`приманка вне песочницы: ${bait}`)

const a = sandbox('a')
const b = sandbox('b')

try {
  step('agent start ca', () => {
    const r = pult(['agent', 'start', 'ca', '--kind', 'codex', '--cwd', a, '--effort', 'low'])
    check(r.code === 0, `код ${r.code}`)
    return r.stdout.trim()
  })

  step('ход 1: модель ответила', () => {
    const r = pult(['agent', 'prompt', 'ca', 'Reply with exactly OK and remember the number 41.', '--wait'])
    check(r.code === 0, `код ${r.code}`)
    check(r.stdout.trim().length > 0, 'ответ ПУСТОЙ')
    return `${r.ms} мс, «${r.stdout.trim().slice(0, 80)}»`
  }, { session: 'ca' })

  step('ход 2: тот же тред помнит контекст', () => {
    const r = pult(['agent', 'prompt', 'ca', 'What number did I ask you to remember? Digits only.', '--wait'])
    check(r.code === 0, `код ${r.code}`)
    check(/41/.test(r.stdout), `в ответе нет 41: «${r.stdout.trim().slice(0, 80)}»`)
    return `${r.ms} мс`
  }, { session: 'ca' })

  step('agent start cb', () => {
    const r = pult(['agent', 'start', 'cb', '--kind', 'codex', '--cwd', b, '--effort', 'low'])
    check(r.code === 0, `код ${r.code}`)
    return r.stdout.trim()
  })

  step('ходы 3 и 4: ДВА агента параллельно в ОДНОМ app-server', () => {
    const p1 = pult(['agent', 'prompt', 'ca', 'Reply with exactly ALPHA.', '--json'])
    const p2 = pult(['agent', 'prompt', 'cb', 'Reply with exactly BETA.', '--json'])
    check(p1.code === 0 && p2.code === 0, `коды ${p1.code}/${p2.code}`)
    const w1 = pult(['agent', 'wait', 'ca', '--timeout', '240000'])
    const w2 = pult(['agent', 'wait', 'cb', '--timeout', '240000'])
    check(w1.code === 0, `ca: код ${w1.code}`)
    check(w2.code === 0, `cb: код ${w2.code}`)
    check(/ALPHA/i.test(w1.stdout), `ca ответил «${w1.stdout.trim().slice(0, 60)}»`)
    check(/BETA/i.test(w2.stdout), `cb ответил «${w2.stdout.trim().slice(0, 60)}»`)
    const procs = run('/bin/sh', ['-c', "pgrep -f 'codex app-server' | grep -v pgrep || true"])
    const n = procs.stdout.trim().split('\n').filter(Boolean).length
    check(n === 1, `процессов app-server ${n}, ожидался ОДИН`)
    return 'ответы не перепутаны, процесс один'
  }, { session: 'ca' })

  step('рестарт демона: разговор переживает его', () => {
    check(pult(['daemon', 'stop']).code === 0, 'daemon stop не отработал')
    const r = pult(['agent', 'prompt', 'ca', 'What number did I ask you to remember? Digits only.', '--wait'])
    check(r.code === 0, `код ${r.code}`)
    check(/41/.test(r.stdout), `тред не возобновился: «${r.stdout.trim().slice(0, 80)}»`)
    return 'thread/resume вернул контекст'
  }, { session: 'ca' })

  await (async () => {
    let pending = null
    step('ход 6: запись ВНЕ песочницы спрашивает разрешение', () => {
      const r = pult(['agent', 'prompt', 'ca', `Run the shell command \`echo smoke > ${bait}\`. Nothing else.`, '--json'])
      check(r.code === 0, `код ${r.code}`)
      return r.stdout.trim()
    }, { session: 'ca' })
    pending = await waitPending()
    step('вопрос появился в pult perm list', () => {
      // Раньше здесь было «ВНИМАНИЕ» и прогон продолжался как ни в чём не бывало.
      check(pending !== null, 'запрос разрешения НЕ появился за 120 с')
      check(pending.toolName === 'commandExecution' || pending.toolName === 'fileChange',
        `неожиданный инструмент ${pending.toolName}`)
      return `${pending.id} · ${pending.toolName} · ${JSON.stringify(pending.input).slice(0, 160)}`
    }, { session: 'ca' })
    step('perm deny: ход продолжается, файл НЕ создан', () => {
      check(pending !== null, 'нечего отклонять')
      check(pult(['perm', 'deny', pending.id, '--reason', 'дымовой прогон: сначала отказ']).code === 0, 'perm deny не отработал')
      const w = pult(['agent', 'wait', 'ca', '--timeout', '240000'])
      check(w.code === 0, `после отказа ход вернул код ${w.code} (отказ НЕ должен проваливать ход)`)
      check(!existsSync(bait), 'файл появился ВОПРЕКИ отказу')
      return 'отказ соблюдён'
    }, { session: 'ca' })
  })()

  await (async () => {
    step('ход 7: та же команда — и разрешаем', () => {
      const r = pult(['agent', 'prompt', 'ca', `Run the shell command \`echo smoke > ${bait}\`. Nothing else.`, '--json'])
      check(r.code === 0, `код ${r.code}`)
      return r.stdout.trim()
    }, { session: 'ca' })
    const pending = await waitPending()
    step('perm approve: файл создан', () => {
      check(pending !== null, 'запрос разрешения НЕ появился за 120 с')
      check(pult(['perm', 'approve', pending.id]).code === 0, 'perm approve не отработал')
      const w = pult(['agent', 'wait', 'ca', '--timeout', '240000'])
      check(w.code === 0, `код ${w.code}`)
      check(existsSync(bait), 'файл так и не создан — разрешение не доехало')
      return 'правка применена'
    }, { session: 'ca' })
  })()

  if (FULL) {
    step('ход 8: субагент и дерево', () => {
      const r = pult(['agent', 'prompt', 'cb', 'Use your agent-spawning tool to delegate one trivial task to a subagent: it must reply with the single word PING. Report the reply. Do not do it yourself.', '--wait', '--timeout', '300000'], { timeoutMs: 360_000 })
      check(r.code === 0, `код ${r.code}`)
      const tree = pult(['agent', 'tree', 'cb'])
      check(/Agent\(/.test(tree.stdout), `в дереве нет субагента:\n${tree.stdout.trim().slice(0, 300)}`)
      return tree.stdout.trim().split('\n')[0]
    }, { session: 'cb' })
  }

  step('usage показывает окна лимита', () => {
    const r = pult(['usage', '--json'])
    check(r.code === 0, `код ${r.code}`)
    const parsed = JSON.parse(r.stdout)
    const row = parsed.usage.find((u) => u.session === 'ca')
    check(row, 'строки расхода по ca нет')
    check(row.rateLimit && typeof row.rateLimit.windows?.five_hour?.utilization === 'number',
      'окна лимита не доехали до usage')
    return `5 часов ${Math.round(row.rateLimit.windows.five_hour.utilization * 100)} %`
  })

  step('doctor знает про схему протокола', () => {
    const r = pult(['doctor', '--no-net'])
    const line = r.stdout.split('\n').find((l) => /Схема протокола codex/.test(l))
    check(line, 'строки про схему в отчёте нет')
    return line.trim()
  })

  step('остановка: агенты сняты, app-server не пережил демона', () => {
    check(pult(['agent', 'stop', 'ca']).code === 0, 'agent stop ca')
    check(pult(['agent', 'stop', 'cb']).code === 0, 'agent stop cb')
    check(pult(['daemon', 'stop']).code === 0, 'daemon stop')
    const left = run('/bin/sh', ['-c', "pgrep -f 'codex app-server|dist/daemon/main.js' | grep -v pgrep || true"])
    check(left.stdout.trim() === '', `осиротевшие процессы: ${left.stdout.trim()}`)
    return 'сирот нет'
  })
} finally {
  cleanup()
}

const total = passed + failed
say(`\n${passed}/${total} шагов прошло${failed ? `, ПРОВАЛЕНО ${failed}` : ''}`)
console.log('\n=== ОТЧЁТ ДЫМОВОГО ПРОГОНА CODEX ===')
console.log(report.join('\n'))
process.exit(failed === 0 ? 0 : 1)
