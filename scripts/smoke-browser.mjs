#!/usr/bin/env node
// smoke-browser.mjs — дымовой прогон О3 на НАСТОЯЩИХ Playwright MCP, Chrome и codex.
//
//   npm run smoke:browser                                       # без ходов модели
//   npm run smoke:browser -- --claude                           # + один ход haiku через Inbox
//   npm run smoke:browser -- --codex                            # + один ход codex: форма вопроса о вызове
//
// В CI не входит и входить не должен: нужна сеть до registry.npmjs.org, Google Chrome в /Applications,
// codex (ChatGPT.app) и — для --claude — залогиненный claude и квота. Запускается руками при приёмке.
//
// ЧТО ПРОВЕРЯЕТСЯ:
//   1. `pult browser install` ставит прибитый @playwright/mcp в PULT_HOME/mcp настоящим npm (без install-
//      скриптов и без скачивания браузеров Playwright); повтор — «уже стоит»;
//   2. Playwright MCP с аргументами Пульта (свой профиль, скачивания, --headless) на системном Chrome:
//      initialize → tools/list → browser_navigate → browser_snapshot → клик по ссылке-скачиванию — файл
//      ложится в PULT_HOME/browser/<сессия>/downloads, профиль — в …/profile;
//   3. codex app-server: `thread/start` с `config.mcp_servers.browser` (как у адаптера) — сервер браузера
//      поднят у треда (`mcpServerStatus/list` по треду, без единого хода модели);
//   4. (--claude) сессия Claude с браузером: вызов `mcp__pult_browser__*` приходит в Inbox, после «разрешить»
//      модель читает страницу, чтение снимка из папки скачиваний вопроса не требует. Один ход haiku, усилие low;
//   5. (--codex) один ход codex (усилие low) по сырому протоколу: каким запросом Codex спрашивает про вызов
//      инструмента (печатается целиком), разбирает ли его код Пульта (`isToolApproval`, `toolApprovalCall`);
//      затем на том же загруженном треде — применяется ли смена набора серверов при `thread/unsubscribe` +
//      `thread/resume` (`mcpServerStatus/list` до и после, без ходов модели).
//
// PULT_HOME и папки — временные (короткий путь: у unix-сокета предел 104 байта), настоящий ~/.pult не
// трогается; ~/.claude.json и ~/.codex/config.toml только читаются самими CLI.

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig } from '../dist/core/config.js'
import { layout } from '../dist/core/paths.js'
import { checkNetwork, netLine } from '../dist/env/net.js'
import { locateToolPath } from '../dist/env/locate.js'
import { BROWSER_SERVER_NAME, browserCli, browserCodexSpec, browserServerSpec, DENIED_BROWSER_TOOLS, ensureBrowserDirs, findChrome } from '../dist/mcp/browser.js'
import { codexNetworkEnv, isToolApproval, toolApprovalCall } from '../dist/adapters/codex/adapter.js'
import { buildChildEnv } from '../dist/env/allowlist.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'dist', 'cli', 'main.js')
const CLAUDE_TURN = process.argv.includes('--claude')
const CODEX_TURN = process.argv.includes('--codex')

const home = mkdtempSync(join(tmpdir(), 'pb-'))
const work = mkdtempSync(join(tmpdir(), 'pult-browser-'))
const paths = layout(home)
let failed = 0
let checks = 0
const say = (s) => console.log(s)
const expect = (cond, what, extra = '') => {
  checks += 1
  if (cond) return true
  failed += 1
  say(`    ПРОВАЛ: ${what}${extra ? ` — ${String(extra).slice(0, 600)}` : ''}`)
  return false
}

function pult(args, timeoutMs = 300_000) {
  const t0 = Date.now()
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, PULT_HOME: home }, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '', ms: Date.now() - t0 }
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), ms: Date.now() - t0 }
  }
}

