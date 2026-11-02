// Адаптер ZCode (маршрут A) на ФАЛЬШИВОМ CLI, который проигрывает живые записи.
// Ни одного настоящего хода, ни одного обращения в сеть: страж инъецируется.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createZcodeAdapter } from '../dist/adapters/zcode/adapter.js'
import { ZCODE_ENV_PASS } from '../dist/adapters/zcode/adapter.js'
import type { ProviderAdapter } from '../dist/adapters/types.js'
import { defaultConfig } from '../dist/core/config.js'
import type { PultConfig } from '../dist/core/config.js'
import type { EventDraft } from '../dist/core/events.js'
import { createLogger } from '../dist/core/log.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { NetCheck } from '../dist/env/net.js'
import { FAKE_ZCODE, waitFor } from './helpers.js'

interface Rig {
  adapter: ProviderAdapter
  drafts: EventDraft[]
  cwd: string
  argvFile: string
  runs(): Array<{ argv: string[]; cwd: string; env: Record<string, string>; pid: number }>
  retune(cfg: Record<string, unknown>): void
  remove(): void
}

const okCheck = (over: Partial<NetCheck> = {}): NetCheck => ({
  provider: 'zcode', mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true,
  reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1,
  checkedAt: '2026-11-02T10:00:00.000Z', cached: false, ...over,
})

function rig(opts: {
  scenario: string
  config?: Partial<PultConfig>
  net?: (provider: 'zcode') => Promise<NetCheck>
  bin?: string
  deaf?: boolean
  hang?: number
}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'pt-zc-'))
  const paths = layout(join(dir, 'h'))
  ensureLayout(paths)
  const cwd = join(dir, 'work')
  const argvFile = join(dir, 'argv.jsonl')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({
    scenario: opts.scenario, argvOut: argvFile, speed: 0,
    ...(opts.deaf ? { deaf: '1' } : {}),
    ...(opts.hang ? { hang: opts.hang } : {}),
  }))
  const drafts: EventDraft[] = []
  const adapter = createZcodeAdapter({
    config: { ...defaultConfig(), ...(opts.config ?? {}) },
    logger: createLogger(paths.logFile),
    bin: opts.bin ?? FAKE_ZCODE,
    emit: (d) => { drafts.push(d) },
    askPermission: async () => ({ behavior: 'deny', message: 'тест' }),
    ...(opts.net ? { netCheck: opts.net } : { netCheck: async () => okCheck() }),
  })
  return {
    adapter, drafts, cwd, argvFile,
    runs: () => (existsSync(argvFile)
      ? readFileSync(argvFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as never)
      : []),
    retune: (cfg) => {
      writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ argvOut: argvFile, speed: 0, ...cfg }))
    },
    remove: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}

const spec = (r: Rig, over: Record<string, unknown> = {}) => ({
  name: 'w', cwd: r.cwd, mode: 'turn' as const, broker: false, ...over,
})

