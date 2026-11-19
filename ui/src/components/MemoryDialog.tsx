import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PultBridge } from '../../../shell/src/contract.js'
import { errorText, isBridgeError } from '../bridge.js'
import { getLanguage, t } from '../lib/i18n.js'
import { appendMemoryPage, MEMORY_PAGE_SIZE, memoryDirty, memoryDraft, memoryDraftError, memoryMutation, memoryProjectLabel, memorySelector } from '../model/memory.js'
import type { MemoryDraft, MemoryMutation, MemoryProject, MemoryRecord, MemorySummary } from '../model/memory.js'
import { Dialog } from './Panels.js'
import { Icon } from './common.js'
import './memory.css'

interface Editor { mode: 'new' | 'edit' | 'forget'; base: MemoryRecord | null; draft: MemoryDraft }
interface Pending { request: MemoryMutation; state: 'sending' | 'unknown'; error: string | null }
interface Guard { run(): void; discard: boolean }

export interface MemoryDialogProps {
  bridge: Pick<PultBridge, 'call'>
  active?: boolean
  available: boolean
  availabilityError?: string | null
  initialSession?: string
  online: boolean
  onClose(): void
}

function MemoryMetadata({ record }: { record: MemoryRecord }): ReactElement {
  const at = (value: string): string => new Date(value).toLocaleString(getLanguage() === 'ru' ? 'ru-RU' : 'en-GB')
  return <dl className="memory-metadata">
    <div><dt>{t('Автор')}</dt><dd>{record.author}</dd></div>
    <div><dt>{t('Версия')}</dt><dd>{record.version}</dd></div>
    <div><dt>{t('Обновлено')}</dt><dd>{at(record.updatedAt)}</dd></div>
    <div><dt>{t('Причина изменения')}</dt><dd>{record.reason}</dd></div>
    {record.sourceSession && <div><dt>{t('Исходный чат')}</dt><dd>{record.sourceSession}</dd></div>}
    {record.sourceEventId !== undefined && <div><dt>{t('Исходное событие')}</dt><dd>{record.sourceEventId}</dd></div>}
    {record.sourceTurnId && <div><dt>{t('Исходный ход')}</dt><dd>{record.sourceTurnId}</dd></div>}
    {record.sourceCreatedAt && <div><dt>{t('Создание исходного чата')}</dt><dd>{at(record.sourceCreatedAt)}</dd></div>}
    <div><dt>ID</dt><dd className="mono">{record.id}</dd></div>
  </dl>
}

