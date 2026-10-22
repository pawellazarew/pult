#!/usr/bin/env node
// Фальшивый launchctl: глаголы, которыми пользуется Пульт (bootstrap, bootout, kickstart, kill, print),
// с ответами и кодами настоящего. argv каждой команды пишется в FAKE_SVC_LOG. Подробности и
// переменные — в fake-svc-lib.mjs. Сам процесс службы сторожит надзиратель fake-launchd-job.mjs:
// он, как launchd, поднимает службу заново после смерти от сигнала или кода ≠ 0.
//
// Тексты ошибок — как у launchctl macOS 13–15:
//   bootout незагруженной метки   → «Boot-out failed: 3: No such process», код 3
//   print/kickstart незагруженной → «Could not find service "<метка>" in domain for user gui: <uid>», код 113
//                                   (print — с первой строкой «Bad request.»; записано лидом 23.09.2026)
//   bootstrap уже загруженной     → «Bootstrap failed: 5: Input/output error», код 5
//
// FAKE_SVC_BOOTOUT_LINGER_MS — как настоящий bootout ведёт себя с процессом, который не выходит
// сразу (замер 30.09.2026: демон, занятый стартом, — 1,3–5,1 с, до `exit timeout`): bootout отвечает
// 0 СРАЗУ, а служба остаётся загруженной ещё столько миллисекунд — `print` её видит, `bootstrap`
// отвечает кодом 5. Без переменной bootout, как и раньше, возвращается уже после выхода процесса.
//
// FAKE_SVC_RACE — «другая команда pult успела раньше» (её ensureDaemon сам грузит незагруженную службу):
//   bootout   — сразу после нашего bootout службу загружает кто-то другой (у неё новый процесс);
//   bootstrap — наш bootstrap приходит вторым: служба уже загружена другим, нам — код 5.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { alive, fail, killJob, loadState, logArgv, logEvent, sleepSync, withState } from './fake-svc-lib.mjs'

logArgv('launchctl')
const argv = process.argv.slice(2)
const verb = argv[0]
const lingerMs = Number(process.env.FAKE_SVC_BOOTOUT_LINGER_MS || 0)
// Службы, чей bootout «дошёл до конца», уходят из состояния перед любой командой.
const left = (job) => job.goneAt && Date.now() >= job.goneAt
if (Object.values(loadState().jobs).some(left)) {
  withState((s) => { for (const [label, job] of Object.entries(s.jobs)) if (left(job)) delete s.jobs[label] })
}
const st = loadState()
const SUPERVISOR = fileURLToPath(new URL('./fake-launchd-job.mjs', import.meta.url))
const throttleMs = Number(process.env.FAKE_SVC_THROTTLE_MS || 1000)

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

function parsePlist(text) {
  const str = (key) => {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)
    return m ? decode(m[1]) : null
  }
  const prog = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)
  const env = {}
  if (envBlock) {
    const re = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g
    let m
    while ((m = re.exec(envBlock[1]))) env[decode(m[1])] = decode(m[2])
  }
  return {
    label: str('Label'),
    program: prog ? decode(prog[1]) : null,
    cwd: str('WorkingDirectory'),
    logPath: str('StandardOutPath'),
    runAtLoad: /<key>RunAtLoad<\/key>\s*<true\/>/.test(text),
    env,
  }
}

const labelOf = (target) => (target || '').split('/').slice(2).join('/')
const uidOf = (target) => (target || '').split('/')[1] || '0'
const notFound = (target) => {
  process.stderr.write(`Could not find service "${labelOf(target)}" in domain for user gui: ${uidOf(target)}\n`)
  process.exit(113)
}

/**
 * Запустить процесс службы новым поколением надзирателя (fake-launchd-job.mjs) и дождаться его pid,
 * как настоящий bootstrap/kickstart. Смена `gen` — сигнал прежнему надзирателю уйти, ничего не поднимая.
 *
 * `ifIdle` — для `kickstart` без -k: решение «поднимать или нет» принимается под блокировкой по СВЕЖЕМУ
 * состоянию. Живой процесс или запуск, который прямо сейчас ведёт другая команда (`spawning`), —
 * ничего не делать, как настоящий kickstart. КАК ЛОМАЛОСЬ (CI ubuntu, PR #13, 30.09.2026): проигравший
 * гонку `bootstrap` звал `kickstart`, тот читал состояние при старте (pid ещё null), надзиратель
 * победителя успевал записать pid, и kickstart всё равно ставил второе поколение — второй процесс
 * службы при живом первом.
 */
