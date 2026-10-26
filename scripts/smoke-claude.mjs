#!/usr/bin/env node
// smoke-claude.mjs — дымовой прогон В2 на НАСТОЯЩЕМ `claude`.
//
//   npm run smoke:claude
//
// В CI не входит и входить не должен: нужен залогиненный `claude`, сеть до api.anthropic.com
// и квота подписки. Запускает лид руками при приёмке вехи.
//
// ЧТО ПРОВЕРЯЕТСЯ (каждый шаг печатается в отчёт):
//   1. `pult agent start --warm` + `prompt --wait` — модель отвечает (холодный старт);
//   2. вторая реплика помнит контекст И меряет выигрыш тёплого процесса;
//   3. круг разрешений: ход упирается в вопрос, `pult perm deny` отказывает, второй ход
//      разрешается через `pult perm approve`, и правка реально применяется к файлу;
//   4. `pult agent tree` показывает субагента;
//   5. `pult usage` показывает ОБА окна лимита;
//   6. `pult agent stop` и остановка демона; ни одного осиротевшего процесса.
//
// ПОЧЕМУ ОДИН АГЕНТ В РЕЖИМЕ --warm, а не два агента. Бюджет прогона — ПЯТЬ крошечных ходов
// haiku, и отдельный тёплый агент стоил бы ещё двух. Тёплый режим меряется теми же ходами 1 и
// 2: первый включает старт процесса, второй идёт в уже живой. Режим «процесс на ход» с
// `--resume` проверен на настоящем CLI при записи фикстуры 03-resume-* и герметичным тестом
// «второй ход идёт с --resume и тем же uuid».
//
// БЕЗОПАСНОСТЬ: PULT_HOME — во временной папке (короткий путь: у unix-сокета на macOS предел
// 104 байта), cwd ходов — одноразовый git-репозиторий, который скрипт сам создаёт и сносит.
// Настоящий ~/.pult не трогается. Страж страны выхода — тот же код, что у адаптера.
// Модель haiku, усилие low, `--setting-sources user`. Бюджет — 5 крошечных ходов.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig } from '../dist/core/config.js'
import { buildChildEnv } from '../dist/env/allowlist.js'
import { checkNetwork, netLine } from '../dist/env/net.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CLI = join(ROOT, 'dist', 'cli', 'main.js')

const home = mkdtempSync(join(tmpdir(), 'ps-'))
const work = mkdtempSync(join(tmpdir(), 'pult-smoke-'))
const report = []
const say = (line) => { console.log(line); report.push(line) }

/**
 * ОЖИДАНИЯ, БЕЗ КОТОРЫХ ПРОГОН НЕ УМЕЕТ ПАДАТЬ (правка по ревью В3). Ровно этим болел
 * дымовой прогон Codex: пять шагов из восемнадцати вернули код 1 с пустым ответом, а скрипт
 * напечатал отчёт и вышел с нулём. Здесь та же болезнь лечится тем же способом: у каждой
 * проверки явное ожидание, при провале печатается stderr шага, а в конце — ненулевой код.
 */
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

function pult(args, { timeoutMs = 180_000 } = {}) {
  const t0 = Date.now()
  const r = spawnSyncish(args, timeoutMs)
  return { ...r, ms: Date.now() - t0 }
}

