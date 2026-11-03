import { t as tr } from './i18n.js'
// Вложения — снимок файла, а не обещание прочитать исходник позже. Destination всегда выбирает main.
// Папки остаются ссылками (не копируем дерево); обычные файлы/байты живут в session-scoped attachments.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { attachmentName, attachmentsDir, dayBytes, ensurePrivateDir, imageHeaderSize, MAX_DAY_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, SESSION_NAME_RE } from './clipboardImage.js'
import type { AttachmentInput, AttachmentResult } from './contract.js'

export const MAX_ATTACHMENT_BYTES = MAX_IMAGE_BYTES
const fail = (error: string): { error: string } => ({ error })
const tooLarge = (): { error: string } => fail(tr('Файл больше 25 МБ. Прикрепи меньший файл или укажи путь к исходнику в тексте.'))

/** Имя служит только подписью/суффиксом: абсолютный путь и ../ не могут выбрать папку записи. */
export function attachmentBaseName(raw: string): string {
  const name = path.basename(raw.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim().replace(/^\.+/, '')
  const clean = name || 'attachment'
  const suffix = path.extname(clean)
  const ext = Buffer.byteLength(suffix) <= 24 ? suffix : ''
  const chars = Array.from(ext ? clean.slice(0, -ext.length) : clean)
  while (Buffer.byteLength(chars.join('') + ext) > 180) chars.pop()
  return chars.join('') + ext
}

function mime(name: string, bytes?: Buffer): string {
  const head = bytes && imageHeaderSize(bytes)
  if (head) return head.type === 'png' ? 'image/png' : 'image/jpeg'
  const ext = path.extname(name).toLowerCase()
  return ({ '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[ext] ?? 'application/octet-stream'
}

/** Только уже сохранённый файл этой сессии; все ступени ниже home должны быть настоящими папками. */
export function ownedAttachment(home: string, session: string, source: string): boolean {
  if (!path.isAbsolute(home) || !SESSION_NAME_RE.test(session) || !path.isAbsolute(source)) return false
  const root = path.join(attachmentsDir(home), session)
  const rel = path.relative(root, source)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).length !== 2) return false
  try {
    for (const d of [attachmentsDir(home), root, path.dirname(source)]) {
      const st = lstatSync(d)
      if (st.isSymbolicLink() || !st.isDirectory()) return false
    }
    const st = lstatSync(source)
    return st.isFile() && !st.isSymbolicLink() && realpathSync(source) === path.join(realpathSync(home), 'attachments', session, rel)
  } catch { return false }
}

function readFileBounded(source: string, maxBytes: number): Buffer | { error: string } {
  let fd: number | undefined
  try {
    // O_NONBLOCK исключает блокировку FIFO; O_NOFOLLOW не даёт заменить исходник ссылкой перед open.
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile()) return fail(tr('Можно прикрепить обычный файл или папку. Этот объект файловой системы не поддерживается.'))
    if (st.size > maxBytes) return tooLarge()
    const out = Buffer.alloc(st.size + 1)
    let count = 0
    while (count < out.length) {
      const n = readSync(fd, out, count, out.length - count, null)
      if (!n) break
      count += n
    }
    if (count !== st.size) return fail(tr('Файл изменился во время добавления. Перетащи его ещё раз.'))
    return out.subarray(0, count)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return fail(tr('Исходный файл уже исчез. Перетащи файл ещё раз или вставь скриншот из буфера.'))
    if (code === 'EACCES' || code === 'EPERM') return fail(tr('Нет доступа к файлу. Проверь права или выбери доступную копию.'))
    if (code === 'ELOOP') return fail(tr('Прикрепи сам файл: символические ссылки не копируются.'))
    return fail(tr('Не удалось прочитать файл. Проверь, что он доступен, и попробуй ещё раз.'))
  } finally { if (fd !== undefined) closeSync(fd) }
}

/** Source path chosen in the renderer is restricted to an existing saved attachment (e.g. draft→session). */
export function importStoredAttachment(o: ImportAttachmentOptions): AttachmentResult {
  const raw = o.item && typeof o.item === 'object' ? o.item as Record<string, unknown> : null
  if (raw && typeof raw['path'] === 'string') {
    const source = raw['path']
    const rel = path.relative(attachmentsDir(o.home), source).split(path.sep)
    const session = rel.length === 3 ? rel[0] ?? '' : ''
    if (!ownedAttachment(o.home, session, source)) return fail(session && SESSION_NAME_RE.test(session) && rel.length === 3
      ? tr('Сохранённое вложение исчезло или недоступно. Прикрепи файл ещё раз.')
      : tr('Этот путь не является сохранённым вложением Пульта. Перетащи файл или вставь его из буфера.'))
  }
  return importAttachment(o)
}

export interface ImportAttachmentOptions {
  home: string
  session: unknown
  item: unknown
  now?: Date
  rand?: () => Buffer
  maxBytes?: number
  maxDayBytes?: number
}

