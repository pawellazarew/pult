import { randomUUID } from 'node:crypto'
import { createAskKeys } from '../perm/askKeys.js'
import type { RuntimeDiscovery, RuntimeHostJob, RuntimeInput, RuntimeResult, RuntimeSetup, RuntimeTarget } from './types.js'

export class RuntimeError extends Error { constructor(readonly code: string, message: string) { super(message) } }
interface Lease { sessionId: string; controller: 'agent' | 'human'; generation: number; touched: number }
interface SetupRequest { id: string; sessionId: string; setup: RuntimeSetup; status: 'pending' | 'approved' | 'denied' | 'installing' | 'failed'; error?: string }
interface Job { wire: RuntimeHostJob; generation: number; targetId: string; owner?: number; timer: ReturnType<typeof setTimeout>; resolve(v: RuntimeResult): void; reject(e: Error): void }
export interface RuntimeDeps {
  mobile(): Promise<RuntimeDiscovery>
  performMobile(target: RuntimeTarget, action: string, input: Record<string, unknown>): Promise<RuntimeResult>
  install?(id: string): Promise<RuntimeResult>
  session(id: string): { approval?: string; archived?: boolean } | null
  authorize(sessionId: string, targetId: string, action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<boolean>
  changed(sessionId: string, data: Record<string, unknown>): void
  now?: () => number
}
const READ = new Set(['inspect', 'screenshot', 'logs'])
const ACTIONS = new Set(['attach', 'detach', 'boot', 'inspect', 'screenshot', 'tap', 'swipe', 'type', 'button', 'launch', 'install', 'logs', 'open_url', 'navigate', 'reload', 'back', 'forward', 'viewport'])
const WEB_ACTIONS = ['attach', 'detach', 'inspect', 'screenshot', 'tap', 'swipe', 'type', 'button', 'navigate', 'reload', 'back', 'forward', 'viewport', 'logs']
const LEASE_MS = 30 * 60_000

/** Commands and ephemeral snapshots share authorization, never the durable event log. */
export function createRuntimeService(d: RuntimeDeps) {
  const keys = createAskKeys()
  const sessionKeys = new Map<string, string>()
  const approvals = new Map<string, string>()
  const epochs = new Map<string, number>()
  const aborters = new Map<string, AbortController>()
  let stopped = false
  const leases = new Map<string, Lease>()
  const jobs = new Map<string, Job>()
  const requests = new Map<string, SetupRequest>()
  const queues = new Map<string, Promise<unknown>>()
  const hosts = new Map<number, number>()
  let inventory: RuntimeDiscovery = { targets: [], setup: [] }
  let inventoryAt = -Infinity
  let discovering: Promise<RuntimeDiscovery> | null = null
  const now = d.now ?? Date.now
  const validSession = (id: string): void => {
    if (stopped) throw new RuntimeError('interrupted', 'Сервис сред остановлен')
    const s = d.session(id)
    if (!s || s.archived) throw new RuntimeError('not_found', 'Сессия недоступна')
  }
  const invalidate = (id: string, reason: string): void => {
    for (const [key, job] of jobs) if (job.targetId === id) {
      clearTimeout(job.timer); jobs.delete(key); job.reject(new RuntimeError('interrupted', reason))
    }
  }
  const leaseOf = (id: string): Lease | undefined => {
    const lease = leases.get(id)
    if (lease && (now() - lease.touched > LEASE_MS || !d.session(lease.sessionId) || d.session(lease.sessionId)?.archived)) {
      invalidate(id, 'Доступ к устройству истёк'); leases.delete(id); return undefined
    }
    return lease
  }
  const mobile = async (): Promise<RuntimeDiscovery> => {
    if (now() - inventoryAt < 3000) return inventory
    if (!discovering) discovering = d.mobile().then((r) => { inventory = r; inventoryAt = now(); return r }).finally(() => { discovering = null })
    return discovering
  }
  const hostAvailable = (): boolean => [...hosts.values()].some((at) => now() - at < 90_000)
  const target = async (sessionId: string, id: string): Promise<RuntimeTarget> => {
    if (id === `web:${sessionId}`) {
      if (!hostAvailable()) throw new RuntimeError('unavailable', 'Встроенный браузер доступен при открытом окне Пульта')
      return { id, kind: 'web', name: 'Браузер', state: 'ready', capabilities: WEB_ACTIONS }
    }
    const found = (await mobile()).targets.find((t) => t.id === id)
    if (!found) throw new RuntimeError('not_found', 'Устройство не найдено; обновите список')
    return found
  }
  const web = (sessionId: string, id: string, action: string, input: Record<string, unknown>, generation: number): Promise<RuntimeResult> => new Promise((resolve, reject) => {
    if (jobs.size >= 32) { reject(new RuntimeError('busy', 'Слишком много ожидающих операций')); return }
    const jobId = randomUUID()
    const timer = setTimeout(() => { jobs.delete(jobId); reject(new RuntimeError('timeout', 'Браузер не ответил за 30 секунд')) }, 30_000)
    timer.unref?.()
    jobs.set(jobId, { wire: { id: jobId, sessionId, action, input }, targetId: id, generation, timer, resolve, reject })
  })
  const execute = async (p: RuntimeInput, actor: 'agent' | 'human'): Promise<RuntimeResult> => {
    p = { ...p, input: structuredClone(p.input ?? {}) }
    validSession(p.sessionId)
    let aborter = aborters.get(p.sessionId)
    if (!aborter) { aborter = new AbortController(); aborters.set(p.sessionId, aborter) }
    const epoch = epochs.get(p.sessionId) ?? 0
    const approval = approvals.get(p.sessionId) ?? d.session(p.sessionId)?.approval ?? 'ask'
    const active = (): void => { validSession(p.sessionId); if ((epochs.get(p.sessionId) ?? 0) !== epoch) throw new RuntimeError('interrupted', 'Сессия остановлена; операция отменена') }
    if (!ACTIONS.has(p.action)) throw new RuntimeError('invalid_params', 'Неизвестное действие среды')
    const t = await target(p.sessionId, p.targetId)
    active()
    let lease = leaseOf(t.id)
    if (lease && lease.sessionId !== p.sessionId) throw new RuntimeError('busy', 'Устройство занято другой сессией')
    if (p.action === 'attach') {
      if (actor === 'agent' && lease?.controller === 'human') throw new RuntimeError('human_control', 'Пользователь управляет устройством. Дождитесь возврата управления.')
      if (!lease && actor === 'agent' && approval !== 'full' && !(await d.authorize(p.sessionId, t.id, 'attach', p.input ?? {}, aborter.signal))) {
        throw new RuntimeError('denied', 'Доступ к среде не разрешён')
      }
      // Permission wait is an await boundary: another session may have acquired the device.
      active()
      const current = leaseOf(t.id)
      if (current && (current.sessionId !== p.sessionId || (actor === 'agent' && current.controller === 'human'))) throw new RuntimeError('busy', 'Управление уже изменилось')
      lease = current ?? { sessionId: p.sessionId, controller: actor, generation: 1, touched: now() }
      leases.set(t.id, lease)
    }
    if (!lease) throw new RuntimeError('not_attached', 'Сначала подключите среду действием attach')
    if (!READ.has(p.action) && p.action !== 'detach' && lease.controller !== actor) throw new RuntimeError('control_required', 'Сначала получите управление устройством')
    if (p.action === 'detach' && lease.controller !== actor) throw new RuntimeError('control_required', 'Сначала получите управление устройством')
    const generation = lease.generation
    if (actor === 'agent' && (p.action === 'install' || p.action === 'open_url' || p.action === 'navigate') && approval !== 'full') {
      if (!(await d.authorize(p.sessionId, t.id, p.action, p.input ?? {}, aborter.signal))) throw new RuntimeError('denied', 'Действие не разрешено')
    }
    const check = (): void => {
      active()
      const l = leaseOf(t.id)
      if (l !== lease || l.generation !== generation || (!READ.has(p.action) && l.controller !== actor)) throw new RuntimeError('interrupted', 'Управление изменилось; перечитайте экран')
    }
    const previous = queues.get(t.id) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      check(); lease!.touched = now()
      const input = p.input ?? {}
      const result = t.kind === 'web' ? await web(p.sessionId, t.id, p.action, input, generation)
        : p.action === 'detach' ? { text: 'Устройство отключено от сессии; оно продолжает работать' }
        : await d.performMobile(t, p.action === 'attach' ? (t.state === 'stopped' ? 'boot' : 'screenshot') : p.action, input)
      check()
      if (p.action === 'detach') { leases.delete(t.id); d.changed(p.sessionId, { state: 'detached', targetId: t.id }) }
      else if (p.action === 'attach') d.changed(p.sessionId, { state: 'attached', targetId: t.id })
      return result
    })
    queues.set(t.id, task)
    try { return await task } catch (e) {
      if (p.action === 'attach' && leases.get(t.id) === lease && lease.generation === generation) leases.delete(t.id)
      throw e
    } finally { if (queues.get(t.id) === task) queues.delete(t.id) }
  }
  return {
    key(sessionId: string, approval = 'ask') { validSession(sessionId); approvals.set(sessionId, approval); let key = sessionKeys.get(sessionId); if (!key) { key = keys.mint(sessionId); sessionKeys.set(sessionId, key) }; return key },
    lookup(key: unknown) { const id = keys.lookup(key); return id && d.session(id) && !d.session(id)?.archived ? id : null },
    revoke(sessionId: string) {
      aborters.get(sessionId)?.abort(); aborters.delete(sessionId)
      epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1); approvals.delete(sessionId)
      keys.revokeSession(sessionId); sessionKeys.delete(sessionId)
      for (const [id, lease] of leases) if (lease.sessionId === sessionId) { invalidate(id, 'Сессия завершена'); leases.delete(id) }
    },
    async discover(sessionId: string) {
      validSession(sessionId)
      const m = await mobile()
      const attached: string[] = []; const controllers: Record<string, 'agent' | 'human'> = {}
      for (const id of leases.keys()) { const l = leaseOf(id); if (l?.sessionId === sessionId) { attached.push(id); controllers[id] = l.controller } }
      const w: RuntimeTarget = { id: `web:${sessionId}`, kind: 'web', name: 'Встроенный браузер', state: hostAvailable() ? 'ready' : 'unavailable', detail: hostAvailable() ? 'Chromium Пульта — без дополнительной установки' : 'Откройте окно Пульта', capabilities: WEB_ACTIONS }
      return { targets: [w, ...m.targets], setup: m.setup, attached, controllers }
    },
    perform: execute,
    takeover(sessionId: string, id: string, controller: 'agent' | 'human') {
      validSession(sessionId); const lease = leaseOf(id)
      if (!lease || lease.sessionId !== sessionId) throw new RuntimeError('not_attached', 'Среда не подключена к этой сессии')
      ++lease.generation; lease.controller = controller; lease.touched = now()
      invalidate(id, 'Пользователь изменил управление')
      d.changed(sessionId, { state: controller === 'human' ? 'takeover' : 'released', targetId: id })
      return { controller }
    },
    poll(owner: number) {
      hosts.set(owner, now())
      const out: RuntimeHostJob[] = []
      for (const j of jobs.values()) if (j.owner === undefined && out.length < 1) { j.owner = owner; out.push(j.wire) }
      return { jobs: out }
    },
    begin(owner: number, id: string) {
      const job = jobs.get(id)
      const lease = job ? leaseOf(job.targetId) : undefined
      if (!job || job.owner !== owner || !lease || lease.generation !== job.generation) throw new RuntimeError('interrupted', 'Операция отменена или управление изменилось')
      return { active: true }
    },
    complete(owner: number, id: string, result: unknown, error?: unknown) {
      const j = jobs.get(id)
      if (!j || j.owner !== owner) throw new RuntimeError('not_found', 'Операция не принадлежит этому окну')
      clearTimeout(j.timer); jobs.delete(id)
      if (error) j.reject(new RuntimeError('runtime_failed', typeof error === 'string' ? error.slice(0, 1000) : 'Ошибка браузера'))
      else j.resolve(result && typeof result === 'object' && !Array.isArray(result) ? result as RuntimeResult : {})
      return { completed: true }
    },
    hostGone(owner: number) {
      if (!hosts.delete(owner)) return
      for (const [id, j] of jobs) if (j.owner === owner) { clearTimeout(j.timer); jobs.delete(id); j.reject(new RuntimeError('unavailable', 'Окно браузера отключилось')) }
      for (const [id, l] of leases) if (id.startsWith('web:')) { invalidate(id, 'Окно отключилось'); leases.delete(id); d.changed(l.sessionId, { state: 'detached', targetId: id }) }
    },
    async requestSetup(sessionId: string, setupId: string) {
      validSession(sessionId)
      const setup = (await mobile()).setup.find((s) => s.id === setupId)
      if (!setup) throw new RuntimeError('not_found', 'Компонент не найден или уже установлен')
      const existing = [...requests.values()].find((r) => r.sessionId === sessionId && r.setup.id === setupId && r.status === 'pending')
      if (existing) return existing
      if (requests.size >= 100) throw new RuntimeError('busy', 'Слишком много запросов настройки')
      const r: SetupRequest = { id: randomUUID(), sessionId, setup: structuredClone(setup), status: 'pending' }
      requests.set(r.id, r); d.changed(sessionId, { state: 'setup', requestId: r.id }); return r
    },
    listSetup(sessionId: string) { validSession(sessionId); return { requests: [...requests.values()].filter((r) => r.sessionId === sessionId) } },
    async resolveSetup(sessionId: string, id: string, approve: boolean) {
      validSession(sessionId); const r = requests.get(id)
      if (!r || r.sessionId !== sessionId || r.status !== 'pending') throw new RuntimeError('not_found', 'Запрос настройки уже обработан')
      r.status = approve ? 'approved' : 'denied'
      if (approve && r.setup.installable && d.install) {
        r.status = 'installing'; d.changed(sessionId, { state: 'setup', requestId: id })
        try { await d.install(r.setup.id); r.status = 'approved'; inventoryAt = -Infinity }
        catch (e) { r.status = 'failed'; r.error = (e as Error).message.slice(0, 1000) }
      }
      d.changed(sessionId, { state: 'setup', requestId: id }); return { ...r }
    },
    stop() { stopped = true; for (const c of aborters.values()) c.abort(); aborters.clear(); for (const id of leases.keys()) invalidate(id, 'Демон остановлен'); leases.clear(); hosts.clear(); for (const id of sessionKeys.keys()) keys.revokeSession(id); sessionKeys.clear() },
  }
}