function spawnSyncish(args, timeoutMs) {
  const res = execFileSyncSafe(process.execPath, [CLI, ...args], {
    env: { ...process.env, PULT_HOME: home },
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  return res
}

function execFileSyncSafe(file, args, opts) {
  try {
    const stdout = execFileSync(file, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

function sandbox() {
  writeFileSync(join(work, 'README.md'), 'pult smoke sandbox\n')
  writeFileSync(join(work, 'note.txt'), 'before\n')
  const env = buildChildEnv(process.env, { extra: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work, env })
  execFileSync('git', ['-c', 'user.name=pult', '-c', 'user.email=pult@localhost', 'add', '-A'], { cwd: work, env })
  execFileSync('git', ['-c', 'user.name=pult', '-c', 'user.email=pult@localhost', 'commit', '-qm', 'smoke'], { cwd: work, env })
}

async function guard() {
  const cfg = defaultConfig()
  const check = await checkNetwork('claude', cfg.network.claude, cfg.guard, { fresh: true })
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

process.on('exit', () => { /* cleanup зовётся явно, здесь только страховка от мусора */ })

// --- прогон -------------------------------------------------------------------
sandbox()
mkdirSync(join(home, 'run'), { recursive: true })
// Отсрочка на фонового субагента короче обычной: дымовой прогон не должен ждать полминуты.
writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, subagentGraceMs: 8000 }, null, 2))
await guard()

say(`PULT_HOME=${home}`)
say(`cwd ходов=${work}`)

const start = pult(['agent', 'start', 'w', '--kind', 'claude', '--cwd', work, '--model', 'haiku', '--effort', 'low', '--setting-sources', 'user', '--warm'])
say(`1. agent start: код ${start.code}, ${start.ms} мс — ${start.stdout.trim() || start.stderr.trim()}`)
expect(start.code === 0, 'agent start не отработал', start)

const t1 = pult(['agent', 'prompt', 'w', 'Remember the number 41. Reply with exactly OK.', '--wait'])
say(`2. первая реплика: код ${t1.code}, ${t1.ms} мс, ответ «${t1.stdout.trim()}»`)
expect(t1.code === 0, 'первая реплика вернула ненулевой код', t1)
expect(t1.stdout.trim().length > 0, 'первая реплика вернула ПУСТОЙ ответ', t1)

const t2 = pult(['agent', 'prompt', 'w', 'What number did I ask you to remember? Digits only.', '--wait'])
const remembered = /41/.test(t2.stdout)
say(`3. контекст: код ${t2.code}, ${t2.ms} мс, ответ «${t2.stdout.trim()}» — помнит: ${remembered ? 'ДА' : 'НЕТ'}`)
expect(t2.code === 0, 'вторая реплика вернула ненулевой код', t2)
expect(remembered, 'вторая реплика НЕ помнит контекст', t2)
say(`3a. тёплый режим: первая реплика (со стартом процесса) ${t1.ms} мс, вторая ${t2.ms} мс — выигрыш ${t1.ms - t2.ms} мс`)

// --- круг разрешений: ход уходит в фон, решение принимает человек (здесь — скрипт) ---
const permRun = pult(['agent', 'prompt', 'w', 'Use the Edit tool on note.txt in the current directory: replace "before" with "SMOKE". Then reply with one word.', '--json'])
say(`4. ход с правкой запущен: ${permRun.stdout.trim()}`)

const waitPending = async (ms = 90_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const r = pult(['perm', 'list', '--json'], { timeoutMs: 20_000 })
    try {
      const parsed = JSON.parse(r.stdout)
      if (parsed.pending?.length) return parsed.pending[0]
    } catch { /* демон ещё поднимается */ }
    if (Date.now() > deadline) return null
    await new Promise((res) => setTimeout(res, 500))
  }
}

const pending = await waitPending()
if (pending) {
  say(`5. Inbox: ${pending.id} · ${pident(pending)} · ждёт ${Math.round(pending.waitingMs / 1000)} с`)
  const deny = pult(['perm', 'deny', pending.id, '--reason', 'дымовой прогон: сначала отказ'])
  say(`6. perm deny: код ${deny.code} — ${deny.stdout.trim()}`)
} else {
  // Раньше здесь было «ВНИМАНИЕ», и прогон продолжался как ни в чём не бывало.
  expect(false, '5. запрос разрешения НЕ появился — проверь --permission-prompt-tool')
}
const afterDeny = pult(['agent', 'wait', 'w', '--timeout', '120000'])
const noteAfterDeny = readFileSync(join(work, 'note.txt'), 'utf8').trim()
say(`7. ход после отказа: код ${afterDeny.code}, ответ «${afterDeny.stdout.trim().slice(0, 120)}», файл: «${noteAfterDeny}»`)
expect(noteAfterDeny !== 'SMOKE', 'файл изменён ВОПРЕКИ отказу', afterDeny)

const permRun2 = pult(['agent', 'prompt', 'w', 'Use the Edit tool on note.txt in the current directory: replace "before" with "SMOKE". Then reply with one word.', '--json'])
say(`8. второй ход с правкой запущен: ${permRun2.stdout.trim()}`)
const pending2 = await waitPending()
if (pending2) {
  const approve = pult(['perm', 'approve', pending2.id])
  say(`9. perm approve: код ${approve.code} — ${approve.stdout.trim()}`)
  expect(approve.code === 0, 'perm approve не отработал', approve)
} else {
  expect(false, '9. второй запрос разрешения НЕ появился')
}
const afterAllow = pult(['agent', 'wait', 'w', '--timeout', '120000'])
const noteAfter = readFileSync(join(work, 'note.txt'), 'utf8').trim()
say(`10. ход после разрешения: код ${afterAllow.code}, файл: «${noteAfter}» — правка применена: ${noteAfter === 'SMOKE' ? 'ДА' : 'НЕТ'}`)
expect(noteAfter === 'SMOKE', 'правка НЕ применена после разрешения', afterAllow)

// --- субагент и дерево ---------------------------------------------------------
const sub = pult(['agent', 'prompt', 'w', 'Use the Agent tool to spawn exactly one subagent of type Explore whose entire job is to reply with the single word OK. Do not do the work yourself. Then reply DONE.', '--wait', '--timeout', '180000'], { timeoutMs: 240_000 })
say(`11. субагент: код ${sub.code}, ${sub.ms} мс, ответ «${sub.stdout.trim().slice(0, 160)}»`)
expect(sub.code === 0, 'ход с субагентом вернул ненулевой код', sub)
const tree = pult(['agent', 'tree', 'w'])
expect(/Agent\(/.test(tree.stdout), 'в дереве нет субагента', tree)
say('12. дерево:')
for (const line of tree.stdout.trim().split('\n')) say(`    ${line}`)

// --- расход --------------------------------------------------------------------
const usage = pult(['usage'])
say('13. расход:')
for (const line of usage.stdout.trim().split('\n')) say(`    ${line}`)

// --- остановка ------------------------------------------------------------------
say(`14. agent stop: код ${pult(['agent', 'stop', 'w']).code}`)
const list = pult(['agent', 'list'])
say('15. список агентов:')
for (const line of list.stdout.trim().split('\n')) say(`    ${line}`)

const stop = pult(['daemon', 'stop'])
say(`16. daemon stop: код ${stop.code} — ${stop.stdout.trim()}`)

const leftovers = execFileSyncSafe('/bin/sh', ['-c', `pgrep -fl 'claude .*--session-id|pultd|dist/daemon/main.js' | grep -v pgrep || true`], { encoding: 'utf8' })
say(`17. осиротевшие процессы: ${leftovers.stdout.trim() || 'нет'}`)
expect(leftovers.stdout.trim() === '', 'после остановки остались осиротевшие процессы')

rmSync(home, { recursive: true, force: true })
rmSync(work, { recursive: true, force: true })
say('18. временные PULT_HOME и песочница снесены')

function pident(p) {
  return `${p.toolName} ${JSON.stringify(p.input).slice(0, 120)}`
}

say(`\n${checks - failed}/${checks} проверок прошло${failed ? `, ПРОВАЛЕНО ${failed}` : ''}`)
console.log('\n=== ОТЧЁТ ДЫМОВОГО ПРОГОНА ===')
console.log(report.join('\n'))
// Ненулевой код выхода — единственное, что отличает прогон-проверку от прогона-открытки.
process.exit(failed === 0 ? 0 : 1)
