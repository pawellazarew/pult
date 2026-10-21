// Канал обновлений (M8c), чистые части: подписанный latest.json и сеть с правилами https и потолков.
// Ключи — свои тестовые пары; ключа релизов в сборке пока нет, и это тоже проверяется.

import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { RELEASE_KEYS } from '../dist/update/keys.js'
import type { TrustedKey } from '../dist/update/keys.js'
import {
  keyIdOf, MANIFEST_MAX_BYTES, PACKAGE_MAX_BYTES, parseManifest, publicOf, rawPublicKey, signEnvelope, verifyEnvelope,
} from '../dist/update/manifest.js'
import { downloadTo, fetchBytes, writeAll } from '../dist/update/fetch.js'
import type { HttpGet, HttpResponse } from '../dist/update/fetch.js'
import { compareVersions, isStableVersion } from '../dist/core/semver.js'
import { fetchManifest, updateUrl } from '../dist/update/channel.js'
import { defaultConfig, DEFAULT_UPDATE_URL, validateConfig } from '../dist/core/config.js'

function keypair(): { priv: KeyObject; pub: string; id: string; trusted: TrustedKey } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const { raw, keyId } = publicOf(privateKey)
  return { priv: privateKey, pub: raw.toString('base64'), id: keyId, trusted: { id: keyId, publicKey: raw.toString('base64') } }
}

const SHA = 'a'.repeat(64)
const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  version: '1.0.1',
  released: '2026-10-19T10:00:00.000Z',
  notes: 'https://github.com/pawellazarew/pult/releases/tag/v1.0.1',
  package: { url: 'https://github.com/pawellazarew/pult/releases/download/v1.0.1/pult-1.0.1.tgz', sha256: SHA, size: 1234 },
  app: { version: '0.2.0', minVersion: '0.1.13', 'darwin-arm64': { url: 'https://github.com/pawellazarew/pult/releases/download/v1.0.1/Pult-0.2.0-arm64.zip', sha256: SHA, size: 99 } },
  ...over,
})
const bytes = (m: unknown): Buffer => Buffer.from(JSON.stringify(m), 'utf8')
/** Конверт руками — чтобы подписывать и то, что signEnvelope подписать откажется. */
function envelope(payload: Buffer, priv: KeyObject, over: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 1, keyId: publicOf(priv).keyId, payload: payload.toString('base64'), signature: sign(null, payload, priv).toString('base64'), ...over })
}

