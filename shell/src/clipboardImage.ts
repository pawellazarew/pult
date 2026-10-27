// Картинка из буфера (скриншот без файла, «Копировать картинку» в браузере) → PNG-файл, путь которого окно вставляет
// в поле реплики, как путь скопированного файла. Решает здесь main, а не окно: ни пути, ни байтов окно не передаёт —
// метод моста `clipboardImage.save(session)` получает только имя сессии (contract.ts). Модуль без Electron:
// декодер приходит параметром (`nativeImage.createFromBuffer`), тесты — без окна.
//
// Раскладка: `PULT_HOME/attachments/<сессия>/<ГГГГ-ММ-ДД>/paste-<ЧЧММСС>-<6 hex>.png` (местное время). Папка сессии —
// своя у каждой: claude получает `--add-dir` только на неё (ревью #17: общая папка открывала каждой сессии картинки всех
// остальных). Папки 0700, файл 0600, создаётся с `wx` — существующий файл не перезаписывается. `attachments`, папка
// сессии и папка дня — настоящие папки: симлинк на месте любой из них — отказ, а не запись туда, куда он ведёт.
// Старше 30 дней удаляет демон (src/core/attachments.ts). PULT_HOME — тот же, что у демона (`paths()` пакета).

import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'

/** Потолок PNG на диске. Больше — отказ словами, файл не пишется. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
/** Потолок пикселей — по заголовку, ДО декодирования (бомба: крошечный PNG, объявивший 50000×50000). */
export const MAX_IMAGE_PIXELS = 100_000_000
/** Сырые байты картинки в буфере больше этого — не читаем вовсе. */
export const MAX_RAW_BYTES = 50 * 1024 * 1024
/** Потолок за день по всем сессиям (`attachments/*\/<день>`): окно не забьёт диск вставками. */
export const MAX_DAY_BYTES = 1024 * 1024 * 1024

/** То же правило, что у демона (`SESSION_NAME_RE`, src/sessions/registry.ts; юнит сверяет). */
export const SESSION_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** То, что нужно от `NativeImage`. */
export interface ImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toPNG(): Buffer
}

export type SavedImage = { path: string; width: number; height: number; bytes: number }
export type SaveImageResult = SavedImage | { error: string }

/**
 * Буфер Electron 44 (`clipboard.read()` → `ClipboardItem`): синхронного `readImage` в этой версии нет. Картинку
 * Chromium отдаёт MIME-типом `image/png` (скриншот macOS, «Копировать картинку» в браузере).
 */
export interface ClipboardItemsLike {
  read(): Promise<Array<{ types: readonly string[]; getType(type: string): Promise<unknown> }>>
}

/** Blob утиной типизацией: значение из другого мира (realm) `instanceof Blob` не проходит. */
interface BlobLike { size: number; arrayBuffer(): Promise<ArrayBuffer> }
const isBlobLike = (v: unknown): v is BlobLike =>
  typeof v === 'object' && v !== null && typeof (v as BlobLike).arrayBuffer === 'function' && typeof (v as BlobLike).size === 'number'

/** Байты первой картинки буфера (`image/png`, иначе любой `image/*`); нет картинки или слишком большая — null. */
export async function readClipboardImageBytes(cb: ClipboardItemsLike, maxRaw = MAX_RAW_BYTES): Promise<Buffer | null> {
  let items
  try { items = await cb.read() } catch { return null }
  for (const want of ['image/png', 'image/']) {
    for (const item of items) {
      const type = item.types.find((t) => (want.endsWith('/') ? t.startsWith(want) : t === want))
      if (!type) continue
      try {
        const v = await item.getType(type)
        if (!isBlobLike(v) || v.size === 0 || v.size > maxRaw) return null
        // Buffer поверх ArrayBuffer — без копии.
        return Buffer.from(await v.arrayBuffer())
      } catch { return null }
    }
  }
  return null
}

/**
 * Размер картинки по заголовку — без декодирования. PNG: IHDR сразу за подписью. JPEG: первый SOF (C0–CF, кроме
 * C4/C8/CC). Прочие форматы — null: такие не декодируем вовсе (размер не узнать, не распаковав).
 */
