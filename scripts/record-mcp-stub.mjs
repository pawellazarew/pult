#!/usr/bin/env node
// record-mcp-stub.mjs — крошечный stdio-MCP-сервер ТОЛЬКО для записи фикстур.
//
// ПОЧЕМУ он отдельный от продуктового `pult mcp-ask` (src/perm/mcpAsk.ts): продуктовая
// заглушка ходит к ДЕМОНУ (рукопожатие с ключом вопросов, метод perm.request), а запись фикстур
// должна работать без демона, брокера и сессий — иначе фикстуры нельзя записать раньше,
// чем написан код, который по ним же тестируется. Здесь решение берётся из очереди,
// заданной переменной окружения.
//
// Окружение:
//   PULT_REC_DECISIONS  JSON-массив решений; i-й вызов `ask` отдаёт i-й элемент.
//                       Элемент {"behavior":"allow","echoInput":true} вернёт updatedInput,
//                       равный полученному input.
//   PULT_REC_TRACE      путь; каждое сообщение JSON-RPC (в обе стороны) дописывается JSONL.
//   PULT_REC_SERVER     имя сервера в serverInfo (по умолчанию pult).

import { appendFileSync } from 'node:fs'

const TRACE = process.env.PULT_REC_TRACE || ''
const SERVER_NAME = process.env.PULT_REC_SERVER || 'pult'
let decisions = []
try { decisions = JSON.parse(process.env.PULT_REC_DECISIONS || '[]') } catch { decisions = [] }
let n = 0

const PROTOCOL_VERSION = '2025-06-18'

const ASK_TOOL = {
  name: 'ask',
  description: 'Pult permission prompt. Returns {"behavior":"allow","updatedInput":{...}} or {"behavior":"deny","message":"..."}.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Name of the tool asking for permission' },
      input: { type: 'object', description: 'The input the tool was called with' },
      tool_use_id: { type: 'string', description: 'Id of the tool_use block' },
    },
    required: ['tool_name', 'input'],
    additionalProperties: true,
  },
}

function trace(dir, msg) {
  if (!TRACE) return
  try { appendFileSync(TRACE, JSON.stringify({ dir, msg }) + '\n') } catch { /* трассировка необязательна */ }
}

function write(msg) {
  trace('out', msg)
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function decide(args) {
  const d = decisions[n++] || { behavior: 'deny', message: 'pult recorder: решения в очереди кончились' }
  if (d.behavior === 'allow' && d.echoInput) return { behavior: 'allow', updatedInput: args.input || {} }
  return d
}

function handle(msg) {
  const { id, method, params } = msg
  if (id === undefined || id === null) return
  if (method === 'initialize') {
    write({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: '0.0.1' },
      },
    })
    return
  }
  if (method === 'tools/list') { write({ jsonrpc: '2.0', id, result: { tools: [ASK_TOOL] } }); return }
  if (method === 'ping') { write({ jsonrpc: '2.0', id, result: {} }); return }
  if (method === 'tools/call') {
    const a = (params && params.arguments) || {}
    if ((params && params.name) !== ASK_TOOL.name) {
      write({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params && params.name}` } })
      return
    }
    const decision = decide(a)
    write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }], isError: false } })
    return
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      continue
    }
    trace('in', msg)
    handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
