// Сквозной прогон настоящих собранных бинарей: подъём по требованию → состояние → хвост
// событий → остановка. Демона здесь никто не поднимает «изнутри»: всё через `dist/cli/main.js`.
//
// `pult doctor` без фальшивок тут НЕ гоняется намеренно: он спрашивает настоящие CLI и сеть,
// а на раннере CI их нет. Логика доктора закрыта doctor.test.ts на фальшивках.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import type { PultEvent } from '../dist/core/events.js'
import { layout } from '../dist/core/paths.js'
import type { PultPaths } from '../dist/core/paths.js'
import { connectClient } from '../dist/cli/client.js'
import { waitFor } from './helpers.js'

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))

interface CliRun {
  code: number | null
  stdout: string
  stderr: string
}

function runCli(paths: PultPaths, args: string[], extraEnv: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, PULT_LANG: 'ru', PULT_HOME: paths.home, PULT_TEST: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => { stdout += d })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => { stderr += d })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('CLI из конца в конец', () => {
  let dir = ''
  let paths: PultPaths

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'pc-'))
    paths = layout(dir)
  })

  after(async () => {
    await runCli(paths, ['daemon', 'stop'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('--version и --help не требуют демона', async () => {
    const v = await runCli(paths, ['--version'])
    assert.equal(v.code, 0)
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/)
    const h = await runCli(paths, ['--help'])
    assert.equal(h.code, 0)
    assert.match(h.stdout, /pult daemon start/)
  })

  it('status без демона — код 1 и внятный JSON', async () => {
    const r = await runCli(paths, ['daemon', 'status', '--json'])
    assert.equal(r.code, 1)
    assert.deepEqual(JSON.parse(r.stdout).running, false)
  })

  it('daemon start поднимает демона отсоединённым и он переживает свой CLI', async () => {
    const start = await runCli(paths, ['daemon', 'start'])
    assert.equal(start.code, 0)
    assert.match(start.stdout, /демон запущен: pid \d+/)

    // Процесс CLI уже завершился (мы дождались close), а демон обязан жить дальше.
    const status = await runCli(paths, ['daemon', 'status', '--json'])
    assert.equal(status.code, 0)
    const parsed = JSON.parse(status.stdout) as { running: boolean; pid: number; lastEventId: number }
    assert.equal(parsed.running, true)
    assert.ok(parsed.pid > 0)
    assert.ok(existsSync(paths.sock))

    // Повторный start не поднимает второго.
    const again = await runCli(paths, ['daemon', 'start', '--json'])
    const secondStatus = JSON.parse(again.stdout) as { alreadyRunning: boolean; status: { pid: number } }
    assert.equal(secondStatus.alreadyRunning, true)
    assert.equal(secondStatus.status.pid, parsed.pid)
  })

  it('второй pultd в том же доме выходит с кодом 3', async () => {
    const daemonEntry = fileURLToPath(new URL('../dist/daemon/main.js', import.meta.url))
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [daemonEntry], {
        env: { ...process.env, PULT_LANG: 'ru', PULT_HOME: paths.home },
        stdio: 'ignore',
      })
      child.on('exit', (c) => resolve(c))
    })
    assert.equal(code, 3)
  })

  it('events tail печатает поток с курсора', async () => {
    const r = await runCli(paths, ['events', 'tail', '--json', '--no-follow'])
    assert.equal(r.code, 0)
    const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as PultEvent)
    assert.equal(events[0]?.kind, 'daemon.started')
    assert.equal(events[0]?.id, 1)

    // С курсором выше последнего — пусто, но без ошибки.
    const empty = await runCli(paths, ['events', 'tail', '--json', '--no-follow', '--since', '999'])
    assert.equal(empty.code, 0)
    assert.equal(empty.stdout.trim(), '')
  })

  it('daemon logs показывает журнал', async () => {
    const r = await runCli(paths, ['daemon', 'logs', '-n', '5'])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /"msg":"демон слушает"|"msg":"клиент подключился"/)
  })

  it('голый pult update в тестах в сеть не ходит: код 1, причина и «ничего не поставлено»', async () => {
    // Канал обновлений (M8c) под PULT_TEST=1 берёт latest.json только из PULT_TEST_UPDATE_DIR.
    const r = await runCli(paths, ['update'], { PULT_UPDATE_URL: '' })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /PULT_TEST=1: сеть в тестах не трогается/)
    assert.match(r.stderr, /ничего не поставлено/)
    const both = await runCli(paths, ['update', '--from', 'x.tgz', '--to', '1.0.0'])
    assert.equal(both.code, 1)
    assert.match(both.stderr, /по одному за раз/)
  })

  it('неизвестная команда — код 1 и подсказка', async () => {
    const r = await runCli(paths, ['такой-команды-нет'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /неизвестная команда/)
  })

  it('daemon stop чистит run/ и второй stop не ломается', async () => {
    const stop = await runCli(paths, ['daemon', 'stop'])
    assert.equal(stop.code, 0)
    // Ждём исчезновения САМОГО lock-файла, а не сокета: lock снимается ПОСЛЕДНИМ (он —
    // арбитр «демон здесь один»), поэтому его пропажа и означает, что уборка дошла до конца.
    // Пока ждали сокет, тест изредка видел в каталоге `pultd.lock` и `token` (ревью В3).
    assert.ok(await waitFor(() => !existsSync(paths.lock)), 'lock-файл обязан исчезнуть')
    assert.ok(!existsSync(paths.sock))
    assert.deepEqual(readdirSync(paths.run), [], 'в run/ остался мусор')

    const again = await runCli(paths, ['daemon', 'stop'])
    assert.equal(again.code, 0)
    assert.match(again.stdout, /останавливать нечего/)
  })

  it('команда, которой нужен демон, поднимает его сама', async () => {
    // Демон только что остановлен предыдущим тестом.
    const r = await runCli(paths, ['events', 'tail', '--json', '--no-follow'])
    assert.equal(r.code, 0)
    const status = await runCli(paths, ['daemon', 'status', '--json'])
    assert.equal(JSON.parse(status.stdout).running, true)
  })

  it('запрос длиннее строки NDJSON отвергается у клиента и не рвёт соединение', async () => {
    // Демон рвёт соединение на строке > 1 МиБ — вместе с ним падали бы все остальные вызовы
    // этого соединения (у окна оно одно на всё). Клиент обязан отказать сам, не отправляя.
    const client = await connectClient(paths)
    try {
      await assert.rejects(client.request('agent.prompt', { name: 'x', text: 'x'.repeat(1_100_000) }), (e: { code?: string }) => e.code === 'payload_too_large')
      const st = (await client.request('daemon.status')) as { running?: boolean; pid?: number }
      assert.ok(st.pid, 'соединение живо после отказа')
    } finally {
      client.close()
    }
  })

  it('большой вывод не обрезается на медленной трубе', async () => {
    // process.exit() обрывает процесс НЕМЕДЛЕННО и выбрасывает всё, что ещё лежит в буфере
    // stdout. На трубе (`pult doctor --json | …`) это молчаливая потеря последних байт.
    // Читателя тут нарочно притормаживаем, чтобы CLI упёрся в backpressure и вышел с
    // неслитым хвостом.
    const client = await connectClient(paths)
    const before = (await client.request('daemon.status')) as { lastEventId: number }
    const pad = 'я'.repeat(500)
    for (let i = 0; i < 3; i++) {
      await client.request('events.emit', { kind: 'status.changed', count: 1000, sessionId: 'поток', data: { pad } })
    }
    const after = (await client.request('daemon.status')) as { lastEventId: number }
    client.close()
    assert.ok(after.lastEventId - before.lastEventId >= 3000)

    const { stdout, code } = await new Promise<{ stdout: string; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'events', 'tail', '--json', '--no-follow', '--since', String(before.lastEventId)], {
        env: { ...process.env, PULT_LANG: 'ru', PULT_HOME: paths.home, PULT_TEST: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.pause()
      setTimeout(() => {
        child.stdout.on('data', (d: string) => { out += d })
        child.stdout.resume()
      }, 500)
      child.on('close', (c) => resolve({ stdout: out, code: c }))
    })
    assert.equal(code, 0)
    const lines = stdout.split('\n').filter((l) => l.trim())
    // Каждая строка целая (обрезанный хвост — это битый JSON) и последнее событие на месте.
    const parsed = lines.map((l) => JSON.parse(l) as PultEvent)
    assert.ok(stdout.length > 1024 * 1024, `вывод всего ${stdout.length} байт — труба не переполнилась`)
    assert.equal(parsed[parsed.length - 1]?.id, after.lastEventId, 'хвост вывода потерян')
  })
})
