// `pult mcp-ask` — stdio-MCP-сервер с ОДНИМ инструментом `ask`.
//
// ГДЕ ОН СТОИТ В ЦЕПОЧКЕ:
//   claude --permission-prompt-tool mcp__pult__ask
//     └─ запускает ЭТОТ процесс по --mcp-config и зовёт его инструмент `ask`
//          └─ он идёт по unix-сокету к демону (рукопожатие КЛЮЧОМ ВОПРОСОВ, client: "mcp-ask")
//               └─ демон кладёт вопрос брокеру и отвечает решением человека
//
// Написан руками, без SDK: транспорт stdio в MCP — это JSON-RPC 2.0 построчно, и тащить ради
// него зависимость в пакет с НОЛЁМ рантайм-зависимостей незачем. Форма проверена на настоящем
// `claude` 2.1.278 — см. test/fixtures/claude/04-permission-mcp-trace.jsonl.
//
// ГЛАВНОЕ ПРАВИЛО — ОТКАЗ ПО УМОЛЧАНИЮ (инвариант 5). Демон не поднят, ключа нет или он не подошёл, сокет
// оборвался посреди вопроса, ответ пришёл кривой — во всех случаях `{"behavior":"deny"}`.
// Недоступный хозяин НЕ означает «разрешаю».
//
// PULT_HOME (только путь к сокету) и PULT_ASK_KEY берутся из окружения, которое задаёт сам Пульт в файле
// --mcp-config: своего окружения у этого процесса нет — его запускает `claude`.
//
// 0.3.7: токен хозяина (PULT_HOME/run/token) заглушка НЕ читает. Её право — ключ вопросов (src/perm/askKeys.ts):
// демон выдаёт его на каждый процесс `claude` и пускает с ним только `perm.request` своей сессии.

import net from 'node:net'
import type { PultPaths } from '../core/paths.js'
import { createLineSplitter, encodeLine } from '../core/ndjson.js'
import { PROTOCOL_VERSION } from '../core/rpc.js'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const ASK_TOOL_NAME = 'ask'

/** Схема входа, измеренная на настоящем вызове (DELTA v0.5 §2). */
export const ASK_TOOL = {
  name: ASK_TOOL_NAME,
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
} as const

export interface AskDecision {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: Record<string, unknown>
}

export type AskFn = (args: Record<string, unknown>) => Promise<AskDecision>

/**
 * Спросить демона. Одно короткое соединение на вопрос: так мёртвый демон виден сразу, а не
 * через зависшую сессию, и заглушка не хранит состояния между вопросами.
 */
