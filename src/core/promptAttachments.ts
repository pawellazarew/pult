import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { imageMime } from './images.js'
import { translator } from '../i18n/core.js'
const tr = translator({
  'можно прикрепить не больше 20 файлов': 'attach no more than 20 files',
  'неверные метаданные вложения': 'invalid attachment metadata',
  'вложение «{0}» недоступно или изменилось — прикрепи его заново': 'attachment “{0}” is unavailable or changed — attach it again',
  'вложение «{0}» недоступно — прикрепи его заново': 'attachment “{0}” is unavailable — attach it again',
  'изображение недоступно или изменилось': 'image is unavailable or changed',
  'изображение изменилось — прикрепи его заново': 'image changed — attach it again',
  'формат изображения не совпадает с содержимым': 'image format does not match its contents',
})

/** Stable metadata persisted with the user message. Native image bytes never enter the journal. */
export interface PromptAttachment { path: string; name: string; bytes: number; mime: string; kind: 'file' | 'directory' }
export interface PromptAttachmentScope { home: string; sessionId: string }
export const MAX_PROMPT_ATTACHMENTS = 20
export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024
const SESSION = /^[a-z][a-z0-9_-]{0,31}$/
const NATIVE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Match the shell's ownedAttachment boundary: real root/owner/day/file, never another session or a symlink. */
export function ownedPromptAttachment(home: string, sessionId: string, source: string): boolean {
  if (!SESSION.test(sessionId) || !path.isAbsolute(home) || !path.isAbsolute(source) || source.includes('\0')) return false
  const root = path.join(home, 'attachments', sessionId)
  const relative = path.relative(root, source)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length !== 2) return false
  try {
    for (const dir of [path.join(home, 'attachments'), root, path.dirname(source)]) {
      const st = lstatSync(dir)
      if (!st.isDirectory() || st.isSymbolicLink()) return false
    }
    const st = lstatSync(source)
    return st.isFile() && !st.isSymbolicLink() && realpathSync(source) === path.join(realpathSync(home), 'attachments', sessionId, relative)
  } catch { return false }
}

/** Files must be owned copies. Directories remain explicit references, and are never opened/read here. */
export function validateOwnedPromptAttachments(home: string, sessionId: string, raw: unknown): PromptAttachment[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_PROMPT_ATTACHMENTS) throw new Error(tr('можно прикрепить не больше 20 файлов'))
  return raw.map((value): PromptAttachment => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(tr('неверные метаданные вложения'))
    const v = value as Record<string, unknown>
    if (typeof v['path'] !== 'string' || !path.isAbsolute(v['path']) || /[\0\r\n]/.test(v['path']) || v['path'].length > 16_384
      || typeof v['name'] !== 'string' || !v['name'].trim() || v['name'].length > 512 || /[\0\r\n]/.test(v['name'])
      || typeof v['bytes'] !== 'number' || !Number.isSafeInteger(v['bytes']) || v['bytes'] < 0 || v['bytes'] > MAX_PROMPT_ATTACHMENT_BYTES
      || typeof v['mime'] !== 'string' || !v['mime'] || v['mime'].length > 128 || !['file', 'directory'].includes(String(v['kind']))) {
      throw new Error(tr('неверные метаданные вложения'))
    }
    const attachment: PromptAttachment = { path: v['path'], name: v['name'], bytes: v['bytes'], mime: v['mime'], kind: v['kind'] as PromptAttachment['kind'] }
    try {
      const st = lstatSync(attachment.path)
      if (attachment.kind === 'directory') {
        if (!st.isDirectory() || st.isSymbolicLink() || attachment.bytes !== 0 || attachment.mime !== 'inode/directory') throw new Error('directory')
      } else if (!ownedPromptAttachment(home, sessionId, attachment.path) || !st.isFile() || st.size !== attachment.bytes) throw new Error('file')
    } catch { throw new Error(tr`вложение «${attachment.name}» недоступно или изменилось — прикрепи его заново`) }
    return attachment
  })
}

export function isNativePromptImage(attachment: PromptAttachment): boolean {
  return attachment.kind === 'file' && NATIVE_IMAGE_MIMES.has(attachment.mime)
}

/** Provider-only path references; never store this string as the visible user message. */
export function promptAttachmentContext(text: string, attachments: readonly PromptAttachment[], includeImages = false): string {
  const refs = attachments.filter((a) => includeImages || !isNativePromptImage(a))
  return refs.length ? [text, `Прикреплённые файлы:\n${refs.map((a) => `- ${JSON.stringify(a.path)}`).join('\n')}`].filter(Boolean).join('\n\n') : text
}

function imageBytes(scope: PromptAttachmentScope, attachment: PromptAttachment): Buffer {
  if (!ownedPromptAttachment(scope.home, scope.sessionId, attachment.path)) throw new Error(tr`вложение «${attachment.name}» недоступно — прикрепи его заново`)
  const fd = openSync(attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== attachment.bytes || stat.size <= 0 || stat.size > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error(tr('изображение недоступно или изменилось'))
    const bytes = Buffer.alloc(stat.size + 1)
    let count = 0
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n }
    if (count !== stat.size) throw new Error(tr('изображение изменилось — прикрепи его заново'))
    const result = bytes.subarray(0, count)
    if (imageMime(result) !== attachment.mime) throw new Error(tr('формат изображения не совпадает с содержимым'))
    return result
  } finally { closeSync(fd) }
}

export type ClaudePromptAttachmentBlock = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
export function claudePromptAttachmentBlocks(scope: PromptAttachmentScope, attachments: readonly PromptAttachment[]): ClaudePromptAttachmentBlock[] {
  const checked = validateOwnedPromptAttachments(scope.home, scope.sessionId, attachments)
  const blocks: ClaudePromptAttachmentBlock[] = checked.filter(isNativePromptImage).map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: imageBytes(scope, a).toString('base64') } }))
  const context = promptAttachmentContext('', checked)
  if (context) blocks.push({ type: 'text', text: context })
  return blocks
}

export type CodexPromptInput = { type: 'text'; text: string } | { type: 'localImage'; path: string }
export function codexPromptInput(scope: PromptAttachmentScope, text: string, attachments: readonly PromptAttachment[] = []): CodexPromptInput[] {
  const checked = validateOwnedPromptAttachments(scope.home, scope.sessionId, attachments)
  const inputs: CodexPromptInput[] = []
  const context = promptAttachmentContext(text, checked)
  if (context) inputs.push({ type: 'text', text: context })
  for (const attachment of checked.filter(isNativePromptImage)) { imageBytes(scope, attachment); inputs.push({ type: 'localImage', path: attachment.path }) }
  return inputs
}