export function MemoryDialog({ bridge, active = true, available, availabilityError = null, initialSession, online, onClose }: MemoryDialogProps): ReactElement | null {
  const host = useRef<HTMLDivElement>(null)
  const [scope, setScope] = useState(() => initialSession ? `session:${initialSession}` : 'global')
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [projects, setProjects] = useState<MemoryProject[]>([])
  const [projectMore, setProjectMore] = useState(false)
  const [projectOffset, setProjectOffset] = useState(0)
  const [projectLoading, setProjectLoading] = useState(false)
  const [items, setItems] = useState<MemorySummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [record, setRecord] = useState<MemoryRecord | null>(null)
  const [reading, setReading] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [history, setHistory] = useState<MemoryRecord[]>([])
  const [historyOffset, setHistoryOffset] = useState(0)
  const [historyMore, setHistoryMore] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [conflict, setConflict] = useState<MemoryRecord | null>(null)
  const [guard, setGuard] = useState<Guard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const listGeneration = useRef(0)
  const projectGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const mutationLock = useRef(false)
  const historyLock = useRef(false)
  const canRead = active && available && online
  const dirty = editor !== null && memoryDirty(editor.draft, editor.base)
  const formError = editor ? memoryDraftError(editor.draft) : null
  const blocked = !canRead || pending !== null

  const resetDetail = (): void => {
    detailGeneration.current++
    historyLock.current = false
    setSelected(null); setRecord(null); setReading(false); setEditor(null); setConflict(null)
    setHistory([]); setHistoryOffset(0); setHistoryMore(false); setHistoryLoading(false); setHistoryLoaded(false)
  }
  const requestAction = (run: () => void, discard = true): void => {
    if (pending && discard) { setError(t('Сначала проверь результат предыдущего сохранения.')); return }
    if (dirty || pending) { setGuard({ run, discard }); return }
    run()
  }
  const close = (): void => {
    if (guard) { setGuard(null); return }
    requestAction(onClose, false)
  }
  const closeRef = useRef(close); closeRef.current = close
  const saveRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    if (!active) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = host.current?.querySelector<HTMLElement>('[role="dialog"]')
    const area = (): HTMLElement | null | undefined => dialog?.querySelector<HTMLElement>('[data-testid="memory-discard"]') ?? dialog
    const focusable = (): HTMLElement[] => [...(area()?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(element => element.checkVisibility())
    const focus = (): void => { (area()?.querySelector<HTMLElement>('[data-memory-autofocus]') ?? focusable()[0])?.focus() }
    focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); return }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); saveRef.current(); return }
      if (event.key !== 'Tab') return
      const elements = focusable(), first = elements[0], last = elements[elements.length - 1]
      if (!first || !last) { event.preventDefault(); return }
      if (!area()?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus()
      }
    }
    const keepFocus = (event: FocusEvent): void => { if (event.target instanceof Node && !area()?.contains(event.target)) focus() }
    window.addEventListener('keydown', key, true)
    document.addEventListener('focusin', keepFocus)
    return () => {
      window.removeEventListener('keydown', key, true)
      document.removeEventListener('focusin', keepFocus)
      requestAnimationFrame(() => {
        const visible = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(element => element.checkVisibility())
        if (previous?.isConnected && previous.checkVisibility() && (!visible || visible.contains(previous))) previous.focus()
      })
    }
  }, [active])
  useLayoutEffect(() => {
    if (!active || !guard) return
    const previous = document.activeElement as HTMLElement | null
    host.current?.querySelector<HTMLButtonElement>('[data-testid="memory-discard"] button')?.focus()
    return () => { if (previous?.isConnected && previous.checkVisibility()) previous.focus() }
  }, [active, guard])

  useEffect(() => {
    const generation = ++projectGeneration.current
    if (!canRead) { setProjectLoading(false); return }
    setProjectLoading(true)
    void bridge.call('memory.projects', { limit: MEMORY_PAGE_SIZE, offset: 0 }).then(value => {
      if (generation !== projectGeneration.current) return
      const page = value as { projects: MemoryProject[]; hasMore: boolean }
      setProjects(page.projects); setProjectOffset(page.projects.length); setProjectMore(page.hasMore)
    }).catch(cause => { if (generation === projectGeneration.current) setError(errorText(cause)) })
      .finally(() => { if (generation === projectGeneration.current) setProjectLoading(false) })
    return () => { projectGeneration.current++ }
  }, [bridge, canRead, revision])

  useEffect(() => {
    const generation = ++listGeneration.current
    if (!canRead) { setLoading(false); return }
    setLoading(true); setError(null)
    const timer = window.setTimeout(() => {
      const selector = memorySelector(scope)
      const params = { ...selector, limit: MEMORY_PAGE_SIZE, offset: 0 }
      void bridge.call(query.trim() ? 'memory.search' : 'memory.list', query.trim() ? { ...params, query } : params).then(value => {
        if (generation !== listGeneration.current) return
        const page = value as { memories: MemorySummary[]; hasMore: boolean }
        setItems(page.memories); setOffset(page.memories.length); setHasMore(page.hasMore)
      }).catch(cause => { if (generation === listGeneration.current) setError(errorText(cause)) })
        .finally(() => { if (generation === listGeneration.current) setLoading(false) })
    }, query ? 180 : 0)
    return () => { window.clearTimeout(timer); listGeneration.current++ }
  }, [bridge, canRead, scope, query, revision])
  const moreProjects = async (): Promise<void> => {
    if (!canRead || projectLoading || !projectMore) return
    const generation = projectGeneration.current
    setProjectLoading(true)
    try {
      const page = await bridge.call('memory.projects', { limit: MEMORY_PAGE_SIZE, offset: projectOffset }) as { projects: MemoryProject[]; hasMore: boolean }
      if (generation !== projectGeneration.current) return
      setProjects(before => appendMemoryPage(before, page.projects, item => item.projectId))
      setProjectOffset(projectOffset + page.projects.length); setProjectMore(page.hasMore)
    } catch (cause) { if (generation === projectGeneration.current) setError(errorText(cause)) }
    finally { if (generation === projectGeneration.current) setProjectLoading(false) }
  }
  const moreItems = async (): Promise<void> => {
    if (!canRead || loading || !hasMore) return
    const generation = listGeneration.current
    setLoading(true)
    try {
      const params = { ...memorySelector(scope), limit: MEMORY_PAGE_SIZE, offset }
      const page = await bridge.call(query.trim() ? 'memory.search' : 'memory.list', query.trim() ? { ...params, query } : params) as { memories: MemorySummary[]; hasMore: boolean }
      if (generation !== listGeneration.current) return
      setItems(before => appendMemoryPage(before, page.memories, item => item.id))
      setOffset(offset + page.memories.length); setHasMore(page.hasMore)
    } catch (cause) { if (generation === listGeneration.current) setError(errorText(cause)) }
    finally { if (generation === listGeneration.current) setLoading(false) }
  }
  const readRecord = async (id: string): Promise<void> => {
    const generation = ++detailGeneration.current
    historyLock.current = false
    setHistoryLoading(false)
    setSelected(id); setRecord(null); setReading(true); setError(null); setEditor(null); setConflict(null)
    setHistory([]); setHistoryLoaded(false); setHistoryMore(false); setHistoryOffset(0)
    try {
      const value = await bridge.call('memory.get', { ...memorySelector(scope), id }) as MemoryRecord
      if (generation === detailGeneration.current) setRecord(value)
    } catch (cause) { if (generation === detailGeneration.current) setError(errorText(cause)) }
    finally { if (generation === detailGeneration.current) setReading(false) }
  }
  const loadHistory = async (more = false): Promise<void> => {
    if (!record || !canRead || historyLock.current) return
    const generation = detailGeneration.current
    historyLock.current = true; setHistoryLoading(true)
    try {
      const page = await bridge.call('memory.history', { ...memorySelector(scope), id: record.id, limit: MEMORY_PAGE_SIZE, offset: more ? historyOffset : 0 }) as { versions: MemoryRecord[]; hasMore: boolean }
      if (generation !== detailGeneration.current) return
      setHistory(before => more ? appendMemoryPage(before, page.versions, item => item.version) : page.versions)
      setHistoryOffset((more ? historyOffset : 0) + page.versions.length); setHistoryMore(page.hasMore); setHistoryLoaded(true)
    } catch (cause) { if (generation === detailGeneration.current) setError(errorText(cause)) }
    finally { if (generation === detailGeneration.current) { historyLock.current = false; setHistoryLoading(false) } }
  }

  const mutate = async (request: MemoryMutation): Promise<void> => {
    if (!canRead || mutationLock.current) return
    mutationLock.current = true
    const generation = detailGeneration.current
    setPending({ request, state: 'sending', error: null }); setError(null); setNotice(null)
    try {
      const result = await bridge.call(request.method, request.params) as MemoryRecord
      // The write is committed even if a later list refresh fails.
      detailGeneration.current++
      historyLock.current = false
      setHistoryLoading(false)
      setPending(null); setEditor(null); setConflict(null); setSelected(result.id); setRecord(result)
      setHistory([]); setHistoryLoaded(false); setHistoryMore(false); setHistoryOffset(0)
      setNotice(result.deleted ? t('Запись удалена из памяти. История версий сохранена.') : t('Запись сохранена.'))
      setRevision(value => value + 1)
    } catch (cause) {
      const code = isBridgeError(cause) ? cause.code : null
      if (code === 'conflict') {
        setPending(null)
        setError(t('Запись уже изменилась. Твой текст сохранён. Сравни его с актуальной версией.'))
        if ('id' in request.params) {
          try {
            const latest = await bridge.call('memory.get', { ...memorySelector(scope), id: request.params.id }) as MemoryRecord
            if (generation === detailGeneration.current) setConflict(latest)
          } catch (readError) { if (generation === detailGeneration.current) setError(errorText(readError)) }
        }
      } else if (code && ['invalid_params', 'not_found', 'command_conflict', 'method_not_allowed', 'denied'].includes(code)) {
        setPending(null); setError(errorText(cause))
      } else {
        setPending({ request, state: 'unknown', error: errorText(cause) })
      }
    } finally { mutationLock.current = false }
  }
  const save = (): void => {
    if (!editor || blocked || formError || guard || conflict) return
    const request = memoryMutation(editor.mode === 'forget' ? 'forget' : 'save', memorySelector(scope), editor.base, editor.draft, crypto.randomUUID())
    void mutate(request)
  }
  saveRef.current = save
  const edit = (mode: 'edit' | 'forget'): void => {
    if (!record || record.deleted) return
    requestAction(() => { setEditor({ mode, base: record, draft: memoryDraft(record) }); setConflict(null); setNotice(null) })
  }
  const patch = (change: Partial<MemoryDraft>): void => setEditor(before => before ? { ...before, draft: { ...before.draft, ...change } } : before)

  if (!active) return null
  const currentScope = initialSession ? `session:${initialSession}` : null
  const selectedProject = scope.startsWith('project:') ? scope.slice(8) : null
  return <div className="memory-dialog-host" ref={host}>
    <Dialog title={t('Общая память')} size="wide" testId="memory-dialog" onClose={close} footer={<>
      {editor && <span className="mut memory-save-hint">{t('Cmd/Ctrl+Enter — сохранить')}</span>}
      <span className="grow" />
      <button type="button" className="btn" data-testid="memory-close" onClick={close}>{t('Закрыть')}</button>
    </>}>
      {!available || !online ? <div className="memory-unavailable" role="status" data-testid="memory-unavailable"><Icon name="info" /><p>{availabilityError || t('Для работы с памятью подключись к демону.')}</p></div> : <>
        <div className="memory-toolbar">
          <label className="field"><span className="lbl">{t('Область памяти')}</span><select value={scope} disabled={pending !== null} data-testid="memory-scope" onChange={event => {
            const next = event.target.value
            requestAction(() => { resetDetail(); setScope(next); setQuery(''); setItems([]); setNotice(null) })
          }}>
            <option value="global">{t('Общая для всех проектов')}</option>
            {currentScope && <option value={currentScope}>{t`Проект чата ${initialSession ?? ''}`}</option>}
            {scope.startsWith('session:') && scope !== currentScope && <option value={scope}>{t`Проект чата ${scope.slice(8)}`}</option>}
            {projects.map(project => <option key={project.projectId} value={`project:${project.projectId}`} title={project.projectId}>{memoryProjectLabel(project.projectId)} · {project.count}</option>)}
            {selectedProject && !projects.some(project => project.projectId === selectedProject) && <option value={scope}>{memoryProjectLabel(selectedProject)}</option>}
          </select></label>
          <label className="field memory-search"><span className="lbl">{t('Поиск в памяти')}</span><input type="search" data-memory-autofocus data-testid="memory-search" value={query} disabled={pending !== null} onChange={event => setQuery([...event.target.value].slice(0, 500).join(''))} placeholder={t('Найти запись')} /></label>
          <button type="button" className="btn btn-ghost" title={t('Обновить список')} aria-label={t('Обновить список')} disabled={loading || pending !== null} data-testid="memory-refresh" onClick={() => setRevision(value => value + 1)}><Icon name="refresh" /></button>
          <button type="button" className="btn btn-primary" disabled={pending !== null} data-testid="memory-new" onClick={() => requestAction(() => {
            resetDetail(); setEditor({ mode: 'new', base: null, draft: memoryDraft(null) }); setNotice(null)
          })}><Icon name="plus" />{t('Новая запись')}</button>
        </div>
        {projectMore && <button type="button" className="btn btn-ghost btn-sm memory-more-projects" disabled={projectLoading || pending !== null} onClick={() => void moreProjects()}>{projectLoading ? t('Загружаю…') : t('Ещё проекты')}</button>}
        {error && <p className="memory-notice err" role="alert" data-testid="memory-error">{error}</p>}
        {notice && <p className="memory-notice" role="status" data-testid="memory-notice">{notice}</p>}
        {pending?.state === 'unknown' && <div className="memory-notice" role="alert" data-testid="memory-pending">
          <p>{t('Результат сохранения неизвестен. Повтори тот же запрос, чтобы проверить результат без дубликата.')}</p>
          <p className="mut">{pending.error}</p><button type="button" className="btn" data-testid="memory-pending-retry" disabled={!canRead} onClick={() => void mutate(pending.request)}>{t('Проверить результат')}</button>
        </div>}
        <div className="memory-grid">
          <section className="memory-list" aria-label={t('Записи памяти')} aria-busy={loading} data-testid="memory-list">
            {loading && !items.length && <p className="mut">{t('Загружаю память…')}</p>}
            {!loading && !items.length && <p className="mut">{query ? t('Записей не найдено.') : t('В этой области пока нет записей.')}</p>}
            {items.map(item => <button type="button" key={item.id} className="memory-row" disabled={pending !== null} aria-pressed={selected === item.id} data-testid="memory-row" data-memory-id={item.id} onClick={() => requestAction(() => { void readRecord(item.id) })}>
              <span className="memory-row-heading"><strong>{item.name}</strong>{item.pinned && <span title={t('Закреплено')} aria-label={t('Закреплено')}>●</span>}</span>
              <span className="memory-row-summary">{item.summary}</span><span className="mut">{item.author} · {t`версия ${item.version}`}</span>
            </button>)}
            {hasMore && <button type="button" className="btn memory-more" disabled={loading || pending !== null} data-testid="memory-more" onClick={() => void moreItems()}>{loading ? t('Загружаю…') : t('Ещё записи')}</button>}
          </section>
          <section className="memory-detail" aria-label={t('Содержимое записи')} aria-busy={reading} data-testid="memory-detail">
            {reading ? <p className="mut">{t('Загружаю запись…')}</p> : editor ? <div className="memory-editor" data-testid="memory-editor">
              <h3>{editor.mode === 'new' ? t('Новая запись') : editor.mode === 'forget' ? t('Удалить запись?') : t('Редактирование записи')}</h3>
              {editor.base && <p className="mut">{t`Редактируется версия ${editor.base.version}`}</p>}
              {editor.mode === 'forget' ? <><strong>{editor.base?.name}</strong><p>{t('Запись исчезнет из поиска и контекста новых ходов. История версий сохранится.')}</p></> : <>
                <label className="field"><span className="lbl">{t('Название')}</span><input value={editor.draft.name} disabled={blocked} data-testid="memory-name" onChange={event => patch({ name: event.target.value })} /></label>
                <label className="field"><span className="lbl">{t('Краткое описание')}</span><textarea rows={3} value={editor.draft.summary} disabled={blocked} data-testid="memory-summary" onChange={event => patch({ summary: event.target.value })} /></label>
                <label className="field"><span className="lbl">{t('Подробности')}</span><textarea rows={8} value={editor.draft.details} disabled={blocked} data-testid="memory-details" onChange={event => patch({ details: event.target.value })} /></label>
                <label className="check"><input type="checkbox" checked={editor.draft.pinned} disabled={blocked} data-testid="memory-pinned" onChange={event => patch({ pinned: event.target.checked })} /><span>{t('Закрепить запись')}</span></label>
              </>}
              <label className="field"><span className="lbl">{t('Причина изменения')}</span><textarea rows={2} value={editor.draft.reason} disabled={blocked} data-testid="memory-reason" onChange={event => patch({ reason: event.target.value })} /></label>
              {formError && dirty && <p className="note" data-testid="memory-validation">{formError}</p>}
              {conflict && <div className="memory-conflict" data-testid="memory-conflict">
                <h4>{t`Актуальная версия ${conflict.version}`}</h4><strong>{conflict.name}</strong><p>{conflict.summary}</p><pre>{conflict.details}</pre>
                {conflict.deleted ? <p>{t('Другой участник уже удалил эту запись.')}</p> : <button type="button" className="btn" data-testid="memory-conflict-continue" onClick={() => {
                  detailGeneration.current++; historyLock.current = false
                  setHistory([]); setHistoryLoaded(false); setHistoryLoading(false); setHistoryMore(false); setHistoryOffset(0)
                  setEditor(before => before ? { ...before, base: conflict } : before); setRecord(conflict); setConflict(null); setError(null)
                }}>{t`Продолжить с версией ${conflict.version}`}</button>}
              </div>}
              <div className="memory-editor-actions"><button type="button" className={`btn ${editor.mode === 'forget' ? 'btn-danger' : 'btn-primary'}`} disabled={blocked || formError !== null || conflict !== null} data-testid="memory-save" onClick={save}>{pending?.state === 'sending' ? t('Сохраняю…') : editor.mode === 'forget' ? t('Удалить запись') : t('Сохранить запись')}</button>
                <button type="button" className="btn btn-ghost" disabled={pending !== null} onClick={() => requestAction(() => { setEditor(null); setConflict(null) })}>{t('Отмена')}</button></div>
            </div> : record ? <>
              <div className="memory-detail-heading"><h3>{record.name}</h3>{!record.deleted && <div className="memory-record-actions"><button type="button" className="btn btn-sm" disabled={blocked} data-testid="memory-edit" onClick={() => edit('edit')}>{t('Редактировать')}</button><button type="button" className="btn btn-ghost btn-sm" disabled={blocked} data-testid="memory-forget" onClick={() => edit('forget')}>{t('Удалить')}</button></div>}</div>
              {record.pinned && <p className="memory-pin">{t('Закреплено')}</p>}
              {record.deleted && <p className="mut">{t('Запись удалена. Доступна история версий.')}</p>}
              <p className="memory-summary">{record.summary}</p><pre className="memory-text">{record.details}</pre>
              <MemoryMetadata record={record} />
              <details className="memory-history" key={record.id + ':' + record.version} data-testid="memory-history" onToggle={event => { if (event.currentTarget.open && !historyLoaded) void loadHistory() }}><summary>{t('История версий')}</summary>
                {historyLoading && !history.length && <p className="mut">{t('Загружаю историю…')}</p>}
                {history.map(version => <details key={version.version} data-testid="memory-history-version"><summary>{t`Версия ${version.version}`} · {version.author}{version.deleted ? ` · ${t('удалена')}` : ''}</summary><h4>{version.name}</h4><p>{version.summary}</p><pre className="memory-text">{version.details}</pre><MemoryMetadata record={version} /></details>)}
                {!historyLoaded && !historyLoading && <button type="button" className="btn" onClick={() => void loadHistory()}>{t('Загрузить историю')}</button>}
                {historyMore && <button type="button" className="btn" disabled={historyLoading} data-testid="memory-history-more" onClick={() => void loadHistory(true)}>{historyLoading ? t('Загружаю…') : t('Ещё версии')}</button>}
              </details>
            </> : <p className="memory-empty mut">{t('Выбери запись или создай новую.')}</p>}
          </section>
        </div>
      </>}
      {guard && <div className="memory-guard" role="alertdialog" aria-label={t('Несохранённые изменения')} aria-modal="true" data-testid="memory-discard">
        <h3>{t('Несохранённые изменения')}</h3><p>{guard.discard ? t('Изменения этой записи будут потеряны.') : t('Можно закрыть память и вернуться к этому черновику позже в этом окне Пульта.')}</p>
        <div><button type="button" className="btn" onClick={() => setGuard(null)}>{t('Продолжить редактирование')}</button><button type="button" className={`btn ${guard.discard ? 'btn-danger' : 'btn-primary'}`} data-testid="memory-discard-confirm" onClick={() => {
          const action = guard
          setGuard(null)
          if (action.discard) { setEditor(null); setConflict(null) }
          action.run()
        }}>{guard.discard ? t('Отбросить изменения') : t('Закрыть с черновиком')}</button></div>
      </div>}
    </Dialog>
  </div>
}