export function imageHeaderSize(b: Buffer): { type: 'png' | 'jpeg'; width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    for (let guard = 0; guard < 10_000 && i + 4 <= b.length; guard++) {
      if (b[i] !== 0xff) return null
      const m = b[i + 1]!
      if (m === 0xff) { i++; continue } // заполнитель
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      if (m === 0xd9 || m === 0xda) return null // конец или данные скана раньше SOF
      const len = b.readUInt16BE(i + 2)
      if (len < 2) return null
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (i + 9 > b.length) return null
        return { type: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
  }
  return null
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

export function attachmentsDir(home: string): string {
  return path.join(home, 'attachments')
}

/** `<ГГГГ-ММ-ДД>` и `paste-<ЧЧММСС>-<hex>.png` по местному времени. */
export function attachmentName(now: Date, hex: string): { day: string; file: string } {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const file = `paste-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${hex}.png`
  return { day, file }
}

/** Папка 0700, и именно папка: симлинк или файл на её месте — ошибка (симлинк не следуем). */
function ensurePrivateDir(dir: string): void {
  try { mkdirSync(dir, { mode: 0o700 }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  const st = lstatSync(dir)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} — не папка`)
  chmodSync(dir, 0o700)
}

/** Сколько байт уже лежит за этот день во всех сессиях (`attachments/*\/<день>/*`); симлинки не раскрываются. */
export function dayBytes(root: string, day: string): number {
  let total = 0
  let sessions: string[] = []
  try {
    const st = lstatSync(root)
    if (st.isSymbolicLink() || !st.isDirectory()) return 0
    sessions = readdirSync(root)
  } catch { return 0 }
  for (const s of sessions) {
    const d = path.join(root, s, day)
    try { const st = lstatSync(d); if (st.isSymbolicLink() || !st.isDirectory()) continue } catch { continue }
    let files: string[] = []
    try { files = readdirSync(d) } catch { continue }
    for (const f of files) {
      try { const st = lstatSync(path.join(d, f)); if (st.isFile()) total += st.size } catch { /* исчез */ }
    }
  }
  return total
}

export interface SaveImageOptions {
  /** PULT_HOME (абсолютный путь). */
  home: string
  /** Имя сессии (`SESSION_NAME_RE`): папка `attachments/<сессия>`. */
  session: unknown
  /** Сырые байты из буфера (PNG или JPEG); null — картинки нет. */
  bytes: Buffer | null
  /** Декодер (в main — `nativeImage.createFromBuffer`). Зовётся только после проверки размера по заголовку. */
  decode(bytes: Buffer): ImageLike
  now?: Date
  /** 3 случайных байта → 6 hex в имени. */
  rand?: () => Buffer
  maxBytes?: number
  maxPixels?: number
  maxDayBytes?: number
}

export function saveClipboardImage(o: SaveImageOptions): SaveImageResult {
  if (!path.isAbsolute(o.home)) return { error: 'PULT_HOME не абсолютный' }
  if (typeof o.session !== 'string' || !SESSION_NAME_RE.test(o.session)) {
    return { error: 'картинке нужна сессия: сначала задай имя (латиница, цифры, - и _)' }
  }
  if (!o.bytes || o.bytes.length === 0) return { error: 'в буфере нет картинки' }
  const head = imageHeaderSize(o.bytes)
  if (!head) return { error: 'картинка в незнакомом формате (нужен PNG или JPEG) — сохрани её файлом и вставь путь' }
  if (!(head.width > 0 && head.height > 0)) return { error: 'в буфере нет картинки' }
  const maxPixels = o.maxPixels ?? MAX_IMAGE_PIXELS
  if (head.width * head.height > maxPixels) return { error: `картинка слишком большая: ${head.width}×${head.height}` }
  let img: ImageLike | null = o.decode(o.bytes)
  if (!img || img.isEmpty()) return { error: 'картинка не читается' }
  const { width, height } = img.getSize()
  // Декодер обязан согласиться с заголовком: иначе проверка размера выше ничего не стоила.
  if (!(width > 0 && height > 0) || width * height > maxPixels) return { error: 'картинка не читается' }
  const maxBytes = o.maxBytes ?? MAX_IMAGE_BYTES
  const png = img.toPNG()
  img = null
  if (png.length > maxBytes) {
    return { error: `картинка больше ${Math.round(maxBytes / 1024 / 1024)} МБ (${(png.length / 1024 / 1024).toFixed(1)} МБ в PNG) — сохрани её файлом и вставь путь` }
  }
  const now = o.now ?? new Date()
  const hex = (o.rand ?? (() => randomBytes(3)))().toString('hex').slice(0, 6)
  const { day, file } = attachmentName(now, hex)
  const root = attachmentsDir(o.home)
  const maxDay = o.maxDayBytes ?? MAX_DAY_BYTES
  if (dayBytes(root, day) + png.length > maxDay) {
    return { error: `за сегодня вставлено больше ${Math.round(maxDay / 1024 / 1024)} МБ картинок — сохрани файлом и вставь путь` }
  }
  const sessionDir = path.join(root, o.session)
  const dayDir = path.join(sessionDir, day)
  const full = path.join(dayDir, file)
  try {
    // PULT_HOME мог ещё не появиться (окно первым): родитель — с теми же правами, что у демона (ensureLayout).
    mkdirSync(o.home, { recursive: true, mode: 0o700 })
    ensurePrivateDir(root)
    ensurePrivateDir(sessionDir)
    ensurePrivateDir(dayDir)
    // `wx`: не пишем поверх (и не идём по симлинку, подложенному на имя файла), режим — сразу 0600.
    const fd = openSync(full, 'wx', 0o600)
    try {
      let off = 0
      while (off < png.length) off += writeSync(fd, png, off, png.length - off)
    } catch (e) {
      // Недописанный файл (кончился диск) агенту не нужен.
      try { unlinkSync(full) } catch { /* уже нет */ }
      throw e
    } finally { closeSync(fd) }
    chmodSync(full, 0o600)
  } catch (e) {
    return { error: `картинка не сохранилась: ${(e as Error).message}` }
  }
  return { path: full, width, height, bytes: png.length }
}

/** Не чаще раза в `gapMs`: окно не засыплет диск, удерживая ⌘V. */
export class SaveRate {
  private last = -Infinity
  constructor(private readonly gapMs = 1000) {}
  take(now: number): boolean {
    if (now - this.last < this.gapMs) return false
    this.last = now
    return true
  }
}
