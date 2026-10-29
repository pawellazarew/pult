import { t } from '../lib/i18n.js'
import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, RefObject } from 'react'
import type { AttachmentInput, SavedAttachment } from '../../../shell/src/contract.js'
import type { FilePathSource } from '../model/paths.js'
import { insertText } from '../model/paths.js'
import { hasFiles, pasteKind } from '../model/filePathsInput.js'
import { AttachmentDraftOwner, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, mergeAttachments, readAttachmentDraft, saveAttachmentDraft } from '../model/attachmentDrafts.js'
import type { DraftStore } from '../model/drafts.js'
import { useFilePaths } from './useFilePaths.js'

const store: DraftStore = {
  get: (k) => { try { return window.localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { window.localStorage.setItem(k, v) } catch { /* unavailable */ } },
}
const owners = new Map<string, AttachmentDraftOwner>()
/** Let in-flight imports persist their draft before reloading the application. */
export async function settleAttachmentDrafts(): Promise<void> {
  await Promise.all([...owners.values()].map((owner) => owner.settled()))
}

function ownerFor(session: string, persist: boolean): AttachmentDraftOwner {
  const existing = persist ? owners.get(session) : null
  if (existing) return existing
  const owner = new AttachmentDraftOwner(persist ? readAttachmentDraft(store, session, Date.now()) : [], (items) => {
    if (persist) saveAttachmentDraft(store, session, items, Date.now())
  })
  if (persist) owners.set(session, owner)
  return owner
}
const errorOf = (e: unknown): string => e && typeof e === 'object' && 'message' in e ? String(e.message) : t('Файл не удалось прикрепить. Попробуй ещё раз.')

export function useAttachments({ source, box, text, setText, session, persist = true }: {
  source: FilePathSource | null; box: RefObject<HTMLTextAreaElement | null>; text: string; setText(s: string): void; session: string; persist?: boolean
}) {
  const legacy = useFilePaths({ source: source?.attachments ? null : source, box, text, setText, session })
  const [owner] = useState(() => ownerFor(session, persist))
  const [items, setItems] = useState(owner.items)
  const alive = useRef(true)
  const [pending, setPending] = useState(owner.pending)
  const [notice, setNotice] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [previews, setPreviews] = useState<Record<string, string>>({})
  useEffect(() => {
    alive.current = true
    const update = (): void => { setItems(owner.items); setPending(owner.pending) }
    const off = owner.subscribe(update)
    update()
    return () => { alive.current = false; off() }
  }, [owner])
  const replace = (next: SavedAttachment[]): void => owner.replace(next)
  const restore = (snapshot: readonly SavedAttachment[]): void => replace(mergeAttachments(snapshot, owner.items))
  useEffect(() => {
    const bridge = source?.attachments
    if (!bridge) return
    let cancelled = false
    for (const item of items) {
      if (!item.mime.startsWith('image/') || previews[item.path]) continue
      void bridge.preview(session, item.path).then((r) => {
        if (!cancelled && 'dataUrl' in r) setPreviews((p) => ({ ...p, [item.path]: r.dataUrl }))
      }).catch(() => { /* file card remains useful without thumbnail */ })
    }
    return () => { cancelled = true }
  }, [items, source, session])
  const enqueue = (job: () => Promise<void>): void => {
    setNotice(null)
    owner.enqueue(job, (e) => { if (alive.current) setNotice(errorOf(e)) })
  }
  const save = async (input: AttachmentInput): Promise<void> => {
    const bridge = source?.attachments
    if (!bridge) return
    if (owner.items.length >= MAX_ATTACHMENTS) throw new Error(t`К сообщению можно прикрепить до ${MAX_ATTACHMENTS} файлов. Убери лишние и попробуй снова.`)
    const r = await bridge.import(session, input)
    if ('error' in r) throw new Error(r.error)
    replace(mergeAttachments(owner.items, [r]))
  }
  const addFiles = (files: File[]): void => {
    const bridge = source?.attachments
    if (!bridge) return
    for (const file of files) {
      enqueue(async () => {
        if (owner.items.length >= MAX_ATTACHMENTS) throw new Error(t`К сообщению можно прикрепить до ${MAX_ATTACHMENTS} файлов.`)
        if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(t`${file.name}: файл больше 25 МБ. Выбери файл меньшего размера.`)
        const results = await bridge.files(session, [file])
        for (const r of results) {
          if ('error' in r) throw new Error(r.error)
          replace(mergeAttachments(owner.items, [r]))
        }
      })
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!source?.attachments) { legacy.onPaste(e); return }
    const plain = e.clipboardData.getData('text/plain')
    const kind = pasteKind(e.clipboardData.types, plain)
    if (kind === 'default') return
    e.preventDefault()
    const files = Array.from(e.clipboardData.files)
    const start = e.currentTarget.selectionStart
    const end = e.currentTarget.selectionEnd
    const before = e.currentTarget.value
    enqueue(async () => {
      const board = kind === 'files' ? await source.attachments!.clipboard(session) : []
      if (board.length) {
        for (const r of board) {
          if ('error' in r) { if (alive.current) setNotice(r.error); continue }
          if (owner.items.length < MAX_ATTACHMENTS) replace(mergeAttachments(owner.items, [r]))
          else if (alive.current) setNotice(t`К сообщению можно прикрепить до ${MAX_ATTACHMENTS} файлов.`)
        }
        return
      }
      if (plain) {
        const el = box.current
        const r = insertText(el?.value ?? text, el && el.value !== before ? el.selectionStart : start, el && el.value !== before ? el.selectionEnd : end, plain)
        if (alive.current) setText(r.text)
        return
      }
      // A clipboard File already carries bytes; no disk path and no manually saved screenshot required.
      if (files.length) {
        for (const file of files) {
          try {
            if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(t`${file.name}: файл больше 25 МБ`)
            if (owner.items.length >= MAX_ATTACHMENTS) throw new Error(t`К сообщению можно прикрепить до ${MAX_ATTACHMENTS} файлов.`)
            const results = await source.attachments!.files(session, [file])
            for (const r of results) {
              if ('error' in r) throw new Error(r.error)
              replace(mergeAttachments(owner.items, [r]))
            }
          } catch (err) { if (alive.current) setNotice(errorOf(err)) }
        }
        return
      }
      if (!source.image) throw new Error(t('Для вставки картинки обнови окно: Настройки → Обновления → «Перезапустить и обновить».'))
      const r = await source.image(session)
      if ('error' in r) throw new Error(r.error)
      await save({ path: r.path, name: t('Скриншот.png') })
    })
  }
  const onDragOver = (e: DragEvent<HTMLTextAreaElement>): void => {
    if (!source?.attachments) { legacy.onDragOver(e); return }
    if (hasFiles(e.dataTransfer.types)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true) }
  }
  const onDrop = (e: DragEvent<HTMLTextAreaElement>): void => {
    if (!source?.attachments) { legacy.onDrop(e); return }
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    addFiles(Array.from(e.dataTransfer.files))
  }
  const finalize = async (target: string, snapshot: readonly SavedAttachment[] = owner.items): Promise<SavedAttachment[]> => {
    if (owner.pending) throw new Error(t('Дождись сохранения вложений.'))
    if (!source?.attachments) return [...snapshot]
    const next: SavedAttachment[] = []
    for (const item of snapshot) {
      if (item.kind === 'directory') { next.push(item); continue }
      const r = await source.attachments.import(target, { path: item.path, name: item.name })
      if ('error' in r) throw new Error(r.error)
      next.push(r)
    }
    return next
  }
  return {
    items, previews, pending, notice: notice ?? legacy.notice, over: over || legacy.over,
    enabled: !!source?.attachments, addFiles, finalize,
    isBusy: () => owner.pending > 0,
    clear: () => replace([]), restore, report: (message: string) => setNotice(message),
    remove: (path: string) => replace(owner.items.filter((x) => x.path !== path)),
    onPaste, onDragOver, onDragEnter: onDragOver,
    onDragLeave: () => { setOver(false); legacy.onDragLeave({} as DragEvent<HTMLTextAreaElement>) }, onDrop,
  }
}
