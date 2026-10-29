import { t } from '../lib/i18n.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { FileEntry, FileListing, FilePreview, PultBridge } from '../../../shell/src/contract.js'
import { Icon } from './common.js'
import { Markdown } from './Markdown.js'
import { ImageContext } from './Images.js'
import { FilePreviewContext } from '../model/filePreviewContext.js'
import { PdfPreview } from './PdfPreview.js'
import { clampSize } from '../model/panelSizes.js'
import { ResizeHandle } from './ResizeHandle.js'
import { usePanelBox, usePanelSize } from './WorkspaceLayout.js'

export interface FileRequest { path: string; sessionId: string; nonce: number }
const nameOf = (p: string): string => p.split('/').filter(Boolean).at(-1) ?? p
const sizeOf = (n: number): string => n < 1024 ? t`${n} Б` : n < 1024 * 1024 ? t`${Math.ceil(n / 1024)} КБ` : t`${(n / 1024 / 1024).toFixed(1)} МБ`

export function FileWorkspace({ bridge, sessionId, cwd, open, expanded, request, onClose, onExpand }: {
  bridge: PultBridge; sessionId: string; cwd: string; open: boolean; expanded: boolean; request: FileRequest | null
  onClose(): void; onExpand(): void
}): ReactElement {
  const layout = useRef<HTMLDivElement>(null)
  const { width: layoutWidth } = usePanelBox(layout, { width: 520, height: 650 })
  const [treeSize, setTreeSize] = usePanelSize('pult.panel.fileTree.v1')
  const treeMin = Math.min(132, layoutWidth * .3)
  const treeMax = Math.max(treeMin, Math.min(420, layoutWidth - 180))
  const treeDefault = expanded ? clampSize(layoutWidth * .22, 174, 260) : layoutWidth < 420 ? 160 : 174
  const treeWidth = clampSize(treeSize ?? treeDefault, treeMin, treeMax)
  const [folders, setFolders] = useState<Record<string, FileListing>>({})
  const [expandedDirs, setExpandedDirs] = useState(new Set(['.']))
  const [dirBusy, setDirBusy] = useState(new Set<string>())
  const [dirError, setDirError] = useState<Record<string, string>>({})
  const [hidden, setHidden] = useState(false)
  const [filter, setFilter] = useState('')
  const [treeShown, setTreeShown] = useState(true)
  const [tabs, setTabs] = useState<Array<{ path: string; name: string }>>([])
  const [file, setFile] = useState<FilePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceView, setSourceView] = useState(false)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const epoch = useRef(0)
  const loadNumber = useRef(0)
  const currentSession = useRef(sessionId)
  const refreshRef = useRef<() => void>(() => {})
  const loadedSession = useRef<string | null>(null)
  const handledRequest = useRef('')
  const allLines = (file?.text ?? '').split('\n')
  const viewText = allLines.slice(0, 5000).join('\n').slice(0, 200_000)
  const textClipped = !!file?.text && viewText.length < file.text.length
  const root = folders['.']?.root ?? cwd

  const loadDir = useCallback(async (dir: string): Promise<FileListing | null> => {
    if (!bridge.listFiles) return null
    const stamp = epoch.current
    setDirBusy((s) => new Set(s).add(dir))
    try {
      const listing = await bridge.listFiles(sessionId, dir, hidden)
      if (stamp !== epoch.current || currentSession.current !== sessionId) return null
      setFolders((s) => ({ ...s, [dir]: listing }))
      setDirError((s) => { const next = { ...s }; delete next[dir]; return next })
      return listing
    } catch {
      if (stamp === epoch.current) setDirError((s) => ({ ...s, [dir]: t('Не удалось прочитать папку') }))
      return null
    } finally {
      if (stamp === epoch.current) setDirBusy((s) => { const next = new Set(s); next.delete(dir); return next })
    }
  }, [bridge, sessionId, hidden])

  const openFile = useCallback(async (path: string, background = false): Promise<void> => {
    if (!bridge.previewFile) return
    const id = ++loadNumber.current
    const stamp = epoch.current
    if (!background) { setLoading(true); setError(null); setFile(null); setActionNote(null) }
    try {
      const preview = await bridge.previewFile(sessionId, path)
      if (id !== loadNumber.current || stamp !== epoch.current || currentSession.current !== sessionId) return
      setFile(preview); setError(null); if (!background) setSourceView(false)
      setTabs((s) => s.some((tab) => tab.path === preview.path) ? s : [...s.slice(-7), { path: preview.path, name: preview.name }])
    } catch {
      if (id === loadNumber.current && stamp === epoch.current) { setError(t('Не удалось открыть файл. Он мог быть перемещён или доступ к нему закрыт.')); setFile(null) }
    } finally { if (id === loadNumber.current && stamp === epoch.current) setLoading(false) }
  }, [bridge, sessionId])

  useEffect(() => {
    ++epoch.current; ++loadNumber.current; currentSession.current = sessionId; loadedSession.current = null
    setFolders({}); setExpandedDirs(new Set(['.'])); setDirBusy(new Set()); setDirError({})
    setTabs([]); setFile(null); setError(null); setLoading(false); setTreeShown(true); setFilter(''); setSourceView(false); setActionNote(null)
  }, [sessionId])
  useEffect(() => {
    if (!open || loadedSession.current === sessionId) return
    loadedSession.current = sessionId
    void loadDir('.')
  }, [open, sessionId, loadDir])
  useEffect(() => {
    if (!open || !request || request.sessionId !== sessionId || handledRequest.current === `${sessionId}:${request.nonce}`) return
    handledRequest.current = `${sessionId}:${request.nonce}`
    if (!request.path) {
      setTreeShown(true)
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="file-filter"]')?.focus())
      return
    }
    setTreeShown(false)
    void openFile(request.path)
  }, [open, request?.nonce, sessionId, openFile])
  useEffect(() => {
    if (!open) return
    refreshRef.current = () => {
      const selected = file
      const dirs = [...expandedDirs].slice(0, 12)
      void Promise.all(dirs.map((dir) => loadDir(dir))).then((results) => {
        if (!selected) return
        const entry = results.flatMap((x) => x?.entries ?? []).find((e) => `${root}/${e.path}` === selected.path)
        if (entry && (entry.modifiedAt !== selected.modifiedAt || entry.size !== selected.size)) void openFile(selected.path, true)
      })
    }
  }, [open, expandedDirs, loadDir, file, root, openFile])
  useEffect(() => {
    if (!open) return
    const refresh = (): void => { if (!document.hidden) refreshRef.current() }
    const timer = window.setInterval(refresh, 4000)
    window.addEventListener('focus', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [open, sessionId])

  const toggleDir = (entry: FileEntry): void => {
    const next = new Set(expandedDirs)
    if (next.has(entry.path)) next.delete(entry.path)
    else { next.add(entry.path); if (!folders[entry.path]) void loadDir(entry.path) }
    setExpandedDirs(next)
  }
  const renderFolder = (dir: string, depth = 0): ReactElement => {
    const listing = folders[dir]
    const entries = (listing?.entries ?? []).filter((entry) => !filter || entry.kind === 'directory' || entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
    return <ul className="file-tree-list">
      {entries.map((entry) => <li key={entry.path}>
        <button type="button" className={`file-tree-row${file?.path === `${root}/${entry.path}` ? ' selected' : ''}`} title={entry.path}
          data-testid="workspace-file" data-path={entry.path} aria-expanded={entry.kind === 'directory' ? expandedDirs.has(entry.path) : undefined}
          onClick={() => entry.kind === 'directory' ? toggleDir(entry) : void openFile(`${root}/${entry.path}`)}>
          <Icon name={entry.kind === 'directory' ? expandedDirs.has(entry.path) ? 'folder-open' : 'folder' : 'file'} />
          <span>{entry.name}</span>
        </button>
        {entry.kind === 'directory' && expandedDirs.has(entry.path) && depth < 24 && renderFolder(entry.path, depth + 1)}
      </li>)}
      {dirBusy.has(dir) && !listing && <li className="file-tree-note">{t("Загружаю…")}</li>}
      {dirError[dir] && <li className="file-tree-note t-fail">{dirError[dir]} <button type="button" className="btn btn-sm" onClick={() => void loadDir(dir)}>{t("Повторить")}</button></li>}
      {listing && !listing.entries.length && <li className="file-tree-note">{t("Папка пуста")}</li>}
      {listing?.truncated && <li className="file-tree-note">{t("Показана часть файлов этой папки")}</li>}
    </ul>
  }
  const external = async (): Promise<void> => {
    if (!file) return
    try { const result = await bridge.openFile?.(file.path); setActionNote(result === 'revealed' ? t('Файл показан в Finder') : null) }
    catch { setActionNote(t('Не удалось открыть файл системным приложением')) }
  }
  const closeTab = (path: string): void => {
    const rest = tabs.filter((tab) => tab.path !== path)
    setTabs(rest)
    if (file?.path === path) { ++loadNumber.current; setLoading(false); setError(null); if (rest.length) void openFile(rest.at(-1)!.path); else setFile(null) }
  }

  return <section className={`files-pane${expanded ? ' expanded' : ''}`} hidden={!open} aria-label={t("Файлы проекта")} data-testid="file-workspace"
    onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation() }
    }}>
    <header className="files-head">
      <button type="button" className="btn btn-ghost btn-sm" aria-pressed={treeShown} onClick={() => setTreeShown((v) => !v)} title={t("Список файлов")} data-testid="files-toggle-tree"><Icon name="sidebar" /></button>
      <strong>{t("Файлы ")}<span title={cwd}>{nameOf(cwd)}</span></strong>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { refreshRef.current(); if (file) void openFile(file.path, true) }} title={t("Обновить файлы")} aria-label={t("Обновить файлы")} data-testid="files-refresh"><Icon name="refresh" /></button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onExpand} title={expanded ? t('Показать рядом с чатом') : t('Развернуть просмотр')} aria-label={expanded ? t('Показать рядом с чатом') : t('Развернуть просмотр')} data-testid="files-expand"><Icon name={expanded ? 'collapse' : 'expand'} /></button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} title={t("Вернуться к чату (Esc)")} aria-label={t("Закрыть просмотр файлов")} data-testid="files-close"><Icon name="x" /></button>
    </header>
    <div className="files-layout resizable-file-layout" ref={layout} style={{ '--file-tree-size': `${treeWidth}px` } as CSSProperties}>
      {treeShown && <aside className="file-tree" aria-label={t("Файлы проекта на диске")} data-testid="file-tree">
        <label className="file-filter"><Icon name="search" /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("Фильтр папки")} aria-label={t("Фильтр имён в открытых папках")} data-testid="file-filter" /></label>
        <label className="file-hidden"><input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); setFolders({}); setExpandedDirs(new Set(['.'])); loadedSession.current = null }} />{t("Скрытые файлы")}</label>
        <div className="file-tree-scroll">{renderFolder('.')}</div>
      </aside>}
      {treeShown && <ResizeHandle label={t("Ширина дерева файлов")} value={treeWidth} min={treeMin} max={treeMax} onChange={setTreeSize}
        onReset={() => setTreeSize(null)} testId="file-tree-resize" className="file-tree-boundary" />}
      <div className="file-document">
        {tabs.length > 0 && <div className="file-tabs" role="tablist" aria-label={t("Открытые файлы")} onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
          e.preventDefault()
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')]
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
          buttons[next]?.focus(); buttons[next]?.click()
        }}>
          {tabs.map((tab) => <span key={tab.path} className={`file-tab${file?.path === tab.path ? ' active' : ''}`}>
            <button type="button" role="tab" aria-selected={file?.path === tab.path} title={tab.path} onClick={() => void openFile(tab.path)}>{tab.name}</button>
            <button type="button" aria-label={t`Закрыть файл ${tab.name}`} onClick={() => closeTab(tab.path)}><Icon name="x" /></button>
          </span>)}
        </div>}
        {file && <div className="file-toolbar">
          <span className="file-location" title={file.path}>{file.path.startsWith(`${root}/`) ? file.path.slice(root.length + 1) : file.path}</span>
          <span className="file-size">{sizeOf(file.size)}</span>
          {file.kind === 'markdown' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSourceView((v) => !v)} data-testid="file-source-toggle">{sourceView ? t('Просмотр') : t('Исходник')}</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void bridge.copyText(file.path).then(() => setActionNote(t('Путь скопирован')), () => setActionNote(t('Не удалось скопировать путь')))} title={t("Скопировать путь")} aria-label={t("Скопировать путь")}><Icon name="copy" /></button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void bridge.revealPath(file.path)} title={t("Показать в Finder")} aria-label={t("Показать файл в Finder")}><Icon name="folder" /></button>
          {bridge.openFile && <button type="button" className="btn btn-sm" onClick={() => void external()} data-testid="file-open-external">{t("Открыть вне Пульта")}</button>}
        </div>}
        {actionNote && <div className="file-action-note" role="status">{actionNote}</div>}
        <div className="file-content" data-testid="file-content">
          {loading ? <div className="file-placeholder" role="status">{t("Открываю файл…")}</div>
            : error ? <div className="file-placeholder" role="alert">{error}</div>
            : !file ? <div className="file-placeholder"><Icon name="file" /><h3>{t("Файлы рядом с разговором")}</h3><p>{t("Выбери файл в дереве проекта или нажми на файловую ссылку в ответе агента.")}</p></div>
            : file.kind === 'pdf' && file.base64 ? <PdfPreview key={file.path} base64={file.base64} name={file.name} />
            : file.kind === 'image' && file.dataUrl ? <div className="file-image"><img src={file.dataUrl} alt={file.name} data-testid="file-image" /></div>
            : file.kind === 'unsupported' ? <div className="file-placeholder"><Icon name="file" /><h3>{file.name}</h3><p>{file.reason ?? t('Для этого формата пока нет встроенного просмотра.')}</p><p>{t("Можно открыть файл вне Пульта.")}</p></div>
            : <>
              {(file.truncated || textClipped) && <div className="file-clipped" role="status">{t("Показана начальная часть большого файла")}</div>}
              {file.kind === 'markdown' && !sourceView ? <div className="file-markdown" data-testid="file-markdown">
                <FilePreviewContext.Provider value={{ open: (source) => void openFile(source), basePath: file.path.slice(0, file.path.lastIndexOf('/')) }}>
                  <ImageContext.Provider value={{ sessionId, bridge: { ...bridge,
                    readImage: bridge.readImage ? (session, source) => bridge.readImage!(session, source.startsWith('/') ? source : `${file.path.slice(0, file.path.lastIndexOf('/'))}/${source}`) : undefined,
                    saveImage: bridge.saveImage ? (session, source) => bridge.saveImage!(session, source.startsWith('/') ? source : `${file.path.slice(0, file.path.lastIndexOf('/'))}/${source}`) : undefined,
                    openImage: bridge.openImage ? (session, source) => bridge.openImage!(session, source.startsWith('/') ? source : `${file.path.slice(0, file.path.lastIndexOf('/'))}/${source}`) : undefined,
                  } }}><Markdown text={viewText} /></ImageContext.Provider>
                </FilePreviewContext.Provider>
              </div> : <pre className="file-code" data-testid="file-source"><code>{viewText.split('\n').map((line, i) => <span className="file-code-line" key={i}><span className="file-line-number" aria-hidden="true">{i + 1}</span><span>{line || ' '}</span>{'\n'}</span>)}</code></pre>}
            </>}
        </div>
      </div>
    </div>
  </section>
}
