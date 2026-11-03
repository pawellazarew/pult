#!/usr/bin/env node
// fake-zcode.mjs — фальшивый `zcode` для герметичных тестов.
//
// Он НЕ имитирует модель: он проигрывает СЫРЫЕ записи настоящего CLI из test/fixtures/zcode/
// (записаны 02.11.2026, CLI 0.17.1). Маршрут A: реплика — аргументом `-p`, процесс на ход,
// stdin не читается вовсе. Поэтому цикла по stdin, как у fake-claude, нет: один запуск — один ход.
//
// ЧТО ОН УМЕЕТ:
//   * ЗАПИСАТЬ свой argv, cwd и окружение в файл (PULT_FAKE_ARGV_OUT) — по нему тесты
//     проверяют контракт argv (режим `--mode`, `--resume`, ни одного лишнего флага);
//   * выбрать сценарий из PULT_FAKE_SCENARIO, из `<cwd>/.pult-fake.json` или из МЕТКИ в тексте
//     реплики (`[[scenario]]`);
//   * `--version` — ответить как настоящий CLI (каталог провайдеров зовёт его без квоты).
//
// СЦЕНАРИИ-ОШИБКИ (файлов не требуют — stderr настоящего CLI не поток, а `Error: …` + exit 1):
//   not-logged-in  отказ входа (`not_authenticated`) — провайдер останавливается целиком;
//   quota          `quota_exceeded` — ход падает, статус limited, провайдер жив;
//   no-session     `--resume` на несуществующий разговор — самолечение: `started` снимается.
//
// Окружение (ручной запуск):
//   PULT_FAKE_SCENARIO   simple|tool|resume|cancelled|not-logged-in|quota|no-session|hang|deaf
//   PULT_FAKE_ARGV_OUT   файл: сюда дописывается JSON {argv, cwd, env, pid}
//   PULT_FAKE_SPEED      делитель пауз (по умолчанию 0 — без пауз)
//   PULT_FAKE_HANG       мс: молчать столько до первого события (тест таймаутов стража)
//   PULT_FAKE_DEAF       1: НЕ реагировать на SIGINT/SIGTERM — застрявший процесс, уходит по SIGKILL

import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(HERE, '..', 'fixtures', 'zcode')

let fileCfg = {}
try { fileCfg = JSON.parse(readFileSync(join(process.cwd(), '.pult-fake.json'), 'utf8')) } catch { fileCfg = {} }

const cfg = {
  scenario: process.env.PULT_FAKE_SCENARIO ?? fileCfg.scenario ?? 'simple',
  argvOut: process.env.PULT_FAKE_ARGV_OUT ?? fileCfg.argvOut ?? null,
  speed: Number(process.env.PULT_FAKE_SPEED ?? fileCfg.speed ?? 0) || 0,
  hang: Number(process.env.PULT_FAKE_HANG ?? fileCfg.hang ?? 0) || 0,
  deaf: (process.env.PULT_FAKE_DEAF ?? String(fileCfg.deaf ?? '')) === '1',
}

const argv = process.argv.slice(2)
if (argv[0] === '--version') {
  process.stdout.write('zcode 0.17.1\n')
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
const prompt = flag('-p') ?? flag('--prompt') ?? ''

/** Метка в реплике важнее переменной: один тест может гонять несколько сценариев подряд. */
function scenarioFromText(text) {
  const m = /\[\[([a-z-]+)\]\]/.exec(String(text || ''))
  return m ? m[1] : null
}
const marked = scenarioFromText(prompt)
if (marked) cfg.scenario = marked

const fail = (code, message) => {
  process.stderr.write(`Error: ${message} (traceId: 00000000-0000-4000-8000-000000000000)\n`)
  process.exitCode = 1
  void code
}

/** Файл фикстуры целиком: у маршрута A один процесс — один ход, резать поток на ходы не нужно. */
function play(name) {
  const base = isAbsolute(name) ? name : join(FIXTURES, name)
  const lines = readFileSync(`${base}.jsonl`, 'utf8').split('\n').filter((l) => l.trim())
  let timing = []
  try { timing = JSON.parse(readFileSync(`${base}.timing.json`, 'utf8')) } catch { timing = [] }
  let prev = 0
  for (let i = 0; i < lines.length; i++) {
    const ms = timing[i] ?? i * 10
    const gap = cfg.speed > 0 ? Math.max(0, Math.round((ms - prev) / cfg.speed)) : 0
    prev = ms
    if (gap > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, gap)
    process.stdout.write(lines[i] + '\n')
  }
}

// Глухой процесс: слушатели есть, выхода нет — сигнал «проглатывается», уходит только по SIGKILL.
if (cfg.deaf) {
  process.on('SIGTERM', () => {})
  process.on('SIGINT', () => {})
  setInterval(() => {}, 1000)
  setTimeout(() => process.exit(0), 60_000)
} else {
  // Как настоящий CLI (замер 02.11.2026): SIGINT → turn.completed cancelled, stderr, exit 130.
  process.on('SIGINT', () => {
    process.stdout.write(JSON.stringify({
      eventId: 'evt-cancelled-0001', payload: { response: '', tokenCount: 0, usage: null, toolCallCount: 0, historyRoundCount: 1, duration: 0, resultType: 'cancelled' },
      seq: 999, sessionId: 'sess_cancelled-00000000-0000-4000-8000-000000000000', timestamp: Date.now(),
      traceId: 'trace-cancelled', turnId: 'turn_cancelled-00000000-0000-4000-8000-000000000000', type: 'turn.completed',
    }) + '\n')
    process.stderr.write('Error: Turn was cancelled. (traceId: trace-cancelled)\n')
    process.exit(130)
  })
  process.on('SIGTERM', () => process.exit(143))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const run = async () => {
  if (cfg.hang > 0) await sleep(cfg.hang)
  switch (cfg.scenario) {
    case 'simple':
      play('01-simple-turn')
      return 0
    case 'tool':
      play('02-tool-turn')
      return 0
    case 'resume':
      play('03-resume-turn2')
      return 0
    // Фикстура 04 — то, что настоящий CLI успел напечатать до SIGINT; здесь она не играет роли
    // (сценарий `cancelled` — это про поведение ПО сигналу, см. обработчик выше), но пусть будет
    // доступна для проверки разбора `turn.completed cancelled`.
    case 'cancelled':
      play('04-cancelled')
      process.stderr.write('Error: Turn was cancelled. (traceId: trace-cancelled)\n')
      return 130
    case 'not-logged-in':
      fail('auth', 'not_authenticated: No available models. Configure a provider or sign in with /login.')
      return 1
    case 'quota':
      fail('quota', 'quota_exceeded: request rejected by provider (429)')
      return 1
    case 'no-session':
      fail('resume', 'Session not found: sess_dead-00000000-0000-4000-8000-000000000000')
      return 1
    case 'hang':
      await sleep(60_000)
      return 0
    default:
      play('01-simple-turn')
      return 0
  }
}

run().then((code) => {
  // Даём stdout дописаться: process.exit() обрезал бы последнюю строку `result`.
  process.stdout.write('', () => process.exit(code))
}).catch(() => process.exit(1))
