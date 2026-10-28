#!/usr/bin/env node
// fake-codex-scripted.mjs — ВТОРОЙ фальшивый `codex app-server`, программируемый.
//
// Зачем второй, когда есть fake-codex-app-server.mjs: тот проигрывает ЗАПИСАННЫЕ фикстуры и
// поэтому честен в форме сообщений, но он не умеет того, чего в записи нет и быть не может —
// сервера, который переиспользует id живого запроса, шлёт запрос по чужому треду или просит
// то, чего Пульт не умеет. Такие случаи придумал взломщик при разборе PR #5, и проверять их
// надо ровно так: вручную собранным пиром с жёстко заданными id.
//
// Настройка — `<cwd>/.pult-fake-scripted.json` (cwd общего процесса = PULT_HOME):
//   { "logOut": "/путь/log.jsonl", "handshakeDelayMs": 0,
//     "threadSandbox": {...},   M8f: объект `sandbox` в ответе thread/start|resume (иначе — по режиму запроса)
//     "configRead": {...} }     M8f: `config` в ответе config/read (иначе — ошибка «не умеет»)
//
// Сценарий выбирается меткой `[[имя]]` в реплике хода:
//   dup-id-a / dup-id-b        два запроса разрешения с ОДНИМ id 9001 (разные словари решений)
//   ghost-approval             запрос разрешения по треду, которого нет ни у кого
//   no-avail                   запрос без `availableDecisions` вовсе
//   file-change                СИНТЕТИЧЕСКИЙ `item/fileChange/requestApproval` — поля строго по
//                              схеме, БЕЗ `availableDecisions` (его там нет)
//   leaky-limit                снимок лимитов с секретами в свободных полях + лимитная ошибка
//   permissions-request        `item/permissions/requestApproval` — Пульт его не умеет
//   tool-user-input            `item/tool/requestUserInput` — не умеет
//   mcp-elicitation            `mcpServer/elicitation/request` — не умеет
//   mcp-tool-approval[-bare|-denied]  О3: вопрос «вызвать инструмент браузера?» (`mcpServer/elicitation/request`,
//                              `_meta.codex_approval_kind = "mcp_tool_call"`) — в форме живого хода codex 0.162
//   approval-custom            M8d: запрос разрешения из настройки `approval: {method, params}` — тест собирает
//                              любую форму (availableDecisions, поправки execpolicy и сети); id 9020, 9021, …
//                              (у настоящего сервера id не повторяются, и клиент дважды на один id не отвечает)
//   net-dead                   три `error` с `willRetry: true` подряд (сеть умерла)
//   usage-limit                `error` с `codexErrorInfo: "usageLimitExceeded"`
//   hang                       ход, который сам никогда не кончится
//   reasoning                  0.3.5, фаза хода: элемент `reasoning` и 200 `summaryTextDelta` (в одной — «секрет»
//                              sk-ant-…), пауза; `commandExecution` (пауза); дельты ответа; конец. Формы — по схеме
//                              0.163 (ReasoningSummaryTextDeltaNotification), записи живого хода с размышлениями нет
//   background[-lost]          28.10.2026: ход заводит субагента и команду и кончается, не дождавшись их (как живой
//                              Codex): после `turn/completed` — сообщение и `subAgentActivity completed` субагента,
//                              `outputDelta` и `item/completed` команды (паузы `bgPauseMs`). `-lost` — команда так и
//                              не кончается (конец потерян). Формы — как в журнале живого хода
//   simple                     обычный ход с ответом «OK»
//
// Запросы разрешений он ЖДЁТ: ответ клиента логируется, и ход продолжается только после него
// (кроме dup-id, где вся суть в том, что ответ приходит позже).

import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let cfg = {}
try { cfg = JSON.parse(readFileSync(join(process.cwd(), '.pult-fake-scripted.json'), 'utf8')) } catch { cfg = {} }
const LOG = cfg.logOut ?? null
const log = (o) => { if (LOG) { try { appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + '\n') } catch { /* тест увидит пропуск */ } } }
log({ ev: 'boot', argv: process.argv.slice(2), cwd: process.cwd(), env: process.env })

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let seq = 0
const uid = (p) => `${p}-${process.pid}-${++seq}`
const threads = new Map()
const answers = new Map()
let customAsks = 0

const replyOk = (id, result) => out({ jsonrpc: '2.0', id, result })
const sandboxOf = (mode) => cfg.threadSandbox ?? { type: mode === 'read-only' ? 'readOnly' : mode === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite', networkAccess: false }
const replyErr = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } })

