#!/usr/bin/env node
// measure-f1.mjs — замеры приёмки Ф1 (В5) на НАСТОЯЩИХ `claude` и `codex`.
//
//   npm run build && node scripts/measure-f1.mjs [--only a,b,c] [--no-write]
//
// В CI не входит и входить не может: нужны залогиненные CLI, сеть и квота. Запускает лид один
// раз при приёмке; результат — JSONL в stdout (строка на метрику) и таблица в
// docs/11-MEASURE-F1.md (скрипт пишет её сам; `--no-write` — не писать). Ход замера — в stderr.
//
// ЧТО МЕРИТСЯ (docs/07-PLAN-F1.md, В5):
//   a. тёплая реплика: агент `--warm` — p50 трёх реплик после первой; против неё — «процесс на ход»
//      с `--resume` (тоже p50 трёх после первой). Цели: тёплая < 3 с (В2, 07-PLAN), процесс на ход
//      < 4 с (приёмка Ф1 на странице); «тёплая < 2 с» страницы печатается примечанием;
//   b. рестарт демона между репликами (claude и codex): `daemon stop` → `daemon start` → реплика,
//      время до первого события хода по журналу демона и помнит ли разговор, что было до рестарта;
//   c. две параллельные сессии (claude+claude, claude+codex): стена параллельно против суммы
//      последовательно и отсутствие перекрёстных ответов (каждый ответ несёт СВОЙ маркер).
//
// БЕЗОПАСНОСТЬ:
//   * страж страны выхода ПЕРЕД КАЖДЫМ шагом (тот же checkNetwork, что у демона); страна в
//     списке-страже или неизвестна — замер останавливается целиком, код 4, ни одного хода дальше;
//   * PULT_HOME и рабочие папки — mkdtemp во временном каталоге, после прогона сносятся;
//     настоящий ~/.pult не трогается; демон замера гасится на любом исходе;
//   * claude — haiku, усилие low, `--setting-sources user`; codex — усилие low; реплики крошечные
//     (всего ≈ 21 ход);
//   * после прогона сносятся папки ~/.claude/projects, которые ПОЯВИЛИСЬ за прогон и несут имя
//     наших рабочих папок (разговоры замера), — и только они (scripts/measure-f1-lib.mjs,
//     projectsToClean). Записи codex в ~/.codex/sessions скрипт не трогает.
//
// Коды выхода: 0 — все строки ok · 1 — хотя бы одна строка провалена или ни одной строки ·
// 2 — неверный --only · 4 — остановлен стражем · 130/143 — прерван Ctrl+C/SIGTERM (уборка сделана,
// таблица не пишется).

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig } from '../dist/core/config.js'
import { locateTool } from '../dist/env/locate.js'
import { checkNetwork, netLine } from '../dist/env/net.js'
import {
  crossTalk, exitCodeFor, firstEventTimes, guardDecision, onceAsync, p50, parseEventLines, parseOnly,
  projectsToClean, renderMarkdown, signalExitCode, trapSignals, waitGone, warmGain,
} from './measure-f1-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = join(ROOT, 'dist', 'cli', 'main.js')
const OUT_MD = join(ROOT, 'docs', '11-MEASURE-F1.md')

const argv = process.argv.slice(2)
// `--only` без значения — пустая строка, а не «все шаги»: parseOnly её отвергнет.
const onlyArg = argv.find((a) => a.startsWith('--only='))?.slice(7) ?? (argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? '') : null)
const only = parseOnly(onlyArg)
if ('error' in only) {
  // До PULT_TEST и до песочницы: опечатка не должна ни создавать папки, ни «проходить» замер.
  console.error(`measure-f1: ${only.error}`)
  process.exit(2)
}
const ONLY = new Set(only.steps)
const WRITE_MD = !argv.includes('--no-write')

if (process.env.PULT_TEST === '1') {
  // Под PULT_TEST=1 демон подменяет сеть и CLI фальшивками — цифры были бы выдуманными.
  console.error('measure-f1: PULT_TEST=1 — замер идёт только на настоящих CLI; сними переменную')
  process.exit(1)
}
if (!existsSync(CLI)) {
  console.error('measure-f1: нет dist/ — сначала npm run build')
  process.exit(1)
}

