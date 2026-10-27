// Изображения хранятся отдельно от журнала: в событии только пути, не base64.
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGES = 16
const SESSION = /^[a-z][a-z0-9_-]{0,31}$/
const inside = (root: string, file: string): boolean => {
  const r = path.relative(root, file)
  return r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)
}
export interface ImageScope { home: string; sessionId: string; cwd: string; userHome?: string; codexHome?: string }
export interface ImageFile { path: string; mimeType: string; bytes: Buffer; name: string }

/** Только растровые форматы, проверенные по сигнатуре. SVG/HTML не исполняются даже под видом PNG. */
export function imageMime(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (b.length >= 6 && /GIF8[79]a/.test(b.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function readScopedImage(scope: ImageScope, source: string): ImageFile {
  if (!SESSION.test(scope.sessionId) || typeof source !== 'string' || !source || source.length > 8192 || source.includes('\0')) throw new Error('Изображение недоступно')
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) throw new Error('Поддерживаются локальные изображения')
  const canonical = (p: string): string => { try { return realpathSync(p) } catch { return path.resolve(p) } }
  const userHome = canonical(scope.userHome ?? homedir())
  const home = canonical(scope.home)
  const cwd = canonical(scope.cwd)
  const media = canonical(path.join(home, 'media', scope.sessionId))
  const generated = canonical(path.join(scope.codexHome ?? path.join(userHome, '.codex'), 'generated_images'))
  const file = realpathSync(path.resolve(scope.cwd, source))
  const roots = [media, generated]
  // Корень диска и домашний каталог не превращаются в разрешение читать любые картинки пользователя.
  if (!inside(cwd, userHome) && cwd !== path.parse(cwd).root) roots.push(cwd)
  const allowed = roots.some((root) => { try { return inside(realpathSync(root), file) } catch { return false } })
  const sensitive = ['.ssh', '.aws', '.gnupg', '.config', '.claude'].some((n) => inside(canonical(path.join(userHome, n)), file))
  const otherMedia = inside(canonical(path.join(home, 'media')), file) && !inside(media, file)
  if (!allowed || sensitive || otherMedia || inside(canonical(path.join(home, 'run')), file)) throw new Error('Изображение вне папки проекта')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) throw new Error('Изображение слишком большое или недоступно')
    const bytes = readFileSync(fd)
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Изображение слишком большое')
    const mimeType = imageMime(bytes)
    const extensions: Record<string, string[]> = { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/gif': ['.gif'], 'image/webp': ['.webp'] }
    if (!mimeType || !extensions[mimeType]?.includes(path.extname(file).toLowerCase())) throw new Error('Формат изображения не поддерживается')
    return { path: file, bytes, mimeType, name: path.basename(file) }
  } finally { closeSync(fd) }
}

export interface ImageCapture {
  capture(content: unknown): string[]
  captureFile(source: unknown): string[]
}

export function createImageCapture(scope: ImageScope): ImageCapture {
  const save = (bytes: Buffer): string | null => {
    if (!SESSION.test(scope.sessionId) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
    const mime = imageMime(bytes)
    if (!mime) return null
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mime]
    const dir = path.join(scope.home, 'media', scope.sessionId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `${createHash('sha256').update(bytes).digest('hex')}.${ext}`)
    try { writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null }
    return file
  }
  return {
    captureFile(source) {
      if (typeof source !== 'string') return []
      try { const p = save(readScopedImage(scope, source).bytes); return p ? [p] : [] } catch { return [] }
    },
    capture(content) {
      const found = new Set<string>()
      let nodes = 0
      const visit = (v: unknown, depth: number): void => {
        if (++nodes > 1000 || depth > 10 || found.size >= MAX_IMAGES) return
        if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return }
        if (v === null || typeof v !== 'object') return
        const o = v as Record<string, unknown>
        const src = o['source'] !== null && typeof o['source'] === 'object' ? o['source'] as Record<string, unknown> : null
        const raw = o['type'] === 'image' ? o['data'] ?? src?.['data'] : o['image_url']
        const data = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['url'] : null
        if (typeof data === 'string' && data.length <= MAX_IMAGE_BYTES * 4 / 3 + 100) {
          const b64 = data.startsWith('data:') ? data.match(/^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/)?.[1] : data
          if (b64 && /^[A-Za-z0-9+/=\r\n]+$/.test(b64)) {
            try { const p = save(Buffer.from(b64, 'base64')); if (p) found.add(p) } catch { /* недоступный диск не прерывает ход */ }
          }
        }
        for (const x of Object.values(o)) visit(x, depth + 1)
      }
      visit(content, 0)
      return [...found]
    },
  }
}
