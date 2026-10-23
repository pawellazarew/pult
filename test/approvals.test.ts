// M8d (решение владельца 19.10.2026): «Разрешить в сессии / всегда» в Inbox и «Как подтверждать действия»
// при заведении сессии; «Убрать из списка» для любого проекта. Всё герметично: фальшивые CLI, страж сети
// подменён, ни одного настоящего хода.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { buildClaudeArgv } from '../dist/adapters/claude/argv.js'
import {
  CODEX_EXEC_RULE_NOTE, CODEX_NET_RULE_NOTE, codexScopedOffers, codexThreadPolicy, createCodexAdapter, shellJoin,
} from '../dist/adapters/codex/adapter.js'
import type { ApprovalMode, ProviderAdapter } from '../dist/adapters/types.js'
import { connectClient } from '../dist/cli/client.js'
import { defaultConfig } from '../dist/core/config.js'
import type { EventDraft } from '../dist/core/events.js'
import { createLogger } from '../dist/core/log.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import type { NetCheck } from '../dist/env/net.js'
import { createBroker, ScopeError } from '../dist/perm/broker.js'
import type { PermBroker } from '../dist/perm/broker.js'
import { parseSessions } from '../dist/sessions/registry.js'
import { CLI_ENTRY, FAKE_CLAUDE, FAKE_CODEX_SCRIPTED, startTestDaemon, tempHome, waitFor } from './helpers.js'
import { buildClaudeArgv as argvOf, CLAUDE_READONLY_DENIED } from '../dist/adapters/claude/argv.js'
import { createProjectStore } from '../dist/projects/store.js'
import { fileURLToPath } from 'node:url'

/** Живой codex 0.163 (ревью M8d): params запросов разрешения как пришли — test/fixtures/codex/11-approval-params-0.163.json. */
const LIVE = JSON.parse(readFileSync(fileURLToPath(new URL('../test/fixtures/codex/11-approval-params-0.163.json', import.meta.url)), 'utf8')) as {
  command: { params: Record<string, unknown> }; fileChange: { params: Record<string, unknown> }
}

// Страж сети тестового демона отвечает «ок» без curl (работает только при testMode).
process.env['PULT_TEST_NET'] = 'ok'

const seenPids: number[] = []
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
after(() => {
  const survivors = seenPids.filter(alive)
  assert.deepEqual(survivors, [], `фальшивые app-server пережили тесты: ${survivors.join(', ')}`)
})

/** Измеренная форма запроса на команду (фикстура codex 03, спайк B2): поправка execpolicy предложена. */
const AMEND = ['/bin/zsh', '-lc', 'echo hi > x.txt']
const AMEND_OBJ = { acceptWithExecpolicyAmendment: { execpolicy_amendment: AMEND } }
const NET_OBJ = { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'example.com' } } }

// --- чистые функции ---------------------------------------------------------------------------------------

