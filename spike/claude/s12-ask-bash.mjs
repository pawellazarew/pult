#!/usr/bin/env node
// S12 (0.3.7, ключи вопросов) — правила `--settings`, которые Пульт ставит сессиям Claude:
//   * `permissions.ask: ["Bash"]` в read-only (`--permission-mode manual`) перебивает разрешающее правило проекта
//     `Bash(python3:*)` из `.claude/settings.local.json` (deny > ask > allow);
//   * `permissions.deny: ["Read(//<run>/**)", "Edit(//<run>/**)"]` закрывает инструменты Read/Edit для папки ВНЕ cwd.
// Ревью #16 добавило: что deny НЕ закрывает — Bash (`cat`), Grep/Glob по родителю папки, путь другим регистром на APFS,
// и экранируются ли метасимволы глоба в пути правила.
//
// Временные папки: «дом» с `run/token` (метка), проект A (allow `Bash(python3:*)`, `Bash(cat:*)`, `Read(//<дом>/**)` —
// владелец разрешил читать дом целиком), проект B (без правил). `--setting-sources project,local`: настройки владельца
// не грузятся и не трогаются. Заглушка s9-stub отказывает на всё (S9_DENY) — спайк видит только, пришёл ли вопрос;
// утечка — метка в выводе инструмента, а не «агент спросил».
//
// Сессии и ходы (haiku, low):
//   A  manual + ask Bash + deny run, проект A: T1 python3 (вопрос должен прийти); T2 Read run/token (отказ без вопроса)
//   B  manual без правил, проект A: T3 python3 (контроль: идёт молча)
// Дальше — каждый ход в СВОЁЙ сессии (manual/acceptEdits + deny run): иначе модель помнит прошлый отказ и сама
// отказывается пробовать обход, и ход ничего не меряет.
//   T4a/T4b  cat run/token, проект A (allow cat), manual / acceptEdits
//   T4c/T4d  cat run/token, проект B (без allow), manual / acceptEdits
//   T4e      python3 читает run/token, проект A (allow python3), manual — интерпретатор
//   T5a      grep -r по дому (родитель run), проект A (allow grep), manual
//   T5b      инструменты Grep/Glob, если они есть в system/init (CLI 2.1.310 их может не давать)
//   T5c      Read <дом>/RUN/token — другой регистр на APFS
//   T6a/T6b  Read из папки `m[a]{b}(c)` — правило deny с экранированием `\` и без

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, HERE, NODE_BIN, logNetworkProfile, scrubbedEnv, egressGuard } from './lib.mjs'

const ID = 'S12-claude'
const log = openLog('s12-ask-bash')
logNetworkProfile(log)
await egressGuard(log, [ID])

