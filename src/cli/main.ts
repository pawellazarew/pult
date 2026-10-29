#!/usr/bin/env node
import { t as tr } from './i18n.js'
import { isLanguageSetting, resolveLanguage, setLanguage } from '../i18n/core.js'
// `pult` — CLI. Разбор argv руками: зависимостей у пакета ноль, а нужных нам форм флагов
// ровно две (`--флаг` и `--флаг значение`).
//
// Коды выхода (план Ф1 §4): 0 ок · 1 ошибка · 2 таймаут · 3 ждёт человека ·
// 4 сеть заблокирована стражем · 5 провайдер недоступен · 10 есть обновление (`pult update --check`, M8c).

import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../core/config.js'
import type { PultEvent } from '../core/events.js'
import { coversDir, ensureLayout, paths as resolvePaths } from '../core/paths.js'
import type { PultPaths } from '../core/paths.js'
import type { DaemonStatus } from '../core/rpc.js'
import { VERSION } from '../core/version.js'
import { formatDoctor, runDoctor } from '../env/doctor.js'
import { codexConfigPath } from '../env/codexConfig.js'
import { askDaemon, runMcpAsk, stdioIo } from '../perm/mcpAsk.js'
import { serviceDoctorItems } from '../service/doctor.js'
import { installService, serviceStatus, uninstallService } from '../service/install.js'
import { stopDaemon } from '../service/stop.js'
import { versionDoctorItems } from '../update/doctor.js'
import { refuseRunningTurns, updateFrom, updateList, updateTo } from '../update/update.js'
import { EXIT_UPDATE_AVAILABLE, updateCheck, updateLatest, updateStage } from '../update/channel.js'
import { runtimeInstall, runtimeShow } from '../update/runtimeCli.js'
import { updateAppCli } from '../update/appUpdateCli.js'
import { daemonNode } from '../env/nodeBin.js'
import { packageRoot } from '../service/install.js'
import { testLocate } from '../env/locate.js'
import { contextShare, parseSessionContext } from '../sessions/context.js'
import { isUnread, parseAttention } from '../sessions/attention.js'
import { isApprovalMode } from '../adapters/types.js'
import { APPROVAL_WORDS, describeChanges, homeCwdWarning, modeBlocksBrowser, parseNewSession } from '../sessions/settings.js'
import type { ConfigureChanges, ConfigureWhen, NewSessionSettings } from '../sessions/settings.js'
import type { PermissionOffers } from '../adapters/types.js'
import { connectClient } from './client.js'
import { ClientError } from './client.js'
import { ensureDaemon } from './startOnDemand.js'
import { describePlan, launchUi, planUi } from './ui.js'
import { browserInstalled, BrowserInstallError, browserPrefix, claudeDefaultMode, findChrome, installBrowser, PLAYWRIGHT_MCP_PACKAGE, PLAYWRIGHT_MCP_VERSION } from '../mcp/browser.js'
import { browserDoctorItems, bypassDoctorItems, installStateOf, mcpDoctorItems } from '../mcp/doctor.js'
import { GuardError, guardLine, guardVerdict, parseGuardStrict } from '../core/guard.js'
import type { GuardRule } from '../core/guard.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Initialize before constructing help and other module-level display text.
let configuredLanguage: unknown
try { configuredLanguage = (JSON.parse(readFileSync(resolvePaths(process.env).config, 'utf8')) as { language?: unknown }).language } catch { /* auto on missing or malformed config */ }
const languageOverride = process.env['PULT_LANG']
setLanguage(resolveLanguage(isLanguageSetting(languageOverride) ? languageOverride : isLanguageSetting(configuredLanguage) ? configuredLanguage : 'auto',
  process.env['LC_ALL'] || process.env['LC_MESSAGES'] || process.env['LANG'] || Intl.DateTimeFormat().resolvedOptions().locale))

export const EXIT = {
  ok: 0,
  error: 1,
  timeout: 2,
  needsHuman: 3,
  netBlocked: 4,
  providerUnavailable: 5,
  updateAvailable: EXIT_UPDATE_AVAILABLE,
} as const

const HELP = tr`pult ${VERSION} — диспетчерская над claude, codex и opencode (веха В4)

  pult daemon start                 поднять демона (отсоединённым, переживает терминал)
  pult daemon status [--json]       состояние демона
  pult daemon stop                  штатно остановить демона
  pult daemon logs [-n N]           последние строки журнала
  pult daemon install [--dev] [--print]   служба launchd/systemd --user: демон живёт сам и
                                    поднимается после перезагрузки (--dev — из этой рабочей копии)
  pult daemon uninstall             снять службу (PULT_HOME не трогается)
  pult events tail [--since N] [--session ID] [--json] [--no-follow] [--limit N]
  pult doctor [--json] [--no-net]   проверка машины: CLI, вход, сеть, права, демон, служба, версии
  pult ui [--dev] [--print]         открыть окно: Pult.app из /Applications, иначе рабочая копия
                                    (PULT_UI_ROOT); --dev — сразу рабочая копия, --print — только план

  pult update                       новая версия из релизов GitHub: подписанный latest.json, тарбол
                                    с проверкой sha256, дальше как --from (проба, откат)
  pult update --check [--json]      только проверить: код 0 — последняя, 10 — есть обновление
  pult update --expect <версия>     то же, что pult update, но эту версию или новее (так зовёт окно)
  pult update --stage               скачать и подготовить новую версию, не переключая (так зовёт демон)
  pult update --from <pult-x.y.z.tgz> [--reinstall]   поставить версию из тарбола и переключиться
                                    (проба нового демона; не прошла — откат на прежнюю)
  pult update --to <версия>         переключиться на уже стоящую версию (ручной откат)
  pult update … --force             не ждать идущих ходов (без него: идут ходы — отказ, демон не трогается)
  pult update --list [--json]       версии на диске: current, previous, bad
  pult update --app [--force]       обновить окно (Pult.app, macOS) из того же канала: демон качает и
                                    проверяет архив, закрывает окно, меняет и открывает; не поднялось —
                                    возвращает прежнее (--force — и версию, которая уже не встала)
  pult update --app --rollback      вернуть прежнее окно, если новое (поставленное при закрытом окне)
                                    не заработало при первом запуске
  pult runtime [--json]             свой node Пульта: стоит ли и на каком node работает демон
  pult runtime install [--from <node-vX-платформа.tar.gz>]   поставить свой node из пина пакета
                                    (демон и заглушка разрешений живут на нём: brew upgrade его не трогает)

  pult session …                    сессии (так они названы в окне); pult agent … — то же самое,
                                    прежнее имя команды
  pult agent start <имя> --kind claude|codex --cwd <папка> [--model M] [--effort E] [--warm]
                    [--title "название"]
                    [--worktree <ветка> [--base <ref>]]   агент в своём git worktree
                                    (PULT_HOME/worktrees/…; ветки нет — заводится от --base или HEAD)
                    [--browser [--headed]]   браузер для агента (Playwright MCP, свой профиль
                                    на сессию; --headed — окно браузера видно)
                    [--approval read-only|ask|workspace|full]   как подтверждать действия (по умолчанию
                                    ask — всё шире рабочей папки через Inbox; workspace — правки в папке
                                    без вопросов; full — что угодно без вопросов и без песочницы, только с --yes)
                                    без флагов модель, усилие, режим и браузер — из config.json → newSession.defaults
                                    этого провайдера (окно → Настройки); провайдер и --warm — только флагом,
                                    последний выбор окна сюда не идёт
  pult agent set <имя> [--model M] [--effort E] [--approval A] [--yes]   сменить у живой сессии — со
                                    следующего хода (идущий ход не трогается); --yes — для full и для модели
                                    с окном меньше занятого контекста
  pult agent browser <имя> on|off [--headed]   браузер вкл/выкл — со следующего хода
  pult agent rename <имя> ["название"]   название для списков и окна; без текста — снять.
                                    <имя> — ключ агента и не меняется; слово на «-» — через
                                    --title="-…"
  pult agent archive|unarchive <имя>   в архив и обратно (окно прячет в «Архив»; реплика возвращает)
  pult agent prompt <имя> "текст" [--wait] [--until idle,blocked,done] [--timeout MS] [--json]
                    [--queue | --interrupt]   --queue: идёт ход — реплика в очередь и уйдёт сама,
                                    когда ход кончится; --interrupt: прервать ход и сказать
  pult agent read <имя> [--since N] [--format text|json]
  pult agent wait|list|stop|rm|tree <имя>
  pult agent list [--json]          ctx 24% — доля контекстного окна модели, занятая разговором;
                                    ● — непрочитано (ход закончился, упал или спросил, а сессию с тех
                                    пор не открывали — то же, что точка в окне), · — прочитано
  pult agent seen <имя> [--unread]  отметить сессию прочитанной; --unread — пометить непрочитанной
  pult agent export <имя> [--stdout | --json]   разговор в Markdown: файл в PULT_HOME/exports/
                                    (печатает путь); --stdout — сам текст, файл не остаётся
  pult agent rm <имя> [--worktree]  --worktree: ещё и git worktree remove (грязное дерево — отказ;
                                    ветка не удаляется никогда)
  pult perm list [--json] · pult perm approve <id> [--session | --rule] · pult perm deny <id> --reason "…"
                                    approve — один раз; --session — и такие же до конца сессии; --rule —
                                    постоянное правило провайдера (оба — только если провайдер их предложил)
  pult perm rules [--json]          правила «Всегда» Codex, записанные Пультом (дата, сессия);
  pult perm rules revoke <id>       отозвать: метка и строка уходят из ~/.codex/rules/default.rules
  pult usage [--json]
  pult provider reset [claude|codex]   снять остановку провайдера
  pult mcp-ask                         служебный режим: stdio-MCP-заглушка разрешений
  pult browser [--json]             браузер агента: стоит ли Playwright MCP, найден ли Chrome
  pult browser install              поставить Playwright MCP ${PLAYWRIGHT_MCP_VERSION} в PULT_HOME/mcp (npm ci по lock-файлу пакета)
  pult mcp list [--json]            свои MCP-серверы из ~/.claude.json (● — подключён); .mcp.json — позже
  pult mcp select <имя> [<имя>…] | --none   какие из них подключать к сессиям Claude
  pult net guard [--json]           правило стража страны выхода (одно на claude, codex и opencode)
  pult net guard --deny RU,BY | --allow DE,FI   сменить: запрещать страны из списка / разрешать только их
                                    (коды ISO 3166-1; через демона — со следующего хода, без рестарта)

  pult --help | --version

Состояние живёт в PULT_HOME (по умолчанию ~/.pult).
Коды выхода: 0 ок · 1 ошибка · 2 таймаут · 3 ждёт человека · 4 сеть заблокирована · 5 провайдер недоступен ·
10 есть обновление (только pult update --check).`

