import { t } from '../lib/i18n.js'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { SpeechStatus } from '../../../shell/src/contract.js'
import { errorText } from '../bridge.js'
import { chooseMicrophone, pcmWav } from '../model/speech.js'
import { Icon } from './common.js'
import './dictation.css'

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing'
type Preferences = { microphone: string; never: string; language: 'ru' | 'en' | 'auto' }
const defaults: Preferences = { microphone: '', never: 'AirPods', language: 'ru' }
function preferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem('pult.dictation') ?? '{}') as Partial<Preferences>
    return { microphone: typeof value.microphone === 'string' ? value.microphone : '', never: typeof value.never === 'string' ? value.never : 'AirPods', language: value.language === 'en' || value.language === 'auto' ? value.language : 'ru' }
  } catch { return defaults }
}

export function Dictation({ disabled, onText, onBusy, settingsOnly = false }: { settingsOnly?: boolean; disabled: boolean; onText(text: string): void; onBusy(busy: boolean): void }): ReactElement | null {
  const api = typeof window === 'undefined' ? undefined : window.pult?.speech
  const [phase, setPhase] = useState<Phase>('idle')
  const [settings, setSettings] = useState(settingsOnly)
  const [prefs, setPrefs] = useState(preferences)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [status, setStatus] = useState<SpeechStatus | null>(null)
  const [notice, setNotice] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [activeMic, setActiveMic] = useState('')
  const run = useRef(0)
  const active = useRef<{ recorder: MediaRecorder; stream: MediaStream; timer: number; chunks: Blob[] } | null>(null)
  const state = useRef(phase); state.current = phase
  const live = useRef({ disabled, prefs, onText, onBusy }); live.current = { disabled, prefs, onText, onBusy }
  const update = (next: Phase): void => { state.current = next; setPhase(next); live.current.onBusy(next !== 'idle') }
  const refresh = async (): Promise<void> => { if (api) setStatus(await api.status()) }
  const stopTracks = (): void => {
    const a = active.current
    if (!a) return
    clearInterval(a.timer)
    for (const track of a.stream.getTracks()) { track.onended = null; track.stop() }
    if (a.recorder.state !== 'inactive') a.recorder.stop()
    active.current = null
  }
  const cancel = (): void => {
    ++run.current
    stopTracks()
    void api?.cancel().catch(() => {})
    update('idle')
  }
  const stop = (): void => {
    if (state.current === 'starting') { cancel(); return }
    if (state.current !== 'recording') return
    update('transcribing')
    stopTracks()
  }
  const listDevices = async (): Promise<MediaDeviceInfo[]> => {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
    setDevices(all)
    return all
  }
  const start = async (): Promise<void> => {
    if (!api || live.current.disabled || state.current !== 'idle' || document.querySelector('[role=dialog]')) return
    const id = ++run.current
    update('starting'); setNotice(''); setSeconds(0)
    let stream: MediaStream | null = null
    try {
      const ready = await api.status()
      if (run.current !== id) return
      setStatus(ready)
      if (!ready.ready || !ready.runtime) { if (document.querySelector('[data-testid="open-settings"]')) window.dispatchEvent(new CustomEvent('pult:settings', { detail: 'voice' })); else setSettings(true); update('idle'); return }
      await api.prepare()
      if (run.current !== id) return
      // Grant reveals labels; immediately release the probe before opening the chosen input.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      probe.getTracks().forEach((t) => t.stop())
      if (run.current !== id) return
      const devices = await listDevices()
      if (run.current !== id) return
      const p = live.current.prefs
      const chosen = chooseMicrophone(devices, p.microphone, p.never)
      if (chosen === null) throw new Error(t('Нет подходящего микрофона. Подключи другой или измени список «Не использовать».'))
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: chosen }, channelCount: 1, echoCancellation: true }, video: false })
      if (run.current !== id) { stream.getTracks().forEach((t) => t.stop()); return }
      setActiveMic(stream.getAudioTracks()[0]?.label ?? t('Микрофон'))
      const chunks: Blob[] = []
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      recorder.onerror = () => { if (run.current === id) { cancel(); setNotice(t('Запись прервалась. Попробуй ещё раз.')) } }
      recorder.onstop = () => {
        if (run.current !== id) return
        update('transcribing')
        void (async () => {
          const context = new OfflineAudioContext(1, 1, 16000)
          const decoded = await context.decodeAudioData(await new Blob(chunks).arrayBuffer())
          if (run.current !== id) return
          if (decoded.length < 1600) throw new Error(t('Запись слишком короткая. Удерживай клавишу, пока говоришь.'))
          const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i).subarray(0, 16000 * 120))
          let energy = 0
          for (const value of channels[0]) energy += value * value
          if (energy / channels[0].length < 0.000001) throw new Error(t('Не слышно речи. Проверь выбранный микрофон.'))
          const text = await api.transcribe(pcmWav(channels), p.language)
          if (run.current !== id) return
          if (text) live.current.onText(text)
          else setNotice(t('Речь не распознана. Попробуй ещё раз.'))
        })().catch((e: unknown) => { if (run.current === id) setNotice(errorText(e)) })
          .finally(() => { if (run.current === id) update('idle') })
      }
      for (const track of stream.getTracks()) track.onended = () => { if (run.current === id) { cancel(); setNotice(t('Микрофон отключён. Запись отменена.')) } }
      const began = Date.now()
      const timer = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - began) / 1000)
        setSeconds(elapsed)
        if (elapsed >= 120) stop()
      }, 250)
      active.current = { recorder, stream, timer, chunks }
      recorder.start(250)
      update('recording')
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop())
      if (run.current === id) { stopTracks(); setNotice(errorText(e)); update('idle') }
    }
  }
  const actions = useRef({ start, stop, cancel }); actions.current = { start, stop, cancel }
  useEffect(() => {
    if (settingsOnly) return
    const observer = new MutationObserver(() => { if (state.current !== 'idle' && document.querySelector('[aria-modal="true"]')) actions.current.cancel() })
    observer.observe(document.body, { childList: true, subtree: true })
    let held = false
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation()
        if (!e.repeat && state.current === 'idle') { held = true; void actions.current.start() }
      } else if (e.key === 'Escape' && state.current !== 'idle') {
        e.preventDefault(); e.stopPropagation(); actions.current.cancel()
      }
    }
    const up = (e: KeyboardEvent): void => { if (e.code === 'Space' && held) { held = false; actions.current.stop() } }
    const blur = (): void => { held = false; if (state.current !== 'idle') actions.current.cancel() }
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', blur)
    return () => {
      observer.disconnect()
      window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur)
      ++run.current; stopTracks(); void api?.cancel().catch(() => {}); live.current.onBusy(false)
    }
  }, [api])
  useEffect(() => { if (disabled && state.current !== 'idle') cancel() }, [disabled])
  useEffect(() => {
    if (!settings || !api) return
    void refresh().catch((e: unknown) => setNotice(errorText(e)))
    const timer = window.setInterval(() => { void refresh().catch(() => {}) }, 800)
    const changed = (): void => { void listDevices().catch(() => {}) }
    navigator.mediaDevices?.addEventListener('devicechange', changed)
    return () => { clearInterval(timer); navigator.mediaDevices?.removeEventListener('devicechange', changed) }
  }, [settings, api])
  const save = (next: Preferences): void => { setPrefs(next); try { localStorage.setItem('pult.dictation', JSON.stringify(next)); window.dispatchEvent(new Event('pult:speech-preferences')) } catch { /* preferences still work for this window */ } }
  useEffect(() => {
    const sync = (): void => setPrefs(preferences())
    window.addEventListener('pult:speech-preferences', sync)
    return () => window.removeEventListener('pult:speech-preferences', sync)
  }, [])
  if (!api) return settingsOnly ? <p>{t("Обнови приложение Пульта, чтобы включить диктовку.")}</p> : null
  return <div className={`dictation${settingsOnly ? " dictation-inline" : ""}`}>
    {!settingsOnly && <>
    <button type="button" className={`btn dictation-mic${phase === 'recording' ? ' recording' : ''}`} disabled={disabled || phase === 'starting' || phase === 'transcribing'}
      aria-label={phase === 'recording' ? t('Завершить диктовку') : t('Диктовать сообщение')} aria-pressed={phase === 'recording'} data-testid="dictation-toggle"
      title={phase === 'recording' ? t('Завершить диктовку') : t('Диктовать сообщение')} onClick={() => phase === 'recording' ? stop() : void start()}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>
      {phase === 'recording' ? t`${seconds} с · Готово` : phase === 'transcribing' ? t('Распознаю…') : phase === 'starting' ? t('Подключаю…') : null}
    </button>
    <button type="button" className="btn dictation-options" aria-label={t("Настройки диктовки")} aria-expanded={settings} disabled={phase !== 'idle'} onClick={() => { if (document.querySelector('[data-testid="open-settings"]')) window.dispatchEvent(new CustomEvent('pult:settings', { detail: 'voice' })); else setSettings(!settings) }}><Icon name="chevd" /></button>
    {phase !== 'idle' && <button type="button" className="btn" onClick={cancel} title={t("Отменить диктовку (Esc)")}>{t("Отмена")}</button>}
    {phase === 'recording' && <span className="dictation-state" role="status">{activeMic}{t("· до 2 минут")}</span>}
    </>}
    {settings && <section className="dictation-settings" aria-label={t("Диктовка")}>
      <div className="dictation-heading" hidden={settingsOnly}><strong>{t("Диктовка на устройстве")}</strong><button type="button" className="btn" aria-label={t("Закрыть настройки диктовки")} onClick={() => setSettings(false)} hidden={settingsOnly}>×</button></div>
      <p>{t("Голос распознаётся на Mac и попадает в черновик. Отправляешь сообщение ты.")}</p>
      {status && !status.runtime ? <p role="status">{t("Обнови приложение Пульта: в этой сборке нет распознавания.")}</p> : status && !status.ready ? <>
        <p>{t("Для русского и английского нужна модель Whisper base — 148 МБ. Скачается с Hugging Face один раз.")}</p>
        <button type="button" className="btn" disabled={status.downloading} onClick={() => { void api.install().then(refresh).catch((e: unknown) => setNotice(errorText(e))); setStatus({ ...status, downloading: true }) }}>
          {status.downloading ? t`Скачиваю ${Math.floor(status.received / 1_000_000)} / 148 МБ…` : t('Скачать модель · 148 МБ')}
        </button>
      </> : <p role="status">{status?.ready ? t('Модель готова · работает без интернета') : t('Проверяю модель…')}</p>}
      <label>{t("Язык")}<select value={prefs.language} onChange={(e) => save({ ...prefs, language: e.target.value as Preferences['language'] })}><option value="ru">{t("Русский")}</option><option value="en">English</option><option value="auto">{t("Определить автоматически")}</option></select></label>
      <label>{t("Микрофон")}<select value={prefs.microphone} onChange={(e) => save({ ...prefs, microphone: e.target.value })}><option value="">{t("Автоматически")}</option>{prefs.microphone && !devices.some((d) => d.label === prefs.microphone) && <option value={prefs.microphone}>{prefs.microphone}{t("· не подключён")}</option>}{devices.filter((d) => d.deviceId !== 'default' && d.label).map((d) => <option key={d.deviceId} value={d.label}>{d.label}</option>)}</select></label>
      <button type="button" className="btn" onClick={() => { void (async () => { await api.prepare(); const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); probe.getTracks().forEach((t) => t.stop()); await listDevices() })().catch((e: unknown) => setNotice(errorText(e))) }}>{t("Показать микрофоны")}</button>
      <label>{t("Не использовать")}<input value={prefs.never} placeholder={t("AirPods, название гарнитуры")} onChange={(e) => save({ ...prefs, never: e.target.value })}/></label>
      <p>{t("Части названий через запятую. Выбранный вручную микрофон имеет приоритет. Если подходящего нет, запись не начнётся.")}</p>
      <p>{t("Удерживай Ctrl+Shift+Space в окне Пульта. Esc или уход из окна отменяют запись.")}</p>
    </section>}
    {notice && <div className="dictation-notice" role="alert"><span>{notice}</span><button type="button" className="btn" aria-label={t("Закрыть сообщение диктовки")} onClick={() => setNotice('')}>×</button></div>}
  </div>
}
