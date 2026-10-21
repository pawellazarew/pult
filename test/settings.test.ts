// M8f: смена модели, усилия и режима подтверждений у живой сессии (со следующего хода), запоминание выбора
// «+ Сессия», умолчания в config.json → newSession, `settings.get|set`, `pult agent set`.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createClaudeAdapter } from '../dist/adapters/claude/adapter.js'
import type { ClaudeAdapterOptions } from '../dist/adapters/claude/adapter.js'
import { createCodexAdapter } from '../dist/adapters/codex/adapter.js'
import type { ProviderAdapter } from '../dist/adapters/types.js'
import { connectClient } from '../dist/cli/client.js'
import { defaultConfig, validateConfig } from '../dist/core/config.js'
import type { PultConfig } from '../dist/core/config.js'
import type { EventDraft } from '../dist/core/events.js'
import { createLogger } from '../dist/core/log.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import type { NetCheck } from '../dist/env/net.js'
import { PLAYWRIGHT_MCP_VERSION, browserPrefix } from '../dist/mcp/browser.js'
import { parseSessions } from '../dist/sessions/registry.js'
import {
  claudeChoices, ConfigureError, describeChanges, modelWindows, nextLastUsed, parseLastUsed, parseNewSession, planConfigure, windowMisfit,
} from '../dist/sessions/settings.js'
import type { ModelChoice } from '../dist/sessions/settings.js'
import { CLI_ENTRY, FAKE_CLAUDE, FAKE_CODEX_SCRIPTED, sleep, startTestDaemon, tempHome, waitFor } from './helpers.js'

const NONE: ReadonlyMap<string, number> = new Map()
const CODEX: ModelChoice[] = [
  { id: 'gpt-fast', efforts: ['low', 'medium'], defaultEffort: 'low', isDefault: true },
  { id: 'gpt-deep', efforts: ['high', 'xhigh'], defaultEffort: 'high' },
]
const code = (want: string) => (e: { code?: string }): boolean => e.code === want

describe('M8f: проверка смены (planConfigure)', () => {
  it('Claude — пресеты формы: чужая модель — отказ; усилие из пресетов; ничего не меняется — пусто', () => {
    const cur = { provider: 'claude' as const, model: 'opus', effort: 'high' }
    assert.throws(() => planConfigure(cur, { model: 'gpt-5' }, claudeChoices(), NONE), (e: unknown) => e instanceof ConfigureError && /нет у claude/.test(e.message))
    assert.throws(() => planConfigure(cur, { model: 'opus extra' }, claudeChoices(), NONE), /без пробелов/)
    assert.throws(() => planConfigure(cur, { effort: 'ultra' }, claudeChoices(), NONE), /усилия ultra нет/)
    assert.deepEqual(planConfigure(cur, { model: 'sonnet', effort: 'medium' }, claudeChoices(), NONE),
      { model: { from: 'opus', to: 'sonnet' }, effort: { from: 'high', to: 'medium' } })
    assert.deepEqual(planConfigure(cur, { model: 'opus', effort: 'high', approval: 'ask' }, claudeChoices(), NONE), {})
  })
  it('режим: full — только с подтверждением; ask ↔ нет поля одно и то же', () => {
    const cur = { provider: 'claude' as const }
    assert.throws(() => planConfigure(cur, { approval: 'full' }, claudeChoices(), NONE), (e: unknown) => e instanceof ConfigureError && e.code === 'invalid_params' && /confirm/.test(e.message))
    assert.deepEqual(planConfigure(cur, { approval: 'full', confirm: true }, claudeChoices(), NONE), { approval: { from: 'ask', to: 'full' } })
    assert.throws(() => planConfigure(cur, { approval: 'yolo' as never }, claudeChoices(), NONE), /read-only \| ask/)
  })
  it('Codex — живой список: усилие — у ЦЕЛЕВОЙ модели; смена модели без усилия ставит её усилие по умолчанию', () => {
    const cur = { provider: 'codex' as const, model: 'gpt-fast', effort: 'low' }
    assert.throws(() => planConfigure(cur, { model: 'gpt-deep', effort: 'low' }, CODEX, NONE), /усилия low нет у модели gpt-deep: high, xhigh/)
    assert.deepEqual(planConfigure(cur, { model: 'gpt-deep' }, CODEX, NONE), { model: { from: 'gpt-fast', to: 'gpt-deep' }, effort: { from: 'low', to: 'high' } })
    assert.throws(() => planConfigure(cur, { model: 'gpt-x' }, CODEX, NONE), /нет у codex: gpt-fast, gpt-deep/)
    // Списка нет (офлайн) — только форма имени.
    assert.deepEqual(planConfigure(cur, { model: 'gpt-x' }, null, NONE), { model: { from: 'gpt-fast', to: 'gpt-x' } })
  })
  it('окно меньше занятого контекста — «не влезет: 300k > 200k», без подтверждения отказ needs_confirm', () => {
    const windows = modelWindows([
      { model: 'opus', context: { model: 'claude-opus-5-5[1m]', window: 1_000_000, at: '2026-10-20T10:00:00Z' } },
      { model: 'sonnet', context: { model: 'claude-sonnet-5-5', window: 200_000, at: '2026-10-20T09:00:00Z' } },
    ])
    assert.equal(windows.get('sonnet'), 200_000)
    assert.equal(windows.get('claude-opus-5-5[1m]'), 1_000_000)
    assert.equal(windowMisfit(300_000, 200_000), 'не влезет: 300k > 200k')
    assert.equal(windowMisfit(100_000, 200_000), null)
    assert.equal(windowMisfit(300_000, undefined), null, 'окно неизвестно — не мешаем')
    const cur = { provider: 'claude' as const, model: 'opus', used: 300_000 }
    assert.throws(() => planConfigure(cur, { model: 'sonnet' }, claudeChoices(), windows),
      (e: unknown) => e instanceof ConfigureError && e.code === 'needs_confirm' && /не влезет: 300k > 200k/.test(e.message))
    assert.deepEqual(planConfigure(cur, { model: 'sonnet', confirm: true }, claudeChoices(), windows), { model: { from: 'opus', to: 'sonnet' } })
    assert.deepEqual(planConfigure(cur, { model: 'haiku' }, claudeChoices(), windows), { model: { from: 'opus', to: 'haiku' } }, 'окно haiku не знаем — не спрашиваем')
  })
  it('строка ленты', () => {
    assert.equal(describeChanges({ model: { from: 'opus', to: 'sonnet' }, effort: { from: 'high', to: 'medium' }, approval: { from: 'ask', to: 'read-only' } }),
      'модель: opus → sonnet · усилие: high → medium · режим: спрашивать → только чтение — со следующего хода')
    assert.match(describeChanges({ model: { from: null, to: 'gpt-x' } }, 'after_background'), /^модель: по умолчанию → gpt-x — когда доделаются фоновые задачи/)
    assert.equal(describeChanges({}), '')
  })
})

