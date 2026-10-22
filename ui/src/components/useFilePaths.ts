// Пути файлов в textarea (⌘V из Finder, перетаскивание) — общий для поля реплики разговора и «первой реплики»
// в «+ Сессия». Логика — model/filePathsInput.ts; здесь только стейт поля, каретка и подсветка при наведении.

import { useState } from 'react'
import type { ClipboardEvent, DragEvent, RefObject } from 'react'
import { pathsInputHandlers } from '../model/filePathsInput.js'
import { insertPaths } from '../model/paths.js'
import type { FilePathSource } from '../model/paths.js'

export function useFilePaths({ source, box, text, setText }: {
  source: FilePathSource | null
  box: RefObject<HTMLTextAreaElement | null>
  /** Текст поля из стейта — на случай, когда самого поля ещё нет. */
  text: string
  setText(next: string): void
}): {
  /** Над полем тащат файлы — подсветить (нужна не всем полям). */
  over: boolean
  onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void
  onDragOver(e: DragEvent<HTMLTextAreaElement>): void
  /** То же, что dragover: при переходе на поле Chromium шлёт dragenter, а dragover — только со следующего движения. */
  onDragEnter(e: DragEvent<HTMLTextAreaElement>): void
  onDragLeave(e: DragEvent<HTMLTextAreaElement>): void
  onDrop(e: DragEvent<HTMLTextAreaElement>): void
} {
  const [over, setOver] = useState(false)
  const h = pathsInputHandlers({
    source,
    field: () => box.current,
    put: (paths, start, end) => {
      // Каретку считаем здесь, от того, что сейчас в поле: функция-обновление setText может
      // выполниться позже кадра, и позиция из неё к setSelectionRange не успела бы.
      const r = insertPaths(box.current?.value ?? text, start, end, paths)
      setText(r.text)
      requestAnimationFrame(() => { const el = box.current; if (el) { el.focus(); el.setSelectionRange(r.caret, r.caret) } })
    },
  })
  const onDragOver = (e: DragEvent<HTMLTextAreaElement>): void => {
    h.onDragOver(e)
    const files = e.isDefaultPrevented()
    if (files !== over) setOver(files)
  }
  return {
    over,
    onPaste: (e) => { void h.onPaste(e) },
    onDragOver,
    onDragEnter: onDragOver,
    onDragLeave: () => setOver(false),
    onDrop: (e) => { setOver(false); h.onDrop(e) },
  }
}
