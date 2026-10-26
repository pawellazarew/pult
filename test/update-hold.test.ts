// M8c, повторная сверка ревью: ходы и очередь реплик, пока ставится обновление (`holdTurns`).
//   N1 — обновление кончилось провалом, демон жив: очереди, притихшие на время установки, снова идут;
//   N2 — реплика, которая уже заводила ход (resume), когда началось обновление, считается идущей и
//        перед `send` проверяет запрет ещё раз;
//   N3 — «в очередь» во время установки встаёт в очередь, а не получает отказ.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { createClaudeAdapter } from '../dist/adapters/claude/adapter.js'
import type { ProviderAdapter } from '../dist/adapters/types.js'
import { connectClient } from '../dist/cli/client.js'
import { ClientError } from '../dist/cli/client.js'
import { defaultConfig } from '../dist/core/config.js'
import type { PultEvent } from '../dist/core/events.js'
import { createStore } from '../dist/core/store.js'
import type { NetCheck } from '../dist/env/net.js'
import { createBroker } from '../dist/perm/broker.js'
import { createManager, ManagerError } from '../dist/sessions/manager.js'
import type { HttpGet } from '../dist/update/fetch.js'
import { publicOf, signEnvelope } from '../dist/update/manifest.js'
import type { ApplyChild } from '../dist/update/checker.js'
import { refuseRunningTurns } from '../dist/update/update.js'
import { CLI_ENTRY, FAKE_CLAUDE, startTestDaemon, tempHome, waitFor, workIn } from './helpers.js'
import type { TempHome } from './helpers.js'

const okNet = async (): Promise<NetCheck> => ({
  provider: 'claude', mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true,
  reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1,
  checkedAt: '2026-10-19T10:00:00.000Z', cached: false,
} as unknown as NetCheck)

function workDir(cfg: Record<string, unknown> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pt-hold-'))
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, ...cfg }))
  return cwd
}

/** Менеджер на настоящем адаптере Claude (fake-claude) с запретом ходов под рукой теста и швом на resume. */
function stand(home: TempHome, hooks: { held: () => boolean; beforeResume?: () => Promise<void> }) {
  const store = createStore(home.paths)
  const claude = createClaudeAdapter({
    paths: home.paths, config: defaultConfig(), logger: home.logger,
    bin: FAKE_CLAUDE, cliEntry: CLI_ENTRY,
    emit: (d) => { manager.emit(d) },
    askPermission: async () => ({ behavior: 'deny', message: 'тест' }),
    netCheck: okNet,
  })
  let sends = 0
  const wrapped = new Proxy(claude, {
    get(t, k) {
      if (k === 'resume') return async (...a: Parameters<ProviderAdapter['resume']>) => { await hooks.beforeResume?.(); return t.resume(...a) }
      if (k === 'send') return async (...a: Parameters<ProviderAdapter['send']>) => { sends++; return t.send(...a) }
      const v = (t as unknown as Record<string | symbol, unknown>)[k]
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
    },
  }) as ProviderAdapter
  const manager = createManager({
    paths: home.paths, config: defaultConfig(), logger: home.logger, store,
    publish: (d) => store.append(d),
    adapters: { claude: wrapped },
    broker: createBroker({ emit: (d) => { manager.emit(d) } }),
    holdTurns: hooks.held,
  })
  const users = (): string[] => store.readFrom(0, { sessionId: 'w' }).filter((e: PultEvent) => e.kind === 'message.user').map((e: PultEvent) => String(e.data['text']))
  return { manager, store, sends: () => sends, users, async close() { await manager.shutdown(); store.close() } }
}