export function askDaemon(
  paths: Pick<PultPaths, 'sock'>,
  sessionName: string,
  askKey: string | undefined,
  args: Record<string, unknown>,
  timeoutMs = 900_000,
): Promise<AskDecision> {
  return new Promise<AskDecision>((resolve) => {
    const deny = (why: string): void => resolve({ behavior: 'deny', message: `pult: ${why}` })
    // Нет ключа — спросить не у кого: заглушка запущена не Пультом (или старым демоном). Отказ, а не токен с диска.
    if (!askKey) { deny('нет ключа вопросов (PULT_ASK_KEY) — заглушку запускает только демон Пульта'); return }

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* уже мёртв */ }
      fn()
    }
    const timer = setTimeout(() => finish(() => deny(`демон не ответил за ${timeoutMs} мс`)), timeoutMs)

    const socket = net.connect(paths.sock)
    const splitter = createLineSplitter()
    let authed = false

    socket.on('connect', () => {
      socket.write(encodeLine({ type: 'hello', ask: askKey, client: 'mcp-ask', protocol: PROTOCOL_VERSION }))
    })
    socket.on('data', (chunk: Buffer) => {
      let lines: string[]
      try { lines = splitter.push(chunk) } catch { finish(() => deny('демон прислал мусор')); return }
      for (const line of lines) {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) as Record<string, unknown> } catch { continue }
        if (msg['type'] === 'error') { finish(() => deny(`рукопожатие отвергнуто: ${String(msg['code'])}`)); return }
        if (msg['type'] === 'hello_ok') {
          authed = true
          socket.write(encodeLine({
            id: 1,
            method: 'perm.request',
            params: { sessionId: sessionName, toolName: args['tool_name'], toolUseId: args['tool_use_id'], input: args['input'] },
          }))
          continue
        }
        if (msg['id'] !== 1) continue
        if (msg['error']) {
          const e = msg['error'] as { code?: unknown; message?: unknown }
          finish(() => deny(`демон отказал: ${String(e.code ?? 'ошибка')}`))
          return
        }
        const result = msg['result'] as { behavior?: unknown; message?: unknown; updatedInput?: unknown } | null
        if (!result || (result.behavior !== 'allow' && result.behavior !== 'deny')) {
          finish(() => deny('демон не вернул решения'))
          return
        }
        finish(() => resolve({
          behavior: result.behavior as 'allow' | 'deny',
          ...(typeof result.message === 'string' ? { message: result.message } : {}),
          ...(result.updatedInput && typeof result.updatedInput === 'object'
            ? { updatedInput: result.updatedInput as Record<string, unknown> }
            : {}),
        }))
        return
      }
    })
    socket.on('error', (e: NodeJS.ErrnoException) => {
      finish(() => deny(`сокет демона недоступен (${e.code ?? e.message})`))
    })
    socket.on('close', () => {
      finish(() => deny(authed ? 'демон закрыл соединение до ответа' : 'демон закрыл соединение на рукопожатии'))
    })
  })
}

export interface McpServerIo {
  read(onLine: (line: string) => void): void
  write(line: string): void
  onEnd(fn: () => void): void
}

/** Чистый цикл JSON-RPC: ввод-вывод и способ спросить хозяина инъецируются — тест их подменяет. */
export function runMcpAsk(io: McpServerIo, ask: AskFn): void {
  const send = (msg: unknown): void => io.write(JSON.stringify(msg) + '\n')

  const handle = async (msg: Record<string, unknown>): Promise<void> => {
    const id = msg['id']
    const method = msg['method']
    // Уведомления (`notifications/initialized`) идут без id — отвечать на них нельзя.
    if (id === undefined || id === null) return

    if (method === 'initialize') {
      const params = (msg['params'] ?? {}) as Record<string, unknown>
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'pult', version: '0.0.1' },
        },
      })
      return
    }
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: [ASK_TOOL] } }); return }
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return }
    if (method === 'tools/call') {
      const params = (msg['params'] ?? {}) as Record<string, unknown>
      if (params['name'] !== ASK_TOOL_NAME) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${String(params['name'])}` } })
        return
      }
      const args = (params['arguments'] ?? {}) as Record<string, unknown>
      let decision: AskDecision
      try {
        decision = await ask(args)
      } catch (e) {
        decision = { behavior: 'deny', message: `pult: ${String((e as Error).message).slice(0, 160)}` }
      }
      if (!decision || (decision.behavior !== 'allow' && decision.behavior !== 'deny')) {
        decision = { behavior: 'deny', message: 'pult: решение не получено' }
      }
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }], isError: false } })
      return
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } })
  }

  io.read((line) => {
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('не объект')
      msg = parsed as Record<string, unknown>
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    void handle(msg)
  })
}

/** Ввод-вывод настоящего процесса: stdin/stdout построчно. */
export function stdioIo(): McpServerIo {
  const splitter = createLineSplitter()
  return {
    read(onLine) {
      process.stdin.on('data', (chunk: Buffer) => {
        let lines: string[]
        try { lines = splitter.push(chunk) } catch { return }
        for (const line of lines) onLine(line)
      })
    },
    write(line) { process.stdout.write(line) },
    onEnd(fn) { process.stdin.on('end', fn) },
  }
}
