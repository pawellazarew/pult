import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, MouseEvent, ReactElement } from 'react'
import type { PultBridge } from '../../../shell/src/contract.js'
import type { RuntimeBounds, RuntimeDiscovery, RuntimeKind, RuntimeResult, RuntimeSetup } from '../../../src/runtimes/types.js'
import { errorText } from '../bridge.js'
import { Icon } from './common.js'
import '../runtime.css'

type Discovery = RuntimeDiscovery & { attached?: string[]; controller?: 'agent' | 'human'; controllers?: Record<string, 'agent' | 'human'> }
type SetupRequest = { id: string; setup: RuntimeSetup; status: 'pending' | 'approved' | 'denied' | 'installing' | 'failed'; sessionId: string; error?: string }
type ViewBridge = PultBridge & { runtimeView?(sessionId: string, bounds: RuntimeBounds | null): Promise<void> }
const KINDS: Array<{ id: RuntimeKind; label: string }> = [{ id: 'web', label: 'Браузер' }, { id: 'ios', label: 'iOS' }, { id: 'android', label: 'Android' }]

/** Device coordinates refer to the original framebuffer, not the compressed preview. */
export function runtimePoint(client: { x: number; y: number }, box: { left: number; top: number; width: number; height: number }, size: { width: number; height: number }): { x: number; y: number } | null {
  if (![client.x, client.y, box.left, box.top, box.width, box.height, size.width, size.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0 || size.width <= 0 || size.height <= 0) return null
  const x = (client.x - box.left) / box.width, y = (client.y - box.top) / box.height
  if (x < 0 || y < 0 || x > 1 || y > 1) return null
  return { x: Math.min(size.width - 1, Math.floor(x * size.width)), y: Math.min(size.height - 1, Math.floor(y * size.height)) }
}

export function runtimeCoordinates(kind: RuntimeKind, frame: RuntimeResult | null, fallback?: { width: number; height: number }): { width: number; height: number } | null {
  const width = Number(frame?.coordinateWidth) || (kind !== 'ios' ? Number(frame?.width) || fallback?.width : 0) || 0
  const height = Number(frame?.coordinateHeight) || (kind !== 'ios' ? Number(frame?.height) || fallback?.height : 0) || 0
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null
}

/** A driver may only display bounded raster images, never a returned HTML/URL payload. */
export function runtimeImage(result: RuntimeResult): string | null {
  const image = result.image
  return image && ['image/jpeg', 'image/png'].includes(image.mimeType) && typeof image.data === 'string' && image.data.length <= 600_000 && /^[A-Za-z0-9+/=\r\n]+$/.test(image.data)
    ? `data:${image.mimeType};base64,${image.data}` : null
}

export function RuntimePanel({ bridge, sessionId, obstructed, onClose }: { bridge: ViewBridge; sessionId: string; obstructed: boolean; onClose(): void }): ReactElement {
  const [discovery, setDiscovery] = useState<Discovery>({ targets: [], setup: [] })
  const [requests, setRequests] = useState<SetupRequest[]>([])
  const [kind, setKind] = useState<RuntimeKind>('web')
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [frame, setFrame] = useState<RuntimeResult | null>(null)
  const [frameAt, setFrameAt] = useState<number | null>(null)
  const [slotVisible, setSlotVisible] = useState(true)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [url, setUrl] = useState('http://localhost:3000')
  const [text, setText] = useState('')
  const [details, setDetails] = useState<string | null>(null)
  const [bootNote, setBootNote] = useState<string | null>(null)
  const slot = useRef<HTMLDivElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const lifetime = useRef(0)
  const activeTarget = useRef('')
  const seen = useRef({ attached: new Set<string>(), requests: new Set<string>() })
  const waitingAndroid = useRef<Set<string> | null>(null)
  const targets = discovery.targets.filter((t) => t.kind === kind)
  const target = targets.find((t) => t.id === selected) ?? targets[0] ?? null
  const targetId = target?.id ?? ''
  activeTarget.current = targetId
  const attached = !!targetId && !!discovery.attached?.includes(targetId)
  const human = (discovery.controllers?.[targetId] ?? discovery.controller) === 'human'
  const web = kind === 'web'
  const nativeEligible = web && attached && human && !!bridge.runtimeView
  const nativeWeb = nativeEligible && slotVisible
  const picture = frame ? runtimeImage(frame) : null
  const syncUrl = useCallback((result: RuntimeResult): void => {
    if (typeof result.url === 'string' && result.url.length <= 8192 && (!human || document.activeElement !== urlInput.current)) setUrl(result.url)
  }, [human])

  const refresh = useCallback(async (): Promise<void> => {
    const epoch = lifetime.current
    try {
      const [next, setups] = await Promise.all([
        bridge.call('runtime.discover', { sessionId }) as Promise<Discovery>,
        bridge.call('runtime.setup.list', { sessionId }) as Promise<{ requests: SetupRequest[] }>,
      ])
      if (epoch !== lifetime.current) return
      const pending = (setups.requests ?? []).find((r) => r.status === 'pending' && !seen.current.requests.has(r.id))
      const newlyAttached = next.targets.find((t) => next.attached?.includes(t.id) && !seen.current.attached.has(t.id))
      if (pending) { setKind(pending.setup.kind); setSelected('') }
      else if (newlyAttached) { setKind(newlyAttached.kind); setSelected(newlyAttached.id) }
      seen.current = { attached: new Set(next.attached ?? []), requests: new Set((setups.requests ?? []).map((r) => r.id)) }
      if (waitingAndroid.current) {
        const ready = next.targets.filter((t) => t.kind === 'android' && t.state === 'ready' && t.id.startsWith('android:') && !waitingAndroid.current!.has(t.id))
        if (ready.length === 1) {
          setKind('android'); setSelected(ready[0].id); waitingAndroid.current = null
          setBootNote('Эмулятор запущен. Нажми «Подключить», чтобы открыть его экран.')
        }
      }
      setDiscovery(next)
      setRequests(setups.requests ?? [])
      setError(null)
    } catch (e) { if (epoch === lifetime.current) setError(errorText(e)) }
    finally { if (epoch === lifetime.current) setLoading(false) }
  }, [bridge, sessionId])

  useEffect(() => {
    const epoch = ++lifetime.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => { await refresh(); if (epoch === lifetime.current) timer = setTimeout(() => { void poll() }, 2500) }
    void poll()
    const visibility = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility)
    return () => { ++lifetime.current; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [refresh])

  useEffect(() => { setFrame(null); setFrameAt(null); setDetails(null) }, [targetId])

  const perform = useCallback(async (action: string, input: Record<string, unknown> = {}): Promise<RuntimeResult | null> => {
    if (!targetId) return null
    const epoch = lifetime.current
    setBusy(true); setError(null)
    if (action === 'attach') {
      if (targetId.startsWith('android-avd:')) { waitingAndroid.current = new Set(discovery.targets.filter((t) => t.kind === 'android' && t.state === 'ready').map((t) => t.id)); setBootNote('Эмулятор запускается. Пульт найдёт его после загрузки Android.') }
      else setBootNote(null)
    }
    try {
      const result = await bridge.call('runtime.perform', { sessionId, targetId, action, input }) as RuntimeResult
      if (epoch !== lifetime.current || activeTarget.current !== targetId) return null
      syncUrl(result)
      if (result.image) { setFrame(result); setFrameAt(Date.now()) }
      if (action === 'inspect' || action === 'logs') setDetails(result.text ?? JSON.stringify(result, null, 2))
      else if (result.text && action !== 'screenshot') setDetails(result.text)
      await refresh()
      return result
    } catch (e) { if (epoch === lifetime.current) setError(errorText(e)); return null }
    finally { if (epoch === lifetime.current) setBusy(false) }
  }, [bridge, sessionId, targetId, refresh, discovery.targets, syncUrl])

  // One outstanding screenshot request. Hidden panels/tabs and native web views do not poll.
  useEffect(() => {
    if (!attached || !targetId || !visible || obstructed || nativeWeb || !target?.capabilities.includes('screenshot')) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const epoch = lifetime.current
    const poll = async (): Promise<void> => {
      try {
        const result = await bridge.call('runtime.perform', { sessionId, targetId, action: 'screenshot' }) as RuntimeResult
        if (!alive || epoch !== lifetime.current || activeTarget.current !== targetId) return
        syncUrl(result)
        if (runtimeImage(result)) { setFrame(result); setFrameAt(Date.now()) }
      } catch (e) { if (alive && epoch === lifetime.current) setError(errorText(e)) }
      if (alive) timer = setTimeout(() => { void poll() }, 1000)
    }
    void poll()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [attached, targetId, visible, obstructed, nativeWeb, bridge, sessionId, syncUrl, target?.capabilities.join(',')])

  // Native contents live above the renderer; hide them whenever a modal could overlap.
  useLayoutEffect(() => {
    if (!bridge.runtimeView) return
    const update = (): void => {
      const box = slot.current?.getBoundingClientRect()
      const panel = slot.current?.closest('.runtime-panel')?.getBoundingClientRect()
      const fits = !!box && !!panel && box.top >= panel.top && box.bottom <= panel.bottom && box.left >= panel.left && box.right <= panel.right && box.top >= 0 && box.bottom <= window.innerHeight
      setSlotVisible(fits)
      const show = nativeEligible && visible && !obstructed && fits && box && box.width > 0 && box.height > 0
      void bridge.runtimeView!(sessionId, show ? { x: Math.round(box.left), y: Math.round(box.top), width: Math.floor(box.width), height: Math.floor(box.height) } : null).catch((e: unknown) => setError(errorText(e)))
    }
    update()
    const observer = new ResizeObserver(update)
    if (slot.current) observer.observe(slot.current)
    // Panel resizing can change position without changing its own width.
    observer.observe(document.body)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); void bridge.runtimeView!(sessionId, null).catch(() => {}) }
  }, [bridge, sessionId, nativeEligible, visible, obstructed])

  const control = async (): Promise<void> => {
    setBusy(true); setError(null)
    try { await bridge.call(human ? 'runtime.release' : 'runtime.takeover', { sessionId, targetId }); await refresh() }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  const resolve = async (request: SetupRequest, approve: boolean): Promise<void> => {
    setBusy(true)
    try { await bridge.call('runtime.setup.resolve', { sessionId, id: request.id, approve }); await refresh() }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  const requestSetup = async (setup: RuntimeSetup): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const request = await bridge.call('runtime.setup.request', { sessionId, setupId: setup.id }) as SetupRequest
      if (setup.installable) {
        setRequests((all) => [...all.filter((r) => r.id !== request.id), { ...request, status: 'installing' }])
        await bridge.call('runtime.setup.resolve', { sessionId, id: request.id, approve: true })
      }
      await refresh()
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  const tap = (e: MouseEvent<HTMLImageElement>): void => {
    if (!human || busy || !target?.capabilities.includes('tap')) return
    const el = e.currentTarget
    const size = runtimeCoordinates(kind, frame, { width: el.naturalWidth, height: el.naturalHeight })
    if (!size) return
    const point = runtimePoint({ x: e.clientX, y: e.clientY }, el.getBoundingClientRect(), size)
    if (point) void perform('tap', point)
  }
  const navigate = (e: FormEvent): void => { e.preventDefault(); void perform('navigate', { url }) }
  const mobileType = (e: FormEvent): void => { e.preventDefault(); if (text) void perform('type', { text }).then((r) => { if (r) setText('') }) }
  const swipe = (direction: 'up' | 'down'): void => {
    const size = runtimeCoordinates(kind, frame)
    if (!size) return
    const start = direction === 'up' ? .75 : .25, end = direction === 'up' ? .25 : .75
    void perform('swipe', { x: Math.floor(size.width / 2), y: Math.floor(size.height * start), endX: Math.floor(size.width / 2), endY: Math.floor(size.height * end), duration: 350 })
  }

  return <aside className="runtime-panel" aria-label="Превью и устройства" data-testid="runtime-panel">
    <div className="runtime-title"><div><b>Превью</b><span>Одна среда у тебя и агента</span></div><button type="button" className="btn btn-ghost btn-sm" aria-label="Закрыть превью" onClick={onClose}><Icon name="x" /></button></div>
    <div className="runtime-kinds" role="tablist" aria-label="Тип среды">{KINDS.map((k) => <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} className={`btn btn-sm ${kind === k.id ? 'runtime-tab-active' : 'btn-ghost'}`} onClick={() => { setKind(k.id); setSelected('') }}>{k.label}</button>)}<button type="button" className="btn btn-ghost btn-sm runtime-refresh" disabled={busy} aria-label="Найти устройства заново" onClick={() => void refresh()}>↻</button></div>
    {error && <div className="runtime-error" role="alert">{error}</div>}
    {loading && <div className="runtime-note" role="status">Ищу доступные среды…</div>}
    {targets.length > 0 && <div className="runtime-device-row"><label className="runtime-select-label">Среда<select value={targetId} onChange={(e) => setSelected(e.target.value)} aria-label="Выбрать устройство">{targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.state === 'stopped' ? ' · выключено' : ''}</option>)}</select></label>{!attached && <button type="button" className="btn btn-primary" disabled={busy || target?.state === 'unavailable'} onClick={() => void perform('attach')} data-testid="runtime-attach">{busy ? 'Подключаю…' : 'Подключить'}</button>}</div>}
    {target?.detail && <p className="runtime-note">{target.detail}</p>}
    {kind === 'android' && bootNote && <p className="runtime-note" role="status">{bootNote}</p>}
    {attached && <>
      <div className="runtime-control"><span className={human ? 't-ok' : 't-run'}><span className="dot" />{human ? 'Ты управляешь' : 'Управляет агент'}</span><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void control()} data-testid="runtime-control">{human ? 'Вернуть агенту' : 'Взять управление'}</button></div>
      {web && <form className="runtime-address" onSubmit={navigate}><input ref={urlInput} aria-label="Адрес страницы" value={url} placeholder="http://localhost:3000" onChange={(e) => setUrl(e.target.value)} spellCheck={false} disabled={!human} /><button type="submit" className="btn btn-sm" disabled={busy || !human}>Открыть</button><button type="button" className="btn btn-ghost btn-sm" aria-label="Перезагрузить страницу" disabled={busy || !human} onClick={() => void perform('reload')}>↻</button></form>}
      <div ref={slot} className={`runtime-screen${web ? ' runtime-screen-web' : ''}${human ? ' runtime-screen-human' : ''}`} data-testid="runtime-screen" aria-label={nativeWeb ? 'Интерактивная веб-страница' : 'Экран выбранной среды'}>
        {!nativeWeb && (picture ? <img src={picture} alt={`Экран: ${target?.name ?? 'устройство'}`} draggable={false} onClick={tap} /> : <div className="runtime-placeholder">{targetId.startsWith('android-avd:') ? 'Эмулятор загружается. Затем выбери запущенное устройство и нажми «Подключить».' : target?.capabilities.includes('screenshot') ? 'Ожидаю первый кадр…' : 'Для показа экрана нужен дополнительный компонент.'}</div>)}
      </div>
      {!web && human && kind === 'ios' && picture && !runtimeCoordinates(kind, frame) && <p className="runtime-note">Координаты экрана ещё недоступны. Нажатия по картинке отключены; агент может работать по названиям элементов.</p>}
      {!nativeWeb && <div className="runtime-frame-status"><span>{web && human && !slotVisible ? 'Прокрути панель к экрану для ввода' : frameAt ? 'Кадры обновляются раз в секунду' : 'Подключено'}</span>{!human && <span>Для ввода возьми управление</span>}</div>}
      {!web && human && <div className="runtime-mobile-input"><div className="runtime-device-buttons">{target?.capabilities.includes('button') && <><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void perform('button', { button: kind === 'android' ? 'back' : 'home' })}>{kind === 'android' ? 'Назад' : 'Домой'}</button>{kind === 'android' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void perform('button', { button: 'home' })}>Домой</button>}</>}{target?.capabilities.includes('swipe') && <><button type="button" className="btn btn-sm" disabled={busy || !runtimeCoordinates(kind, frame)} onClick={() => swipe('up')}>↑ Прокрутить</button><button type="button" className="btn btn-sm" disabled={busy || !runtimeCoordinates(kind, frame)} onClick={() => swipe('down')}>↓</button></>}</div>{target?.capabilities.includes('type') && <form onSubmit={mobileType}><input aria-label="Текст для устройства" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ввести в активное поле" /><button className="btn btn-sm" type="submit" disabled={busy || !text}>Ввести</button></form>}</div>}
      <div className="runtime-bottom-actions">{target?.capabilities.includes('inspect') && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void perform('inspect')}>Элементы экрана</button>}{target?.capabilities.includes('logs') && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void perform('logs')}>Ошибки и журнал</button>}<button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void perform('detach')}>Отключить</button></div>
      {details && <details className="runtime-details" open><summary>Состояние среды</summary><pre>{details}</pre></details>}
    </>}
    {!loading && !targets.length && <div className="runtime-empty"><b>{web ? 'Браузер пока недоступен' : 'Устройства не найдены'}</b><p>{web ? 'Открой эту сессию в обновлённом desktop-приложении Пульта.' : 'Подключи существующий симулятор или настрой среду ниже. SDK и образы не входят в Пульт.'}</p></div>}
    {requests.filter((r) => r.setup.kind === kind && r.status !== 'denied').slice(-6).map((request) => <div className={`runtime-setup runtime-setup-pending${request.status === 'failed' ? ' runtime-setup-failed' : ''}`} key={request.id}>
      <b>{runtimeSetupLabel(request.status, request.setup.installable)}</b>
      {request.status !== 'approved' || !request.setup.installable ? <SetupInfo setup={request.setup} bridge={bridge} /> : <p>{request.setup.title}. Пульт перепроверил готовность среды.</p>}
      {request.status === 'installing' && <p role="status">Установка выполняется на этом компьютере. Можно продолжать разговор; состояние обновляется автоматически.</p>}
      {request.status === 'failed' && <><p className="t-fail" role="alert">{request.error ?? 'Компонент не удалось установить.'}</p><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void requestSetup(request.setup)}>Попробовать снова</button></>}
      {request.status === 'pending' && <div className="runtime-setup-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void resolve(request, true)}>{request.setup.installable ? 'Установить и продолжить' : 'Показать шаги настройки'}</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void resolve(request, false)}>Пропустить</button></div>}
      {!request.setup.installable && <p className="runtime-note">Эти шаги выполняются вручную. После настройки нажми ↻ — Пульт перепроверит готовность.</p>}
    </div>)}
    {discovery.setup.filter((s) => s.kind === kind && !requests.some((r) => r.setup.id === s.id && (['pending', 'installing', 'failed'].includes(r.status) || (r.status === 'approved' && !s.installable)))).map((setup) => <details className="runtime-setup" key={setup.id} open={!targets.length || setup.installable}><summary>{setup.title}</summary><SetupInfo setup={setup} bridge={bridge} />{setup.installable && <div className="runtime-setup-actions"><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void requestSetup(setup)} data-testid="runtime-install-helper">Установить помощник</button></div>}</details>)}
  </aside>
}

export function runtimeSetupLabel(status: SetupRequest['status'], installable: boolean): string {
  if (status === 'installing') return 'Устанавливаю компонент…'
  if (status === 'failed') return 'Установка не завершена'
  if (status === 'approved') return installable ? 'Компонент установлен' : 'Выполни шаги настройки'
  return 'Для задачи нужна настройка'
}

function SetupInfo({ setup, bridge }: { setup: RuntimeSetup; bridge: PultBridge }): ReactElement {
  return <><p>{setup.detail}</p>{setup.command && <div className="runtime-command"><code>{setup.command}</code><button className="btn btn-ghost btn-sm" type="button" aria-label="Скопировать команду настройки" onClick={() => void bridge.copyText(setup.command!)}>Копировать</button></div>}{setup.url && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void bridge.openExternal?.(setup.url!)}>Открыть инструкцию ↗</button>}</>
}
