import { t } from '../lib/i18n.js'
// Вкладки открытых сессий над разговором: клик в дереве открывает вкладку, ⌘1…9 — переключают,
// крестик закрывает (сессия при этом живёт дальше — закрывается только вкладка).

import type { ReactElement } from 'react'
import type { AgentView } from '../model/agents.js'
import { agentLabel, statusView } from '../model/agents.js'
import { contextView } from '../model/context.js'
import { CMD, Icon } from './common.js'
import { UnreadDot } from './ProjectTree.js'

export function SessionTabs({ tabs, active, onSelect, onClose }: {
  tabs: readonly AgentView[]
  active: string | null
  onSelect(name: string): void
  onClose(name: string): void
}): ReactElement | null {
  if (tabs.length === 0) return null
  return (
    <div className="tabs" role="tablist" aria-label={t("Открытые сессии")} data-testid="session-tabs">
      {tabs.map((a, i) => {
        const sv = statusView(a.status)
        const needs = sv.needsYou || a.pending > 0
        // Подсказка вкладки: подпись, горячая клавиша и занятость контекстного окна, если известна.
        const ctx = contextView(a.context)
        const tip = [agentLabel(a), i < 9 ? `${CMD}${i + 1}` : null, ctx ? t`контекст ${ctx.short}` : null].filter(Boolean).join(' · ')
        return (
          <div key={a.name} role="tab" className="tab" aria-selected={a.name === active} data-provider={a.provider}
            data-needs={needs ? '1' : '0'} data-busy={sv.busy && !needs ? '1' : '0'} data-unread={a.unread ? '1' : '0'} data-testid="session-tab" data-agent={a.name}
            title={tip} onClick={() => onSelect(a.name)}>
            <span className="tab-dot" />
            <span className="tab-name">{agentLabel(a)}</span>
            {a.unread && <UnreadDot a={a} testId="tab-unread" />}
            <button type="button" className="tab-x" aria-label={t`Закрыть вкладку ${agentLabel(a)}`} data-testid="tab-close"
              onClick={(e) => { e.stopPropagation(); onClose(a.name) }}><Icon name="x" /></button>
          </div>
        )
      })}
    </div>
  )
}