describe('latest.json: подпись и манифест', () => {
  const A = keypair()
  const B = keypair()

  it('подпись сходится — манифест разобран', () => {
    const text = signEnvelope(bytes(manifest()), A.priv)
    const m = verifyEnvelope(text, [A.trusted])
    assert.equal(m.version, '1.0.1')
    assert.equal(m.package.size, 1234)
    assert.equal(m.app?.minVersion, '0.1.13')
    assert.equal(m.app?.['darwin-arm64']?.size, 99)
  })

  it('подменённый payload — отказ с одной строкой причины', () => {
    const env = JSON.parse(signEnvelope(bytes(manifest()), A.priv)) as Record<string, string>
    env['payload'] = bytes(manifest({ version: '9.9.9' })).toString('base64')
    assert.throws(() => verifyEnvelope(JSON.stringify(env), [A.trusted]), (e: Error) => /подпись latest\.json не сходится/.test(e.message) && !e.message.includes('\n'))
  })

  it('подпись ЧУЖИМ ключом под keyId доверенного — отказ', () => {
    const text = envelope(bytes(manifest()), B.priv, { keyId: A.id })
    assert.throws(() => verifyEnvelope(text, [A.trusted]), /не сходится с ключом/)
  })

  it('незнакомый keyId — отказ с перечнем доверенных', () => {
    const text = signEnvelope(bytes(manifest()), B.priv)
    assert.throws(() => verifyEnvelope(text, [A.trusted]), new RegExp(`ключом ${B.id}, которому эта сборка не доверяет \\(знаю: ${A.id}\\)`))
  })

  it('ключа релизов в сборке нет — внятный отказ; список ключей сборки согласован', () => {
    const text = signEnvelope(bytes(manifest()), A.priv)
    assert.throws(() => verifyEnvelope(text, []), /в этой сборке нет ключа релизов/)
    // Что бы ни лежало в keys.ts — id каждого ключа обязан быть от него самого.
    for (const k of RELEASE_KEYS) assert.equal(keyIdOf(rawPublicKey(k.publicKey)), k.id, k.id)
  })

  it('строка keys.ts с чужим id — «ключ испорчен», а не доверие', () => {
    const text = signEnvelope(bytes(manifest()), A.priv)
    assert.throws(() => verifyEnvelope(text, [{ id: A.id, publicKey: B.pub }]), /испорчен/)
  })

  it('незнакомая схема конверта и манифеста — отказ', () => {
    const env = JSON.parse(signEnvelope(bytes(manifest()), A.priv)) as Record<string, unknown>
    assert.throws(() => verifyEnvelope(JSON.stringify({ ...env, schema: 2 }), [A.trusted]), /схема конверта 2 незнакома/)
    const text = envelope(bytes(manifest({ schema: 2 })), A.priv)
    assert.throws(() => verifyEnvelope(text, [A.trusted]), /манифест: схема 2 незнакома/)
  })

  it('подпись проверяется ДО разбора: мусор с плохой подписью — про подпись, а не про JSON', () => {
    const junk = Buffer.from('{not json', 'utf8')
    const text = JSON.stringify({ schema: 1, keyId: A.id, payload: junk.toString('base64'), signature: Buffer.alloc(64, 1).toString('base64') })
    assert.throws(() => verifyEnvelope(text, [A.trusted]), /подпись latest\.json не сходится/)
    // А подписанный мусор доходит до разбора — и честно отвергается им.
    assert.throws(() => verifyEnvelope(envelope(junk, A.priv), [A.trusted]), /манифест не JSON/)
  })

  it('пререлиз, http, логин в адресе, размер больше потолка — подписанный, но отвергнутый манифест', () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ version: '1.0.1-rc.1' }, /пререлизы каналом не ходят/],
      [{ package: { url: 'http://example.com/pult-1.0.1.tgz', sha256: SHA, size: 1 } }, /package\.url: только https/],
      [{ package: { url: 'https://u:p@example.com/x.tgz', sha256: SHA, size: 1 } }, /логин в адресе/],
      [{ package: { url: 'https://example.com/x.tgz', sha256: SHA, size: PACKAGE_MAX_BYTES + 1 } }, /больше потолка/],
      [{ package: { url: 'https://example.com/x.tgz', sha256: 'ABC', size: 1 } }, /sha256: не 64 hex/],
      [{ notes: 'javascript:alert(1)' }, /notes: только https/],
    ]
    for (const [over, re] of bad) {
      assert.throws(() => verifyEnvelope(envelope(bytes(manifest(over)), A.priv), [A.trusted]), re, JSON.stringify(over))
      // signEnvelope такой манифест и не подпишет: релиз, который отвергнет каждый Пульт, не выходит.
      assert.throws(() => signEnvelope(bytes(manifest(over)), A.priv), re)
    }
  })

  it('latest.json больше 64 КБ — отказ до разбора', () => {
    const big = signEnvelope(bytes(manifest({ pad: 'x'.repeat(MANIFEST_MAX_BYTES) })), A.priv)
    assert.throws(() => verifyEnvelope(big, [A.trusted]), /больше потолка 65536/)
  })

  it('ключ в любом из трёх видов даёт тот же keyId, что печатает keygen', () => {
    const raw = Buffer.from(A.pub, 'base64')
    const pem = createPublicKey(A.priv).export({ type: 'spki', format: 'pem' }).toString()
    const der = createPublicKey(A.priv).export({ type: 'spki', format: 'der' }).toString('base64')
    for (const spec of [A.pub, pem, der]) assert.deepEqual(rawPublicKey(spec), raw)
    assert.equal(keyIdOf(raw), createHash('sha256').update(raw).digest('hex').slice(0, 8))
    assert.throws(() => rawPublicKey('не-ключ!'), /не base64/)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    assert.throws(() => rawPublicKey(rsa), /не Ed25519/)
  })

  it('незнакомые поля манифеста пропускаются (расширение той же схемы)', () => {
    const m = parseManifest(bytes(manifest({ future: { x: 1 } })))
    assert.equal(m.version, '1.0.1')
  })
})