const log = (line) => process.stderr.write(`${line}\n`)
const rows = []
const emit = (row) => {
  rows.push(row)
  process.stdout.write(`${JSON.stringify({ type: 'metric', ...row })}\n`)
  log(`  ${row.ok ? 'ok  ' : 'FAIL'} ${row.step} · ${row.provider} · ${row.metric} = ${row.value}${row.unit === 'ms' ? ' мс' : ''}${row.note ? ` (${row.note})` : ''}`)
}

// --- песочница ----------------------------------------------------------------------------
// Короткий PULT_HOME: у unix-сокета на macOS предел 104 байта. realpath — затем, чтобы имя
// папки разговоров claude (он видит реальный путь) совпало с тем, что мы потом ищем.
const home = realpathSync(mkdtempSync(join(tmpdir(), 'pm-')))
const workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pult-mf-')))
const work = {}
for (const k of ['wa', 'ca', 'cx', 'p1', 'p2']) {
  work[k] = realpathSync(mkdtempSync(join(workRoot, `${k}-`)))
  writeFileSync(join(work[k], 'README.md'), `pult measure ${k}\n`)
}
const tokens = [basename(workRoot)]
const PROJECTS = join(homedir(), '.claude', 'projects')
const listProjects = () => { try { return readdirSync(PROJECTS) } catch { return [] } }
const projectsBefore = listProjects()
mkdirSync(join(home, 'run'), { recursive: true })
writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1 }, null, 2))

// Прерывание сигналом: имя сигнала, пока идёт уборка. Шаги после него не начинаются — pult()
// отвечает отказом, иначе `daemon start` из шага b поднял бы демона ПОСЛЕ того, как уборка его
// погасила. Живые дочерние `pult` уборка добивает и дожидается (children).
let interrupted = null
const children = new Map()

/** Асинхронный вызов CLI: параллельный шаг (c) без него невозможен. `cleanup` — вызов из уборки. */
function pult(args, { timeoutMs = 240_000, cleanup = false } = {}) {
  if (interrupted && !cleanup) {
    return Promise.resolve({ code: signalExitCode(interrupted), stdout: '', stderr: `прервано ${interrupted}`, ms: 0, t0: Date.now() })
  }
  let done
  const closed = new Promise((r) => { done = r })
  const p = new Promise((res) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, PULT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    children.set(child, closed)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      children.delete(child)
      done()
      res({ code: code ?? (signal ? 1 : 0), stdout, stderr, ms: Date.now() - t0, t0 })
    })
  })
  return p
}

// Уборка — одна на все исходы: конец прогона (finally) и Ctrl+C/SIGTERM (trapSignals). Без
// ловушки node выходит по сигналу, минуя finally, и отсоединённый демон замера оставался жить.
const cleanup = onceAsync(async () => {
  // Сначала — живые дочерние `pult` (при сигнале): иначе `daemon start`, который уже летит,
  // поднял бы демона после нашего stop.
  for (const child of children.keys()) { try { child.kill('SIGTERM') } catch { /* ушёл */ } }
  await Promise.all(children.values())
  // Демон замера гасится на любом исходе; разговоры замера уходят из ~/.claude/projects.
  const pid = await pult(['daemon', 'status', '--json'], { timeoutMs: 20_000, cleanup: true }).then((r) => {
    try { return JSON.parse(r.stdout).pid ?? null } catch { return null }
  })
  const stop = await pult(['daemon', 'stop'], { timeoutMs: 30_000, cleanup: true })
  log(`daemon stop: код ${stop.code}${pid ? ` (pid ${pid})` : ''}`)
  if (pid) {
    // stop отвечает, как только снят lock, а демон снимает его последним и ещё выходит: ждём
    // с потолком, а не проверяем один раз (одна проверка давала ложный провал в ~20% прогонов).
    const alive = await waitGone(() => { try { process.kill(pid, 0); return true } catch { return false } }, { timeoutMs: 3000 })
    if (alive) {
      log(`демон замера pid ${pid} жив через 3 с после stop — добиваю SIGTERM`)
      try { process.kill(pid, 'SIGTERM') } catch { /* уже ушёл */ }
      emit({ step: 'уборка', provider: 'pult', metric: 'демон замера вышел по daemon stop', value: false, unit: 'bool', ok: false, note: 'добит SIGTERM' })
    }
  }
  const clean = projectsToClean(projectsBefore, listProjects(), tokens)
  for (const name of clean) rmSync(join(PROJECTS, name), { recursive: true, force: true })
  log(`~/.claude/projects: снесено ${clean.length} папок замера${clean.length ? ` (${clean.join(', ')})` : ''}`)
  rmSync(home, { recursive: true, force: true })
  rmSync(workRoot, { recursive: true, force: true })
})
trapSignals(process, {
  cleanup,
  onSignal: (s) => { interrupted = s; log(`ПРЕРВАНО — ${s}: новых шагов нет, убираю за собой (второй Ctrl+C — выйти сразу)`) },
  exit: (code) => process.exit(code),
})

