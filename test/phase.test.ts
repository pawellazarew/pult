// Фаза хода (0.3.5): вывод фазы из записанных потоков обоих провайдеров, живой канал мимо журнала, снимок для
// свежей подписки и `agent.list`. Фикстуры — test/fixtures/{claude,codex}: настоящие порядки событий.

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createClaudeMapper } from '../dist/adapters/claude/mapper.js'
import { createCodexMapper } from '../dist/adapters/codex/mapper.js'
import { connectClient } from '../dist/cli/client.js'
import type { Client } from '../dist/cli/client.js'
import type { EventDraft, PultEvent } from '../dist/core/events.js'
import { createLiveChannel } from '../dist/daemon/live.js'
import type { LiveFrame } from '../dist/daemon/live.js'
import { createPhaseTracker } from '../dist/sessions/phaseTracker.js'
import type { PhaseTracker } from '../dist/sessions/phaseTracker.js'
import { LIVE_CURSOR_BASE, REASONING_TAIL } from '../dist/sessions/turnPhase.js'
import type { TurnPhase } from '../dist/sessions/turnPhase.js'
import { FAKE_CODEX_SCRIPTED, startTestDaemon, tempHome, waitFor } from './helpers.js'

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url))

interface Rig {
  tr: PhaseTracker
  seen: Array<TurnPhase | null>
  feed(d: EventDraft): void
  status(s: string, extra?: Record<string, unknown>): void
}

/** Трекер на часах-счётчике; `seen` — фаза сессии `w` после каждой перемены. */
function rig(): Rig {
  let t = 1_000
  let id = 0
  const seen: Array<TurnPhase | null> = []
  const tr = createPhaseTracker({ now: () => (t += 10), onChange: (name) => { if (name === 'w') seen.push(tr.get('w')) } })
  const ev = (d: EventDraft): PultEvent => ({
    id: ++id, ts: '', sessionId: d.sessionId, provider: d.provider, kind: d.kind, data: d.data ?? {}, ...(d.parentId ? { parentId: d.parentId } : {}),
  })
  return {
    tr, seen,
    feed: (d) => tr.event(ev(d)),
    status: (s, extra = {}) => tr.event(ev({ sessionId: 'w', provider: 'claude', kind: 'status.changed', data: { status: s, ...extra } })),
  }
}

const label = (p: TurnPhase | null): string => {
  if (p === null) return 'none'
  if (p.phase === 'tool') return `tool:${p.tool?.name}`
  if (p.phase === 'waiting') return `waiting:${p.waiting?.kind}`
  return p.phase + (p.background ? `+bg${p.background}` : '')
}
const compact = (xs: string[]): string[] => xs.filter((x, i) => i === 0 || x !== xs[i - 1])
const labels = (r: Rig): string[] => compact(r.seen.map(label))

/**
 * Проиграть запись Claude так, как её видит менеджер: реплика принята, адаптер поставил `working`, дальше строки
 * через настоящий переводчик (события — в трекер, живые сигналы — тоже), `result` закрывает ход (`idle`), а
 * `system/init` без хода (Claude сам взял итоги фоновых задач) — `working`, как пишет адаптер.
 */
function playClaude(name: string): Rig {
  const r = rig()
  r.tr.accepted('w')
  r.status('working', { turnId: 't1' })
  const mapper = createClaudeMapper({ sessionId: 'w' })
  for (const line of readFileSync(join(FIXTURES, 'claude', `${name}.jsonl`), 'utf8').split('\n')) {
    let native: unknown
    try { native = JSON.parse(line) } catch { continue }
    const out = mapper.push(native)
    for (const s of out.signals) if (s.kind === 'turn_started') r.status('working')
    for (const d of out.drafts) r.feed(d)
    for (const s of out.live ?? []) r.tr.live('w', s)
    for (const s of out.signals) if (s.kind === 'result') r.status('idle', { turnId: 't1' })
  }
  return r
}

/**
 * Запись Codex: события своего треда — без родителя, треда субагента — с узлом из `subAgentActivity`, чужие —
 * мимо (как демультиплексор адаптера). Запрос разрешения сервера — как его пишет брокер (`permission.requested`),
 * ответ — сразу (ответов клиента в записи нет). `turn/completed` закрывает ход.
 */