describe('M8f: настройки «Новая сессия» и последний выбор', () => {
  it('строгий разбор (settings.set): незнакомое поле, full, браузер в «без вопросов» Codex — отказ целиком', () => {
    assert.throws(() => parseNewSession({ rememberLast: true, network: {} }, true), /network — незнакомое поле/)
    assert.throws(() => parseNewSession({ defaults: { claude: { approval: 'full' } } }, true), /полный доступ по умолчанию не ставится/)
    assert.throws(() => parseNewSession({ defaults: { codex: { approval: 'workspace', browser: true } } }, true), /браузер/)
    assert.throws(() => parseNewSession({ defaults: { claude: { model: 'a b' } } }, true), /model/)
    assert.throws(() => parseNewSession({ defaults: { provider: 'opencode' } }, true), /claude \| codex/)
    const ok = parseNewSession({ rememberLast: false, defaults: { provider: 'codex', claude: { model: 'opus', effort: 'high', approval: 'workspace', mode: 'warm', browser: true, worktree: true }, codex: {} } }, true)
    assert.deepEqual(ok.value, { rememberLast: false, defaults: { provider: 'codex', claude: { model: 'opus', effort: 'high', approval: 'workspace', mode: 'warm', browser: true, worktree: true }, codex: {} } })
  })
  it('мягкий разбор config.json: кривое поле выброшено с предупреждением, остальное на месте; нет раздела — умолчания', () => {
    const { config, warnings } = validateConfig({ newSession: { rememberLast: 'да', defaults: { claude: { model: 'opus', approval: 'full' } } } })
    assert.deepEqual(config.newSession, { rememberLast: true, defaults: { claude: { model: 'opus' }, codex: {} } })
    assert.equal(warnings.length, 2, warnings.join('\n'))
    assert.deepEqual(defaultConfig().newSession, { rememberLast: true, defaults: { claude: {}, codex: {} } })
  })
  it('последний выбор: full не запоминается; папка — только когда форма открыта без папки; второй провайдер не стирается', () => {
    const a = nextLastUsed({}, { kind: 'claude', model: 'opus', effort: 'high', approval: 'full', mode: 'warm', browser: false, worktree: true, cwd: '/p/app' }, true, 't1')
    assert.deepEqual(a, { provider: 'claude', claude: { model: 'opus', effort: 'high', mode: 'warm', browser: false, worktree: true }, cwd: '/p/app', at: 't1' })
    const b = nextLastUsed(a, { kind: 'codex', approval: 'read-only', cwd: '/p/other' }, false, 't2')
    assert.equal(b.cwd, '/p/app', 'форма открыта с папкой — прошлая папка остаётся')
    assert.deepEqual(b.claude, a.claude)
    assert.deepEqual(b.codex, { approval: 'read-only', mode: 'turn', browser: false, worktree: false })
    // Файл правили руками: full не читается.
    assert.deepEqual(parseLastUsed({ provider: 'claude', claude: { approval: 'full', model: 'opus' }, cwd: 'relative' }), { provider: 'claude', claude: { model: 'opus' } })
  })
})

// --- адаптер Claude: следующий ход несёт новые флаги ---------------------------------------------------------

const okCheck = (provider: 'claude' | 'codex' = 'claude'): NetCheck => ({
  provider, mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true,
  reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1, checkedAt: '2026-10-20T10:00:00.000Z', cached: false,
})
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

interface ClaudeRig { adapter: ProviderAdapter; drafts: EventDraft[]; cwd: string; runs(): Array<{ argv: string[]; pid: number; env: Record<string, string> }>; retune(cfg: Record<string, unknown>): void; remove(): void }
interface RigOpts {
  now?: () => number
  net?: () => Promise<NetCheck>
  mcpExtras?: ClaudeAdapterOptions['mcpExtras']
}
function claudeRig(scenario: string, config: Partial<PultConfig> = {}, o: RigOpts = {}): ClaudeRig {
  const dir = mkdtempSync(join(tmpdir(), 'pt-m8f-'))
  const paths = layout(join(dir, 'h'))
  ensureLayout(paths)
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const argvFile = join(dir, 'argv.jsonl')
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario, argvOut: argvFile, speed: 0 }))
  const drafts: EventDraft[] = []
  const adapter = createClaudeAdapter({
    paths, config: { ...defaultConfig(), ...config }, logger: createLogger(paths.logFile), bin: FAKE_CLAUDE, cliEntry: CLI_ENTRY,
    emit: (d) => { drafts.push(d) }, askPermission: async () => ({ behavior: 'deny', message: 'тест' }), netCheck: o.net ?? (async () => okCheck()),
    ...(o.now ? { now: o.now } : {}), ...(o.mcpExtras ? { mcpExtras: o.mcpExtras } : {}),
  })
  return {
    adapter, drafts, cwd,
    retune: (cfg) => { writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ argvOut: argvFile, speed: 0, ...cfg })) },
    runs: () => (existsSync(argvFile) ? readFileSync(argvFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as never) : []),
    remove: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}
const flag = (argv: string[], f: string): string | undefined => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)

