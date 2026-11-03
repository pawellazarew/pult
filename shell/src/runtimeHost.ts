import type { RuntimeHostJob } from '../../src/runtimes/types.js'
import type { DaemonLink } from './link.js'
import type { RuntimeWeb } from './runtimeWeb.js'

/** Ephemeral queue: screenshots are direct RPC responses, never journal events. */
export function startRuntimeHost(options: { link: DaemonLink; web: RuntimeWeb; log?(message: string): void }): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const tick = async (): Promise<void> => {
    if (stopped) return
    if (options.link.current.state === 'up') {
      try {
        const reply = await options.link.call('runtime.host.poll', { available: options.web.available() }) as { jobs?: RuntimeHostJob[] }
        for (const job of reply.jobs ?? []) {
          if (stopped) break
          // A takeover/Stop can invalidate an already-polled job before execution.
          try { await options.link.call('runtime.host.begin', { id: job.id }) } catch { continue }
          try {
            const result = await options.web.perform(job)
            await options.link.call('runtime.host.complete', { id: job.id, result })
          } catch (error) {
            await options.link.call('runtime.host.complete', { id: job.id, error: (error as Error).message.slice(0, 1000) }).catch(() => {})
          }
        }
      } catch (error) {
        // Older daemon can lack runtime methods; keep chat working and retry without log spam.
        const e = error as { code?: string; message?: string }
        if (e.code !== 'method_not_found' && e.code !== 'not_implemented' && e.code !== 'not_found' && e.code !== 'no_daemon') options.log?.(`runtime host: ${e.message ?? String(error)}`)
      }
    }
    if (!stopped) { timer = setTimeout(() => { void tick() }, 500); timer.unref() }
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
