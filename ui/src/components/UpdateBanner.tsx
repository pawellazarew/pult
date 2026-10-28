// Плашка обновления (M8c) — одна тихая строка над окном. Что в ней писать, решает model/update.ts.

import type { ReactElement } from 'react'
import { Icon } from './common.js'
import type { UpdateAction, UpdateBannerView } from '../model/update.js'

export function UpdateBanner(p: {
  view: UpdateBannerView | null
  busy: boolean
  onAction: (a: UpdateAction) => void
  onNotes: (url: string) => void
  onDismiss: (version: string) => void
}): ReactElement | null {
  const v = p.view
  if (!v) return null
  const tone = v.kind === 'failed' || v.kind === 'rolledback' || v.kind === 'app-failed' ? 'banner-wait' : 'banner-update'
  return (
    <div className={`banner ${tone}`} role="status" data-testid={`update-${v.kind}`}>
      <Icon name={v.kind === 'failed' || v.kind === 'rolledback' || v.kind === 'app-failed' ? 'alert' : v.kind === 'waiting' || v.kind === 'applying' ? 'clock' : 'info'} />
      <span className="grow">{v.text}</span>
      {v.notes && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => p.onNotes(v.notes as string)} data-testid="update-notes">Что нового</button>
      )}
      {v.action && (
        <button type="button" className={`btn btn-sm${v.action.force ? '' : ' btn-primary'}`} disabled={p.busy}
          onClick={() => { if (v.action) p.onAction(v.action) }} data-testid={v.action.rollback ? 'update-apply-app' : 'update-apply'}>{v.action.label}</button>
      )}
      {v.dismissKey && (
        <button type="button" className="btn btn-ghost btn-sm" title="Скрыть" aria-label="Скрыть"
          onClick={() => p.onDismiss(v.dismissKey as string)} data-testid="update-dismiss"><Icon name="x" /></button>
      )}
    </div>
  )
}
