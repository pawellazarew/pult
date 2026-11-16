import { t as tr } from './i18n.js'
import type { AttachmentInput } from './contract.js'

/** Preload obtains source from webUtils, never from a renderer-supplied path property. */
export async function attachmentInputFromFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>, source: string): Promise<AttachmentInput | { error: string }> {
  if (source) return { name: file.name, path: source }
  // A browser/clipboard blob has no original path to retain. Do not materialize an oversized buffer.
  if (file.size > 25 * 1024 * 1024) return { error: tr`${file.name}: файл больше 25 МБ и не имеет локального пути. Сохрани его на диск и прикрепи заново.` }
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
}