export interface ParsedArgs {
  verb: string | null
  sub: string | null
  flags: Map<string, string | boolean>
  positional: string[]
  /**
   * Флаг со значением, за которым шло слово на «-»: разбор его значением не берёт (флаг = true),
   * но само слово помнит — чтобы отказ назвал то, что человек написал (ревью В4, A4).
   */
  dashAfter: Map<string, string>
}

const VALUE_FLAGS = new Set([
  'since', 'session', 'limit', 'n', 'lines', 'timeout',
  'kind', 'cwd', 'model', 'effort', 'until', 'format', 'reason', 'setting-sources', 'worktree',
  'from', 'to', 'base', 'title', 'expect', 'approval', 'deny', 'allow',
])

/**
 * Колонка контекстного окна в `agent list`: «ctx 24%» — доля окна модели, занятая разговором;
 * окно ещё не известно (у Claude оно приходит в конце хода) — «ctx 48k» токенов. Замеров не
 * было — пусто. Точные числа — в `agent list --json`, поле `context`.
 */
function contextColumn(raw: unknown): string {
  const c = parseSessionContext(raw)
  if (!c) return ''
  const share = contextShare(c)
  return share !== null ? `ctx ${Math.round(share * 100)}%` : `ctx ${Math.round(c.used / 1000)}k`
}

/** M8d: режим подтверждений сессии словами (нет поля — `ask`, как у всех сессий до M8d). */
function approvalLabel(raw: unknown): string {
  const mode = isApprovalMode(raw) ? raw : 'ask'
  return {
    'read-only': tr('read-only (только чтение)'),
    ask: tr('ask (шире рабочей папки — через Inbox)'),
    workspace: tr('workspace (правки в папке без вопросов)'),
    full: tr('full (без вопросов и без песочницы)'),
  }[mode]
}

/** Флаги без значения — чтобы `--worktree --json` читался как «значения нет», а не как ветка «--json». */
const BOOL_FLAGS = new Set([
  'json', 'warm', 'wait', 'dev', 'print', 'reinstall', 'list', 'check', 'stage', 'no-follow', 'no-net', 'help', 'version', 'h', 'v', 'unread',
  'queue', 'interrupt', 'stdout', 'browser', 'headed', 'none', 'rule', 'yes', 'app', 'force', 'rollback',
])

/** Слово на «-» — это флаг Пульта (тогда у предыдущего флага значения нет), а не значение на «-». */
export function isOwnFlag(word: string): boolean {
  const body = word.replace(/^--?/, '').split('=')[0] ?? ''
  return VALUE_FLAGS.has(body) || BOOL_FLAGS.has(body)
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>()
  const positional: string[] = []
  const dashAfter = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq > 0) { flags.set(body.slice(0, eq), body.slice(eq + 1)); continue }
      if (VALUE_FLAGS.has(body) && i + 1 < argv.length && !(argv[i + 1] as string).startsWith('-')) {
        flags.set(body, argv[++i] as string)
        continue
      }
      if (VALUE_FLAGS.has(body) && i + 1 < argv.length) dashAfter.set(body, argv[i + 1] as string)
      flags.set(body, true)
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const body = a.slice(1)
      if (VALUE_FLAGS.has(body) && i + 1 < argv.length) { flags.set(body, argv[++i] as string); continue }
      flags.set(body, true)
      continue
    }
    positional.push(a)
  }
  return {
    verb: positional[0] ?? null,
    sub: positional[1] ?? null,
    flags,
    positional,
    dashAfter,
  }
}

const num = (v: string | boolean | undefined, dflt: number): number => {
  if (typeof v !== 'string') return dflt
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : dflt
}

const out = (s: string): void => { process.stdout.write(s.endsWith('\n') ? s : s + '\n') }
const err = (s: string): void => { process.stderr.write(s.endsWith('\n') ? s : s + '\n') }

function formatEvent(ev: PultEvent): string {
  const data = JSON.stringify(ev.data)
  return `#${ev.id} ${ev.ts} ${ev.provider}/${ev.kind} ${ev.sessionId}${data === '{}' ? '' : ' ' + data}`
}

async function cmdDaemonStart(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const before = await tryStatus(paths)
  if (before) {
    out(args.flags.has('json')
      ? JSON.stringify({ started: false, alreadyRunning: true, status: before })
      : tr`демон уже работает: pid ${before.pid}, версия ${before.version}`)
    return EXIT.ok
  }
  const { client, spawned } = await ensureDaemon(paths)
  const status = (await client.request('daemon.status')) as DaemonStatus
  client.close()
  out(args.flags.has('json')
    ? JSON.stringify({ started: spawned, alreadyRunning: !spawned, status })
    : tr`демон запущен: pid ${status.pid}, режим ${status.mode ?? 'on-demand'}, сокет ${status.sock}`)
  return EXIT.ok
}

async function tryStatus(paths: PultPaths): Promise<DaemonStatus | null> {
  try {
    const client = await connectClient(paths)
    const status = (await client.request('daemon.status')) as DaemonStatus
    client.close()
    return status
  } catch {
    return null
  }
}

async function cmdDaemonStatus(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const status = await tryStatus(paths)
  // Строка службы печатается и при мёртвом демоне: «служба загружена, последний код 78» — ровно
  // то, что человеку нужно увидеть, когда демон не поднимается.
  const svc = serviceStatus(paths, process.env)
  if (!status) {
    out(args.flags.has('json')
      ? JSON.stringify({ running: false, home: paths.home, service: svc.report })
      : tr`демон не запущен\n${svc.line}`)
    return EXIT.error
  }
  out(args.flags.has('json')
    ? JSON.stringify({ running: true, ...status, service: svc.report })
    : tr`pultd ${status.version} · pid ${status.pid} · протокол ${status.protocol} · аптайм ${Math.round(status.uptimeMs / 1000)} с\n`
      + tr`режим ${status.mode ?? 'on-demand'} · дом ${status.home}\nклиентов ${status.clients}, подписок ${status.subscriptions}, событий до #${status.lastEventId}\n`
      + svc.line)
  return EXIT.ok
}

const cliIo = { out, err }

function cmdDaemonInstall(paths: PultPaths, args: ParsedArgs): Promise<number> {
  return installService(paths, cliIo, {
    dev: args.flags.has('dev'),
    print: args.flags.has('print'),
    json: args.flags.has('json'),
  })
}

function cmdDaemonUninstall(paths: PultPaths): Promise<number> {
  return uninstallService(paths, cliIo)
}

