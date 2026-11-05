import { useEffect, useState } from 'react'
import type { DiskSettings as Preferences, DiskStatus } from '../../../src/core/disk.js'
import { t, getLanguage } from '../lib/i18n.js'

export function defaultCleanupPrompt(): string { return t('Помоги почистить диск') }
export function freeDiskText(status: DiskStatus): string {
  return status.freeBytes === null ? t('Не удалось определить свободное место') : t`Сейчас свободно: ${(status.freeBytes / 1e9).toLocaleString(getLanguage(), { maximumFractionDigits: 1 })} ГБ`
}
export function DiskSettings({ disk, onSave }: { disk?: { settings: Preferences; status: DiskStatus }; onSave?(value: Preferences): Promise<void> }) {
  const [threshold, setThreshold] = useState(String(disk?.settings.thresholdGb ?? 6))
  const [prompt, setPrompt] = useState(disk?.settings.prompt ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => { setThreshold(String(disk?.settings.thresholdGb ?? 6)); setPrompt(disk?.settings.prompt ?? '') }, [disk?.settings.thresholdGb, disk?.settings.prompt])
  const value = Number(threshold)
  const valid = Number.isSafeInteger(value) && value >= 1 && Number.isSafeInteger(value * 1e9)
  async function save() {
    if (!valid || !onSave || busy) return
    setBusy(true); setError(''); setSaved(false)
    try { await onSave({ thresholdGb: value, prompt: prompt.trim() || null }); setSaved(true) }
    catch { setError(t('Не удалось сохранить настройки диска.')) }
    finally { setBusy(false) }
  }
  return <fieldset disabled={!disk || !onSave || busy} data-testid="disk-settings">
    <legend>{t('Свободное место на диске')}</legend>
    {disk && <p className="note">{freeDiskText(disk.status)}<br /><span className="mono" style={{ overflowWrap: 'anywhere' }}>{disk.status.path}</span></p>}
    <label className="field"><span className="lbl">{t('Предупреждать, когда свободно меньше (ГБ)')}</span>
      <input type="number" min="1" step="1" value={threshold} aria-invalid={!valid} onChange={e => { setThreshold(e.target.value); setSaved(false) }} data-testid="disk-threshold" /></label>
    <label className="field"><span className="lbl">{t('Фраза для уборки диска')}</span>
      <textarea value={prompt} placeholder={defaultCleanupPrompt()} onChange={e => { setPrompt(e.target.value); setSaved(false) }} data-testid="disk-prompt" />
      <span className="note">{t('Пустое поле — стандартная фраза на языке интерфейса. Свой текст не меняется при смене языка.')}</span></label>
    {prompt && <button type="button" className="btn" onClick={() => { setPrompt(''); setSaved(false) }}>{t('Восстановить по умолчанию')}</button>}
    <button type="button" className="btn" disabled={!valid || busy} onClick={() => void save()}>{t('Сохранить настройки диска')}</button>
    {saved && <p role="status">{t('Настройки диска сохранены.')}</p>}
    {error && <p role="alert" className="err">{error}</p>}
  </fieldset>
}
