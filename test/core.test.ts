// Ядро: кадрирование NDJSON, lock, токен, журнал событий, фильтр журнала, конфиг.

import assert from 'node:assert/strict'
import {
  appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { defaultConfig, loadConfig, validateConfig, writeConfig } from '../dist/core/config.js'
import { createLogger, redact, redactString } from '../dist/core/log.js'
import { acquireLock, confirmedLockHolder, isAlive, liveLockHolder, parseLockRecord } from '../dist/core/lock.js'
import { createLineSplitter, encodeLine, NdjsonError } from '../dist/core/ndjson.js'
import { checkSockPath, layout } from '../dist/core/paths.js'
import { createStore } from '../dist/core/store.js'
import { readToken, rotateToken, tokenEquals } from '../dist/core/token.js'
import { tempHome } from './helpers.js'

describe('ndjson', () => {
  it('склеенные записи разбираются все', () => {
    const s = createLineSplitter()
    const lines = s.push('{"a":1}\n{"a":2}\n{"a":3}\n')
    assert.deepEqual(lines.map((l) => JSON.parse(l).a), [1, 2, 3])
  })

  it('разорванная запись собирается из кусков', () => {
    const s = createLineSplitter()
    assert.deepEqual(s.push('{"a":'), [])
    assert.deepEqual(s.push('1}'), [])
    assert.deepEqual(s.push('\n'), ['{"a":1}'])
  })

  it('многобайтовый символ, разорванный между chunk, не портится', () => {
    const s = createLineSplitter()
    const buf = Buffer.from('{"t":"привет"}\n', 'utf8')
    const cut = 8
    assert.deepEqual(s.push(buf.subarray(0, cut)), [])
    const lines = s.push(buf.subarray(cut))
    assert.equal(JSON.parse(lines[0] as string).t, 'привет')
  })

  it('пустые строки и \\r\\n отбрасываются', () => {
    const s = createLineSplitter()
    assert.deepEqual(s.push('\n\r\n{"a":1}\r\n'), ['{"a":1}'])
  })

  it('слишком длинная строка — ошибка line_too_long', () => {
    const s = createLineSplitter(64)
    assert.throws(() => s.push('x'.repeat(200)), (e: unknown) => {
      assert.ok(e instanceof NdjsonError)
      assert.equal((e as NdjsonError).code, 'line_too_long')
      return true
    })
    // Буфер сброшен: хвост выброшенной строки не выдаёт себя за новую запись.
    assert.equal(s.pending(), 0)
  })

  it('длинная строка, пришедшая вместе со своим \\n, тоже отвергается', () => {
    // Проверка только недобитого остатка пропускала сколь угодно длинную ГОТОВУЮ строку:
    // предел на память демона обходился одним лишним символом `\n` в конце.
    const s = createLineSplitter(64)
    assert.throws(() => s.push('x'.repeat(200) + '\n'), (e: unknown) => {
      assert.equal((e as NdjsonError).code, 'line_too_long')
      return true
    })
    assert.equal(s.pending(), 0)
  })

  it('строка ровно по пределу проходит', () => {
    const s = createLineSplitter(64)
    assert.deepEqual(s.push('x'.repeat(64) + '\n'), ['x'.repeat(64)])
  })

  it('encodeLine всегда заканчивается переводом строки', () => {
    assert.equal(encodeLine({ a: 1 }), '{"a":1}\n')
  })
})

describe('lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-lock-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('первый берёт, второй видит живого держателя', () => {
    const path = join(dir, 'a.lock')
    const first = acquireLock(path)
    assert.equal(first.ok, true)
    const second = acquireLock(path)
    assert.equal(second.ok, false)
    assert.equal(second.ok === false && second.holderPid, process.pid)
    if (first.ok) first.lock.release()
  })

  it('confirmedLockHolder: только доказанный pultd — ему `pult daemon stop` шлёт SIGTERM', () => {
    const path = join(dir, 'h.lock')
    const rec = { pid: 4242, startedAt: '', started: 'Mon Sep 21 10:00:00 2026', cmd: '/usr/bin/node /x/pult/dist/daemon/main.js' }
    writeFileSync(path, JSON.stringify(rec), { mode: 0o600 })
    const same = { alive: () => true, processStart: () => rec.started, processCommand: () => rec.cmd }
    assert.equal(confirmedLockHolder(path, same)?.pid, 4242)
    assert.equal(confirmedLockHolder(path, { ...same, alive: () => false }), null, 'мёртвый')
    assert.equal(confirmedLockHolder(path, { ...same, processStart: () => 'Tue Sep 22 10:00:00 2026' }), null, 'переиспользованный pid')
    assert.equal(confirmedLockHolder(path, { ...same, processStart: () => null }), null, 'время старта не узнать — сигнал не шлём')
    writeFileSync(path, JSON.stringify({ ...rec, cmd: '/usr/bin/vim notes.txt' }), { mode: 0o600 })
    assert.equal(confirmedLockHolder(path, same), null, 'не pultd')
    assert.equal(confirmedLockHolder(join(dir, 'нет.lock'), same), null)

    // Без времени старта: доказательство — только живой ответ `ps` с командой pultd. Команде из
    // самого lock не верим (pid мог смениться хозяином), молчание `ps` — не доказательство.
    writeFileSync(path, JSON.stringify({ ...rec, started: '' }), { mode: 0o600 })
    assert.equal(confirmedLockHolder(path, same)?.pid, 4242, '`ps` видит pultd')
    assert.equal(confirmedLockHolder(path, { ...same, processCommand: () => null }), null, '`ps` не ответил — сигнал не шлём')
    assert.equal(confirmedLockHolder(path, { ...same, processCommand: () => '/usr/bin/vim notes.txt' }), null, 'чужой процесс')
    writeFileSync(path, '4242', { mode: 0o600 })
    assert.equal(confirmedLockHolder(path, { ...same, processCommand: () => null }), null, 'старый формат, `ps` не ответил')
  })

  it('liveLockHolder: осторожный вердикт «возможно, держит» — тот же, что у acquireLock', () => {
    // По нему stop ждёт демона и решает, свободен ли lock; сигнала по нему не шлют.
    const path = join(dir, 'maybe.lock')
    const rec = { pid: 4242, startedAt: '', started: 'Mon Sep 21 10:00:00 2026', cmd: '/usr/bin/node /x/pult/dist/daemon/main.js' }
    writeFileSync(path, JSON.stringify(rec), { mode: 0o600 })
    const same = { alive: () => true, processStart: () => rec.started, processCommand: () => rec.cmd }
    assert.equal(liveLockHolder(path, same)?.pid, 4242)
    assert.equal(liveLockHolder(path, { ...same, processStart: () => null })?.pid, 4242, 'время старта не узнать — считаем, что держит')
    assert.equal(liveLockHolder(path, { ...same, processStart: () => 'Tue Sep 22 10:00:00 2026' }), null, 'переиспользованный pid')
    assert.equal(liveLockHolder(path, { ...same, alive: () => false }), null, 'мёртвый')
    writeFileSync(path, JSON.stringify({ ...rec, started: '' }), { mode: 0o600 })
    assert.equal(liveLockHolder(path, { ...same, processCommand: () => null })?.pid, 4242, '`ps` не ответил — считаем, что держит')
    assert.equal(liveLockHolder(path, { ...same, processCommand: () => '/sbin/launchd' }), null, 'не pultd')
  })

  it('lock без времени старта, держатель жив, `ps` не ответил — acquireLock НЕ берёт (осторожная сторона)', () => {
    // Сигнал такому держателю stop не шлёт (его не опознать), но и отобрать lock нельзя: вдруг это
    // живой pultd, а `ps` просто не ответил. Два демона на одном доме хуже, чем честный отказ.
    const path = join(dir, 'unknown.lock')
    writeFileSync(path, JSON.stringify({ pid: 4242, startedAt: '', started: '', cmd: '' }), { mode: 0o600 })
    const r = acquireLock(path, { alive: () => true, processCommand: () => null })
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.holderPid, 4242)
    assert.equal(parseLockRecord(readFileSync(path, 'utf8'))?.pid, 4242, 'чужой lock переписан')
  })

  it('протухший lock мёртвого процесса снимается и берётся заново', () => {
    const path = join(dir, 'b.lock')
    // pid 2^22 заведомо свободен на macOS и Linux (предел pid_max меньше).
    writeFileSync(path, '4194303', { mode: 0o600 })
    const r = acquireLock(path)
    assert.equal(r.ok, true)
    assert.equal(parseLockRecord(readFileSync(path, 'utf8'))?.pid, process.pid)
    if (r.ok) r.lock.release()
  })

  it('переиспользованный pid не держит lock вечно', () => {
    // Держатель «жив», но это УЖЕ ДРУГОЙ процесс: после жёсткого падения номер достался
    // кому-то ещё. Раньше pultd отказывался стартовать навсегда, пока человек не сотрёт файл.
    const path = join(dir, 'reuse.lock')
    const first = acquireLock(path, { processStart: () => 'Mon Sep 21 10:00:00 2026' })
    assert.equal(first.ok, true)
    const second = acquireLock(path, {
      alive: () => true,
      processStart: () => 'Tue Sep 22 11:11:11 2026', // тот же pid, другое время старта
    })
    assert.equal(second.ok, true, 'lock переиспользованного pid обязан сниматься')
    if (second.ok) second.lock.release()
  })

  it('живой держатель с тем же временем старта не отбирается', () => {
    const path = join(dir, 'live.lock')
    const first = acquireLock(path, { processStart: () => 'Mon Sep 21 10:00:00 2026' })
    assert.equal(first.ok, true)
    const second = acquireLock(path, { alive: () => true, processStart: () => 'Mon Sep 21 10:00:00 2026' })
    assert.equal(second.ok, false)
    assert.equal(second.ok === false && second.holderPid, process.pid)
    if (first.ok) first.lock.release()
  })

  it('lock старого формата, который держит НЕ pultd, снимается', () => {
    // Ровно случай «pid 1 = launchd»: он жив всегда, и голый pid в файле блокировал старт.
    const path = join(dir, 'legacy.lock')
    writeFileSync(path, '1', { mode: 0o600 })
    const r = acquireLock(path, { alive: () => true, processCommand: () => '/sbin/launchd' })
    assert.equal(r.ok, true)
    if (r.ok) r.lock.release()

    writeFileSync(path, '1', { mode: 0o600 })
    const held = acquireLock(path, {
      alive: () => true,
      processCommand: () => '/usr/bin/node /opt/pult/dist/daemon/main.js',
    })
    assert.equal(held.ok, false, 'похожий на pultd держатель старого формата — живой')
  })

  it('lock публикуется целиком и снимается только своим владельцем', () => {
    const path = join(dir, 'atomic.lock')
    const r = acquireLock(path)
    assert.equal(r.ok, true)
    // Публикация одним link(): пустого или недописанного файла не бывает даже на миг,
    // а временный файл после себя не остаётся.
    const rec = parseLockRecord(readFileSync(path, 'utf8'))
    assert.equal(rec?.pid, process.pid)
    assert.ok(rec && rec.startedAt.length > 0)
    assert.equal(existsSync(`${path}.${process.pid}.tmp`), false)

    // Файл перехватил кто-то другой — наш release не имеет права его сносить.
    writeFileSync(path, JSON.stringify({ pid: 4194303, startedAt: 'x', started: '', cmd: '' }))
    if (r.ok) r.lock.release()
    assert.equal(existsSync(path), true, 'release снял чужой lock')
  })

  it('битый lock считается мёртвым', () => {
    const path = join(dir, 'c.lock')
    writeFileSync(path, 'не число', { mode: 0o600 })
    const r = acquireLock(path)
    assert.equal(r.ok, true)
    if (r.ok) r.lock.release()
  })

  it('EPERM означает «жив»: pid 1 нам не принадлежит', () => {
    // launchd (macOS) и init (Linux) всегда есть и всегда чужие: kill(1,0) даёт EPERM.
    assert.equal(isAlive(1), true)
    assert.equal(isAlive(4194303), false)
    assert.equal(isAlive(-1), false)
  })

  it('файл lock создаётся с правами 0600', () => {
    const path = join(dir, 'd.lock')
    const r = acquireLock(path)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    if (r.ok) r.lock.release()
  })
})