/** Построчный JSON-RPC по stdio: запросы с id, ответы по id; запросы сервера → `onRequest`. */
function rpcChild(cmd, args, opts = {}, hooks = {}) {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts })
  let buf = ''
  let id = 0
  const waiters = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.id !== undefined && m.method) {
        const answer = hooks.onRequest?.(m)
        child.stdin.write(JSON.stringify(answer !== undefined ? { jsonrpc: '2.0', id: m.id, result: answer } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'smoke' } }) + '\n')
        continue
      }
      if (m.method && m.id === undefined) hooks.onNotification?.(m)
      if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) }
    }
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const req = (method, params, ms = 60_000) => new Promise((res, rej) => {
    const my = ++id
    const t = setTimeout(() => { waiters.delete(my); rej(new Error(`${method}: нет ответа за ${ms} мс; stderr: ${stderr.slice(-300)}`)) }, ms)
    waiters.set(my, (m) => { clearTimeout(t); res(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n')
  })
  const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const close = () => { try { child.stdin.end() } catch { /* закрыт */ } try { child.kill('SIGTERM') } catch { /* ушёл */ } }
  return { child, req, notify, close }
}

const textOf = (r) => (r?.result?.content ?? []).map((c) => c.text ?? '').join('\n')

try {
  say(`PULT_HOME=${home}`)
  const chrome = findChrome()
  say(`Chrome: ${chrome ?? 'НЕ НАЙДЕН'}`)
  expect(chrome !== null, 'Google Chrome не найден — браузеру агента нечем работать')

  // --- 1. установка ------------------------------------------------------------
  const inst = pult(['browser', 'install'])
  say(`1. pult browser install: код ${inst.code}, ${inst.ms} мс — ${inst.stdout.trim() || inst.stderr.trim()}`)
  expect(inst.code === 0, 'установка не удалась', inst.stderr)
  const again = pult(['browser', 'install'])
  say(`1a. повтор: ${again.stdout.trim()}`)
  expect(/уже стоит/.test(again.stdout), 'повтор должен сказать «уже стоит»', again.stdout)
  const pkgs = readdirSync(join(paths.mcp, readdirSync(paths.mcp)[0] ?? '', 'node_modules')).filter((n) => !n.startsWith('.'))
  say(`1b. пакеты: ${pkgs.join(', ')}; браузеров Playwright не скачано: ${!existsSync(join(home, 'Library', 'Caches', 'ms-playwright')) ? 'да' : 'НЕТ'}`)

  // --- 2. Playwright MCP + Chrome ---------------------------------------------
  const dirs = ensureBrowserDirs(paths, 'smoke')
  const spec = browserServerSpec({ nodeBin: process.execPath, cli: browserCli(paths), dirs, headed: false, chrome })
  say(`2. ${spec.command} ${spec.args.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' ')}`)
  const mcp = rpcChild(spec.command, spec.args, { cwd: work })
  try {
    const init = await mcp.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pult-smoke', version: '1' } })
    mcp.notify('notifications/initialized')
    say(`2a. сервер: ${JSON.stringify(init.result?.serverInfo)}`)
    const tools = (await mcp.req('tools/list', {})).result?.tools ?? []
    say(`2b. инструментов: ${tools.length}: ${tools.map((t) => t.name).join(', ')}`)
    expect(tools.some((t) => t.name === 'browser_navigate'), 'нет browser_navigate')
    // Всё, что исполняет код, должно быть в списке запрета (DENIED_BROWSER_TOOLS).
    const codeTools = tools.filter((t) => /run_code|evaluate|eval\b|script/i.test(t.name)).map((t) => t.name)
    say(`2b'. исполняют код: ${codeTools.join(', ') || 'нет'}; запрещены Пультом: ${DENIED_BROWSER_TOOLS.join(', ')}`)
    expect(codeTools.every((t) => DENIED_BROWSER_TOOLS.includes(t)), 'инструмент, исполняющий код, не в списке запрета', codeTools.join(','))
    const page = 'data:text/html,<h1>Hello Pult</h1><a href="data:text/plain;base64,cHVsdCBzbW9rZQ==" download="pult-smoke.txt">download</a><input type=file>'
    const nav = await mcp.req('tools/call', { name: 'browser_navigate', arguments: { url: page } }, 120_000)
    say(`2c. browser_navigate: ${nav.error ? JSON.stringify(nav.error) : textOf(nav).split('\n').slice(0, 4).join(' | ')}`)
    expect(!nav.error && !nav.result?.isError, 'навигация не удалась', JSON.stringify(nav).slice(0, 400))
    const snap = await mcp.req('tools/call', { name: 'browser_snapshot', arguments: {} })
    const snapText = textOf(snap)
    expect(/Hello Pult/.test(snapText), 'в снимке страницы нет «Hello Pult»', snapText)
    const ref = /link "download" \[ref=(e\d+)\]/.exec(snapText)?.[1]
    say(`2d. снимок: заголовок есть: ${/Hello Pult/.test(snapText) ? 'да' : 'НЕТ'}; ссылка: ${ref ?? 'нет'}`)
    if (ref) {
      const click = await mcp.req('tools/call', { name: 'browser_click', arguments: { element: 'download link', target: ref } }, 60_000)
      say(`2e. browser_click: ${textOf(click).split('\n').slice(0, 2).join(' | ')}`)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && !readdirSync(dirs.downloads).some((f) => f.includes('pult-smoke'))) await new Promise((r) => setTimeout(r, 300))
    }
    const files = readdirSync(dirs.downloads)
    say(`2f. скачивания (${dirs.downloads}): ${files.join(', ') || 'пусто'}`)
    expect(files.some((f) => f.includes('pult-smoke')), 'файл скачивания не лёг в папку сессии')
    say(`2g. профиль (${dirs.profile}): ${readdirSync(dirs.profile).length} записей`)
    expect(readdirSync(dirs.profile).length > 0, 'профиль браузера пуст — --user-data-dir не сработал')
    // Загрузка файла на сайт: корень доступа — папка скачиваний (cwd сервера). /etc/hosts — отказ, свой файл — можно.
    const fileRef = /button "Choose File" \[ref=(e\d+)\]/.exec(snapText)?.[1]
    if (fileRef) {
      await mcp.req('tools/call', { name: 'browser_click', arguments: { element: 'file input', target: fileRef } })
      const bad = textOf(await mcp.req('tools/call', { name: 'browser_file_upload', arguments: { paths: ['/etc/hosts'] } }))
      say(`2h. загрузка /etc/hosts: ${bad.split('\n').slice(0, 2).join(' | ')}`)
      expect(/outside allowed roots/.test(bad), 'загрузку /etc/hosts сервер НЕ отклонил', bad)
      const okFile = join(dirs.downloads, 'pult-smoke.txt')
      const good = textOf(await mcp.req('tools/call', { name: 'browser_file_upload', arguments: { paths: [okFile] } }))
      say(`2i. загрузка файла из папки скачиваний: ${/Error/.test(good) ? 'ОТКАЗ' : 'ок'}`)
      expect(!/Error/.test(good), 'файл из папки скачиваний не загрузился', good)
    } else {
      expect(false, 'на странице нет поля выбора файла')
    }
    await mcp.req('tools/call', { name: 'browser_close', arguments: {} }).catch(() => undefined)
  } finally { mcp.close() }

  // --- 3. codex: браузер в конфиге треда, без хода модели ----------------------
  const codexBin = locateToolPath('codex').path
  const cxStatus = async (cx, threadId) => {
    const st = await cx.req('mcpServerStatus/list', { threadId, serverName: BROWSER_SERVER_NAME }, 30_000)
    return (st.result?.data ?? []).find((x) => x.name === BROWSER_SERVER_NAME) ?? null
  }
  const cxWait = async (cx, threadId, want) => {
    let b = null
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      b = await cxStatus(cx, threadId)
      if (want ? b?.runtimeStatus === 'connected' : b === null) break
      await new Promise((r) => setTimeout(r, 500))
    }
    return b
  }
  const cxServers = () => ({ [BROWSER_SERVER_NAME]: browserCodexSpec({ nodeBin: process.execPath, cli: browserCli(paths), dirs: ensureBrowserDirs(paths, 'smoke-codex'), headed: false, chrome }) })
  if (!codexBin) {
    say('3. codex не найден — шаг пропущен')
  } else {
    const cx = rpcChild(codexBin, ['app-server'], { cwd: work })
    try {
      const init = await cx.req('initialize', { clientInfo: { name: 'pult-smoke', version: '1' } }, 30_000)
      cx.notify('initialized')
      say(`3. codex: ${init.result?.userAgent ?? JSON.stringify(init.error)}`)
      const ts = await cx.req('thread/start', { cwd: work, sandbox: 'workspace-write', approvalPolicy: 'on-request', config: { mcp_servers: cxServers() } }, 60_000)
      expect(!ts.error, 'thread/start с config.mcp_servers отказал', JSON.stringify(ts.error))
      const b = await cxWait(cx, ts.result?.thread?.id, true)
      const names = Object.keys(b?.tools ?? {})
      say(`3a. mcpServerStatus/list по треду: ${BROWSER_SERVER_NAME} ${b?.runtimeStatus ?? 'нет'}, ${names.length} инструментов, ${b?.serverInfo?.name ?? ''} ${b?.serverInfo?.version ?? ''}`)
      expect(b?.runtimeStatus === 'connected', 'сервер браузера у треда codex не поднят')
      const leaked = DENIED_BROWSER_TOOLS.filter((t) => names.includes(t))
      say(`3b. disabled_tools: запрещённых среди инструментов треда — ${leaked.join(', ') || 'нет'}`)
      expect(!leaked.length, 'disabled_tools не спрятал инструменты, исполняющие код', leaked.join(','))
      await cx.req('thread/unsubscribe', { threadId: ts.result?.thread?.id }, 10_000).catch(() => undefined)
    } finally { cx.close() }
  }

  // --- 4. ход Claude с браузером через Inbox -----------------------------------
  if (CLAUDE_TURN) {
    const cfg = defaultConfig()
    const net = await checkNetwork('claude', cfg.network.claude, cfg.guard, { fresh: true })
    say(`4. страж: ${netLine(net)}`)
    if (!net.ok) {
      expect(false, `страж сети не пускает ход: ${net.reason}`)
    } else {
      writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, subagentGraceMs: 4000, autoTitle: false }, null, 2))
      // Страница на localhost с жетоном, которого нет в реплике: ответить, не открыв её, модель не может.
      const token = `PULT-${randomBytes(4).toString('hex').toUpperCase()}`
      const srv = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<h1>${token}</h1>`) })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const url = `http://127.0.0.1:${srv.address().port}/`
      // `--setting-sources user` — НАРОЧНО: так берётся `defaultMode` владельца. Если там `auto`, классификатор
      // Claude разрешает инструменты сам и вопрос до Inbox не доходит — браузер обязан спросить всё равно
      // (правило `permissions.ask: ["mcp__browser"]` в `--settings`, src/mcp/session.ts).
      const start = pult(['agent', 'start', 'b', '--kind', 'claude', '--cwd', work, '--model', 'haiku', '--effort', 'low', '--setting-sources', 'user', '--browser'])
      say(`4a. agent start --browser: код ${start.code} — ${start.stdout.trim().split('\n').join(' | ')}`)
      expect(start.code === 0, 'agent start не отработал', start.stderr)
      const run = pult(['agent', 'prompt', 'b', `Open ${url} with the browser tool browser_navigate and reply with the page heading only.`, '--json'])
      say(`4b. реплика ушла: ${run.stdout.trim()}`)
      const seen = []
      const deadline = Date.now() + 180_000
      for (;;) {
        const st = pult(['agent', 'list', '--json'], 20_000)
        const rec = (JSON.parse(st.stdout || '{"sessions":[]}').sessions ?? []).find((s) => s.name === 'b')
        const list = JSON.parse(pult(['perm', 'list', '--json'], 20_000).stdout || '{"pending":[]}').pending ?? []
        for (const p of list) {
          seen.push(p.toolName)
          // Браузер разрешаем, прочее — нет: прогон проверяет круг Inbox, а не права модели.
          pult(p.toolName.startsWith(`mcp__${BROWSER_SERVER_NAME}__`) ? ['perm', 'approve', p.id] : ['perm', 'deny', p.id, '--reason', 'smoke: только браузер'])
        }
        if (rec && ['idle', 'failed', 'interrupted', 'limited'].includes(rec.lastStatus) && !list.length) break
        if (Date.now() > deadline) break
        await new Promise((r) => setTimeout(r, 700))
      }
      srv.close()
      say(`4c. вопросы в Inbox: ${seen.join(', ') || 'ни одного'}`)
      expect(seen.some((t) => t.startsWith(`mcp__${BROWSER_SERVER_NAME}__`)), `вызов mcp__${BROWSER_SERVER_NAME}__* не пришёл в Inbox`)
      // Чтение снимка из папки скачиваний — без вопроса (permissions.allow Read(//…/downloads/**)).
      expect(!seen.includes('Read'), 'чтение снимка страницы спросило разрешение — правило allow Read не сработало', seen.join(','))
      const tree = pult(['agent', 'tree', 'b'])
      say(`4d. дерево: ${tree.stdout.trim().split('\n').slice(0, 6).join(' | ')}`)
      const read = pult(['agent', 'read', 'b'])
      const answer = read.stdout.trim().split('\n').slice(-3).join(' | ')
      say(`4e. ответ модели: ${answer} (жетон ${token})`)
      expect(read.stdout.includes(token), 'модель не прочитала заголовок страницы (жетона нет в ответе)', answer)
    }
  }

  // --- 5. ход Codex: форма вопроса о вызове инструмента, переподключение треда --------
  if (CODEX_TURN && codexBin) {
    const cfg = defaultConfig()
    const net = await checkNetwork('codex', cfg.network.codex, cfg.guard, { fresh: true })
    say(`5. страж: ${netLine(net)}`)
    if (!net.ok) {
      expect(false, `страж сети не пускает ход codex: ${net.reason}`)
    } else {
      const token = `PULT-${randomBytes(4).toString('hex').toUpperCase()}`
      const srv = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<h1>${token}</h1>`) })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const url = `http://127.0.0.1:${srv.address().port}/`
      const started = new Map()
      const requests = []
      let reply = ''
      let done = null
      const finished = new Promise((r) => { done = r })
      const pending = (threadId, server, tool) => {
        const list = [...started.values()].filter((x) => x.threadId === threadId && x.server === server && (tool === null || x.tool === tool))
        const x = list[list.length - 1]
        return x ? { tool: x.tool, args: x.args } : null
      }
      const cx = rpcChild(codexBin, ['app-server'], { cwd: work, env: buildChildEnv(process.env, { network: codexNetworkEnv(net) }) }, {
        onRequest: (m) => {
          requests.push(m)
          say(`5r. запрос сервера: ${m.method} ${JSON.stringify(m.params).slice(0, 1500)}`)
          if (m.method === 'mcpServer/elicitation/request' && isToolApproval(m.params)) {
            const call = toolApprovalCall(m.params, pending)
            say(`5p. разбор Пульта: isToolApproval=да, инструмент mcp__${call.server}__${call.tool}, аргументы ${call.args === null ? 'НЕ найдены' : JSON.stringify(call.args)}`)
            return { action: 'accept', content: {} }
          }
          if (m.method === 'mcpServer/elicitation/request') return { action: 'decline' }
          return { decision: 'decline' }
        },
        onNotification: (m) => {
          const item = m.params?.item
          if (m.method === 'item/started' && item?.type === 'mcpToolCall') started.set(item.id, { threadId: m.params.threadId, server: item.server, tool: item.tool, args: item.arguments })
          if (m.method === 'item/completed' && item?.type === 'mcpToolCall') say(`5m. mcpToolCall ${item.server}/${item.tool} ${item.status}, аргументы ${JSON.stringify(item.arguments)}`)
          if (m.method === 'item/completed' && item?.type === 'agentMessage') reply += item.text ?? ''
          if (m.method === 'turn/completed') done(m.params?.turn?.status)
        },
      })
      try {
        const init = await cx.req('initialize', { clientInfo: { name: 'pult-smoke', version: '1' } }, 30_000)
        cx.notify('initialized')
        say(`5a. codex: ${init.result?.userAgent ?? JSON.stringify(init.error)}`)
        const ts = await cx.req('thread/start', { cwd: work, sandbox: 'workspace-write', approvalPolicy: 'on-request', config: { mcp_servers: cxServers() } }, 60_000)
        const threadId = ts.result?.thread?.id
        expect((await cxWait(cx, threadId, true))?.runtimeStatus === 'connected', 'браузер у треда не поднят перед ходом')
        const t = await cx.req('turn/start', { threadId, effort: 'low', input: [{ type: 'text', text: `Open ${url} with the ${BROWSER_SERVER_NAME} browser_navigate tool and reply with the page heading only.` }] }, 60_000)
        expect(!t.error, 'turn/start отказал', JSON.stringify(t.error))
        const status = await Promise.race([finished, new Promise((r) => setTimeout(() => r('timeout'), 240_000))])
        srv.close()
        say(`5b. ход: ${status}; ответ «${reply.trim().slice(0, 200)}» (жетон ${token})`)
        const asks = requests.filter((m) => m.method === 'mcpServer/elicitation/request')
        expect(asks.length > 0, 'Codex НЕ спросил разрешения на вызов браузера (default_tools_approval_mode=prompt)')
        expect(asks.every((m) => isToolApproval(m.params)), 'вопрос Codex не распознан isToolApproval', JSON.stringify(asks.map((m) => m.params)).slice(0, 600))
        expect(reply.includes(token), 'модель не прочитала страницу (жетона нет в ответе)', reply)

        // Переподключение на загруженном треде: без браузера, затем снова с ним.
        await cx.req('thread/unsubscribe', { threadId }, 10_000)
        const r1 = await cx.req('thread/resume', { threadId, excludeTurns: true, cwd: work, sandbox: 'workspace-write', approvalPolicy: 'on-request' }, 60_000)
        const off = await cxWait(cx, threadId, false)
        say(`5c. resume БЕЗ браузера: ${r1.error ? JSON.stringify(r1.error) : 'ок'}; ${BROWSER_SERVER_NAME} у треда: ${off?.runtimeStatus ?? 'нет'}`)
        await cx.req('thread/unsubscribe', { threadId }, 10_000)
        const r2 = await cx.req('thread/resume', { threadId, excludeTurns: true, cwd: work, sandbox: 'workspace-write', approvalPolicy: 'on-request', config: { mcp_servers: cxServers() } }, 60_000)
        const on = await cxWait(cx, threadId, true)
        say(`5d. resume С браузером: ${r2.error ? JSON.stringify(r2.error) : 'ок'}; ${BROWSER_SERVER_NAME} у треда: ${on?.runtimeStatus ?? 'нет'}`)
        say(`5e. переподключение применяет новый набор: выключение ${off === null ? 'ДА' : 'НЕТ'}, включение ${on?.runtimeStatus === 'connected' ? 'ДА' : 'НЕТ'}`)
      } finally { cx.close(); srv.close() }
    }
  }
} catch (e) {
  expect(false, 'прогон упал', e?.stack ?? e)
} finally {
  pult(['daemon', 'stop'], 30_000)
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

say(`\nитог: проверок ${checks}, провалов ${failed}`)
process.exit(failed ? 1 : 0)
