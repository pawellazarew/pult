// План 16, № 11: правила «Всегда» Codex — метка Пульта, список, «Отозвать». Файл правил — всегда во временном доме
// (`PULT_HOME/codex-rules/default.rules` у тестового демона); настоящий ~/.codex не читается и не правится.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  appendFileSync, chmodSync, closeSync, constants as fsc, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { codexRuleTarget, createCodexAdapter, RELOAD_REMIND_MS } from '../dist/adapters/codex/adapter.js'
import { defaultConfig } from '../dist/core/config.js'
import type { EventDraft } from '../dist/core/events.js'
import { createLogger } from '../dist/core/log.js'
import { createBroker } from '../dist/perm/broker.js'
import { connectClient } from '../dist/cli/client.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import {
  backupAdvice, codexChildRulesPath, codexRulesPath, countMatching, createCodexRules, editRulesFile, formatMarker, listCodexRules, markNewRule, normalizeHost,
  openLocked, parseMarker, parseRuleLine, revokeCodexRule, ruleSha,
} from '../dist/perm/codexRules.js'
import { revokeSummary } from '../dist/perm/rulesText.js'
import { CLI_ENTRY, FAKE_CLAUDE, FAKE_CODEX_SCRIPTED, startTestDaemon, tempHome, waitFor } from './helpers.js'

process.env['PULT_TEST_NET'] = 'ok'

const seenPids: number[] = []
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
after(() => {
  const survivors = seenPids.filter(alive)
  assert.deepEqual(survivors, [], `фальшивые app-server пережили тесты: ${survivors.join(', ')}`)
})

const tmp = (): string => mkdtempSync(join(tmpdir(), 'pt-rules-'))

/** Содержимое «чужого» файла: комментарии, правила человека, CRLF, байты не-UTF-8, deny, без \n в конце. */
const USER_TEXT = Buffer.concat([
  Buffer.from('# мои правила\nprefix_rule(pattern=["git", "status"], decision="allow")\r\n'),
  Buffer.from([0xff, 0xfe, 0x0a]),
  Buffer.from('prefix_rule(pattern=[["npm", "pnpm"], "test"], decision="allow")\nnetwork_rule(host="example.com", protocol="https", decision="deny")'),
])
const RULE = (argv: string[]): string => `prefix_rule(pattern=[${argv.map((x) => JSON.stringify(x)).join(', ')}], decision="allow")`
/** Метка Пульта над строкой `line` — с отпечатком именно этой строки. */
const MARK = (id: string, line: string, session = 'w'): string => formatMarker({ id, sha: ruleSha(line), at: '2026-10-29T10:00:00.000Z', session })