describe('M8d: codex — что предложено сверх «один раз»', () => {
  const CMD = 'item/commandExecution/requestApproval'
  it('shellJoin: префикс команды строкой, как в sh', () => {
    assert.equal(shellJoin(AMEND), "/bin/zsh -lc 'echo hi > x.txt'")
    assert.equal(shellJoin(['git', 'push']), 'git push')
    assert.equal(shellJoin(["it's"]), `'it'\\''s'`)
  })
  it('измеренная форма 03: правило execpolicy есть, «на сессию» нет (acceptForSession не предложен)', () => {
    const params = { proposedExecpolicyAmendment: AMEND, availableDecisions: ['accept', AMEND_OBJ, 'cancel'] }
    const got = codexScopedOffers(CMD, params, ['accept', 'cancel'])
    assert.deepEqual(got.offers, { rule: { kind: 'execpolicy', label: "/bin/zsh -lc 'echo hi > x.txt'", note: CODEX_EXEC_RULE_NOTE } })
    assert.deepEqual(got.rule, AMEND_OBJ, 'ответ «всегда» — ровно предложенная поправка')
  })
  it('acceptForSession среди предложенного — кнопка «в этой сессии»', () => {
    assert.deepEqual(codexScopedOffers(CMD, { availableDecisions: ['accept', 'acceptForSession', 'cancel'] }, ['accept', 'acceptForSession', 'cancel']),
      { offers: { session: true }, rule: null })
  })
  it('поправка предложена, но объекта среди availableDecisions нет — правила нет; объект без предложения — тоже нет', () => {
    assert.deepEqual(codexScopedOffers(CMD, { proposedExecpolicyAmendment: AMEND, availableDecisions: ['accept', 'cancel'] }, ['accept', 'cancel']),
      { offers: {}, rule: null })
    assert.deepEqual(codexScopedOffers(CMD, { availableDecisions: ['accept', AMEND_OBJ, 'cancel'] }, ['accept', 'cancel']), { offers: {}, rule: null })
    assert.deepEqual(codexScopedOffers(CMD, { proposedExecpolicyAmendment: [], availableDecisions: ['accept', AMEND_OBJ] }, ['accept']), { offers: {}, rule: null })
  })
  it('сеть: только allow-поправка И объект applyNetworkPolicyAmendment; deny-поправку «всегда» не берёт', () => {
    const params = {
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
      proposedNetworkPolicyAmendments: [{ action: 'deny', host: 'evil.test' }, { action: 'allow', host: 'example.com' }],
      availableDecisions: ['accept', NET_OBJ, 'decline', 'cancel'],
    }
    const got = codexScopedOffers(CMD, params, ['accept', 'decline', 'cancel'])
    assert.deepEqual(got.offers, { rule: { kind: 'network', label: 'example.com', note: CODEX_NET_RULE_NOTE } })
    assert.deepEqual(got.rule, NET_OBJ)
    assert.deepEqual(codexScopedOffers(CMD, { ...params, proposedNetworkPolicyAmendments: [{ action: 'deny', host: 'evil.test' }] }, []).rule, null)
    assert.deepEqual(codexScopedOffers(CMD, { ...params, availableDecisions: ['accept'] }, ['accept']).rule, null)
  })
  it('ЖИВАЯ форма 0.163: команда — правило ровно объектом из availableDecisions; правка файла — только «на сессию» (словарь схемы)', () => {
    const cmd = LIVE.command.params
    const avail = cmd['availableDecisions'] as unknown[]
    const got = codexScopedOffers(CMD, cmd, ['accept', 'cancel'])
    assert.equal(got.rule, avail[1], 'ушёл бы ТОТ ЖЕ объект, что прислал сервер')
    assert.equal(got.offers.session, undefined, 'живой сервер acceptForSession на команде не предлагает')
    assert.match(got.offers.rule?.label ?? '', /^curl -sS -o \/dev\/null/)
    assert.deepEqual(codexScopedOffers('item/fileChange/requestApproval', LIVE.fileChange.params, ['accept', 'acceptForSession', 'decline', 'cancel']),
      { offers: { session: true }, rule: null })
  })
  it('объект поправки не совпал с предложением — кнопки нет; лишние поля объекта уходят как есть', () => {
    const other = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['/bin/zsh', '-lc'] } }
    assert.equal(codexScopedOffers(CMD, { proposedExecpolicyAmendment: AMEND, availableDecisions: ['accept', other] }, ['accept']).rule, null)
    const extra = { acceptWithExecpolicyAmendment: { execpolicy_amendment: AMEND, future: 1 } }
    assert.equal(codexScopedOffers(CMD, { proposedExecpolicyAmendment: AMEND, availableDecisions: ['accept', extra] }, ['accept']).rule, extra)
  })
  it('сеть: предложенный объект с action deny — не «всегда пускать»', () => {
    const deny = { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny', host: 'example.com' } } }
    assert.equal(codexScopedOffers(CMD, { proposedNetworkPolicyAmendments: [{ action: 'allow', host: 'example.com' }], availableDecisions: ['accept', deny] }, ['accept']).rule, null)
  })
  it('правка файла: «на сессию» из словаря схемы, правила не бывает никогда', () => {
    const got = codexScopedOffers('item/fileChange/requestApproval', { proposedExecpolicyAmendment: AMEND }, ['accept', 'acceptForSession', 'decline', 'cancel'])
    assert.deepEqual(got, { offers: { session: true }, rule: null })
  })
})

describe('M8d: брокер — предложения', () => {
  it('СЕКРЕТ В ПРЕФИКСЕ: правило не предлагается вовсе (карточка показала бы <redacted>, а записался бы секрет)', async () => {
    const drafts: EventDraft[] = []
    const broker = createBroker({ emit: (d) => { drafts.push(d) } })
    const done = broker.request({ sessionId: 'w', toolName: 'commandExecution', input: {},
      offers: { session: true, rule: { kind: 'execpolicy', label: 'curl -u me@example.com https://x', note: 'n' } } })
    const p = broker.list('w')[0]!
    assert.deepEqual(p.offers, { session: true }, '«на сессию» остаётся, правило — нет')
    assert.deepEqual((drafts[0]?.data as { offers: unknown }).offers, { session: true })
    assert.throws(() => broker.resolve(p.id, { behavior: 'allow', scope: 'rule' }), ScopeError)
    broker.resolve(p.id, { behavior: 'allow', scope: 'session' })
    assert.equal((await done).scope, 'session')
  })
  it('чистый префикс — правило на месте, журнал пишет его ярлык', async () => {
    const drafts: EventDraft[] = []
    const broker = createBroker({ emit: (d) => { drafts.push(d) } })
    const done = broker.request({ sessionId: 'w', toolName: 'commandExecution', input: {}, offers: { rule: { kind: 'execpolicy', label: 'git push', note: 'n' } } })
    broker.resolve(broker.list('w')[0]!.id, { behavior: 'allow', scope: 'rule' })
    assert.equal((await done).scope, 'rule')
    assert.deepEqual((drafts[1]?.data as { rule: unknown }).rule, { kind: 'execpolicy', label: 'git push' })
  })
})

