#!/usr/bin/env node
// Заглушка S9: stdio-MCP с одним инструментом `ask`, без хозяина. Пишет каждое сообщение в трассу
// (S9_TRACE) и отвечает allow. Подсказки `permission_suggestions` возвращает в `updatedPermissions`,
// но ВСЕГДА с `destination: "localSettings"` — правило не имеет права лечь в настройки владельца.

import { appendFileSync } from 'node:fs'

const TRACE = process.env.S9_TRACE || ''
// S12: инструменты из S9_DENY (через запятую) получают отказ — спайк видит, что вопрос пришёл, и ничего не исполняется.
const DENY = new Set((process.env.S9_DENY || '').split(',').filter(Boolean))
const trace = (dir, msg) => { if (TRACE) appendFileSync(TRACE, JSON.stringify({ t: new Date().toISOString(), dir, msg }) + '\n') }
const send = (msg) => { trace('out', msg); process.stdout.write(JSON.stringify(msg) + '\n') }

const TOOL = {
  name: 'ask',
  description: 'Permission prompt. Returns {"behavior":"allow","updatedInput":{...}} or {"behavior":"deny","message":"..."}.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'], additionalProperties: true },
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    trace('in', msg)
    if (msg.id === undefined || msg.id === null) continue
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'pultask', version: '0.0.1' } } })
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } })
    } else if (msg.method === 'tools/call') {
      const args = msg.params?.arguments ?? {}
      // S9_CRAFT=1: подсказок CLI не прислал (ходы 1–3) — проверяем, исполнит ли он правило, собранное
      // хозяином сам: Bash(<ровно эта команда>) в localSettings.
      const sugg = Array.isArray(args.permission_suggestions) ? args.permission_suggestions
        : process.env.S9_CRAFT === '1' && args.tool_name === 'Bash'
          ? [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: String(args.input?.command ?? '') }], behavior: 'allow', destination: 'localSettings' }]
          : null
      const decision = DENY.has(args.tool_name) ? { behavior: 'deny', message: 's9-stub: denied' } : {
        behavior: 'allow',
        updatedInput: args.input ?? {},
        ...(sugg ? { updatedPermissions: sugg.map((s) => ({ ...s, destination: 'localSettings' })) } : {}),
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }], isError: false } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
