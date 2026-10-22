// M8f: «Настройки» (⌘,). Раздел «Новая сессия» — умолчания по провайдерам и «Подставлять последний выбор»;
// «Обновления» — версии, состояние канала, «Проверить сейчас», «Обновить до X» и флаг автопроверки (что писать —
// model/update.ts); «Внешний вид» пока пустой (темы и цвета — после редизайна, docs/15). Логика черновика —
// model/sessionSettings.ts.

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { APPROVAL_LABEL, PRESETS } from '../model/newAgent.js'
import { DEFAULT_APPROVALS, draftError, effortOptions, setDefault, setDefaultProvider, settingsDraft } from '../model/sessionSettings.js'
import type { NewSessionSettings, Provider } from '../../../src/sessions/settings.js'
import type { UpdateStatus } from '../../../src/core/rpc.js'
import type { ProviderCatalog } from '../model/types.js'
import { appUpdateView, updateSection } from '../model/update.js'
import type { UpdateAction } from '../model/update.js'
import { CMD, Kbd } from './common.js'
import { Dialog } from './Panels.js'

const PROVIDERS: readonly Provider[] = ['claude', 'codex']

function ProviderDefaultsBox({ provider, draft, catalog, onChange }: {
  provider: Provider; draft: NewSessionSettings; catalog: ProviderCatalog | null; onChange(d: NewSessionSettings): void
}): ReactElement {
  const d = draft.defaults[provider]
  const models: Array<{ id: string; label: string }> = provider === 'claude'
    ? PRESETS.claude.models.map((id) => ({ id, label: id }))
    : (catalog?.codex.models ?? []).map((m) => ({ id: m.id, label: m.label }))
  if (d.model && !models.some((m) => m.id === d.model)) models.unshift({ id: d.model, label: d.model })
  const efforts = effortOptions(provider, catalog, d.model)
  const effortList = d.effort && !efforts.includes(d.effort) ? [d.effort, ...efforts] : efforts
  const id = (k: string): string => `set-${provider}-${k}`
  return (
    <fieldset data-testid={`settings-${provider}`}>
      <legend>{provider}</legend>
      <label className="field" htmlFor={id('model')}>
        <span className="lbl">модель</span>
        <select id={id('model')} value={d.model ?? ''} data-testid={`settings-${provider}-model`}
          onChange={(e) => onChange(setDefault(draft, provider, 'model', e.target.value))}>
          <option value="">{provider === 'codex' ? 'по умолчанию Codex' : `как в форме (${PRESETS.claude.defaultModel})`}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {provider === 'codex' && !catalog?.codex.models.length && <span className="note">список моделей Codex не загружен — «Проверить» в «+ Сессия»</span>}
      </label>
      <label className="field" htmlFor={id('effort')}>
        <span className="lbl">усилие</span>
        <select id={id('effort')} value={d.effort ?? ''} data-testid={`settings-${provider}-effort`}
          onChange={(e) => onChange(setDefault(draft, provider, 'effort', e.target.value))}>
          <option value="">как в форме</option>
          {effortList.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </label>
      <label className="field" htmlFor={id('approval')}>
        <span className="lbl">подтверждения</span>
        <select id={id('approval')} value={d.approval ?? ''} data-testid={`settings-${provider}-approval`}
          onChange={(e) => onChange(setDefault(draft, provider, 'approval', e.target.value as typeof d.approval | ''))}>
          <option value="">как в форме ({APPROVAL_LABEL.ask.toLowerCase()})</option>
          {DEFAULT_APPROVALS.map((a) => <option key={a} value={a}>{APPROVAL_LABEL[a]}</option>)}
        </select>
        <span className="note">«Полный доступ» по умолчанию не ставится — только явно при заведении.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={d.mode === 'warm'} data-testid={`settings-${provider}-warm`}
          onChange={(e) => onChange(setDefault(draft, provider, 'mode', e.target.checked ? 'warm' : undefined))} />
        <span>Тёплый процесс между репликами</span>
        {provider === 'codex' && <span className="note">у Codex процесс app-server и так общий — флаг ни на что не влияет</span>}
      </label>
      <label className="check">
        <input type="checkbox" checked={d.browser === true} data-testid={`settings-${provider}-browser`}
          onChange={(e) => onChange(setDefault(draft, provider, 'browser', e.target.checked ? true : undefined))} />
        <span>Браузер для агента</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={d.worktree === true} data-testid={`settings-${provider}-worktree`}
          onChange={(e) => onChange(setDefault(draft, provider, 'worktree', e.target.checked ? true : undefined))} />
        <span>Предлагать ветку worktree (pult/&lt;имя&gt;)</span>
      </label>
    </fieldset>
  )
}

/** Раздел «Обновления»: живой — кнопки работают сразу, мимо «Сохранить»; флаг автопроверки — в черновике. */
export interface UpdatesPanel {
  /** `daemon.status.update`; нет — старый демон. */
  status: UpdateStatus | null | undefined
  /** Версия пакета (демона) и окна (из user agent; null — неизвестна). */
  packageVersion: string | null
  windowVersion: string | null
  /** Идёт «Проверить сейчас» из окна и чем кончился сам вызов (не ответ канала). */
  checking: boolean
  error: string | null
  /** Идёт вызов `update.apply`; его отказ (старая оболочка, «ставить нечего»). */
  busy: boolean
  applyError: string | null
  now: number
  onCheck(): void
  onApply(a: UpdateAction): void
  onNotes(url: string): void
}

export function UpdatesSection({ panel, auto, onAuto }: {
  panel: UpdatesPanel
  /** Флаг «Проверять автоматически»; null — демон его не отдаёт (старый), переключателя нет. */
  auto: boolean | null
  onAuto(on: boolean): void
}): ReactElement {
  const v = updateSection(panel.status, panel.windowVersion, { checking: panel.checking, error: panel.error }, panel.now)
  const tone = v.state === 'error' || v.state === 'failed' || v.state === 'window' || v.state === 'bad' ? ' upd-warn' : v.state === 'available' ? ' upd-new' : ''
  // 0.3.4: окно обновляется само — своя строка с «Обновить окно».
  const w = appUpdateView(panel.status, panel.windowVersion)
  const wTone = w.state === 'failed' || w.state === 'rolledback' || w.state === 'bad' || w.state === 'firstrun-failed' ? ' upd-warn' : w.state === 'available' ? ' upd-new' : ''
  return (
    <section className="settings-sec" aria-labelledby="settings-upd-h" data-testid="settings-updates">
      <h3 id="settings-upd-h">Обновления</h3>
      <div className="upd-versions" data-testid="settings-update-versions">
        <span>Пульт <span className="mono">{panel.packageVersion ?? '—'}</span></span>
        <span>окно <span className="mono">{panel.status?.app?.installed ?? panel.windowVersion ?? 'неизвестно'}</span></span>
      </div>
      <div className={`upd-state${tone}`} role="status" data-testid="settings-update-state" data-state={v.state}>
        {v.state === 'checking' && <span className="spin" aria-hidden="true" />}
        <span className="grow">{v.text}</span>
        {v.notes && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => panel.onNotes(v.notes as string)} data-testid="settings-update-notes">Что нового</button>
        )}
      </div>
      {v.note && <span className="note" data-testid="settings-update-note">{v.note}</span>}
      {panel.applyError && <span className="err" role="alert" data-testid="settings-update-error">{panel.applyError}</span>}
      <div className="upd-actions">
        <span className="note" data-testid="settings-update-checked">{v.checked}</span>
        <span className="grow" />
        <button type="button" className="btn btn-sm" disabled={!v.canCheck} onClick={panel.onCheck} data-testid="settings-update-check">
          {panel.checking ? 'Проверяю…' : 'Проверить сейчас'}
        </button>
        {v.action && (
          <button type="button" className={`btn btn-sm${v.action.force ? '' : ' btn-primary'}`} disabled={panel.busy}
            onClick={() => { if (v.action) panel.onApply(v.action) }} data-testid="settings-update-apply">{v.action.label}</button>
        )}
      </div>
      {w.state !== 'none' && (
        <div className={`upd-state${wTone}`} role="status" data-testid="settings-app-update" data-state={w.state}>
          {w.state === 'applying' && <span className="spin" aria-hidden="true" />}
          <span className="grow">{w.text}</span>
          {w.action && (
            <button type="button" className="btn btn-sm btn-primary" disabled={panel.busy}
              onClick={() => {
                if (!w.action) return
                // «Вернуть», пока новое окно не запускалось, — с вопросом: это откат по просьбе, а не по сбою.
                if (w.action.confirm && !window.confirm(w.action.confirm)) return
                panel.onApply(w.action)
              }} data-testid="settings-app-apply">{w.action.label}</button>
          )}
        </div>
      )}
      {auto !== null && (
        <label className="check">
          <input type="checkbox" checked={auto} data-testid="settings-update-auto" onChange={(e) => onAuto(e.target.checked)} />
          <span>Проверять обновления автоматически</span>
          <span className="note">Раз в 6 ч и когда окно возвращается на экран (не чаще раза в 10 мин): один запрос latest.json к GitHub. Ставится только по кнопке.</span>
        </label>
      )}
    </section>
  )
}