describe('правила codex: разбор строк и метки', () => {
  it('путь: CODEX_HOME или HOME/.codex; файл app-server Пульта — по HOME ребёнка (CODEX_HOME ему не передаётся)', () => {
    assert.equal(codexRulesPath({ CODEX_HOME: '/x/ch' }, '/h'), '/x/ch/rules/default.rules')
    assert.equal(codexRulesPath({}, '/h'), '/h/.codex/rules/default.rules')
    assert.equal(codexChildRulesPath({ CODEX_HOME: '/x/ch', HOME: '/home/user' }, '/h'), '/home/user/.codex/rules/default.rules')
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
  it('network_rule: хост; сравнение хоста — как normalize_network_rule_host у codex', () => {
    assert.deepEqual(parseRuleLine('network_rule(host="api.example.com", protocol="https", decision="allow")'), { kind: 'network', host: 'api.example.com' })
    assert.equal(parseRuleLine('network_rule(host="api.example.com", protocol="https", decision="deny")'), null)
    assert.equal(normalizeHost('API.Example.COM:443'), 'api.example.com')
    assert.equal(normalizeHost('example.com.'), 'example.com')
    assert.equal(normalizeHost('[::1]:8080'), '::1')
    assert.equal(normalizeHost('::1'), '::1')
    const f = Buffer.from('network_rule(host="example.com", protocol="https", decision="allow")\n')
    assert.equal(countMatching(f, { kind: 'network', host: 'Example.COM:443' }), 1)
  })
  it('метка: имя сессии и папка с пробелами и кириллицей переживают круг; отпечаток строки — 8 hex', () => {
    const m = { id: 'r-0a1b2c3d', sha: ruleSha(RULE(['ls'])), at: '2026-10-29T10:00:00.000Z', session: 'моя сессия', cwd: '/srv/про ект' }
    assert.match(m.sha, /^[0-9a-f]{8}$/)
    assert.equal(ruleSha(`${RULE(['ls'])}\r`), m.sha, '\\r в конце не меняет отпечаток')
    const line = formatMarker(m)
    assert.doesNotMatch(line, / сессия/)
    assert.deepEqual(parseMarker(line), m)
    assert.equal(parseMarker('# обычный комментарий'), null)
    assert.equal(parseMarker('# pult: rule=r-1 at=x session=w'), null, 'без отпечатка — не метка')
  })
  it('codexRuleTarget: из ответа «всегда» — префикс или хост', () => {
    assert.deepEqual(codexRuleTarget({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'push'] } }), { kind: 'execpolicy', argv: ['git', 'push'] })
    assert.deepEqual(codexRuleTarget({ applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'example.com' } } }), { kind: 'network', host: 'example.com' })
    assert.equal(codexRuleTarget(null), null)
  })
  it('итог отзыва словами: перезапущен / после хода / не запущен; «ещё разрешено N другими строками»', () => {
    const rule = { id: 'r-1', kind: 'execpolicy' as const, label: 'git push' }
    const restarted = revokeSummary({ rule, stillAllowedBy: 0, codex: 'restarted' })
    assert.match(restarted, /^Отозвано: команды, начинающиеся с «git push»\. Codex в Пульте перезапущен/)
    assert.match(restarted, /продолжатся с того же места, но разрешения «в этой сессии» у всех сессий Codex сброшены/, 'оговорка обязательна')
    assert.match(restarted, /вне Пульта \(терминал, IDE\), держит правило до своего перезапуска/)
    const deferred = revokeSummary({ rule, stillAllowedBy: 0, codex: 'deferred', busy: 'работает фон — субагенты или команды' })
    assert.match(deferred, /Codex занят \(работает фон — субагенты или команды\): пока он не освободится, правило в нём ещё действует/)
    assert.match(deferred, /«в этой сессии» у всех сессий Codex сброшены/)
    assert.match(revokeSummary({ rule, stillAllowedBy: 0, codex: 'not_running' }), /Codex в Пульте не запущен — правило больше не действует; codex, запущенный вне Пульта/)
    assert.match(revokeSummary({ rule, stillAllowedBy: 2, codex: 'restarted' }), /ещё разрешено 2 другими строками/)
    assert.match(revokeSummary({ rule, stillAllowedBy: 1, codex: 'restarted' }), /ещё разрешено 1 другой строкой/)
  })
})