describe('версии канала', () => {
  it('только вперёд: строгое «новее», пререлиз младше релиза той же тройки', () => {
    assert.ok(compareVersions('1.0.1', '1.0.0') > 0)
    assert.equal(compareVersions('1.0.1', '1.0.1'), 0)
    assert.ok(compareVersions('1.0.0', '1.0.1') < 0)
    assert.ok(compareVersions('1.0.1', '1.0.1-dev') > 0)
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
    assert.ok(isStableVersion('1.0.1'))
    for (const v of ['1.0.1-rc.1', '1.0', '01.0.0', '1.0.1+b', 'v1.0.1']) assert.equal(isStableVersion(v), false, v)
  })
})

describe('адрес latest.json', () => {
  it('PULT_UPDATE_URL → config → GitHub; только https', () => {
    const cfg = defaultConfig()
    assert.equal(updateUrl(cfg, {}), DEFAULT_UPDATE_URL)
    assert.equal(updateUrl({ ...cfg, updates: { check: true, url: 'https://mirror.example/latest.json' } }, {}), 'https://mirror.example/latest.json')
    assert.equal(updateUrl(cfg, { PULT_UPDATE_URL: 'https://x.example/l.json' }), 'https://x.example/l.json')
    assert.throws(() => updateUrl(cfg, { PULT_UPDATE_URL: 'http://x.example/l.json' }), /только https/)
    const v = validateConfig({ updates: { check: false, url: 'http://x.example/l.json' } })
    assert.equal(v.config.updates.check, false)
    assert.equal(v.config.updates.url, DEFAULT_UPDATE_URL)
    assert.match(v.warnings.join('\n'), /updates\.url не https-адрес/)
  })
})

// --- сеть ---------------------------------------------------------------------------------

const ok = (body: Buffer | Buffer[], headers: Record<string, string> = {}): HttpResponse => ({
  status: 200,
  header: (n) => headers[n.toLowerCase()] ?? null,
  body: (async function* () { for (const b of Array.isArray(body) ? body : [body]) yield b })(),
})
const redirect = (to: string, status = 302): HttpResponse => ({ status, header: (n) => (n === 'location' ? to : null), body: null })

/** Подставной сервер: адрес → ответ; записывает, куда ходили. */
function server(routes: Record<string, () => HttpResponse>): { http: HttpGet; seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    http: async (url) => {
      seen.push(url)
      const r = routes[url]
      return r ? r() : { status: 404, header: () => null, body: null }
    },
  }
}