function playCodex(name: string): Rig {
  const r = rig()
  r.tr.accepted('w')
  r.status('working', { turnId: 't1' })
  const mapper = createCodexMapper({ sessionId: 'w' })
  const raws = readFileSync(join(FIXTURES, 'codex', `${name}.jsonl`), 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { id?: number; method?: string; params: Record<string, unknown> })
  const own = raws.find((x) => x.method === 'turn/started')?.params['threadId']
  const kids = new Map<string, string>()
  let perm = 0
  for (const raw of raws) {
    if (!raw.method) continue
    if (raw.id !== undefined) {
      const id = `p${++perm}`
      r.feed({ sessionId: 'w', provider: 'pult', kind: 'permission.requested', data: { id, toolName: 'commandExecution' } })
      r.feed({ sessionId: 'w', provider: 'pult', kind: 'permission.resolved', data: { id, decision: 'deny' } })
      continue
    }
    const thread = raw.params['threadId'] as string | undefined
    const parentId = thread ? kids.get(thread) : undefined
    if (thread && thread !== own && parentId === undefined) continue
    const out = mapper.push(raw.method, raw.params, parentId ? { parentId } : {})
    for (const d of out.drafts) r.feed(d)
    for (const s of out.live ?? []) r.tr.live('w', s)
    for (const s of out.signals) {
      if (s.kind === 'subagent_started') kids.set(s.agentThreadId, s.nodeId)
      if (s.kind === 'turn_completed') r.status('idle', { turnId: 't1' })
    }
  }
  return r
}

describe('фаза хода: вывод из записанных потоков Claude', () => {
  it('01 простой ход: запускается → думает (init) → пишет (дельты) → строки нет; блок размышлений пустой — текста нет', () => {
    const r = playClaude('01-simple-turn')
    assert.deepEqual(labels(r), ['starting', 'thinking', 'writing', 'none'])
    assert.ok(r.seen.every((p) => !p?.reasoning), 'пустой thinking_delta не даёт текста «Размышлений»')
  })

  it('02 тёплый процесс, два хода: второй ход — заново от «думает»', () => {
    assert.deepEqual(labels(playClaude('02-warm-two-turns')), ['starting', 'thinking', 'writing', 'none', 'thinking', 'writing', 'none'])
  })

  it('05 инструмент: «выполняет: Bash touch probe.txt», после результата — снова «думает», потом ответ', () => {
    const r = playClaude('05-permission-bash-deny')
    assert.deepEqual(labels(r), ['starting', 'thinking', 'tool:Bash', 'thinking', 'writing', 'none'])
    const tool = r.seen.find((p) => p?.phase === 'tool')
    assert.deepEqual(tool?.tool, { name: 'Bash', detail: 'touch probe.txt' })
  })

  it('06 субагент: строка — про Agent; его собственные инструменты и текст (parentId) фазу не двигают', () => {
    const r = playClaude('06-subagent')
    const ls = labels(r)
    assert.deepEqual(ls.slice(0, 3), ['starting', 'thinking', 'tool:Agent'])
    assert.ok(!ls.some((l) => l.startsWith('tool:') && l !== 'tool:Agent'), ls.join(' → '))
  })

  it('12 фоновые задачи: после ответа — «фоновые задачи: N», задачи кончились — строки нет', () => {
    const r = playClaude('12-background-live')
    const ls = labels(r)
    assert.ok(ls.includes('background+bg1'), ls.join(' → '))
    assert.ok(ls.includes('background+bg2'), ls.join(' → '))
    assert.equal(ls.at(-1), 'none')
    const bg = r.seen.find((p) => p?.phase === 'background')
    assert.equal(bg?.background, 1)
  })

  it('разрешение: «ждёт тебя» со ссылкой на запрос; ответ — обратно к инструменту; вопрос модели — «question»', () => {
    const r = rig()
    r.tr.accepted('w')
    r.status('working', { turnId: 't1' })
    r.feed({ sessionId: 'w', provider: 'claude', kind: 'tool.called', data: { toolUseId: 'u1', name: 'Bash', input: { command: 'rm -rf build' } } })
    r.feed({ sessionId: 'w', provider: 'pult', kind: 'permission.requested', data: { id: 'p1-ab', toolName: 'Bash', toolUseId: 'u1', input: {} } })
    assert.deepEqual(r.tr.get('w')?.waiting, { kind: 'permission', permId: 'p1-ab', toolName: 'Bash' })
    // Запоздалая дельта не прячет вопрос.
    r.feed({ sessionId: 'w', provider: 'claude', kind: 'message.delta', data: { text: 'x' } })
    assert.equal(r.tr.get('w')?.phase, 'waiting')
    r.feed({ sessionId: 'w', provider: 'pult', kind: 'permission.resolved', data: { id: 'p1-ab', decision: 'allow' } })
    assert.deepEqual(r.tr.get('w')?.tool, { name: 'Bash', detail: 'rm -rf build' })
    r.feed({ sessionId: 'w', provider: 'pult', kind: 'permission.requested', data: { id: 'p2-ab', toolName: 'AskUserQuestion', input: {} } })
    assert.equal(r.tr.get('w')?.waiting?.kind, 'question')
    r.status('interrupted', { turnId: 't1' })
    assert.equal(r.tr.get('w'), null)
  })

  it('ход не завёлся без события конца (resume упал) — фазу снимает менеджер; предупреждение о лимите ход не кончает', () => {
    const r = rig()
    r.tr.accepted('w')
    r.status('limited', { rateLimitStatus: 'allowed_warning', turnId: 't1' })
    assert.equal(r.tr.get('w')?.phase, 'starting')
    r.tr.abandoned('w')
    assert.equal(r.tr.get('w'), null)
  })
})

