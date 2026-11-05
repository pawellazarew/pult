#!/usr/bin/env node
// A RAM-only stream-json fixture. Never writes prompts, replies, argv, or environment to disk.
import { readFileSync } from 'node:fs'
import readline from 'node:readline'
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('2.1.317 (Claude Code)'); process.exit(0) }
if (args.includes('--help')) {
  console.log('--safe-mode --no-session-persistence --system-prompt-snapshot --tools --disallowedTools --strict-mcp-config --mcp-config --setting-sources --disable-slash-commands --permission-prompts --input-format --output-format')
  process.exit(0)
}
let config = {}
try { config = JSON.parse(readFileSync('.pult-temporary-fake.json', 'utf8')) } catch { /* defaults */ }
const model = args[args.indexOf('--model') + 1]
const scenario = config.scenario ?? (model === 'pult-test-hang-once' ? 'hang-once' : model === 'pult-test-hang' ? 'hang' : 'normal')
const emit = (row) => process.stdout.write(JSON.stringify(row) + '\n')
let first = '', count = 0, pending = false
const init = () => emit({ type: 'system', subtype: 'init', tools: scenario === 'unsafe-tools' ? ['Read'] : [], mcp_servers: scenario === 'unsafe-mcp' ? [{ name: 'private' }] : [], skills: scenario === 'unsafe-skills' ? ['custom'] : [], slash_commands: [], plugins: scenario === 'unsafe-plugin' ? [{ path: '/custom/plugin', source: 'custom@marketplace' }] : [{ name: 'security', path: 'builtin', source: 'security@builtin' }] })
const result = (success = true, text = '') => emit({ type: 'result', subtype: success ? 'success' : 'error_during_execution', is_error: !success, result: text })
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  let row
  try { row = JSON.parse(line) } catch { return }
  if (row.type === 'control_request' && row.request?.subtype === 'interrupt') {
    if (scenario !== 'ignore-interrupt' && pending) { pending = false; result(false, 'Interrupted') }
    return
  }
  if (row.type !== 'user') return
  const text = row.message?.content?.filter((p) => p.type === 'text').map((p) => p.text).join('') ?? ''
  if (!first) first = text
  count++
  if (count === 1 && scenario !== 'no-init') init()
  if (scenario === 'crash') { process.stderr.write(text); process.exit(2) }
  if (scenario === 'error') { process.stderr.write(text); result(false, `PRIVATE CLI DETAIL ${text}`); return }
  if (scenario === 'malformed') { process.stdout.write('{not-json}\n'); return }
  if (scenario === 'hang' || scenario === 'ignore-interrupt' || (scenario === 'hang-once' && count === 1)) { pending = true; emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ready' } } }); return }
  const unsafeEnvironment = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'NODE_OPTIONS'].some((key) => process.env[key]);
  const answer = scenario === 'environment' ? JSON.stringify({ unsafeEnvironment: !!unsafeEnvironment, safeMode: process.env.CLAUDE_CODE_SAFE_MODE === '1', proxy: process.env.HTTPS_PROXY === 'http://127.0.0.1:9876' }) : count === 1 ? `Temporary reply: ${text}` : `First message: ${first}; reply: ${text}`
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } })
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
  result(true, answer)
})
input.on('close', () => process.exit(0))
