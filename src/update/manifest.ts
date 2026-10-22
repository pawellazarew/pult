// `latest.json` канала обновлений (M8c): подписанный конверт и манифест внутри.
//
//   конверт:  {"schema":1,"keyId":"<hex8>","payload":"<base64 байтов манифеста>","signature":"<base64 Ed25519>"}
//   манифест: {"schema":1,"version":"1.0.1","released":"<ISO>","notes":"https://…",
//              "package":{"url":"https://…/pult-1.0.1.tgz","sha256":"…","size":N},
//              "app":{"version":"0.2.0","minVersion":"0.1.13","darwin-arm64":{"url":"…zip","sha256":"…","size":N}}}
//
// ПОЧЕМУ один файл, а не latest.json + latest.json.sig: два скачивания с GitHub — две гонки (релиз
// перевыложили между ними — подпись от одного файла, манифест от другого) и два места подмены.
// ПОЧЕМУ подпись над БАЙТАМИ payload, а не над разобранным JSON: канонизации JSON нет, и «тот же»
// объект с другим порядком ключей дал бы другую подпись. Проверка идёт ДО JSON.parse манифеста —
// разборщик никогда не видит байтов, которых не подписал ключ релизов.
//
// Модуль чистый (только node:crypto): его же импортирует scripts/release.mjs из СОБРАННОГО пакета —
// релиз проверяется ровно тем кодом и теми ключами, которые получат люди.

import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { isStableVersion } from '../core/semver.js'
import type { TrustedKey } from './keys.js'

export const ENVELOPE_SCHEMA = 1
export const MANIFEST_SCHEMA = 1
/** latest.json — пара килобайт; 64 КБ — потолок, после которого это уже не манифест. */
export const MANIFEST_MAX_BYTES = 64 * 1024
/** Тарбол пакета ~1–2 МБ; потолок с запасом, чтобы чужой «манифест» не залил диск. */
export const PACKAGE_MAX_BYTES = 200 * 1024 * 1024
/** Потолок поля манифеста; сам архив окна демон качает с потолком APP_ZIP_MAX_BYTES (appUpdate.ts, 0.3.4). */
export const APP_MAX_BYTES = 1024 * 1024 * 1024

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

export interface ReleaseAsset {
  url: string
  sha256: string
  size: number
}

export interface ReleaseApp {
  version: string
  /** Окно старше этой версии работать с пакетом не может — «нужна новая версия окна». */
  minVersion: string
  'darwin-arm64'?: ReleaseAsset
}

export interface Manifest {
  schema: 1
  version: string
  released: string
  notes: string
  package: ReleaseAsset
  app?: ReleaseApp
}

export interface Envelope {
  schema: 1
  keyId: string
  payload: string
  signature: string
}

// --- ключи ----------------------------------------------------------------------------

/** DER-префикс SPKI для Ed25519: SEQUENCE { AlgorithmIdentifier 1.3.101.112, BIT STRING (32 байта) }. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** base64 без поблажек: `Buffer.from(…, 'base64')` молча глотает мусор, а здесь мусор — повод для отказа. */
export function strictBase64(s: unknown, what: string): Buffer {
  if (typeof s !== 'string' || !s || s.length % 4 !== 0 || !B64_RE.test(s)) throw new ManifestError(`${what}: не base64`)
  const b = Buffer.from(s, 'base64')
  if (b.toString('base64') !== s) throw new ManifestError(`${what}: не base64`)
  return b
}

/**
 * Сырой публичный ключ (32 байта) из строки ключа: сырой base64, SPKI в PEM или SPKI base64 DER.
 * Любой другой алгоритм, кроме Ed25519, — отказ.
 */