describe('фаза хода: вывод из записанных потоков Codex', () => {
  it('01 простой ход: turn/started — «думает», agentMessage/delta — «пишет», turn/completed — строки нет', () => {
    assert.deepEqual(labels(playCodex('01-simple-turn')), ['starting', 'thinking', 'writing', 'none'])
  })

  it('02 разрешение на команду: выполняет → ждёт тебя → выполняет → думает', () => {
    const r = playCodex('02-permission-decline')
    assert.deepEqual(labels(r), ['starting', 'thinking', 'tool:commandExecution', 'waiting:permission', 'tool:commandExecution', 'thinking', 'none'])
    assert.match(r.seen.find((p) => p?.phase === 'tool')?.tool?.detail ?? '', /echo hi > x\.txt/)
  })

  it('04 субагент: строка — про узел Agent и `wait`, текст ребёнка (свой тред) фазу не двигает', () => {
    const ls = labels(playCodex('04-subagent'))
    assert.deepEqual(ls, ['starting', 'thinking', 'writing', 'tool:Agent', 'tool:wait', 'none'])
  })

  it('сводка размышлений (форма схемы 0.163): «думает» с текстом; новая часть — с новой строки; хвост ≤ 4 КБ; секрет замаскирован', () => {
    const r = rig()
    r.tr.accepted('w')
    const m = createCodexMapper({ sessionId: 'w' })
    const push = (method: string, params: Record<string, unknown>, parentId?: string): void => {
      const out = m.push(method, { threadId: 't', turnId: 'u', ...params }, parentId ? { parentId } : {})
      for (const d of out.drafts) r.feed(d)
      for (const s of out.live ?? []) r.tr.live('w', s)
    }
    push('turn/started', { turn: { id: 'u' } })
    push('item/started', { item: { type: 'reasoning', id: 'rs', summary: [], content: [] } })
    push('item/reasoning/summaryPartAdded', { itemId: 'rs', summaryIndex: 0 })
    push('item/reasoning/summaryTextDelta', { itemId: 'rs', summaryIndex: 0, delta: `ключ ${'sk-'}ant-api03-${'B'.repeat(30)} ` })
    for (let i = 0; i < 2000; i++) push('item/reasoning/summaryTextDelta', { itemId: 'rs', summaryIndex: 0, delta: 'мысль ' })
    push('item/reasoning/summaryPartAdded', { itemId: 'rs', summaryIndex: 1 })
    push('item/reasoning/summaryTextDelta', { itemId: 'rs', summaryIndex: 1, delta: 'ИТОГ' })
    // Размышления ребёнка-субагента в строку родителя не идут.
    push('item/reasoning/summaryTextDelta', { itemId: 'rs2', summaryIndex: 0, delta: 'ЧУЖОЕ' }, 'call_1')
    const p = r.tr.get('w')
    assert.equal(p?.phase, 'thinking')
    assert.match(p?.reasoning ?? '', /мысль\s*\n\nИТОГ$/)
    assert.ok((p?.reasoning?.length ?? 0) <= REASONING_TAIL)
    assert.ok(!p?.reasoning?.includes('ЧУЖОЕ'))
    assert.equal(r.tr.get('w', { reasoning: false })?.reasoning, undefined, 'agent.list — без текста')

    const r2 = rig()
    r2.tr.accepted('w')
    r2.tr.live('w', { kind: 'reasoning', text: `начало ключ ${'sk-'}ant-api03-${'C'.repeat(30)} конец` })
    assert.match(r2.tr.get('w')?.reasoning ?? '', /начало ключ <token> конец/)
  })
})

