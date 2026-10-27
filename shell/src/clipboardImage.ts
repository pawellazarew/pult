// Картинка из буфера (скриншот без файла, «Копировать картинку» в браузере) → PNG-файл, путь которого окно вставляет
// в поле реплики, как путь скопированного файла. Решает здесь main, а не окно: путь и байты окно не передаёт —
// метод моста `clipboardImage.save()` без аргументов (contract.ts). Модуль без Electron: картинка приходит
// параметром (`NativeImage` подходит как есть), тесты — без окна.
//
// Раскладка: `PULT_HOME/attachments/<ГГГГ-ММ-ДД>/paste-<ЧЧММСС>-<6 hex>.png` (местное время). Папки 0700, файл 0600,
// создаётся с `wx` — существующий файл не перезаписывается. `attachments` и папка дня — настоящие папки, не симлинки:
// симлинк на месте любой из них — отказ, а не запись туда, куда он ведёт. Старше 30 дней удаляет демон
// (src/core/attachments.ts). PULT_HOME — тот же, что у демона (`paths()` пакета: env PULT_HOME или ~/.pult).

import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'

/** Потолок PNG на диске. Больше — отказ словами, файл не пишется. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
/** Потолок пикселей ДО кодирования: огромный битмап не кодируем вовсе (память main). 100 Мпикс ≈ 400 МБ RGBA. */
export const MAX_IMAGE_PIXELS = 100_000_000

/** То, что нужно от `NativeImage`. */
export interface ImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toPNG(): Buffer
}

export type SavedImage = { path: string; width: number; height: number; bytes: number }
export type SaveImageResult = SavedImage | { error: string }

export interface SaveImageOptions {
  /** PULT_HOME (абсолютный путь). */
  home: string
  image: ImageLike | null
  now?: Date
  /** 3 случайных байта → 6 hex в имени. */
  rand?: () => Buffer
  maxBytes?: number
  maxPixels?: number
}

/** Сырые байты картинки в буфере больше этого — не читаем (до декодирования). */
export const MAX_RAW_BYTES = 200 * 1024 * 1024

/**
 * Буфер Electron 44 (`clipboard.read()` → `ClipboardItem`): синхронного `readImage` в этой версии нет. Картинку
 * Chromium отдаёт MIME-типом `image/png` (скриншот macOS, «Копировать картинку» в браузере).
 */
export interface ClipboardItemsLike {
  read(): Promise<Array<{ types: readonly string[]; getType(type: string): Promise<unknown> }>>
}

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
        if (!(v instanceof Blob) || v.size === 0 || v.size > maxRaw) return null
        return Buffer.from(await v.arrayBuffer())
      } catch { return null }
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

export function saveClipboardImage(o: SaveImageOptions): SaveImageResult {
  if (!path.isAbsolute(o.home)) return { error: 'PULT_HOME не абсолютный' }
  const img = o.image
  if (!img || img.isEmpty()) return { error: 'в буфере нет картинки' }
  const { width, height } = img.getSize()
  if (!(width > 0 && height > 0)) return { error: 'в буфере нет картинки' }
  if (width * height > (o.maxPixels ?? MAX_IMAGE_PIXELS)) return { error: `картинка слишком большая: ${width}×${height}` }
  const maxBytes = o.maxBytes ?? MAX_IMAGE_BYTES
  const png = img.toPNG()
  if (png.length > maxBytes) {
    return { error: `картинка больше ${Math.round(maxBytes / 1024 / 1024)} МБ (${(png.length / 1024 / 1024).toFixed(1)} МБ в PNG) — сохрани её файлом и вставь путь` }
  }
  const now = o.now ?? new Date()
  const hex = (o.rand ?? (() => randomBytes(3)))().toString('hex').slice(0, 6)
  const { day, file } = attachmentName(now, hex)
  const root = attachmentsDir(o.home)
  const dayDir = path.join(root, day)
  const full = path.join(dayDir, file)
  try {
    // PULT_HOME мог ещё не появиться (окно первым): родитель — с теми же правами, что у демона (ensureLayout).
    mkdirSync(o.home, { recursive: true, mode: 0o700 })
    ensurePrivateDir(root)
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