export function rawPublicKey(spec: string): Buffer {
  const s = spec.trim()
  let key: KeyObject
  try {
    if (s.startsWith('-----BEGIN')) key = createPublicKey(s)
    else {
      const der = strictBase64(s, 'публичный ключ')
      if (der.length === 32) return der
      key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    }
  } catch (e) {
    if (e instanceof ManifestError) throw e
    throw new ManifestError(`публичный ключ не разбирается: ${(e as Error).message}`)
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new ManifestError(`публичный ключ не Ed25519 (${key.asymmetricKeyType ?? '?'})`)
  const jwk = key.export({ format: 'jwk' }) as { x?: string }
  const raw = Buffer.from(jwk.x ?? '', 'base64url')
  if (raw.length !== 32) throw new ManifestError('публичный ключ Ed25519 не 32 байта')
  return raw
}

/** keyId — первые 8 hex sha256 сырого ключа: короткая метка «каким ключом подписано» в конверте. */
export function keyIdOf(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 8)
}

export function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

/** Сырой публичный ключ и keyId из ЗАКРЫТОГО ключа (release.mjs, keygen). */
export function publicOf(privateKey: KeyObject): { raw: Buffer; keyId: string } {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new ManifestError(`ключ подписи не Ed25519 (${privateKey.asymmetricKeyType ?? '?'})`)
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string }
  const raw = Buffer.from(jwk.x ?? '', 'base64url')
  return { raw, keyId: keyIdOf(raw) }
}

// --- проверка -------------------------------------------------------------------------

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

/**
 * Только https, без логина в адресе. Этот же адрес потом идёт в загрузку, и правило там
 * проверяется снова на каждом редиректе (fetch.ts) — здесь отсекается манифест, который просит
 * заведомо недоверенного.
 */
export function httpsUrl(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new ManifestError(`${what}: нет адреса`)
  let u: URL
  try { u = new URL(v) } catch { throw new ManifestError(`${what}: «${v.slice(0, 200)}» — не адрес`) }
  if (u.protocol !== 'https:') throw new ManifestError(`${what}: только https, а здесь ${u.protocol.replace(/:$/, '')}`)
  if (u.username || u.password) throw new ManifestError(`${what}: логин в адресе не принимается`)
  return u.href
}

function asset(v: unknown, what: string, maxBytes: number): ReleaseAsset {
  const o = obj(v)
  if (!o) throw new ManifestError(`${what}: не объект`)
  const url = httpsUrl(o['url'], `${what}.url`)
  const sha256 = o['sha256']
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new ManifestError(`${what}.sha256: не 64 hex-символа`)
  const size = o['size']
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new ManifestError(`${what}.size: не положительное целое`)
  if (size > maxBytes) throw new ManifestError(`${what}.size: ${size} байт — больше потолка ${maxBytes}`)
  return { url, sha256, size }
}

const versionField = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !isStableVersion(v)) throw new ManifestError(`${what}: «${String(v).slice(0, 40)}» — не версия x.y.z (пререлизы каналом не ходят)`)
  return v
}

/** Разбор манифеста из ПРОВЕРЕННЫХ байтов. Незнакомые поля пропускаются (схема та же — расширения совместимы). */
export function parseManifest(bytes: Buffer): Manifest {
  let raw: unknown
  try { raw = JSON.parse(bytes.toString('utf8')) } catch (e) { throw new ManifestError(`манифест не JSON: ${(e as Error).message}`) }
  const o = obj(raw)
  if (!o) throw new ManifestError('манифест: корень не объект')
  if (o['schema'] !== MANIFEST_SCHEMA) throw new ManifestError(`манифест: схема ${JSON.stringify(o['schema'])} незнакома этой версии Пульта (знаю ${MANIFEST_SCHEMA}) — обнови Пульт вручную: pult update --from <тарбол>`)
  const version = versionField(o['version'], 'version')
  const released = o['released']
  if (typeof released !== 'string' || !Number.isFinite(Date.parse(released))) throw new ManifestError('released: не дата ISO')
  const notes = httpsUrl(o['notes'], 'notes')
  const pkg = asset(o['package'], 'package', PACKAGE_MAX_BYTES)
  const m: Manifest = { schema: 1, version, released, notes, package: pkg }
  if (o['app'] !== undefined) {
    const a = obj(o['app'])
    if (!a) throw new ManifestError('app: не объект')
    const app: ReleaseApp = { version: versionField(a['version'], 'app.version'), minVersion: versionField(a['minVersion'], 'app.minVersion') }
    if (a['darwin-arm64'] !== undefined) app['darwin-arm64'] = asset(a['darwin-arm64'], 'app.darwin-arm64', APP_MAX_BYTES)
    m.app = app
  }
  return m
}

