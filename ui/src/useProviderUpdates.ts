import { useCallback, useEffect, useRef, useState } from 'react'
import type { DaemonStatus, PultBridge } from '../../shell/src/contract.js'
import { errorText } from './bridge.js'
import { observeProviderTools, providerDaemonKey, PROVIDER_CHECK_INTERVAL_MS, PROVIDER_FOCUS_CHECK_MS } from './model/providerUpdates.js'
import type { ProviderObservation } from './model/providerUpdates.js'
import { t } from './lib/i18n.js'

/** Read-only inventory polls never call installers, auth, schema generation or restart on their own. */
export function useProviderUpdates(bridge: PultBridge, status: DaemonStatus | null, online: boolean, refreshStatus: () => Promise<void>): {
  observation: ProviderObservation | null
  checking: boolean
  reconnecting: boolean
  error: string | null
  refresh(force?: boolean): Promise<void>
  reconnect(): Promise<void>
} {
  const [observation, setObservation] = useState<ProviderObservation | null>(null)
  const [checking, setChecking] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [failure, setFailure] = useState<{ daemon: string; kind: 'inventory' | 'reconnect'; message: string } | null>(null)
  const current = useRef({ daemon: providerDaemonKey(status), online })
  current.current = { daemon: providerDaemonKey(status), online }
  const alive = useRef(true)
  const inFlight = useRef<Promise<void> | null>(null)
  const reconnectLock = useRef(false)
  const lastChecked = useRef<{ daemon: string; at: number } | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const refresh = useCallback((force = false): Promise<void> => {
    const daemon = current.current.daemon
    if (!bridge.providerTools || !current.current.online || !daemon) return Promise.resolve()
    if (inFlight.current) return inFlight.current
    if (!force && lastChecked.current?.daemon === daemon && Date.now() - lastChecked.current.at < PROVIDER_FOCUS_CHECK_MS) return Promise.resolve()
    setChecking(true)
    lastChecked.current = { daemon, at: Date.now() }
    const request = (async () => {
      try {
        const tools = await Promise.resolve().then(() => bridge.providerTools!())
        if (!alive.current || current.current.daemon !== daemon || !current.current.online) return
        setObservation(before => observeProviderTools(before, daemon, tools, Date.now()))
        setFailure(before => before?.daemon === daemon && before.kind === 'inventory' ? null : before)
      } catch (cause) {
        if (alive.current && current.current.daemon === daemon && current.current.online) setFailure({ daemon, kind: 'inventory', message: errorText(cause) })
      } finally {
        inFlight.current = null
        if (alive.current) setChecking(false)
      }
    })()
    inFlight.current = request
    return request
  }, [bridge])

  const reconnect = useCallback(async (): Promise<void> => {
    const daemon = current.current.daemon
    if (!bridge.restartDaemon || !current.current.online || !daemon || reconnectLock.current) return
    reconnectLock.current = true
    setReconnecting(true); setFailure(null)
    try {
      const applied = await bridge.restartDaemon()
      if (!applied || !alive.current) return
      // A successful request is not an acknowledgement of the installed file. Fresh daemon status
      // and its retained installation snapshot are the only source of disappearance of the card.
      await refreshStatus()
      await refresh(true)
    } catch (cause) { if (alive.current) setFailure({ daemon, kind: 'reconnect', message: t`Переподключение CLI не подтверждено: ${errorText(cause)}` }) }
    finally { reconnectLock.current = false; if (alive.current) setReconnecting(false) }
  }, [bridge, refreshStatus, refresh])

  const daemon = providerDaemonKey(status)
  useEffect(() => {
    if (!online || !daemon || !bridge.providerTools) return
    // A previous-daemon probe may still be owned by main. Its result is discarded; retry after join.
    const check = (): void => {
      if (document.visibilityState === 'hidden') return
      void refresh().then(() => {
        if (alive.current && current.current.daemon === daemon && lastChecked.current?.daemon !== daemon) void refresh()
      })
    }
    check()
    const interval = window.setInterval(check, PROVIDER_CHECK_INTERVAL_MS)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => { clearInterval(interval); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check) }
  }, [bridge, daemon, online, refresh])
  return { observation, checking, reconnecting, error: failure?.daemon === daemon ? failure.message : null, refresh, reconnect }
}