describe('token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-tok-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('меняется на каждом вызове и лежит с правами 0600', () => {
    const path = join(dir, 'token')
    const a = rotateToken(path)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const b = rotateToken(path)
    assert.notEqual(a, b)
    assert.equal(readToken(path), b)
    assert.equal(a.length, 64)
  })

  it('сравнение не принимает ни чужой токен, ни пустую строку', () => {
    const t = rotateToken(join(dir, 'token2'))
    assert.equal(tokenEquals(t, t), true)
    assert.equal(tokenEquals('', t), false)
    // Подменяем последний символ на ГАРАНТИРОВАННО другой: «всегда 0» давал ложный провал
    // раз в шестнадцать прогонов — ровно когда токен и сам заканчивался нулём.
    assert.equal(tokenEquals(t.slice(0, -1) + (t.endsWith('0') ? '1' : '0'), t), false)
    assert.equal(tokenEquals(t + 'x', t), false)
  })

  it('readToken на пустом месте даёт null', () => {
    assert.equal(readToken(join(dir, 'нет-такого')), null)
  })
})

describe('store', () => {
  it('номер события монотонный и переживает рестарт', () => {
    const home = tempHome()
    try {
      const first = createStore(home.paths)
      first.append({ sessionId: 's1', provider: 'pult', kind: 'session.started' })
      first.append({ sessionId: 's1', provider: 'pult', kind: 'message.done' })
      assert.equal(first.lastId, 2)
      first.close()

      // Рестарт демона: новый store обязан продолжить нумерацию, а не начать с единицы.
      const second = createStore(home.paths)
      assert.equal(second.lastId, 2)
      const ev = second.append({ sessionId: 's1', provider: 'pult', kind: 'session.ended' })
      assert.equal(ev.id, 3)
      second.close()
    } finally {
      home.remove()
    }
  })

  it('оборванная последняя строка журнала не сбивает нумерацию', () => {
    const home = tempHome()
    try {
      const s = createStore(home.paths)
      s.append({ sessionId: 's1', provider: 'pult', kind: 'session.started' })
      s.close()
      writeFileSync(home.paths.journal, readFileSync(home.paths.journal, 'utf8') + '{"id":2,"обор', { flag: 'w' })
      const again = createStore(home.paths)
      assert.equal(again.lastId, 1)
      again.close()
    } finally {
      home.remove()
    }
  })

  it('readFrom отдаёт строго после курсора и фильтрует по сессии', () => {
    const home = tempHome()
    try {
      const s = createStore(home.paths)
      s.append({ sessionId: 'a', provider: 'pult', kind: 'session.started' })
      s.append({ sessionId: 'b', provider: 'claude', kind: 'session.started' })
      s.append({ sessionId: 'a', provider: 'pult', kind: 'message.done' })

      assert.deepEqual(s.readFrom(0).map((e) => e.id), [1, 2, 3])
      assert.deepEqual(s.readFrom(2).map((e) => e.id), [3])
      assert.deepEqual(s.readFrom(0, { sessionId: 'a' }).map((e) => e.id), [1, 3])
      assert.deepEqual(s.readFrom(0, { limit: 2 }).map((e) => e.id), [1, 2])
      s.close()

      // Файл сессии — отдельный срез того же потока.
      const perSession = readFileSync(join(home.paths.events, 'a.jsonl'), 'utf8').trim().split('\n')
      assert.equal(perSession.length, 2)
    } finally {
      home.remove()
    }
  })

  it('оборванный хвост обрезается: следующее событие читается, а не склеивается с огрызком', () => {
    const home = tempHome()
    try {
      const first = createStore(home.paths)
      for (let i = 0; i < 3; i++) first.append({ sessionId: 's', provider: 'pult', kind: 'status.changed' })
      first.close()
      // Демона убили посреди writeSync: последняя строка без `\n`.
      appendFileSync(home.paths.journal, '{"id":4,"ts":"t","sessionId":"s","provider":"pul')

      const second = createStore(home.paths)
      const ev = second.append({ sessionId: 's', provider: 'pult', kind: 'daemon.started' })
      assert.equal(ev.id, 4)
      assert.equal(second.lastId, 4)
      // Главное: событие 4 ЧИТАЕТСЯ. До починки оно прилипало к огрызку, строка не
      // разбиралась никогда, и курсор навсегда расходился с тем, что можно прочитать.
      assert.deepEqual(second.readFrom(0).map((e) => e.id), [1, 2, 3, 4])
      second.close()
      assert.deepEqual(createStore(home.paths).readFrom(0).map((e) => e.id), [1, 2, 3, 4])
    } finally {
      home.remove()
    }
  })

  it('строка `null` в журнале не роняет чтение', () => {
    const home = tempHome()
    try {
      const s = createStore(home.paths)
      s.append({ sessionId: 's', provider: 'pult', kind: 'status.changed' })
      s.close()
      // Валидный JSON, но не событие: `ev.id` на нём падал ВНЕ try/catch и убивал
      // и events.tail, и доигрывание подписки.
      appendFileSync(home.paths.journal, 'null\n[]\n42\n{"id":"два"}\n')
      const again = createStore(home.paths)
      assert.deepEqual(again.readFrom(0).map((e) => e.id), [1])
      assert.equal(again.lastId, 1)
      again.close()
    } finally {
      home.remove()
    }
  })

  it('сессия с именем journal не пишет в общий журнал', () => {
    const home = tempHome()
    try {
      const s = createStore(home.paths)
      s.append({ sessionId: 'journal', provider: 'pult', kind: 'status.changed' })
      s.close()
      // Файл сессии назывался бы journal.jsonl — то есть общим журналом, и каждое событие
      // такой сессии попадало в курсор дважды с одним и тем же номером.
      assert.equal(readFileSync(home.paths.journal, 'utf8').trim().split('\n').length, 1)
      assert.equal(existsSync(join(home.paths.events, '_journal.jsonl')), true)
      assert.deepEqual(createStore(home.paths).readFrom(0).map((e) => e.id), [1])
    } finally {
      home.remove()
    }
  })

  it('отказ записи не расходует номер и останавливает журнал', () => {
    const home = tempHome()
    try {
      let fail = false
      const s = createStore(home.paths, {
        writeAll: (fd: number, buf: Buffer) => {
          if (fail) throw new Error('ENOSPC: no space left on device')
          let off = 0
          while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
        },
      })
      s.append({ sessionId: 's', provider: 'pult', kind: 'status.changed' })
      assert.equal(s.lastId, 1)
      fail = true
      // Событие не записалось — значит его НЕ существует: ни для подписчиков, ни для курсора.
      assert.throws(() => s.append({ sessionId: 's', provider: 'pult', kind: 'status.changed' }), /ENOSPC/)
      assert.equal(s.lastId, 1, 'номер израсходован на событие, которого нет на диске')
      fail = false
      assert.throws(() => s.append({ sessionId: 's', provider: 'pult', kind: 'status.changed' }), /журнал сломан/)
      s.close()
    } finally {
      home.remove()
    }
  })
})