describe('живой канал: темп, номера, снимок', () => {
  it('поток перемен — первый кадр сразу, дальше не чаще раза в minGap (последнее значение); без подписчиков — ни одного', async () => {
    let phase: TurnPhase | null = { phase: 'thinking', since: 1, turnSince: 1 }
    const ch = createLiveChannel({ phase: () => phase, names: () => (phase ? ['w'] : []), minGapMs: 40 })
    for (let i = 0; i < 500; i++) ch.touch('w')
    const frames: LiveFrame[] = []
    const sub = ch.subscribe(LIVE_CURSOR_BASE, (f) => frames.push(f))
    sub.start()
    assert.deepEqual(frames.map((f) => [f.sessionId, f.kind, f.data]), [['daemon', 'turn.phase', { reset: true }], ['w', 'turn.phase', { phase }]])
    frames.length = 0
    for (let i = 0; i < 500; i++) { phase = { phase: 'thinking', since: 1, turnSince: 1, reasoning: `x${i}` }; ch.touch('w') }
    assert.equal(frames.length, 1, 'первая перемена — сразу')
    await new Promise((res) => setTimeout(res, 120))
    assert.equal(frames.length, 2, 'остальные 499 — одним кадром после паузы')
    assert.equal((frames[1]?.data as { phase: TurnPhase }).phase.reasoning, 'x499')
    phase = null
    ch.touch('w')
    await new Promise((res) => setTimeout(res, 120))
    assert.deepEqual(frames.at(-1)?.data, { phase: null })
    for (let i = 1; i < frames.length; i++) assert.ok((frames[i]?.id ?? 0) > (frames[i - 1]?.id ?? 0), 'номера растут')
    sub.stop()
    // Переподписка оболочки после рестарта: номера — выше её курсора, иначе она выбросила бы кадры.
    const ch2 = createLiveChannel({ phase: () => null, names: () => [] })
    const got: LiveFrame[] = []
    const cursor = LIVE_CURSOR_BASE + 123_456
    ch2.subscribe(cursor, (f) => got.push(f)).start()
    assert.ok((got[0]?.id ?? 0) > cursor)
    ch.close(); ch2.close()
  })
})

// --- демон целиком: фальшивый claude и программируемый codex ------------------------------------------------

type Frame = { id: number; kind: string; sessionId: string; data: { reset?: true; phase?: TurnPhase | null } }

/** Живая подписка так, как её открывает окно 0.1.15: только курсор от базы. */
async function liveFrames(c: Client): Promise<Frame[]> {
  const frames: Frame[] = []
  await c.subscribe({ since: LIVE_CURSOR_BASE }, (ev) => { frames.push(ev as unknown as Frame) })
  return frames
}
const phasesOf = (frames: Frame[], name: string): Array<TurnPhase | null> =>
  frames.filter((f) => f.sessionId === name && f.data.phase !== undefined).map((f) => f.data.phase ?? null)
const journalKinds = (home: string): string[] => readdirSync(join(home, 'events')).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => readFileSync(join(home, 'events', f), 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { kind: string }).kind))

