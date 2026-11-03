#!/usr/bin/env node
// smoke-zcode.mjs — дымовой прогон ZCode (маршрут A, docs/17-SPIKE-zcode.md) на НАСТОЯЩЕМ CLI.
//
//   npm run smoke:zcode
//
// В CI не входит и входить не должен: нужен залогиненный `zcode` (`zcode login`), сеть до
// api.z.ai и квота плана. Запускает лид руками при приёмке.
//
// ЧТО ПРОВЕРЯЕТСЯ (каждый шаг печатается в отчёт, у каждого — явное ожидание):
//   1. `pult doctor` — бинарь найден, вход по файлу кред;
//   2. `agent start --kind zcode` + `prompt --wait` — модель отвечает;
//   3. вторая реплика помнит контекст (--resume переживает границу процесса);
//   4. `--mode plan` честный: просьба создать файл НЕ создаёт файл;
//   5. `agent read` видит session.started с sessionId CLI и расход usage;
//   6. `agent stop` посреди хода — interrupted, осиротевших процессов нет.
//
// БЮДЖЕТ: ТРИ крошечных хода + один оборванный. Модель и уровень продуманности задаёт аккаунт
// Z.AI — флага --model у CLI нет, ничего выбирать нечем.
//
// БЕЗОПАСНОСТЬ: PULT_HOME — во временной папке, cwd ходов — одноразовая песочница, настоящий
// ~/.pult не трогается. Страж страны выхода — тот же код, что у адаптера.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig } from '../dist/core/config.js'
import { checkNetwork, netLine } from '../dist/env/net.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = join(ROOT, 'dist', 'cli', 'main.js')

const home = mkdtempSync(join(tmpdir(), 'psz-'))
const work = mkdtempSync(join(tmpdir(), 'pult-smoke-zcode-'))
const report = []
const say = (line) => { console.log(line); report.push(line) }

let failed = 0
let checks = 0
function expect(cond, what, run = null) {
  checks += 1
  if (cond) return true
  failed += 1
  say(`    ПРОВАЛ: ${what}`)
  if (run) {
    say(`    код ${run.code}${run.ms !== undefined ? `, ${run.ms} мс` : ''}`)
    if (run.stdout?.trim()) say(`    stdout: ${run.stdout.trim().split('\n').slice(0, 3).join(' | ').slice(0, 400)}`)
    if (run.stderr?.trim()) say(`    stderr: ${run.stderr.trim().split('\n').slice(0, 5).join(' | ').slice(0, 600)}`)
  }
  return false
}