describe('M8d: режим подтверждений → песочница и политика треда codex', () => {
  it('таблица режимов; без брокера — never при любом режиме', () => {
    const table: Array<[ApprovalMode | undefined, boolean, string, string]> = [
      ['read-only', true, 'read-only', 'on-request'],
      ['ask', true, 'workspace-write', 'on-request'],
      [undefined, true, 'workspace-write', 'on-request'],
      ['workspace', true, 'workspace-write', 'never'],
      ['full', true, 'danger-full-access', 'never'],
      ['read-only', false, 'read-only', 'never'],
      ['ask', false, 'workspace-write', 'never'],
    ]
    for (const [mode, broker, sandbox, approvalPolicy] of table) {
      assert.deepEqual(codexThreadPolicy(mode, broker), { sandbox, approvalPolicy }, `${String(mode)} broker=${broker}`)
    }
  })
})

describe('M8d: режим подтверждений → argv claude', () => {
  it('read-only → plan, ask/нет → флага нет, workspace → acceptEdits, full → bypassPermissions', () => {
    const mode = (approval?: ApprovalMode): string | null => {
      const argv = buildClaudeArgv({ sessionId: 'x', resume: false, ...(approval ? { approval } : {}) })
      const i = argv.indexOf('--permission-mode')
      return i < 0 ? null : argv[i + 1] as string
    }
    assert.equal(mode('read-only'), 'manual', 'не plan: в нём Claude пишет планы без вопроса (ревью M8d)')
    assert.equal(mode('ask'), null)
    assert.equal(mode(undefined), null)
    assert.equal(mode('workspace'), 'acceptEdits')
    assert.equal(mode('full'), 'bypassPermissions')
  })
  it('read-only: правки и ExitPlanMode запрещены --disallowedTools (имена — замер S10); у прочих режимов флага нет', () => {
    const ro = argvOf({ sessionId: 'x', resume: false, approval: 'read-only', mcpConfigPath: '/m.json' })
    const i = ro.indexOf('--disallowedTools')
    assert.deepEqual(ro.slice(i + 1, i + 1 + CLAUDE_READONLY_DENIED.length), ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode'])
    assert.ok((ro[i + 1 + CLAUDE_READONLY_DENIED.length] ?? '').startsWith('--'), 'за списком — флаг, вариадический список не съест чужое')
    for (const a of ['ask', 'workspace', 'full'] as ApprovalMode[]) assert.equal(argvOf({ sessionId: 'x', resume: false, approval: a }).includes('--disallowedTools'), false)
  })
  it('реестр: незнакомый режим из файла — самый строгий read-only; нет поля — ask', () => {
    const base = { name: 'w', provider: 'claude', cwd: '/w', mode: 'turn', createdAt: 'x', lastStatus: 'cold', lastEventId: 0 }
    const [a, b, c] = parseSessions({ sessions: [{ ...base, approval: 'yolo' }, { ...base, name: 'v' }, { ...base, name: 'u', approval: 'workspace' }] })
    assert.deepEqual([a?.approval, b?.approval, c?.approval], ['read-only', undefined, 'workspace'])
  })
})

// --- адаптер codex на программируемом сервере ---------------------------------------------------------------

const okCheck = (): NetCheck => ({
  provider: 'codex', mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true,
  reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1, checkedAt: '2026-10-19T10:00:00.000Z', cached: false,
})

interface Msg { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }

interface Rig {
  adapter: ProviderAdapter
  broker: PermBroker
  drafts: EventDraft[]
  cwd: string
  client(): Msg[]
  remove(): void
}

function rig(fake: Record<string, unknown> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'pt-appr-'))
  const paths = layout(join(dir, 'h'))
  ensureLayout(paths)
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const logOut = join(dir, 'server.jsonl')
  writeFileSync(join(paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut, ...fake }))
  const drafts: EventDraft[] = []
  const broker = createBroker({ emit: (d) => { drafts.push(d) } })
  const adapter = createCodexAdapter({
    paths, config: defaultConfig(), logger: createLogger(paths.logFile), bin: FAKE_CODEX_SCRIPTED,
    emit: (d) => { drafts.push(d) },
    askPermission: (req) => broker.request(req),
    netCheck: async () => okCheck(),
    schemaCheck: () => ({ status: 'ok', expected: 'x', actual: 'x', files: 310, detail: 'тест' }),
  })
  const read = (): Array<Record<string, unknown>> => (existsSync(logOut)
    ? readFileSync(logOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [])
  return {
    adapter, broker, drafts, cwd,
    client: () => read().filter((r) => r['ev'] === 'client').map((r) => r['msg'] as Msg),
    remove: () => {
      for (const r of read()) if (r['ev'] === 'boot') seenPids.push(Number(r['pid']))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const spec = (r: Rig, over: Record<string, unknown> = {}) => ({ name: 'w', cwd: r.cwd, mode: 'turn' as const, broker: true, ...over })

/** Что адаптер ответил серверу на запрос разрешения 9020 (сценарий `approval-custom`). */
async function answer9020(r: Rig): Promise<unknown> {
  assert.ok(await waitFor(() => r.client().some((m) => m.id === 9020 && m.result !== undefined), 5000), 'ответа на 9020 нет')
  return r.client().filter((m) => m.id === 9020 && m.result !== undefined).at(-1)?.result
}

const FULL_OFFER = {
  approval: {
    params: {
      command: 'echo hi > x.txt', proposedExecpolicyAmendment: AMEND,
      availableDecisions: ['accept', 'acceptForSession', AMEND_OBJ, 'cancel'],
    },
  },
}

describe('M8d: адаптер codex — ширина «да» доезжает до провода ровно', () => {
  for (const [scope, wire] of [
    [undefined, 'accept'],
    ['session', 'acceptForSession'],
    ['rule', AMEND_OBJ],
  ] as Array<[undefined | 'session' | 'rule', unknown]>) {
    it(`scope ${scope ?? 'once (⌘Enter / голое approve)'} → ${JSON.stringify(wire)}`, async () => {
      const r = rig(FULL_OFFER)
      try {
        await r.adapter.startSession(spec(r))
        const turn = await r.adapter.send('w', 'делай [[approval-custom]]')
        assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
        const pending = r.broker.list('w')[0]!
        assert.deepEqual(pending.offers, { session: true, rule: { kind: 'execpolicy', label: "/bin/zsh -lc 'echo hi > x.txt'", note: CODEX_EXEC_RULE_NOTE } })
        r.broker.resolve(pending.id, { behavior: 'allow', ...(scope ? { scope } : {}) })
        assert.deepEqual(await answer9020(r), { decision: wire })
        assert.equal((await turn.done).ok, true)
        const resolved = r.drafts.find((d) => d.kind === 'permission.resolved')?.data as Record<string, unknown>
        assert.equal(resolved['scope'], scope ?? 'once', 'журнал помнит ширину')
        if (scope === 'rule') assert.deepEqual(resolved['rule'], { kind: 'execpolicy', label: "/bin/zsh -lc 'echo hi > x.txt'" })
        else assert.equal(resolved['rule'], undefined)
        const requested = r.drafts.find((d) => d.kind === 'permission.requested')?.data as Record<string, unknown>
        assert.ok(requested['offers'], 'кнопки окна приходят событием')
      } finally { await r.adapter.shutdown(); r.remove() }
    })
  }

  it('КАРТОЧКА ПРИЗНАЁТСЯ: длинный массив команды — с хвостом «…(ещё N)» и `concealed`, короткий — как есть', async () => {
    const argv = Array.from({ length: 45 }, (_, i) => `a${i}`)
    const r = rig({ approval: { params: { command: argv, availableDecisions: ['accept', 'cancel'] } } })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'делай [[approval-custom]]')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
      const pending = r.broker.list('w')[0]!
      assert.deepEqual(pending.input['command'], [...argv.slice(0, 40), '…(ещё 5)'], 'хвост команды не пропадает молча')
      assert.equal(pending.concealed, true)
      const requested = r.drafts.find((d) => d.kind === 'permission.requested')?.data as Record<string, unknown>
      assert.equal(requested['concealed'], true, 'окно узнаёт это событием')
      r.broker.resolve(pending.id, { behavior: 'deny' })
      await turn.done
    } finally { await r.adapter.shutdown(); r.remove() }
    const clean = rig({ approval: { params: { command: 'echo hi', availableDecisions: ['accept', 'cancel'] } } })
    try {
      await clean.adapter.startSession(spec(clean))
      const turn = await clean.adapter.send('w', 'делай [[approval-custom]]')
      assert.ok(await waitFor(() => clean.broker.list('w').length === 1, 5000))
      assert.equal(clean.broker.list('w')[0]!.concealed, undefined)
      clean.broker.resolve(clean.broker.list('w')[0]!.id, { behavior: 'deny' })
      await turn.done
    } finally { await clean.adapter.shutdown(); clean.remove() }
  })

  it('НЕ ПРЕДЛОЖЕНО: кнопок нет, брокер отвергает scope, а прямой ответ сужается до одного раза', async () => {
    // Измеренная форма без объекта поправки: правило выдумывать нельзя, acceptForSession не предложен.
    const r = rig({ approval: { params: { command: 'echo hi', proposedExecpolicyAmendment: AMEND, availableDecisions: ['accept', 'cancel'] } } })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'делай [[approval-custom]]')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
      const pending = r.broker.list('w')[0]!
      assert.equal(pending.offers, undefined)
      assert.throws(() => r.broker.resolve(pending.id, { behavior: 'allow', scope: 'session' }), ScopeError)
      assert.throws(() => r.broker.resolve(pending.id, { behavior: 'allow', scope: 'rule' }), ScopeError)
      assert.equal(r.broker.list('w').length, 1, 'отвергнутый scope вопрос не снимает')
      // Прямая дверь адаптера (интерфейс opencode Ф1.5): scope шире предложенного → один раз, не отказ и не шире.
      await r.adapter.respondPermission('w', '9020', { behavior: 'allow', scope: 'rule' })
      assert.deepEqual(await answer9020(r), { decision: 'accept' })
      assert.equal((await turn.done).ok, true)
      r.broker.resolve(pending.id, { behavior: 'deny' })
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('сеть: «Всегда пускать в сеть к example.com» → applyNetworkPolicyAmendment ровно с этим хостом', async () => {
    const r = rig({ approval: { params: {
      command: 'curl https://example.com', networkApprovalContext: { host: 'example.com', protocol: 'https' },
      proposedNetworkPolicyAmendments: [{ action: 'allow', host: 'example.com' }],
      availableDecisions: ['accept', NET_OBJ, 'decline', 'cancel'],
    } } })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'делай [[approval-custom]]')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
      const pending = r.broker.list('w')[0]!
      assert.deepEqual(pending.offers?.rule, { kind: 'network', label: 'example.com', note: CODEX_NET_RULE_NOTE })
      assert.equal(pending.offers?.session, undefined)
      r.broker.resolve(pending.id, { behavior: 'allow', scope: 'rule' })
      assert.deepEqual(await answer9020(r), { decision: NET_OBJ })
      assert.equal((await turn.done).ok, true)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('правка файла «в этой сессии» → acceptForSession; отказ с любым scope — decline', async () => {
    const r = rig({ approval: { method: 'item/fileChange/requestApproval', params: { reason: 'запись вне папки', grantRoot: '/srv/p' } } })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'делай [[approval-custom]]')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
      assert.deepEqual(r.broker.list('w')[0]!.offers, { session: true })
      r.broker.resolve(r.broker.list('w')[0]!.id, { behavior: 'allow', scope: 'session' })
      assert.deepEqual(await answer9020(r), { decision: 'acceptForSession' })
      assert.equal((await turn.done).ok, true)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('M8d: адаптер codex — режим подтверждений в thread/start и после resume', () => {
  for (const [approval, sandbox, policy] of [
    ['read-only', 'read-only', 'on-request'],
    ['ask', 'workspace-write', 'on-request'],
    ['workspace', 'workspace-write', 'never'],
    ['full', 'danger-full-access', 'never'],
  ] as Array<[ApprovalMode, string, string]>) {
    it(`${approval}: thread/start sandbox=${sandbox} approvalPolicy=${policy}; turn/start их не повторяет`, async () => {
      const r = rig()
      try {
        await r.adapter.startSession(spec(r, approval === 'ask' ? {} : { approval }))
        assert.equal((await (await r.adapter.send('w', 'привет')).done).ok, true)
        const start = r.client().find((m) => m.method === 'thread/start')?.params ?? {}
        assert.deepEqual([start['sandbox'], start['approvalPolicy']], [sandbox, policy])
        const turn = r.client().find((m) => m.method === 'turn/start')?.params ?? {}
        assert.equal('sandbox' in turn || 'sandboxPolicy' in turn || 'approvalPolicy' in turn, false)
        const started = r.drafts.find((d) => d.kind === 'session.started')?.data as Record<string, unknown>
        assert.equal(started['sandbox'], sandbox)
      } finally { await r.adapter.shutdown(); r.remove() }
    })
  }
  it('сессия без брокера в read-only: песочница read-only, политика never', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, { broker: false, approval: 'read-only' }))
      await (await r.adapter.send('w', 'привет')).done
      const start = r.client().find((m) => m.method === 'thread/start')?.params ?? {}
      assert.deepEqual([start['sandbox'], start['approvalPolicy']], ['read-only', 'never'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })
  it('resume после рестарта демона: режим из записи — тред возобновляется (или заводится) с тем же sandbox', async () => {
    const r = rig()
    try {
      await r.adapter.resume('w', {
        name: 'w', provider: 'codex', cwd: r.cwd, mode: 'turn', approval: 'full', providerSessionId: 'sc-thread-забытый',
        createdAt: '2026-10-19T10:00:00.000Z', lastStatus: 'cold', lastEventId: 0,
      })
      await (await r.adapter.send('w', 'привет')).done
      const resume = r.client().find((m) => m.method === 'thread/resume')?.params ?? {}
      assert.deepEqual([resume['sandbox'], resume['approvalPolicy']], ['danger-full-access', 'never'])
      // Фейк такого треда не знает → самолечение: новый тред с ТЕМ ЖЕ режимом.
      const start = r.client().find((m) => m.method === 'thread/start')?.params ?? {}
      assert.deepEqual([start['sandbox'], start['approvalPolicy']], ['danger-full-access', 'never'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

// --- демон ---------------------------------------------------------------------------------------------------

const code = (want: string) => (e: { code?: string }): boolean => e.code === want

/** Папка сессии с настройкой фальшивого claude: сценарий и куда писать argv. */
function claudeWork(root: string, name: string): { cwd: string; argvOut: string } {
  const cwd = join(root, name)
  mkdirSync(cwd, { recursive: true })
  const argvOut = join(root, `${name}.argv.jsonl`)
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, argvOut }))
  return { cwd, argvOut }
}
const lastArgv = (file: string): string[] =>
  (JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1) as string) as { argv: string[] }).argv

describe('M8d: демон — режим подтверждений в записи сессии', () => {
  it('agent.start: проверка значения, браузер в «без вопросов» — отказ, режим переживает рестарт демона и доходит до argv', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-appr-d-'))
    const w = claudeWork(root, 'w')
    const plain = claudeWork(root, 'plain')
    let d = await startTestDaemon(home)
    let c = await connectClient(home.paths)
    try {
      await assert.rejects(c.request('agent.start', { name: 'x', kind: 'claude', cwd: w.cwd, approval: 'yolo' }), code('invalid_params'))
      await assert.rejects(c.request('agent.start', { name: 'x', kind: 'claude', cwd: w.cwd, approval: 'full' }),
        (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /confirm/.test(e.message ?? ''), 'full без подтверждения — отказ')
      await assert.rejects(c.request('agent.start', { name: 'x', kind: 'claude', cwd: w.cwd, approval: 'full', confirm: true, browser: true }),
        (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /полный доступ/.test(e.message ?? ''))
      await assert.rejects(c.request('agent.start', { name: 'x', kind: 'codex', cwd: w.cwd, approval: 'workspace', browser: true }),
        (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /спрашивать некого/.test(e.message ?? ''))
      const rec = (await c.request('agent.start', { name: 'w', kind: 'claude', cwd: w.cwd, approval: 'workspace' })) as Record<string, unknown>
      assert.equal(rec['approval'], 'workspace')
      const ask = (await c.request('agent.start', { name: 'plain', kind: 'claude', cwd: plain.cwd, approval: 'ask' })) as Record<string, unknown>
      assert.equal('approval' in ask, false, '`ask` — это отсутствие поля: старые записи и новые одинаковы')
      // Браузер в «полном доступе» нельзя включить и потом.
      const full = claudeWork(root, 'full')
      await c.request('agent.start', { name: 'full', kind: 'claude', cwd: full.cwd, approval: 'full', confirm: true })
      await assert.rejects(c.request('agent.browser', { name: 'full', on: true }), code('invalid_params'))

      // Рестарт демона: запись с диска, адаптер поднимает сессию лениво — с тем же режимом.
      c.close(); await d.stop('рестарт')
      assert.equal(parseSessions(JSON.parse(readFileSync(home.paths.sessions, 'utf8'))).find((s) => s.name === 'w')?.approval, 'workspace')
      d = await startTestDaemon(home)
      c = await connectClient(home.paths)
      // У Claude в ask окно показывает действующий режим из настроек владельца (тестовый демон: PULT_HOME/claude-settings.json).
      writeFileSync(join(home.paths.home, 'claude-settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }))
      const listed = ((await c.request('agent.list')) as { sessions: Array<Record<string, unknown>> }).sessions
      assert.equal(listed.find((s) => s['name'] === 'w')?.['approval'], 'workspace')
      assert.equal(listed.find((s) => s['name'] === 'w')?.['claudeMode'], undefined, 'режим задан — настройки не при чём')
      assert.equal(listed.find((s) => s['name'] === 'plain')?.['claudeMode'], 'auto')
      rmSync(join(home.paths.home, 'claude-settings.json'))
      await c.request('agent.prompt', { name: 'w', text: 'привет' })
      await c.request('agent.wait', { name: 'w', timeoutMs: 10_000 })
      const argv = lastArgv(w.argvOut)
      assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits')
      await c.request('agent.prompt', { name: 'plain', text: 'привет' })
      await c.request('agent.wait', { name: 'plain', timeoutMs: 10_000 })
      assert.equal(lastArgv(plain.argvOut).includes('--permission-mode'), false, 'ask — флага нет, как до M8d')
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })

  it('perm.resolve: scope проверяется по предложенному, отвергнутый вопрос остаётся, журнал помнит ширину', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-appr-s-'))
    const logOut = join(root, 'server.jsonl')
    // Предложено только «на сессию»: правило не предложено.
    writeFileSync(join(home.paths.home, '.pult-fake-scripted.json'), JSON.stringify({
      logOut, approval: { params: { command: 'echo hi', availableDecisions: ['accept', 'acceptForSession', 'cancel'] } },
    }))
    const d = await startTestDaemon(home, { codexBin: FAKE_CODEX_SCRIPTED })
    const c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'c', kind: 'codex', cwd: root })
      await c.request('agent.prompt', { name: 'c', text: 'делай [[approval-custom]]' })
      let pending: Array<{ id: string; offers?: unknown }> = []
      assert.ok(await waitFor(async () => {
        pending = ((await c.request('perm.list', { name: 'c' })) as { pending: typeof pending }).pending
        return pending.length === 1
      }, 10_000), 'вопрос не дошёл до Inbox')
      const id = pending[0]!.id
      assert.deepEqual(pending[0]!.offers, { session: true })
      await assert.rejects(c.request('perm.resolve', { id, decision: 'allow', scope: 'forever' }), code('invalid_params'))
      await assert.rejects(c.request('perm.resolve', { id, decision: 'deny', scope: 'session' }), code('invalid_params'))
      await assert.rejects(c.request('perm.resolve', { id, decision: 'allow', scope: 'rule' }), code('invalid_params'))
      assert.equal(((await c.request('perm.list', { name: 'c' })) as { pending: unknown[] }).pending.length, 1, 'вопрос на месте')
      assert.deepEqual(await c.request('perm.resolve', { id, decision: 'allow', scope: 'session' }), { resolved: true, id, decision: 'allow', scope: 'session' })
      await c.request('agent.wait', { name: 'c', timeoutMs: 10_000 })
      const events = ((await c.request('events.tail', { since: 0, sessionId: 'c' })) as { events: Array<{ kind: string; data: Record<string, unknown> }> }).events
      const resolved = events.find((e) => e.kind === 'permission.resolved')
      assert.deepEqual([resolved?.data['decision'], resolved?.data['scope']], ['allow', 'session'])
      const answers = readFileSync(logOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ev: string; msg?: Msg })
        .filter((r) => r.ev === 'client' && r.msg?.id === 9020 && r.msg.result !== undefined)
      assert.deepEqual(answers.at(-1)?.msg?.result, { decision: 'acceptForSession' })
    } finally {
      c.close(); await d.stop('конец теста')
      try { for (const l of readFileSync(logOut, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l) as { ev: string; pid: number }; if (r.ev === 'boot') seenPids.push(r.pid) } } catch { /* лога нет */ }
      home.remove(); rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M8d: демон — «Убрать из списка» для любого проекта', () => {
  it('папка с сессиями: сессии в архив, закрепление снято; кривые параметры — отказ без половинчатых правок; новая сессия возвращает папку', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-appr-p-'))
    const proj = join(root, 'proj')
    mkdirSync(proj)
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    const archived = async (): Promise<Record<string, boolean>> => Object.fromEntries(
      ((await c.request('agent.list')) as { sessions: Array<{ name: string; archived?: boolean }> }).sessions.map((s) => [s.name, s.archived === true]))
    try {
      await c.request('project.add', { path: proj })
      await c.request('agent.start', { name: 'a', kind: 'claude', cwd: proj })
      await c.request('agent.start', { name: 'b', kind: 'claude', cwd: proj })
      await assert.rejects(c.request('project.remove', { path: proj, sessions: 'a' }), code('invalid_params'))
      await assert.rejects(c.request('project.remove', { path: proj, sessions: ['a', 'нет-такой'] }), code('not_found'))
      const other = join(root, 'other')
      mkdirSync(other)
      await c.request('agent.start', { name: 'o', kind: 'claude', cwd: other })
      await assert.rejects(c.request('project.remove', { path: proj, sessions: ['a', 'o'] }),
        (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /не из папки/.test(e.message ?? ''), 'чужая сессия — отказ')
      assert.deepEqual(await archived(), { a: false, b: false, o: false }, 'отказ на входе — ни одной правки')
      assert.equal(((await c.request('project.list')) as { projects: unknown[] }).projects.length, 1)

      assert.deepEqual(await c.request('project.remove', { path: proj, sessions: ['a', 'b'] }), { removed: true, archived: ['a', 'b'] })
      assert.deepEqual(await archived(), { a: true, b: true, o: false })
      assert.deepEqual(((await c.request('project.list')) as { projects: unknown[] }).projects, [])
      assert.ok(existsSync(proj), 'папка на диске не тронута')
      // Папка сессии вне списка (не закреплена): removed=false, но сессии всё равно в архиве; повтор не ломается.
      assert.deepEqual(await c.request('project.remove', { path: proj, sessions: ['a'] }), { removed: false, archived: [] })

      // Новая сессия в той же папке — не в архиве: окно снова покажет папку.
      await c.request('agent.start', { name: 'n', kind: 'claude', cwd: proj })
      assert.deepEqual(await archived(), { a: true, b: true, o: false, n: false })
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
})

describe('M8d (ревью): «Убрать из списка» не трогает занятые сессии; путь проекта нормализуется', () => {
  it('идёт ход — отказ «сначала останови», в архив не ушло ничего', async () => {
    const home = tempHome()
    const root = mkdtempSync(join(tmpdir(), 'pt-appr-b-'))
    const proj = join(root, 'proj')
    mkdirSync(proj)
    writeFileSync(join(proj, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, hangAfterInit: 30_000 }))
    const d = await startTestDaemon(home)
    const c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'h', kind: 'claude', cwd: proj })
      await c.request('agent.start', { name: 'idle', kind: 'claude', cwd: proj })
      await c.request('agent.prompt', { name: 'h', text: 'долгий ход' })
      assert.ok(await waitFor(async () => ((await c.request('agent.list')) as { sessions: Array<{ name: string; lastStatus: string }> })
        .sessions.find((s) => s.name === 'h')?.lastStatus === 'working', 10_000), 'ход не пошёл')
      await assert.rejects(c.request('project.remove', { path: proj, sessions: ['h', 'idle'] }),
        (e: { code?: string; message?: string }) => e.code === 'invalid_params' && /сначала останови: h$/.test(e.message ?? ''))
      const recs = ((await c.request('agent.list')) as { sessions: Array<{ name: string; archived?: boolean }> }).sessions
      assert.deepEqual(recs.filter((r) => r.archived).map((r) => r.name), [], 'ни одна не ушла в архив')
      await c.request('agent.stop', { name: 'h' })
    } finally { c.close(); await d.stop('конец теста'); home.remove(); rmSync(root, { recursive: true, force: true }) }
  })
  it('store.remove нормализует путь, как add: «/x/» убирает «/x»', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-appr-st-'))
    try {
      const s = createProjectStore(join(dir, 'projects.json'))
      s.add(dir)
      assert.equal(s.remove(`${dir}/`), true)
      assert.deepEqual(s.list(), [])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// --- CLI ------------------------------------------------------------------------------------------------------

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

describe('M8d: CLI — --approval, perm approve --session | --rule', () => {
  it('режим при заведении, подсказки в perm list, scope по флагу, взаимоисключение флагов', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-appr-cli-'))
    const paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    const logOut = join(dir, 'server.jsonl')
    writeFileSync(join(paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut, ...FULL_OFFER }))
    const work = join(dir, 'work')
    mkdirSync(work)
    try {
      const bad = await runCli(paths, ['agent', 'start', 'x', '--kind', 'codex', '--cwd', work, '--approval', 'yolo'])
      assert.equal(bad.code, 1)
      assert.match(bad.stderr, /read-only \| ask \| workspace \| full/)
      const noYes = await runCli(paths, ['agent', 'start', 'f', '--kind', 'codex', '--cwd', work, '--approval', 'full'])
      assert.equal(noYes.code, 1)
      assert.match(noYes.stderr, /--yes/)
      assert.doesNotMatch((await runCli(paths, ['agent', 'list'])).stdout, /^f /m, 'без --yes ничего не заведено')
      const full = await runCli(paths, ['agent', 'start', 'f', '--kind', 'codex', '--cwd', work, '--approval', 'full', '--yes'])
      assert.equal(full.code, 0, full.stderr)
      assert.match(full.stdout, /подтверждения: full/)
      assert.match(full.stderr, /без вопросов, песочницы нет/)
      assert.equal((await runCli(paths, ['agent', 'start', 'c', '--kind', 'codex', '--cwd', work])).code, 0)
      const list = await runCli(paths, ['agent', 'list'])
      assert.match(list.stdout, /^f .* · full/m)
      assert.doesNotMatch(list.stdout.split('\n').find((l) => l.startsWith('c ')) ?? '', /· (ask|full)/)

      const ask = async (): Promise<string> => {
        assert.equal((await runCli(paths, ['agent', 'prompt', 'c', 'делай [[approval-custom]]'])).code, 0)
        let id = ''
        assert.ok(await waitFor(async () => {
          const r = JSON.parse((await runCli(paths, ['perm', 'list', '--json'])).stdout) as { pending: Array<{ id: string }> }
          id = r.pending[0]?.id ?? ''
          return id !== ''
        }, 15_000), 'вопрос не дошёл до perm list')
        return id
      }
      const answers = (): unknown[] => readFileSync(logOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ev: string; pid: number; msg?: Msg })
        .filter((r) => r.ev === 'client' && (r.msg?.id ?? 0) >= 9020 && (r.msg?.id ?? 0) < 9100 && r.msg?.result !== undefined).map((r) => r.msg?.result)

      const id1 = await ask()
      const text = (await runCli(paths, ['perm', 'list'])).stdout
      assert.match(text, /--session: разрешить в этой сессии/)
      assert.match(text, /--rule: всегда — команды, начинающиеся с «\/bin\/zsh -lc 'echo hi > x\.txt'» \(с любыми аргументами дальше\)/)
      const both = await runCli(paths, ['perm', 'approve', id1, '--session', '--rule'])
      assert.equal(both.code, 1)
      assert.match(both.stderr, /не оба/)
      assert.equal((await runCli(paths, ['perm', 'deny', id1, '--rule'])).code, 1)
      const rule = await runCli(paths, ['perm', 'approve', id1, '--rule'])
      assert.equal(rule.code, 0, rule.stderr)
      assert.match(rule.stdout, /разрешено всегда/)
      assert.ok(await waitFor(() => answers().length === 1, 5000))
      assert.deepEqual(answers()[0], { decision: AMEND_OBJ })
      assert.equal((await runCli(paths, ['agent', 'wait', 'c', '--timeout', '10000'])).code, 0)

      // `--session` перед id: разбор отдаёт id флагу — CLI это понимает.
      const id2 = await ask()
      const session = await runCli(paths, ['perm', 'approve', '--session', id2])
      assert.equal(session.code, 0, session.stderr)
      assert.match(session.stdout, /разрешено в этой сессии/)
      assert.ok(await waitFor(() => answers().length === 2, 5000))
      assert.deepEqual(answers()[1], { decision: 'acceptForSession' })
    } finally {
      await runCli(paths, ['daemon', 'stop'])
      try { for (const l of readFileSync(logOut, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l) as { ev: string; pid: number }; if (r.ev === 'boot') seenPids.push(r.pid) } } catch { /* лога нет */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
