#!/usr/bin/env node
// S12 (0.3.7, ключи вопросов) — правила `--settings`, которые Пульт ставит сессиям Claude с брокером:
//   * `permissions.ask: ["Bash"]` в read-only (`--permission-mode manual`) перебивает разрешающее правило
//     проекта `Bash(python3:*)` из `.claude/settings.local.json` (deny > ask > allow);
//   * `permissions.deny: ["Read(//<run>/**)"]` закрывает чтение папки ВНЕ cwd (там лежат токен и mcp-config).
//
// Ходы (haiku, low, 3): временная папка проекта со своим `.claude/settings.local.json`, `--setting-sources project,local`
// (настройки владельца не грузятся и не трогаются), заглушка s9-stub с отказом на всё (S9_DENY) — спайк видит только,
// дошёл ли вопрос; ничего не исполняется.
//   1. сессия A (ask Bash + deny run): «python3 -c …» → вопрос ДОЛЖЕН прийти, файла нет;
//   2. та же сессия: «прочитай <run>/token инструментом Read» → вопроса о Read нет, метки в ответе нет;
//   3. сессия B (контроль, без ask): та же команда python3 → вопроса НЕТ, файл есть (правило проекта действует).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { baseArgs, newSessionId, openLog, saveResult, startClaude, waitForResult, resultSummary, looksNotLoggedIn, HERE, NODE_BIN, logNetworkProfile, scrubbedEnv, egressGuard } from './lib.mjs'

const ID = 'S12-claude'
const log = openLog('s12-ask-bash')
logNetworkProfile(log)
await egressGuard(log, [ID])

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pult-s12-')))
const run = realpathSync(mkdtempSync(join(tmpdir(), 'pult-s12-run-')))
const MARK = `S12MARK${randomBytes(6).toString('hex')}`
writeFileSync(join(run, 'token'), MARK + '\n', { mode: 0o600 })
mkdirSync(join(dir, '.claude'))
writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(python3:*)'] } }))
const TRACE = join(HERE, 'logs', 's12-mcp-trace.jsonl')
writeFileSync(TRACE, '')
const mcpConfig = join(dir, 'mcp.json')
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { pultask: { command: NODE_BIN, args: [join(HERE, 's9-stub.mjs')], env: { S9_TRACE: TRACE, S9_DENY: 'Bash,Read,Glob,Grep' } } } }))
const asks = () => readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.dir === 'in' && r.msg?.method === 'tools/call').map((r) => r.msg.params.arguments)

const session = (settings) => startClaude({
  args: [
    ...baseArgs({ sessionId: newSessionId(), model: 'haiku', effort: 'low', settingSources: 'project,local', permissionPrompts: 'host' }),
    '--permission-mode', 'manual',
    '--mcp-config', mcpConfig, '--strict-mcp-config', '--permission-prompt-tool', 'mcp__pultask__ask',
    ...(settings ? ['--settings', JSON.stringify(settings)] : []),
  ],
  cwd: dir, env: scrubbedEnv(),
})
const turn = async (s, text, label) => {
  const from = s.mark()
  const before = asks().length
  s.send(text)
  const r = await waitForResult(s, 180000, { from })
  if (looksNotLoggedIn(s.events)) { log.rec('verdict', { verdict: 'blocked', reason: 'not logged in' }); process.exit(2) }
  const a = asks().slice(before)
  const tools = s.events.slice(from).filter((e) => e.type === 'assistant')
    .flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => c.name))
  log.rec('turn', { label, result: resultSummary(r), tool_uses: tools, asks: a.map((x) => ({ tool_name: x.tool_name, input: x.input })) })
  return { asks: a, tools, text: JSON.stringify(s.events.slice(from)) }
}

const RULES = { permissions: { ask: ['Bash'], deny: [`Read(/${run}/**)`, `Edit(/${run}/**)`] } }
log.rec('settings', { rules: RULES })
const a = session(RULES)
const t1 = await turn(a, 'Run exactly this shell command with the Bash tool and nothing else: python3 -c "open(\'s12a.txt\',\'w\').write(\'1\')" — then reply "done".', 'T1 python3 with ask')
const t2 = await turn(a, `Use the Read tool (and no other tool) to read the file ${join(run, 'token')} and reply with its exact contents.`, 'T2 Read run dir')
a.endStdin(); await a.exited

const b = session(null)
const t3 = await turn(b, 'Run exactly this shell command with the Bash tool and nothing else: python3 -c "open(\'s12b.txt\',\'w\').write(\'1\')" — then reply "done".', 'T3 control python3 without ask')
b.endStdin(); await b.exited

const assistantText = (t) => t.text.includes(MARK)
const verdict = {
  t1_bash_asked: t1.asks.some((x) => x.tool_name === 'Bash'),
  t1_file_exists: existsSync(join(dir, 's12a.txt')),
  t2_read_tool_used: t2.tools.includes('Read'),
  t2_read_asked: t2.asks.some((x) => x.tool_name === 'Read'),
  t2_mark_leaked: assistantText(t2),
  t3_bash_asked: t3.asks.some((x) => x.tool_name === 'Bash'),
  t3_file_exists: existsSync(join(dir, 's12b.txt')),
}
log.rec('verdict', verdict)
const works = verdict.t1_bash_asked && !verdict.t1_file_exists && !verdict.t2_read_asked && !verdict.t2_mark_leaked
  && !verdict.t3_bash_asked && verdict.t3_file_exists
saveResult({
  id: ID,
  title: 'Claude --settings: ask Bash beats project allow Bash(python3:*) in manual mode; deny Read on a dir outside cwd',
  verdict: works ? 'works' : 'fails',
  details: JSON.stringify(verdict),
  decisive_evidence: 'spike/claude/logs/s12-ask-bash.jsonl :: verdict; spike/claude/logs/s12-mcp-trace.jsonl',
  script: 's12-ask-bash.mjs',
})
await log.close()