/**
 * Конверт → проверенный манифест. Порядок — ответ на угрозы, а не красота:
 *   1. размер и разбор КОНВЕРТА (он ещё не доверен, но в нём нет ничего, кроме трёх строк);
 *   2. схема конверта: незнакомая — отказ (новый формат подписи старый код проверять не умеет);
 *   3. ключ по keyId из ДОВЕРЕННЫХ этой сборки; пустой список — отдельный внятный отказ;
 *   4. подпись Ed25519 над сырыми байтами payload;
 *   5. и только теперь — разбор манифеста.
 * Любой отказ — ManifestError с причиной в одну строку.
 */
export function verifyEnvelope(text: string | Buffer, keys: readonly TrustedKey[]): Manifest {
  const buf = typeof text === 'string' ? Buffer.from(text, 'utf8') : text
  if (buf.length > MANIFEST_MAX_BYTES) throw new ManifestError(`latest.json: ${buf.length} байт — больше потолка ${MANIFEST_MAX_BYTES}`)
  let raw: unknown
  try { raw = JSON.parse(buf.toString('utf8')) } catch { throw new ManifestError('latest.json не JSON') }
  const env = obj(raw)
  if (!env) throw new ManifestError('latest.json: корень не объект')
  if (env['schema'] !== ENVELOPE_SCHEMA) throw new ManifestError(`latest.json: схема конверта ${JSON.stringify(env['schema'])} незнакома этой версии Пульта (знаю ${ENVELOPE_SCHEMA}) — обнови Пульт вручную: pult update --from <тарбол>`)
  const keyId = env['keyId']
  if (typeof keyId !== 'string' || !/^[0-9a-f]{8}$/.test(keyId)) throw new ManifestError('latest.json: keyId — не 8 hex-символов')
  const payload = strictBase64(env['payload'], 'latest.json: payload')
  const signature = strictBase64(env['signature'], 'latest.json: signature')
  if (signature.length !== 64) throw new ManifestError('latest.json: подпись не 64 байта Ed25519')

  if (!keys.length) throw new ManifestError('в этой сборке нет ключа релизов — проверить latest.json нечем; ставь версию руками: pult update --from <тарбол>')
  const trusted = keys.find((k) => k.id === keyId)
  if (!trusted) throw new ManifestError(`latest.json подписан ключом ${keyId}, которому эта сборка не доверяет (знаю: ${keys.map((k) => k.id).join(', ')})`)
  const rawKey = rawPublicKey(trusted.publicKey)
  // Строка списка, у которой id не от этого ключа, — опечатка в keys.ts: доверять ей нельзя ни в какую сторону.
  if (keyIdOf(rawKey) !== trusted.id) throw new ManifestError(`ключ ${trusted.id} в сборке испорчен: его id не совпадает с самим ключом`)
  if (!verify(null, payload, publicKeyObject(rawKey), signature)) throw new ManifestError(`подпись latest.json не сходится с ключом ${keyId} — файл подменён или испорчен`)
  return parseManifest(payload)
}

/** Подписать байты манифеста: конверт JSON-текстом (release.mjs). Ключ — закрытый Ed25519. */
export function signEnvelope(manifestBytes: Buffer, privateKey: KeyObject): string {
  const { keyId } = publicOf(privateKey)
  // Подписанное должно разбираться — релиз с манифестом, который отвергнет любой Пульт, не выпускаем.
  parseManifest(manifestBytes)
  const signature = sign(null, manifestBytes, privateKey)
  const env: Envelope = { schema: 1, keyId, payload: manifestBytes.toString('base64'), signature: signature.toString('base64') }
  return JSON.stringify(env, null, 2) + '\n'
}
