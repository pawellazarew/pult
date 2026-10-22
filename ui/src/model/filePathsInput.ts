// Файлы в поле текста: ⌘V на файлах из Finder и перетаскивание кладут в поле их пути (поле реплики разговора и
// «первая реплика» в «+ Сессия»), а папка, брошенная на форму «+ Сессия», становится папкой сессии.
// Без React и без DOM: события здесь — их минимальная форма, поэтому ui/test гоняет логику без окна.

import type { FilePathSource } from './paths.js'

/** Поле с кареткой: то, что нужно знать о textarea. */
export interface Caret { value: string; selectionStart: number; selectionEnd: number }

type List<T> = ArrayLike<T> | Iterable<T>
const arr = <T>(l: List<T> | null | undefined): T[] => (l ? Array.from(l as Iterable<T>) : [])

/** Среди типов перетаскивания или буфера есть файлы. */
export function hasFiles(types: List<string> | null | undefined): boolean {
  return arr(types).includes('Files')
}

export interface PasteLike {
  clipboardData: { types: List<string>; files: List<File> }
  currentTarget: Caret
  preventDefault(): void
}
export interface DragLike {
  dataTransfer: { types: List<string>; files: List<File>; dropEffect: string }
  currentTarget: Caret
  preventDefault(): void
}

/** Куда класть пути: живое поле и вставка с кареткой (у каждого поля — свой стейт). */
export interface PathsField {
  source: FilePathSource | null
  /** Поле сейчас (может отличаться от момента события: main читает буфер асинхронно). */
  field(): Caret | null
  /** Вставить пути на место выделения [start, end) и поставить каретку за ними. */
  put(paths: string[], start: number, end: number): void
}

/**
 * Обработчики paste/dragover/drop для поля текста. Обычный текст в буфере и перетаскивание не файлов не трогаются:
 * событие не отменяется, браузер делает своё. Нет моста (старая оболочка) — поле как раньше.
 */
export function pathsInputHandlers(t: PathsField): {
  onPaste(e: PasteLike): Promise<void> | undefined
  onDragOver(e: DragLike): void
  onDrop(e: DragLike): void
} {
  return {
    // ⌘V на файлах из Finder: Chromium отдаёт тип `Files` и только ПЕРВЫЙ файл, а в поле не кладёт
    // ничего (замерено 06.10.2026, Electron 44). Все пути знает main — читает их из буфера.
    onPaste(e) {
      const src = t.source
      if (!src || !hasFiles(e.clipboardData.types)) return undefined
      e.preventDefault()
      const { selectionStart: start, selectionEnd: end, value: before } = e.currentTarget
      const dropped = arr(e.clipboardData.files)
      return (async () => {
        let paths: string[] = []
        try { paths = await src.clipboard() } catch { /* старая оболочка или чужой буфер */ }
        if (!paths.length) paths = src.files(dropped)
        if (!paths.length) return
        // Пока main читал буфер, в поле могли допечатать — тогда вставляем туда, где каретка сейчас.
        const el = t.field()
        if (el && el.value !== before) t.put(paths, el.selectionStart, el.selectionEnd)
        else t.put(paths, start, end)
      })()
    },
    onDragOver(e) {
      if (t.source && hasFiles(e.dataTransfer.types)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
    },
    onDrop(e) {
      const src = t.source
      if (!src || !arr(e.dataTransfer.files).length) return
      e.preventDefault()
      const paths = src.files(arr(e.dataTransfer.files))
      const el = e.currentTarget
      if (paths.length) t.put(paths, el.selectionStart, el.selectionEnd)
    },
  }
}

// --- папка перетаскиванием -----------------------------------------------------------

/** Подсказка, когда на форму «+ Сессия» бросили файлы, а не одну папку: форма их не берёт. */
export const FOLDER_DROP_HINT = 'Сюда — одну папку. Файлы перетащи в поле «первая реплика»: туда встанут их пути.'

/** Что брошено на форму: одна папка, файлы (их сюда не берём) или ничего с путём. */
export type FolderDrop = { kind: 'folder'; path: string } | { kind: 'files'; count: number } | { kind: 'none' }

interface EntryLike { isDirectory: boolean }
interface ItemLike { kind: string; webkitGetAsEntry?: () => EntryLike | null }
export interface DropData { files: List<File>; items?: List<ItemLike> | null }

/** Последний довод, когда у элемента нет записи файловой системы: папку как файл не прочесть. */
async function unreadable(f: File): Promise<boolean> {
  try { await f.slice(0, 1).arrayBuffer(); return false } catch { return true }
}

/**
 * Разобрать бросок на форму «+ Сессия». Синхронная часть (файлы, записи `webkitGetAsEntry`) идёт до первого
 * `await` — после события `DataTransfer` пустеет, поэтому звать прямо в обработчике `drop`.
 * Папка — только ОДНА: две папки или папка с файлами — не выбор папки, а «файлы».
 */
export async function folderFromDrop(dt: DropData, source: FilePathSource | null): Promise<FolderDrop> {
  const files = arr(dt.files)
  if (!source || !files.length) return { kind: 'none' }
  if (files.length !== 1) return { kind: 'files', count: files.length }
  let entry: EntryLike | null = null
  try { entry = arr(dt.items).find((i) => i.kind === 'file')?.webkitGetAsEntry?.() ?? null } catch { entry = null }
  const path = source.files(files)[0]
  if (!path) return { kind: 'none' }
  const dir = entry ? entry.isDirectory : await unreadable(files[0]!)
  return dir ? { kind: 'folder', path } : { kind: 'files', count: 1 }
}
