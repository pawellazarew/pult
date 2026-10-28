// План 16, № 11: правила «Всегда» Codex — метка Пульта, список, «Отозвать». Файл правил — всегда во временном доме
// (`PULT_HOME/codex-rules/default.rules` у тестового демона); настоящий ~/.codex не читается и не правится.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { codexRuleTarget } from '../dist/adapters/codex/adapter.js'
import { connectClient } from '../dist/cli/client.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import {
  codexRulesPath, countMatching, createCodexRules, formatMarker, listCodexRules, markNewRule, parseMarker, parseRuleLine, revokeCodexRule,
} from '../dist/perm/codexRules.js'
import { CLI_ENTRY, FAKE_CLAUDE, FAKE_CODEX_SCRIPTED, startTestDaemon, tempHome, waitFor } from './helpers.js'

process.env['PULT_TEST_NET'] = 'ok'

const seenPids: number[] = []
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
after(() => {
  const survivors = seenPids.filter(alive)
  assert.deepEqual(survivors, [], `фальшивые app-server пережили тесты: ${survivors.join(', ')}`)
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'pt-rules-'))

/** Содержимое «чужого» файла: комментарии, правила человека, CRLF, байты не-UTF-8, без \n в конце. */
const USER_TEXT = Buffer.concat([
  Buffer.from('# мои правила\nprefix_rule(pattern=["git", "status"], decision="allow")\r\n'),
  Buffer.from([0xff, 0xfe, 0x0a]),
  Buffer.from('prefix_rule(pattern=[["npm", "pnpm"], "test"], decision="allow")\nnetwork_rule(host="example.com", protocol="https", decision="deny")'),
])
const RULE = (argv: string[]): string => `prefix_rule(pattern=[${argv.map((x) => JSON.stringify(x)).join(', ')}], decision="allow")`

describe('правила codex: разбор строк и метки', () => {
  it('путь: CODEX_HOME или ~/.codex', () => {
    assert.equal(codexRulesPath({ CODEX_HOME: '/x/ch' }, '/h'), '/x/ch/rules/default.rules')
    assert.equal(codexRulesPath({}, '/h'), '/h/.codex/rules/default.rules')
  })
  it('prefix_rule: JSON-литералы с кавычками, запятыми и \\n; альтернативы, deny и мусор — null', () => {
    const argv = ['/bin/zsh', '-lc', 'echo "a, b" ] [\n']
    assert.deepEqual(parseRuleLine(RULE(argv)), { kind: 'execpolicy', argv })
    assert.deepEqual(parseRuleLine(`${RULE(['git', 'push'])}\r`), { kind: 'execpolicy', argv: ['git', 'push'] })
    assert.equal(parseRuleLine('prefix_rule(pattern=[["npm", "pnpm"], "test"], decision="allow")'), null)
    assert.equal(parseRuleLine('prefix_rule(pattern=["rm"], decision="forbidden")'), null)
    assert.equal(parseRuleLine('prefix_rule(pattern=["rm", decision="allow")'), null)
    assert.equal(parseRuleLine('# prefix_rule(pattern=["rm"], decision="allow")'), null)
  })
  it('network_rule: хост', () => {
    assert.deepEqual(parseRuleLine('network_rule(host="api.example.com", protocol="https", decision="allow")'), { kind: 'network', host: 'api.example.com' })
    assert.equal(parseRuleLine('network_rule(host="api.example.com", protocol="https", decision="deny")'), null)
  })
  it('метка: имя сессии и папка с пробелами и кириллицей переживают круг', () => {
    const m = { id: 'r-0a1b2c3d', at: '2026-10-29T10:00:00.000Z', session: 'моя сессия', cwd: '/srv/про ект' }
    const line = formatMarker(m)
    assert.doesNotMatch(line, / сессия/)
    assert.deepEqual(parseMarker(line), m)
    assert.equal(parseMarker('# обычный комментарий'), null)
  })
  it('codexRuleTarget: из ответа «всегда» — префикс или хост', () => {
    assert.deepEqual(codexRuleTarget({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'push'] } }), { kind: 'execpolicy', argv: ['git', 'push'] })
    assert.deepEqual(codexRuleTarget({ applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'example.com' } } }), { kind: 'network', host: 'example.com' })
    assert.equal(codexRuleTarget(null), null)
  })
})