const CLAUDE = ['--kind', 'claude', '--model', 'haiku', '--effort', 'low', '--setting-sources', 'user']
const CODEX = ['--kind', 'codex', '--effort', 'low']
const WAIT = ['--wait', '--timeout', '180000']
const firstLine = (s) => String(s ?? '').trim().split('\n')[0]?.slice(0, 160) ?? ''
const failNote = (r) => `код ${r.code}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'пусто'}`

async function start(name, cwd, kindArgs, extra = []) {
  const r = await pult(['agent', 'start', name, ...kindArgs, '--cwd', cwd, ...extra])
  if (r.code !== 0) throw new Error(`agent start ${name}: ${failNote(r)}`)
}

async function say(name, text) {
  return pult(['agent', 'prompt', name, text, ...WAIT])
}

/**
 * Курсор журнала демона. null — не узнали: тогда шаг b проваливается, а не читает журнал с 0
 * (с нуля пришёл бы и прошлый ход, и «первое событие» оказалось бы чужим).
 */
async function lastEventId() {
  const r = await pult(['daemon', 'status', '--json'], { timeoutMs: 20_000 })
  if (r.code !== 0) return null
  try {
    const id = JSON.parse(r.stdout).lastEventId
    return Number.isInteger(id) && id >= 0 ? id : null
  } catch { return null }
}

// --- страж перед каждым шагом ------------------------------------------------------------
const cfg = defaultConfig()
let egress = 'не проверен'
class GuardStop extends Error {}
async function guard(step, providers) {
  if (interrupted) throw new Error(`прервано ${interrupted}`)
  for (const provider of providers) {
    const check = await checkNetwork(provider, cfg.network[provider], cfg.guard, { fresh: true })
    const d = guardDecision(check, cfg.guard.mode === 'deny' ? cfg.guard.countries : [])
    log(`страж перед ${step}: ${netLine(check)} → ${d.go ? 'идём' : 'СТОП'} (${d.why})`)
    process.stdout.write(`${JSON.stringify({ type: 'guard', step, provider, loc: check.loc, go: d.go, why: d.why })}\n`)
    if (!d.go) throw new GuardStop(`${step}/${provider}: ${d.why}`)
    egress = d.why
  }
}

// --- a. тёплая реплика против «процесса на ход» ------------------------------------------
async function stepA() {
  await guard('a', ['claude'])
  log('a. тёплая реплика')
  const series = async (name, cwd, extra) => {
    await start(name, cwd, CLAUDE, extra)
    const first = await say(name, 'Remember the word APRICOT. Reply with exactly OK.')
    if (first.code !== 0) return { first, rest: [], context: false, fail: failNote(first) }
    const rest = []
    for (const text of ['Reply with exactly OK.', 'Reply with exactly OK.', 'What word did I ask you to remember? One word.']) {
      const r = await say(name, text)
      if (r.code !== 0) return { first, rest, context: false, fail: failNote(r) }
      rest.push(r)
    }
    return { first, rest, context: /apricot/i.test(rest[rest.length - 1].stdout), fail: null }
  }
  const warm = await series('wa', work.wa, ['--warm'])
  await pult(['agent', 'stop', 'wa'], { timeoutMs: 30_000 })
  const cold = await series('ca', work.ca, [])
  const warmP50 = p50(warm.rest.map((r) => r.ms))
  const coldP50 = p50(cold.rest.map((r) => r.ms))
  emit({ step: 'a', provider: 'claude', metric: 'первая реплика --warm (со стартом процесса)', value: warm.first.ms, unit: 'ms', ok: warm.first.code === 0, note: warm.first.code === 0 ? '' : failNote(warm.first) })
  emit({ step: 'a', provider: 'claude', metric: 'тёплая реплика, p50 из 3', value: warmP50, unit: 'ms', ok: !warm.fail && warmP50 !== null && warmP50 < 3000, note: warm.fail ?? 'цель В2: < 3 с (страница Ф1: < 2 с)' })
  emit({ step: 'a', provider: 'claude', metric: 'реплика --resume (процесс на ход), p50 из 3', value: coldP50, unit: 'ms', ok: !cold.fail && coldP50 !== null && coldP50 < 4000, note: cold.fail ?? 'цель страницы Ф1: < 4 с с холодным стартом' })
  emit({ step: 'a', provider: 'claude', metric: 'выигрыш тёплого процесса', unit: 'ms', ...warmGain({ warmP50, coldP50, warmFail: warm.fail, coldFail: cold.fail }) })
  emit({ step: 'a', provider: 'claude', metric: 'контекст помнится (warm / resume)', value: `${warm.context ? 'да' : 'нет'} / ${cold.context ? 'да' : 'нет'}`, unit: 'text', ok: warm.context && cold.context })
}