async function cmdDaemonStop(paths: PultPaths, args: ParsedArgs): Promise<number> {
  // Раньше: сокет не ответил → «не запущен — останавливать нечего», код 0. Так отвечали и демону,
  // который прямо сейчас стартует (служба подняла его после kill -9, в run/ — сокет убитого), и он
  // оставался жить (A1 ревью В4). Теперь остановка спрашивает ещё менеджер служб и держателя lock.
  const r = await stopDaemon(paths, { env: process.env })
  const json = args.flags.has('json')
  if (r.result === 'none') {
    out(json ? JSON.stringify({ stopped: false, running: false }) : tr('демон не запущен — останавливать нечего'))
    return EXIT.ok
  }
  if (r.result === 'failed') {
    if (json) out(JSON.stringify({ stopped: false, running: true, error: r.message }))
    err(`pult daemon stop: ${r.message}`)
    return EXIT.error
  }
  const how = r.via === 'service' ? tr(' (через менеджер служб: демон ещё стартовал)')
    : r.via === 'signal' ? tr(' (SIGTERM: демон ещё стартовал)') : ''
  out(json ? JSON.stringify({ stopped: true, via: r.via, pid: r.pid }) : tr`демон остановлен${how}`)
  return EXIT.ok
}

function cmdDaemonLogs(paths: PultPaths, args: ParsedArgs): number {
  const n = num(args.flags.get('n') ?? args.flags.get('lines'), 50)
  let text: string
  try {
    text = readFileSync(paths.logFile, 'utf8')
  } catch {
    err(tr`журнал ${paths.logFile} не читается — демон ещё ни разу не стартовал?`)
    return EXIT.error
  }
  const lines = text.split('\n').filter((l) => l.trim())
  out(lines.slice(-n).join('\n'))
  return EXIT.ok
}

async function cmdEventsTail(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const since = num(args.flags.get('since'), 0)
  const sessionId = typeof args.flags.get('session') === 'string' ? (args.flags.get('session') as string) : undefined
  const asJson = args.flags.has('json')
  const follow = !args.flags.has('no-follow')
  const limit = num(args.flags.get('limit'), 0)

  const { client } = await ensureDaemon(paths)
  let shown = 0
  let lastId = since
  // `--no-follow` обязан дождаться, пока доиграет ВЕСЬ хвост до курсора, который демон вернул
  // на подписку: ответ и кадры могут прийти разными кусками, и выход «сразу после ответа»
  // печатал бы пустоту.
  let stopAt = Number.POSITIVE_INFINITY
  let finish: (() => void) | null = null

  const done = new Promise<void>((resolve) => { finish = resolve })
  const maybeFinish = (): void => {
    if (limit && shown >= limit) finish?.()
    if (!follow && lastId >= stopAt) finish?.()
  }

  const res = await client.subscribe(
    { since, ...(sessionId !== undefined ? { sessionId } : {}) },
    (ev) => {
      out(asJson ? JSON.stringify(ev) : formatEvent(ev))
      shown++
      lastId = ev.id
      maybeFinish()
    },
    () => finish?.(),
  )
  client.onClose(() => finish?.())
  process.on('SIGINT', () => finish?.())
  if (!follow) {
    stopAt = res.cursor
    maybeFinish()
    // Страховка: если демон за это время не прислал хвост, не висим вечно.
    setTimeout(() => finish?.(), 3000).unref()
  }

  await done
  client.close()
  return EXIT.ok
}

// --- агенты, разрешения, расход (веха В2) -------------------------------------

/** Код выхода по коду ошибки протокола — таблица из плана Ф1 §4. */
function exitForError(code: string | undefined): number {
  switch (code) {
    case 'timeout': return EXIT.timeout
    case 'blocked_network': return EXIT.netBlocked
    case 'provider_unavailable': return EXIT.providerUnavailable
    // Исчерпанный лимит подписки — это «провайдер сейчас недоступен», и скрипту важно, что
    // это НЕ обычная ошибка: код 5 отличает «подожди сброса» от «запрос кривой» (ревью В3).
    case 'limited': return EXIT.providerUnavailable
    default: return EXIT.error
  }
}

const flagStr = (args: ParsedArgs, name: string): string | undefined => {
  const v = args.flags.get(name)
  return typeof v === 'string' && v ? v : undefined
}