describe('журнал демона', () => {
  it('почта и токены не попадают в файл', () => {
    const home = tempHome()
    try {
      const log = createLogger(home.paths.logFile)
      log.info('пользователь ivan' + '@example.org вошёл', {
        // Литералы секретов собираются из кусков, иначе на них сработает страж утечек CI
        // (scripts/ci-leakguard.mjs) — он не отличает выдуманный ключ от настоящего.
        apiKey: 'sk-' + 'ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        note: 'Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123456789',
        token: 'деталь',
        nested: { mail: 'someone@example.org', hex: 'a'.repeat(64) },
      })
      log.close()
      const text = readFileSync(home.paths.logFile, 'utf8')
      assert.ok(!text.includes('ivan' + '@example.org'), 'адрес почты утёк в журнал')
      assert.ok(!text.includes('someone@example.org'), 'адрес почты утёк в журнал')
      assert.ok(!text.includes('sk-ant-api03'), 'ключ утёк в журнал')
      assert.ok(!text.includes('abcdefghijklmnopqrstuvwxyz'), 'Bearer утёк в журнал')
      assert.ok(!text.includes('a'.repeat(64)), 'длинный hex утёк в журнал')
      assert.ok(text.includes('<email>') && text.includes('<token>') && text.includes('<redacted>'))
    } finally {
      home.remove()
    }
  })

  it('redact не ломает обычные значения', () => {
    assert.equal(redactString('всё хорошо'), 'всё хорошо')
    assert.deepEqual(redact({ n: 1, s: 'ok', arr: [1, 'two'] }), { n: 1, s: 'ok', arr: [1, 'two'] })
  })

  it('логин и пароль внутри URL вырезаются', () => {
    // Такой прокси владелец может написать в config.json, а доктор печатает его строкой.
    const line = redactString('claude: auto → прокси http://vasya:hunter2@127.0.0.1:3128, loc=XX')
    assert.ok(!line.includes('hunter2'), 'пароль из URL утёк')
    assert.ok(!line.includes('vasya'), 'логин из URL утёк')
    assert.match(line, /http:\/\/<redacted>@127\.0\.0\.1:3128/)
    // Обычный адрес без учётки не портится.
    assert.equal(redactString('http://127.0.0.1:3128'), 'http://127.0.0.1:3128')
  })
})

