import { translator } from '../i18n/core.js'
import { filesEn } from '../i18n/files.en.js'
import { constants } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { imageMime } from './images.js'
import type { FileEntry, FileListing, FilePreview, FileScope } from './fileBrowserTypes.js'

const tr = translator(filesEn)

export const MAX_FILE_ENTRIES = 400
export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024
export const MAX_BINARY_PREVIEW_BYTES = 20 * 1024 * 1024
const MAX_DIRECTORY_SCAN = 5000
const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.csv', '.tsv',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xml', '.svg', '.sql',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh',
  '.svelte', '.vue', '.graphql', '.gql', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.env'])
const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'notice', 'dockerfile', 'makefile', 'gemfile', 'procfile'])
const MARKDOWN = new Set(['.md', '.markdown', '.mdown', '.mdx'])
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const inside = (root: string, source: string): boolean => {
  const relative = path.relative(root, source)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
const denied = (): Error => new Error(tr('Файл недоступен в этом проекте'))
const pathInput = (source: string): void => {
  if (typeof source !== 'string' || !source || source.length > 8192 || /[\u0000-\u001f\u007f]/.test(source)
    || source.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(source)) throw denied()
}
const canonical = async (source: string): Promise<string> => { try { return await realpath(source) } catch { return path.resolve(source) } }

async function context(scope: FileScope): Promise<{ root: string; workspace: boolean; sensitive(source: string): boolean }> {
  pathInput(scope.cwd)
  if (!path.isAbsolute(scope.cwd)) throw denied()
  const root = await realpath(scope.cwd)
  if (!(await stat(root)).isDirectory()) throw new Error(tr('Выбери папку проекта для просмотра файлов'))
  const userHome = await canonical(scope.userHome ?? homedir())
  const credentialRoots = await Promise.all(['.ssh', '.aws', '.gnupg', '.config', '.pult', '.codex', '.claude']
    .map((name) => canonical(path.join(userHome, name))))
  const sensitive = (source: string): boolean => credentialRoots.some((dir) => inside(dir, source))
  const workspace = root !== path.parse(root).root && !inside(root, userHome) && !sensitive(root)
  return { root, workspace, sensitive }
}

/** A directory listing never enumerates outside the selected workspace, even for cited outputs. */
export async function listWorkspaceFiles(scope: FileScope, source = '.', showHidden = false): Promise<FileListing> {
  if (source === '') source = '.'
  pathInput(source)
  const ctx = await context(scope)
  if (!ctx.workspace) throw new Error(tr('Выбери папку проекта для просмотра файлов'))
  const directory = await realpath(path.resolve(ctx.root, source))
  if (!inside(ctx.root, directory) || ctx.sensitive(directory)) throw denied()
  const handle = await opendir(directory)
  const entries: FileEntry[] = []
  let scanned = 0
  let truncated = false
  for await (const entry of handle) {
    if (++scanned > MAX_DIRECTORY_SCAN) { truncated = true; break }
    if (!showHidden && entry.name.startsWith('.')) continue
    const candidate = path.join(directory, entry.name)
    try {
      const resolved = await realpath(candidate)
      if (!inside(ctx.root, resolved) || ctx.sensitive(resolved)) continue
      const info = await stat(resolved)
      if (!info.isFile() && !info.isDirectory()) continue
      if (entries.length === MAX_FILE_ENTRIES) { truncated = true; break }
      entries.push({ name: entry.name, path: path.relative(ctx.root, candidate), kind: info.isDirectory() ? 'directory' : 'file',
        size: info.isFile() ? info.size : 0, modifiedAt: info.mtime.toISOString() })
    } catch { /* Deleted, unreadable and escaping entries are not navigable. */ }
  }
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory')
    || a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name))
  return { root: ctx.root, path: path.relative(ctx.root, directory), entries, truncated }
}

/** File content crosses the bridge only within the workspace or for an explicitly cited output. */
export async function readWorkspaceFile(scope: FileScope, source: string): Promise<FilePreview> {
  pathInput(source)
  const ctx = await context(scope)
  const resolved = await realpath(path.resolve(ctx.root, source))
  if (ctx.sensitive(resolved)) throw denied()
  let allowed = ctx.workspace && inside(ctx.root, resolved)
  if (!allowed) for (const candidate of scope.allowedFiles ?? []) {
    try { pathInput(candidate); if (path.isAbsolute(candidate) && await realpath(candidate) === resolved) { allowed = true; break } } catch { /* A stale citation grants nothing. */ }
  }
  if (!allowed) throw denied()
  const expected = await stat(resolved)
  if (await realpath(resolved) !== resolved) throw denied()
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (info.dev !== expected.dev || info.ino !== expected.ino) throw denied()
    if (!info.isFile()) throw new Error(tr('Выбери обычный файл'))
    const base: FilePreview = { path: resolved, name: path.basename(resolved), kind: 'unsupported', size: info.size, modifiedAt: info.mtime.toISOString() }
    const unsupported = (reason: string): FilePreview => ({ ...base, reason })
    if (info.mode & 0o111) return unsupported(tr('Исполняемый файл можно показать в Finder'))
    const ext = path.extname(resolved).toLowerCase()
    const markdown = MARKDOWN.has(ext)
    const image = IMAGES[ext]
    const pdf = ext === '.pdf'
    const text = markdown || TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(base.name.toLowerCase()) || TEXT_EXTENSIONS.has(base.name.toLowerCase())
    if (!text && !image && !pdf) return unsupported(tr('Предпросмотр этого формата пока недоступен'))
    const limit = image || pdf ? MAX_BINARY_PREVIEW_BYTES : MAX_TEXT_PREVIEW_BYTES
    if (info.size > limit) return unsupported(tr`Файл слишком большой для предпросмотра (максимум ${image || pdf ? tr('20 МБ') : tr('512 КБ')})`)
    // Read at most limit + 1, even if another process grows the file after stat().
    const chunks: Buffer[] = []
    let total = 0
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead
    }
    if (total > limit) return unsupported(tr('Файл вырос и слишком большой для предпросмотра'))
    const bytes = Buffer.concat(chunks, total)
    const current = { ...base, size: total }
    if (image) return imageMime(bytes) === image
      ? { ...current, kind: 'image', dataUrl: `data:${image};base64,${bytes.toString('base64')}` }
      : unsupported(tr('Файл не является поддерживаемым изображением'))
    if (pdf) return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
      ? { ...current, kind: 'pdf', base64: bytes.toString('base64') }
      : unsupported(tr('Файл не является PDF-документом'))
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(content)) return unsupported(tr('Бинарный файл нельзя показать как текст'))
      return { ...current, kind: markdown ? 'markdown' : 'text', text: content }
    } catch { return unsupported(tr('Файл не является текстом в UTF-8')) }
  } finally { await handle.close() }
}