/** Послать запрос серверу→клиенту и дождаться ответа (любого). */
function ask(id, method, params) {
  out({ jsonrpc: '2.0', id, method, params })
  return new Promise((res) => { answers.set(id, res) })
}

async function runTurn(scenario, threadId, turnId) {
  const finish = async (status = 'completed') => {
    out({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text: 'OK', phase: 'final_answer' } },
    })
    out({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status, error: null, startedAt: 1, completedAt: 2, durationMs: 1 } },
    })
  }

  switch (scenario) {
    case 'dup-id-a':
    case 'dup-id-b': {
      // ОДИН И ТОТ ЖЕ id на два живых запроса — в этом вся проверка.
      const method = scenario === 'dup-id-a' ? 'applyPatchApproval' : 'item/commandExecution/requestApproval'
      const params = scenario === 'dup-id-a'
        ? { threadId, itemId: 'item-a', path: '/tmp/patch-a.diff', availableDecisions: ['approved', 'denied', 'abort'] }
        : { threadId, itemId: 'item-b', command: 'echo hi', availableDecisions: ['accept', 'decline', 'cancel'] }
      out({ jsonrpc: '2.0', id: 9001, method, params })
      await sleep(400)
      await finish()
      return
    }
    case 'ghost-approval': {
      await ask(9002, 'item/commandExecution/requestApproval', {
        threadId: `${threadId}-НИЧЕЙ`, itemId: 'ghost', command: 'echo ghost', availableDecisions: ['accept', 'decline', 'cancel'],
      })
      await finish()
      return
    }
    case 'no-avail': {
      await ask(9003, 'item/commandExecution/requestApproval', { threadId, itemId: 'item-c', command: 'echo c' })
      await finish()
      return
    }
    case 'file-change': {
      // СИНТЕТИКА: живой записи `item/fileChange/requestApproval` у нас нет (спайк её не
      // поймал), поэтому поля взяты ДОСЛОВНО из схемы протокола 0.155 —
      // `FileChangeRequestApprovalParams`: grantRoot, itemId, reason, startedAtMs, threadId,
      // turnId, и БОЛЬШЕ НИЧЕГО.
      //
      // Раньше тут лежали `availableDecisions` и `changes` — ни того, ни другого в схеме
      // нет. Выдуманный `availableDecisions` скрывал настоящую дыру: на правке файла сервер
      // списка решений не присылает ВООБЩЕ, а адаптер только из него и выбирал «да» — то
      // есть `pult perm approve` на правке файла молча уезжал `decline`. Фейк, который
      // присылает поле, которого не бывает, — это тест, проверяющий не тот протокол.
      await ask(9004, 'item/fileChange/requestApproval', {
        threadId,
        turnId,
        itemId: 'fc-1',
        startedAtMs: 1790000000000,
        reason: 'Запись вне рабочей папки: /Users/человек/проект/notes.md',
        grantRoot: '/Users/человек/проект',
      })
      await finish()
      return
    }
    case 'approval-custom': {
      const a = cfg.approval ?? {}
      await ask(9020 + customAsks++, a.method ?? 'item/commandExecution/requestApproval', { threadId, turnId, itemId: 'ac-1', ...(a.params ?? {}) })
      await finish()
      return
    }
    case 'leaky-limit': {
      out({
        jsonrpc: '2.0',
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            limitId: 'codex',
            limitName: 'leaked-secret@example.com',
            // 32 hex-символа — форма, которую `redact()` ловит generic-токен-правилом
            // (`[0-9a-f]{32,}`), а НЕ форма `sk-ant-…`: страж утечек репозитория (ci-leakguard,
            // правило anthropic-key) требует 20+ символов после `sk-ant-` и ловил прежний
            // фальшивый ключ как настоящий, хотя это тестовая заглушка.
            normalModelSlug: 'deadbeefdeadbeefdeadbeefdeadbeef',
            primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 },
            rateLimitReachedType: null,
          },
        },
      })
      await sleep(20)
      out({
        jsonrpc: '2.0',
        method: 'error',
        params: { threadId, turnId, willRetry: false, error: { message: 'hit your usage limit', codexErrorInfo: 'usageLimitExceeded' } },
      })
      return
    }
    case 'permissions-request': {
      await ask(9010, 'item/permissions/requestApproval', {
        threadId, turnId, itemId: 'p-1', startedAtMs: 1, cwd: '/tmp', permissions: { network: true },
      })
      await finish()
      return
    }
    case 'tool-user-input': {
      await ask(9011, 'item/tool/requestUserInput', {
        threadId, turnId, itemId: 'q-1', isBlocking: true, questions: [{ id: 'q1', header: 'Порт', question: 'Какой порт?', options: null }],
      })
      await finish()
      return
    }
    case 'mcp-elicitation': {
      await ask(9012, 'mcpServer/elicitation/request', { threadId, turnId, serverName: 'demo', message: 'нужен токен' })
      await finish()
      return
    }
    case 'mcp-tool-approval':
    case 'mcp-tool-approval-bare':
    case 'mcp-tool-approval-denied': {
      // Форма — дословно с живого хода codex 0.162 (15.10.2026, scripts/smoke-browser.mjs --codex): имени
      // инструмента в `_meta` нет, оно в `message`; аргументы — `tool_params`. `-bare` — без `tool_params`
      // (аргументы берутся из `item/started`), `-denied` — запрещённый инструмент.
      const tool = scenario === 'mcp-tool-approval-denied' ? 'browser_run_code_unsafe' : 'browser_navigate'
      const args = { url: 'http://127.0.0.1:1/' }
      out({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, item: { type: 'mcpToolCall', id: `mcp-${turnId}`, server: 'pult_browser', tool, arguments: args, status: 'inProgress' } } })
      // id — свой на каждый вопрос, как у настоящего сервера (клиент Пульта отвечает на id один раз за процесс).
      await ask(9100 + (++seq), 'mcpServer/elicitation/request', {
        threadId, turnId, serverName: 'pult_browser', mode: 'form', message: `Allow the pult_browser MCP server to run tool "${tool}"?`,
        requestedSchema: { type: 'object', properties: {} },
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_description: 'Navigate to a URL',
          ...(scenario === 'mcp-tool-approval-bare' ? {} : { tool_params: args, tool_params_display: [{ name: 'url', value: args.url, display_name: 'url' }] }) },
      })
      out({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, item: { type: 'mcpToolCall', id: `mcp-${turnId}`, server: 'pult_browser', tool, arguments: args, status: 'completed',
        result: { content: [{ type: 'text', text: '### Page' }, { type: 'image', mimeType: 'image/png', data: 'A'.repeat(200_000) }] } } } })
      await finish()
      return
    }
    case 'net-dead': {
      for (let i = 2; i <= 4; i++) {
        out({
          jsonrpc: '2.0',
          method: 'error',
          params: {
            threadId, turnId, willRetry: true,
            error: { message: `Reconnecting... ${i}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: 'stream disconnected before completion: Connection refused (os error 61)' },
          },
        })
        await sleep(15)
      }
      return
    }
    case 'usage-limit': {
      out({
        jsonrpc: '2.0',
        method: 'error',
        params: {
          threadId, turnId, willRetry: false,
          error: { message: 'You’ve hit your usage limit. Try again at Sep 22nd, 2026 12:23 AM.', codexErrorInfo: 'usageLimitExceeded' },
        },
      })
      return
    }
    case 'hang':
      return
    case 'reasoning': {
      const pause = Number(cfg.phasePauseMs ?? 400)
      const rid = `rs-${turnId}`
      out({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, item: { type: 'reasoning', id: rid, summary: [], content: [] } } })
      out({ jsonrpc: '2.0', method: 'item/reasoning/summaryPartAdded', params: { threadId, turnId, itemId: rid, summaryIndex: 0 } })
      for (let i = 0; i < 200; i++) {
        const delta = i === 7 ? ` ключ ${'sk-'}ant-api03-${'A'.repeat(40)} ` : `шаг ${i}. `
        out({ jsonrpc: '2.0', method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId, itemId: rid, summaryIndex: 0, delta } })
      }
      out({ jsonrpc: '2.0', method: 'item/reasoning/summaryPartAdded', params: { threadId, turnId, itemId: rid, summaryIndex: 1 } })
      out({ jsonrpc: '2.0', method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId, itemId: rid, summaryIndex: 1, delta: 'ИТОГ-РАЗМЫШЛЕНИЙ' } })
      await sleep(pause)
      out({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, item: { type: 'reasoning', id: rid, summary: [], content: [] } } })
      const cid = `cmd-${turnId}`
      out({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, item: { type: 'commandExecution', id: cid, command: 'npm test', cwd: '/tmp', status: 'inProgress' } } })
      await sleep(pause)
      out({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', id: cid, command: 'npm test', cwd: '/tmp', status: 'completed', exitCode: 0 } } })
      const mid = `msg-${turnId}`
      out({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, item: { type: 'agentMessage', id: mid, text: '', phase: 'final_answer' } } })
      for (const delta of ['O', 'K']) out({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: mid, delta } })
      await sleep(pause)
      await finish()
      return
    }
    case 'background':
    case 'background-lost': {
      const pause = Number(cfg.bgPauseMs ?? 300)
      const child = uid('sc-child')
      const spawnId = `call-${turnId}`
      const cid = `exec-${turnId}`
      out({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, item: { type: 'subAgentActivity', id: spawnId, kind: 'started', agentThreadId: child, agentPath: '/root/checker' } } })
      out({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, item: { type: 'commandExecution', id: cid, command: "/bin/zsh -lc 'npm test'", cwd: '/tmp', status: 'inProgress' } } })
      await finish()
      await sleep(pause)
      out({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: child, turnId: uid('sc-child-turn'), item: { type: 'agentMessage', id: uid('msg'), text: 'проверено', phase: 'final_answer' } } })
      out({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, item: { type: 'subAgentActivity', id: uid('act'), kind: 'completed', agentThreadId: child, agentPath: '/root/checker' } } })
      if (scenario === 'background-lost') return
      await sleep(pause)
      out({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: { threadId, turnId, itemId: cid, delta: 'ok\n' } })
      out({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', id: cid, command: "/bin/zsh -lc 'npm test'", cwd: '/tmp', status: 'completed', exitCode: 0 } } })
      return
    }
    default:
      await sleep(30)
      await finish()
  }
}

async function onRequest(id, method, params) {
  switch (method) {
    case 'initialize':
      if (cfg.handshakeDelayMs) await sleep(Number(cfg.handshakeDelayMs))
      replyOk(id, { userAgent: 'pult-scripted/0.155.0', codexHome: '/фальшивый/.codex', platformFamily: 'unix', platformOs: 'macos' })
      return
    case 'thread/start': {
      const threadId = uid('sc-thread')
      threads.set(threadId, { cwd: params.cwd, turn: null })
      replyOk(id, {
        thread: { id: threadId, cwd: params.cwd, path: `/фальшивый/rollout-${threadId}.jsonl`, status: { type: 'idle' }, turns: [] },
        model: params.model ?? 'gpt-6-astra', modelProvider: 'openai', cwd: params.cwd,
        approvalPolicy: params.approvalPolicy ?? 'never', sandbox: sandboxOf(params.sandbox), reasoningEffort: 'low',
      })
      return
    }
    case 'thread/resume': {
      if (!threads.has(params.threadId)) { replyErr(id, -32600, `no rollout found for thread id ${params.threadId}`); return }
      replyOk(id, { thread: { id: params.threadId, cwd: params.cwd, status: { type: 'idle' }, turns: [] }, cwd: params.cwd, initialTurnsPage: { items: [] }, sandbox: sandboxOf(params.sandbox) })
      return
    }
    case 'turn/start': {
      const text = Array.isArray(params.input) ? params.input.map((i) => i.text ?? '').join(' ') : ''
      const marked = /\[\[([a-z-]+)\]\]/.exec(text)
      const scenario = marked ? marked[1] : 'simple'
      const turnId = uid('sc-turn')
      const t = threads.get(params.threadId)
      if (t) t.turn = turnId
      replyOk(id, { turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } })
      out({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } } })
      void runTurn(scenario, params.threadId, turnId)
      return
    }
    case 'turn/interrupt': {
      const t = threads.get(params.threadId)
      if (!t || t.turn !== params.turnId) { replyErr(id, -32600, 'no active turn to interrupt'); return }
      const turnId = t.turn
      t.turn = null
      replyOk(id, {})
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'interrupted', error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } })
      return
    }
    case 'config/read':
      if (cfg.configRead) replyOk(id, { config: cfg.configRead, origins: {} })
      else replyErr(id, -32601, 'фальшивый сервер не умеет config/read')
      return
    case 'thread/unsubscribe':
      replyOk(id, { status: threads.has(params.threadId) ? 'unsubscribed' : 'notLoaded' })
      return
    case 'account/rateLimits/read':
      replyOk(id, { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1 }, secondary: null, rateLimitReachedType: null } })
      return
    default:
      replyErr(id, -32601, `фальшивый сервер не умеет ${method}`)
  }
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
    try { msg = JSON.parse(line) } catch { continue }
    log({ ev: 'client', msg })
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = answers.get(msg.id)
      if (waiter) { answers.delete(msg.id); waiter(msg) }
      continue
    }
    if (msg.method === 'initialized') continue
    if (msg.id === undefined) continue
    void onRequest(msg.id, msg.method, msg.params ?? {})
  }
})

process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
setTimeout(() => process.exit(0), 120_000)
