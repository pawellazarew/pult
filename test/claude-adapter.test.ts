// Адаптер Claude на ФАЛЬШИВОМ CLI, который проигрывает записанные потоки.
// Ни одного настоящего хода, ни одного обращения в сеть: страж инъецируется.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createClaudeAdapter } from '../dist/adapters/claude/adapter.js'
import type { ProviderAdapter } from '../dist/adapters/types.js'
import { defaultConfig, validateConfig } from '../dist/core/config.js'
import type { PultConfig } from '../dist/core/config.js'
import type { EventDraft } from '../dist/core/events.js'
import { createLogger } from '../dist/core/log.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import { checkNetwork } from '../dist/env/net.js'
import type { NetCheck } from '../dist/env/net.js'
import { stableNodePath } from '../dist/env/nodeBin.js'
import { createAskKeys } from '../dist/perm/askKeys.js'
import type { AskKeys } from '../dist/perm/askKeys.js'
import { CLI_ENTRY, FAKE_CLAUDE, sleep, waitFor } from './helpers.js'

interface Rig {
  adapter: ProviderAdapter
  drafts: EventDraft[]
  cwd: string
  argvFile: string
  /** Все запуски фальшивого CLI: argv, cwd, окружение. */
  runs(): Array<{ argv: string[]; cwd: string; env: Record<string, string>; pid: number }>
  /**
   * Переписать настройку фальшивого CLI перед следующим ходом. В режиме «процесс на ход»
   * каждый ход — новый процесс, и он читает файл заново: так один тест играет несколько
   * разных ответов подряд, не заводя второго стенда.
   */
  retune(cfg: Record<string, unknown>): void
  remove(): void
}

const okCheck = (over: Partial<NetCheck> = {}): NetCheck => ({
  provider: 'claude', mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true,
  reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1,
  checkedAt: '2026-09-21T10:00:00.000Z', cached: false, ...over,
})

function rig(opts: {
  scenario: string
  config?: Partial<PultConfig>
  net?: (provider: 'claude') => Promise<NetCheck>
  speed?: number
  /** Путь к бинарю: тест «спавн не удался» подсовывает сюда несуществующий файл. */
  bin?: string
  /** Фальшивый CLI глохнет к SIGINT/SIGTERM — проверка лестницы до SIGKILL. */
  deaf?: boolean
  /** Фальшивый CLI не выходит по закрытию stdin — проверка добивающего сигнала. */
  keepAlive?: boolean
  /** Мс тишины перед первым событием: так ход гарантированно ещё идёт, когда его рвут. */
  hang?: number
  /** Мс тишины СРАЗУ ПОСЛЕ `system/init`: стоп в этом окне разговор уже оставляет. */
  hangAfterInit?: number
  /** Node демона: тест «brew upgrade удалил node» подсовывает несуществующий путь. */
  nodeExec?: string
  /** Содержимое PULT_HOME/node-path (его пишет лаунчер службы). */
  savedNode?: string
  /** 0.3.7: ключи вопросов (тест следит, когда выдан и снят). */
  askKeys?: AskKeys
}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'pt-ad-'))
  const paths = layout(join(dir, 'h'))
  ensureLayout(paths)
  if (opts.savedNode) writeFileSync(paths.nodePath, `${opts.savedNode}\n`)
  const cwd = join(dir, 'work')
  rmSync(cwd, { recursive: true, force: true })
  writeFileSync(join(dir, 'unused'), '')
  const argvFile = join(dir, 'argv.jsonl')
  // Папка сессии: тут же лежит настройка фальшивого CLI — через окружение она не пройдёт,
  // окружение ребёнка строится по белому списку.
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({
    scenario: opts.scenario, argvOut: argvFile, speed: opts.speed ?? 0,
    ...(opts.deaf ? { deaf: '1' } : {}),
    ...(opts.keepAlive ? { keepAlive: '1' } : {}),
    ...(opts.hang ? { hang: opts.hang } : {}),
    ...(opts.hangAfterInit ? { hangAfterInit: opts.hangAfterInit } : {}),
  }))
  const drafts: EventDraft[] = []
  const adapter = createClaudeAdapter({
    paths,
    config: { ...defaultConfig(), ...(opts.config ?? {}) },
    logger: createLogger(paths.logFile),
    bin: opts.bin ?? FAKE_CLAUDE,
    cliEntry: CLI_ENTRY,
    ...(opts.nodeExec ? { nodeExec: opts.nodeExec } : {}),
    ...(opts.askKeys ? { askKeys: opts.askKeys } : {}),
    emit: (d) => { drafts.push(d) },
    askPermission: async () => ({ behavior: 'deny', message: 'тест' }),
    ...(opts.net ? { netCheck: opts.net } : { netCheck: async () => okCheck() }),
  })
  return {
    adapter, drafts, cwd, argvFile,
    runs: () => (existsSync(argvFile)
      ? readFileSync(argvFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as never)
      : []),
    retune: (cfg) => {
      writeFileSync(join(cwd, '.pult-fake.json'), JSON.stringify({ argvOut: argvFile, speed: 0, ...cfg }))
    },
    remove: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}

