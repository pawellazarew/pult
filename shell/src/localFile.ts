import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

// Other file types are revealed in Finder; they must never be launched as programs.
const DOCUMENTS = new Set(['.pdf', '.txt', '.md', '.csv', '.json', '.log', '.rtf', '.docx', '.xlsx', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.webm'])

export function localFile(raw: unknown): { path: string; action: 'open' | 'reveal' } {
  if (typeof raw !== 'string' || raw.length > 8192 || !path.isAbsolute(raw) || raw.startsWith('//') || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error('invalid local path')
  const resolved = realpathSync(raw)
  const stat = statSync(resolved)
  if (!stat.isFile()) throw new Error('not a regular file')
  return { path: resolved, action: DOCUMENTS.has(path.extname(resolved).toLowerCase()) && !(stat.mode & 0o111) ? 'open' : 'reveal' }
}
