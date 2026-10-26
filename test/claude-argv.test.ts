// Контракт argv адаптера Claude и файл --mcp-config.
// Флаги сверяются с ДОСЛОВНО записанным argv рекордера (см. test/fixtures/claude/README.md).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildClaudeArgv, claudeGuardPermissions, mcpConfigBody, PERMISSION_TOOL, userTurnLine } from '../dist/adapters/claude/argv.js'

const UUID = '94357d2d-8c5c-46b3-9a4c-2176726d3521'

const pairs = (argv: string[]): Map<string, string> => {
  const m = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a.startsWith('--') && i + 1 < argv.length && !(argv[i + 1] as string).startsWith('--')) m.set(a, argv[i + 1] as string)
  }
  return m
}

describe('argv claude', () => {
  it('импортированный разговор форкается только на первом resume', () => {
    const fork = buildClaudeArgv({ sessionId: UUID, resume: true, forkOnResume: true })
    assert.equal(pairs(fork).get('--resume'), UUID)
    assert.ok(fork.includes('--fork-session'))
    assert.ok(!fork.includes('--session-id'))
    assert.ok(!buildClaudeArgv({ sessionId: UUID, resume: false, forkOnResume: true }).includes('--fork-session'))
    assert.ok(!buildClaudeArgv({ sessionId: UUID, resume: true, forkOnResume: false }).includes('--fork-session'))
  })
  it('первый ход: --session-id, измеренный набор флагов, --permission-prompts none без брокера', () => {
    const argv = buildClaudeArgv({ sessionId: UUID, resume: false, model: 'haiku', effort: 'low', settingSources: 'user' })
    assert.deepEqual(argv.slice(0, 7), [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ])
    assert.ok(argv.includes('--forward-subagent-text'))
    const p = pairs(argv)
    assert.equal(p.get('--session-id'), UUID)
    assert.equal(p.get('--model'), 'haiku')
    assert.equal(p.get('--effort'), 'low')
    assert.equal(p.get('--setting-sources'), 'user')
    // ИНВАРИАНТ 5: нода без хозяина разрешений запускается с запретом.
    assert.equal(p.get('--permission-prompts'), 'none')
    assert.ok(!argv.includes('--resume'))
    assert.ok(!argv.includes('--mcp-config'))
    assert.ok(!argv.includes('--permission-prompt-tool'))
  })

  it('следующий ход: --resume с тем же uuid и без --session-id', () => {
    const argv = buildClaudeArgv({ sessionId: UUID, resume: true })
    const p = pairs(argv)
    assert.equal(p.get('--resume'), UUID)
    assert.ok(!argv.includes('--session-id'))
  })

  it('с брокером: host + mcp-config + --permission-prompt-tool mcp__pult__ask', () => {
    const argv = buildClaudeArgv({ sessionId: UUID, resume: false, mcpConfigPath: '/tmp/x/mcp.json' })
    const p = pairs(argv)
    assert.equal(p.get('--permission-prompts'), 'host')
    assert.equal(p.get('--mcp-config'), '/tmp/x/mcp.json')
    assert.equal(p.get('--permission-prompt-tool'), PERMISSION_TOOL)
    assert.equal(PERMISSION_TOOL, 'mcp__pult__ask')
    assert.ok(argv.includes('--strict-mcp-config'))
  })

  it('ПРОМПТ НИКОГДА НЕ В ARGV — он уходит строкой stream-json в stdin', () => {
    const secret = 'секретная реплика про деньги'
    const argv = buildClaudeArgv({ sessionId: UUID, resume: false, model: secret })
    // Даже подставленный в модель текст остаётся значением флага, а самой реплики в argv нет.
    assert.ok(!argv.some((a) => a === secret && argv[argv.indexOf(a) - 1] !== '--model'))
    const line = userTurnLine(secret)
    const parsed = JSON.parse(line) as { type: string; message: { content: Array<{ text: string }> } }
    assert.equal(parsed.type, 'user')
    assert.equal(parsed.message.content[0]?.text, secret)
    assert.ok(line.endsWith('\n'))
    assert.equal('uuid' in parsed, false, 'без метки поля uuid нет')
  })

  it('метка реплики уходит полем uuid — по ней CLI метит свой ответ', () => {
    const tie = '1882cefb-2766-472b-81ce-8114f6ad41e1'
    const parsed = JSON.parse(userTurnLine('привет', tie)) as { uuid?: string; message: { content: Array<{ text: string }> } }
    assert.equal(parsed.uuid, tie)
    assert.equal(parsed.message.content[0]?.text, 'привет')
  })

  it('mcp-config запускает НАСТОЯЩИЙ `pult mcp-ask` и отдаёт ему PULT_HOME и ключ вопросов — не токен', () => {
    const body = JSON.parse(mcpConfigBody({
      nodeBin: '/usr/bin/node', cliEntry: '/opt/pult/dist/cli/main.js', home: '/tmp/home', sessionName: 'w', askKey: 'k'.repeat(64),
    })) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }
    const server = body.mcpServers['pult']
    assert.ok(server)
    assert.equal(server.command, '/usr/bin/node')
    assert.deepEqual(server.args, ['/opt/pult/dist/cli/main.js', 'mcp-ask'])
    assert.equal(server.env['PULT_HOME'], '/tmp/home')
    assert.equal(server.env['PULT_ASK_SESSION'], 'w')
    assert.equal(server.env['PULT_ASK_KEY'], 'k'.repeat(64))
    assert.deepEqual(Object.keys(server.env).sort(), ['PULT_ASK_KEY', 'PULT_ASK_SESSION', 'PULT_HOME'], 'токена хозяина в env нет')
  })

  it('0.3.7: --settings закрывает папку run всегда; read-only — ask Bash', () => {
    const settings = (argv: string[]): { permissions: Record<string, string[]> } | null =>
      argv.includes('--settings') ? JSON.parse(argv[argv.indexOf('--settings') + 1] as string) as { permissions: Record<string, string[]> } : null
    const deny = ['Read(//p/run/**)', 'Edit(//p/run/**)']
    for (const approval of [undefined, 'ask', 'workspace', 'full'] as const) {
      for (const broker of [true, false]) {
        const argv = buildClaudeArgv({ sessionId: UUID, resume: false, ...(approval ? { approval } : {}), ...(broker ? { mcpConfigPath: '/x' } : {}), protectDirs: ['/p/run'] })
        assert.deepEqual(settings(argv), { permissions: { deny } }, `${approval} broker=${broker}`)
      }
    }
    const ro = buildClaudeArgv({ sessionId: UUID, resume: false, approval: 'read-only', mcpConfigPath: '/x', protectDirs: ['/p/run'] })
    assert.deepEqual(settings(ro), { permissions: { ask: ['Bash'], deny } })
    assert.deepEqual(claudeGuardPermissions(['/a', '/b'], 'read-only'), { ask: ['Bash'], deny: ['Read(//a/**)', 'Edit(//a/**)', 'Read(//b/**)', 'Edit(//b/**)'] })
    assert.equal(settings(buildClaudeArgv({ sessionId: UUID, resume: false })), null, 'без папок и read-only — флага нет')
  })
})