describe('ходы, пока ставится обновление', () => {
  it('N2: реплика, заводившая ход, считается идущей; обновление началось во время resume — отказ до send', async () => {
    const home = tempHome()
    const cwd = workDir()
    let held = false
    let release: () => void = () => {}
    const resumed = new Promise<void>((r) => { release = r })
    let entered = false
    const s = stand(home, { held: () => held, beforeResume: async () => { entered = true; await resumed } })
    try {
      await s.manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      const p = s.manager.prompt('w', 'привет')
      assert.ok(await waitFor(() => entered, 5000))
      // Статуса working ещё нет, но ход заводится — «Обновить» обязано его ждать.
      assert.deepEqual(s.manager.startingTurns(), ['w'])
      held = true
      release()
      await assert.rejects(p, (e: unknown) => e instanceof ManagerError && e.code === 'updating')
      assert.equal(s.sends(), 0, 'ход ушёл в адаптер во время обновления')
      const failed = s.store.readFrom(0, { sessionId: 'w' }).filter((e) => e.kind === 'status.changed' && e.data['errorCode'] === 'updating')
      assert.equal(failed.length, 1, 'в ленте — ошибка «Пульт обновляется», «Повторить» после рестарта')
      assert.deepEqual(s.manager.startingTurns(), [])
    } finally {
      await s.close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('N3 + N1: идёт ход — «в очередь» во время установки встаёт; свободной сессии — отказ; провал обновления — resumeQueues', async () => {
    const home = tempHome()
    const cwd = workDir({ hang: 800 })
    let held = false
    const s = stand(home, { held: () => held })
    try {
      await s.manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await s.manager.prompt('w', 'первая')
      assert.ok(await waitFor(() => s.manager.list()[0]?.lastStatus === 'working', 5000))
      held = true
      await assert.rejects(s.manager.say('w', 'сразу'), (e: unknown) => e instanceof ManagerError && e.code === 'updating')
      await assert.rejects(s.manager.say('w', 'прервать', { interrupt: true }), (e: unknown) => e instanceof ManagerError && e.code === 'updating')
      const q = await s.manager.say('w', 'потом', { queue: true })
      assert.equal((q as { queued?: boolean }).queued, true)
      // Ход кончился — очередь будится, но обновление держит её: реплика стоит.
      assert.ok(await waitFor(() => s.manager.list()[0]?.lastStatus === 'idle', 10_000))
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(s.manager.list()[0]?.queue?.length, 1, 'очередь ушла во время установки')
      assert.deepEqual(s.users(), ['первая'])
      // Сессия свободна, но очередь не пуста — новая реплика встаёт за ней.
      assert.equal(((await s.manager.say('w', 'ещё', { queue: true })) as { queued?: boolean }).queued, true)
      held = false
      s.manager.resumeQueues()
      assert.ok(await waitFor(() => s.users().includes('потом'), 5000), 'очередь не ушла после провала обновления')
    } finally {
      await s.close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })

  it('N3: свободная сессия без очереди — «в очередь» во время установки получает отказ (окно шлёт queue на каждый Enter)', async () => {
    const home = tempHome()
    const cwd = workDir()
    const s = stand(home, { held: () => true })
    try {
      await s.manager.start({ name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await assert.rejects(s.manager.say('w', 'привет', { queue: true }), (e: unknown) => e instanceof ManagerError && e.code === 'updating')
      assert.equal(s.manager.list()[0]?.queue, undefined)
    } finally {
      await s.close()
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })
})

class FakeChild extends EventEmitter implements ApplyChild {}

describe('демон: N1 целиком — конец хода запускает обновление раньше очереди', () => {
  it('ход кончился → pult update пошёл, очередь притихла; pult update упал → реплика из очереди ушла', async () => {
    const home = tempHome()
    home.config.updates = { check: true, url: 'https://example.invalid/latest.json' }
    const { privateKey } = generateKeyPairSync('ed25519')
    const pub = publicOf(privateKey)
    const manifest = Buffer.from(JSON.stringify({
      schema: 1, version: '99.0.0', released: '2026-10-19T10:00:00.000Z', notes: 'https://github.com/pawellazarew/pult/releases/tag/v99.0.0',
      package: { url: 'https://example.invalid/pult-99.0.0.tgz', sha256: 'c'.repeat(64), size: 10 },
    }))
    const latest = Buffer.from(signEnvelope(manifest, privateKey))
    const http: HttpGet = async () => ({ status: 200, header: () => null, body: (async function* () { yield latest })() })
    const kids: FakeChild[] = []
    // Ход держится 1,5 с до первого события и кончается сам (`idle`) — очередь будится концом хода.
    const cwd = workDir({ hang: 1500 })
    const d = await startTestDaemon(home, {
      updates: { http, keys: [{ id: pub.keyId, publicKey: pub.raw.toString('base64') }], schedule: false, spawnApply: () => { const k = new FakeChild(); kids.push(k); return k } },
    })
    const c = await connectClient(home.paths)
    const users = async (): Promise<string[]> => ((await c.request('events.tail', { since: 0, sessionId: 'w' })) as { events: PultEvent[] }).events
      .filter((e) => e.kind === 'message.user').map((e) => String(e.data['text']))
    try {
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd, mode: 'turn' })
      await c.request('agent.prompt', { name: 'w', text: 'первая' })
      assert.ok(await waitFor(() => d.manager.list().some((r) => r.lastStatus === 'working'), 10_000))
      assert.deepEqual(await c.request('agent.prompt', { name: 'w', text: 'вторая', queue: true }), { queued: true, id: d.manager.list()[0]?.queue?.[0]?.id })
      assert.deepEqual(await c.request('update.apply'), { waiting: 1 })
      assert.ok(await waitFor(() => kids.length === 1, 15_000), 'конец хода не запустил обновление')
      await new Promise((r) => setTimeout(r, 200))
      assert.deepEqual(await users(), ['первая'], 'реплика из очереди ушла посреди установки')
      await assert.rejects(c.request('agent.prompt', { name: 'w', text: 'третья' }), (e: unknown) => e instanceof ClientError && e.code === 'updating')
      kids[0]?.emit('exit', 1, null)
      assert.ok(await waitFor(async () => (await users()).includes('вторая'), 10_000), 'после провала обновления очередь осталась висеть')
    } finally {
      c.close()
      await d.stop('тест')
      rmSync(cwd, { recursive: true, force: true })
      home.remove()
    }
  })
})

// `pult update` из CLI (канал, --from, --to) перезапускает демона: идущие ходы оборвались бы. Окно ждёт их конца
// (checker.ts), CLI — отказывает с тем же счётом (`daemon.status.turns`) или идёт дальше с `--force`.
describe('pult update из CLI и идущие ходы', () => {
  it('refuseRunningTurns: идут ходы — отказ с числом; --force, 0 ходов, нет демона, старый демон — дальше', async () => {
    const lines: string[] = []
    const io = { out: (s: string) => { lines.push(s) }, err: (s: string) => { lines.push(s) } }
    const home = tempHome()
    try {
      const at = (st: { turns?: number } | null) => async () => st
      assert.equal(await refuseRunningTurns(home.paths, io, { force: false, status: at({ turns: 2 }) }), true)
      assert.match(lines.at(-1) ?? '', /^pult update: идут ходы: 2 — .*дождись или --force$/)
      const n = lines.length
      assert.equal(await refuseRunningTurns(home.paths, io, { force: true, status: at({ turns: 2 }) }), false)
      assert.equal(await refuseRunningTurns(home.paths, io, { force: false, status: at({ turns: 0 }) }), false)
      assert.equal(await refuseRunningTurns(home.paths, io, { force: false, status: at(null) }), false)
      assert.equal(await refuseRunningTurns(home.paths, io, { force: false, status: at({}) }), false)
      assert.equal(lines.length, n, 'пропуск молчит')
    } finally { home.remove() }
  })

  it('daemon.status.turns считает идущие ходы; `pult update --to` отказывает, --force проходит дальше', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    const run = (args: string[]): Promise<{ code: number | null; err: string }> => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI_ENTRY, 'update', ...args], { env: { ...process.env, PULT_HOME: home.paths.home, PULT_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      child.stderr.on('data', (b: Buffer) => { err += b.toString() })
      child.on('exit', (code) => resolve({ code, err }))
    })
    try {
      await daemon.manager.start({ name: 'w', kind: 'claude', cwd: workIn(home) })
      assert.equal(daemon.status().turns, 0)
      daemon.manager.emit({ sessionId: 'w', provider: 'claude', kind: 'status.changed', data: { status: 'working', turnId: 't1' } })
      assert.ok(await waitFor(() => daemon.status().turns === 1, 3000), `turns: ${daemon.status().turns}`)
      const refused = await run(['--to', '9.9.9'])
      assert.equal(refused.code, 1)
      assert.match(refused.err, /идут ходы: 1 — .*дождись или --force/)
      // --force: отказа по ходам нет — дальше обычный путь (версии 9.9.9 на диске нет).
      const forced = await run(['--to', '9.9.9', '--force'])
      assert.equal(forced.code, 1)
      assert.doesNotMatch(forced.err, /идут ходы/)
      assert.match(forced.err, /версии 9\.9\.9 на диске нет/)
      // Ход кончился — без --force тоже дальше.
      daemon.manager.emit({ sessionId: 'w', provider: 'claude', kind: 'status.changed', data: { status: 'idle', turnId: 't1' } })
      assert.ok(await waitFor(() => daemon.status().turns === 0, 3000))
      assert.doesNotMatch((await run(['--to', '9.9.9'])).err, /идут ходы/)
      // --list и --check с --force не бывает.
      assert.match((await run(['--list', '--force'])).err, /--force — не с --list и --check/)
    } finally { await daemon.stop('тест'); home.remove() }
  })
})
