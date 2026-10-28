// Правки по независимому разбору PR #5: всё, что нашёл взломщик и подтвердил лид.
// Каждый тест здесь ПАДАЕТ на коде до правки — это проверялось подменой собранного `dist`.
//
// Почему отдельный файл, а не дописка в codex-adapter.test.ts: здесь нужен ПРОГРАММИРУЕМЫЙ
// сервер (`test/fakes/fake-codex-scripted.mjs`), а не проигрыватель записей, — случаи вроде
// «сервер переиспользовал id живого запроса» в записи не встречаются и встретиться не могут.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createCodexAdapter } from '../dist/adapters/codex/adapter.js'
import type { ProviderAdapter } from '../dist/adapters/types.js'
import { defaultConfig } from '../dist/core/config.js'
import type { EventDraft } from '../dist/core/events.js'
import { createLogger } from '../dist/core/log.js'
import { ensureLayout, layout } from '../dist/core/paths.js'
import type { NetCheck } from '../dist/env/net.js'
import { createBroker } from '../dist/perm/broker.js'
import type { PermBroker } from '../dist/perm/broker.js'
import { createCodexBackground } from '../dist/adapters/codex/background.js'
import { FAKE_CODEX, FAKE_CODEX_SCRIPTED, sleep, waitFor } from './helpers.js'

const seenPids: number[] = []
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
after(() => {
  const survivors = seenPids.filter(alive)
  assert.deepEqual(survivors, [], `фальшивые app-server пережили тесты: ${survivors.join(', ')}`)
})

const okCheck = (over: Partial<NetCheck> = {}): NetCheck => ({
  provider: 'codex', mode: 'auto', path: 'direct', proxy: null, loc: 'FI', ok: true,
  reason: 'ok', fellBack: false, guard: ['RU'], attempts: [], ms: 1,
  checkedAt: '2026-09-22T10:00:00.000Z', cached: false, ...over,
})

/** Профиль «через прокси»: из него адаптер строит ALL_PROXY/HTTPS_PROXY ребёнку. */
const proxyCheck = (): NetCheck => okCheck({ path: 'proxy', proxy: 'socks5h://127.0.0.1:9050', fellBack: true })

interface Msg { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }

/** Запись журнала фальшивого сервера: у каждой строки есть pid процесса, который её написал. */
interface Rec { ev: string; pid: number; msg?: Msg; env?: Record<string, string> }

interface Rig {
  adapter: ProviderAdapter
  broker: PermBroker
  drafts: EventDraft[]
  cwd: string
  home: string
  /** Сообщения, которые адаптер прислал серверу. */
  client(): Msg[]
  /** Те же строки, но С PID: по ним видно, В КАКОЙ процесс ушёл запрос. */
  raw(): Rec[]
  boots(): number
  pids(): number[]
  remove(): void
}