const spec = (r: Rig, over: Record<string, unknown> = {}) => ({
  name: 'w', cwd: r.cwd, model: 'haiku', effort: 'low', mode: 'turn' as const,
  settingSources: 'user', broker: false, ...over,
})

describe('адаптер claude: контракт запуска', () => {
  it('argv ребёнка — измеренный набор; реплики в argv НЕТ; без брокера --permission-prompts none', async () => {
    const r = rig({ scenario: 'simple' })
    try {
      const started = await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'СЕКРЕТНАЯ РЕПЛИКА про деньги')
      await turn.done
      const runs = r.runs()
      assert.equal(runs.length, 1)
      const argv = runs[0]!.argv
      assert.equal(argv[0], '-p')
      assert.ok(argv.includes('--input-format') && argv.includes('stream-json'))
      assert.ok(argv.includes('--include-partial-messages'))
      assert.ok(argv.includes('--forward-subagent-text'))
      assert.equal(argv[argv.indexOf('--session-id') + 1], started.providerSessionId)
      assert.equal(argv[argv.indexOf('--model') + 1], 'haiku')
      assert.equal(argv[argv.indexOf('--effort') + 1], 'low')
      assert.equal(argv[argv.indexOf('--permission-prompts') + 1], 'none')
      assert.ok(!argv.includes('--mcp-config'))
      // ГЛАВНОЕ: реплики в argv нет ни в каком виде.
      assert.ok(!argv.some((a) => a.includes('СЕКРЕТНАЯ')), argv.join(' '))
      assert.equal(runs[0]!.cwd, realpathSync(r.cwd))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('с брокером: --permission-prompts host, --mcp-config <файл> и mcp__pult__ask', async () => {
    const r = rig({ scenario: 'simple' })
    try {
      await r.adapter.startSession(spec(r, { broker: true }))
      await (await r.adapter.send('w', 'привет')).done
      const argv = r.runs()[0]!.argv
      assert.equal(argv[argv.indexOf('--permission-prompts') + 1], 'host')
      assert.equal(argv[argv.indexOf('--permission-prompt-tool') + 1], 'mcp__pult__ask')
      const cfgPath = argv[argv.indexOf('--mcp-config') + 1] as string
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, { args: string[] }> }
      assert.deepEqual(cfg.mcpServers['pult']?.args, [CLI_ENTRY, 'mcp-ask'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('0.3.7: ключ вопросов — на процесс: выдан перед запуском, в файле --mcp-config, снят на выходе процесса', async () => {
    const inner = createAskKeys()
    const log: string[] = []
    const keys: AskKeys = {
      mint: (s) => { const k = inner.mint(s); log.push(`mint ${s} ${k}`); return k },
      lookup: (k) => inner.lookup(k),
      revoke: (k) => { const ok = inner.revoke(k); if (ok) log.push(`revoke ${k}`); return ok },
      revokeSession: (n) => inner.revokeSession(n),
      size: () => inner.size(),
    }
    const r = rig({ scenario: 'simple', askKeys: keys })
    try {
      await r.adapter.startSession(spec(r, { broker: true }))
      await (await r.adapter.send('w', 'привет')).done
      const key = (log[0] ?? '').split(' ')[2] as string
      assert.match(log[0] ?? '', /^mint w [0-9a-f]{64}$/)
      assert.ok(await waitFor(() => inner.size() === 0, 5000), `ключ не снят после выхода процесса: ${log.join(' | ')}`)
      assert.deepEqual(log, [`mint w ${key}`, `revoke ${key}`])
      // Следующий ход — новый процесс и новый ключ; прежний не воскресает.
      await (await r.adapter.send('w', 'ещё')).done
      assert.ok(await waitFor(() => inner.size() === 0, 5000))
      assert.equal(log.filter((l) => l.startsWith('mint')).length, 2)
      assert.notEqual(log[2]?.split(' ')[2], key)
      const argv = r.runs()[1]!.argv
      const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] as string) as { permissions: { deny: string[] } }
      assert.ok(settings.permissions.deny.some((d) => /^Read\(\/\/.*\/h\/run\/\*\*\)$/.test(d)), settings.permissions.deny.join(' '))
      // 0.3.8: картинки из буфера окна — в --add-dir только папка ЭТОЙ сессии (PULT_HOME/attachments/w, заведена), не deny.
      const addDir = argv[argv.indexOf('--add-dir') + 1] ?? ''
      assert.ok(argv.includes('--add-dir') && /\/h\/attachments\/w$/.test(addDir), argv.join(' '))
      assert.ok(existsSync(addDir), 'папка attachments заведена до спавна')
      assert.ok(!settings.permissions.deny.some((d) => d.includes('attachments')))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ревью #16: spawn бросил после выдачи ключа — ключ снят, файл убран, сессия не «занята»', async () => {
    const keys = createAskKeys()
    const r = rig({ scenario: 'simple', askKeys: keys })
    try {
      // Нулевой байт в аргументе — spawn отказывает синхронно (ERR_INVALID_ARG_VALUE).
      await r.adapter.startSession(spec(r, { broker: true, model: 'hai\u0000ku' }))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'internal')
      assert.match(String(outcome.message), /claude не запустился/)
      assert.equal(keys.size(), 0, 'ключ брошенного запуска снят')
      assert.equal(r.runs().length, 0)
      // Сессия не залипла в «занята»: следующий ход отвечает не «уже делает ход».
      const again = await (await r.adapter.send('w', 'ещё')).done
      assert.doesNotMatch(String(again.message ?? ''), /уже делает ход/)
      assert.equal(keys.size(), 0)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ревью #16: close снимает все ключи сессии (имя переиспользуемо)', async () => {
    const keys = createAskKeys()
    const r = rig({ scenario: 'simple', askKeys: keys })
    try {
      await r.adapter.startSession(spec(r, { broker: true }))
      keys.mint('w'); keys.mint('other')
      await r.adapter.close('w')
      assert.equal(keys.size(), 1)
      keys.mint('gone')
      await r.adapter.close('gone')
      assert.equal(keys.size(), 1, 'сессии нет в адаптере — ключи по имени всё равно сняты')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('brew upgrade удалил node демона: заглушка идёт на живом node из node-path', async () => {
    const r = rig({ scenario: 'simple', nodeExec: '/нет/Cellar/node/26.10.0_2/bin/node', savedNode: process.execPath })
    try {
      await r.adapter.startSession(spec(r, { broker: true }))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, true)
      const argv = r.runs()[0]!.argv
      const cfgPath = argv[argv.indexOf('--mcp-config') + 1] as string
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, { command: string }> }
      assert.equal(cfg.mcpServers['pult']?.command, stableNodePath(process.execPath))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('живого node нет нигде: ход отказывает понятными словами, claude не запущен, сессия не заперта', async () => {
    const r = rig({ scenario: 'simple', nodeExec: '/нет/Cellar/node/26.10.0_2/bin/node' })
    try {
      await r.adapter.startSession(spec(r, { broker: true }))
      for (let i = 0; i < 2; i++) {
        const outcome = await (await r.adapter.send('w', 'привет')).done
        assert.equal(outcome.ok, false)
        assert.equal(outcome.errorCode, 'internal')
        assert.match(outcome.message ?? '', /нечем запустить заглушку разрешений/)
      }
      assert.equal(r.runs().length, 0)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ИНВАРИАНТ 1: ни одной ANTHROPIC_*/CLAUDE_* переменной родителя в окружении ребёнка', async () => {
    const r = rig({ scenario: 'simple' })
    const saved = { ...process.env }
    process.env['ANTHROPIC_BASE_URL'] = 'https://подменённый.example.com'
    process.env['CLAUDE_CODE_MESSAGING_SOCKET'] = '/tmp/чужая.sock'
    process.env['CLAUDE_CODE_OAUTH_SCOPES'] = 'всё'
    try {
      await r.adapter.startSession(spec(r))
      await (await r.adapter.send('w', 'привет')).done
      const env = r.runs()[0]!.env
      const leaked = Object.keys(env).filter((k) => /^(ANTHROPIC|CLAUDE)/i.test(k))
      assert.deepEqual(leaked, [], `утекли: ${leaked.join(', ')}`)
      assert.ok(env['PATH'], 'PATH обязан быть')
      assert.ok(env['HOME'], 'HOME обязан быть')
    } finally {
      process.env = saved
      await r.adapter.shutdown(); r.remove()
    }
  })
})

describe('адаптер claude: режимы', () => {
  it('процесс на ход: второй ход идёт с --resume и ТЕМ ЖЕ uuid, процессы разные', async () => {
    const r = rig({ scenario: 'resume' })
    try {
      const started = await r.adapter.startSession(spec(r))
      await (await r.adapter.send('w', 'запомни кодовое слово')).done
      await (await r.adapter.send('w', 'какое кодовое слово?')).done
      const runs = r.runs()
      assert.equal(runs.length, 2, 'на каждый ход свой процесс')
      assert.notEqual(runs[0]!.pid, runs[1]!.pid)
      // Первый ход идёт с нашим uuid…
      assert.equal(runs[0]!.argv[runs[0]!.argv.indexOf('--session-id') + 1], started.providerSessionId)
      // …а дальше адаптер берёт uuid, который назвал САМ CLI в system/init, и возобновляет
      // именно его. В бою это тот же uuid; в фикстуре — записанный при съёмке.
      const reported = (r.drafts.find((d) => d.kind === 'session.started')!.data as { providerSessionId: string }).providerSessionId
      assert.ok(!runs[1]!.argv.includes('--session-id'))
      assert.equal(runs[1]!.argv[runs[1]!.argv.indexOf('--resume') + 1], reported)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('--warm: второй ход идёт в ТОТ ЖЕ процесс (один запуск на два хода)', async () => {
    const r = rig({ scenario: 'warm' })
    try {
      await r.adapter.startSession(spec(r, { mode: 'warm' }))
      await (await r.adapter.send('w', 'запомни 41')).done
      await (await r.adapter.send('w', 'какое число?')).done
      assert.equal(r.runs().length, 1, 'тёплый процесс переиспользуется')
      const texts = r.drafts.filter((d) => d.kind === 'message.done').map((d) => (d.data as { text: string }).text)
      assert.ok(texts.includes('41'))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('жнец снимает тёплый процесс по warmTtlMs и следующий ход поднимает новый', async () => {
    const r = rig({ scenario: 'warm', config: { warmTtlMs: 120 } })
    try {
      await r.adapter.startSession(spec(r, { mode: 'warm' }))
      await (await r.adapter.send('w', 'запомни 41')).done
      assert.ok(await waitFor(() => r.drafts.some(
        (d) => d.kind === 'status.changed' && (d.data as { reason?: string }).reason === 'warm_ttl',
      ), 3000), 'жнец должен был сработать')
      await (await r.adapter.send('w', 'какое число?')).done
      assert.equal(r.runs().length, 2, 'после жнеца поднимается новый процесс')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('адаптер claude: защиты', () => {
  it('страж сети отказывает ДО спавна: ни одного дочернего процесса', async () => {
    const r = rig({
      scenario: 'simple',
      net: async () => okCheck({ ok: false, reason: 'blocked_country', loc: 'RU', path: 'none' }),
    })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'blocked_network')
      assert.deepEqual(r.runs(), [], 'дочерний процесс не должен был запускаться')
      assert.ok(r.drafts.some((d) => d.kind === 'net.blocked'))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ЗАКРЫТО: `required` без прокси в config.json — ход отказан с понятной причиной, прямой путь не пробуется', async () => {
    const { config } = validateConfig({ version: 1, network: { claude: { mode: 'required' } } })
    let probes = 0
    const r = rig({
      scenario: 'simple',
      net: (p) => checkNetwork(p, config.network[p], config.guard, { fresh: true, probe: async () => { probes++; return { status: 0, stdout: 'loc=FI', stderr: '' } } }),
    })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'blocked_network')
      assert.match(String(outcome.message), /no_proxy — network\.claude\.mode = "required", а proxy не задан; ход запрещён/)
      assert.equal(probes, 0, 'ни прокси, ни прямой путь не пробовались')
      assert.deepEqual(r.runs(), [])
      assert.equal((r.drafts.find((d) => d.kind === 'net.blocked')?.data as { reason?: string } | undefined)?.reason, 'no_proxy')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('страж с неизвестной страной тоже запрещает ход', async () => {
    const r = rig({
      scenario: 'simple',
      net: async () => okCheck({ ok: false, reason: 'unknown_location', loc: null, path: 'none' }),
    })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.errorCode, 'blocked_network')
      assert.deepEqual(r.runs(), [])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('шторм api_retry: ход прерван на третьем повторе, событие net.blocked', async () => {
    const r = rig({ scenario: 'api-retry' })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'blocked_network')
      assert.match(String(outcome.message), /3 подряд system\/api_retry/)
      const blocked = r.drafts.find((d) => d.kind === 'net.blocked')
      assert.ok(blocked)
      assert.equal((blocked.data as { reason: string }).reason, 'api_retry_storm')
      assert.equal((blocked.data as { retries: number }).retries, 3)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('блок аккаунта останавливает ВЕСЬ провайдер; повторов нет, снимает только reset', async () => {
    const r = rig({ scenario: 'account-block' })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.errorCode, 'provider_unavailable')
      assert.ok(r.drafts.some((d) => d.kind === 'provider.blocked'))
      assert.equal(r.adapter.blocked().blocked, true)

      // Пока провайдер остановлен, новые сессии не заводятся и ходы не делаются.
      await assert.rejects(() => r.adapter.startSession(spec(r, { name: 'w2' })))
      const again = await (await r.adapter.send('w', 'ещё раз')).done
      assert.equal(again.errorCode, 'provider_unavailable')
      assert.equal(r.runs().length, 1, 'после остановки ни одного нового запуска')

      r.adapter.reset()
      assert.equal(r.adapter.blocked().blocked, false)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('не залогинен: ход неуспешен, провайдер НЕ останавливается', async () => {
    const r = rig({ scenario: 'not-logged-in' })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, false)
      assert.equal(r.adapter.blocked().blocked, false)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('пока фоновая задача идёт, реплика уходит в ТОТ ЖЕ процесс; итоги задач доходят; без задач процесс уходит', async () => {
    const r = rig({ scenario: 'background-live', config: { subagentGraceMs: 400 } })
    try {
      await r.adapter.startSession(spec(r))
      const first = await (await r.adapter.send('w', 'запусти фоновую задачу')).done
      assert.equal(first.text, 'STARTED')
      const pid = r.runs()[0]!.pid
      assert.ok(alive(pid), 'процесс снят при живой фоновой задаче — её работа пропала бы')
      const second = await (await r.adapter.send('w', 'Reply with exactly PONG.')).done
      assert.equal(second.text, 'PONG')
      assert.equal(r.runs().length, 1, 'вторая реплика подняла новый процесс вместо живого')
      assert.ok(await waitFor(() => r.drafts.some((d) => d.kind === 'message.done' && /SUB-DONE/.test(String((d.data as { text?: unknown }).text))), 5000),
        'итог фонового субагента не дошёл до журнала')
      // `SUB-DONE` впервые приходит пересланным текстом самого субагента — РАНЬШЕ финального пустого
      // списка задач. Ждём сам список.
      const bg = (): number[] => r.drafts.filter((d) => d.kind === 'background.changed').map((d) => (d.data as { count: number }).count)
      assert.ok(await waitFor(() => bg().at(-1) === 0, 5000), `последний список фоновых задач должен быть пустым: ${bg().join(',')}`)
      assert.ok(await waitFor(() => !alive(pid), 5000), 'без фоновых задач процесс должен уйти после тишины')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('стоп и закрытие простаивающей сессии с фоновыми задачами обнуляют «фон» событием (28.10.2026)', async () => {
    for (const how of ['interrupt', 'close'] as const) {
      const r = rig({ scenario: 'background-live', config: { subagentGraceMs: 400 } })
      try {
        await r.adapter.startSession(spec(r))
        await (await r.adapter.send('w', 'запусти фоновую задачу')).done
        const bg = (): Array<{ count: number; reason?: string }> => r.drafts.filter((d) => d.kind === 'background.changed').map((d) => d.data as never)
        assert.ok(await waitFor(() => (bg().at(-1)?.count ?? 0) > 0, 5000), `фон не появился: ${JSON.stringify(bg())}`)
        if (how === 'interrupt') await r.adapter.interrupt('w')
        else await r.adapter.close('w')
        assert.ok(await waitFor(() => bg().at(-1)?.count === 0, 5000), `${how}: фон не обнулён: ${JSON.stringify(bg())}`)
        assert.equal(bg().at(-1)?.reason, how === 'interrupt' ? 'background_process_exit' : 'session_closed')
      } finally { await r.adapter.shutdown(); r.remove() }
    }
  })

  it('фоновый субагент: ход закрывается по СВОЕМУ ответу, итог приходит ходом-итогом, процесс уходит после тишины', async () => {
    // 07.10.2026: раньше ход держала отсрочка, а по её концу процесс снимали — вместе с ещё живыми
    // фоновыми субагентами и их работой. Теперь ход человека закрывается по своему result, а
    // процесс живёт, пока идёт фоновая работа; её итог CLI отыгрывает сам, отдельным ходом.
    const r = rig({ scenario: 'subagent', config: { subagentGraceMs: 400 } })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'позови субагента')).done
      assert.equal(outcome.ok, true)
      assert.match(String(outcome.text), /в фоновом режиме/)
      assert.doesNotMatch(String(outcome.text), /DONE/, 'ход человека не ждёт итога фоновой задачи')
      assert.ok(await waitFor(() => r.drafts.some((d) => d.kind === 'message.done' && /DONE/.test(String((d.data as { text?: unknown }).text))), 5000),
        'итог фоновой задачи не дошёл до журнала')
      const reasons = (): string[] => r.drafts.filter((d) => d.kind === 'status.changed').map((d) => `${(d.data as { status?: string }).status}:${(d.data as { reason?: string }).reason ?? ''}`)
      // Статус «итог отыгран» едет строкой `result` ПОСЛЕ текста ответа — на медленном раннере
      // другим куском stdout. Ждём его самого, а не текст.
      assert.ok(await waitFor(() => reasons().includes('idle:background_turn_done'), 5000), `статусы: ${reasons().join(', ')}`)
      assert.deepEqual(reasons().slice(-2), ['working:background_turn', 'idle:background_turn_done'])
      assert.ok(!reasons().some((x) => x.includes('subagent_grace_expired')))
      assert.ok(r.drafts.some((d) => d.kind === 'agent.spawned'))
      // Фоновой работы больше нет — после тишины процесс уходит сам.
      const pid = r.runs()[0]!.pid
      assert.ok(await waitFor(() => !alive(pid), 5000), 'процесс остался жить без фоновой работы')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('адаптер claude: реплика после хода с фоновым субагентом', () => {
  // БАГ 07.10.2026 (жалоба владельца: «агент закончил, я долго не писал, написал — он не продолжает»).
  // Прошлый ход кончился отсрочкой при живом фоновом субагенте, процесс сняли. На `--resume` CLI
  // СНАЧАЛА отыгрывает застрявшее уведомление: `task_notification` → `init` → `result`
  // (`num_turns: 0`, пусто), и только потом отвечает на реплику. Адаптер закрывал ход по этому
  // пустому `result` и снимал процесс — до реплики дело не доходило.
  it('пустой result-разгрузка уведомления не закрывает ход: ответ на реплику доходит', async () => {
    const r = rig({ scenario: 'resume-drain', config: { subagentGraceMs: 1500 } })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'Reply with exactly PONG.')).done
      assert.equal(outcome.ok, true)
      assert.equal(outcome.text, 'PONG')
      assert.ok(r.drafts.some((d) => d.kind === 'message.done' && /PONG/.test(String((d.data as { text?: unknown }).text))), 'ответ модели не попал в журнал')
      assert.deepEqual(statuses(r).filter((s) => s === 'idle'), ['idle'], 'ход закрылся ровно один раз — по настоящему ответу')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('разгрузка пришла, а ответ не начался за отсрочку — ход падает с объяснением, а не висит', async () => {
    const r = rig({ scenario: 'resume-drain-stuck', config: { subagentGraceMs: 800 } })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'Reply with exactly PONG.')).done
      assert.equal(outcome.ok, false)
      assert.match(String(outcome.message), /не начал ответ на реплику/)
      assert.deepEqual(statuses(r).slice(-1), ['failed'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  // БАГ 07–08.10.2026 (журналы review, ai, liquid_glass, pult, ios-workspace): реплика после
  // процесса, снятого при живых фоновых субагентах, пропадала — ход закрывался за ~60 мс по
  // `result` с `num_turns: 0`, иногда по ВТОРОМУ такому подряд. CLI 2.1.294 метит свой ответ
  // меткой реплики (`user_message_uuids`), разгрузка уведомлений метки не несёт (фикстура 13).
  it('чужой result до ответа (без метки реплики) не закрывает ход: PONG доходит', async () => {
    const r = rig({ scenario: 'resume-phantom', config: { subagentGraceMs: 1500 } })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'Reply with exactly PONG.')).done
      assert.equal(outcome.ok, true)
      assert.equal(outcome.text, 'PONG')
      assert.ok(r.drafts.some((d) => d.kind === 'message.done' && /PONG/.test(String((d.data as { text?: unknown }).text))), 'ответ модели не попал в журнал')
      assert.deepEqual(statuses(r).filter((s) => s === 'idle'), ['idle'], 'ход закрылся ровно один раз — по настоящему ответу')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ДВА чужих result подряд (форма из журнала) — ход ждёт ответ, PONG доходит', async () => {
    // Прежняя примета («num_turns 0 после task_notification») глотала только первый: второй,
    // уже без уведомления, закрывал ход — реплика пропадала.
    const r = rig({ scenario: 'resume-phantom-twice', config: { subagentGraceMs: 1500 } })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'Reply with exactly PONG.')).done
      assert.equal(outcome.ok, true)
      assert.equal(outcome.text, 'PONG')
      assert.equal(r.drafts.filter((d) => d.kind === 'usage.updated' && (d.data as { source?: string }).source === 'result').length, 3, 'сыграно три result: два чужих и ответ')
      assert.deepEqual(statuses(r).filter((s) => s === 'idle'), ['idle'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('чужой result пришёл, а ответ не начался за отсрочку — ход падает с объяснением, а не висит', async () => {
    const r = rig({ scenario: 'resume-phantom-stuck', config: { subagentGraceMs: 800 } })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'Reply with exactly PONG.')).done
      assert.equal(outcome.ok, false)
      assert.match(String(outcome.message), /не начал ответ на реплику/)
      assert.deepEqual(statuses(r).slice(-1), ['failed'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('настоящий ответ с num_turns 0 (локальная команда /cost) закрывает ход сразу', async () => {
    // Отсрочка длинная нарочно: прими адаптер этот ответ за чужой, ход провисел бы её целиком.
    const r = rig({ scenario: 'local-command', config: { subagentGraceMs: 20_000 } })
    try {
      await r.adapter.startSession(spec(r))
      const started = Date.now()
      const outcome = await (await r.adapter.send('w', '/cost')).done
      assert.equal(outcome.ok, true)
      assert.match(String(outcome.text), /subscription/)
      assert.ok(Date.now() - started < 10_000, 'ход ждал отсрочку вместо того, чтобы закрыться')
      assert.deepEqual(statuses(r).slice(-1), ['idle'])
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

/** Жив ли процесс с таким pid. `kill(pid, 0)` ничего не посылает — только спрашивает. */
function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Все статусы, которые адаптер написал в журнал, по порядку. */
function statuses(r: Rig): string[] {
  return r.drafts
    .filter((d) => d.kind === 'status.changed')
    .map((d) => String((d.data as { status?: unknown }).status))
}

describe('адаптер claude: правки после ревью В2', () => {
  it('СПАВН НЕ УДАЛСЯ: ход падает сам, процесс Пульта ЖИВ (F1)', async () => {
    // До правки у ChildProcess не было ни одного слушателя 'error', и Node превращал ENOENT
    // в НЕОБРАБОТАННОЕ исключение: падал весь демон со всеми чужими сессиями. Этот тест
    // проваливался бы не ассертом, а смертью процесса тест-раннера.
    const r = rig({ scenario: 'simple', bin: join(tmpdir(), 'нет-такого-бинаря-pult') })
    try {
      await r.adapter.startSession(spec(r))
      const outcome = await (await r.adapter.send('w', 'привет')).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'internal')
      assert.match(String(outcome.message), /claude не запустился/)
      assert.match(String(outcome.message), /ENOENT/)
      // Сессия помечена проваленной, а не осталась «работающей» навсегда.
      const last = r.drafts.filter((d) => d.kind === 'status.changed').pop()
      assert.equal((last?.data as { status?: string }).status, 'failed')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('СТОП ВО ВРЕМЯ ПРОВЕРКИ СТРАЖА: процесс не рождается вовсе (f2)', async () => {
    // Страж сети — это `await`. Стоп, пришедший в этот зазор, раньше был холостым: interrupt
    // видел `child === null`, отчитывался успехом, а ребёнок рождался мгновением позже и жил
    // до жнеца (20 минут) или до остановки демона.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const r = rig({ scenario: 'warm', net: async () => { await gate; return okCheck() } })
    try {
      await r.adapter.startSession(spec(r, { mode: 'warm' }))
      const turn = r.adapter.send('w', 'привет')
      await r.adapter.interrupt('w')
      release()
      const outcome = await (await turn).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'interrupted')
      assert.deepEqual(r.runs(), [], 'после стопа дочерний процесс запускаться не должен')
      // Статус по стопу пишет менеджер, а не адаптер: отсюда не должно уйти НИ ОДНОГО
      // `status.changed interrupted`, иначе на каждый `agent stop` их в журнале два.
      assert.deepEqual(statuses(r).filter((s) => s === 'interrupted'), [])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ГЛУХОЙ ПРОЦЕСС: стоп доводит до SIGKILL и не врёт про успех (F3)', async () => {
    // Фальшивый CLI проглатывает SIGINT и SIGTERM и переживает закрытие stdin: уйти он может
    // ТОЛЬКО по SIGKILL. До правки interrupt слал SIGTERM вслепую и возвращался с успехом,
    // оставляя живого ребёнка.
    const r = rig({ scenario: 'warm', deaf: true, keepAlive: true, speed: 0 })
    try {
      await r.adapter.startSession(spec(r, { mode: 'warm' }))
      void r.adapter.send('w', 'привет')
      // Запас на холодный раннер: спавн node на нагруженной машине CI не мгновенный.
      assert.ok(await waitFor(() => r.runs().length === 1, 20_000), 'процесс должен был запуститься')
      const pid = r.runs()[0]!.pid
      assert.ok(alive(pid), 'глухой процесс должен быть жив до стопа')
      await r.adapter.interrupt('w')
      assert.ok(await waitFor(() => !alive(pid), 2000), `процесс ${pid} пережил стоп`)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ПОСЛЕ close() ход-призрак не пишет НИ ОДНОГО события (f1)', async () => {
    // Имя сессии переиспользуемо: событие убитого хода, записанное после `session.ended`,
    // приезжало в журнал СВЕЖЕЙ сессии с тем же именем и помечало её проваленной.
    // `hang` держит ход открытым: его рвут заведомо посреди работы, а не после конца.
    const r = rig({ scenario: 'simple', hang: 4000 })
    try {
      await r.adapter.startSession(spec(r, { mode: 'warm' }))
      void r.adapter.send('w', 'привет')
      assert.ok(await waitFor(() => r.runs().length === 1, 20_000), 'процесс должен был запуститься')
      await r.adapter.close('w')
      const afterClose = r.drafts.length
      // Новая сессия с тем же именем — та, в чей поток и приезжал чужой хвост.
      await r.adapter.startSession(spec(r, { mode: 'warm' }))
      // sleep из helpers, а НЕ `setTimeout(...).unref()`: unref-нутое ожидание не держит
      // событийный цикл, и раннер вправе выйти раньше — тест и следующий за ним уезжают
      // в `cancelled`. На CI это ровно так и случилось.
      await sleep(800)
      assert.deepEqual(
        r.drafts.slice(afterClose),
        [],
        `после close() записано лишнее: ${JSON.stringify(r.drafts.slice(afterClose))}`,
      )
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('shutdown добивает ребёнка, чей ход уже закончился (F6)', async () => {
    // Режим «процесс на ход»: после `result` stdin закрывается, а добивающий SIGTERM висит на
    // `unref`-нутом таймере. Быстрый `daemon.stop` уходил раньше него, и в `live` такого
    // ребёнка уже не было — снимать его было некому.
    // Процесс и глухой, и живучий: добивающий SIGTERM на него не действует ВООБЩЕ, поэтому
    // тест не зависит от того, успел таймер или нет, — уйти ребёнок может только от SIGKILL,
    // который шлёт подметание в shutdown. Ждать можно сколько угодно: ложного успеха нет.
    const r = rig({ scenario: 'simple', keepAlive: true, deaf: true })
    try {
      await r.adapter.startSession(spec(r))
      await (await r.adapter.send('w', 'привет')).done
      const pid = r.runs()[0]!.pid
      assert.ok(alive(pid), 'живучий процесс закрытие stdin не убивает')
      await sleep(1800)
      assert.ok(alive(pid), 'глухой процесс не уходит и от добивающего SIGTERM')
      await r.adapter.shutdown()
      assert.ok(await waitFor(() => !alive(pid), 5000), `процесс ${pid} пережил shutdown`)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('СТОП ДО system/init: ход кончается interrupted, адаптер молчит, следующий ход с --session-id', async () => {
    // НАБЛЮДЕНО на настоящем CLI: `agent prompt`, через секунду `agent stop` — и в журнале
    // сначала `status.changed failed errorCode=internal` (снятый ход рапортовал «claude вышел
    // без result»), а следом ДВА `interrupted` подряд, от адаптера и от менеджера.
    // ВТОРАЯ БЕДА ТОГО ЖЕ СТОПА: ход умер раньше `system/init`, разговора на диске не
    // появилось, а следующий ход всё равно уходил с `--resume` — и агент был мёртв навсегда.
    const r = rig({ scenario: 'simple', hang: 3000 })
    try {
      const started = await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'привет')
      assert.ok(await waitFor(() => r.runs().length === 1, 20_000), 'процесс должен был запуститься')
      await r.adapter.interrupt('w')
      const outcome = await turn.done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'interrupted', 'не internal: ход сняли стопом, он не упал сам')
      assert.deepEqual(statuses(r), ['working'], 'по стопу адаптер не пишет ни failed, ни interrupted')
      assert.deepEqual(r.drafts.filter((d) => d.kind === 'session.started'), [], 'init не приходил')

      // Фикстура снова играется с начала, и на этот раз без задержки.
      r.retune({ scenario: 'simple' })
      const second = await (await r.adapter.send('w', 'ещё раз')).done
      assert.equal(second.ok, true, 'после стопа сессия должна продолжать работать')
      const argv = r.runs()[1]!.argv
      assert.ok(!argv.includes('--resume'), `разговора не было — возобновлять нечего: ${argv.join(' ')}`)
      assert.equal(argv[argv.indexOf('--session-id') + 1], started.providerSessionId)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('СТОП ПОСЛЕ system/init: разговор заведён, следующий ход идёт с --resume', async () => {
    // Обратная половина той же границы. ИЗМЕРЕНО 21.09.2026: `session.started` на +1,18 с,
    // стоп на +1,9 с — и `--resume` следующего хода работает. Значит `init` увиден ⇒
    // разговор возобновляем, и дешеветь до `--session-id` здесь было бы потерей контекста.
    const r = rig({ scenario: 'simple', hangAfterInit: 3000 })
    try {
      await r.adapter.startSession(spec(r))
      const turn = await r.adapter.send('w', 'привет')
      assert.ok(await waitFor(() => r.drafts.some((d) => d.kind === 'session.started'), 20_000), 'init должен был прийти')
      await r.adapter.interrupt('w')
      assert.equal((await turn.done).errorCode, 'interrupted')
      // Тот самый uuid, который назвал САМ CLI в `system/init`, — его и возобновляем.
      const reported = (r.drafts.find((d) => d.kind === 'session.started')!.data as { providerSessionId: string }).providerSessionId

      r.retune({ scenario: 'simple' })
      assert.equal((await (await r.adapter.send('w', 'ещё раз')).done).ok, true)
      const argv = r.runs()[1]!.argv
      assert.ok(!argv.includes('--session-id'), argv.join(' '))
      assert.equal(argv[argv.indexOf('--resume') + 1], reported)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('«No conversation found» на --resume: ход падает с ВНЯТНЫМ текстом, следующий начинает заново', async () => {
    // Самолечение. Даже если разговор потерялся по причине, которой мы не знаем, агент не
    // обязан оставаться кирпичом до `agent rm`: ответ CLI прямо говорит, что возобновлять
    // нечего, — значит следующий ход заводит разговор заново.
    const r = rig({ scenario: 'simple' })
    try {
      await r.adapter.startSession(spec(r))
      assert.equal((await (await r.adapter.send('w', 'привет')).done).ok, true)
      assert.ok(r.runs()[0]!.argv.includes('--session-id'))

      // Ход 2: разговора на той стороне нет. Фикстура 10 — дословная запись такого ответа.
      r.retune({ scenario: 'no-conversation' })
      const broken = await (await r.adapter.send('w', 'а теперь?')).done
      assert.equal(broken.ok, false)
      assert.ok(r.runs()[1]!.argv.includes('--resume'), 'ход 2 обязан был пойти с --resume')
      // Раньше здесь была пустая строка: у такого `result` нет поля `result`, а причина
      // лежит в `errors[]`, и CLI печатал «ход не удался: internal — ».
      assert.match(String(broken.message), /No conversation found with session ID/)

      // Ход 3: начинаем разговор заново, без единого ручного `agent rm`.
      r.retune({ scenario: 'simple' })
      assert.equal((await (await r.adapter.send('w', 'ещё раз')).done).ok, true)
      const argv = r.runs()[2]!.argv
      assert.ok(!argv.includes('--resume'), argv.join(' '))
      assert.ok(argv.includes('--session-id'), argv.join(' '))
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})