describe('адаптер zcode: ход и события', () => {
  it('ход проходит: ответ в done, session.started один, статус idle, расход и контекст в журнале', async () => {
    const r = rig({ scenario: 'simple' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'число?')
      const outcome = await turn.done
      assert.equal(outcome.ok, true)
      assert.equal(outcome.text, '4711')
      assert.equal(r.drafts.filter((d) => d.kind === 'session.started').length, 1)
      assert.ok(r.drafts.some((d) => d.kind === 'usage.updated'))
      assert.ok(r.drafts.some((d) => d.kind === 'context.updated'))
      const statuses = r.drafts.filter((d) => d.kind === 'status.changed').map((d) => d.data!['status'])
      assert.deepEqual(statuses, ['working', 'idle'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('argv ребёнка — маршрут A: реплика в argv (у -p нет stdin), без --model и лишних флагов', async () => {
    const r = rig({ scenario: 'simple' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'СЕКРЕТНАЯ РЕПЛИКА про деньги', { approval: 'workspace' })
      await turn.done
      const runs = r.runs()
      assert.equal(runs.length, 1)
      const argv = runs[0]!.argv
      assert.equal(argv[0], '-p')
      // Реплика идёт в argv ПЕРВОЙ строкой промпта (у -p нет stdin), контекст режима — второй
      // частью того же аргумента: у zcode нет stdin-блока, как у claude.
      assert.ok(argv[1]!.startsWith('СЕКРЕТНАЯ РЕПЛИКА про деньги\n'))
      assert.match(argv[1]!, /pult_runtime_context/)
      assert.equal(argv.filter((a) => a === '-p').length, 1)
      assert.equal(argv[argv.indexOf('--mode') + 1], 'edit')
      assert.equal(argv[argv.indexOf('--surface') + 1], 'terminal')
      assert.ok(!argv.includes('--model'))
      // Окружение ребёнка — белый список: никаких PULT_*; ZCODE_ — только осознанный проброс
      // конфига (ZCODE_ENV_PASS), не креды и не ключи.
      assert.ok(Object.keys(runs[0]!.env).every((k) => !k.startsWith('PULT_')))
      assert.ok(Object.keys(runs[0]!.env).every((k) => !k.startsWith('ZCODE_') || ZCODE_ENV_PASS.includes(k)))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('второй ход — с --resume <sessionId из потока>; ответ хода 2 доходит', async () => {
    const r = rig({ scenario: 'simple' })
    try {
      await r.adapter.startSession(spec(r))
      await (await r.adapter.send('w', 'первый')).done
      const firstRun = r.runs()[0]!.argv
      assert.ok(!firstRun.includes('--resume'))
      r.retune({ scenario: 'resume' })
      const second = await r.adapter.send('w', 'второй')
      const outcome = await second.done
      assert.equal(outcome.ok, true)
      assert.equal(outcome.text, '420')
      // resume идёт с sessionId, который адаптер УЗНАЛ из потока первого хода (фикстура 01).
      const secondRun = r.runs()[1]!.argv
      assert.equal(secondRun[secondRun.indexOf('--resume') + 1], 'sess_38c5e2d9-5a0f-4f1e-8f81-133b52ab6087')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ход с инструментом: tool.called/tool.finished в журнале, фазы живые', async () => {
    const r = rig({ scenario: 'tool' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'прочитай note.txt')
      const outcome = await turn.done
      assert.equal(outcome.ok, true)
      assert.equal(outcome.text, '42')
      assert.ok(r.drafts.some((d) => d.kind === 'tool.called'))
      assert.ok(r.drafts.some((d) => d.kind === 'tool.finished'))
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('адаптер zcode: стоп и срывы', () => {
  it('agent stop во время хода: ход завершается interrupted, статус пишет менеджер (не адаптер)', async () => {
    const r = rig({ scenario: 'simple', hang: 2000 })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'долгий ход')
      await r.adapter.interrupt('w')
      const outcome = await turn.done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'interrupted')
      // Адаптер не пишет статус interrupted — это делает менеджер (контракт).
      assert.ok(!r.drafts.some((d) => d.kind === 'status.changed' && d.data!['status'] === 'interrupted'))
      assert.ok(!r.drafts.some((d) => d.kind === 'status.changed' && d.data!['status'] === 'failed'))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('глухой процесс: лестница до SIGKILL, ход заканчивается, процесс умирает', async () => {
    const r = rig({ scenario: 'simple', deaf: true, hang: 30_000 })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'застрявший ход')
      // SIGINT раньше загрузки node убил бы фейк до регистрации «глухих» обработчиков — ждём
      // записанного argv: процесс жив и готов игнорировать сигналы (тот же приём, что у claude).
      assert.ok(await waitFor(() => r.runs().length === 1, 20_000), 'процесс должен был запуститься')
      await r.adapter.interrupt('w')
      const outcome = await turn.done
      assert.equal(outcome.errorCode, 'interrupted')
      const pid = r.runs()[0]!.pid
      assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } }, 5000))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('отказ входа: провайдер останавливается ЦЕЛИКОМ, вторая реплика отказывает до старта', async () => {
    const r = rig({ scenario: 'not-logged-in' })
    try {
      await r.adapter.startSession(spec(r))
      const first = await r.adapter.send('w', 'ход без входа')
      const outcome = await first.done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'provider_unavailable')
      assert.match(String(outcome.message), /нужен вход/)
      assert.ok(r.drafts.some((d) => d.kind === 'provider.blocked'))
      assert.deepEqual(r.adapter.blocked(), { blocked: true, reason: r.adapter.blocked().reason })
      const second = await r.adapter.send('w', 'после отказа')
      assert.equal((await second.done).errorCode, 'provider_unavailable')
      // provider.reset снимает остановку.
      r.adapter.reset()
      assert.deepEqual(r.adapter.blocked(), { blocked: false })
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('квота: ход падает, статус limited, limit.hit в журнале, провайдер НЕ останавливается', async () => {
    const r = rig({ scenario: 'quota' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'уперся в лимит')
      const outcome = await turn.done
      assert.equal(outcome.ok, false)
      assert.match(String(outcome.message), /лимит\/квота/)
      assert.ok(r.drafts.some((d) => d.kind === 'limit.hit'))
      assert.ok(r.drafts.some((d) => d.kind === 'status.changed' && d.data!['status'] === 'limited'))
      assert.equal(r.adapter.blocked().blocked, false)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('resume без разговора: самолечение — следующий ход заведёт разговор заново', async () => {
    const r = rig({ scenario: 'no-session' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'мертвый resume')
      const outcome = await turn.done
      assert.equal(outcome.ok, false)
      assert.match(String(outcome.message), /заново/)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('страж сети отказал: net.blocked в журнале, ход не начат, errorCode blocked_network', async () => {
    const r = rig({
      scenario: 'simple',
      net: async () => okCheck({ ok: false, reason: 'blocked_country', path: 'none', loc: 'RU' }),
    })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'ход за заблокированный выход')
      const outcome = await turn.done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'blocked_network')
      assert.ok(r.drafts.some((d) => d.kind === 'net.blocked'))
      assert.equal(r.runs().length, 0)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('спавн не удался: ход падает internal, демон жив, незнакомая close принимается молча', async () => {
    const r = rig({ scenario: 'simple', bin: '/nonexistent/zcode-binary' })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'нет бинаря')
      const outcome = await turn.done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'internal')
      await r.adapter.close('чужая-сессия')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('адаптер zcode: контракт сессии', () => {
  it('resume после рестарта демона: идемпотентен, ничего не спавнит, настройки из записи', async () => {
    const r = rig({ scenario: 'simple' })
    try {
      // Рестарт демона: адаптер НИЧЕГО не знает — только запись реестра. Никакого startSession.
      await r.adapter.resume('w', {
        name: 'w', provider: 'zcode', cwd: r.cwd, mode: 'turn',
        providerSessionId: 'sess_413c6305-a0f5-4741-9fea-bdd8a3f308de',
        approval: 'workspace', createdAt: new Date().toISOString(),
      } as never)
      await r.adapter.resume('w', { name: 'w', provider: 'zcode', cwd: r.cwd, mode: 'turn' } as never)
      assert.equal(r.runs().length, 0)
      const turn = await r.adapter.send('w', 'после рестарта')
      await turn.done
      // Ход ушёл с --resume подтверждённого sessionId из записи и режимом из записи.
      const argv = r.runs()[0]!.argv
      assert.equal(argv[argv.indexOf('--resume') + 1], 'sess_413c6305-a0f5-4741-9fea-bdd8a3f308de')
      assert.equal(argv[argv.indexOf('--mode') + 1], 'edit')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('configure: режим меняется, модель и усилие честно отклоняются', async () => {
    const r = rig({ scenario: 'simple' })
    try {
      await r.adapter.startSession(spec(r))
      assert.equal(r.adapter.configure?.('w', { approval: 'read-only' }), 'next_turn')
      const turn = await r.adapter.send('w', 'строже')
      await turn.done
      const argv = r.runs()[0]!.argv
      assert.equal(argv[argv.indexOf('--mode') + 1], 'plan')
      assert.throws(() => r.adapter.configure?.('w', { model: 'glm-5' }))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('respondPermission отклоняет: у маршрута A нет канала вопросов', async () => {
    const r = rig({ scenario: 'simple' })
    try {
      await assert.rejects(() => r.adapter.respondPermission('w', 'rq', { behavior: 'allow' }), (e: Error & { code?: string }) => e.code === 'invalid_params')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})