function rig(opts: {
  bin?: string
  fake?: Record<string, unknown>
  permTimeoutMs?: number
  controlTimeoutMs?: number
  /** Страж сети: по умолчанию прямой путь. Тест подменяет, когда профиль важен. */
  net?: () => Promise<NetCheck>
  /** Не давать адаптеру снимать вопросы из Inbox: так проверяется защита ПО ПОКОЛЕНИЮ. */
  noCancel?: boolean
  /** Потолок фоновой работы (и молчания записи фона Codex) — тест ставит короче. */
  backgroundMaxMs?: number
} = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'pt-safe-'))
  const paths = layout(join(dir, 'h'))
  ensureLayout(paths)
  const cwd = join(dir, 'work')
  mkdirSync(cwd, { recursive: true })
  const logOut = join(dir, 'server.jsonl')
  writeFileSync(join(paths.home, '.pult-fake-scripted.json'), JSON.stringify({ logOut, ...(opts.fake ?? {}) }))
  writeFileSync(join(paths.home, '.pult-fake-codex.json'), JSON.stringify({ scenario: 'simple', speed: 0, logOut, ...(opts.fake ?? {}) }))
  const drafts: EventDraft[] = []
  const broker = createBroker({
    emit: (d) => { drafts.push(d) },
    ...(opts.permTimeoutMs !== undefined ? { timeoutMs: opts.permTimeoutMs } : {}),
  })
  const config = defaultConfig()
  if (opts.backgroundMaxMs !== undefined) config.backgroundMaxMs = opts.backgroundMaxMs
  const adapter = createCodexAdapter({
    paths, config, logger: createLogger(paths.logFile),
    bin: opts.bin ?? FAKE_CODEX_SCRIPTED,
    emit: (d) => { drafts.push(d) },
    askPermission: (req) => broker.request(req),
    ...(opts.noCancel ? {} : {
      cancelPermissions: (sessionId: string, reason: string) => {
        let n = 0
        for (const p of broker.list(sessionId)) {
          if (broker.resolve(p.id, { behavior: 'deny', message: reason }, 'provider_gone')) n++
        }
        return n
      },
    }),
    netCheck: opts.net ?? (async () => okCheck()),
    schemaCheck: () => ({ status: 'ok', expected: 'x', actual: 'x', files: 310, detail: 'тест' }),
    ...(opts.controlTimeoutMs !== undefined ? { controlTimeoutMs: opts.controlTimeoutMs } : {}),
  })
  const read = (): Array<Record<string, unknown>> => (existsSync(logOut)
    ? readFileSync(logOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [])
  return {
    adapter, broker, drafts, cwd, home: paths.home,
    client: () => read().filter((r) => r['ev'] === 'client').map((r) => r['msg'] as Msg),
    raw: () => read() as unknown as Rec[],
    boots: () => read().filter((r) => r['ev'] === 'boot').length,
    pids: () => [...new Set(read().filter((r) => r['ev'] === 'boot').map((r) => Number(r['pid'])))],
    remove: () => {
      for (const pid of read().filter((r) => r['ev'] === 'boot').map((r) => Number(r['pid']))) seenPids.push(pid)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const spec = (r: Rig, name: string) => ({ name, cwd: r.cwd, mode: 'turn' as const, broker: true })

describe('codex: остановка демона не оставляет сирот', () => {
  it('СПАВН В ПОЛЁТЕ: shutdown() дожидает рукопожатия и убивает процесс, о котором никто не знал', async () => {
    // До правки `shutdown()` снимал снимок `client` (а он ещё null, пока идёт `initialize`),
    // подчищал состояние и уходил; спавн доезжал следом, присваивал `client = c` — и живой
    // `codex app-server` переживал `pult daemon stop`. Флаг `shuttingDown` при этом читался
    // ровно в одном месте — в строке журнала.
    const r = rig({ fake: { handshakeDelayMs: 400 } })
    try {
      await r.adapter.startSession(spec(r, 'w'))
      const turn = r.adapter.send('w', 'привет')
      // Ждём именно СТАРТА процесса, а не конца рукопожатия.
      assert.ok(await waitFor(() => r.boots() === 1, 5000), 'процесс должен был запуститься')
      await r.adapter.shutdown()
      const outcome = await (await turn).done
      assert.equal(outcome.ok, false, 'ход обязан завершиться честно, а не зависнуть')
      const pids = r.pids()
      assert.equal(pids.length, 1)
      assert.ok(await waitFor(() => !alive(pids[0] as number), 5000), `app-server ${pids[0]} пережил shutdown()`)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('после shutdown() новый ход не поднимает процесс заново', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      await (await r.adapter.send('w', 'привет')).done
      await r.adapter.shutdown()
      await r.adapter.resume('w', {
        name: 'w', provider: 'codex', cwd: r.cwd, mode: 'turn',
        createdAt: '2026-09-22T00:00:00.000Z', lastStatus: 'cold', lastEventId: 0,
      })
      const outcome = await (await r.adapter.send('w', 'ещё раз')).done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'provider_unavailable')
      assert.equal(r.boots(), 1, 'после остановки адаптер не имеет права спавнить')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('codex: очередь разрешений не путает запросы', () => {
  it('ПОВТОРНЫЙ id живого запроса ОТРАВЛЯЕТ его: новому отказ, старый снят, «разрешить» никуда не уедет', async () => {
    // До правки второй `approvals.set(id, …)` затирал первый: решение человека по первому
    // уходило на провод под ВТОРЫМ запросом, с чужим словарём решений, а настоящее решение по
    // второму терялось молча — при этом брокер отчитывался «решено».
    //
    // Почему «отравлен» именно оба: ответ сопоставляется сервером по id, и отличить, какому
    // из двух он адресован, нельзя НИ НАМ, НИ ЕМУ. Единственный безопасный исход — самый
    // строгий ответ новому и снятие старого.
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'a'))
      await r.adapter.startSession(spec(r, 'b'))
      void r.adapter.send('a', 'делай [[dup-id-a]]')
      assert.ok(await waitFor(() => r.broker.list('a').length === 1, 5000), 'вопрос a обязан попасть в Inbox')
      const pendingA = r.broker.list('a')[0]!
      void r.adapter.send('b', 'делай [[dup-id-b]]')

      // Новый запрос в Inbox не попадает (спрашивать по отравленному id нечего), а старый из
      // Inbox ИСЧЕЗАЕТ — отказом.
      assert.ok(await waitFor(() => r.broker.list('a').length === 0, 5000), 'старый вопрос обязан быть снят')
      assert.equal(r.broker.list('b').length, 0, 'новый запрос с занятым id в Inbox не кладётся')
      const resolved = r.drafts.filter((d) => d.kind === 'permission.resolved' && d.sessionId === 'a')
      assert.equal((resolved[0]?.data as { decision: string }).decision, 'deny')

      // На провод ушёл РОВНО ОДИН ответ — самый строгий, на последний запрос. `waitFor` выше
      // дождался состояния БРОКЕРА (тот же процесс), а не строки в логе ФЕЙКА (чужой процесс,
      // пишет её сам по прочтении трубы) — ждём и её явно, прежде чем читать лог.
      assert.ok(await waitFor(() => r.client().some((m) => m.id === 9001 && m.result !== undefined), 5000))
      const responses = r.client().filter((m) => m.id === 9001 && m.result !== undefined)
      assert.equal(responses.length, 1, `ответ должен быть один: ${JSON.stringify(responses)}`)
      assert.deepEqual(responses[0]?.result, { decision: 'decline' })

      // Запоздалое «разрешить» по снятому вопросу не добавляет НИ ОДНОГО ответа.
      r.broker.resolve(pendingA.id, { behavior: 'allow' })
      await sleep(200)
      assert.equal(r.client().filter((m) => m.id === 9001 && m.result !== undefined).length, 1,
        'решение по снятому вопросу не имеет права уехать на провод')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('РЕШЕНИЕ ПОСЛЕ ПЕРЕЗАПУСКА не уезжает в новый процесс (поколение не совпало)', async () => {
    // `noCancel` — намеренно: без него вопрос покойника снимает `cancelPermissions`, запись
    // из очереди исчезает, и защита по поколению просто не проверяется. Здесь вопрос ДОЖИВАЕТ
    // до перезапуска, и единственное, что не даёт ответу уехать в новый процесс, — поколение.
    const r = rig({ noCancel: true })
    try {
      await r.adapter.startSession(spec(r, 'w'))
      void r.adapter.send('w', 'делай [[no-avail]]')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
      const pending = r.broker.list('w')[0]!
      for (const pid of r.pids()) { try { process.kill(pid, 'SIGKILL') } catch { /* мёртв */ } }
      // Смерть должна быть ЗАМЕЧЕНА адаптером до следующего хода: `send()` сразу после
      // `kill()` без этого ожидания законно гонится с `onProcessGone` — `client.alive()`
      // читает ЕЩЁ живое состояние, ход уходит в мёртвый процесс и хоронится как
      // `provider_unavailable` БЕЗ переспавна (документированное поведение, не баг).
      assert.ok(await waitFor(() => r.drafts.some((d) => d.kind === 'provider.restarted'
        && (d.data as { event: string }).event === 'exited'), 5000), 'адаптер обязан заметить смерть процесса до следующего хода')
      // Новый процесс — новое поколение; в нём id 9003 принадлежит уже другому запросу.
      await (await r.adapter.send('w', 'ещё раз')).done
      assert.ok(await waitFor(() => r.boots() === 2, 5000))
      assert.equal(r.boots(), 2)
      const before = r.client().filter((m) => m.id === 9003 && (m.result !== undefined || m.error !== undefined)).length
      r.broker.resolve(pending.id, { behavior: 'allow' })
      await sleep(300)
      const after = r.client().filter((m) => m.id === 9003 && (m.result !== undefined || m.error !== undefined)).length
      assert.equal(after, before, 'ответ уехал в НОВОЕ поколение процесса')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('запрос по НЕЗНАКОМОМУ треду: чистая ошибка JSON-RPC, ход продолжается', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      const outcome = await (await r.adapter.send('w', 'делай [[ghost-approval]]')).done
      assert.equal(outcome.ok, true, outcome.message)
      assert.equal(r.broker.list('w').length, 0)
      assert.ok(await waitFor(() => r.client().some((m) => m.id === 9002), 5000))
      const resp = r.client().find((m) => m.id === 9002)
      assert.equal(resp?.error?.code, -32600)
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('без availableDecisions «разрешить» всё равно понижается до отказа (инвариант 5)', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      void r.adapter.send('w', 'делай [[no-avail]]')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
      const pending = r.broker.list('w')[0]!
      assert.deepEqual((pending.input as { availableDecisions: string[] }).availableDecisions, [])
      r.broker.resolve(pending.id, { behavior: 'allow' })
      await sleep(200)
      const resp = r.client().find((m) => m.id === 9003 && m.result !== undefined)
      assert.deepEqual(resp?.result, { decision: 'decline' })
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ЗАКРЫТИЕ СЕССИИ убирает её вопрос из Inbox, а не оставляет призрака на 10 минут', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      void r.adapter.send('w', 'делай [[no-avail]]')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
      await r.adapter.close('w')
      assert.equal(r.broker.list('w').length, 0, 'вопрос закрытой сессии обязан уйти из Inbox')
      const resolved = r.drafts.filter((d) => d.kind === 'permission.resolved')
      assert.equal(resolved.length, 1)
      assert.equal((resolved[0]?.data as { decision: string }).decision, 'deny')
      assert.equal((resolved[0]?.data as { by: string }).by, 'provider_gone')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ОСТАНОВКА АГЕНТА тоже убирает его вопрос из Inbox', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      void r.adapter.send('w', 'делай [[no-avail]]')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
      await r.adapter.interrupt('w')
      assert.equal(r.broker.list('w').length, 0)
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('codex: человек видит, ЧТО разрешает', () => {
  it('правка файла показывает корень, причину и id, а не command: null', async () => {
    // Фикстуры `item/fileChange/requestApproval` у нас нет (спайк её не поймал) — форма
    // СИНТЕТИЧЕСКАЯ, поля дословно по схеме 0.155 `FileChangeRequestApprovalParams`:
    // grantRoot, itemId, reason, startedAtMs, threadId, turnId. Ни `changes`, ни
    // `availableDecisions` там нет — фейк их больше и не присылает.
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      void r.adapter.send('w', 'правь файл [[file-change]]')
      assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
      const input = r.broker.list('w')[0]!.input as Record<string, unknown>
      assert.equal(r.broker.list('w')[0]!.toolName, 'fileChange')
      assert.equal(input['grantRoot'], '/Users/человек/проект')
      assert.match(String(input['reason']), /notes\.md/)
      assert.equal(input['itemId'], 'fc-1')
      // Маршрутные поля человеку не нужны.
      assert.equal(input['threadId'], undefined)
      assert.equal(input['turnId'], undefined)
      assert.equal(input['startedAtMs'], undefined)
      // И ни одного пустого поля-обманки от прежнего жёсткого набора.
      assert.equal('command' in input, false)
      // Человеку показан НЕ пустой список решений, хотя сервер его не присылал: он взят из
      // словаря схемы метода. Пустой означал бы «разрешать нечего», а это неправда. С M8d в словаре и
      // `acceptForSession` (`FileChangeApprovalDecision` его объявляет) — кнопка «В этой сессии».
      assert.deepEqual(input['availableDecisions'], ['accept', 'acceptForSession', 'decline', 'cancel'])
      assert.deepEqual(r.broker.list('w')[0]!.offers, { session: true })
      r.broker.resolve(r.broker.list('w')[0]!.id, { behavior: 'deny' })
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  // НАХОДКА РАЗБОРА В3 (P2). У `item/fileChange/requestApproval` поля `availableDecisions` в
  // схеме НЕТ вовсе (её поля: grantRoot, itemId, reason, startedAtMs, threadId, turnId), а
  // «да» адаптер выбирал ТОЛЬКО из этого поля. Значит список всегда пуст, «разрешить»
  // понижалось до `decline` — правку файла через Пульт нельзя было согласовать НИКОГДА,
  // при том что `FileChangeApprovalDecision` это accept|acceptForSession|decline|cancel.
  // Наблюдаемо: `pult perm approve` отчитывался об успехе, на проводе был `decline`.
  for (const [behavior, decision] of [['allow', 'accept'], ['deny', 'decline']] as Array<['allow' | 'deny', string]>) {
    it(`правка файла: ${behavior} человека доезжает до провода как ${decision}`, async () => {
      const r = rig()
      try {
        await r.adapter.startSession(spec(r, 'w'))
        const turn = await r.adapter.send('w', 'правь файл [[file-change]]')
        assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000), 'вопрос обязан попасть в Inbox')
        r.broker.resolve(r.broker.list('w')[0]!.id, { behavior })
        assert.equal((await turn.done).ok, true, 'ответ на разрешение ход не проваливает')
        // Ответ пишет СВОЙ процесс фейка — ждём строку журнала, а не читаем её сразу.
        assert.ok(await waitFor(() => r.client().some((m) => m.id === 9004 && m.result !== undefined), 5000))
        const answer = r.client().find((m) => m.id === 9004 && m.result !== undefined)
        assert.deepEqual(answer?.result, { decision })
      } finally { await r.adapter.shutdown(); r.remove() }
    })
  }
})

describe('codex: запросы сервера, которых Пульт не умеет', () => {
  for (const behavior of ['allow', 'deny'] as const) {
    it(`вопрос Codex проходит через Inbox: ${behavior}`, async () => {
      const r = rig()
      try {
        await r.adapter.startSession(spec(r, 'w'))
        const turn = await r.adapter.send('w', 'спроси [[tool-user-input]]')
        assert.ok(await waitFor(() => r.broker.list('w').length === 1, 5000))
        const question = r.broker.list('w')[0]!
        assert.equal(question.toolName, 'requestUserInput')
        r.broker.resolve(question.id, behavior === 'allow' ? { behavior, answers: { q1: { answers: ['8080'] } } } : { behavior })
        assert.equal((await turn.done).ok, true)
        assert.ok(await waitFor(() => r.client().some((m) => m.id === 9011 && m.result !== undefined), 5000))
        assert.deepEqual(r.client().find((m) => m.id === 9011 && m.result !== undefined)?.result,
          { answers: behavior === 'allow' ? { q1: { answers: ['8080'] } } : {} })
      } finally { await r.adapter.shutdown(); r.remove() }
    })
  }
  for (const [scenario, method, id] of [
    ['permissions-request', 'item/permissions/requestApproval', 9010],
    ['mcp-elicitation', 'mcpServer/elicitation/request', 9012],
  ] as Array<[string, string, number]>) {
    it(`${method}: ход НЕ виснет, в журнале названа причина`, async () => {
      const r = rig()
      try {
        await r.adapter.startSession(spec(r, 'w'))
        const outcome = await (await r.adapter.send('w', `делай [[${scenario}]]`)).done
        // Наблюдаемое поведение: сервер получает ошибку -32601 и доводит ход до конца.
        assert.equal(outcome.ok, true, outcome.message)
        assert.ok(await waitFor(() => r.client().some((m) => m.id === id), 5000))
        const resp = r.client().find((m) => m.id === id)
        assert.equal(resp?.error?.code, -32601)
        assert.match(String(resp?.error?.message), /не поддерживается/)
        const named = r.drafts.find((d) => d.kind === 'permission.resolved'
          && (d.data as { by?: string }).by === 'unsupported_request')
        assert.ok(named, 'в журнале должно быть событие с названием неподдержанного запроса')
        assert.equal((named.data as { toolName: string }).toolName, method)
        assert.equal(r.broker.list('w').length, 0, 'в Inbox такому запросу делать нечего')
      } finally { await r.adapter.shutdown(); r.remove() }
    })
  }
})

describe('codex: инвариант 7 на снимке лимитов', () => {
  it('секреты из полей снимка НЕ уезжают в limit.hit и usage.updated', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      const outcome = await (await r.adapter.send('w', 'трать [[leaky-limit]]')).done
      assert.equal(outcome.errorCode, 'limited')
      const hit = r.drafts.find((d) => d.kind === 'limit.hit')
      assert.ok(hit)
      const snapshot = (hit.data as { snapshot?: Record<string, unknown> }).snapshot
      assert.ok(snapshot)
      assert.equal(snapshot['limitName'], '<email>')
      assert.equal(snapshot['normalModelSlug'], '<token>')
      // И ни в одном событии адаптера секретов нет вообще.
      const whole = JSON.stringify(r.drafts)
      assert.ok(!whole.includes('leaked-secret@example.com'), 'почта утекла в журнал')
      assert.ok(!whole.includes('deadbeefdeadbeefdeadbeefdeadbeef'), 'ключ утёк в журнал')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('codex: смерть общего процесса видна в журнале', () => {
  it('ПРОСТАИВАЮЩИЙ процесс умер — событие provider.restarted с pid и сигналом; подъём тоже', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      await (await r.adapter.send('w', 'привет')).done
      const pid = r.pids()[0] as number
      process.kill(pid, 'SIGKILL')
      assert.ok(await waitFor(() => r.drafts.some((d) => d.kind === 'provider.restarted'
        && (d.data as { event: string }).event === 'exited'), 5000), 'смерть процесса обязана попасть в журнал')
      const died = r.drafts.filter((d) => d.kind === 'provider.restarted' && (d.data as { event: string }).event === 'exited')
      assert.equal((died[0]?.data as { signal: string }).signal, 'SIGKILL')
      assert.equal((died[0]?.data as { pid: number }).pid, pid)
      assert.equal(died[0]?.sessionId, 'daemon', 'событие про провайдера, а не про чью-то сессию')

      await (await r.adapter.send('w', 'ещё раз')).done
      const up = r.drafts.filter((d) => d.kind === 'provider.restarted' && (d.data as { event: string }).event === 'restarted')
      assert.equal(up.length, 1)
      assert.equal((up[0]?.data as { generation: number }).generation, 2)
      const first = r.drafts.filter((d) => d.kind === 'provider.restarted' && (d.data as { event: string }).event === 'started')
      assert.equal(first.length, 1, 'первый подъём отмечается отдельно от перезапуска')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('codex: гонка двух ходов за перезапуск', () => {
  it('после падения ОБА хода поднимают процесс ровно ОДИН раз', async () => {
    // Репро взломщика: два `send()` подряд без await между ними.
    const r = rig({ bin: FAKE_CODEX })
    try {
      await r.adapter.startSession(spec(r, 'a'))
      await r.adapter.startSession(spec(r, 'b'))
      assert.equal((await (await r.adapter.send('a', 'привет')).done).ok, true)
      assert.equal((await (await r.adapter.send('b', 'привет')).done).ok, true)
      const [ca, cb] = await Promise.all([r.adapter.send('a', 'падай [[crash]]'), r.adapter.send('b', 'падай [[crash]]')])
      await Promise.all([ca.done, cb.done])
      const [na, nb] = await Promise.all([r.adapter.send('a', 'ещё раз'), r.adapter.send('b', 'ещё раз')])
      const [oa, ob] = await Promise.all([na.done, nb.done])
      assert.equal(oa.ok, true, oa.message)
      assert.equal(ob.ok, true, ob.message)
      assert.ok(await waitFor(() => r.boots() === 2, 5000))
      assert.equal(r.boots(), 2, 'перезапуск обязан быть ОДИН на двоих')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('codex: гонки вокруг общего процесса и снятой сессии', () => {
  it('ПРОФИЛЬ СЕТИ: ход не уезжает в процесс, поднятый ЧУЖОЙ проверкой стража', async () => {
    // НАХОДКА РАЗБОРА В3 (P1). В `ensureClient` стояло `if (starting) return starting` — ход,
    // пришедший вторым, получал процесс, поднятый по ЧУЖОМУ профилю сети, и не сверял его со
    // своим. Здесь страж отвечает сессии `a` прямым путём, а сессии `b` — прокси: до правки
    // `b` спокойно шла ходом в процесс БЕЗ единой переменной прокси, то есть маршрутом,
    // который её собственная проверка не утверждала (инвариант 2).
    let probes = 0
    const r = rig({
      // Рукопожатие медленное нарочно: спавн `a` гарантированно ещё в полёте, когда `b`
      // доходит до `ensureClient`.
      fake: { handshakeDelayMs: 350 },
      net: async () => {
        probes += 1
        if (probes === 1) return okCheck()
        await sleep(120)
        return proxyCheck()
      },
    })
    try {
      await r.adapter.startSession(spec(r, 'a'))
      await r.adapter.startSession(spec(r, 'b'))
      // Два `send()` подряд БЕЗ await между ними: порядок обращений к стражу детерминирован —
      // `a` спрашивает первой.
      const pa = r.adapter.send('a', 'привет-A')
      const pb = r.adapter.send('b', 'привет-B')
      const [sa, sb] = await Promise.all([pa, pb])
      const [oa, ob] = await Promise.all([sa.done, sb.done])

      assert.equal(oa.ok, true, `ход по прямому профилю обязан пройти: ${String(oa.message)}`)
      // Допустимых исходов у `b` ровно два, и оба честные: отказ (общий процесс занят чужим
      // ходом) либо перезапуск под её собственный профиль. Недопустим ровно один — молча
      // пройти по чужому маршруту.
      if (!ob.ok) {
        assert.equal(ob.errorCode, 'provider_unavailable')
        assert.match(String(ob.message), /профиль сети сменился/)
      }
      assert.ok(await waitFor(() => r.client().some((m) => m.method === 'turn/start'), 5000))
      const bTurn = r.raw().find((rec) => rec.ev === 'client'
        && rec.msg?.method === 'turn/start'
        && JSON.stringify(rec.msg?.params ?? {}).includes('привет-B'))
      if (bTurn) {
        const boot = r.raw().find((rec) => rec.ev === 'boot' && rec.pid === bTurn.pid)
        assert.ok(boot?.env?.['ALL_PROXY'], 'ход B ушёл в процесс БЕЗ прокси — маршрут не тот, что утвердил страж')
      }
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ПРОФИЛЬ СМЕНИЛСЯ У ВСЕХ: два простаивающих агента перезапускают процесс, а не отказывают', async () => {
    // РЕГРЕССИЯ ПЕРВОГО КРУГА ПРАВОК. `anyBusy` стала считать занятыми сессии с флагом
    // `starting`, а он ставится ДО проверки сети — то есть у сессии, которая общего процесса
    // ещё не касалась. Случай Ф0 «прокси лёг, страж откатил на прямой путь ВСЕХ»: два агента
    // отвечают репликой одновременно, каждый видит у соседа `starting`, каждый решает, что
    // процесс занят чужим ходом, и ОБА получают `provider_unavailable` — при том что процессом
    // не пользуется никто и перезапуск бесплатен.
    let proxied = false
    const r = rig({ net: async () => (proxied ? proxyCheck() : okCheck()) })
    try {
      // Процесс поднимается ПРЯМЫМ профилем и остаётся простаивать.
      await r.adapter.startSession(spec(r, 's'))
      assert.equal((await (await r.adapter.send('s', 'первый ход')).done).ok, true)
      assert.equal(r.boots(), 1)

      // Прокси поднялся (или лёг — неважно): страж отвечает НОВЫМ профилем всем сразу.
      proxied = true
      await r.adapter.startSession(spec(r, 'a'))
      await r.adapter.startSession(spec(r, 'b'))
      const [sa, sb] = await Promise.all([r.adapter.send('a', 'привет-A'), r.adapter.send('b', 'привет-B')])
      const [oa, ob] = await Promise.all([sa.done, sb.done])

      assert.equal(oa.ok, true, `ходу A отказали вместо бесплатного перезапуска: ${String(oa.message)}`)
      assert.equal(ob.ok, true, `ходу B отказали вместо бесплатного перезапуска: ${String(ob.message)}`)
      assert.ok(await waitFor(() => r.boots() === 2, 5000), 'процесс обязан подняться заново ровно один раз')
      assert.equal(r.boots(), 2, 'перезапуск ОДИН на двоих, а не по одному на каждого')
      const boots = r.raw().filter((rec) => rec.ev === 'boot')
      assert.ok(boots[1]?.env?.['ALL_PROXY'], 'второй процесс обязан жить под НОВЫМ профилем сети')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('ДВЕ РЕПЛИКИ ПОДРЯД по одной сессии: ход ровно один, вторая получает invalid_params', async () => {
    // НАХОДКА РАЗБОРА В3 (P1). Проверка «уже делает ход» смотрела на `l.turn`, который
    // присваивается после трёх `await`, — обе реплики её проходили, обе заводили тред и ход,
    // вторая затирала контекст первой, и `done` первой не резолвился НИКОГДА.
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      const p1 = r.adapter.send('w', 'первая')
      const p2 = r.adapter.send('w', 'вторая')
      const [s1, s2] = await Promise.all([p1, p2])

      const o2 = await s2.done
      assert.equal(o2.ok, false, 'вторая реплика обязана быть отвергнута сразу')
      assert.equal(o2.errorCode, 'invalid_params')
      assert.match(String(o2.message), /уже делает ход/)

      const o1 = await s1.done
      assert.equal(o1.ok, true, `первый ход обязан доехать: ${String(o1.message)}`)

      assert.ok(await waitFor(() => r.client().filter((m) => m.method === 'turn/start').length === 1, 5000))
      await sleep(200)
      assert.equal(r.client().filter((m) => m.method === 'turn/start').length, 1, 'на провод ушёл лишний ход')
      assert.equal(r.client().filter((m) => m.method === 'thread/start').length, 1, 'тред тоже обязан быть один')
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('СНЯТАЯ СЕССИЯ: close() посреди проверки стража не даёт ходу дойти до провода', async () => {
    // НАХОДКА РАЗБОРА В3 (P1). После каждого `await` в ходе проверялся только
    // `stopRequested`, а `close()` ставит `closing` и вынимает сессию из `live`. Ход,
    // проскочивший проверку занятости, этого не замечал и доходил до `thread/start` +
    // `turn/start` для УДАЛЁННОЙ сессии: `pult agent rm` вернул управление, а агент продолжал
    // выполнять команды. Его `done` при этом не резолвился никогда — уведомления по треду
    // демультиплексор уже выбрасывал, хозяина нет.
    const r = rig({ net: async () => { await sleep(200); return okCheck() } })
    try {
      await r.adapter.startSession(spec(r, 'w'))
      const p = r.adapter.send('w', 'привет')
      await r.adapter.close('w')
      const started = await p
      // Даём ходу, которого быть не должно, честный шанс проявиться.
      await sleep(400)
      assert.deepEqual(
        r.client().filter((m) => m.method === 'turn/start'),
        [],
        'ход снятой сессии не имеет права уйти на провод',
      )
      assert.equal(r.boots(), 0, 'снятой сессии не за чем поднимать общий процесс')
      const outcome = await started.done
      assert.equal(outcome.ok, false)
      assert.equal(outcome.errorCode, 'interrupted', 'исход по контракту interrupt, а не internal')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('codex: фоновая работа после хода — «фон · N», как у Claude (28.10.2026)', () => {
  const bgEvents = (r: Rig): Array<{ count: number; tasks: Array<{ type: string; description: string }>; reason?: string }> =>
    r.drafts.filter((d) => d.kind === 'background.changed').map((d) => d.data as never)
  const statuses = (r: Rig): string[] => r.drafts.filter((d) => d.kind === 'status.changed').map((d) => String(d.data?.['status']))

  it('субагент и команда пережили ход: фон 2 → 1 → 0 на их концах; статус после хода не трогается', async () => {
    const r = rig()
    try {
      await r.adapter.startSession(spec(r, 'w'))
      const turn = await r.adapter.send('w', '[[background]] проверь')
      const outcome = await turn.done
      assert.equal(outcome.ok, true)
      assert.ok(await waitFor(() => bgEvents(r).some((b) => b.count === 0), 5000), 'фон не обнулился')
      const counts = bgEvents(r).map((b) => b.count)
      assert.deepEqual(counts, [2, 1, 0])
      const first = bgEvents(r)[0]!
      assert.deepEqual(first.tasks.map((t) => t.type).sort(), ['command', 'subagent'])
      assert.ok(first.tasks.some((t) => t.description === 'npm test'), 'команда — без обёртки оболочки')
      // После `idle` хода ни одного `working`: поздние концы статус не двигают.
      const st = statuses(r)
      assert.equal(st.at(-1), 'idle')
      assert.equal(st.lastIndexOf('working') < st.indexOf('idle'), true)
      // Концы пришли верхними событиями, как в живых журналах.
      assert.ok(r.drafts.some((d) => d.kind === 'agent.finished' && !d.parentId))
      assert.ok(r.drafts.some((d) => d.kind === 'tool.finished' && !d.parentId && d.data?.['name'] === 'commandExecution'))
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('конец потерян: запись, молчащая дольше потолка, снимается сама', async () => {
    const r = rig({ backgroundMaxMs: 400, fake: { bgPauseMs: 50 } })
    try {
      await r.adapter.startSession(spec(r, 'w'))
      await (await r.adapter.send('w', '[[background-lost]] проверь')).done
      assert.ok(await waitFor(() => bgEvents(r).some((b) => b.count === 0 && b.reason === 'background_silence'), 5000), 'зависшая запись не снята')
      assert.deepEqual(bgEvents(r).map((b) => b.count), [2, 1, 0])
    } finally { await r.adapter.shutdown(); r.remove() }
  })

  it('сессию закрыли — фон обнуляется до `done`', async () => {
    const r = rig({ fake: { bgPauseMs: 5_000 } })
    try {
      await r.adapter.startSession(spec(r, 'w'))
      await (await r.adapter.send('w', '[[background]] проверь')).done
      assert.ok(await waitFor(() => bgEvents(r).length > 0, 3000))
      await r.adapter.close('w')
      const last = bgEvents(r).at(-1)
      assert.equal(last?.count, 0)
      assert.equal(last?.reason, 'session_closed')
      assert.equal(statuses(r).at(-1), 'done')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('codex: ход, начатый сервером (сообщение субагента будит родителя)', () => {
  const st = (r: Rig): string[] => r.drafts.filter((d) => d.kind === 'status.changed').map((d) => `${String(d.data?.['status'])}:${String(d.data?.['reason'] ?? '')}`)

  it('working {server_turn} → idle {server_turn_done}; реплика человека ждёт его конца, а не сталкивается', async () => {
    const r = rig({ fake: { bgPauseMs: 400 } })
    try {
      await r.adapter.startSession(spec(r, 'w'))
      await (await r.adapter.send('w', '[[server-turn]] начни')).done
      assert.ok(await waitFor(() => st(r).includes('working:server_turn'), 3000), `статусы: ${st(r).join(', ')}`)
      assert.ok(r.drafts.some((d) => d.kind === 'message.done' && d.data?.['text'] === 'субагент отчитался'))
      // Человек пишет посреди хода сервера.
      const second = await r.adapter.send('w', 'ещё вопрос')
      const outcome = await second.done
      assert.equal(outcome.ok, true)
      assert.deepEqual(r.raw().filter((x) => x.ev === 'collision'), [], 'turn/start ушёл посреди хода сервера')
      const order = r.raw().map((x) => x.ev === 'server-turn-completed' ? 'srv-done' : x.msg?.method === 'turn/start' ? 'turn/start' : null).filter(Boolean)
      assert.deepEqual(order, ['turn/start', 'srv-done', 'turn/start'])
      const s = st(r)
      assert.ok(s.indexOf('idle:server_turn_done') > s.indexOf('working:server_turn'))
      assert.equal(s.at(-1), 'idle:')
    } finally { await r.adapter.shutdown(); r.remove() }
  })
})

describe('codex: фон — чистый счёт (background.ts)', () => {
  let t = 0
  const bg = (): ReturnType<typeof createCodexBackground> => createCodexBackground({ now: () => t, silenceMs: 1000 })
  const d = (kind: string, data: Record<string, unknown>, parentId?: string): EventDraft =>
    ({ sessionId: 'w', provider: 'codex', kind: kind as EventDraft['kind'], data, ...(parentId ? { parentId } : {}) })

  it('элемент, начатый ВНЕ хода, — сразу фон; внутри хода — только на его конце', () => {
    t = 0
    const b = bg()
    b.turnStarted()
    assert.equal(b.onDraft(d('tool.called', { toolUseId: 'e1', name: 'commandExecution', input: { command: 'make' } })), false)
    assert.equal(b.data().count, 0, 'в ходе — инструмент хода')
    assert.equal(b.turnEnded(), true)
    assert.equal(b.data().count, 1)
    assert.equal(b.onDraft(d('agent.spawned', { toolUseId: 'a1', name: 'Agent', subagentType: '/root/late' })), true, 'после конца хода — сразу фон')
    assert.equal(b.data().count, 2)
    assert.deepEqual(b.data().tasks.map((x) => x.description), ['make', 'субагент /root/late'])
  })

  it('жизнь внука (субагент субагента) держит запись верхнего уровня', () => {
    t = 0
    const b = bg()
    b.turnStarted()
    b.onDraft(d('agent.spawned', { toolUseId: 'a1', name: 'Agent' }))
    b.turnEnded()
    b.onDraft(d('agent.spawned', { toolUseId: 'a2', name: 'Agent' }, 'a1'))
    b.onDraft(d('tool.called', { toolUseId: 'e2', name: 'commandExecution', input: { command: 'sleep 1' } }, 'a2'))
    for (t = 500; t <= 3000; t += 500) b.touch('a2')
    assert.deepEqual(b.sweep(), [], 'внук жив — субагент не снят')
    assert.equal(b.data().count, 1)
    t += 1500
    assert.equal(b.sweep().length, 1, 'замолчали все — снят')
  })
})
