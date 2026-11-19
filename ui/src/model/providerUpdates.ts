import type { DaemonStatus, ProviderTool } from '../../../shell/src/contract.js'
import type { ProviderFileIdentity } from '../../../src/env/providerIdentity.js'
import type { InboxSystemCard } from './inbox.js'
import { t } from '../lib/i18n.js'

export const PROVIDER_CHECK_INTERVAL_MS = 60_000
export const PROVIDER_FOCUS_CHECK_MS = 15_000

/** Requested path aliases may differ between shell and daemon; the selected file must match. */
export function providerIdentityKey(value: ProviderFileIdentity | null | undefined): string | null {
  if (!value) return null
  const fields = [value.realpath, value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs]
  return fields.every(field => typeof field === 'string' && field.length > 0) ? JSON.stringify(fields) : null
}

export function providerToolKey(tool: ProviderTool): string | null {
  if (tool.changedDuringCheck) return null
  const identity = providerIdentityKey(tool.installation)
  if (identity) return identity
  if (tool.installation !== undefined) return null
  // Compatibility with an old desktop bridge. This is observation, not runtime qualification.
  return tool.path && tool.realpath && tool.version ? JSON.stringify([tool.path, tool.realpath, tool.version]) : null
}

export function providerDaemonKey(status: Pick<DaemonStatus, 'pid' | 'startedAt' | 'home'> | null): string | null {
  return status ? JSON.stringify([status.home, status.pid, status.startedAt]) : null
}

export interface ProviderObservation {
  daemon: string
  tools: readonly ProviderTool[]
  baseline: Partial<Record<ProviderTool['provider'], string>>
  baselineVersions: Partial<Record<ProviderTool['provider'], string>>
  versions: Partial<Record<ProviderTool['provider'], string>>
  checkedAt: number
}

/** Baselines are scoped to one daemon lifetime; an unstable probe can never acknowledge a file. */
export function observeProviderTools(before: ProviderObservation | null, daemon: string, tools: readonly ProviderTool[], checkedAt: number): ProviderObservation {
  const baseline = before?.daemon === daemon ? { ...before.baseline } : {}
  const baselineVersions = before?.daemon === daemon ? { ...before.baselineVersions } : {}
  const versions = before?.daemon === daemon ? { ...before.versions } : {}
  for (const tool of tools) {
    const key = providerToolKey(tool)
    if (key && baseline[tool.provider] === undefined) baseline[tool.provider] = key
    if (key && tool.version) {
      baselineVersions[tool.provider] ??= tool.version
      versions[tool.provider] = tool.version
    }
  }
  return { daemon, tools, baseline, baselineVersions, versions, checkedAt }
}

export function providerUpdateCards(status: DaemonStatus | null, observation: ProviderObservation | null, options: {
  online: boolean
  canReconnect: boolean
  checking?: boolean
  reconnecting?: boolean
  error?: string | null
}): InboxSystemCard[] {
  const daemon = providerDaemonKey(status)
  const cards: InboxSystemCard[] = []
  if (status && options.error) cards.push({ id: 'provider-check-error', title: t('Не удалось проверить подключение CLI'), detail: options.error,
    error: true, action: 'check', actionLabel: t('Перепроверить'), actionDisabled: !options.online || !!options.checking || !!options.reconnecting, busy: !!options.checking })
  if (!status || !observation || observation.daemon !== daemon) return cards
  for (const tool of observation.tools) {
    const name = tool.provider === 'claude' ? 'Claude Code' : 'Codex'
    const adopted = status.providerInstallations?.[tool.provider]
    const detected = providerToolKey(tool)
    const used = providerIdentityKey(adopted?.installation)
    if (tool.changedDuringCheck) {
      cards.push({ id: `${tool.provider}:checking`, provider: tool.provider, title: t`${name}: обновление ещё идёт`,
        detail: t('CLI изменился во время проверки. Перепроверю его перед подключением.'), error: false,
        action: 'check', actionLabel: t('Перепроверить'), actionDisabled: !options.online || !!options.checking, busy: !!options.checking })
      continue
    }
    if (!tool.path || tool.source === 'missing' || (tool.installation === null && tool.version === null)) {
      // An uninstalled, unused provider should not create a permanent Inbox warning.
      if (!used && !observation.baseline[tool.provider]) continue
      cards.push({ id: `${tool.provider}:missing`, provider: tool.provider, title: t`${name}: CLI не найден`,
        detail: t('Ранее выбранный CLI недоступен. Перепроверь установку в панели CLI.'), error: true,
        action: 'check', actionLabel: t('Перепроверить'), actionDisabled: !options.online || !!options.checking, busy: !!options.checking })
      continue
    }
    // A lazy Rust runtime has not selected a CLI yet; the first turn will choose a fresh installation.
    if (adopted?.initialized === false) continue
    const versionChanged = observation.baselineVersions[tool.provider] !== undefined
      && observation.versions[tool.provider] !== observation.baselineVersions[tool.provider]
    const changed = versionChanged || (adopted && tool.installation !== undefined
      ? detected !== null && (used === null || providerIdentityKey(tool.installation) !== used)
      : detected !== null && observation.baseline[tool.provider] !== detected)
    if (!changed) continue
    cards.push({ id: `${tool.provider}:${detected}`, provider: tool.provider, title: t`${name}: CLI изменился`,
      detail: tool.version
        ? t`Найдена версия ${tool.version}. Подключи её перезапуском демона из окна. Разговоры сохранятся; текущие ходы прервутся только после подтверждения.`
        : t('Установка CLI изменилась. Подключи её перезапуском демона из окна. Разговоры сохранятся; текущие ходы прервутся только после подтверждения.'),
      error: false, action: 'reconnect', actionLabel: options.reconnecting ? t('Переподключаю…') : t('Подключить обновление'),
      actionDisabled: !options.online || !options.canReconnect || !!options.reconnecting, busy: !!options.reconnecting })
  }
  return cards
}