describe('M8f: адаптер claude — смена со следующего хода', () => {
  it('процесс на ход: следующий --resume несёт новые --model/--effort/--permission-mode и --disallowedTools', async () => {
    const r = claudeRig('simple')
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, model: 'haiku', effort: 'low', mode: 'turn', broker: false })
      await (await r.adapter.send('w', 'привет')).done
      assert.equal(r.adapter.configure?.('w', { model: 'sonnet', effort: 'high', approval: 'read-only' }), 'next_turn')
      await (await r.adapter.send('w', 'ещё')).done
      const [first, second] = r.runs()
      assert.equal(flag(first!.argv, '--model'), 'haiku')
      assert.ok(second!.argv.includes('--resume'), 'разговор тот же')
      assert.deepEqual([flag(second!.argv, '--model'), flag(second!.argv, '--effort'), flag(second!.argv, '--permission-mode')], ['sonnet', 'high', 'manual'])
      assert.deepEqual(second!.argv.slice(second!.argv.indexOf('--disallowedTools') + 1, second!.argv.indexOf('--disallowedTools') + 6), ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode'])
      // Обратно в ask и без усилия — флагов нет.
      r.adapter.configure?.('w', { model: 'sonnet' })
      await (await r.adapter.send('w', 'и ещё')).done
      const third = r.runs()[2]!.argv
      assert.equal(third.includes('--permission-mode') || third.includes('--disallowedTools') || third.includes('--effort'), false, third.join(' '))
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('тёплый процесс: перезапуск на границе хода — новый процесс с --resume и новой моделью, старый уходит', async () => {
    const r = claudeRig('warm')
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, model: 'haiku', effort: 'low', mode: 'warm', broker: false })
      await (await r.adapter.send('w', 'запомни 41')).done
      const pid1 = r.runs()[0]!.pid
      assert.ok(alive(pid1), 'тёплый процесс жив между ходами')
      assert.equal(r.adapter.configure?.('w', { model: 'opus', effort: 'low' }), 'next_turn')
      assert.ok(alive(pid1), 'настройки не трогают процесс до границы хода')
      await (await r.adapter.send('w', 'какое число?')).done
      assert.equal(r.runs().length, 2, 'смена модели подняла новый процесс')
      const second = r.runs()[1]!.argv
      assert.equal(flag(second, '--model'), 'opus')
      assert.ok(second.includes('--resume'))
      assert.ok(await waitFor(() => !alive(pid1), 5000), 'старый тёплый процесс ушёл')
      // Без смены — снова тот же процесс.
      await (await r.adapter.send('w', 'ещё раз')).done
      assert.equal(r.runs().length, 2)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('фоновые задачи идут — смена ждёт их конца: ход в прежний процесс, новый — когда задач нет', async () => {
    const r = claudeRig('background-live', { subagentGraceMs: 400 })
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, model: 'haiku', effort: 'low', mode: 'turn', broker: false })
      await (await r.adapter.send('w', 'запусти фоновую задачу')).done
      const pid = r.runs()[0]!.pid
      assert.equal(r.adapter.configure?.('w', { model: 'sonnet', effort: 'low' }), 'after_background')
      const second = await (await r.adapter.send('w', 'Reply with exactly PONG.')).done
      assert.equal(second.text, 'PONG')
      assert.equal(r.runs().length, 1, 'фоновая задача не оборвана новым процессом')
      const notes = r.drafts.filter((d) => d.kind === 'session.configured').map((d) => String((d.data as { notice?: unknown }).notice))
      assert.ok(notes.some((n) => /ещё на прежних настройках/.test(n)), `заметки: ${notes.join(' | ')}`)
      assert.ok(await waitFor(() => !alive(pid), 8000), 'процесс уходит после конца задач')
      await (await r.adapter.send('w', 'дальше')).done
      assert.equal(flag(r.runs().at(-1)!.argv, '--model'), 'sonnet')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('resume идемпотентен: знакомую сессию не перезаписывает (тёплый процесс не теряется)', async () => {
    const r = claudeRig('warm')
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, model: 'haiku', effort: 'low', mode: 'warm', broker: false })
      await (await r.adapter.send('w', 'запомни 41')).done
      await r.adapter.resume('w', { name: 'w', provider: 'claude', cwd: r.cwd, model: 'haiku', effort: 'low', mode: 'warm', createdAt: 'x', lastStatus: 'idle', lastEventId: 0 })
      await (await r.adapter.send('w', 'какое число?')).done
      assert.equal(r.runs().length, 1, 'менеджер зовёт resume перед каждым ходом — процесс тот же')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})


describe('M8f (ревью): адаптер claude — гонки и живой процесс', () => {
  it('HIGH 1: неудачный ход тёплого процесса закрывает процесс; следующий ход — в свежий, без зависания', async () => {
    const r = claudeRig('not-logged-in')
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, mode: 'warm', broker: false })
      const first = await (await r.adapter.send('w', 'раз')).done
      assert.equal(first.ok, false)
      const pid = r.runs()[0]!.pid
      assert.ok(await waitFor(() => !alive(pid), 5000), 'процесс после неудачного тёплого хода не ушёл')
      r.retune({ scenario: 'warm' })
      const two = await Promise.race([(await r.adapter.send('w', 'два')).done, new Promise<string>((res) => setTimeout(() => res('HANG'), 5000))])
      assert.notEqual(two, 'HANG')
      assert.equal(r.runs().length, 2, 'второй ход поднял свежий процесс')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('HIGH 1: тёплый процесс умер между ходами (kill -9) — следующий ход не пишет в мёртвый stdin', async () => {
    const r = claudeRig('warm')
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, mode: 'warm', broker: false })
      await (await r.adapter.send('w', 'раз')).done
      process.kill(r.runs()[0]!.pid, 'SIGKILL')
      assert.ok(await waitFor(() => !alive(r.runs()[0]!.pid), 3000))
      const two = await Promise.race([(await r.adapter.send('w', 'два')).done, new Promise<string>((res) => setTimeout(() => res('HANG'), 5000))])
      assert.notEqual(two, 'HANG')
      assert.equal(r.runs().length, 2)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('HIGH 1: стоп висящего тёплого хода (глухой процесс) — ход закрыт interrupted', async () => {
    const r = claudeRig('warm')
    r.retune({ scenario: 'simple', hangAfterInit: 30_000, deaf: '1' })
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, mode: 'warm', broker: false })
      const t = await r.adapter.send('w', 'долго')
      await sleep(300)
      await r.adapter.interrupt('w')
      const o = await Promise.race([t.done, new Promise<string>((res) => setTimeout(() => res('HANG'), 3000))])
      assert.notEqual(o, 'HANG')
      assert.equal((o as { errorCode?: string }).errorCode, 'interrupted')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('HIGH 2: страж сменил путь (напрямую → прокси) — тёплый процесс сменяется, новый идёт через прокси', async () => {
    let t = 1_000_000
    let path: 'direct' | 'proxy' = 'direct'
    const r = claudeRig('warm', {}, { now: () => t, net: async () => ({ ...okCheck(), path, proxy: path === 'proxy' ? 'http://127.0.0.1:9' : null }) })
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, mode: 'warm', broker: false })
      await (await r.adapter.send('w', 'раз')).done
      path = 'proxy'
      t += 120_000
      await (await r.adapter.send('w', 'два')).done
      assert.equal(r.runs().length, 2, 'ход в процесс со старым путём в сеть — нарушение инварианта 2')
      assert.equal(r.runs()[0]!.env['HTTPS_PROXY'], undefined)
      assert.equal(r.runs()[1]!.env['HTTPS_PROXY'], 'http://127.0.0.1:9')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('HIGH 2: путь сменился, а процесс держит фоновые задачи — ход закрыт отказом, в старый путь не уходит', async () => {
    let t = 1_000_000
    let path: 'direct' | 'proxy' = 'direct'
    const r = claudeRig('background-live', { subagentGraceMs: 400 }, { now: () => t, net: async () => ({ ...okCheck(), path, proxy: path === 'proxy' ? 'http://127.0.0.1:9' : null }) })
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, mode: 'turn', broker: false })
      await (await r.adapter.send('w', 'запусти фоновую задачу')).done
      path = 'proxy'
      t += 120_000
      const o = await (await r.adapter.send('w', 'Reply with exactly PONG.')).done
      assert.deepEqual([o.ok, o.errorCode], [false, 'blocked_network'])
      assert.match(o.message ?? '', /сеть сменилась \(напрямую → прокси\)/)
      assert.equal(r.runs().length, 1)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('HIGH 3: configure, пока ход заводится (MCP собирается), — этому ходу не достаётся; следующему — да', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    let calls = 0
    const r = claudeRig('simple', {}, { mcpExtras: async () => { calls++; if (calls === 1) await gate; return { servers: {} } } })
    try {
      await r.adapter.startSession({ name: 'b', cwd: r.cwd, mode: 'turn', broker: true })
      const p = r.adapter.send('b', 'раз')
      await sleep(100)
      r.adapter.configure?.('b', { approval: 'full' })
      release()
      await (await p).done
      assert.equal(flag(r.runs()[0]!.argv, '--permission-mode'), undefined, 'идущий ход получил bypassPermissions')
      await (await r.adapter.send('b', 'два')).done
      assert.equal(flag(r.runs()[1]!.argv, '--permission-mode'), 'bypassPermissions')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('HIGH 3: снимок менеджера — главнее spec адаптера (браузер и режим этого хода)', async () => {
    const seen: unknown[] = []
    const r = claudeRig('simple', {}, { mcpExtras: async (_n, _b, at) => { seen.push(at); return { servers: {} } } })
    try {
      await r.adapter.startSession({ name: 'b', cwd: r.cwd, mode: 'turn', broker: true, approval: 'full' })
      await (await r.adapter.send('b', 'раз', { approval: 'ask' as never, browser: { headed: true } })).done
      assert.deepEqual(seen[0], { approval: 'ask', browser: { headed: true } })
      assert.equal(flag(r.runs()[0]!.argv, '--permission-mode'), undefined)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('ревью 2: тёплый процесс, порядок фикстуры 06 (задачи кончились ДО result) — следующий ход берёт новые настройки', async () => {
    const r = claudeRig('subagent', { subagentGraceMs: 300 })
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, model: 'haiku', effort: 'low', mode: 'warm', broker: false })
      await (await r.adapter.send('w', 'раз')).done
      assert.ok(await waitFor(() => r.drafts.some((d) => d.kind === 'status.changed' && (d.data as { reason?: string }).reason === 'background_turn_done'), 5000),
        'ход-итог фоновой задачи не отыгран')
      await sleep(400)
      assert.equal(r.adapter.configure?.('w', { model: 'opus', effort: 'low' }), 'next_turn', 'фоновой работы уже нет')
      r.retune({ scenario: 'warm' })
      await (await r.adapter.send('w', 'два')).done
      assert.equal(r.runs().length, 2, 'новые настройки — новый процесс')
      assert.equal(flag(r.runs()[1]!.argv, '--model'), 'opus')
      const notes = r.drafts.filter((d) => d.kind === 'session.configured').map((d) => String((d.data as { notice?: unknown }).notice))
      assert.equal(notes.some((n) => /прежних настройках/.test(n)), false, notes.join(' | '))
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('ревью 2: браузер выключили, а идут фоновые задачи — как режим строже: реплика ждёт их конца', async () => {
    const r = claudeRig('background-live', { subagentGraceMs: 400 })
    r.retune({ scenario: 'background-live', bgEndMs: 1500 })
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, mode: 'turn', broker: false })
      await (await r.adapter.send('w', 'запусти фоновую задачу', { browser: {} })).done
      const t = await r.adapter.send('w', 'Reply with exactly PONG.', { browser: null })
      const notes = r.drafts.filter((d) => d.kind === 'session.configured').map((d) => String((d.data as { notice?: unknown }).notice))
      assert.ok(notes.some((n) => /чтобы выключить браузер/.test(n)), notes.join(' | '))
      assert.equal((await t.done).ok, true)
      assert.equal(r.runs().length, 2, 'ход ушёл в новый процесс — без браузера')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('MED 6: режим строже, а идут фоновые задачи — реплика ждёт их конца (не отказ) и уходит в новый процесс', async () => {
    const r = claudeRig('background-live', { subagentGraceMs: 400 })
    r.retune({ scenario: 'background-live', bgEndMs: 1500 })
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, mode: 'turn', broker: false })
      await (await r.adapter.send('w', 'запусти фоновую задачу')).done
      r.adapter.configure?.('w', { approval: 'read-only' })
      const t = await Promise.race([r.adapter.send('w', 'Reply with exactly PONG.'), new Promise<string>((res) => setTimeout(() => res('SLOW'), 1000))])
      assert.notEqual(t, 'SLOW', 'реплика принята сразу, ход ждёт сам')
      const notes = r.drafts.filter((d) => d.kind === 'session.configured').map((d) => String((d.data as { notice?: unknown }).notice))
      assert.ok(notes.some((n) => /жду окончания фоновых задач, чтобы включить режим «только чтение»/.test(n)), notes.join(' | '))
      const o = await (t as { done: Promise<{ ok: boolean }> }).done
      assert.equal(o.ok, true)
      assert.equal(r.runs().length, 2, 'ход ушёл в новый процесс')
      assert.equal(flag(r.runs()[1]!.argv, '--permission-mode'), 'manual')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

// --- адаптер Codex: turn/start несёт смену ---------------------------------------------------------------

interface Msg { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
function codexRig(browser = false, fake: Record<string, unknown> = {}, mcpExtras?: () => Promise<{ servers: Record<string, Record<string, unknown>> }>): { adapter: ProviderAdapter; cwd: string; client(): Msg[]; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'pt-m8f-c-'))
  const paths = layout(join(dir, 'h'))
  ensureLayout(paths)
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const logOut = join(dir, 'server.jsonl')
  writeFileSync(join(paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut, ...fake }))
  const adapter = createCodexAdapter({
    paths, config: defaultConfig(), logger: createLogger(paths.logFile), bin: FAKE_CODEX_SCRIPTED,
    emit: () => {}, askPermission: async () => ({ behavior: 'deny' }), netCheck: async () => okCheck('codex'),
    schemaCheck: () => ({ status: 'ok', expected: 'x', actual: 'x', files: 310, detail: 'тест' }),
    ...(mcpExtras ? { mcpExtras } : browser ? { mcpExtras: async () => ({ servers: { pult_browser: { command: '/bin/true', args: [] } } }) } : {}),
  })
  const read = (): Array<Record<string, unknown>> => (existsSync(logOut)
    ? readFileSync(logOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [])
  return {
    adapter, cwd,
    client: () => read().filter((x) => x['ev'] === 'client').map((x) => x['msg'] as Msg),
    remove: () => {
      for (const x of read()) if (x['ev'] === 'boot') { try { process.kill(Number(x['pid']), 'SIGKILL') } catch { /* ушёл */ } }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('M8f: адаптер codex — смена в turn/start загруженного треда', () => {
  it('режим на загруженном треде — ход несёт ТОЛЬКО отличие: ask → read-only — песочница, → full — и политика', async () => {
    const r = codexRig()
    try {
      await r.adapter.startSession({ name: 'c', cwd: r.cwd, model: 'gpt-fast', effort: 'low', mode: 'turn', broker: true })
      assert.equal((await (await r.adapter.send('c', 'раз')).done).ok, true)
      assert.equal(r.adapter.configure?.('c', { model: 'gpt-deep', effort: 'high', approval: 'read-only' }), 'next_turn')
      assert.equal((await (await r.adapter.send('c', 'два')).done).ok, true)
      assert.equal((await (await r.adapter.send('c', 'три')).done).ok, true)
      const turns = r.client().filter((m) => m.method === 'turn/start').map((m) => m.params ?? {})
      assert.equal(turns.length, 3)
      assert.equal('sandboxPolicy' in turns[0]!, false)
      assert.deepEqual([turns[1]!['model'], turns[1]!['effort'], 'approvalPolicy' in turns[1]!, turns[1]!['sandboxPolicy']], ['gpt-deep', 'high', false, { type: 'readOnly' }],
        'ask и read-only — одна политика on-request')
      assert.equal('sandboxPolicy' in turns[2]! || 'approvalPolicy' in turns[2]!, false, 'тред помнит сам — дальше не повторяем')
      r.adapter.configure?.('c', { model: 'gpt-deep', effort: 'high', approval: 'full' })
      await (await r.adapter.send('c', 'четыре')).done
      const last = r.client().filter((m) => m.method === 'turn/start').at(-1)?.params ?? {}
      assert.deepEqual([last['approvalPolicy'], last['sandboxPolicy']], ['never', { type: 'dangerFullAccess' }])
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('MED 5: ask → workspace — только политика, песочницу не трогаем; A → B → A — объект песочницы сервера возвращается как был', async () => {
    const own = { type: 'workspaceWrite', networkAccess: true, writableRoots: ['/extra'] }
    const r = codexRig(false, { threadSandbox: own })
    try {
      await r.adapter.startSession({ name: 'c', cwd: r.cwd, mode: 'turn', broker: true })
      await (await r.adapter.send('c', 'раз')).done
      r.adapter.configure?.('c', { approval: 'workspace' })
      await (await r.adapter.send('c', 'два')).done
      r.adapter.configure?.('c', { approval: 'read-only' })
      await (await r.adapter.send('c', 'три')).done
      r.adapter.configure?.('c', {})
      await (await r.adapter.send('c', 'четыре')).done
      const turns = r.client().filter((m) => m.method === 'turn/start').map((m) => m.params ?? {})
      assert.deepEqual([turns[1]!['approvalPolicy'], 'sandboxPolicy' in turns[1]!], ['never', false])
      assert.deepEqual([turns[2]!['approvalPolicy'], turns[2]!['sandboxPolicy']], ['on-request', { type: 'readOnly' }])
      assert.deepEqual(turns[3]!['sandboxPolicy'], own, 'вернулся объект сервера, а не умолчания схемы')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('MED 5: тред заведён в read-only, переход в ask — workspaceWrite из config/read (sandbox_workspace_write config.toml)', async () => {
    const r = codexRig(false, { configRead: { sandbox_workspace_write: { network_access: true, writable_roots: ['/r'] } } })
    try {
      await r.adapter.startSession({ name: 'c', cwd: r.cwd, mode: 'turn', broker: true, approval: 'read-only' })
      await (await r.adapter.send('c', 'раз')).done
      r.adapter.configure?.('c', {})
      await (await r.adapter.send('c', 'два')).done
      assert.ok(r.client().some((m) => m.method === 'config/read' && (m.params as Record<string, unknown>)['cwd'] === r.cwd))
      const t = r.client().filter((m) => m.method === 'turn/start').at(-1)?.params ?? {}
      assert.deepEqual(t['sandboxPolicy'], { type: 'workspaceWrite', writableRoots: ['/r'], networkAccess: true })
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('HIGH 3: configure, пока тред заводится (MCP собирается), — тред с режимом снимка; без вопросов при браузере — ход закрыт', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    let calls = 0
    const r = codexRig(false, {}, async () => { calls++; if (calls === 1) await gate; return { servers: { pult_browser: { command: '/bin/true', args: [] } } } })
    try {
      await r.adapter.startSession({ name: 'c', cwd: r.cwd, mode: 'turn', broker: true })
      const p = r.adapter.send('c', 'раз')
      await sleep(300)
      r.adapter.configure?.('c', { approval: 'workspace' })
      release()
      assert.equal((await (await p).done).ok, true)
      const ts = r.client().find((m) => m.method === 'thread/start')?.params ?? {}
      assert.deepEqual([ts['sandbox'], ts['approvalPolicy']], ['workspace-write', 'on-request'], 'тред — с режимом снимка, не с пришедшим посреди')
      const two = await (await r.adapter.send('c', 'два')).done
      assert.deepEqual([two.ok, two.errorCode], [false, 'invalid_params'])
      assert.match(two.message ?? '', /мимо Inbox/)
      assert.equal(r.client().filter((m) => m.method === 'turn/start').length, 1, 'ход без вопросов с браузером на провод не ушёл')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('ревью 2: ход с браузером заводится (MCP ещё ставится) — смена в «без вопросов» отказ сразу, а не провал каждого хода потом', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const r = codexRig(false, {}, async () => { await gate; return { servers: { pult_browser: { command: '/bin/true', args: [] } } } })
    try {
      await r.adapter.startSession({ name: 'c', cwd: r.cwd, mode: 'turn', broker: true })
      const p = r.adapter.send('c', 'раз', { browser: {} })
      await sleep(200)
      assert.throws(() => r.adapter.configure?.('c', { approval: 'workspace' }), (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /мимо Inbox/.test(e.message ?? ''))
      release()
      assert.equal((await (await p).done).ok, true)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('MED-HIGH 4: строже посреди заведения треда (full → read-only) — следующий ход несёт строгий режим', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    let calls = 0
    const r = codexRig(false, {}, async () => { calls++; if (calls === 1) await gate; return { servers: {} } })
    try {
      await r.adapter.startSession({ name: 'c', cwd: r.cwd, mode: 'turn', broker: true, approval: 'full' })
      const p = r.adapter.send('c', 'раз')
      await sleep(300)
      r.adapter.configure?.('c', { approval: 'read-only' })
      release()
      await (await p).done
      await (await r.adapter.send('c', 'два')).done
      const ts = r.client().find((m) => m.method === 'thread/start')?.params ?? {}
      assert.deepEqual([ts['sandbox'], ts['approvalPolicy']], ['danger-full-access', 'never'])
      const t2 = r.client().filter((m) => m.method === 'turn/start').at(-1)?.params ?? {}
      assert.deepEqual([t2['approvalPolicy'], t2['sandboxPolicy']], ['on-request', { type: 'readOnly' }])
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('браузер уже в загруженном треде — режим без вопросов отказ (его вызовы шли бы мимо Inbox); тише — можно', async () => {
    const r = codexRig(true)
    try {
      await r.adapter.startSession({ name: 'c', cwd: r.cwd, mode: 'turn', broker: true })
      await (await r.adapter.send('c', 'раз')).done
      assert.ok((r.client().find((m) => m.method === 'thread/start')?.params?.['config'] as Record<string, unknown> | undefined)?.['mcp_servers'], 'браузер в треде')
      assert.throws(() => r.adapter.configure?.('c', { approval: 'workspace' }), (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /мимо Inbox/.test(e.message ?? ''))
      assert.equal(r.adapter.configure?.('c', { approval: 'read-only' }), 'next_turn')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('тред ещё не заведён — режим уходит в thread/start, turn/start без политики', async () => {
    const r = codexRig()
    try {
      await r.adapter.startSession({ name: 'c', cwd: r.cwd, mode: 'turn', broker: true })
      r.adapter.configure?.('c', { approval: 'workspace' })
      await (await r.adapter.send('c', 'раз')).done
      const start = r.client().find((m) => m.method === 'thread/start')?.params ?? {}
      assert.deepEqual([start['sandbox'], start['approvalPolicy']], ['workspace-write', 'never'])
      const turn = r.client().find((m) => m.method === 'turn/start')?.params ?? {}
      assert.equal('sandboxPolicy' in turn, false)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

// --- демон -----------------------------------------------------------------------------------------------

function claudeWork(root: string, name: string): { cwd: string; argvOut: string } {
  const cwd = join(root, name)
  mkdirSync(cwd, { recursive: true })
  const argvOut = join(root, `${name}.argv.jsonl`)
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, argvOut }))
  return { cwd, argvOut }
}
const lastArgv = (file: string): string[] =>
  (JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1) as string) as { argv: string[] }).argv
type Ev = { kind: string; data: Record<string, unknown> }

describe('M8f: демон — agent.configure', () => {
  it('проверка, журнал session.configured, следующий ход с новыми флагами, запись переживает рестарт', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-m8f-d-'))
    const w = claudeWork(root, 'w')
    let d = await startTestDaemon(home)
    let c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'w', kind: 'claude', cwd: w.cwd, model: 'haiku', effort: 'low' })
      await c.request('agent.prompt', { name: 'w', text: 'привет' })
      await c.request('agent.wait', { name: 'w', timeoutMs: 10_000 })
      await assert.rejects(c.request('agent.configure', { name: 'w' }), code('invalid_params'))
      await assert.rejects(c.request('agent.configure', { name: 'w', model: 'gpt-5' }), code('invalid_params'))
      await assert.rejects(c.request('agent.configure', { name: 'w', approval: 'full' }), code('invalid_params'))
      await assert.rejects(c.request('agent.configure', { name: 'nope', model: 'opus' }), code('not_found'))
      const r = (await c.request('agent.configure', { name: 'w', model: 'opus', effort: 'high', approval: 'read-only' })) as Record<string, unknown>
      assert.deepEqual([r['model'], r['effort'], r['approval'], r['when']], ['opus', 'high', 'read-only', 'next_turn'])
      const same = (await c.request('agent.configure', { name: 'w', model: 'opus' })) as Record<string, unknown>
      assert.deepEqual(same['changes'], {}, 'то же значение — ничего не меняется, события нет')
      const evs = ((await c.request('events.tail', { since: 0, sessionId: 'w' })) as { events: Ev[] }).events.filter((e) => e.kind === 'session.configured')
      assert.equal(evs.length, 1)
      assert.deepEqual(evs[0]!.data, { changes: { model: { from: 'haiku', to: 'opus' }, effort: { from: 'low', to: 'high' }, approval: { from: 'ask', to: 'read-only' } }, when: 'next_turn' })
      await c.request('agent.prompt', { name: 'w', text: 'дальше' })
      await c.request('agent.wait', { name: 'w', timeoutMs: 10_000 })
      const argv = lastArgv(w.argvOut)
      assert.deepEqual([flag(argv, '--model'), flag(argv, '--effort'), flag(argv, '--permission-mode')], ['opus', 'high', 'manual'])
      assert.ok(argv.includes('--resume'))
      // Полный доступ — с подтверждением; обратно в ask — поля нет.
      await c.request('agent.configure', { name: 'w', approval: 'full', confirm: true })
      await c.request('agent.configure', { name: 'w', approval: 'ask', effort: 'medium' })

      c.close(); await d.stop('рестарт')
      const saved = parseSessions(JSON.parse(readFileSync(home.paths.sessions, 'utf8'))).find((s) => s.name === 'w')!
      assert.deepEqual([saved.model, saved.effort, saved.approval], ['opus', 'medium', undefined])
      d = await startTestDaemon(home)
      c = await connectClient(home.paths)
      await c.request('agent.configure', { name: 'w', model: 'sonnet' })
      await c.request('agent.prompt', { name: 'w', text: 'после рестарта' })
      await c.request('agent.wait', { name: 'w', timeoutMs: 10_000 })
      const after = lastArgv(w.argvOut)
      assert.deepEqual([flag(after, '--model'), flag(after, '--effort'), after.includes('--permission-mode')], ['sonnet', 'medium', false])
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('окно модели меньше занятого контекста — needs_confirm; Codex — по живому списку', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-m8f-w-'))
    let listed = 0
    const d = await startTestDaemon(home, {
      codexModels: async () => { listed++; return CODEX.map((m) => ({ id: m.id, label: m.id, efforts: [...m.efforts], defaultEffort: m.defaultEffort, isDefault: m.isDefault === true })) },
    })
    const c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'big', kind: 'claude', cwd: claudeWork(root, 'big').cwd, model: 'opus' })
      await c.request('agent.start', { name: 'small', kind: 'claude', cwd: claudeWork(root, 'small').cwd, model: 'sonnet' })
      d.manager.emit({ sessionId: 'small', provider: 'claude', kind: 'context.updated', data: { used: 1000, window: 200_000, model: 'claude-sonnet-5-5' } })
      d.manager.emit({ sessionId: 'big', provider: 'claude', kind: 'context.updated', data: { used: 300_000, window: 1_000_000, model: 'claude-opus-5-5[1m]' } })
      await assert.rejects(c.request('agent.configure', { name: 'big', model: 'sonnet' }),
        (e: { code?: string; message?: string }) => e.code === 'needs_confirm' && /не влезет: 300k > 200k/.test(e.message ?? ''))
      const ok = (await c.request('agent.configure', { name: 'big', model: 'sonnet', confirm: true })) as Record<string, unknown>
      assert.equal(ok['model'], 'sonnet')

      await c.request('agent.start', { name: 'cx', kind: 'codex', cwd: root, model: 'gpt-fast', effort: 'low' })
      await assert.rejects(c.request('agent.configure', { name: 'cx', model: 'gpt-x' }), code('invalid_params'))
      await assert.rejects(c.request('agent.configure', { name: 'cx', effort: 'ultra' }), code('invalid_params'))
      const deep = (await c.request('agent.configure', { name: 'cx', model: 'gpt-deep' })) as Record<string, unknown>
      assert.deepEqual([deep['model'], deep['effort']], ['gpt-deep', 'high'], 'усилия low у gpt-deep нет — её умолчание')
      // Только режим — список моделей не нужен (ревью, LOW 9): app-server ради него не поднимается.
      const before = listed
      await c.request('agent.configure', { name: 'cx', approval: 'read-only' })
      assert.equal(listed, before)
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('браузер: режим без вопросов выключает его (и говорит), возврат в «спрашивать» включает обратно', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-m8f-b-'))
    const d = await startTestDaemon(home, {
      browserInstall: async (p: PultPaths) => ({ installed: false, version: PLAYWRIGHT_MCP_VERSION, path: browserPrefix(p) }),
      findChrome: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    })
    const c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'b', kind: 'claude', cwd: claudeWork(root, 'b').cwd, browser: { headed: true } })
      const off = (await c.request('agent.configure', { name: 'b', approval: 'full', confirm: true })) as Record<string, unknown>
      assert.equal(off['browser'], undefined)
      assert.equal((off['changes'] as Record<string, unknown>)['browser'], 'off')
      const on = (await c.request('agent.configure', { name: 'b', approval: 'workspace' })) as Record<string, unknown>
      assert.deepEqual(on['browser'], { headed: true }, 'вернулся выбор человека — с окном')
      assert.equal((on['changes'] as Record<string, unknown>)['browser'], 'on')
      // Выключил сам, пока режим держал браузер, — возвращать нечего.
      await c.request('agent.configure', { name: 'b', approval: 'full', confirm: true })
      await c.request('agent.browser', { name: 'b', on: false })
      const back = (await c.request('agent.configure', { name: 'b', approval: 'ask' })) as Record<string, unknown>
      assert.equal(back['browser'], undefined)
      const evs = ((await c.request('events.tail', { since: 0, sessionId: 'b' })) as { events: Ev[] }).events.filter((e) => e.kind === 'session.configured')
      assert.deepEqual(evs.map((e) => (e.data['changes'] as Record<string, unknown>)['browser'] ?? null), ['off', 'on', 'off', null])
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
})

describe('M8f: демон — settings.get|set и последний выбор', () => {
  it('set пишет только newSession (прочее в config.json не трогает), строгий отказ; get отдаёт и последний выбор', async () => {
    const home = tempHome()
    writeFileSync(home.paths.config, JSON.stringify({ version: 1, network: { claude: { mode: 'auto', proxy: 'http://127.0.0.1:9' } }, custom: 42 }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      const got = (await c.request('settings.get')) as Record<string, unknown>
      assert.deepEqual(got, { newSession: { rememberLast: true, defaults: { claude: {}, codex: {} } }, lastUsed: {} })
      await assert.rejects(c.request('settings.set', { network: { claude: { mode: 'off' } } }), code('invalid_params'))
      await assert.rejects(c.request('settings.set', { newSession: { rememberLast: true }, notifyCommand: 'curl x' }), code('invalid_params'))
      await assert.rejects(c.request('settings.set', { newSession: { defaults: { claude: { approval: 'full' } } } }), code('invalid_params'))
      await assert.rejects(c.request('settings.set', { newSession: { defaults: { claude: { proxy: 'http://evil' } } } }), code('invalid_params'))
      const ns = { rememberLast: false, defaults: { provider: 'codex', claude: { model: 'opus' }, codex: { effort: 'high', approval: 'read-only' } } }
      const set = (await c.request('settings.set', { newSession: ns })) as Record<string, unknown>
      assert.deepEqual(set['newSession'], ns)
      const file = JSON.parse(readFileSync(home.paths.config, 'utf8')) as Record<string, unknown>
      assert.deepEqual(file['network'], { claude: { mode: 'auto', proxy: 'http://127.0.0.1:9' } }, 'сеть не тронута')
      assert.equal(file['custom'], 42)
      assert.deepEqual(file['newSession'], ns)
      assert.deepEqual(((await c.request('settings.get')) as Record<string, unknown>)['newSession'], ns)
    } finally { c.close(); await d.stop('конец теста'); home.remove() }
  })

  it('последний выбор — только agent.start из окна (клиент shell): без full, папка — если форма открыта без папки', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-m8f-l-'))
    const d = await startTestDaemon(home)
    const cli = await connectClient(home.paths)
    const win = await connectClient(home.paths, { client: 'shell' })
    try {
      await cli.request('agent.start', { name: 'a', kind: 'claude', cwd: claudeWork(root, 'a').cwd, model: 'opus' })
      assert.equal(existsSync(home.paths.newSessionLast), false, 'CLI последний выбор не трогает')
      const b = claudeWork(root, 'b').cwd
      await win.request('agent.start', { name: 'b', kind: 'claude', cwd: b, model: 'opus', effort: 'high', approval: 'full', confirm: true, mode: 'warm', worktree: undefined })
      const last = ((await win.request('settings.get')) as { lastUsed: Record<string, unknown> }).lastUsed
      assert.deepEqual([last['provider'], last['cwd'], last['claude']], ['claude', b, { model: 'opus', effort: 'high', mode: 'warm', browser: false, worktree: false }])
      await win.request('agent.start', { name: 'c', kind: 'codex', cwd: root, approval: 'read-only', rememberCwd: false })
      const last2 = ((await win.request('settings.get')) as { lastUsed: Record<string, unknown> }).lastUsed
      assert.deepEqual([last2['provider'], last2['cwd'], last2['codex']], ['codex', b, { approval: 'read-only', mode: 'turn', browser: false, worktree: false }])
    } finally { cli.close(); win.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
})

// --- CLI ------------------------------------------------------------------------------------------------

interface Run { code: number; stdout: string; stderr: string }
function runCli(paths: PultPaths, args: string[], timeoutMs = 25_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, PULT_HOME: paths.home, PULT_TEST: '1', PULT_TEST_NET: 'ok', PULT_CLAUDE_BIN: FAKE_CLAUDE, PULT_CODEX_BIN: FAKE_CODEX_SCRIPTED },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pult ${args.join(' ')} не завершился`)) }, timeoutMs)
    child.on('close', (n) => { clearTimeout(timer); resolve({ code: n ?? -1, stdout, stderr }) })
  })
}

describe('M8f: CLI — pult agent set и умолчания pult agent start', () => {
  it('флаги, --yes для full, строка «со следующего хода»; start без флагов — newSession.defaults, не последний выбор', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-m8f-cli-'))
    const paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    const work = join(dir, 'work')
    mkdirSync(work)
    // Провайдер и тёплый процесс из умолчаний CLI не берёт (ревью, LOW 11): скрипт не меняет их молча.
    writeFileSync(paths.config, JSON.stringify({ version: 1, newSession: { defaults: { provider: 'codex', claude: { model: 'opus', effort: 'high', approval: 'read-only', mode: 'warm' }, codex: { model: 'gpt-x' } } } }))
    // Последний выбор окна — другой: CLI его не берёт.
    writeFileSync(paths.newSessionLast, JSON.stringify({ provider: 'codex', codex: { model: 'x' } }))
    try {
      const start = await runCli(paths, ['agent', 'start', 'w', '--cwd', work])
      assert.equal(start.code, 0, start.stderr)
      assert.match(start.stderr, /из настроек \(newSession\.defaults\): модель opus, усилие high, режим read-only$/m)
      const list = JSON.parse((await runCli(paths, ['agent', 'list', '--json'])).stdout) as { sessions: Array<Record<string, unknown>> }
      const w = list.sessions.find((s) => s['name'] === 'w')!
      assert.deepEqual([w['provider'], w['model'], w['effort'], w['approval'], w['mode']], ['claude', 'opus', 'high', 'read-only', 'turn'])
      const flagWins = await runCli(paths, ['agent', 'start', 'v', '--cwd', work, '--model', 'haiku', '--approval', 'ask'])
      assert.equal(flagWins.code, 0, flagWins.stderr)
      const v = (JSON.parse((await runCli(paths, ['agent', 'list', '--json'])).stdout) as { sessions: Array<Record<string, unknown>> }).sessions.find((s) => s['name'] === 'v')!
      assert.deepEqual([v['model'], v['approval']], ['haiku', undefined])

      const usage = await runCli(paths, ['agent', 'set', 'w'])
      assert.equal(usage.code, 1)
      const noYes = await runCli(paths, ['agent', 'set', 'w', '--approval', 'full'])
      assert.equal(noYes.code, 1)
      assert.match(noYes.stderr, /--yes/)
      const bad = await runCli(paths, ['agent', 'set', 'w', '--model', 'gpt-5'])
      assert.equal(bad.code, 1)
      assert.match(bad.stderr, /нет у claude/)
      const ok = await runCli(paths, ['agent', 'set', 'w', '--model', 'sonnet', '--effort', 'low', '--approval', 'ask'])
      assert.equal(ok.code, 0, ok.stderr)
      assert.match(ok.stdout, /^w: модель: opus → sonnet · усилие: high → low · режим: только чтение → спрашивать — со следующего хода$/m)
      assert.match(ok.stderr, /кэш промпта у каждой модели свой/)
      const full = await runCli(paths, ['agent', 'set', 'w', '--approval', 'full', '--yes', '--json'])
      assert.equal(full.code, 0, full.stderr)
      assert.equal((JSON.parse(full.stdout) as Record<string, unknown>)['approval'], 'full')
    } finally {
      await runCli(paths, ['daemon', 'stop']).catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
