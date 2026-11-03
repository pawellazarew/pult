import { t as tr } from '../lib/i18n.js'
// Файлы в поле текста: ⌘V на файлах из Finder и перетаскивание кладут в поле их пути (поле реплики разговора и
// «первая реплика» в «+ Сессия»), а папка, брошенная на форму «+ Сессия», становится папкой сессии. ⌘V на картинке
// без файла (скриншот, «Копировать картинку» в браузере) — окно 0.1.20 сохраняет её PNG-файлом и кладёт его путь.
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
  /** `getData('text/plain')` — обычный текст буфера; нет метода — текста нет. */
  clipboardData: { types: List<string>; files: List<File>; getData?(type: string): string }
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
  /** Вставить текст как есть (обычная вставка, отменённая ради возможных файлов, а файлов не оказалось). */
  putText?(text: string, start: number, end: number): void
  /** Сказать под полем (отказ сохранить картинку, старое окно). */
  notice?(text: string): void
  /**
   * Сессия, чья картинка: своя папка `attachments/<сессия>`, и только её claude читает без вопроса. Поле разговора —
   * его сессия, «первая реплика» — набранное имя (картинка ляжет в папку будущей сессии с этим именем).
   */
  session?(): string
}

/** Окно 0.1.15 и старше не умеет сохранять картинку из буфера: метода моста нет. */
export const OLD_WINDOW_IMAGE_HINT = tr('Вставка картинок — в окне 0.1.20 и новее: Настройки → Обновления → «Перезапустить и обновить»')

/**
 * Что делать с ⌘V — решается синхронно, в обработчике (отменить вставку можно только там):
 *   * `files` — в буфере тип `Files` (файлы из Finder ИЛИ картинка без пути): вставку отменяем, дальше по порядку пути
 *     файлов из main → пути `File` → обычный текст буфера, если есть (его и вставила бы система) → картинка;
 *   * `image` — картинка (`image/*`) без файлов и без обычного текста;
 *   * `default` — всё остальное, в том числе текст рядом с картинкой: вставку делает браузер, как раньше.
 * Текст сильнее картинки нарочно: Office, Numbers и редакторы кладут рядом с копируемым текстом его снимок — вставить
 * ждут текст. «Копировать картинку» в браузере кладёт рядом только HTML (`text/html`), обычного текста нет — картинка.
 */
export type PasteKind = 'files' | 'image' | 'default'

export function pasteKind(types: List<string> | null | undefined, plainText: string): PasteKind {
  const t = arr(types)
  if (t.includes('Files')) return 'files'
  if (!plainText && t.some((x) => x.startsWith('image/'))) return 'image'
  return 'default'
}

/** Итог вставки, когда путей файлов нет: текст, картинка или ничего. Чистая функция — матрица в ui/test. */
export function pasteFallback(o: { plainText: string; image: boolean }): 'text' | 'image' | 'none' {
  if (o.plainText) return 'text'
  return o.image ? 'image' : 'none'
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
    // Картинка без файла (скриншот, «Копировать картинку»): Chromium отдаёт `Files` с `image.png` без пути на диске
    // или только тип `image/*` — сохраняет её main (окно 0.1.20), в поле встаёт путь к PNG.
    onPaste(e) {
      const src = t.source
      let plainText = ''
      try { plainText = e.clipboardData.getData?.('text/plain') ?? '' } catch { plainText = '' }
      const kind = src ? pasteKind(e.clipboardData.types, plainText) : 'default'
      if (!src || kind === 'default') return undefined
      e.preventDefault()
      const { selectionStart: start, selectionEnd: end, value: before } = e.currentTarget
      const dropped = arr(e.clipboardData.files)
      const imageInClipboard = kind === 'image' || dropped.some((f) => f.type.startsWith('image/')) || arr(e.clipboardData.types).some((x) => x.startsWith('image/'))
      // Пока main читал буфер, в поле могли допечатать — тогда вставляем туда, где каретка сейчас.
      const at = (): [number, number] => {
        const el = t.field()
        return el && el.value !== before ? [el.selectionStart, el.selectionEnd] : [start, end]
      }
      return (async () => {
        let paths: string[] = []
        if (kind === 'files') {
          try { paths = await src.clipboard() } catch { /* старая оболочка или чужой буфер */ }
          if (!paths.length) paths = src.files(dropped)
        }
        if (paths.length) { t.put(paths, ...at()); return }
        const next = pasteFallback({ plainText, image: imageInClipboard })
        if (next === 'text') { t.putText?.(plainText, ...at()); return }
        if (next !== 'image') return
        if (!src.image) { t.notice?.(OLD_WINDOW_IMAGE_HINT); return }
        let r: Awaited<ReturnType<NonNullable<typeof src.image>>>
        try { r = await src.image(t.session?.() ?? '') } catch (err) {
          const m = (err as { message?: unknown } | null)?.message
          r = { error: typeof m === 'string' && m ? m : tr('картинка не сохранилась') }
        }
        if ('error' in r) { t.notice?.(r.error); return }
        t.put([r.path], ...at())
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
export const FOLDER_DROP_HINT = tr('Сюда — одну папку. Файлы перетащи в поле «первая реплика»: туда встанут их пути.')

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