export function SettingsDialog({ settings, catalog, updates, autoCheck = null, onSave, onClose }: {
  settings: NewSessionSettings | null
  catalog: ProviderCatalog | null
  /** Раздел «Обновления»; нет — раздела нет. */
  updates?: UpdatesPanel
  /** `updates.check` из `settings.get`; null — старый демон. */
  autoCheck?: boolean | null
  /** `null` — записано; строка — отказ демона. `autoCheck` — флаг автопроверки (null — не трогать). */
  onSave(next: NewSessionSettings, autoCheck: boolean | null): Promise<string | null>
  onClose(): void
}): ReactElement {
  const [draft, setDraft] = useState<NewSessionSettings>(() => settingsDraft(settings))
  const [auto, setAuto] = useState<boolean | null>(autoCheck)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const first = useRef<HTMLSelectElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  const invalid = draftError(draft)
  const save = async (): Promise<void> => {
    if (busy || invalid) return
    setBusy(true)
    setErr(null)
    const e = await onSave(draft, auto)
    setBusy(false)
    if (e) setErr(e)
  }
  return (
    <Dialog title="Настройки" size="wide" onClose={onClose} testId="settings-dialog"
      footer={<>
        {(err ?? invalid) && <span className="err" role="alert" data-testid="settings-error">{err ?? invalid}</span>}
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>Отмена <Kbd>Esc</Kbd></button>
        <button type="button" className="btn btn-primary" disabled={busy || !!invalid} onClick={() => void save()} data-testid="settings-save">
          {busy ? 'Сохраняю…' : 'Сохранить'} <Kbd>{`${CMD}↵`}</Kbd>
        </button>
      </>}>
      <div className="form-stack" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void save() } }}>
        <section className="settings-sec" aria-labelledby="settings-new-h" data-testid="settings-new-session">
          <h3 id="settings-new-h">Новая сессия</h3>
          <label className="field" htmlFor="set-provider">
            <span className="lbl">провайдер по умолчанию</span>
            <select id="set-provider" ref={first} value={draft.defaults.provider ?? ''} data-testid="settings-provider"
              onChange={(e) => setDraft(setDefaultProvider(draft, e.target.value as Provider | ''))}>
              <option value="">как в форме (claude)</option>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.rememberLast} data-testid="settings-remember-last"
              onChange={(e) => setDraft({ ...draft, rememberLast: e.target.checked })} />
            <span>Подставлять последний выбор</span>
            <span className="note">«+ Сессия» откроется с тем, что ты выбрал в прошлый раз (кроме реплики и «Полного доступа»); иначе — с умолчаниями ниже. pult agent start всегда берёт умолчания.</span>
          </label>
          <div className="settings-prov">
            {PROVIDERS.map((p) => <ProviderDefaultsBox key={p} provider={p} draft={draft} catalog={catalog} onChange={setDraft} />)}
          </div>
        </section>
        {updates && <UpdatesSection panel={updates} auto={auto} onAuto={setAuto} />}
        <section className="settings-sec" aria-labelledby="settings-look-h" data-testid="settings-appearance">
          <h3 id="settings-look-h">Внешний вид</h3>
          <span className="note">Темы и цвета — после редизайна.</span>
        </section>
      </div>
    </Dialog>
  )
}