async function cmdAgent(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const sub = args.sub
  const name = args.positional[2]
  const asJson = args.flags.has('json')
  const { client } = await ensureDaemon(paths)
  const done = (code: number): number => { client.close(); return code }

  const call = async (method: string, params?: Record<string, unknown>): Promise<unknown> => client.request(method, params)

  try {
    switch (sub) {
      case 'start': {
        if (!name) { err(tr('pult agent start: нужно имя агента')); return done(EXIT.error) }
        // `--worktree` без значения (или со значением на `-`, которое разбор не берёт) — это
        // не «без worktree», а ошибка: молча завести агента в общей папке — ровно то, от чего
        // человек хотел уйти флагом.
        // Пустое значение (`--worktree=`, скрипт подставил пустую $BRANCH) — то же самое: раньше
        // проверка ловила только `true`, flagStr выбрасывал пустую строку, и агент молча
        // заводился в общей папке репо с кодом 0.
        const emptyFlag = (f: string): boolean => args.flags.get(f) === true || args.flags.get(f) === ''
        // Значение на «-» (`--worktree -x`, `--worktree=-x`, `--base --upload-pack=x`) — отказ, но
        // С ЭТИМ значением. Раньше `--worktree -x` отвечал «--worktree требует имя ветки»: разбор
        // слово на «-» значением не берёт, и человек читал, что имени нет, хотя он его дал (A4).
        // Отказ обязан остаться: такое слово ушло бы в git как опция.
        const dashValue = (f: string): string | null => {
          const v = args.flags.get(f)
          if (typeof v === 'string' && v.startsWith('-')) return v
          const next = args.dashAfter.get(f)
          return v === true && next !== undefined && !isOwnFlag(next) ? next : null
        }
        const wtDash = dashValue('worktree')
        if (wtDash !== null) { err(tr`pult agent start: ветка не может начинаться с «-»: ${wtDash}`); return done(EXIT.error) }
        const baseDash = dashValue('base')
        if (baseDash !== null) { err(tr`pult agent start: --base: ревизия не может начинаться с «-»: ${baseDash}`); return done(EXIT.error) }
        if (emptyFlag('worktree')) { err(tr('pult agent start: --worktree требует имя ветки')); return done(EXIT.error) }
        // `--title -важное-`: разбор слово на «-» значением не берёт — агент завёлся бы без названия и без слова об этом.
        if (emptyFlag('title')) { err(tr('pult agent start: --title требует название (начинается с «-» — пиши --title="-…")')); return done(EXIT.error) }
        if (emptyFlag('base')) { err(tr('pult agent start: --base требует ревизию')); return done(EXIT.error) }
        if (args.flags.has('approval') && (flagStr(args, 'approval') === undefined || !isApprovalMode(flagStr(args, 'approval')))) {
          err('pult agent start: --approval — read-only | ask | workspace | full'); return done(EXIT.error)
        }
        // M8f: умолчания `newSession.defaults` (окно → Настройки) — для того, что не задано флагом. Последний выбор
        // окна сюда не идёт: скрипт должен давать один и тот же результат. Старый демон без `settings.get` — без них.
        // Ревью (LOW 11): провайдер и тёплый процесс из умолчаний CLI НЕ берёт — скрипт не должен молча сменить
        // провайдера или режим процесса; модель, усилие, режим и браузер — только умолчания ЭТОГО провайдера.
        let defaults: NewSessionSettings['defaults'] | null = null
        try {
          defaults = parseNewSession(((await call('settings.get')) as { newSession?: unknown }).newSession, false).value.defaults
        } catch { defaults = null }
        const kind = flagStr(args, 'kind') ?? 'claude'
        const d = defaults ? (kind === 'codex' ? defaults.codex : defaults.claude) : {}
        const approval = flagStr(args, 'approval') ?? d.approval
        const used: string[] = []
        if (!args.flags.has('model') && d.model) used.push(tr`модель ${d.model}`)
        if (!args.flags.has('effort') && d.effort) used.push(tr`усилие ${d.effort}`)
        if (!args.flags.has('approval') && d.approval) used.push(tr`режим ${d.approval}`)
        const browserDefault = !args.flags.has('browser') && d.browser === true && !modeBlocksBrowser(kind === 'codex' ? 'codex' : 'claude', isApprovalMode(approval) ? approval : undefined)
        if (browserDefault) used.push(tr('браузер'))
        if (used.length && !asJson) err(tr`pult agent start: из настроек (newSession.defaults): ${used.join(', ')}`)
        // Ревью M8d: `full` — только с `--yes`, отказ до заведения чего-либо.
        if (approval === 'full' && !args.flags.has('yes')) {
          err(tr('pult agent start: --approval full — агент делает что угодно без вопросов, песочницы нет; повтори с --yes')); return done(EXIT.error)
        }
        const rec = await call('agent.start', {
          name,
          ...(approval !== undefined ? { approval } : {}),
          ...(approval === 'full' ? { confirm: true } : {}),
          ...(flagStr(args, 'title') !== undefined ? { title: flagStr(args, 'title') } : {}),
          kind,
          cwd: flagStr(args, 'cwd') ?? process.cwd(),
          ...((flagStr(args, 'model') ?? d.model) !== undefined ? { model: flagStr(args, 'model') ?? d.model } : {}),
          ...((flagStr(args, 'effort') ?? d.effort) !== undefined ? { effort: flagStr(args, 'effort') ?? d.effort } : {}),
          ...(args.flags.has('warm') ? { mode: 'warm' } : {}),
          ...(flagStr(args, 'setting-sources') !== undefined ? { settingSources: flagStr(args, 'setting-sources') } : {}),
          ...(flagStr(args, 'worktree') !== undefined ? { worktree: flagStr(args, 'worktree') } : {}),
          ...(flagStr(args, 'base') !== undefined ? { base: flagStr(args, 'base') } : {}),
          ...(args.flags.has('browser') || browserDefault ? { browser: args.flags.has('headed') ? { headed: true } : true } : {}),
        })
        const r = rec as Record<string, unknown>
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        out(tr`агент ${String(r['name'])} заведён: ${String(r['provider'])}, режим ${String(r['mode'])}, cwd ${String(r['cwd'])}`
          + tr`, подтверждения: ${approvalLabel(r['approval'])}`)
        if (r['approval'] === 'full') err(tr('pult agent start: режим full — агент делает что угодно без вопросов, песочницы нет'))
        // Не отказ — предупреждение: дом агенту можно дать сознательно, но он должен знать, что под ним лежит.
        if (r['approval'] !== 'read-only' && typeof r['cwd'] === 'string' && coversDir(r['cwd'], homedir())) {
          err(tr`pult agent start: внимание — ${homeCwdWarning()}`)
        }
        const wt = r['worktree'] as { path: string; branch: string } | undefined
        if (wt) {
          const how = r['worktreeAction'] === 'created' ? tr('новая ветка')
            : r['worktreeAction'] === 'reused' ? tr('папка переиспользована') : tr('выписана существующая ветка')
          out(tr`worktree ${wt.path} · ветка ${wt.branch} (${how})`)
          if (r['baseIgnored']) err(tr('pult agent start: ветка уже была — --base ни на что не повлиял'))
        }
        if (typeof r['browserDownloads'] === 'string') out(tr`браузер для агента: скачивания — ${r['browserDownloads']}`)
        return done(EXIT.ok)
      }

      case 'set': {
        // M8f: модель, усилие, режим подтверждений живой сессии — со следующего хода.
        if (!name) { err(tr('pult agent set: нужно имя сессии')); return done(EXIT.error) }
        for (const f of ['model', 'effort', 'approval']) {
          if (args.flags.has(f) && flagStr(args, f) === undefined) { err(tr`pult agent set: --${f} требует значение`); return done(EXIT.error) }
        }
        const approval = flagStr(args, 'approval')
        if (approval !== undefined && !isApprovalMode(approval)) { err('pult agent set: --approval — read-only | ask | workspace | full'); return done(EXIT.error) }
        if (approval === 'full' && !args.flags.has('yes')) {
          err(tr('pult agent set: --approval full — агент делает что угодно без вопросов, песочницы нет; повтори с --yes')); return done(EXIT.error)
        }
        if (flagStr(args, 'model') === undefined && flagStr(args, 'effort') === undefined && approval === undefined) {
          err(tr('pult agent set <имя> [--model M] [--effort E] [--approval read-only|ask|workspace|full] [--yes]')); return done(EXIT.error)
        }
        let r: Record<string, unknown>
        try {
          r = (await call('agent.configure', {
            name,
            ...(flagStr(args, 'model') !== undefined ? { model: flagStr(args, 'model') } : {}),
            ...(flagStr(args, 'effort') !== undefined ? { effort: flagStr(args, 'effort') } : {}),
            ...(approval !== undefined ? { approval } : {}),
            ...(args.flags.has('yes') ? { confirm: true } : {}),
          })) as Record<string, unknown>
        } catch (e) {
          if (e instanceof ClientError && e.code === 'needs_confirm') {
            err(tr`pult agent set: ${e.message} (повтори с --yes)`)
            return done(EXIT.error)
          }
          throw e
        }
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        const changes = (r['changes'] ?? {}) as ConfigureChanges
        const line = describeChanges(changes, (r['when'] as ConfigureWhen | undefined) ?? 'next_turn')
        out(line ? `${name}: ${line}` : tr`${name}: ничего не поменялось`)
        if (changes.browser === 'off') err(tr`pult agent set: браузер для агента выключен — в режиме «${APPROVAL_WORDS[changes.approval?.to ?? 'ask']}» его вызовы шли бы без вопроса`)
        if (changes.browser === 'on') out(tr('браузер для агента снова включён — как было до смены режима'))
        if (changes.model) err(tr('pult agent set: первый ход после смены модели дороже — кэш промпта у каждой модели свой'))
        if (changes.approval?.to === 'full') err(tr('pult agent set: режим full — агент делает что угодно без вопросов, песочницы нет'))
        return done(EXIT.ok)
      }

      case 'browser': {
        if (!name) { err(tr('pult agent browser: нужно имя сессии')); return done(EXIT.error) }
        const what = args.positional[3]
        if (what !== 'on' && what !== 'off') { err(tr('pult agent browser <имя> on|off [--headed]')); return done(EXIT.error) }
        const r = (await call('agent.browser', { name, on: what === 'on', ...(args.flags.has('headed') ? { headed: true } : {}) })) as Record<string, unknown>
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        out(what === 'on'
          ? tr`браузер для ${name} включён${args.flags.has('headed') ? tr(' (окно видно)') : ''} — со следующего хода; скачивания — ${String(r['browserDownloads'] ?? '')}`
          : tr`браузер для ${name} выключен — со следующего хода`)
        return done(EXIT.ok)
      }

      case 'rename': {
        if (!name) { err(tr('pult agent rename: нужно имя агента')); return done(EXIT.error) }
        // Название — словами после имени ИЛИ флагом `--title`, как у `start`. Без второго
        // `rename w --title "x"` читался как «слов нет» и молча СНИМАЛ название.
        const words = args.positional.slice(3).join(' ')
        const flag = args.flags.get('title')
        if (flag !== undefined && (typeof flag !== 'string' || words)) {
          err(tr('pult agent rename: название — либо словами после имени, либо --title "…" (одним значением)'))
          return done(EXIT.error)
        }
        const r = (await call('agent.rename', { name, title: typeof flag === 'string' ? flag : words })) as Record<string, unknown>
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        out(r['title'] !== undefined ? tr`агент ${name} теперь «${String(r['title'])}»` : tr`агент ${name}: название снято`)
        return done(EXIT.ok)
      }

      case 'archive':
      case 'unarchive': {
        if (!name) { err(tr`pult session ${args.sub}: нужно имя сессии`); return done(EXIT.error) }
        const r = (await call('agent.archive', { name, archived: args.sub === 'archive' })) as Record<string, unknown>
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        out(args.sub === 'archive' ? tr`сессия ${name} в архиве (реплика вернёт её)` : tr`сессия ${name} возвращена из архива`)
        return done(EXIT.ok)
      }

      case 'prompt': {
        if (!name) { err(tr('pult agent prompt: нужно имя агента')); return done(EXIT.error) }
        const text = args.positional.slice(3).join(' ')
        if (!text.trim()) { err(tr('pult agent prompt: нужна реплика')); return done(EXIT.error) }
        const queue = args.flags.has('queue')
        const interrupt = args.flags.has('interrupt')
        if (queue && interrupt) { err(tr('pult agent prompt: --queue и --interrupt вместе не бывают')); return done(EXIT.error) }
        const started = (await call('agent.prompt', { name, text, ...(queue ? { queue: true } : {}), ...(interrupt ? { interrupt: true } : {}) })) as
          { turnId: string } | { queued: true; id: string }
        // В очереди — ход ещё не начат: ждать нечего, `--wait` дождался бы ЧУЖОГО (идущего) хода.
        if ('queued' in started) {
          out(asJson ? JSON.stringify(started) : tr`реплика в очереди (${started.id}): уйдёт, когда ход ${name} кончится`)
          return done(EXIT.ok)
        }
        if (!args.flags.has('wait')) {
          out(asJson ? JSON.stringify({ turnId: started.turnId, waiting: false }) : tr`ход ${started.turnId} запущен`)
          return done(EXIT.ok)
        }
        const until = (flagStr(args, 'until') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const result = (await call('agent.wait', {
          name,
          ...(until.length ? { until } : {}),
          ...(args.flags.has('timeout') ? { timeoutMs: num(args.flags.get('timeout'), 600_000) } : {}),
        })) as Record<string, unknown>
        return done(printWait(result, asJson))
      }

      case 'wait': {
        if (!name) { err(tr('pult agent wait: нужно имя агента')); return done(EXIT.error) }
        const until = (flagStr(args, 'until') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const result = (await call('agent.wait', {
          name,
          ...(until.length ? { until } : {}),
          ...(args.flags.has('timeout') ? { timeoutMs: num(args.flags.get('timeout'), 600_000) } : {}),
        })) as Record<string, unknown>
        return done(printWait(result, asJson))
      }

      case 'read': {
        if (!name) { err(tr('pult agent read: нужно имя агента')); return done(EXIT.error) }
        const format = flagStr(args, 'format') === 'json' ? 'json' : 'text'
        const r = (await call('agent.read', { name, since: num(args.flags.get('since'), 0), format })) as Record<string, unknown>
        // Worktree — в stderr: stdout у `read` — это текст модели или NDJSON событий, и скрипт,
        // который их читает, не должен спотыкаться о служебную строку.
        const wt = r['worktree'] as { path: string; branch: string } | undefined
        if (wt) err(tr`worktree ${wt.path} · ветка ${wt.branch}`)
        if (format === 'json') {
          for (const ev of (r['events'] as PultEvent[])) out(JSON.stringify(ev))
        } else {
          const text = String(r['text'] ?? '')
          if (text) out(text)
        }
        return done(EXIT.ok)
      }

      case 'list': {
        const r = (await call('agent.list')) as { sessions: Array<Record<string, unknown>> }
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        if (!r.sessions.length) { out(tr('агентов нет')); return done(EXIT.ok) }
        for (const sn of r.sessions) {
          const wt = sn['worktree'] as { path: string; branch: string } | undefined
          const ctx = contextColumn(sn['context'])
          // Непрочитанное (О2) — колонкой сразу за именем: `●` непрочитано, `·` прочитано. Всегда одно слово
          // без пробелов: скрипт, который режет строку по пробелам, видит одинаковое число полей.
          const unread = isUnread({
            attention: parseAttention(sn['attention']),
            ...(typeof sn['lastSeenEventId'] === 'number' ? { lastSeenEventId: sn['lastSeenEventId'] } : {}),
            ...(sn['markedUnread'] === true ? { markedUnread: true } : {}),
          })
          out(`${String(sn['name']).padEnd(16)} ${unread ? '●' : '·'} ${String(sn['provider']).padEnd(7)} ${String(sn['lastStatus']).padEnd(19)} `
            + `${String(sn['mode'])}${isApprovalMode(sn['approval']) && sn['approval'] !== 'ask' ? ` · ${String(sn['approval'])}` : ''}${ctx ? ` · ${ctx}` : ''}${Number(sn['pendingPermissions']) > 0 ? tr` · ждёт решения: ${String(sn['pendingPermissions'])}` : ''}`
            + `${wt ? ` · worktree ${wt.path} (${wt.branch})` : ''}`
            + `${typeof sn['title'] === 'string' ? ` · «${sn['title']}»` : ''}`)
        }
        return done(EXIT.ok)
      }

      case 'seen': {
        if (!name) { err(tr('pult agent seen: нужно имя сессии')); return done(EXIT.error) }
        const unread = args.flags.has('unread')
        const r = (await call('agent.seen', { name, unread })) as Record<string, unknown>
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        out(unread ? tr`сессия ${name} помечена непрочитанной` : tr`сессия ${name} прочитана`)
        return done(EXIT.ok)
      }

      case 'stop': {
        if (!name) { err(tr('pult agent stop: нужно имя агента')); return done(EXIT.error) }
        await call('agent.stop', { name })
        out(asJson ? JSON.stringify({ stopped: true }) : tr`агент ${name} остановлен`)
        return done(EXIT.ok)
      }

      case 'rm': {
        // `--worktree` у `rm` — флаг без значения, но разбор знает его как флаг СО значением
        // (у `start`): `rm --worktree w` кладёт имя во флаг. Принимаем обе формы.
        const wtFlag = args.flags.get('worktree')
        const rmName = name ?? (typeof wtFlag === 'string' ? wtFlag : undefined)
        if (!rmName) { err(tr('pult agent rm: нужно имя агента')); return done(EXIT.error) }
        if (typeof wtFlag === 'string' && name) {
          err(tr('pult agent rm: --worktree не принимает значения — ветка не удаляется никогда')); return done(EXIT.error)
        }
        const r = (await call('agent.rm', { name: rmName, worktree: wtFlag !== undefined })) as Record<string, unknown>
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        out(tr`агент ${rmName} удалён`)
        const wt = r['worktree'] as { path: string; branch: string; repo: string } | undefined
        if (wt && r['worktreeRemoved']) {
          out(tr`worktree ${wt.path} убран; ветка ${wt.branch} осталась`)
        } else if (wt) {
          out(tr`worktree оставлен: ${wt.path} (ветка ${wt.branch})`)
          out(tr`убрать: git -C ${shellQuote(wt.repo)} worktree remove ${shellQuote(wt.path)}`)
        }
        return done(EXIT.ok)
      }

      case 'export': {
        if (!name) { err(tr('pult agent export: нужно имя сессии')); return done(EXIT.error) }
        const toStdout = args.flags.has('stdout')
        if (toStdout && asJson) { err(tr('pult agent export: --stdout и --json вместе не бывают — выбери одно')); return done(EXIT.error) }
        // Демон пишет файл и отвечает путём (текст разговора больше строки NDJSON, которую читает клиент).
        // `--stdout` дочитывает этот файл и удаляет его: просили текст, а не ещё один файл в exports/ —
        // демон и CLI на одной машине под одним пользователем.
        const r = (await call('agent.export', { name })) as { path: string; bytes: number }
        if (toStdout) {
          const md = readFileSync(r.path, 'utf8')
          try { unlinkSync(r.path) } catch { /* уже нет — не страшно */ }
          process.stdout.write(md)
          return done(EXIT.ok)
        }
        out(asJson ? JSON.stringify(r) : r.path)
        return done(EXIT.ok)
      }

      case 'tree': {
        if (!name) { err(tr('pult agent tree: нужно имя агента')); return done(EXIT.error) }
        const r = (await call('agent.tree', { name })) as Record<string, unknown>
        out(asJson ? JSON.stringify(r) : (String(r['text'] ?? '') || tr('дерево пустое: ни одного инструмента и субагента')))
        return done(EXIT.ok)
      }

      default:
        err(tr('pult agent: нужен один из start|set|rename|prompt|read|wait|list|seen|stop|rm|tree|browser'))
        return done(EXIT.error)
    }
  } catch (e) {
    if (e instanceof ClientError) {
      err(`pult agent: ${e.code} — ${e.message}`)
      return done(exitForError(e.code))
    }
    throw e
  }
}

/** Кавычки для строки-подсказки, которую человек скопирует в shell: путь бывает с пробелами. */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

function printWait(result: Record<string, unknown>, asJson: boolean): number {
  if (asJson) out(JSON.stringify(result))
  const status = String(result['status'] ?? '?')
  if (result['reason'] === 'timeout') {
    if (!asJson) err(tr`таймаут: агент в состоянии ${status}`)
    return EXIT.timeout
  }
  if (status === 'blocked_permission' || status === 'blocked_question') {
    if (!asJson) err(tr`ждёт человека: ${status} — смотри pult perm list`)
    return EXIT.needsHuman
  }
  const code = result['errorCode']
  if (result['ok'] === false || typeof code === 'string') {
    // Человеку нужен ТЕКСТ ПРИЧИНЫ, а он живёт в `message`: `text` у проваленного хода почти
    // всегда пуст. Пока печатался только `text`, строка выглядела как «ход не удался:
    // limited — » и не отличала исчерпанный лимит от мёртвого прокси (ревью В3).
    const why = String(result['message'] ?? result['text'] ?? '') || tr('провайдер не объяснил причину')
    if (!asJson) err(tr`ход не удался: ${String(result['errorCode'] ?? status)} — ${why}`)
    return exitForError(typeof code === 'string' ? code : undefined)
  }
  if (!asJson) {
    const text = String(result['text'] ?? '')
    if (text) out(text)
  }
  return EXIT.ok
}

/** Правило «Всегда» строкой — как кнопка карточки. */
function ruleText(x: Record<string, unknown>): string {
  return x['kind'] === 'network' ? tr`пускать в сеть к ${String(x['label'])}` : tr`команды, начинающиеся с «${String(x['label'])}»`
}

async function cmdPerm(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const { client } = await ensureDaemon(paths)
  const done = (code: number): number => { client.close(); return code }
  const asJson = args.flags.has('json')
  const id = args.positional[2]
  try {
    switch (args.sub) {
      case 'list': {
        const r = (await client.request('perm.list')) as { pending: Array<Record<string, unknown>> }
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        if (!r.pending.length) { out(tr('очередь разрешений пуста')); return done(EXIT.ok) }
        for (const p of r.pending) {
          out(tr`${String(p['id'])}  ${String(p['sessionId'])}  ${String(p['toolName'])}  ждёт ${Math.round(Number(p['waitingMs']) / 1000)} с`)
          out(`    ${JSON.stringify(p['input'])}`)
          if (p['concealed'] === true) out(tr('    ВНИМАНИЕ: показано не всё — фильтр секретов скрыл часть входа или длинное поле обрезано; исполнится исходный вход'))
          // M8d: что ещё можно, кроме «один раз», — ровно то, что провайдер предложил на этот запрос.
          const offers = p['offers'] as PermissionOffers | undefined
          if (offers?.session) out(tr('    --session: разрешить в этой сессии (и такие же до её конца)'))
          if (offers?.rule) out(tr`    --rule: всегда — ${offers.rule.kind === 'network' ? tr`пускать в сеть к ${offers.rule.label}` : tr`команды, начинающиеся с «${offers.rule.label}»`} ${offers.rule.note}`)
        }
        return done(EXIT.ok)
      }
      case 'approve':
      case 'deny': {
        // `--session` в разборе — флаг со значением (у `events tail`): `perm approve --session p1` отдал бы ему id.
        // Тогда id — это значение флага, а scope — «в сессии».
        const sessionFlag = args.flags.get('session')
        const permId = id ?? (typeof sessionFlag === 'string' ? sessionFlag : undefined)
        if (!permId) { err(tr`pult perm ${args.sub}: нужен id из pult perm list`); return done(EXIT.error) }
        if (typeof sessionFlag === 'string' && id) { err(tr`pult perm ${args.sub}: --session без значения — id уже ${id}`); return done(EXIT.error) }
        const wantSession = sessionFlag !== undefined
        const wantRule = args.flags.has('rule')
        if (wantSession && wantRule) { err(tr('pult perm approve: --session или --rule, не оба')); return done(EXIT.error) }
        if ((wantSession || wantRule) && args.sub !== 'approve') { err(tr('pult perm deny: --session и --rule бывают только у approve')); return done(EXIT.error) }
        const scope = wantSession ? 'session' : wantRule ? 'rule' : undefined
        const r = await client.request('perm.resolve', {
          id: permId,
          decision: args.sub === 'approve' ? 'allow' : 'deny',
          ...(scope ? { scope } : {}),
          ...(flagStr(args, 'reason') !== undefined ? { message: flagStr(args, 'reason') } : {}),
        })
        const how = scope === 'session' ? tr('разрешено в этой сессии') : scope === 'rule' ? tr('разрешено всегда (правило провайдера)') : tr('разрешено')
        out(asJson ? JSON.stringify(r) : `${permId}: ${args.sub === 'approve' ? how : tr('отказано')}`)
        return done(EXIT.ok)
      }
      case 'rules': {
        // План 16, № 11: правила «Всегда» Codex с меткой Пульта; без метки — только счётчиком, их Пульт не трогает.
        if (id === 'revoke') {
          const ruleId = args.positional[3]
          if (!ruleId) { err(tr('pult perm rules revoke: нужен id из pult perm rules')); return done(EXIT.error) }
          const r = (await client.request('perm.rules.revoke', { id: ruleId })) as { revoked: Record<string, unknown>; text?: string }
          out(asJson ? JSON.stringify(r) : `${ruleId}: ${r.text ?? tr`отозвано (${ruleText(r.revoked)})`}`)
          return done(EXIT.ok)
        }
        if (id !== undefined) { err(tr`pult perm rules: неизвестное «${id}» — revoke <id> или ничего`); return done(EXIT.error) }
        const r = (await client.request('perm.rules')) as { path: string; exists: boolean; rules: Array<Record<string, unknown>>; unmarked: number; backup?: string; error?: string }
        if (asJson) { out(JSON.stringify(r)); return done(EXIT.ok) }
        out(tr`файл правил Codex: ${r.path}${r.exists ? '' : tr(' (ещё нет)')}`)
        if (r.error) err(tr`не прочитан: ${r.error}`)
        if (r.backup) {
          const file = r.backup.replace(/\.pult\.bak$/, '')
          err(tr`ВНИМАНИЕ: осталась копия прерванной записи ${r.backup}; до её удаления Пульт файл не правит.`)
          err(tr`  если ${file} пуст или обрезан — mv ${r.backup} ${file}, затем проверь последние строки; иначе удали копию`)
        }
        if (!r.rules.length) out(tr('правил «Всегда», записанных Пультом, нет'))
        for (const x of r.rules) {
          out(tr`${String(x['id'])}  ${String(x['at'])}  сессия ${String(x['session'])}${x['cwd'] ? ` · ${String(x['cwd'])}` : ''}`)
          out(`    ${ruleText(x)}`)
        }
        if (r.unmarked > 0) out(tr`ещё строк правил без метки Пульта: ${r.unmarked} — их Пульт не показывает и не отзывает`)
        if (r.rules.length) out(tr('отозвать: pult perm rules revoke <id>'))
        return done(EXIT.ok)
      }
      default:
        err(tr('pult perm: нужен один из list|approve|deny|rules'))
        return done(EXIT.error)
    }
  } catch (e) {
    if (e instanceof ClientError) {
      err(`pult perm: ${e.code} — ${e.message}`)
      return done(exitForError(e.code))
    }
    throw e
  }
}

async function cmdUsage(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const { client } = await ensureDaemon(paths)
  try {
    const r = (await client.request('usage.get')) as { usage: Array<Record<string, unknown>> }
    if (args.flags.has('json')) { out(JSON.stringify(r)); return EXIT.ok }
    if (!r.usage.length) { out(tr('расхода пока нет')); return EXIT.ok }
    for (const u of r.usage) {
      const rl = u['rateLimit'] as { windows?: { five_hour?: { utilization?: number }; seven_day?: { utilization?: number } } } | null
      const pct = (v: number | undefined): string => (typeof v === 'number' ? `${Math.round(v * 100)} %` : '—')
      out(tr`${String(u['session']).padEnd(16)} ходов ${String(u['turns']).padStart(3)} · $${Number(u['totalCostUsd']).toFixed(4)} · `
        + tr`вход ${String(u['inputTokens'])} / выход ${String(u['outputTokens'])} / кэш ${String(u['cacheReadTokens'])}`)
      out(tr`    окна лимита: 5 часов ${pct(rl?.windows?.five_hour?.utilization)} · 7 дней ${pct(rl?.windows?.seven_day?.utilization)}`)
    }
    return EXIT.ok
  } finally {
    client.close()
  }
}

async function cmdProvider(paths: PultPaths, args: ParsedArgs): Promise<number> {
  if (args.sub !== 'reset') { err(tr('pult provider: в Ф1 есть только reset')); return EXIT.error }
  const { client } = await ensureDaemon(paths)
  try {
    const r = (await client.request('provider.reset', { provider: args.positional[2] ?? 'claude' })) as Record<string, unknown>
    out(args.flags.has('json')
      ? JSON.stringify(r)
      : r['was'] ? tr`остановка провайдера ${String(r['provider'])} снята` : tr`провайдер ${String(r['provider'])} и так не был остановлен`)
    return EXIT.ok
  } finally {
    client.close()
  }
}

/**
 * Служебный режим: stdio-MCP-заглушка разрешений. Запускается НЕ человеком, а самим `claude`
 * по файлу `--mcp-config`, который пишет адаптер. PULT_HOME приходит через env того файла.
 */
function cmdMcpAsk(paths: PultPaths): Promise<number> {
  const sessionName = process.env['PULT_ASK_SESSION'] ?? 'unknown'
  const askKey = process.env['PULT_ASK_KEY']
  runMcpAsk(stdioIo(), (a) => askDaemon(paths, sessionName, askKey, a))
  // Процесс живёт, пока `claude` держит его stdin открытым.
  return new Promise<number>((resolve) => { process.stdin.on('end', () => resolve(EXIT.ok)) })
}

async function cmdDoctor(paths: PultPaths, args: ParsedArgs): Promise<number> {
  ensureLayout(paths)
  const { config, warnings } = loadConfig(paths.config)
  for (const w of warnings) err(`config: ${w}`)
  const test = process.env['PULT_TEST'] === '1'
  const report = await runDoctor({
    paths,
    config,
    skipNet: args.flags.has('no-net'),
    daemonStatus: () => tryStatus(paths),
    serviceItems: () => serviceDoctorItems(paths, process.env),
    versionItems: (st) => versionDoctorItems(paths, st),
    mcpItems: async (st) => [
      ...browserDoctorItems({ paths, wanted: st?.browser?.sessions ?? null, chrome: test ? null : findChrome() }),
      ...(await mcpDoctorItems(test ? join(paths.home, 'claude.json') : join(homedir(), '.claude.json'), config.mcp.servers)),
      ...bypassDoctorItems(claudeDefaultMode([test ? join(paths.home, 'claude-settings.json') : join(homedir(), '.claude', 'settings.json')]), st?.browser?.sessions ?? 0),
    ],
    ...(test ? { locate: testLocate, pathEntries: (process.env['PATH'] ?? '').split(':').filter(Boolean) } : {}),
    // 0.3.7: сеть в песочнице Codex (тест — файл в PULT_HOME, config.toml машины не читается).
    codexConfig: test ? join(paths.home, 'codex-config.toml') : codexConfigPath(),
  })
  out(args.flags.has('json') ? JSON.stringify(report, null, 2) : formatDoctor(report))
  if (report.ok) return EXIT.ok
  const netFail = report.items.some((i) => (i.id.startsWith('net.') || i.id === 'guard.rule') && i.status === 'fail')
  return netFail ? EXIT.netBlocked : EXIT.error
}

/**
 * `pult ui`. Демона не трогает: окно поднимает его само тем же `ensureDaemon`, что и CLI.
 */
async function cmdUi(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const plan = planUi({
    env: process.env,
    platform: process.platform,
    selfRoot: fileURLToPath(new URL('../..', import.meta.url)),
    // Окно поднимает демона этим node, если службы нет: свой node Пульта, иначе node этого CLI.
    nodePath: daemonNode(paths.runtimeActive),
    dev: args.flags.has('dev'),
    fs: {
      isDir: (p) => { try { return statSync(p).isDirectory() } catch { return false } },
      isFile: (p) => { try { return statSync(p).isFile() } catch { return false } },
      read: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
    },
  })
  if (plan.kind === 'none') { err(`pult ui: ${plan.hint}`); return EXIT.error }
  if (args.flags.has('print')) { out(describePlan(plan)); return EXIT.ok }
  try {
    await launchUi(plan, process.env)
  } catch (e) {
    err(tr`pult ui: окно не запустилось — ${(e as Error).message}`)
    return EXIT.error
  }
  out(plan.kind === 'app' ? tr`окно открыто: ${plan.app}` : tr`окно открыто из рабочей копии: ${plan.root}`)
  return EXIT.ok
}

/**
 * `pult update`. Без режима — канал обновлений (channel.ts, M8c): latest.json из релизов GitHub, подпись,
 * тарбол, дальше тот же путь, что `--from`. `--check` — только сказать, есть ли что ставить.
 */
async function cmdUpdate(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const opts = { reinstall: args.flags.has('reinstall'), json: args.flags.has('json') }
  const from = args.flags.get('from')
  const to = args.flags.get('to')
  const app = args.flags.has('app')
  const stage = args.flags.has('stage')
  const modes = [from !== undefined, to !== undefined, args.flags.has('list'), args.flags.has('check') && !app, app, stage].filter(Boolean).length
  if (modes > 1) { err(tr('pult update: --from, --to, --list, --check, --stage и --app — по одному за раз')); return EXIT.error }
  // `--force`: у окна — ставить и «плохую» версию; у пакета (канал, --from, --to) — не ждать конца идущих ходов.
  if (args.flags.has('force') && (args.flags.has('list') || args.flags.has('check'))) { err(tr('pult update: --force — не с --list и --check')); return EXIT.error }
  if (args.flags.has('rollback') && !app) { err(tr('pult update: --rollback — только вместе с --app')); return EXIT.error }
  if (app && args.flags.has('check')) { err(tr('pult update --app: проверить окно — pult update --check (строка «окно: …»)')); return EXIT.error }
  // 0.3.4: окно — через демона (он закрывает окно, меняет Pult.app и ждёт hello нового), сессии не трогаются.
  if (app) return updateAppCli(cliIo, { force: args.flags.has('force'), rollback: args.flags.has('rollback'), connect: async () => (await ensureDaemon(paths)).client })
  if (args.flags.has('list')) return updateList(paths, cliIo, opts)
  if (args.flags.has('check')) return updateCheck(paths, cliIo, { json: opts.json })
  // 0.3.16: фоновая подготовка — демона и ходы не трогает, ждать их незачем.
  if (stage) return updateStage(paths, cliIo)
  // Как «Обновить» в окне: идущий ход не обрывается молча. `--expect` зовёт сам демон — он уже дождался ходов.
  if (args.flags.get('expect') === undefined && await refuseRunningTurns(paths, cliIo, { force: args.flags.has('force') })) return EXIT.error
  if (from !== undefined) {
    if (typeof from !== 'string' || !from) { err(tr('pult update --from: нужен путь к тарболу pult-x.y.z.tgz')); return EXIT.error }
    return updateFrom(paths, cliIo, from, opts)
  }
  if (to !== undefined) {
    if (typeof to !== 'string' || !to) { err(tr('pult update --to: нужна версия (что есть на диске — pult update --list)')); return EXIT.error }
    return updateTo(paths, cliIo, to, opts)
  }
  if (opts.reinstall) { err(tr('pult update: --reinstall — только вместе с --from')); return EXIT.error }
  // `--expect <версия>` ставит «Обновить» из окна: ребёнок ставит ровно то, что видел человек.
  const expect = args.flags.get('expect')
  if (expect !== undefined && (typeof expect !== 'string' || !expect)) { err(tr('pult update --expect: нужна версия')); return EXIT.error }
  return updateLatest(paths, cliIo, typeof expect === 'string' ? { expect } : {})
}

/**
 * `pult browser [--json]` и `pult browser install` (О3, src/mcp/browser.ts). Установка — здесь же, без демона:
 * тот же код, что у демона, под тем же `run/mcp-install.lock`.
 */
async function cmdBrowser(paths: PultPaths, args: ParsedArgs): Promise<number> {
  ensureLayout(paths)
  if (args.sub === 'install') {
    try {
      const r = await installBrowser(paths, { progress: (s) => err(s) })
      out(r.installed ? tr`${PLAYWRIGHT_MCP_PACKAGE} ${r.version} поставлен: ${r.path}` : tr`${PLAYWRIGHT_MCP_PACKAGE} ${r.version} уже стоит: ${r.path}`)
      if (!findChrome()) err(tr('Google Chrome не найден — браузер агента работает на системном Chrome: поставь его в /Applications'))
      return EXIT.ok
    } catch (e) {
      if (!(e instanceof BrowserInstallError)) throw e
      err(`pult browser install: ${e.message}`)
      return EXIT.error
    }
  }
  if (args.sub !== null && args.sub !== 'status') { err(tr('pult browser: нужен один из status|install')); return EXIT.error }
  const st = await tryStatus(paths)
  const chrome = findChrome()
  const report = {
    installed: browserInstalled(paths),
    version: PLAYWRIGHT_MCP_VERSION,
    path: browserPrefix(paths),
    chrome,
    daemon: st?.browser ?? null,
  }
  if (args.flags.has('json')) { out(JSON.stringify(report)); return EXIT.ok }
  for (const it of browserDoctorItems({ paths, ...(st?.browser ? { state: installStateOf(st.browser) } : {}), wanted: st?.browser?.sessions ?? null, chrome })) {
    out(`[${it.status === 'ok' ? 'ok  ' : 'warn'}] ${it.title}: ${it.detail}`)
  }
  return EXIT.ok
}

/** `pult mcp list|select` (О3, src/mcp/servers.ts) — через демона: выбор живёт в его config.json. */
/**
 * `pult net guard` (0.3.6): показать или сменить правило стража страны выхода. Смена идёт через `settings.set`
 * демона — тот же строгий разбор, что у окна, запись только `network.guard`, действует со следующего хода.
 */
async function cmdNet(paths: PultPaths, args: ParsedArgs): Promise<number> {
  if (args.sub !== 'guard') { err(tr('pult net: есть только guard — pult net guard [--deny RU,BY | --allow DE,FI] [--json]')); return EXIT.error }
  const deny = args.flags.get('deny')
  const allow = args.flags.get('allow')
  if (deny !== undefined && allow !== undefined) { err(tr('pult net guard: либо --deny, либо --allow')); return EXIT.error }
  const raw = deny ?? allow
  if (raw === true) { err(tr`pult net guard: --${deny !== undefined ? 'deny' : 'allow'} — список кодов стран через запятую, например DE,FI`); return EXIT.error }
  let next: GuardRule | null = null
  if (typeof raw === 'string') {
    const countries = raw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
    try { next = parseGuardStrict({ mode: deny !== undefined ? 'deny' : 'allow', countries }) } catch (e) {
      if (e instanceof GuardError) { err(`pult net guard: ${e.message}`); return EXIT.error }
      throw e
    }
  }
  const { client } = await ensureDaemon(paths)
  try {
    const r = (next
      ? await client.request('settings.set', { network: { guard: next } })
      : await client.request('settings.get')) as { network?: { guard?: GuardRule; exits?: Record<string, { loc?: string | null; reason?: string } | undefined> } }
    const rule = r.network?.guard
    if (!rule) { err(tr('pult net guard: демон старше 0.3.6 не знает правила стража — перезапусти его новой версией')); return EXIT.error }
    const exits = r.network?.exits ?? {}
    if (args.flags.has('json')) { out(JSON.stringify({ guard: rule, exits })); return EXIT.ok }
    out(tr`страж сети: ${guardLine(rule)}${next ? tr(' — со следующего хода') : ''}`)
    // Последний известный выход провайдеров (из уже сделанных проверок, без новой пробы) — под этим правилом.
    for (const [provider, e] of Object.entries(exits)) {
      if (!e) continue
      out(e.loc
        ? tr`  ${provider}: выход ${e.loc} — ${guardVerdict(rule, e.loc).ok ? tr('проходит') : tr('не проходит')}`
        : tr`  ${provider}: выход неизвестен (${e.reason ?? tr('нет ответа')}) — не проходит`)
    }
    return EXIT.ok
  } catch (e) {
    if (e instanceof ClientError) { err(`pult net guard: ${e.code} — ${e.message}`); return exitForError(e.code) }
    throw e
  } finally {
    client.close()
  }
}

async function cmdMcp(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const asJson = args.flags.has('json')
  if (args.sub !== 'list' && args.sub !== 'select') { err(tr('pult mcp: нужен один из list|select')); return EXIT.error }
  const { client } = await ensureDaemon(paths)
  try {
    if (args.sub === 'list') {
      const r = (await client.request('mcp.list')) as { servers: Array<{ name: string; transport: string; detail: string }>; selected: string[]; missing: string[]; warnings: string[] }
      if (asJson) { out(JSON.stringify(r)); return EXIT.ok }
      for (const w of r.warnings) err(w)
      if (!r.servers.length) out(tr('в ~/.claude.json своих MCP-серверов нет (серверы проекта .mcp.json — позже)'))
      for (const sv of r.servers) out(`${r.selected.includes(sv.name) ? '●' : '·'} ${sv.name.padEnd(24)} ${sv.transport.padEnd(5)} ${sv.detail}`)
      if (r.missing.length) out(tr`выбраны, но в ~/.claude.json их нет — не подключаются: ${r.missing.join(', ')}`)
      return EXIT.ok
    }
    const names = args.positional.slice(2)
    if (!names.length && !args.flags.has('none')) { err(tr('pult mcp select <имя> [<имя>…] — или --none, чтобы не подключать ни одного')); return EXIT.error }
    if (names.length && args.flags.has('none')) { err(tr('pult mcp select: либо имена, либо --none')); return EXIT.error }
    const r = (await client.request('mcp.select', { names })) as { selected: string[] }
    if (asJson) { out(JSON.stringify(r)); return EXIT.ok }
    out(r.selected.length ? tr`к сессиям Claude подключаются: ${r.selected.join(', ')} — со следующего хода` : tr('свои MCP-серверы не подключаются'))
    return EXIT.ok
  } catch (e) {
    if (e instanceof ClientError) { err(`pult mcp: ${e.code} — ${e.message}`); return exitForError(e.code) }
    throw e
  } finally {
    client.close()
  }
}

/** `pult runtime [--json]` | `pult runtime install [--from <тарбол node>]` — src/update/runtimeCli.ts. */
async function cmdRuntime(paths: PultPaths, args: ParsedArgs): Promise<number> {
  const pkgRoot = packageRoot()
  if (args.sub === null || args.sub === 'status') {
    return runtimeShow(paths, cliIo, { pkgRoot, json: args.flags.has('json') })
  }
  if (args.sub === 'install') {
    const from = args.flags.get('from')
    if (from !== undefined && (typeof from !== 'string' || !from)) { err(tr('pult runtime install --from: нужен путь к тарболу node')); return EXIT.error }
    return runtimeInstall(paths, cliIo, { pkgRoot, ...(typeof from === 'string' ? { from } : {}) })
  }
  err(tr('pult runtime: нужен один из status|install'))
  return EXIT.error
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const paths = resolvePaths(process.env)

  // Порядок важен: у `pult --version` глагола нет, и проверка «глагола нет → справка»,
  // стоящая раньше, съела бы флаг.
  if (args.flags.has('version') || args.flags.has('v') || args.verb === 'version') {
    out(VERSION)
    return EXIT.ok
  }
  if (args.flags.has('help') || args.flags.has('h') || args.verb === 'help') {
    out(HELP)
    return EXIT.ok
  }
  if (args.verb === null) {
    out(HELP)
    return EXIT.error
  }

  switch (args.verb) {
    case 'daemon': {
      switch (args.sub) {
        case 'start': return cmdDaemonStart(paths, args)
        case 'status': return cmdDaemonStatus(paths, args)
        case 'stop': return cmdDaemonStop(paths, args)
        case 'logs': return cmdDaemonLogs(paths, args)
        case 'install': return cmdDaemonInstall(paths, args)
        case 'uninstall': return cmdDaemonUninstall(paths)
        default:
          err(tr('pult daemon: нужен один из start|status|stop|logs|install|uninstall'))
          return EXIT.error
      }
    }
    case 'events': {
      if (args.sub !== 'tail') {
        err(tr('pult events: в В1 есть только tail'))
        return EXIT.error
      }
      return cmdEventsTail(paths, args)
    }
    // `session` — имя из окна (07.10.2026: «агенты» стали «сессиями»); `agent` остаётся рабочим
    // синонимом: скрипты и привычка не ломаются.
    case 'session':
    case 'agent':
      return cmdAgent(paths, args)
    case 'perm':
      return cmdPerm(paths, args)
    case 'usage':
      return cmdUsage(paths, args)
    case 'provider':
      return cmdProvider(paths, args)
    case 'mcp-ask':
      return cmdMcpAsk(paths)
    case 'doctor':
      return cmdDoctor(paths, args)
    case 'update':
      return cmdUpdate(paths, args)
    case 'ui':
      return cmdUi(paths, args)
    case 'runtime':
      return cmdRuntime(paths, args)
    case 'browser':
      return cmdBrowser(paths, args)
    case 'mcp':
      return cmdMcp(paths, args)
    case 'net':
      return cmdNet(paths, args)
    default:
      err(tr`неизвестная команда: ${args.verb}\n\n${HELP}`)
      return EXIT.error
  }
}

/**
 * process.exit() обрывает процесс НЕМЕДЛЕННО, и всё, что ещё лежит в буфере stdout, пропадает.
 * На трубе (`pult doctor --json | …`) это молчаливое обрезание последних байт. Поэтому перед
 * выходом ждём, пока поток действительно сольётся; страховка на случай читателя, который
 * ушёл, не дочитав, — чтобы CLI не повис навсегда.
 */
function flush(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0 || stream.destroyed) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(resolve, 2000)
    timer.unref?.()
    stream.once('error', done)
    try { stream.write('', () => done()) } catch { done() }
  })
}

async function exit(code: number): Promise<never> {
  process.exitCode = code
  await flush(process.stdout)
  await flush(process.stderr)
  // Явный выход: подписка и сокет могли оставить открытые дескрипторы.
  process.exit(code)
}

async function main(): Promise<void> {
  try {
    await exit(await run(process.argv.slice(2)))
  } catch (e) {
    if (e instanceof ClientError) {
      err(`pult: ${e.code} — ${e.message}`)
      await exit(e.code === 'timeout' ? EXIT.timeout : EXIT.error)
    }
    err(`pult: ${(e as Error).message}`)
    await exit(EXIT.error)
  }
}

void main()