describe('фаза хода в демоне', () => {
  it('claude: живой канал — думает → выполняет → строки нет; agent.list и свежая подписка посреди хода знают фазу; журнал без кадров', async () => {
    const home = tempHome()
    const cwd = mkdtempSync(join(tmpdir(), 'pt-ph-'))
    writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'demo-working', speed: 0, hangAfterInit: 700, hangAfterTool: 500 }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    let c2: Client | null = null
    try {
      const frames = await liveFrames(c)
      await c.request('agent.start', { name: 'ph', kind: 'claude', cwd })
      assert.ok(await waitFor(() => frames.some((f) => f.data.reset === true), 3000), 'нет кадра reset')
      const t0 = Date.now()
      await c.request('agent.prompt', { name: 'ph', text: 'посмотри шапку' })
      assert.ok(await waitFor(() => phasesOf(frames, 'ph').some((p) => p?.phase === 'thinking'), 3000), 'нет «думает»')
      assert.ok(Date.now() - t0 < 3000)

      // Посреди хода: agent.list (без текста размышлений) и свежая подписка (reset + текущая фаза).
      const rec = ((await c.request('agent.list')) as { sessions: Array<{ name: string; phase?: TurnPhase }> }).sessions.find((s) => s.name === 'ph')
      assert.equal(rec?.phase?.phase, 'thinking')
      assert.equal(typeof rec?.phase?.since, 'number')
      c2 = await connectClient(home.paths)
      const fresh = await liveFrames(c2)
      assert.ok(await waitFor(() => fresh.length >= 2, 2000))
      assert.deepEqual(fresh[0]?.data, { reset: true })
      assert.equal(fresh.find((f) => f.sessionId === 'ph')?.data.phase?.phase, 'thinking')
      assert.ok((fresh[0]?.id ?? 0) > LIVE_CURSOR_BASE)

      assert.ok(await waitFor(() => phasesOf(frames, 'ph').some((p) => p?.phase === 'tool'), 5000), 'нет «выполняет»')
      const tool = phasesOf(frames, 'ph').find((p) => p?.phase === 'tool')
      assert.deepEqual(tool?.tool, { name: 'Read', detail: 'ui/src/components/Header.tsx' })
      await c.request('agent.wait', { name: 'ph', timeoutMs: 15_000 })
      assert.ok(await waitFor(() => phasesOf(frames, 'ph').at(-1) === null, 3000), 'строка не ушла с концом хода')
      const seq = compact(phasesOf(frames, 'ph').map(label))
      assert.equal(seq[0], 'starting')
      assert.deepEqual(seq.slice(1, 3), ['thinking', 'tool:Read'])
      assert.ok(seq.includes('tool:Agent'), seq.join(' → '))
      assert.ok(!((await c.request('agent.list')) as { sessions: Array<{ phase?: unknown }> }).sessions[0]?.phase)

      // Ни одного кадра фазы в журнале.
      const kinds = journalKinds(home.paths.home)
      assert.ok(kinds.includes('message.done') && !kinds.includes('turn.phase' as string), kinds.join(','))
    } finally {
      c2?.close(); c.close(); await d.stop('конец теста'); home.remove(); rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('codex: 200 дельт сводки размышлений — несколько кадров, текст в окне без секрета, в журнале ни строчки; потом команда, ответ, конец', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-ph-c-'))
    writeFileSync(join(home.paths.home, '.pult-fake-scripted.json'), JSON.stringify({ phasePauseMs: 400 }))
    const d = await startTestDaemon(home, { codexBin: FAKE_CODEX_SCRIPTED })
    const c = await connectClient(home.paths)
    try {
      const frames = await liveFrames(c)
      await c.request('agent.start', { name: 'cx', kind: 'codex', cwd: root })
      const before = journalKinds(home.paths.home).length
      await c.request('agent.prompt', { name: 'cx', text: 'подумай [[reasoning]]' })
      assert.ok(await waitFor(() => phasesOf(frames, 'cx').some((p) => p?.reasoning?.includes('ИТОГ-РАЗМЫШЛЕНИЙ')), 8000), 'текст размышлений не дошёл')
      const thinking = phasesOf(frames, 'cx').filter((p) => p?.phase === 'thinking' && p.reasoning)
      assert.ok(thinking.length <= 6, `кадров с размышлениями ${thinking.length} — темп не держится`)
      const text = thinking.at(-1)?.reasoning ?? ''
      assert.ok(text.includes('<token>') && !text.includes('sk-ant'), 'секрет в размышлениях не замаскирован')
      assert.ok(text.endsWith('\n\nИТОГ-РАЗМЫШЛЕНИЙ'), text.slice(-60))

      await c.request('agent.wait', { name: 'cx', timeoutMs: 15_000 })
      assert.ok(await waitFor(() => phasesOf(frames, 'cx').at(-1) === null, 3000))
      const seq = compact(phasesOf(frames, 'cx').map(label))
      assert.deepEqual(seq.filter((l) => l !== 'starting'), ['thinking', 'tool:commandExecution', 'thinking', 'writing', 'none'], seq.join(' → '))
      assert.deepEqual(phasesOf(frames, 'cx').find((p) => p?.phase === 'tool')?.tool, { name: 'commandExecution', detail: 'npm test' })

      // Журнал: дельты ответа и инструмент — как всегда; размышлений и кадров фазы нет ни одного.
      const kinds = journalKinds(home.paths.home)
      assert.ok(!kinds.includes('turn.phase' as string))
      const added = kinds.length - before
      assert.ok(added < 30, `ход с 200 дельтами размышлений добавил в журнал ${added} событий: ${kinds.slice(before).join(',')}`)
      const raw = readdirSync(join(home.paths.home, 'events')).map((f) => readFileSync(join(home.paths.home, 'events', f), 'utf8')).join('')
      assert.ok(!raw.includes('шаг 1') && !raw.includes('ИТОГ-РАЗМЫШЛЕНИЙ'), 'текст размышлений попал в журнал')
    } finally {
      c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true })
    }
  })
})