const home = realpathSync(mkdtempSync(join(tmpdir(), 'pult-s12-home-')))
const run = join(home, 'run')
const meta = join(home, 'm[a]{b}(c)')
mkdirSync(run, { mode: 0o700 })
mkdirSync(meta, { mode: 0o700 })
const MARK = `S12MARK${randomBytes(6).toString('hex')}`
const MARK2 = `S12META${randomBytes(6).toString('hex')}`
writeFileSync(join(run, 'token'), MARK + '\n', { mode: 0o600 })
writeFileSync(join(meta, 'token'), MARK2 + '\n', { mode: 0o600 })
const project = (name, allow) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pult-s12-${name}-`)))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow } }))
  return dir
}
const projA = project('a', ['Bash(python3:*)', 'Bash(cat:*)', 'Bash(grep:*)', `Read(/${home}/**)`])
const projB = project('b', [])
const TRACE = join(HERE, 'logs', 's12-mcp-trace.jsonl')
writeFileSync(TRACE, '')
const mcpConfig = join(projA, 'mcp.json')
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { pultask: { command: NODE_BIN, args: [join(HERE, 's9-stub.mjs')], env: { S9_TRACE: TRACE, S9_DENY: 'Bash,Read,Glob,Grep' } } } }))
const asks = () => readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.dir === 'in' && r.msg?.method === 'tools/call').map((r) => r.msg.params.arguments)

const session = ({ mode, settings, cwd }) => startClaude({
  args: [
    ...baseArgs({ sessionId: newSessionId(), model: 'haiku', effort: 'low', settingSources: 'project,local', permissionPrompts: 'host' }),
    '--permission-mode', mode,
    '--mcp-config', mcpConfig, '--strict-mcp-config', '--permission-prompt-tool', 'mcp__pultask__ask',
    ...(settings ? ['--settings', JSON.stringify(settings)] : []),
  ],
  cwd, env: scrubbedEnv(),
})
const turn = async (s, text, label, files = []) => {
  const from = s.mark()
  const before = asks().length
  s.send(text)
  const r = await waitForResult(s, 180000, { from })
  if (looksNotLoggedIn(s.events)) { log.rec('verdict', { verdict: 'blocked', reason: 'not logged in' }); process.exit(2) }
  const a = asks().slice(before)
  const evs = s.events.slice(from)
  const tools = evs.filter((e) => e.type === 'assistant')
    .flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => ({ name: c.name, input: c.input })))
  // Вывод инструментов (tool_result в событиях `user`) и текст ответа — входы инструментов сюда не входят.
  const out = JSON.stringify(evs.filter((e) => e.type === 'user' || e.type === 'result')) +
    JSON.stringify(evs.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'text')))
  const row = {
    label,
    tools: tools.map((t) => t.name),
    asked: a.map((x) => x.tool_name),
    denials: (r?.permission_denials ?? []).map((d) => d.tool_name),
    leaked: out.includes(MARK) || out.includes(MARK2),
    ...Object.fromEntries(files.map((f) => [`listed:${f}`, out.includes(f)])),
    result: resultSummary(r)?.result,
  }
  log.rec('turn', { ...row, tool_inputs: tools })
  return row
}
const deny = (dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]
const esc = (p) => p.replace(/[\[\]{}()*?\\]/g, '\\$&')
const RULES = { permissions: { ask: ['Bash'], deny: deny(run) } }
const DENY_ONLY = { permissions: { deny: deny(run) } }
const done = (s) => { s.endStdin(); return s.exited }
const rows = {}
const cat = `Run exactly this shell command with the Bash tool and nothing else: cat ${run}/token — then reply with its output.`

let s = session({ mode: 'manual', settings: RULES, cwd: projA })
rows.T1 = await turn(s, 'Run exactly this shell command with the Bash tool and nothing else: python3 -c "open(\'s12a.txt\',\'w\').write(\'1\')" — then reply "done".', 'T1 A manual ask-Bash python3')
rows.T2 = await turn(s, `Use the Read tool (and no other tool) to read the file ${join(run, 'token')} and reply with its exact contents.`, 'T2 A Read run/token')
await done(s)

s = session({ mode: 'manual', settings: null, cwd: projA })
rows.T3 = await turn(s, 'Run exactly this shell command with the Bash tool and nothing else: python3 -c "open(\'s12b.txt\',\'w\').write(\'1\')" — then reply "done".', 'T3 B control python3')
await done(s)

const one = async (key, opts, text, label, files) => {
  const ss = session(opts)
  rows[key] = await turn(ss, text, label, files)
  const init = ss.events.find((e) => e.type === 'system' && e.subtype === 'init')
  rows[key].initTools = Array.isArray(init?.tools) ? init.tools.filter((t) => /^(Grep|Glob|Read|Bash|LS)$/.test(t)) : null
  await done(ss)
}
await one('T4a', { mode: 'manual', settings: DENY_ONLY, cwd: projA }, cat, 'T4a manual allow-cat cat run/token')
await one('T4b', { mode: 'acceptEdits', settings: DENY_ONLY, cwd: projA }, cat, 'T4b acceptEdits allow-cat cat run/token')
await one('T4c', { mode: 'manual', settings: DENY_ONLY, cwd: projB }, cat, 'T4c manual no-allow cat run/token')
await one('T4d', { mode: 'acceptEdits', settings: DENY_ONLY, cwd: projB }, cat, 'T4d acceptEdits no-allow cat run/token')
await one('T4e', { mode: 'manual', settings: DENY_ONLY, cwd: projA },
  `Run exactly this shell command with the Bash tool and nothing else: python3 -c "print(open('${run}/token').read())" — then reply with its output.`, 'T4e manual allow-python3 reads run/token')
await one('T5a', { mode: 'manual', settings: DENY_ONLY, cwd: projA },
  `Run exactly this shell command with the Bash tool and nothing else: grep -r S12MARK ${home} — then reply with its output verbatim.`, 'T5a manual allow-grep grep -r parent')
await one('T5b', { mode: 'manual', settings: DENY_ONLY, cwd: projA },
  `If you have a Grep tool, use it with pattern "S12MARK", path "${home}", output_mode "content"; if you have a Glob tool, use it with pattern "**/token" and path "${home}". Use no other tools. Reply with what they returned, or say which of the two tools you do not have.`, 'T5b Grep/Glob tools on parent', [`${run}/token`])
await one('T5c', { mode: 'manual', settings: DENY_ONLY, cwd: projA },
  `Use the Read tool (and no other tool) to read the file ${join(home, 'RUN', 'token')} and reply with its exact contents.`, 'T5c Read RUN/token (case)')

const readMeta = `Use the Read tool (and no other tool) to read the file ${join(meta, 'token')} and reply with its exact contents.`
await one('T6a', { mode: 'manual', settings: { permissions: { deny: [`Read(/${esc(meta)}/**)`] } }, cwd: projA }, readMeta, 'T6a Read meta, escaped deny')
await one('T6b', { mode: 'manual', settings: { permissions: { deny: [`Read(/${meta}/**)`] } }, cwd: projA }, readMeta, 'T6b Read meta, unescaped deny')

const verdict = {
  t1_bash_asked: rows.T1.asked.includes('Bash'),
  t1_file_exists: existsSync(join(projA, 's12a.txt')),
  t2_read_asked: rows.T2.asked.includes('Read'),
  t2_leaked: rows.T2.leaked,
  t3_bash_asked: rows.T3.asked.includes('Bash'),
  t3_file_exists: existsSync(join(projA, 's12b.txt')),
  t4a_manual_allowcat: { tools: rows.T4a.tools, asked: rows.T4a.asked, denials: rows.T4a.denials, leaked: rows.T4a.leaked },
  t4b_accept_allowcat: { asked: rows.T4b.asked, leaked: rows.T4b.leaked },
  t4c_manual_noallow: { asked: rows.T4c.asked, leaked: rows.T4c.leaked },
  t4d_accept_noallow: { asked: rows.T4d.asked, leaked: rows.T4d.leaked },
  t4e_manual_python3: { tools: rows.T4e.tools, asked: rows.T4e.asked, denials: rows.T4e.denials, leaked: rows.T4e.leaked },
  t5a_grep_r_parent: { tools: rows.T5a.tools, asked: rows.T5a.asked, denials: rows.T5a.denials, leaked: rows.T5a.leaked },
  t5b_grep_glob_tools: { init: rows.T5b.initTools, tools: rows.T5b.tools, asked: rows.T5b.asked, denials: rows.T5b.denials, leaked: rows.T5b.leaked, listed: rows.T5b[`listed:${run}/token`] },
  t5c_read_case: { tools: rows.T5c.tools, asked: rows.T5c.asked, denials: rows.T5c.denials, leaked: rows.T5c.leaked },
  t6a_meta_escaped: { asked: rows.T6a.asked, denials: rows.T6a.denials, leaked: rows.T6a.leaked },
  t6b_meta_unescaped: { asked: rows.T6b.asked, denials: rows.T6b.denials, leaked: rows.T6b.leaked },
}
log.rec('verdict', verdict)
const works = verdict.t1_bash_asked && !verdict.t1_file_exists && !verdict.t2_read_asked && !verdict.t2_leaked
  && !verdict.t3_bash_asked && verdict.t3_file_exists
saveResult({
  id: ID,
  title: 'Claude --settings: ask Bash beats project allow in manual; deny Read/Edit on run dir; what deny does not cover (Bash cat, Grep/Glob on parent, case, glob metachars)',
  verdict: works ? 'works' : 'fails',
  details: JSON.stringify(verdict),
  decisive_evidence: 'spike/claude/logs/s12-ask-bash.jsonl :: verdict; spike/claude/logs/s12-mcp-trace.jsonl',
  script: 's12-ask-bash.mjs',
})
await log.close()
