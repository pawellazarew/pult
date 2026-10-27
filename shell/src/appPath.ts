// Протокол `app://pult/…` (docs/12 §2): какой файл отдать на какой адрес. Чистая функция — её
// гоняют юнит-тесты; проверку симлинков (realpath) делает main уже на найденном файле.

import path from 'node:path'
import { CSP } from './contract.js'

export const APP_SCHEME = 'app'
export const APP_HOST = 'pult'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_INDEX = `${APP_ORIGIN}/index.html`

/**
 * Файл внутри `root` для адреса `url` или `null`, если адрес чужой или выходит за корень.
 * `root` — абсолютный путь к `<пакет>/dist/ui` (уже после realpath).
 * Порядок защит: схема и хост → декодирование (кривой %-код — отказ) → NUL — отказ →
 * resolve относительно корня → относительный путь не должен начинаться с `..`.
 */
export function resolveAppPath(root: string, url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null
  let rel: string
  try { rel = decodeURIComponent(u.pathname) } catch { return null }
  if (rel.includes('\0') || rel.includes('\\')) return null
  if (rel === '' || rel === '/') rel = '/index.html'
  const full = path.resolve(root, `.${rel.startsWith('/') ? '' : '/'}${rel}`)
  const inside = path.relative(root, full)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null
  return full
}

/** Тип содержимого по расширению. Неизвестное — отказ: окну не нужно ничего, чего нет в списке. */
export const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.bcmap': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

/**
 * Заголовки ответа `app://`. CSP — на КАЖДОМ ответе, а не только на html: svg (или иной документ),
 * открытый во фрейме или напрямую, иначе исполнял бы свои скрипты без всякой политики.
 */
export function appHeaders(type: string): Record<string, string> {
  return { 'content-type': type, 'x-content-type-options': 'nosniff', 'content-security-policy': CSP }
}

export function mimeOf(file: string): string | null {
  return MIME[path.extname(file).toLowerCase()] ?? null
}
