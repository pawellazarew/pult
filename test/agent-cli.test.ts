// Сквозной прогон CLI против настоящего демона с ФАЛЬШИВЫМ `claude`:
// start → prompt --wait → read → tree → круг разрешений → stop → rm, плюс коды выхода.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { ensureLayout } from '../dist/core/paths.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { connectClient } from '../dist/cli/client.js'
import { layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { FAKE_CLAUDE, waitFor } from './helpers.js'

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))

interface Run { code: number; stdout: string; stderr: string }

/** Ответ стража сети для демона: `ok` — пускать ход, `blocked` — запрещать. */
let netMode: 'ok' | 'blocked' = 'ok'

function runCli(paths: PultPaths, args: string[], timeoutMs = 25_000, extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      // PULT_TEST_NET делает прогон герметичным: без неё демон звал настоящий `curl`
      // и результат зависел от страны выхода машины (ревью В3 — течёт и В2).
      env: { ...process.env, PULT_LANG: 'ru', PULT_HOME: paths.home, PULT_TEST: '1', PULT_TEST_NET: netMode, PULT_CLAUDE_BIN: FAKE_CLAUDE, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pult ${args.join(' ')} не завершился`)) }, timeoutMs)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

let dir: string
let paths: PultPaths
let work: string

/** Папка сессии + настройка фальшивого CLI: через окружение она не пройдёт (белый список). */
function makeWork(name: string, scenario: string): string {
  const w = join(dir, name)
  mkdirSync(w, { recursive: true })
  writeFileSync(join(w, '.pult-fake.json'), JSON.stringify({ scenario, speed: 0 }))
  return w
}

describe('CLI: агенты сквозным прогоном', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'pt-cli2-'))
    paths = layout(join(dir, 'h'))
    ensureLayout(paths)
    // Отсрочка на фонового субагента — 800 мс вместо 30 с: тест не должен ждать полминуты
    // ради факта, который проверяется мгновенно.
    writeFileSync(paths.config, JSON.stringify({ version: 1, subagentGraceMs: 800 }))
    work = makeWork('work', 'simple')
  })
  after(async () => {
    await runCli(paths, ['daemon', 'stop'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('agent start заводит агента и показывает его в list', async () => {
    const start = await runCli(paths, ['agent', 'start', 'w', '--kind', 'claude', '--cwd', work, '--model', 'haiku', '--effort', 'low'])
    assert.equal(start.code, 0, start.stderr)
    assert.match(start.stdout, /агент w заведён/)

    const list = await runCli(paths, ['agent', 'list', '--json'])
    assert.equal(list.code, 0)
    const parsed = JSON.parse(list.stdout) as { sessions: Array<{ name: string; lastStatus: string; mode: string }> }
    assert.equal(parsed.sessions.length, 1)
    assert.equal(parsed.sessions[0]?.name, 'w')
    assert.equal(parsed.sessions[0]?.mode, 'turn')
    assert.equal(parsed.sessions[0]?.lastStatus, 'cold')
  })

  it('папка — домашняя (или выше): заводит, но предупреждает; в «только чтение» — молча', async () => {
    // PULT_HOME лежит не в этом «доме» — старт не отказ, а предупреждение: агент правил бы ~/.claude, ~/.zshrc…
    const fakeHome = makeWork('fakehome', 'simple')
    const warn = /внимание — папка — домашняя или выше: агент сможет менять ~\/\.claude, ~\/\.codex, ~\/\.zshrc/
    const a = await runCli(paths, ['agent', 'start', 'hw', '--kind', 'claude', '--cwd', fakeHome], 25_000, { HOME: fakeHome })
    assert.equal(a.code, 0, a.stderr)
    assert.match(a.stderr, warn)
    const b = await runCli(paths, ['agent', 'start', 'hr', '--kind', 'claude', '--cwd', fakeHome, '--approval', 'read-only'], 25_000, { HOME: fakeHome })
    assert.equal(b.code, 0, b.stderr)
    assert.doesNotMatch(b.stderr, warn)
    // Обычная папка проекта под этим домом — без предупреждения.
    const c = await runCli(paths, ['agent', 'start', 'hp', '--kind', 'claude', '--cwd', work], 25_000, { HOME: fakeHome })
    assert.equal(c.code, 0, c.stderr)
    assert.doesNotMatch(c.stderr, warn)
    for (const n of ['hw', 'hr', 'hp']) assert.equal((await runCli(paths, ['agent', 'rm', n])).code, 0)
  })

  it('pult session … — то же, что pult agent … (окно зовёт агентов сессиями)', async () => {
    const viaSession = await runCli(paths, ['session', 'list', '--json'])
    assert.equal(viaSession.code, 0, viaSession.stderr)
    assert.deepEqual(JSON.parse(viaSession.stdout), JSON.parse((await runCli(paths, ['agent', 'list', '--json'])).stdout))
  })

  it('agent rename: название меняется и снимается, имя — ключ — остаётся', async () => {
    const r = await runCli(paths, ['agent', 'rename', 'w', 'Починить', 'VPN'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /агент w теперь «Починить VPN»/)
    const one = (await runCli(paths, ['agent', 'list'])).stdout
    assert.match(one, /^w\s.*«Починить VPN»/m)
    const listed = async (): Promise<Array<{ name: string; title?: string }>> =>
      (JSON.parse((await runCli(paths, ['agent', 'list', '--json'])).stdout) as { sessions: Array<{ name: string; title?: string }> }).sessions
    assert.deepEqual((await listed()).map((s) => [s.name, s.title]), [['w', 'Починить VPN']])

    const long = await runCli(paths, ['agent', 'rename', 'w', 'я'.repeat(61)])
    assert.equal(long.code, 1)
    assert.match(long.stderr, /invalid_params — название длиннее 60 знаков/)
    const ghost = await runCli(paths, ['agent', 'rename', 'nobody', 'x'])
    assert.equal(ghost.code, 1)
    assert.match(ghost.stderr, /not_found/)
    assert.equal((await listed())[0]?.title, 'Починить VPN', 'отказ название не трогает')

    // `--title` — тот же синтаксис, что у `start`; раньше он читался как «слов нет» и СНИМАЛ название.
    const byFlag = await runCli(paths, ['agent', 'rename', 'w', '--title', 'Через флаг'])
    assert.equal(byFlag.code, 0, byFlag.stderr)
    assert.equal((await listed())[0]?.title, 'Через флаг')
    // Слово на «-» разбор значением не берёт: отказ, а не тихое «название снято»; через `=` — проходит.
    for (const bad of [['--title', '-5', 'градусов'], ['слова', '--title', 'и флаг'], ['--title']]) {
      const r2 = await runCli(paths, ['agent', 'rename', 'w', ...bad])
      assert.equal(r2.code, 1, bad.join(' '))
      assert.match(r2.stderr, /либо словами после имени, либо --title/)
    }
    assert.equal((await listed())[0]?.title, 'Через флаг')
    assert.equal((await runCli(paths, ['agent', 'rename', 'w', '--title=-5 градусов'])).code, 0)
    assert.equal((await listed())[0]?.title, '-5 градусов')

    // Протокол: снять название — это явное `title: ''`. Забытый параметр и null — отказ, название цело.
    const raw = await connectClient(paths)
    try {
      for (const params of [{ name: 'w' }, { name: 'w', title: null }, { name: 'w', title: 42 }]) {
        await assert.rejects(() => raw.request('agent.rename', params), (e: { code?: string }) => e.code === 'invalid_params', JSON.stringify(params))
      }
    } finally { raw.close() }
    assert.equal((await listed())[0]?.title, '-5 градусов')

    const cleared = await runCli(paths, ['agent', 'rename', 'w'])
    assert.equal(cleared.code, 0, cleared.stderr)
    assert.match(cleared.stdout, /название снято/)
    assert.ok(!('title' in ((await listed())[0] as object)))
  })

  it('agent start --title заводит агента сразу с названием', async () => {
    const t = makeWork('titled', 'simple')
    const r = await runCli(paths, ['agent', 'start', 'titled', '--cwd', t, '--title', 'Релиз Эха', '--json'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal((JSON.parse(r.stdout) as { title?: string }).title, 'Релиз Эха')
    assert.equal((await runCli(paths, ['agent', 'rm', 'titled'])).code, 0)
    // `--title -важное-`: без отказа агент завёлся бы без названия и без слова об этом.
    const dash = await runCli(paths, ['agent', 'start', 'titled', '--cwd', t, '--title', '-важное-'])
    assert.equal(dash.code, 1)
    assert.match(dash.stderr, /--title требует название/)
    assert.ok(!(JSON.parse((await runCli(paths, ['agent', 'list', '--json'])).stdout) as { sessions: Array<{ name: string }> }).sessions.some((s) => s.name === 'titled'))
  })

  it('кривое имя агента отвергается с кодом 1', async () => {
    const r = await runCli(paths, ['agent', 'start', 'ЗАГЛАВНЫМИ', '--cwd', work])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /invalid_params/)
  })

  it('prompt --wait печатает ответ модели и выходит 0', async () => {
    const r = await runCli(paths, ['agent', 'prompt', 'w', 'скажи PULT', '--wait'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /PULT/)
  })

  it('prompt без --wait возвращает id хода сразу', async () => {
    const r = await runCli(paths, ['agent', 'prompt', 'w', 'ещё раз', '--json'])
    assert.equal(r.code, 0, r.stderr)
    const parsed = JSON.parse(r.stdout) as { turnId: string; waiting: boolean }
    assert.match(parsed.turnId, /^t\d+$/)
    assert.equal(parsed.waiting, false)
    // Дожидаемся, иначе следующий ход упрётся в «сессия уже делает ход».
    await runCli(paths, ['agent', 'wait', 'w'])
  })

  it('agent list: ● — непрочитано после хода; agent seen снимает, --unread ставит', async () => {
    const line = async (): Promise<string> => (await runCli(paths, ['agent', 'list'])).stdout.split('\n').find((l) => /^w\s/.test(l)) ?? ''
    assert.match(await line(), /^w\s+● claude/)
    const seen = await runCli(paths, ['agent', 'seen', 'w'])
    assert.equal(seen.code, 0, seen.stderr)
    assert.match(seen.stdout, /сессия w прочитана/)
    const read = await line()
    assert.match(read, /^w\s+· claude/)
    assert.equal(read.indexOf('claude'), 19, 'колонки на месте')
    assert.equal(read.trim().split(/\s+/)[1], '·', 'колонка — всегда одно слово: разбор по пробелам стабилен')
    assert.equal((await runCli(paths, ['agent', 'seen', 'w', '--unread'])).code, 0)
    assert.match(await line(), /^w\s+● claude/)
    const json = JSON.parse((await runCli(paths, ['agent', 'list', '--json'])).stdout) as { sessions: Array<{ name: string; markedUnread?: boolean; attention?: { kind: string } }> }
    const w = json.sessions.find((s) => s.name === 'w')
    assert.deepEqual([w?.markedUnread, w?.attention?.kind], [true, 'done'])
    await runCli(paths, ['agent', 'seen', 'w'])
  })

  it('agent read печатает текст модели, --format json — события', async () => {
    const text = await runCli(paths, ['agent', 'read', 'w'])
    assert.equal(text.code, 0)
    assert.match(text.stdout, /PULT/)

    const json = await runCli(paths, ['agent', 'read', 'w', '--format', 'json'])
    assert.equal(json.code, 0)
    const events = json.stdout.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; sessionId: string })
    assert.ok(events.length > 5)
    assert.ok(events.every((e) => e.sessionId === 'w'))
    assert.ok(events.some((e) => e.kind === 'session.started'))
    assert.ok(events.some((e) => e.kind === 'usage.updated'))
  })

  it('usage показывает оба окна лимита', async () => {
    const r = await runCli(paths, ['usage', '--json'])
    assert.equal(r.code, 0)
    const parsed = JSON.parse(r.stdout) as { usage: Array<{ session: string; turns: number; rateLimit: { windows: { five_hour: { utilization: number }; seven_day: { utilization: number } } } }> }
    const row = parsed.usage.find((u) => u.session === 'w')
    assert.ok(row)
    assert.ok(row.turns >= 2)
    assert.equal(typeof row.rateLimit.windows.five_hour.utilization, 'number')
    assert.equal(typeof row.rateLimit.windows.seven_day.utilization, 'number')

    const human = await runCli(paths, ['usage'])
    assert.match(human.stdout, /окна лимита/)
  })

  it('agent list: колонка ctx — доля контекстного окна; --json несёт context целиком', async () => {
    const json = await runCli(paths, ['session', 'list', '--json'])
    assert.equal(json.code, 0, json.stderr)
    const w = (JSON.parse(json.stdout) as { sessions: Array<{ name: string; context?: { used: number; window: number | null; model: string | null; at: string } }> })
      .sessions.find((s) => s.name === 'w')
    // Фикстура 01: подсказка 10 + 9693 + 13689, окно haiku 200 000 → 12%.
    assert.deepEqual([w?.context?.used, w?.context?.window, w?.context?.model], [23392, 200000, 'claude-haiku-4-5-20251001'])
    assert.equal(typeof w?.context?.at, 'string')
    const human = await runCli(paths, ['agent', 'list'])
    assert.match(human.stdout, /^w\s.*· ctx 12%/m)
  })

  it('agent tree рисует субагента отступами', async () => {
    const sub = makeWork('sub', 'subagent')
    assert.equal((await runCli(paths, ['agent', 'start', 'sub', '--cwd', sub])).code, 0)
    const r = await runCli(paths, ['agent', 'prompt', 'sub', 'позови субагента', '--wait', '--timeout', '20000'])
    assert.equal(r.code, 0, r.stderr)
    const tree = await runCli(paths, ['agent', 'tree', 'sub'])
    assert.equal(tree.code, 0)
    assert.match(tree.stdout, /Agent\(Explore\)/)
    const json = JSON.parse((await runCli(paths, ['agent', 'tree', 'sub', '--json'])).stdout) as { roots: Array<{ kind: string; children: unknown[] }> }
    assert.ok(json.roots.some((n) => n.kind === 'agent'))
  })

  it('stop и rm убирают агента', async () => {
    assert.equal((await runCli(paths, ['agent', 'stop', 'sub'])).code, 0)
    assert.equal((await runCli(paths, ['agent', 'rm', 'sub'])).code, 0)
    const list = JSON.parse((await runCli(paths, ['agent', 'list', '--json'])).stdout) as { sessions: unknown[] }
    assert.equal(list.sessions.length, 1)
    const gone = await runCli(paths, ['agent', 'prompt', 'sub', 'ау', '--wait'])
    assert.equal(gone.code, 1)
    assert.match(gone.stderr, /not_found/)
  })

  it('РЕСТАРТ ДЕМОНА: агент жив, следующая реплика проходит', async () => {
    // НАБЛЮДЕНО 21.09.2026: после `daemon stop` + `daemon start` любая реплика отвечала
    // `pult agent: internal — сессия w не заведена в адаптере`, и агент был мёртв до
    // `agent rm`. Реестр сессию переживал, адаптер — нет, и подцеплять их было некому.
    assert.equal((await runCli(paths, ['daemon', 'stop'])).code, 0)
    // Следующая команда поднимет демон сама — это и есть перезапуск.
    const list = await runCli(paths, ['agent', 'list', '--json'])
    assert.equal(list.code, 0, list.stderr)
    const before = JSON.parse(list.stdout) as { sessions: Array<{ name: string; lastStatus: string }> }
    const w = before.sessions.find((s) => s.name === 'w')
    assert.ok(w, 'реестр обязан пережить рестарт')
    assert.equal(w.lastStatus, 'cold', 'после рестарта ни один процесс не жив')

    const r = await runCli(paths, ['agent', 'prompt', 'w', 'помнишь меня?', '--wait', '--timeout', '20000'], 40_000)
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${r.stderr}`)
  })

  it('КОД 4: страж сети — блок страны', async () => {
    const blocked = makeWork('blocked', 'simple')
    await runCli(paths, ['daemon', 'stop'])
    netMode = 'blocked'
    try {
      assert.equal((await runCli(paths, ['agent', 'start', 'nb', '--cwd', blocked])).code, 0)
      const r = await runCli(paths, ['agent', 'prompt', 'nb', 'привет', '--wait', '--timeout', '20000'], 40_000)
      assert.equal(r.code, 4, `stdout=${r.stdout} stderr=${r.stderr}`)
      assert.match(r.stderr, /blocked_network/)
      assert.match(r.stderr, /страж сети: blocked_country/, 'человек обязан прочитать причину')
    } finally {
      netMode = 'ok'
      await runCli(paths, ['daemon', 'stop'])
    }
  })

  it('КОД 5: блок аккаунта останавливает провайдера, второй start отвергается', async () => {
    const blockWork = makeWork('block', 'account-block')
    assert.equal((await runCli(paths, ['agent', 'start', 'ab', '--cwd', blockWork])).code, 0)
    const r = await runCli(paths, ['agent', 'prompt', 'ab', 'привет', '--wait'])
    assert.equal(r.code, 5, `stdout=${r.stdout} stderr=${r.stderr}`)

    const second = await runCli(paths, ['agent', 'start', 'ab2', '--cwd', blockWork])
    assert.equal(second.code, 5)
    assert.match(second.stderr, /provider_unavailable/)

    const reset = await runCli(paths, ['provider', 'reset', 'claude'])
    assert.equal(reset.code, 0)
    assert.match(reset.stdout, /снята/)
    assert.equal((await runCli(paths, ['agent', 'start', 'ab3', '--cwd', blockWork])).code, 0)
  })

  it('КОД 2: таймаут ожидания', async () => {
    const slow = makeWork('slow', 'simple')
    writeFileSync(join(slow, '.pult-fake.json'), JSON.stringify({ scenario: 'simple', speed: 0, hang: 8000 }))
    assert.equal((await runCli(paths, ['agent', 'start', 'slow', '--cwd', slow])).code, 0)
    const r = await runCli(paths, ['agent', 'prompt', 'slow', 'привет', '--wait', '--timeout', '400'])
    assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`)
    assert.match(r.stderr, /таймаут/)
    await runCli(paths, ['agent', 'stop', 'slow'])
  })
})

describe('CLI: круг разрешений', () => {
  let dir2: string
  let paths2: PultPaths

  before(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'pt-cli3-'))
    paths2 = layout(join(dir2, 'h'))
  })
  after(async () => {
    await runCli(paths2, ['daemon', 'stop'])
    rmSync(dir2, { recursive: true, force: true })
  })

  it('КОД 3: ход встаёт на разрешении, perm list его показывает, approve отпускает', async () => {
    const w = join(dir2, 'work')
    mkdirSync(w, { recursive: true })
    writeFileSync(join(w, '.pult-fake.json'), JSON.stringify({ scenario: 'permission', speed: 0 }))
    assert.equal((await runCli(paths2, ['agent', 'start', 'p', '--cwd', w])).code, 0, 'agent start')

    // Без --wait: ход уходит в фон и упирается в вопрос разрешения.
    const started = await runCli(paths2, ['agent', 'prompt', 'p', 'правь файл', '--json'])
    assert.equal(started.code, 0, started.stderr)

    // Вопрос обязан появиться в Inbox.
    let pendingId = ''
    const seen = await waitFor(async () => {
      const r = await runCli(paths2, ['perm', 'list', '--json'])
      const parsed = JSON.parse(r.stdout) as { pending: Array<{ id: string; toolName: string; sessionId: string }> }
      if (parsed.pending.length === 0) return false
      pendingId = parsed.pending[0]!.id
      assert.equal(parsed.pending[0]?.sessionId, 'p')
      return true
    }, 15_000)
    assert.ok(seen, 'запрос разрешения должен попасть в pult perm list')

    // Пока ждём человека — `agent wait --until blocked` отвечает кодом 3.
    const blocked = await runCli(paths2, ['agent', 'wait', 'p', '--until', 'blocked', '--timeout', '5000'])
    assert.equal(blocked.code, 3, `stdout=${blocked.stdout} stderr=${blocked.stderr}`)

    const approve = await runCli(paths2, ['perm', 'approve', pendingId])
    assert.equal(approve.code, 0)
    assert.match(approve.stdout, /разрешено/)

    // Очередь пуста, ход доезжает.
    const empty = JSON.parse((await runCli(paths2, ['perm', 'list', '--json'])).stdout) as { pending: unknown[] }
    assert.equal(empty.pending.length, 0)
    const done = await runCli(paths2, ['agent', 'wait', 'p', '--timeout', '20000'], 30_000)
    assert.equal(done.code, 0, `stdout=${done.stdout} stderr=${done.stderr}`)

    // События разрешений записаны в журнал.
    const events = (await runCli(paths2, ['agent', 'read', 'p', '--format', 'json'])).stdout
      .trim().split('\n').map((l) => JSON.parse(l) as { kind: string })
    assert.ok(events.some((e) => e.kind === 'permission.requested'))
    assert.ok(events.some((e) => e.kind === 'permission.resolved'))
  })

  it('perm deny --reason отвечает отказом, а несуществующий id — not_found', async () => {
    const r = await runCli(paths2, ['perm', 'deny', 'p999', '--reason', 'нельзя'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /not_found/)
  })
})