describe('правила codex: метка, список, отзыв — байт в байт', () => {
  const grant = { kind: 'execpolicy' as const, argv: ['git', 'push'], sessionId: 'w', cwd: '/srv/p' }

  it('метит только НОВУЮ строку; остальное — байт в байт; отзыв на месте (тот же inode) возвращает файл как был', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      writeFileSync(f, USER_TEXT)
      chmodSync(f, 0o640)
      const ino = statSync(f).ino
      const baseline = countMatching(readFileSync(f), grant)
      assert.equal(baseline, 0)
      assert.equal(await markNewRule(f, grant, baseline, { id: 'r-1', at: '2026-10-29T10:00:00.000Z' }), null, 'codex ещё не дописал — метить нечего')
      assert.ok(readFileSync(f).equals(USER_TEXT), 'файл не тронут')
      appendFileSync(f, `\n${RULE(['git', 'push'])}\n`)
      const withRule = readFileSync(f)
      const marked = await markNewRule(f, grant, baseline, { id: 'r-1', at: '2026-10-29T10:00:00.000Z' })
      assert.deepEqual(marked, { id: 'r-1', at: '2026-10-29T10:00:00.000Z', session: 'w', cwd: '/srv/p', kind: 'execpolicy', label: 'git push' })
      const listed = listCodexRules(f)
      assert.deepEqual(listed.rules, [marked])
      assert.equal(listed.unmarked, 2, 'чужие allow-строки — только счётчиком; deny не в счёт')
      assert.equal(statSync(f).mode & 0o777, 0o640, 'режим файла сохранён')
      assert.equal(await markNewRule(f, grant, baseline, { id: 'r-2', at: 'x' }), null, 'повторная метка не ставится')
      const revoked = await revokeCodexRule(f, 'r-1')
      assert.equal(revoked.rule.label, 'git push')
      assert.equal(revoked.stillAllowedBy, 0)
      const back = readFileSync(f)
      assert.ok(back.equals(Buffer.concat([USER_TEXT, Buffer.from('\n')])), 'ушли ровно метка и строка правила')
      assert.ok(!back.equals(withRule))
      assert.equal(statSync(f).ino, ino, 'правка на месте, а не rename')
      assert.equal(existsSync(`${f}.pult.bak`), false, 'копия убрана после записи')
      await assert.rejects(revokeCodexRule(f, 'r-1'), /нет/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('запись codex в дескриптор, открытый ДО правки Пульта, не теряется', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      const line = RULE(['make'])
      writeFileSync(f, `${MARK('r-5', line)}\n${line}\n`)
      const codexFd = openSync(f, 'a')
      try {
        await revokeCodexRule(f, 'r-5')
        writeSync(codexFd, `${RULE(['cargo', 'test'])}\n`)
      } finally { closeSync(codexFd) }
      assert.equal(readFileSync(f, 'utf8'), `${RULE(['cargo', 'test'])}\n`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('замок codex (flock) занят — Пульт ждёт и отказывает, файл не тронут (macOS: O_EXLOCK)', { skip: process.platform !== 'darwin' }, async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      const line = RULE(['make'])
      const text = `${MARK('r-5', line)}\n${line}\n`
      writeFileSync(f, text)
      const held = openSync(f, fsc.O_RDWR | 0x20)
      try {
        await assert.rejects(revokeCodexRule(f, 'r-5'), /держит другой процесс/)
      } finally { closeSync(held) }
      assert.equal(readFileSync(f, 'utf8'), text)
      assert.equal((await openLocked(f)).locked, true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('осталась копия прерванной записи — список её показывает, правки нет до человека', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      const line = RULE(['make'])
      const text = `${MARK('r-5', line)}\n${line}\n`
      writeFileSync(f, text)
      writeFileSync(`${f}.pult.bak`, 'старое')
      assert.equal(listCodexRules(f).backup, `${realpathSync(f)}.pult.bak`)
      await assert.rejects(revokeCodexRule(f, 'r-5'), /копия прерванной записи/)
      assert.equal(readFileSync(f, 'utf8'), text)
      assert.equal(readFileSync(`${f}.pult.bak`, 'utf8'), 'старое', 'копию не затираем')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('строка уже была в файле до «Всегда» (codex не дублирует) — метки нет, чужое не отзывается', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      writeFileSync(f, `${RULE(['git', 'push'])}\n`)
      const before = readFileSync(f)
      const baseline = countMatching(before, grant)
      assert.equal(baseline, 1)
      assert.equal(await markNewRule(f, grant, baseline, { id: 'r-1', at: 'x' }), null)
      assert.ok(readFileSync(f).equals(before))
      assert.deepEqual(listCodexRules(f).rules, [])
      await assert.rejects(revokeCodexRule(f, 'r-1'))
      assert.ok(readFileSync(f).equals(before), 'неотмеченную строку отзыв не трогает')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('метка-сирота не усыновляет строку человека под собой и следующую запись codex', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      // Метка от «make», чью строку убрали руками; под ней теперь правило человека.
      const human = RULE(['rm', '-rf'])
      const text = `${MARK('r-9', RULE(['make']))}\n${human}\n${MARK('r-8', RULE(['ls']))}\n`
      writeFileSync(f, text)
      assert.deepEqual(listCodexRules(f).rules, [])
      assert.equal(listCodexRules(f).unmarked, 1)
      await assert.rejects(revokeCodexRule(f, 'r-9'), /нет/)
      assert.equal(readFileSync(f, 'utf8'), text, 'строка человека на месте')
      // codex дописывает новую строку сразу под меткой-сиротой в конце файла — та её тоже не берёт.
      appendFileSync(f, `${RULE(['cargo'])}\n`)
      assert.deepEqual(listCodexRules(f).rules, [])
      await assert.rejects(revokeCodexRule(f, 'r-8'), /нет/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('две метки с одним id — ни одна не в списке, обе строки — «без метки»', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      const a = RULE(['make'])
      const b = RULE(['ls'])
      writeFileSync(f, `${MARK('r-1', a)}\n${a}\n${MARK('r-1', b)}\n${b}\n`)
      const l = listCodexRules(f)
      assert.deepEqual([l.rules.length, l.unmarked], [0, 2])
      await assert.rejects(revokeCodexRule(f, 'r-1'), /нет/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('после отзыва — сколько строк ещё разрешают то же: такая же, префикс шире, соседний *.rules', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      const line = RULE(['git', 'push'])
      writeFileSync(f, `${MARK('r-1', line)}\n${line}\n${line}\n${RULE(['git'])}\n${RULE(['git', 'push', '--force'])}\n`)
      writeFileSync(join(dir, 'extra.rules'), `${RULE(['git', 'push'])}\n`)
      writeFileSync(join(dir, 'notes.txt'), `${RULE(['git', 'push'])}\n`)
      const r = await revokeCodexRule(f, 'r-1')
      assert.equal(r.stillAllowedBy, 3, 'такая же + «git» + extra.rules; более узкий префикс и не-*.rules не в счёт')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('симлинк остаётся симлинком: правится его цель', async () => {
    const dir = tmp()
    try {
      const real = join(dir, 'dotfiles.rules.txt')
      const link = join(dir, 'default.rules')
      const line = RULE(['make'])
      writeFileSync(real, `${MARK('r-5', line)}\n${line}\n# хвост\n`)
      symlinkSync(real, link)
      await revokeCodexRule(link, 'r-5')
      assert.ok(lstatSync(link).isSymbolicLink())
      assert.equal(readFileSync(real, 'utf8'), '# хвост\n')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('файла нет — список пуст, exists: false, метка не создаёт файл', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'nope', 'default.rules')
      assert.deepEqual(listCodexRules(f), { path: f, exists: false, rules: [], unmarked: 0 })
      assert.equal(await markNewRule(f, grant, 0, { id: 'r-1', at: 'x' }), null)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('без замка (Linux): codex дописал во время записи — перечитать и повторить; не уймётся — предупреждение', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      const line = RULE(['make'])
      writeFileSync(f, `${MARK('r-5', line)}\n${line}\n`)
      let once = false
      await revokeCodexRule(f, 'r-5', { lock: false, afterWrite: () => { if (!once) { once = true; appendFileSync(f, `${RULE(['cargo'])}\n`) } } })
      assert.equal(readFileSync(f, 'utf8'), `${RULE(['cargo'])}\n`, 'запись codex пережила правку без замка')
      writeFileSync(f, '# моё\n')
      const warns: string[] = []
      let n = 0
      await editRulesFile(f, (b) => Buffer.concat([b, Buffer.from('# метка\n')]), { lock: false, afterWrite: () => { appendFileSync(f, `# codex ${++n}\n`) }, warn: (m) => warns.push(m) })
      assert.equal(warns.length, 1)
      assert.match(warns[0]!, /изменился во время записи без замка/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('копия прерванной записи — совет, как вернуть файл', () => {
    assert.equal(backupAdvice('/r/default.rules'),
      'осталась копия прерванной записи /r/default.rules.pult.bak: если default.rules пуст или обрезан — mv /r/default.rules.pult.bak /r/default.rules, затем проверь последние строки; иначе удали копию')
  })

  it('замок занят — ждём таймером, цикл событий демона не стоит', { skip: process.platform !== 'darwin' }, async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      const line = RULE(['make'])
      writeFileSync(f, `${MARK('r-5', line)}\n${line}\n`)
      const held = openSync(f, fsc.O_RDWR | 0x20)
      let ticks = 0
      const t = setInterval(() => { ticks++ }, 50)
      try {
        const p = revokeCodexRule(f, 'r-5')
        setTimeout(() => closeSync(held), 400)
        const r = await p
        assert.equal(r.rule.id, 'r-5', 'замок отпустили — правка прошла')
        assert.ok(ticks >= 4, `таймеры стояли, пока ждали замок: ${ticks}`)
      } finally { clearInterval(t) }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('второе «Всегда» на то же: строка уже помечена — новой метки и заметки «не помечено» нет', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      const line = RULE(['git', 'push'])
      writeFileSync(f, `${MARK('r-1', line)}\n${line}\n`)
      const before = readFileSync(f)
      const unmarked: string[] = []
      const rules = createCodexRules({ path: f, pollMs: 20, waitMs: 150, onUnmarked: (_g, why) => unmarked.push(why) })
      rules.granted({ ...grant, sessionId: 'w2' })
      await new Promise((r) => setTimeout(r, 400))
      assert.deepEqual(unmarked, [])
      assert.ok(readFileSync(f).equals(before))
      await rules.close()
      assert.deepEqual(unmarked, [])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('createCodexRules: ждёт записи codex и метит; не дождался — onUnmarked с причиной; остановка — последняя попытка', async () => {
    const dir = tmp()
    try {
      const f = join(dir, 'default.rules')
      writeFileSync(f, '# моё\n')
      const unmarked: string[] = []
      const rules = createCodexRules({ path: f, pollMs: 20, waitMs: 400, onUnmarked: (g, why) => unmarked.push(`${g.sessionId}: ${why}`) })
      rules.granted({ kind: 'network', host: 'example.com', sessionId: 's1' })
      setTimeout(() => appendFileSync(f, 'network_rule(host="example.com", protocol="https", decision="allow")\n'), 80)
      assert.ok(await waitFor(() => rules.list().rules.length === 1, 3000), 'метки нет')
      const r = rules.list().rules[0]!
      assert.deepEqual([r.kind, r.label, r.session], ['network', 'example.com', 's1'])
      await rules.revoke(r.id)
      assert.equal(readFileSync(f, 'utf8'), '# моё\n')
      rules.granted({ kind: 'execpolicy', argv: ['ls'], sessionId: 's2' })
      assert.ok(await waitFor(() => unmarked.length === 1, 3000))
      assert.match(unmarked[0]!, /^s2: codex не дописал строку правила/)
      assert.equal(readFileSync(f, 'utf8'), '# моё\n')
      // Демон останавливается посреди ожидания: строка уже есть — помечается; нет — заметка «демон остановлен».
      const slow = createCodexRules({ path: f, pollMs: 10_000, waitMs: 60_000, onUnmarked: (g, why) => unmarked.push(`${g.sessionId}: ${why}`) })
      slow.granted({ kind: 'execpolicy', argv: ['make'], sessionId: 's3' })
      slow.granted({ kind: 'execpolicy', argv: ['cargo'], sessionId: 's4' })
      appendFileSync(f, `${RULE(['make'])}\n`)
      await slow.close()
      assert.deepEqual(slow.list().rules.map((x) => x.session), ['s3'])
      assert.match(unmarked.at(-1)!, /^s4: демон остановлен/)
      await rules.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// --- адаптер: перезапуск ради правил ------------------------------------------------------------------------------

function adapterRig(fake: Record<string, unknown>, now?: () => number) {
  const dir = tmp()
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
    netCheck: async () => ({ ok: true, provider: 'codex', path: 'direct', loc: 'XX', reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1, checkedAt: '2026-10-29T10:00:00.000Z', cached: false }) as never,
    schemaCheck: () => ({ status: 'ok', expected: 'x', actual: 'x', files: 310, detail: 'тест' }),
    ...(now ? { now } : {}),
  })
  const log = (): Array<Record<string, unknown>> => (existsSync(logOut)
    ? readFileSync(logOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [])
  return { adapter, broker, drafts, cwd, log, remove: () => { reap(logOut); rmSync(dir, { recursive: true, force: true }) } }
}
const notices = (drafts: EventDraft[]): string[] => drafts.filter((d) => d.kind === 'session.configured').map((d) => String((d.data as Record<string, unknown>)['notice']))

describe('правила codex: адаптер — перезапуск ради отозванного правила', () => {
  it('снятый процесс: новый не поднимается, пока старый жив; его поздние уведомления и запросы до сессии не доходят', async () => {
    const r = adapterRig({ lingerOnTerm: 1200 })
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, mode: 'turn', broker: true })
      const t1 = await r.adapter.send('w', 'делай [[simple]]')
      assert.equal((await t1.done).ok, true)
      const before = r.drafts.length
      assert.equal(r.adapter.reloadPolicy?.('тест').codex, 'restarted')
      const t2 = await r.adapter.send('w', 'делай [[simple]]')
      assert.equal((await t2.done).ok, true)
      const log = r.log()
      const exit = log.find((x) => x['ev'] === 'exit')
      const boots = log.filter((x) => x['ev'] === 'boot')
      assert.equal(boots.length, 2)
      assert.ok(exit && Number(boots[1]!['t']) >= Number(exit['t']), 'второй процесс поднят до выхода первого')
      const late = r.drafts.slice(before)
      assert.equal(JSON.stringify(late).includes('ПОЗДНЕЕ-СТАРОГО'), false, 'позднее сообщение старого процесса дошло до сессии')
      assert.equal(r.broker.list('w').length, 0, 'запрос старого процесса попал в Inbox')
      assert.ok(log.some((x) => x['ev'] === 'client' && (x['msg'] as { method?: string }).method === 'thread/resume'), 'тред не возобновлён')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('занят дольше 10 мин — одно напоминание в ленту; причина названа', async () => {
    let t = Date.parse('2026-10-29T10:00:00Z')
    const r = adapterRig({}, () => t)
    try {
      await r.adapter.startSession({ name: 'w', cwd: r.cwd, mode: 'turn', broker: true })
      const turn = await r.adapter.send('w', 'делай [[hang]]')
      const res = r.adapter.reloadPolicy?.('Правило отозвано')
      assert.deepEqual(res, { codex: 'deferred', busy: 'идёт ход' })
      assert.match(notices(r.drafts).at(-1)!, /^Правило отозвано: Codex занят \(идёт ход\) — пока он не освободится, правило в нём ещё действует; потом Пульт перезапустит Codex, и разрешения «в этой сессии» у всех сессий Codex сброшены/)
      t += RELOAD_REMIND_MS + 1000
      assert.ok(await waitFor(() => notices(r.drafts).some((n) => /всё ещё занят \(идёт ход\)/.test(n)), 3000), 'напоминания нет')
      await new Promise((ok) => setTimeout(ok, 1200))
      assert.equal(notices(r.drafts).filter((n) => /всё ещё занят/.test(n)).length, 1, 'напоминание одно')
      await r.adapter.interrupt('w')
      await turn.done
      assert.ok(await waitFor(() => notices(r.drafts).some((n) => /Codex в Пульте перезапущен/.test(n)), 3000), 'после хода — перезапуск')
    } finally { await r.adapter.shutdown(); r.remove() }
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
      assert.equal(listing.unmarked, 2, 'allow-строки человека; deny не в счёт')
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
      type Revoked = { codexRules: Listing; codexRulesRevoked: { codex: string; stillAllowedBy: number; text: string } }
      const after1 = (await c.request('settings.set', { codexRules: { revoke: rule.id } })) as Revoked
      assert.deepEqual(after1.codexRules.rules, [])
      // Ход идёт — Codex перезапустится после него, а не сейчас; правило до конца хода ещё действует.
      assert.equal(after1.codexRulesRevoked.codex, 'deferred')
      assert.match(after1.codexRulesRevoked.text, /Codex занят \(идёт ход\): пока он не освободится, правило в нём ещё действует/)
      assert.ok(readFileSync(rulesFile).equals(Buffer.concat([USER_TEXT, Buffer.from('\n')])), 'чужое — байт в байт, ушли метка и строка')
      await assert.rejects(c.request('perm.rules.revoke', { id: rule.id }), code('not_found'))
      await c.request('agent.wait', { name: 'c', timeoutMs: 10_000 })
      type Ev = { sessionId: string; kind: string; data: Record<string, unknown> }
      const all = async (): Promise<Ev[]> => ((await c.request('events.tail', { since: 0 })) as { events: Ev[] }).events
      let events = await all()
      const done = events.filter((e) => e.sessionId === 'c' && e.kind === 'status.changed').map((e) => e.data['status'])
      assert.equal(done.at(-1), 'idle', `ход не дошёл до конца: ${done.join(' → ')}`)
      assert.equal(events.filter((e) => e.sessionId === 'c' && e.kind === 'status.changed' && e.data['status'] === 'failed').length, 0, 'ход не похоронен')
      const rev = events.find((e) => e.kind === 'rule.revoked')
      assert.equal(rev?.sessionId, 'daemon')
      assert.deepEqual([rev?.data['id'], rev?.data['label'], rev?.data['session'], rev?.data['codex']], [rule.id, rule.label, 'c', 'deferred'])
      // Ход кончился — общий процесс снят ради правил (не авария), в ленте сессии — две заметки.
      assert.ok(await waitFor(async () => (events = await all()).some((e) => e.kind === 'provider.restarted' && e.data['reason'] === 'policy_reload'), 5000), 'codex не перезапущен после хода')
      const notes = events.filter((e) => e.sessionId === 'c' && e.kind === 'session.configured').map((e) => String(e.data['notice']))
      assert.ok(notes.some((n) => /Codex занят \(идёт ход\)/.test(n)), notes.join(' | '))
      assert.ok(notes.some((n) => /Codex в Пульте перезапущен .*но разрешения «в этой сессии» у всех сессий Codex сброшены/.test(n)), notes.join(' | '))
      // Следующая реплика поднимает новый процесс и возвращается в тот же тред (thread/resume).
      await c.request('agent.prompt', { name: 'c', text: 'делай [[simple]]' })
      await c.request('agent.wait', { name: 'c', timeoutMs: 10_000 })
      const log = readFileSync(logOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { ev: string; msg?: { method?: string } })
      assert.equal(log.filter((r) => r.ev === 'boot').length, 2, 'второй процесс codex')
      assert.ok(log.some((r) => r.ev === 'client' && r.msg?.method === 'thread/resume'), 'тред возобновлён')
      const st2 = ((await c.request('agent.list')) as { sessions: Array<{ name: string; lastStatus: string }> }).sessions.find((s) => s.name === 'c')
      assert.equal(st2?.lastStatus, 'idle')

      // Без ходов — перезапуск сразу.
      await c.request('agent.prompt', { name: 'c', text: 'делай [[approval-custom]]' })
      assert.ok(await waitFor(async () => {
        const p = ((await c.request('perm.list', { name: 'c' })) as { pending: Array<{ id: string }> }).pending
        id = p[0]?.id ?? ''
        return id !== ''
      }, 10_000))
      await c.request('perm.resolve', { id, decision: 'allow', scope: 'rule' })
      assert.ok(await waitFor(async () => ((await c.request('perm.rules')) as Listing).rules.length === 1, 5000))
      await c.request('agent.wait', { name: 'c', timeoutMs: 10_000 })
      const id2 = ((await c.request('perm.rules')) as Listing).rules[0]!.id
      const now2 = (await c.request('perm.rules.revoke', { id: id2 })) as { codex: string; text: string }
      assert.equal(now2.codex, 'restarted')
      assert.match(now2.text, /Codex в Пульте перезапущен — правило больше не действует; .*«в этой сессии».*сброшены/)
    } finally {
      c.close(); await d.stop('конец теста'); reap(logOut)
      home.remove(); rmSync(root, { recursive: true, force: true })
    }
  })

  it('codex не дописал строку, а демон остановился — заметка «не помечено» в ленте сессии', async () => {
    const home = tempHome()
    const root = tmp()
    const logOut = join(root, 'server.jsonl')
    mkdirSync(join(home.paths.home, 'codex-rules'))
    writeFileSync(join(home.paths.home, 'codex-rules', 'default.rules'), '# моё\n')
    // Без `rulesFile`: фальшивый codex строку не пишет.
    writeFileSync(join(home.paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut, ...offer(0) }))
    let d = await startTestDaemon(home, { codexBin: FAKE_CODEX_SCRIPTED })
    let c = await connectClient(home.paths)
    try {
      await c.request('agent.start', { name: 'c', kind: 'codex', cwd: root })
      await c.request('agent.prompt', { name: 'c', text: 'делай [[approval-custom]]' })
      let id = ''
      assert.ok(await waitFor(async () => {
        id = ((await c.request('perm.list', { name: 'c' })) as { pending: Array<{ id: string }> }).pending[0]?.id ?? ''
        return id !== ''
      }, 10_000))
      await c.request('perm.resolve', { id, decision: 'allow', scope: 'rule' })
      await c.request('agent.wait', { name: 'c', timeoutMs: 10_000 })
      c.close(); await d.stop('конец теста')
      d = await startTestDaemon(home, { codexBin: FAKE_CODEX_SCRIPTED })
      c = await connectClient(home.paths)
      const events = ((await c.request('events.tail', { since: 0, sessionId: 'c' })) as { events: Array<{ kind: string; data: Record<string, unknown> }> }).events
      const note = events.find((e) => e.kind === 'session.configured' && /не помечено/.test(String(e.data['notice'])))
      assert.match(String(note?.data['notice']), /демон остановлен .* убрать можно только руками/)
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
      assert.match(ok.stdout, /Отозвано: команды, начинающиеся с/)
      assert.equal(readFileSync(rulesFile, 'utf8'), '# моё\nprefix_rule(pattern=["ls"], decision="allow")\n')
    } finally {
      await runCli(paths, ['daemon', 'stop'])
      reap(logOut)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
