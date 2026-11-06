import { ProviderIcon } from './ProviderIcon.js'
import { t } from '../lib/i18n.js'
// Вкладки открытых сессий над разговором: клик в дереве открывает вкладку, ⌘1…9 — переключают,
// крестик закрывает (сессия при этом живёт дальше — закрывается только вкладка).

import type { ReactElement } from 'react'
import type { AgentView } from '../model/agents.js'
import { agentLabel } from '../model/agents.js'
import { contextView } from '../model/context.js'
import { chatStatus } from '../model/navigation.js'
import { Icon } from './common.js'
import { UnreadDot } from './ProjectTree.js'
import { LOUD_STATES, StatusDot, toneState } from './StatusDot.js'

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
        // Та же сводка, что у строки чата в боковой панели: вкладка и строка обязаны говорить одно и то же.
        const sv = chatStatus(a)
        const state = toneState(sv.tone)
        const needs = state === 'waiting'
        // Подсказка вкладки: подпись, горячая клавиша и занятость контекстного окна, если известна.
        const ctx = contextView(a.context)
        const tip = [agentLabel(a), ctx ? t`контекст ${ctx.short}` : null].filter(Boolean).join(' · ')
        return (
          <div key={a.name} role="tab" className="tab" aria-selected={a.name === active} data-provider={a.provider}
            data-needs={needs ? '1' : '0'} data-state={state} data-unread={a.unread ? '1' : '0'} data-testid="session-tab" data-agent={a.name}
            title={tip} onClick={() => onSelect(a.name)}>
            {/* Провайдер — значком, состояние — точкой поверх его угла, как в строке чата. */}
            <span className="tab-provider"><ProviderIcon provider={a.provider} />
              {LOUD_STATES.has(state) && <StatusDot state={state} label={sv.label} cutout className="tab-live-dot" testId="tab-status" />}</span>
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