describe('сеть канала: https, редиректы, потолки', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pu-net-'))
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('http-адрес — отказ, ни одного запроса', async () => {
    const s = server({})
    await assert.rejects(fetchBytes('http://example.com/latest.json', { http: s.http, maxBytes: 100, what: 'latest.json' }), /только https/)
    assert.deepEqual(s.seen, [])
  })

  it('редирект GitHub → objects.githubusercontent.com (https) проходит', async () => {
    const s = server({
      'https://github.com/o/r/releases/latest/download/latest.json': () => redirect('https://objects.githubusercontent.com/x/latest.json?sig=1'),
      'https://objects.githubusercontent.com/x/latest.json?sig=1': () => ok(Buffer.from('{"a":1}')),
    })
    const b = await fetchBytes('https://github.com/o/r/releases/latest/download/latest.json', { http: s.http, maxBytes: 100, what: 'latest.json' })
    assert.equal(b.toString(), '{"a":1}')
    assert.equal(s.seen.length, 2)
  })

  it('редирект на http — отказ, по http не ходили', async () => {
    const s = server({ 'https://a.example/l.json': () => redirect('http://evil.example/l.json', 301) })
    await assert.rejects(fetchBytes('https://a.example/l.json', { http: s.http, maxBytes: 100, what: 'latest.json' }), /редирект: только https, а здесь http/)
    assert.deepEqual(s.seen, ['https://a.example/l.json'])
  })

  it('петля редиректов — отказ после пятого', async () => {
    const s = server({ 'https://a.example/l': () => redirect('/l') })
    await assert.rejects(fetchBytes('https://a.example/l', { http: s.http, maxBytes: 100, what: 'latest.json' }), /больше 5 редиректов/)
    assert.equal(s.seen.length, 6)
  })

  it('потолок размера — по прочитанным байтам, даже когда Content-Length врёт или его нет', async () => {
    const big = Buffer.alloc(80, 0x61)
    const lie = server({ 'https://a.example/l': () => ok([big.subarray(0, 40), big.subarray(40)], { 'content-length': '10' }) })
    await assert.rejects(fetchBytes('https://a.example/l', { http: lie.http, maxBytes: 50, what: 'latest.json' }), /больше потолка 50/)
    const honest = server({ 'https://a.example/l': () => ok(big, { 'content-length': '80' }) })
    await assert.rejects(fetchBytes('https://a.example/l', { http: honest.http, maxBytes: 50, what: 'latest.json' }), /80 байт — больше потолка 50/)
  })

  it('HTTP 404 — причина с адресом', async () => {
    const s = server({})
    await assert.rejects(fetchBytes('https://a.example/l', { http: s.http, maxBytes: 50, what: 'latest.json' }), /ответил HTTP 404/)
  })

  it('загрузка: размер и sha256 сошлись — файл на месте', async () => {
    const data = Buffer.from('тарбол'.repeat(100))
    const sha = createHash('sha256').update(data).digest('hex')
    const file = join(dir, 'ok.tgz')
    await downloadTo('https://a.example/p.tgz', file, { http: server({ 'https://a.example/p.tgz': () => ok(data) }).http, size: data.length, sha256: sha, what: 'p.tgz' })
    assert.deepEqual(readFileSync(file), data)
  })

  it('загрузка: sha256 не тот, байтов больше или меньше заявленного — файла нет', async () => {
    const data = Buffer.from('x'.repeat(100))
    const sha = createHash('sha256').update(data).digest('hex')
    const cases: Array<[Buffer, number, string, RegExp]> = [
      [data, data.length, 'b'.repeat(64), /sha256 .* не совпадает с манифестом/],
      [Buffer.concat([data, data]), data.length, sha, /больше 100 байт из манифеста/],
      [data.subarray(0, 50), data.length, sha, /пришло 50 байт, манифест обещал 100/],
    ]
    for (const [body, size, want, re] of cases) {
      const file = join(dir, `bad-${Math.random().toString(36).slice(2)}.tgz`)
      await assert.rejects(downloadTo('https://a.example/p.tgz', file, { http: server({ 'https://a.example/p.tgz': () => ok(body) }).http, size, sha256: want, what: 'p.tgz' }), re)
      assert.equal(existsSync(file), false, String(re))
    }
  })

  it('загрузка: тишина дольше idle — обрыв, файла нет', async () => {
    const file = join(dir, 'slow.tgz')
    const http: HttpGet = async (_url, signal) => ({
      status: 200,
      header: () => null,
      body: (async function* () {
        yield Buffer.from('a')
        // Настоящий сокет держит цикл событий, пока ждёт байты; таймеры потолка и тишины в fetch.ts — unref.
        // Без этой замены сокета node 22 видит пустой цикл раньше, чем сработает тишина, и снимает тест
        // («Promise resolution is still pending but the event loop has already resolved»).
        const socket = setInterval(() => {}, 1000)
        try {
          await new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))
        } finally { clearInterval(socket) }
      })(),
    })
    await assert.rejects(downloadTo('https://a.example/p.tgz', file, { http, size: 10, sha256: SHA, idleMs: 80, what: 'p.tgz' }), /ни байта за 1 с/)
    assert.equal(existsSync(file), false)
  })
})

describe('ревью M8c: 404 канала, запись на диск', () => {
  it('404 — нейтральная подсказка на любом адресе: проверь updates.url, поставь вручную --from', async () => {
    const http: HttpGet = async () => ({ status: 404, header: () => null, body: null })
    const hint = /HTTP 404 — релизов в канале нет или адрес недоступен — проверь updates\.url; поставить вручную: pult update --from <тарбол>/
    await assert.rejects(fetchManifest({ url: DEFAULT_UPDATE_URL, http, keys: [] }), (e: Error) => hint.test(e.message) && !/M9|публичн|приватн/.test(e.message))
    await assert.rejects(fetchManifest({ url: 'https://mirror.example/latest.json', http, keys: [] }), (e: Error) => hint.test(e.message))
  })

  it('writeSync записал не всё — дописываем остаток; 0 байт — отказ, а не вечный цикл', () => {
    const got: number[] = []
    writeAll(7, Buffer.from('abcdefghij'), (_fd, b) => { const n = Math.min(3, b.length); got.push(n); return n })
    assert.deepEqual(got, [3, 3, 3, 1])
    assert.throws(() => writeAll(7, Buffer.from('ab'), () => 0), /запись на диск вернула 0 байт/)
  })
})