function startJob(label, { ifIdle = false } = {}) {
  const gen = randomUUID()
  const job = withState((s) => {
    const j = s.jobs[label]
    if (!j) return null
    const spawning = j.spawning && Date.now() - j.spawning < 4000
    if (ifIdle && (alive(j.pid) || spawning)) return null
    j.gen = gen
    j.scheduled = false
    if (process.env.FAKE_SVC_NOSPAWN !== '1') j.spawning = Date.now()
    return { ...j }
  })
  if (!job || process.env.FAKE_SVC_NOSPAWN === '1') return
  // Настоящий kickstart после падения ждёт конца ThrottleInterval (приёмка 23.09.2026: 10–18 с на
  // вызов); отсчёт — от начала прошлого запуска. bootstrap новой службы не ждёт (прошлого запуска нет).
  const crashed = job.lastSignal || (job.lastExit !== null && job.lastExit !== undefined && job.lastExit !== 0)
  if (crashed && job.lastStart) {
    const wait = job.lastStart + throttleMs - Date.now()
    if (wait > 0) sleepSync(wait)
  }
  const p = parsePlist(readFileSync(job.file, 'utf8'))
  const runs = job.runs || 0
  const sup = spawn(process.execPath, [SUPERVISOR], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FAKE_JOB: JSON.stringify({ label, gen, program: p.program, env: p.env, cwd: p.cwd, logPath: p.logPath }) },
  })
  sup.unref()
  // pid надзирателя — в журнал до выхода команды: он отсоединён и пишет в дом теста и после смерти
  // процесса службы, поэтому тест перед стиранием дома ждёт его выхода (test/helpers.ts, reapFakeSupervisors).
  if (sup.pid) logEvent('launchctl', 'supervisor', { label, gen, pid: sup.pid })
  for (let i = 0; i < 400; i++) {
    const j = loadState().jobs[label]
    if (!j || j.gen !== gen || (j.runs || 0) > runs) return
    sleepSync(10)
  }
}

/** Загрузить службу из файла и запустить её (RunAtLoad). `false` — такая метка уже загружена. */
function bootstrapJob(file) {
  const p = parsePlist(readFileSync(file, 'utf8'))
  const created = withState((s) => {
    if (s.jobs[p.label]) return false
    s.jobs[p.label] = { file, pid: null, lastExit: null, lastSignal: null, runs: 0, gen: null, scheduled: false, lastStart: null }
    return true
  })
  if (created && p.runAtLoad) startJob(p.label)
  return created
}