// --- b. рестарт демона между репликами -----------------------------------------------------
async function restartOnce(provider, name, word) {
  const stop = await pult(['daemon', 'stop'], { timeoutMs: 30_000 })
  if (stop.code !== 0) return { fail: `daemon stop: ${failNote(stop)}` }
  const up = await pult(['daemon', 'start'], { timeoutMs: 30_000 })
  if (up.code !== 0) return { fail: `daemon start: ${failNote(up)}` }
  const since = await lastEventId()
  if (since === null) return { fail: 'daemon status после рестарта: курсор журнала неизвестен', startMs: up.ms }
  const r = await say(name, 'What word did I ask you to remember? One word.')
  if (r.code !== 0) return { fail: `реплика после рестарта: ${failNote(r)}`, startMs: up.ms }
  const read = await pult(['agent', 'read', name, '--since', String(since), '--format', 'json'], { timeoutMs: 20_000 })
  const times = firstEventTimes(parseEventLines(read.stdout), since, r.t0)
  return { startMs: up.ms, turnMs: r.ms, ...times, context: new RegExp(word, 'i').test(r.stdout), fail: null, provider }
}

async function stepB() {
  // claude: агент `ca` из шага a уже помнит APRICOT; без шага a — свой первый ход.
  await guard('b', ['claude', 'codex'])
  log('b. рестарт демона')
  if (!ONLY.has('a')) {
    await start('ca', work.ca, CLAUDE)
    const first = await say('ca', 'Remember the word APRICOT. Reply with exactly OK.')
    if (first.code !== 0) throw new Error(`b/claude первый ход: ${failNote(first)}`)
  }
  await start('cx', work.cx, CODEX)
  const firstCx = await say('cx', 'Remember the word BASALT. Reply with exactly OK.')
  for (const [provider, name, word, pre] of [['claude', 'ca', 'apricot', null], ['codex', 'cx', 'basalt', firstCx]]) {
    await guard(`b/${provider}`, [provider])
    const res = pre && pre.code !== 0 ? { fail: `первый ход: ${failNote(pre)}` } : await restartOnce(provider, name, word)
    const ok = !res.fail
    emit({ step: 'b', provider, metric: 'daemon start после stop', value: res.startMs ?? null, unit: 'ms', ok: ok || res.startMs !== undefined, note: res.fail ?? '' })
    emit({ step: 'b', provider, metric: 'до первого события хода после рестарта', value: res.firstEventMs ?? null, unit: 'ms', ok: ok && res.firstEventMs !== null, note: res.firstKind ? `первое событие: ${res.firstKind}` : '' })
    emit({ step: 'b', provider, metric: 'до первого события модели', value: res.firstModelMs ?? null, unit: 'ms', ok: ok && res.firstModelMs !== null, note: 'message.* или tool.called' })
    emit({ step: 'b', provider, metric: 'реплика целиком после рестарта', value: res.turnMs ?? null, unit: 'ms', ok })
    emit({ step: 'b', provider, metric: 'разговор пережил рестарт', value: res.context ?? false, unit: 'bool', ok: ok && res.context === true })
  }
}

