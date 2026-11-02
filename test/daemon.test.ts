// Демон: рукопожатие (успех и четыре отказа), один экземпляр, осиротевший сокет, права,
// штатная остановка, поведение при обрыве клиента.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { PultEvent } from '../dist/core/events.js'
import { startDaemon } from '../dist/daemon/server.js'
import { PROTOCOL_VERSION } from '../dist/core/rpc.js'
import { readToken } from '../dist/core/token.js'
import { rawConnect, sleep, startTestDaemon, tempHome, waitFor } from './helpers.js'

const DAEMON_ENTRY = fileURLToPath(new URL('../dist/daemon/main.js', import.meta.url))

async function hello(paths: { sock: string; token: string }, token?: string) {
  const conn = await rawConnect(paths as never)
  conn.send({ type: 'hello', token: token ?? readToken(paths.token), client: 'cli', protocol: PROTOCOL_VERSION })
  return conn
}

describe('рукопожатие', () => {
  it('правильный токен — hello_ok с версией и pid', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await hello(home.paths)
      const frame = await conn.next()
      assert.equal(frame['type'], 'hello_ok')
      assert.equal(frame['protocol'], PROTOCOL_VERSION)
      const info = frame['daemon'] as Record<string, unknown>
      assert.equal(info['pid'], process.pid)
      assert.ok(typeof info['version'] === 'string')
      conn.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('отказ 1: неверный токен → bad_token и разрыв', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await hello(home.paths, 'f'.repeat(64))
      const frame = await conn.next()
      assert.equal(frame['code'], 'bad_token')
      await conn.closed
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('отказ 2: первым сообщением не hello → handshake_required', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await rawConnect(home.paths)
      conn.send({ id: 1, method: 'daemon.status' })
      const frame = await conn.next()
      assert.equal(frame['code'], 'handshake_required')
      await conn.closed
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('отказ 3: мусор вместо JSON → bad_json', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await rawConnect(home.paths)
      conn.socket.write('это не json\n')
      const frame = await conn.next()
      assert.equal(frame['code'], 'bad_json')
      await conn.closed
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('отказ 4: молчание дольше 2 с → handshake_timeout', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await rawConnect(home.paths)
      const frame = await conn.next(4000)
      assert.equal(frame['code'], 'handshake_timeout')
      await conn.closed
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('слишком длинная строка рвёт соединение с line_too_long', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await rawConnect(home.paths)
      conn.socket.write('{"type":"hello","token":"' + 'x'.repeat(1024 * 1024 + 16))
      const frame = await conn.next(5000)
      assert.equal(frame['code'], 'line_too_long')
      await conn.closed
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('`null` вместо объекта до рукопожатия — bad_json, а не падение демона', async () => {
    // `null`, `[]` и `42` — валидный JSON. Раньше первое же `null\n` от неаутентифицирован-
    // ного клиента падало на msg['type'] неперехваченным TypeError и убивало ВЕСЬ демон,
    // ещё до проверки токена.
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      for (const junk of ['null', '[]', '42', '"строка"']) {
        const conn = await rawConnect(home.paths)
        conn.socket.write(junk + '\n')
        const frame = await conn.next()
        assert.equal(frame['code'], 'bad_json', junk)
        await conn.closed
      }
      // Демон жив и обслуживает нормального клиента.
      const ok = await hello(home.paths)
      assert.equal((await ok.next())['type'], 'hello_ok')
      ok.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('токен меняется на каждом старте демона', async () => {
    const home = tempHome()
    const first = await startTestDaemon(home)
    const tokenA = first.token
    await first.stop('тест')
    const second = await startTestDaemon(home)
    try {
      assert.notEqual(second.token, tokenA)
      const conn = await hello(home.paths, tokenA)
      const frame = await conn.next()
      assert.equal(frame['code'], 'bad_token')
    } finally {
      await second.stop('тест')
      home.remove()
    }
  })
})

describe('один экземпляр', () => {
  it('второй демон в том же PULT_HOME выходит с кодом 3', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [DAEMON_ENTRY], {
          env: { ...process.env, PULT_HOME: home.paths.home },
          stdio: 'ignore',
        })
        child.on('exit', (c) => resolve(c))
      })
      assert.equal(code, 3)
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('осиротевший сокет удаляется только после взятия lock', async () => {
    const home = tempHome()
    // Файл на месте сокета остался от мёртвого демона.
    writeFileSync(home.paths.sock, 'мусор')
    const daemon = await startTestDaemon(home)
    try {
      assert.equal(statSync(home.paths.sock).isSocket(), true)
      // Живой демон держит lock, значит второй НЕ имеет права трогать сокет.
      const before = statSync(home.paths.sock).ino
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [DAEMON_ENTRY], {
          env: { ...process.env, PULT_HOME: home.paths.home },
          stdio: 'ignore',
        })
        child.on('exit', (c) => resolve(c))
      })
      assert.equal(code, 3)
      assert.equal(statSync(home.paths.sock).ino, before, 'чужой сокет был удалён вторым экземпляром')
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('ГОНКА: второй демон стартует ПОСРЕДИ остановки первого — либо честный отказ, либо рабочий демон', async () => {
    // Порядок уборки в `stop()` важен ровно здесь: lock снимается ПОСЛЕДНИМ. Иначе между
    // `lock.release()` и `unlink(sock)` второй демон успевает взять lock, занять сокет — а
    // уходящий первый сносит уже ЧУЖОЙ свежий сокет, и демон остаётся недостижимым.
    // Недостижимый демон — единственный исход, которого быть не должно.
    for (let attempt = 0; attempt < 6; attempt++) {
      const home = tempHome()
      const first = await startTestDaemon(home)
      try {
        // Остановку НЕ ждём: второй старт идёт ей навстречу.
        const stopping = first.stop('гонка')
        const second = await startDaemon({
          paths: home.paths,
          config: home.config,
          logger: home.logger,
          testMode: true,
        })
        await stopping
        if (!second.ok) {
          assert.equal(second.reason, 'locked', 'отказ обязан быть честным: lock держит первый')
          continue
        }
        try {
          // Взял lock — значит обязан быть ДОСТИЖИМЫМ: сокет на месте и отвечает.
          assert.ok(existsSync(home.paths.sock), 'демон взял lock, но сокета нет')
          await new Promise<void>((resolve, reject) => {
            const s = net.connect(home.paths.sock)
            s.once('connect', () => { s.destroy(); resolve() })
            s.once('error', reject)
          })
        } finally {
          await second.daemon.stop('тест')
        }
      } finally {
        home.remove()
      }
    }
  })
})

describe('права и остановка', () => {
  it('каталоги 0700, сокет и токен 0600', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      for (const dir of [home.paths.home, home.paths.run, home.paths.events, home.paths.logs]) {
        assert.equal(statSync(dir).mode & 0o777, 0o700, dir)
      }
      for (const f of [home.paths.sock, home.paths.token]) {
        assert.equal(statSync(f).mode & 0o777, 0o600, f)
      }
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('штатная остановка убирает сокет, токен и lock', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    await daemon.stop('тест')
    try {
      assert.equal(existsSync(home.paths.sock), false, 'сокет остался')
      assert.equal(existsSync(home.paths.token), false, 'токен остался')
      assert.equal(existsSync(home.paths.lock), false, 'lock остался')
      // Последнее событие — daemon.stopping: журнал объясняет, почему поток оборвался.
      const tail = daemon.store.readFrom(0)
      assert.equal(tail[tail.length - 1]?.kind, 'daemon.stopping')
    } finally {
      home.remove()
    }
  })

  it('после остановки PULT_HOME можно занять заново', async () => {
    const home = tempHome()
    const first = await startTestDaemon(home)
    await first.stop('тест')
    const second = await startTestDaemon(home)
    try {
      assert.ok(second.status().pid > 0)
    } finally {
      await second.stop('тест')
      home.remove()
    }
  })
})

describe('диспетчер', () => {
  it('методы В1 и В2 отвечают, неизвестный метод — not_found', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await hello(home.paths)
      await conn.next() // hello_ok

      conn.send({ id: 1, method: 'daemon.status' })
      const status = (await conn.next())['result'] as Record<string, unknown>
      assert.equal(status['protocol'], PROTOCOL_VERSION)
      assert.equal(status['home'], home.paths.home)

      // В2: метод реализован, поэтому пустые параметры должны дать разбор параметров,
      // а не «метода нет».
      conn.send({ id: 2, method: 'agent.start', params: {} })
      const later = (await conn.next())['error'] as Record<string, unknown>
      assert.equal(later['code'], 'invalid_params')

      conn.send({ id: 3, method: 'нет.такого' })
      const unknown = (await conn.next())['error'] as Record<string, unknown>
      assert.equal(unknown['code'], 'not_found')

      conn.send({ id: 4, method: 'events.tail', params: { since: 0 } })
      const tail = (await conn.next())['result'] as { events: unknown[] }
      assert.equal(tail.events.length, 1) // daemon.started

      conn.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('events.emit закрыт, когда PULT_TEST не выставлен', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home, { testMode: false })
    try {
      const conn = await hello(home.paths)
      await conn.next()
      conn.send({ id: 1, method: 'events.emit', params: { kind: 'status.changed' } })
      const error = (await conn.next())['error'] as Record<string, unknown>
      assert.equal(error['code'], 'not_found')
      conn.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('обрыв клиента посреди потока не роняет демона', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const conn = await hello(home.paths)
      await conn.next()
      conn.send({ id: 1, method: 'events.subscribe', params: { since: 0 } })
      await conn.next()
      // Рвём соединение грубо, как это делает убитый терминал.
      conn.socket.destroy()
      await waitFor(() => daemon.status().clients === 0)

      for (let i = 0; i < 50; i++) {
        daemon.emit({ sessionId: 'после-обрыва', provider: 'pult', kind: 'status.changed', data: { i } })
      }
      assert.equal(daemon.status().clients, 0)
      assert.equal(daemon.status().subscriptions, 0)

      // Демон продолжает обслуживать новых клиентов.
      const again = await hello(home.paths)
      assert.equal((await again.next())['type'], 'hello_ok')
      again.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('ответы клиенту, который не читает, не копятся без предела', async () => {
    // Лимит знали только подписки, а ответы на обычные запросы шли в socket.write напрямую:
    // клиент мог слать events.tail и не читать ничего, а память демона росла без границы.
    const home = tempHome()
    const daemon = await startTestDaemon(home, { writeBacklogLimit: 1024 })
    try {
      for (let i = 0; i < 300; i++) {
        daemon.emit({ sessionId: 's', provider: 'pult', kind: 'status.changed', data: { pad: 'x'.repeat(2048) } })
      }
      const conn = await hello(home.paths)
      await conn.next() // hello_ok
      conn.socket.pause() // клиент перестал читать — ровно как зависший терминал
      for (let i = 0; i < 20; i++) conn.send({ id: i + 1, method: 'events.tail', params: { since: 0 } })

      // Правда на стороне демона: соединение снято со счёта. Сам сокет клиента, пока он
      // в паузе, про закрытие ещё не знает — поэтому сначала спрашиваем демона.
      assert.ok(await waitFor(() => daemon.status().clients === 0), 'нечитающего клиента не отцепили')
      conn.socket.resume()
      await Promise.race([conn.closed, sleep(3000)])
      assert.equal(conn.socket.destroyed, true)

      // Демон жив и обслуживает нормальных.
      const again = await hello(home.paths)
      assert.equal((await again.next())['type'], 'hello_ok')
      again.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('медленный подписчик узнаёт, почему поток оборвался', async () => {
    // Кадр slow_consumer уходил в тот же переполненный буфер, из-за которого подписку и
    // сняли, — то есть выбрасывался. Сокет оставался открытым, и клиент ждал событий вечно.
    const home = tempHome()
    const daemon = await startTestDaemon(home, { writeBacklogLimit: 1024 })
    try {
      const conn = await hello(home.paths)
      await conn.next()
      conn.send({ id: 1, method: 'events.subscribe', params: { since: 0 } })
      await conn.next() // ответ с номером подписки
      conn.socket.pause()
      for (let i = 0; i < 300; i++) {
        daemon.emit({ sessionId: 's', provider: 'pult', kind: 'status.changed', data: { pad: 'x'.repeat(2048) } })
      }
      assert.ok(await waitFor(() => daemon.status().subscriptions === 0), 'подписку не сняли')

      conn.socket.resume()
      let end: Record<string, unknown> | null = null
      for (let i = 0; i < 2000 && end === null; i++) {
        let frame: Record<string, unknown>
        try { frame = await conn.next(3000) } catch { break }
        if (frame['end']) end = frame['end'] as Record<string, unknown>
      }
      assert.equal(end?.['code'], 'slow_consumer', 'клиент не узнал, почему поток затих')
      await conn.closed
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('прошлое больше лимита буфера доигрывается целиком, ответы посреди доигрывания доходят', async () => {
    // 08.10.2026: журнал перерос 8 МБ, окно подписывалось с нуля, и прошлое одним махом
    // переполняло буфер — демон отцеплял окно, окно переподключалось, и так по кругу.
    const home = tempHome()
    const daemon = await startTestDaemon(home, { writeBacklogLimit: 64 * 1024 })
    try {
      for (let i = 0; i < 300; i++) {
        daemon.emit({ sessionId: 's', provider: 'pult', kind: 'status.changed', data: { i, pad: 'x'.repeat(2048) } })
      }
      const conn = await hello(home.paths)
      await conn.next()
      conn.send({ id: 1, method: 'events.subscribe', params: { since: 0 } })
      conn.send({ id: 2, method: 'daemon.status', params: {} })
      const seen: number[] = []
      let status = false
      let end: unknown = null
      while (seen.length < 300 || !status) {
        const frame = await conn.next(5000)
        const ev = frame['event'] as PultEvent | undefined
        // В журнале есть и события самого демона (daemon.started) — считаем только свои.
        if (ev?.kind === 'status.changed') seen.push((ev.data as { i: number }).i)
        if (frame['id'] === 2) status = true
        if (frame['end']) { end = frame['end']; break }
      }
      assert.equal(end, null, 'клиента, который читает, отцепили посреди доигрывания')
      assert.deepEqual(seen, Array.from({ length: 300 }, (_, i) => i))
      assert.equal(daemon.status().subscriptions, 1)
      conn.end()
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })

  it('сокет недоступен другим пользователям: режим 0600 запрещает даже чтение группе', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      const mode = statSync(home.paths.sock).mode & 0o777
      assert.equal(mode & 0o077, 0)
      // И он действительно работает для владельца.
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(home.paths.sock)
        s.once('connect', () => { s.destroy(); resolve() })
        s.once('error', reject)
      })
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })
})

describe('daemon.status для окна (Ф2)', () => {
  it('providers: остановлен ли провайдер — ответ «сейчас», а не догадка по журналу', async () => {
    const home = tempHome()
    const daemon = await startTestDaemon(home)
    try {
      assert.deepEqual(daemon.status().providers, { claude: { blocked: false }, codex: { blocked: false }, zcode: { blocked: false } })
    } finally {
      await daemon.stop('тест')
      home.remove()
    }
  })
})