switch (verb) {
  case 'bootstrap': {
    const file = argv[2]
    if (fail('bootstrap')) { process.stderr.write('Bootstrap failed: 5: Input/output error\n'); process.exit(5) }
    // Гонка: «другая команда» загрузила службу мгновением раньше — нам достаётся «уже загружена».
    const created = bootstrapJob(file) && process.env.FAKE_SVC_RACE !== 'bootstrap'
    if (!created) { process.stderr.write('Bootstrap failed: 5: Input/output error\n'); process.exit(5) }
    process.exit(0)
  }
  case 'bootout': {
    // Сначала служба уходит из состояния (надзиратель больше ничего не поднимет), потом — процесс.
    const label = labelOf(argv[1])
    const bootedFile = st.jobs[label]?.file
    const pid = withState((s) => {
      const job = s.jobs[label]
      if (!job) return undefined
      if (lingerMs > 0) {
        // Служба ещё «загружена» до goneAt; новое поколение — надзиратель процесс больше не поднимет.
        job.goneAt = job.goneAt ?? Date.now() + lingerMs
        job.gen = randomUUID()
      } else {
        delete s.jobs[label]
      }
      return job.pid ?? null
    })
    if (pid === undefined) { process.stderr.write('Boot-out failed: 3: No such process\n'); process.exit(3) }
    if (lingerMs > 0) {
      if (alive(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* ушёл */ } }
      process.exit(0)
    }
    if (alive(pid)) killJob(pid)
    // Гонка: «другая команда» загружает службу сразу после нашего bootout.
    if (process.env.FAKE_SVC_RACE === 'bootout' && bootedFile) bootstrapJob(bootedFile)
    process.exit(0)
  }
  case 'kickstart': {
    const kill = argv.includes('-k')
    const target = argv.slice(1).filter((a) => !a.startsWith('-'))[0]
    const label = labelOf(target)
    const job = st.jobs[label]
    if (!job) notFound(target)
    if (fail('kickstart')) { process.stderr.write(`Could not kickstart service "${label}": 1: Operation not permitted\n`); process.exit(1) }
    // Процесс запущен, а ответ — ошибка: так выглядит launchctl, не дождавшийся launchd.
    if (fail('kickstart-after-start')) {
      startJob(label, { ifIdle: true })
      process.stderr.write(`Could not kickstart service "${label}": 1: Operation not permitted\n`)
      process.exit(1)
    }
    if (alive(job.pid)) {
      if (!kill) process.exit(0)
      // Новое поколение ДО убийства: прежний надзиратель увидит смену и не поднимет процесс сам.
      withState((s) => { if (s.jobs[label]) s.jobs[label].gen = randomUUID() })
      killJob(job.pid)
    }
    // Без -k — по свежему состоянию: процесс мог подняться, пока эта команда стартовала.
    startJob(label, { ifIdle: !kill })
    process.exit(0)
  }
  case 'kill': {
    // `launchctl kill <сигнал> <цель>`: сигнал ТЕКУЩЕМУ процессу службы, без ожидания (как настоящий).
    // Что будет дальше, решает надзиратель: код 0 — служба стоит, сигнал или код ≠ 0 — воскрешение.
    // Текст отказа для службы без процесса не записан с настоящего — берём код 3 «No such process».
    const sig = argv[1]
    const target = argv[2]
    const job = st.jobs[labelOf(target)]
    if (!job) notFound(target)
    if (!alive(job.pid)) { process.stderr.write('Could not kill service: 3: No such process\n'); process.exit(3) }
    try { process.kill(job.pid, /^\d+$/.test(sig) ? Number(sig) : sig) } catch { /* ушёл */ }
    process.exit(0)
  }
  case 'print': {
    const target = argv[1]
    const label = labelOf(target)
    const job = st.jobs[label]
    if (!job) { process.stderr.write('Bad request.\n'); notFound(target) }
    const running = alive(job.pid)
    // Формат — по НАСТОЯЩЕМУ выводу (test/fixtures/service/, записан лидом 23.09.2026): у живой службы
    // `last exit code = (never exited)`; после смерти от сигнала строки кода нет, есть
    // `last terminating signal = Killed: 9` и `state = spawn scheduled`. Вложенные блоки несут свои
    // `state = active` — разбор обязан их не путать с состоянием службы.
    // Окружение (FAKE_SVC_LAST_SIGNAL/LAST_EXIT) перебивает то, что записал надзиратель.
    const sig = !running ? process.env.FAKE_SVC_LAST_SIGNAL || (process.env.FAKE_SVC_LAST_EXIT === undefined ? job.lastSignal : undefined) : undefined
    const envExit = !running ? process.env.FAKE_SVC_LAST_EXIT : undefined
    let lastLine = null
    if (sig) lastLine = `\tlast terminating signal = ${sig}`
    else if (envExit !== undefined) lastLine = `\tlast exit code = ${envExit === '78' ? '78: EX_CONFIG' : envExit}`
    else if (job.lastExit !== null && job.lastExit !== undefined) lastLine = `\tlast exit code = ${job.lastExit === 78 ? '78: EX_CONFIG' : job.lastExit}`
    // Процесс умер, а с каким кодом — фальшивка не знает (он отсоединён): строку не выдумываем.
    else if (running || !(job.runs > 0)) lastLine = '\tlast exit code = (never exited)'
    const p = parsePlist(readFileSync(job.file, 'utf8'))
    const lines = [
      `${target} = {`,
      `\tactive count = ${running ? 1 : 0}`,
      `\tpath = ${job.file}`,
      '\ttype = LaunchAgent',
      `\tstate = ${running ? 'running' : sig || job.scheduled || process.env.FAKE_SVC_SPAWN_SCHEDULED === '1' ? 'spawn scheduled' : 'not running'}`,
      '',
      `\tprogram = ${p.program}`,
      '\targuments = {',
      `\t\t${p.program}`,
      '\t}',
      '',
      `\tworking directory = ${p.cwd}`,
      '',
      `\tstdout path = ${p.logPath}`,
      `\tstderr path = ${p.logPath}`,
      '\tenvironment = {',
      ...Object.entries(p.env).map(([k, v]) => `\t\t${k} => ${v}`),
      `\t\tXPC_SERVICE_NAME => ${label}`,
      '\t}',
      '',
      `\tdomain = gui/${uidOf(target)} [100017]`,
      '\tasid = 100017',
      '\tminimum runtime = 10',
      '\texit timeout = 5',
      `\truns = ${job.runs || 0}`,
      ...(running ? [`\tpid = ${job.pid}`, '\timmediate reason = speculative'] : []),
      ...(lastLine ? [lastLine] : []),
      '',
      '\tsemaphores = {',
      '\t\tsuccessful exit => 0',
      '\t}',
      '',
      '\tresource coalition = {',
      '\t\tID = 237177',
      '\t\ttype = resource',
      '\t\tstate = active',
      '\t\tactive count = 1',
      `\t\tname = ${label}`,
      '\t}',
      '',
      '\tspawn type = background (5)',
      '\tproperties = runatload | inferred program',
      '}',
    ]
    process.stdout.write(lines.join('\n') + '\n')
    process.exit(0)
  }
  default:
    process.stderr.write(`fake-launchctl: глагол ${verb} не поддержан\n`)
    process.exit(64)
}