describe('config', () => {
  it('значения по умолчанию, когда файла нет', () => {
    const home = tempHome()
    try {
      const loaded = loadConfig(home.paths.config)
      assert.equal(loaded.fromFile, false)
      // M8b: по умолчанию — прямой путь без прокси у всех провайдеров (страж страны остаётся).
      for (const p of ['claude', 'codex', 'opencode'] as const) {
        assert.deepEqual(loaded.config.network[p], { mode: 'off', proxy: '' })
      }
      assert.equal(JSON.stringify(defaultConfig()).includes('127.0.0.1'), false)
      assert.deepEqual(loaded.config.guardCountries, ['RU', 'BY', 'CN', 'IR', 'KP', 'SY', 'CU'])
    } finally {
      home.remove()
    }
  })

  it('кривые поля заменяются умолчанием и дают предупреждение', () => {
    const { config, warnings } = validateConfig({
      network: { claude: { mode: 'турбо', proxy: 42 } },
      guardCountries: 'RU',
      warmTtlMs: -1,
    })
    assert.equal(config.network.claude.mode, 'off')
    assert.equal(config.network.claude.proxy, '')
    assert.equal(config.guardCountries.length, 7)
    assert.equal(warnings.length, 4)
  })

  it('частичный config.json с прокси владельца сливается с умолчаниями и даёт прежнее поведение (auto через локальный прокси)', () => {
    const proxy = 'http://127.0.0.1:3128'
    const partial = {
      version: 1,
      network: { claude: { mode: 'auto', proxy }, codex: { mode: 'auto', proxy }, opencode: { mode: 'auto', proxy } },
    }
    const { config, warnings } = validateConfig(partial)
    assert.deepEqual(warnings, [])
    for (const p of ['claude', 'codex', 'opencode'] as const) assert.deepEqual(config.network[p], { mode: 'auto', proxy })
    // Всё, чего в файле нет, — умолчания.
    const d = defaultConfig()
    assert.deepEqual({ ...config, network: d.network }, d)
  })

  it('прокси без режима — auto; режим без прокси — off с предупреждением', () => {
    const { config, warnings } = validateConfig({
      network: { claude: { proxy: 'http://127.0.0.1:3128' }, codex: { mode: 'required' }, opencode: { mode: 'auto', proxy: '' } },
    })
    assert.deepEqual(config.network.claude, { mode: 'auto', proxy: 'http://127.0.0.1:3128' })
    assert.deepEqual(config.network.codex, { mode: 'off', proxy: '' })
    assert.deepEqual(config.network.opencode, { mode: 'off', proxy: '' })
    assert.equal(warnings.length, 3)
  })

  it('noProxy: «*.домен» становится «.домен», повторы схлопываются, без поля профиль прежний', () => {
    const { config, warnings } = validateConfig({
      network: {
        claude: { proxy: 'http://127.0.0.1:28781', noProxy: ['*.sun-team.ru', '.global.internal', '10.0.0.0/8', '.sun-team.ru'] },
        codex: { proxy: 'socks5h://127.0.0.1:28780' },
      },
    })
    assert.deepEqual(warnings, [])
    assert.deepEqual(config.network.claude.noProxy, ['.sun-team.ru', '.global.internal', '10.0.0.0/8'])
    assert.deepEqual(config.network.codex, { mode: 'auto', proxy: 'socks5h://127.0.0.1:28780' })
  })

  it('noProxy: запятые, пробелы и не-строки отбрасываются с предупреждением — NO_PROXY не ломается целиком', () => {
    const { config, warnings } = validateConfig({
      network: {
        claude: { proxy: 'http://127.0.0.1:28781', noProxy: ['.ok.ru', 'a.ru,b.ru', 'с пробелом', 42, ''] },
        codex: { proxy: 'http://127.0.0.1:28781', noProxy: '.sun-team.ru' },
      },
    })
    assert.deepEqual(config.network.claude.noProxy, ['.ok.ru'])
    assert.equal(config.network.codex.noProxy, undefined)
    assert.equal(warnings.length, 5)
  })

  it('записанный конфиг читается обратно', () => {
    const home = tempHome()
    try {
      const cfg = defaultConfig()
      cfg.network.codex = { mode: 'required', proxy: 'http://127.0.0.1:3128' }
      cfg.guardCountries = ['ru']
      writeConfig(home.paths.config, cfg)
      const loaded = loadConfig(home.paths.config)
      assert.equal(loaded.config.network.codex.mode, 'required')
      assert.deepEqual(loaded.config.guardCountries, ['RU'])
      assert.equal(statSync(home.paths.config).mode & 0o777, 0o600)
    } finally {
      home.remove()
    }
  })

  it('нечитаемый config.json не роняет загрузку', () => {
    const home = tempHome()
    try {
      writeFileSync(home.paths.config, '{сломано')
      chmodSync(home.paths.config, 0o600)
      const loaded = loadConfig(home.paths.config)
      assert.equal(loaded.warnings.length, 1)
      assert.equal(loaded.config.version, 1)
    } finally {
      home.remove()
    }
  })
})

describe('paths', () => {
  it('слишком длинный путь сокета отвергается заранее', () => {
    const deep = layout('/tmp/' + 'x'.repeat(120))
    assert.throws(() => checkSockPath(deep.sock), /длиннее 104 байт/)
  })
})