export function importAttachment(o: ImportAttachmentOptions): AttachmentResult {
  if (!path.isAbsolute(o.home)) return fail(tr('Пульт ещё не готов сохранять вложения.'))
  if (typeof o.session !== 'string' || !SESSION_NAME_RE.test(o.session)) return fail(tr('Для вложений нужна сессия с корректным именем.'))
  if (!o.item || typeof o.item !== 'object' || Array.isArray(o.item)) return fail(tr('Не удалось получить вложение.'))
  const item = o.item as AttachmentInput
  if (item.name !== undefined && (typeof item.name !== 'string' || item.name.length > 4096)) return fail(tr('Не удалось получить имя файла.'))
  if (item.path !== undefined && typeof item.path !== 'string') return fail(tr('Не удалось получить путь к файлу.'))
  if (item.bytes !== undefined && !(item.bytes instanceof Uint8Array)) return fail(tr('Не удалось получить содержимое файла.'))
  const hasPath = typeof item.path === 'string' && item.path.length > 0
  const hasBytes = item.bytes instanceof Uint8Array
  if (hasPath === hasBytes) return fail(tr('Нужно передать один файл или его содержимое.'))
  const maxBytes = o.maxBytes ?? MAX_ATTACHMENT_BYTES
  let data: Buffer
  let name: string
  if (hasPath) {
    const source = item.path!
    if (!path.isAbsolute(source) || source.includes('\0') || source.length > 16_384) return fail(tr('Нужен абсолютный путь к файлу.'))
    name = attachmentBaseName(item.name ?? source)
    try {
      const st = lstatSync(source)
      if (st.isSymbolicLink()) return fail(tr('Прикрепи сам файл: символические ссылки не копируются.'))
      if (st.isDirectory()) return { path: realpathSync(source), name, bytes: 0, mime: 'inode/directory', kind: 'directory' }
      if (!st.isFile()) return fail(tr('Можно прикрепить обычный файл или папку. Этот объект файловой системы не поддерживается.'))
    } catch { return fail(tr('Исходный файл уже исчез или недоступен. Перетащи его ещё раз.')) }
    const read = readFileBounded(source, maxBytes)
    if (!Buffer.isBuffer(read)) return read
    data = read
    if (ownedAttachment(o.home, o.session, source)) return { path: source, name, bytes: data.length, mime: mime(name, data), kind: 'file' }
  } else {
    if (item.bytes!.byteLength > maxBytes) return tooLarge()
    data = Buffer.from(item.bytes!)
    name = attachmentBaseName(item.name ?? 'attachment')
  }
  const now = o.now ?? new Date()
  const hex = (o.rand ?? (() => randomBytes(6)))().toString('hex')
  const { day, file } = attachmentName(now, hex)
  const root = attachmentsDir(o.home)
  if (dayBytes(root, day) + data.length > (o.maxDayBytes ?? MAX_DAY_BYTES)) return fail(tr('Сегодня сохранено больше 1 ГБ вложений. Укажи путь к исходнику в тексте или попробуй завтра.'))
  const dir = path.join(root, o.session, day)
  const full = path.join(dir, `${file.slice(0, -4)}-${name}`)
  let fd: number | undefined
  let created = false
  try {
    mkdirSync(o.home, { recursive: true, mode: 0o700 })
    for (const d of [root, path.join(root, o.session), dir]) ensurePrivateDir(d)
    fd = openSync(full, 'wx', 0o600)
    created = true
    let off = 0
    while (off < data.length) {
      const n = writeSync(fd, data, off, data.length - off)
      if (!n) throw new Error('short write')
      off += n
    }
    return { path: full, name, bytes: data.length, mime: mime(name, data), kind: 'file' }
  } catch {
    if (created) { try { unlinkSync(full) } catch { /* уже исчез */ } }
    return fail(tr('Не удалось сохранить вложение в папке Пульта. Проверь свободное место и права доступа.'))
  } finally { if (fd !== undefined) closeSync(fd) }
}

export interface ThumbnailImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'good' }): ThumbnailImage
  toDataURL(): string
}

/** Превью только raster PNG/JPEG из собственного хранилища. HTML/SVG никогда не декодируются. */
export function previewAttachment(o: { home: string; session: unknown; source: unknown; decode(bytes: Buffer): ThumbnailImage }): { dataUrl: string } | { error: string } {
  if (typeof o.session !== 'string' || typeof o.source !== 'string' || !ownedAttachment(o.home, o.session, o.source)) return fail(tr('Превью доступно только для сохранённого вложения этой сессии.'))
  const data = readFileBounded(o.source, MAX_ATTACHMENT_BYTES)
  if (!Buffer.isBuffer(data)) return data
  const head = imageHeaderSize(data)
  if (!head || head.width <= 0 || head.height <= 0 || head.width * head.height > MAX_IMAGE_PIXELS) return fail(tr('Для этого файла нет превью изображения.'))
  try {
    const image = o.decode(data)
    const size = image.getSize()
    if (image.isEmpty() || size.width <= 0 || size.height <= 0 || size.width * size.height > MAX_IMAGE_PIXELS) return fail(tr('Изображение не читается.'))
    const scale = Math.min(1, 320 / size.width, 240 / size.height)
    const dataUrl = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }).toDataURL()
    if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 280_000) return fail(tr('Не удалось подготовить небольшое превью.'))
    return { dataUrl }
  } catch { return fail(tr('Изображение не читается.')) }
}