function execFileSyncSafe(file, args, opts) {
  try {
    const stdout = execFileSync(file, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

function pult(args, { timeoutMs = 180_000 } = {}) {
  const t0 = Date.now()
  const r = execFileSyncSafe(process.execPath, [CLI, ...args], {
    env: { ...process.env, PULT_HOME: home },
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  return { ...r, ms: Date.now() - t0 }
}

async function guard() {
  const cfg = defaultConfig()
  const check = await checkNetwork('zcode', cfg.network.zcode, cfg.guard, { fresh: true })
  say(`страж: ${netLine(check)}`)
  if (!check.ok) {
    console.error(`ОТКАЗ (страж сети): ${check.reason}. Ни один ход не сделан.`)
    cleanup()
    process.exit(4)
  }
}

function cleanup() {
  pult(['daemon', 'stop'], { timeoutMs: 20_000 })
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

mkdirSync(join(work), { recursive: true })
writeFileSync(join(work, 'note.txt'), 'before\n')
await guard()

say(`PULT_HOME=${home}`)
say(`cwd ходов=${work}`)

// --- 1. доктор -------------------------------------------------------------------
const doctor = pult(['doctor', '--no-net'], { timeoutMs: 120_000 })
say(`1. doctor: код ${doctor.code}`)
const docText = doctor.stdout
expect(/CLI zcode/.test(docText) && !/CLI zcode[^]*не найден/.test(docText), 'доктор не видит CLI zcode', doctor)
expect(/Вход zcode/.test(docText), 'в докторе нет пункта «Вход zcode»', doctor)

// --- 2. первый ход ----------------------------------------------------------------
const start = pult(['agent', 'start', 'w', '--kind', 'zcode', '--cwd', work])
say(`2. agent start: код ${start.code}, ${start.ms} мс — ${start.stdout.trim() || start.stderr.trim()}`)
expect(start.code === 0, 'agent start --kind zcode не отработал', start)

const t1 = pult(['agent', 'prompt', 'w', 'Remember the number 41. Reply with exactly OK.', '--wait'])
say(`3. первая реплика: код ${t1.code}, ${t1.ms} мс, ответ «${t1.stdout.trim().slice(0, 120)}»`)
expect(t1.code === 0, 'первая реплика вернула ненулевой код', t1)
expect(t1.stdout.trim().length > 0, 'первая реплика вернула ПУСТОЙ ответ', t1)

// --- 3. resume вторым ходом ---------------------------------------------------------
const t2 = pult(['agent', 'prompt', 'w', 'What number did I ask you to remember? Digits only.', '--wait'])
const remembered = /41/.test(t2.stdout)
say(`4. resume: код ${t2.code}, ${t2.ms} мс, ответ «${t2.stdout.trim().slice(0, 120)}» — помнит: ${remembered ? 'ДА' : 'НЕТ'}`)
expect(t2.code === 0, 'вторая реплика (resume) вернула ненулевой код', t2)
expect(remembered, 'вторая реплика НЕ помнит контекст (--resume не работает?)', t2)

// --- 4. журнал ----------------------------------------------------------------------
const read = pult(['agent', 'read', 'w', '--format', 'json'])
const events = read.stdout.trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const started = events.find((e) => e.kind === 'session.started')
say(`5. журнал: session.started ${started ? String(started.data?.providerSessionId).slice(0, 18) + '…' : 'НЕТ'}, usage ${events.some((e) => e.kind === 'usage.updated') ? 'есть' : 'НЕТ'}`)
expect(Boolean(started && String(started.data?.providerSessionId ?? '').startsWith('sess_')), 'в журнале нет session.started с sessionId CLI', read)
expect(events.some((e) => e.kind === 'usage.updated'), 'в журнале нет usage.updated', read)

// --- 5. plan — честный read-only ------------------------------------------------------
const plan = pult(['agent', 'start', 'p', '--kind', 'zcode', '--cwd', work, '--approval', 'read-only'])
expect(plan.code === 0, 'agent start --approval read-only не отработал', plan)
const t3 = pult(['agent', 'prompt', 'p', 'Create a file named PLAN.txt in the current directory with the single word hi. Reply with one word.', '--wait'], { timeoutMs: 240_000 })
const planFile = existsSync(join(work, 'PLAN.txt'))
say(`6. plan-режим: код ${t3.code}, ответ «${t3.stdout.trim().slice(0, 80)}», PLAN.txt ${planFile ? 'СОЗДАН (плохо!)' : 'не создан (хорошо)'}`)
expect(!planFile, 'plan-режим создал файл — read-only не честный', t3)

// --- 6. стоп посреди хода --------------------------------------------------------------
const slow = pult(['agent', 'prompt', 'w', 'Count slowly from 1 to 50 explaining each step.', '--json'])
expect(slow.code === 0, 'долгий ход не запустился', slow)
await new Promise((r) => setTimeout(r, 3000))
const stop = pult(['agent', 'stop', 'w'])
say(`7. agent stop посреди хода: код ${stop.code}`)
expect(stop.code === 0, 'agent stop не отработал', stop)
const afterStop = pult(['agent', 'wait', 'w', '--timeout', '30000'], { timeoutMs: 40_000 })
say(`8. ход после стопа: код ${afterStop.code} — ${afterStop.stdout.trim().slice(0, 120)}`)

// --- финал ------------------------------------------------------------------------------
const stopAll = pult(['daemon', 'stop'])
say(`9. daemon stop: код ${stopAll.code}`)
const leftovers = execFileSyncSafe('/bin/sh', ['-c', `pgrep -fl 'zcode' | grep 'stream-json' | grep -- '${work}' | grep -v pgrep || true`], { encoding: 'utf8' })
say(`10. осиротевшие процессы: ${leftovers.stdout.trim() || 'нет'}`)
expect(leftovers.stdout.trim() === '', 'после остановки остались осиротевшие процессы')

rmSync(home, { recursive: true, force: true })
rmSync(work, { recursive: true, force: true })
say('11. временные PULT_HOME и песочница снесены')

say(`\n${checks - failed}/${checks} проверок прошло${failed ? `, ПРОВАЛЕНО ${failed}` : ''}`)
console.log('\n=== ОТЧЁТ ДЫМОВОГО ПРОГОНА ZCODE ===')
console.log(report.join('\n'))
process.exit(failed === 0 ? 0 : 1)
