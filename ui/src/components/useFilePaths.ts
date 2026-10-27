// Пути файлов в textarea (⌘V из Finder, перетаскивание, картинка из буфера) — общий для поля реплики разговора и
// «первой реплики» в «+ Сессия». Логика — model/filePathsInput.ts; здесь только стейт поля, каретка, подсветка при
// наведении и заметка под полем (отказ сохранить картинку, старое окно).

import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, RefObject } from 'react'
import { pathsInputHandlers } from '../model/filePathsInput.js'
import { insertPaths, insertText } from '../model/paths.js'
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
  /** Заметка под полем: картинка не сохранилась, окно старое. Гаснет сама через 10 с и на следующей вставке. */
  notice: string | null
  onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void
  onDragOver(e: DragEvent<HTMLTextAreaElement>): void
  /** То же, что dragover: при переходе на поле Chromium шлёт dragenter, а dragover — только со следующего движения. */
  onDragEnter(e: DragEvent<HTMLTextAreaElement>): void
  onDragLeave(e: DragEvent<HTMLTextAreaElement>): void
  onDrop(e: DragEvent<HTMLTextAreaElement>): void
} {
  const [over, setOver] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current) }, [])
  const say = (msg: string | null): void => {
    if (noticeTimer.current !== null) { window.clearTimeout(noticeTimer.current); noticeTimer.current = null }
    setNotice(msg)
    if (msg) noticeTimer.current = window.setTimeout(() => { noticeTimer.current = null; setNotice(null) }, 10_000)
  }
  const apply = (r: { text: string; caret: number }): void => {
    setText(r.text)
    requestAnimationFrame(() => { const el = box.current; if (el) { el.focus(); el.setSelectionRange(r.caret, r.caret) } })
  }
  const h = pathsInputHandlers({
    source,
    field: () => box.current,
    // Каретку считаем здесь, от того, что сейчас в поле: функция-обновление setText может
    // выполниться позже кадра, и позиция из неё к setSelectionRange не успела бы.
    put: (paths, start, end) => apply(insertPaths(box.current?.value ?? text, start, end, paths)),
    putText: (ins, start, end) => apply(insertText(box.current?.value ?? text, start, end, ins)),
    notice: (msg) => say(msg),
  })
  const onDragOver = (e: DragEvent<HTMLTextAreaElement>): void => {
    h.onDragOver(e)
    const files = e.isDefaultPrevented()
    if (files !== over) setOver(files)
  }
  return {
    over,
    notice,
    onPaste: (e) => { if (notice) say(null); void h.onPaste(e) },
    onDragOver,
    onDragEnter: onDragOver,
    onDragLeave: () => setOver(false),
    onDrop: (e) => { setOver(false); h.onDrop(e) },
  }
}