describe('правила codex: метка, список, отзыв — байт в байт', () => {
  const grant = { kind: 'execpolicy' as const, argv: ['git', 'push'], sessionId: 'w', cwd: '/srv/p' }

  it('метит только НОВУЮ строку; остальное — байт в байт; отзыв возвращает файл как был', () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      writeFileSync(f, USER_TEXT)
      chmodSync(f, 0o640)
      const baseline = countMatching(readFileSync(f), grant)
      assert.equal(baseline, 0)
      assert.equal(markNewRule(f, grant, baseline, { id: 'r-1', at: '2026-10-29T10:00:00.000Z' }), null, 'codex ещё не дописал — метить нечего')
      assert.ok(readFileSync(f).equals(USER_TEXT), 'файл не тронут')
      // codex дописывает строку (в файле без \n в конце — сначала \n)
      appendFileSync(f, `\n${RULE(['git', 'push'])}\n`)
      const withRule = readFileSync(f)
      const marked = markNewRule(f, grant, baseline, { id: 'r-1', at: '2026-10-29T10:00:00.000Z' })
      assert.deepEqual(marked, { id: 'r-1', at: '2026-10-29T10:00:00.000Z', session: 'w', cwd: '/srv/p', kind: 'execpolicy', label: 'git push' })
      const listed = listCodexRules(f)
      assert.deepEqual(listed.rules, [marked])
      assert.equal(listed.unmarked, 3, 'чужие строки правил — только счётчиком')
      assert.equal(statSync(f).mode & 0o777, 0o640, 'режим файла сохранён')
      // повторная метка той же строки не ставится
      assert.equal(markNewRule(f, grant, baseline, { id: 'r-2', at: 'x' }), null)
      const revoked = revokeCodexRule(f, 'r-1')
      assert.equal(revoked.label, 'git push')
      const back = readFileSync(f)
      assert.ok(back.equals(Buffer.concat([USER_TEXT, Buffer.from('\n')])), 'ушли ровно метка и строка правила')
      assert.ok(!back.equals(withRule))
      assert.throws(() => revokeCodexRule(f, 'r-1'), { name: 'Error', message: /нет/ })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('строка уже была в файле до «Всегда» (codex не дублирует) — метки нет, чужое не отзывается', () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      writeFileSync(f, `${RULE(['git', 'push'])}\n`)
      const before = readFileSync(f)
      const baseline = countMatching(before, grant)
      assert.equal(baseline, 1)
      assert.equal(markNewRule(f, grant, baseline, { id: 'r-1', at: 'x' }), null)
      assert.ok(readFileSync(f).equals(before))
      assert.deepEqual(listCodexRules(f).rules, [])
      assert.throws(() => revokeCodexRule(f, 'r-1'))
      assert.ok(readFileSync(f).equals(before), 'неотмеченную строку отзыв не трогает')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('метка без правила под ней (строку убрали руками) — не в списке и не отзывается', () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      const text = `${formatMarker({ id: 'r-9', at: 'x', session: 'w' })}\n# дальше не правило\n`
      writeFileSync(f, text)
      assert.deepEqual(listCodexRules(f).rules, [])
      assert.throws(() => revokeCodexRule(f, 'r-9'))
      assert.equal(readFileSync(f, 'utf8'), text)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('симлинк остаётся симлинком: правится его цель', () => {
    const dir = tmp()
    try {
      const real = join(dir, 'dotfiles.rules')
      const link = join(dir, 'default.rules')
      writeFileSync(real, `${formatMarker({ id: 'r-5', at: 'x', session: 'w' })}\n${RULE(['make'])}\n# хвост\n`)
      symlinkSync(real, link)
      revokeCodexRule(link, 'r-5')
      assert.ok(lstatSync(link).isSymbolicLink())
      assert.equal(readFileSync(real, 'utf8'), '# хвост\n')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('файла нет — список пуст, exists: false, метка не создаёт файл', () => {
    const dir = tmp()
    try {
      const f = join(dir, 'nope', 'default.rules')
      assert.deepEqual(listCodexRules(f), { path: f, exists: false, rules: [], unmarked: 0 })
      assert.equal(markNewRule(f, grant, 0, { id: 'r-1', at: 'x' }), null)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('createCodexRules: ждёт, пока codex допишет, и метит; не дождался — файл не тронут', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      writeFileSync(f, '# моё\n')
      const logs: string[] = []
      const revoked: string[] = []
      const rules = createCodexRules({ path: f, pollMs: 20, waitMs: 400, log: (_l, msg) => logs.push(msg), onRevoked: (r, by) => revoked.push(`${r.id}:${by}`) })
      rules.granted({ kind: 'network', host: 'example.com', sessionId: 's1' })
      setTimeout(() => appendFileSync(f, 'network_rule(host="example.com", protocol="https", decision="allow")\n'), 80)
      assert.ok(await waitFor(() => rules.list().rules.length === 1, 3000), 'метки нет')
      const r = rules.list().rules[0]!
      assert.deepEqual([r.kind, r.label, r.session], ['network', 'example.com', 's1'])
      rules.revoke(r.id, 'тест')
      assert.equal(readFileSync(f, 'utf8'), '# моё\n')
      assert.deepEqual(revoked, [`${r.id}:тест`])
      rules.granted({ kind: 'execpolicy', argv: ['ls'], sessionId: 's1' })
      assert.ok(await waitFor(() => logs.some((l) => /новой строки правила не появилось/.test(l)), 3000))
      assert.equal(readFileSync(f, 'utf8'), '# моё\n')
      rules.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// --- демон и CLI на фальшивом codex ------------------------------------------------------------------------------

const AMEND = ['/bin/zsh', '-lc', 'echo hi > x.txt']
const AMEND_OBJ = { acceptWithExecpolicyAmendment: { execpolicy_amendment: AMEND } }
const offer = (holdMs: number): Record<string, unknown> => ({
  approval: { holdMs, params: { command: 'echo hi > x.txt', proposedExecpolicyAmendment: AMEND, availableDecisions: ['accept', AMEND_OBJ, 'cancel'] } },
})
const code = (want: string) => (e: { code?: string }): boolean => e.code === want
const reap = (logOut: string): void => {
  try { for (const l of readFileSync(logOut, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l) as { ev: string; pid: number }; if (r.ev === 'boot') seenPids.push(r.pid) } } catch { /* лога нет */ }
}

describe('правила codex: демон — «Всегда» → метка → список → отзыв посреди хода', () => {
  it('отзыв убирает ровно строку Пульта, пишет rule.revoked, ход доходит до конца', async () => {
    const home = tempHome()
    const root = tmp()
    const logOut = join(root, 'server.jsonl')
    const rulesFile = join(home.paths.home, 'codex-rules', 'default.rules')
    mkdirSync(join(home.paths.home, 'codex-rules'))
    writeFileSync(rulesFile, USER_TEXT)
    writeFileSync(join(home.paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut, rulesFile, ...offer(2500) }))
    const d = await startTestDaemon(home, { codexBin: FAKE_CODEX_SCRIPTED })
    const c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'c', kind: 'codex', cwd: root })
      await c.request('agent.prompt', { name: 'c', text: 'делай [[approval-custom]]' })
      let id = ''
      assert.ok(await waitFor(async () => {
        const p = ((await c.request('perm.list', { name: 'c' })) as { pending: Array<{ id: string }> }).pending
        id = p[0]?.id ?? ''
        return id !== ''
      }, 10_000), 'вопрос не дошёл до Inbox')
      await c.request('perm.resolve', { id, decision: 'allow', scope: 'rule' })
      type Listing = { path: string; rules: Array<{ id: string; label: string; session: string; cwd?: string; at: string }>; unmarked: number }
      let listing: Listing = { path: '', rules: [], unmarked: 0 }
      assert.ok(await waitFor(async () => {
        listing = (await c.request('perm.rules')) as Listing
        return listing.rules.length === 1
      }, 5000), 'метки Пульта нет')
      assert.equal(listing.path, rulesFile)
      assert.equal(listing.unmarked, 3)
      const rule = listing.rules[0]!
      assert.deepEqual([rule.label, rule.session, rule.cwd], ["/bin/zsh -lc 'echo hi > x.txt'", 'c', root])
      const settings = (await c.request('settings.get')) as { codexRules: Listing }
      assert.deepEqual(settings.codexRules.rules, listing.rules, 'окно видит то же через settings.get')
      // Ход ещё идёт (фальшивый codex держит его после ответа) — отзыв не должен его рвать.
      const st = ((await c.request('agent.list')) as { sessions: Array<{ name: string; lastStatus: string }> }).sessions.find((s) => s.name === 'c')
      assert.equal(st?.lastStatus, 'working')
      await assert.rejects(c.request('settings.set', { codexRules: { revoke: rule.id }, updates: { check: false } }), code('invalid_params'))
      await assert.rejects(c.request('settings.set', { codexRules: { revoke: 'r-nope' } }), code('not_found'))
      await assert.rejects(c.request('perm.rules.revoke', {}), code('invalid_params'))
      const after1 = (await c.request('settings.set', { codexRules: { revoke: rule.id } })) as { codexRules: Listing }
      assert.deepEqual(after1.codexRules.rules, [])
      assert.ok(readFileSync(rulesFile).equals(Buffer.concat([USER_TEXT, Buffer.from('\n')])), 'чужое — байт в байт, ушли метка и строка')
      await assert.rejects(c.request('perm.rules.revoke', { id: rule.id }), code('not_found'))
      await c.request('agent.wait', { name: 'c', timeoutMs: 10_000 })
      const events = ((await c.request('events.tail', { since: 0 })) as { events: Array<{ sessionId: string; kind: string; data: Record<string, unknown> }> }).events
      const done = events.filter((e) => e.sessionId === 'c' && e.kind === 'status.changed').map((e) => e.data['status'])
      assert.equal(done.at(-1), 'idle', `ход не дошёл до конца: ${done.join(' → ')}`)
      const rev = events.find((e) => e.kind === 'rule.revoked')
      assert.equal(rev?.sessionId, 'daemon')
      assert.deepEqual([rev?.data['id'], rev?.data['label'], rev?.data['session']], [rule.id, rule.label, 'c'])
    } finally {
      c.close(); await d.stop('конец теста'); reap(logOut)
      home.remove(); rmSync(root, { recursive: true, force: true })
    }
  })
})

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

describe('правила codex: CLI — pult perm rules [revoke]', () => {
  it('список с датой и сессией, отзыв по id, неизвестный id — ошибка', async () => {
    const dir = tmp()
    const paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    const logOut = join(dir, 'server.jsonl')
    const rulesFile = join(paths.home, 'codex-rules', 'default.rules')
    mkdirSync(join(paths.home, 'codex-rules'))
    writeFileSync(rulesFile, '# моё\nprefix_rule(pattern=["ls"], decision="allow")\n')
    writeFileSync(join(paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut, rulesFile, ...offer(0) }))
    const work = join(dir, 'work')
    mkdirSync(work)
    try {
      const empty = await runCli(paths, ['perm', 'rules'])
      assert.equal(empty.code, 0, empty.stderr)
      assert.match(empty.stdout, /правил «Всегда», записанных Пультом, нет/)
      assert.match(empty.stdout, /без метки Пульта: 1/)
      assert.equal((await runCli(paths, ['agent', 'start', 'c', '--kind', 'codex', '--cwd', work])).code, 0)
      assert.equal((await runCli(paths, ['agent', 'prompt', 'c', 'делай [[approval-custom]]'])).code, 0)
      let permId = ''
      assert.ok(await waitFor(async () => {
        const r = await runCli(paths, ['perm', 'list', '--json'])
        permId = ((JSON.parse(r.stdout || '{"pending":[]}') as { pending: Array<{ id: string }> }).pending[0]?.id) ?? ''
        return permId !== ''
      }, 15_000))
      assert.equal((await runCli(paths, ['perm', 'approve', permId, '--rule'])).code, 0)
      let ruleId = ''
      assert.ok(await waitFor(async () => {
        const r = await runCli(paths, ['perm', 'rules', '--json'])
        ruleId = ((JSON.parse(r.stdout) as { rules: Array<{ id: string }> }).rules[0]?.id) ?? ''
        return ruleId !== ''
      }, 10_000), 'метки нет')
      const text = await runCli(paths, ['perm', 'rules'])
      assert.match(text.stdout, new RegExp(`^${ruleId}  \\d{4}-\\d\\d-\\d\\dT\\S+  сессия c · `, 'm'))
      assert.match(text.stdout, /команды, начинающиеся с «\/bin\/zsh -lc 'echo hi > x\.txt'»/)
      assert.match(text.stdout, /pult perm rules revoke <id>/)
      const bad = await runCli(paths, ['perm', 'rules', 'revoke', 'r-nope'])
      assert.notEqual(bad.code, 0)
      assert.match(bad.stderr, /not_found/)
      assert.equal((await runCli(paths, ['perm', 'rules', 'revoke'])).code, 1)
      const ok = await runCli(paths, ['perm', 'rules', 'revoke', ruleId])
      assert.equal(ok.code, 0, ok.stderr)
      assert.match(ok.stdout, /отозвано/)
      assert.equal(readFileSync(rulesFile, 'utf8'), '# моё\nprefix_rule(pattern=["ls"], decision="allow")\n')
    } finally {
      await runCli(paths, ['daemon', 'stop'])
      reap(logOut)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