// --- c. две параллельные сессии -------------------------------------------------------------
const mark = (tag) => `MARK-${tag}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
const ask = (m) => `Reply with exactly this token and nothing else: ${m}`

async function pair(label, a, b) {
  await guard(`c/${label}`, [...new Set([a.provider, b.provider])])
  // Последовательно.
  const [sa, sb] = [mark('A'), mark('B')]
  const ra = await say(a.name, ask(sa))
  const rb = await say(b.name, ask(sb))
  const seqMs = ra.ms + rb.ms
  const seqCt = crossTalk(ra.stdout, sa, rb.stdout, sb)
  // Параллельно: обе реплики уходят разом, стена — от первого старта до последнего конца.
  const [pa, pb] = [mark('A'), mark('B')]
  const t0 = Date.now()
  const [qa, qb] = await Promise.all([say(a.name, ask(pa)), say(b.name, ask(pb))])
  const parMs = Date.now() - t0
  const parCt = crossTalk(qa.stdout, pa, qb.stdout, pb)
  const codesOk = [ra, rb, qa, qb].every((r) => r.code === 0)
  const bad = [ra, rb, qa, qb].find((r) => r.code !== 0)
  const prov = `${a.provider}+${b.provider}`
  emit({ step: 'c', provider: prov, metric: 'последовательно, сумма двух реплик', value: seqMs, unit: 'ms', ok: codesOk, note: bad ? failNote(bad) : '' })
  emit({ step: 'c', provider: prov, metric: 'параллельно, стена', value: parMs, unit: 'ms', ok: codesOk && parMs < seqMs, note: 'цель: быстрее суммы' })
  emit({ step: 'c', provider: prov, metric: 'ускорение (последовательно / параллельно)', value: parMs > 0 ? seqMs / parMs : null, unit: 'x', ok: codesOk })
  emit({ step: 'c', provider: prov, metric: 'без перекрёстных ответов', value: seqCt.ok && parCt.ok, unit: 'bool', ok: codesOk && seqCt.ok && parCt.ok, note: parCt.ok && seqCt.ok ? '' : `свой A/B: ${parCt.ownA}/${parCt.ownB}, чужой: ${parCt.foreign || seqCt.foreign}` })
}

async function stepC() {
  log('c. две параллельные сессии')
  await guard('c', ['claude', 'codex'])
  // Разогрев: первая реплика нового агента дороже (заводится разговор) и исказила бы сравнение.
  await start('p1', work.p1, CLAUDE)
  await start('p2', work.p2, CLAUDE)
  for (const n of ['p1', 'p2']) {
    const r = await say(n, 'Reply with exactly OK.')
    if (r.code !== 0) throw new Error(`c разогрев ${n}: ${failNote(r)}`)
  }
  if (!ONLY.has('b')) {
    await start('cx', work.cx, CODEX)
    const r = await say('cx', 'Reply with exactly OK.')
    if (r.code !== 0) throw new Error(`c разогрев cx: ${failNote(r)}`)
  }
  await pair('claude+claude', { name: 'p1', provider: 'claude' }, { name: 'p2', provider: 'claude' })
  await pair('claude+codex', { name: 'p1', provider: 'claude' }, { name: 'cx', provider: 'codex' })
}

// --- прогон ---------------------------------------------------------------------------------
const versionOf = (name) => {
  const t = locateTool(name, { pathEntries: (process.env.PATH ?? '').split(':').filter(Boolean) })
  return t.version ? firstLine(t.version) : 'не найден'
}
const versions = { claude: versionOf('claude'), codex: versionOf('codex'), node: process.version }
log(`PULT_HOME=${home}\nрабочие папки: ${workRoot}\nверсии: ${JSON.stringify(versions)}`)

let aborted = null
let exitCode = 0
try {
  if (ONLY.has('a')) await stepA()
  if (ONLY.has('b')) await stepB()
  if (ONLY.has('c')) await stepC()
} catch (e) {
  if (e instanceof GuardStop) {
    aborted = `страж: ${e.message}`
    exitCode = 4
  } else {
    aborted = `ошибка: ${e instanceof Error ? e.message : String(e)}`
    exitCode = 1
  }
  log(`ПРЕРВАНО — ${aborted}`)
} finally {
  await cleanup()
}
// Прерван сигналом: цифры неполные, таблицу не пишем; выход тем же кодом, что у ловушки.
if (interrupted) process.exit(signalExitCode(interrupted))

const date = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
const md = renderMarkdown(rows, { date, versions, egress, aborted, steps: [...ONLY] })
if (WRITE_MD) {
  writeFileSync(OUT_MD, md)
  log(`таблица записана: ${OUT_MD}`)
}
const failed = rows.filter((r) => !r.ok).length
const code = exitCodeFor(rows, exitCode)
process.stdout.write(`${JSON.stringify({ type: 'summary', steps: [...ONLY], rows: rows.length, failed, aborted, exitCode: code })}\n`)
// Ни одна строка не может быть пропущена молча: провал любой или пустой замер — ненулевой код.
process.exit(code)
