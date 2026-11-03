// Адаптер ZCode (маршрут A спайка docs/17-SPIKE-zcode.md): процесс НА ХОД, как у claude.
//
// ЧЕГО ЗДЕСЬ НЕТ ПО СРАВНЕНИЮ С CLAUDE — И ПОЧЕМУ:
//   * тёплых процессов и фоновой работы: `-p`-процесс всегда умирает после ответа, держать
//     нечего — жнец, фоновый слушатель и граница «сменить процесс по флагам» не нужны;
//   * MCP-брокера и заглушки разрешений: у маршрута A нет канала вопросов. `ask` ложится на
//     `guarded` (опасное CLI отклоняет сам), а approvalContext честно говорит об этом модели;
//   * `--session-id`: разговор заводит САМ CLI (sess_…), Пульт узнаёт id из потока и resume'ит
//     его следующим ходом через `--resume`.
//
// СТОП (контракт тот же): SIGINT → SIGTERM → SIGKILL; незакрытый ход заканчивается
// `errorCode: 'interrupted'`, статус `interrupted` пишет менеджер. ИЗМЕРЕНО 02.11.2026:
// SIGINT по headless-ходу даёт `turn.completed {resultType:"cancelled"}`, exit 130 и
// `Error: Turn was cancelled.` в stderr — строки `result` нет вовсе.
//
// ЧТО ЗАПРЕЩЕНО ЗДЕСЬ И ПОЧЕМУ:
//   * ход без проверки страны выхода — перед ПЕРВЫМ ходом сессии и после простоя дольше 60 с
//     (инвариант 2, общий с claude/codex);
//   * повтор после отказа входа/аккаунта — провайдер останавливается ЦЕЛИКОМ (инвариант 3),
//     снимается только `provider.reset`. Квота при этом провайдер не останавливает: лимит
//     проходит, подписка/денежный лимит могут пополниться без нашего вмешательства.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { PultConfig } from '../../core/config.js'
import type { EventDraft } from '../../core/events.js'
import type { Logger } from '../../core/log.js'
import { redactString } from '../../core/log.js'
import { createLineSplitter } from '../../core/ndjson.js'
import { buildChildEnv } from '../../env/allowlist.js'
import { checkNetwork, netGeneration, netRefusal, noProxyValue } from '../../env/net.js'
import type { NetCheck } from '../../env/net.js'
import type { SessionRecord } from '../../sessions/registry.js'
import type {
  AdapterDeps, ApprovalMode, PermissionDecision, ProviderAdapter, SessionSpec, StartedSession, TurnOutcome, TurnSettings, TurnStarted,
} from '../types.js'
import { approvalContext } from '../approvalContext.js'
import { buildZcodeArgv } from './argv.js'
import { createZcodeMapper } from './mapper.js'
import type { ZcodeSignal } from './mapper.js'

type ResultSignal = Extract<ZcodeSignal, { kind: 'result' }>
type TurnEndedSignal = Extract<ZcodeSignal, { kind: 'turn_ended' }>

/** Простой дольше этого — страж проверяется заново (инвариант 2, как у claude). */
export const IDLE_RECHECK_MS = 60_000
export const INTERRUPT_GRACE_MS = 2_000
export const INTERRUPT_KILL_MS = 3_000

/**
 * Ошибки stderr, означающие «входа нет/аккаунт не пускает»: провайдер останавливается целиком.
 * Коды — из бандла CLI 0.17.1 (`not_authenticated`, `official_auth_unavailable`, 401 →
 * `authentication_required`); сами строки BEGIN-anchored, чтобы цитата модели их не изображала.
 */
const AUTH_FAIL_RE = /not_authenticated|official_auth_unavailable|authentication_required|zcode-jwt-invalid|ZCODE_CREDENTIAL_DECRYPT_FAILED|Unable to read shared ZCode credentials/i

/** Квота/лимит: ход падает, статус limited, но провайдер жив (списание/лимит могут обновиться). */
const QUOTA_RE = /quota_exceeded|coding_plan_required|rate_limited|limit_exceeded/i

/** `--resume` на разговор, которого нет: следующий ход заведёт разговор заново (самолечение, как NO_CONVERSATION у claude). */
const NO_SESSION_RE = /(session.{0,40}(not found|не найден|не существует))|invalid session id/i

/**
 * Профиль сети процесса zcode: как у claude — только HTTPS_PROXY (у API z.ai anthropic-совместимый
 * транспорт, SOCKS не обещан), прямой путь не ставит ни одной прокси-переменной.
 */
export function zcodeNetworkEnv(check: NetCheck): Record<string, string> {
  return check.path === 'proxy' && check.proxy ? { HTTPS_PROXY: check.proxy, NO_PROXY: noProxyValue(check.noProxy) } : {}
}

/**
 * Конфиг-переменные zcode, которые пробрасываются ребёнку ОСОЗНАННО, поверх белого списка.
 *
 * ЗАЧЕМ (ИЗМЕРЕНО 02.11.2026, бисекция живого прогона): без них CLI не находит свой provider-конфиг
 * и умирает «无法定位 CLI ZCode Built-in Provider Config» — бандл внутри .app конфига не содержит.
 * Десктоп ZCode держит его в `~/.zcode/v2/runtime/provider/<платформа>/<версия>/endpoint-<sha256>/` и
 * указывает терминальному CLI точным путём: `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (решающая переменная
 * бисекции); `ZCODE_BASE_URL`/`ZCODE_APP_VERSION` помогают CLI собрать путь самому. Тот же класс
 * осознанного проброса, что HTTPS_PROXY. Креды и токены (имена вроде `ZCODE_OFFICIAL_ENDPOINT_TOKEN`,
 * `~/.zcode/v2/credentials.json`) сюда НЕ входят никогда: CLI сам читает файл по HOME, которого
 * в белом списке достаточно.
 */
export const ZCODE_ENV_PASS: readonly string[] = [
  'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
  'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
  'ZCODE_BASE_URL',
  'ZCODE_ENDPOINT_ORIGIN',
  'ZCODE_PRODUCTION_BASE_URL',
  'ZCODE_TEST_BASE_URL',
  'ZCODE_APP_VERSION',
]

/** Проброс конфиг-переменных zcode из окружения демона: есть значение — уходит ребёнку. */
export function zcodeExtraEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ZCODE_ENV_PASS) {
    const v = parent[k]
    if (typeof v === 'string' && v.length) out[k] = v
  }
  return out
}

export interface ZcodeAdapterOptions extends AdapterDeps {
  config: PultConfig
  logger: Logger
  /** Путь к `zcode` (node-скрипт с shebang — запускается напрямую). Тест подсовывает фальшивый CLI. */
  bin: string
  /** Инъекция стража сети: тест не ходит в сеть вообще. */
  netCheck?: (provider: 'zcode') => Promise<NetCheck>
  now?: () => number
}

interface Live {
  spec: SessionSpec
  providerSessionId: string
  /** Заведён ли разговор на стороне CLI: поднимает первый поток событий с sessionId (см. onSignal). */
  started: boolean
  child: ChildProcess | null
  lastTurnAt: number
  busy: boolean
  closing: boolean
  /** Был `interrupt`, пока ход не дошёл до спавна: ход отменяет сам runTurn. */
  stopRequested: boolean
  /** Профиль сети, выбранный последней проверкой стража: он и уезжает ребёнку. */
  netEnv: Record<string, string>
  /** Закрыть идущий ход стопом, даже если его процесс уже закрылся. */
  turnAbort: ((message: string) => void) | null
  /** Шаг A: уровень, с которым запущен текущий процесс хода (`undefined` — `ask`); для `activeAccess`. */
  childApproval?: ApprovalMode
}

/** Процессы, чей `close` уже был: ход не должен ждать второго. */
const closedChildren = new WeakSet<ChildProcess>()

let turnSeq = 0

export function createZcodeAdapter(opts: ZcodeAdapterOptions): ProviderAdapter {
  const { config, logger } = opts
  const now = opts.now ?? Date.now
  const live = new Map<string, Live>()
  /** Дети с добивающим SIGTERM (unref-таймер демона не держит). Подметает shutdown(). */
  const pendingKills = new Set<ChildProcess>()
  let providerBlocked: string | null = null

  const emit = (draft: EventDraft): void => { opts.emit(draft) }
  const status = (sessionId: string, s: string, extra: Record<string, unknown> = {}): void =>
    emit({ sessionId, provider: 'zcode', kind: 'status.changed', data: { status: s, ...extra } })

  const netProbe = opts.netCheck
    ?? ((provider: 'zcode'): Promise<NetCheck> =>
      checkNetwork(provider, config.network[provider], config.guard, {}))
  /** Поколение правил сети, при котором сессия последний раз проходила стража. */
  const netSeen = new WeakMap<Live, number>()

  const need = (name: string): Live => {
    const l = live.get(name)
    if (!l) throw new Error(`сессия ${name} не заведена в адаптере`)
    return l
  }

  const killChild = (l: Live, signal: NodeJS.Signals = 'SIGTERM'): void => {
    const child = l.child
    if (!child) return
    l.child = null
    try { child.stdin?.end() } catch { /* уже закрыт */ }
    try { child.kill(signal) } catch { /* уже мёртв */ }
  }

  /** Ждёт выхода ребёнка. false — не дождались за `ms`: сигнал не подействовал. */
  const waitExit = (child: ChildProcess, ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return }
      const onExit = (): void => { clearTimeout(timer); resolve(true) }
      const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, ms)
      timer.unref?.()
      child.once('exit', onExit)
    })

  const blockProvider = (name: string, text: string): void => {
    providerBlocked = text.slice(0, 400)
    emit({
      sessionId: name, provider: 'zcode', kind: 'provider.blocked',
      data: { provider: 'zcode', text: providerBlocked, hint: 'zcode login — потом pult provider reset zcode' },
    })
    logger.error('провайдер zcode остановлен целиком', { session: name })
  }

  const runTurn = async (l: Live, text: string, at?: TurnSettings): Promise<TurnStarted> => {
    const name = l.spec.name
    const turnId = `t${++turnSeq}`
    const fail = (errorCode: string, message: string): TurnStarted =>
      ({ turnId, done: Promise.resolve({ turnId, ok: false, errorCode, message }) })

    if (providerBlocked !== null) return fail('provider_unavailable', providerBlocked)
    if (l.busy) return fail('invalid_params', `сессия ${name} уже делает ход`)

    /** Сессию закрыли/пересоздали под ходом: её события выбрасываются. */
    const gone = (): boolean => l.closing || live.get(name) !== l
    const emitL = (draft: EventDraft): void => { if (!gone()) emit(draft) }
    const statusL = (s: string, extra: Record<string, unknown> = {}): void => { if (!gone()) status(name, s, extra) }

    l.stopRequested = false
    let approval = at?.approval ?? l.spec.approval
    // Шаг A (PR #39): полный уровень (`--mode yolo`) — только если демон его СЕЙЧАС разрешает (согласие или `--yes`).
    // Снимок хода демон уже провёл через `accessGate`; это вторая линия — согласие отозвали между снимком и спавном.
    // Без разрешения — явный `ask` (`guarded`), никогда не «шире».
    if (approval === 'full' && opts.mayRunFull && !opts.mayRunFull(name)) {
      logger.warn('полный доступ не разрешён к моменту хода — ход в «Спрашивать»', { session: name })
      approval = undefined
    }

    // --- страж страны выхода (инвариант 2) ------------------------------------
    if (!l.started || now() - l.lastTurnAt > IDLE_RECHECK_MS || netSeen.get(l) !== netGeneration()) {
      const gen = netGeneration()
      const check = await netProbe('zcode')
      if (!check.ok) {
        emitL({
          sessionId: name, provider: 'zcode', kind: 'net.blocked',
          data: { reason: check.reason, loc: check.loc, mode: check.mode, guard: check.guard, ...(check.guardMode ? { guardMode: check.guardMode } : {}), turnId },
        })
        statusL('failed', { reason: 'net_blocked' })
        return fail('blocked_network', netRefusal(check))
      }
      netSeen.set(l, gen)
      l.netEnv = zcodeNetworkEnv(check)
    }

    // Стоп пришёл, пока шла проверка стража: ребёнка ещё нет — отменяем ход здесь.
    if (l.stopRequested) {
      l.stopRequested = false
      logger.info('ход отменён: стоп пришёл во время проверки стража', { session: name, turnId })
      return fail('interrupted', `ход ${turnId} отменён: агент остановлен до запуска процесса`)
    }

    l.busy = true
    statusL('working', { turnId })

    const done = new Promise<TurnOutcome>((resolve) => {
      let settled = false
      let sawResult: ResultSignal | null = null
      /** `turn.completed` без строки `result` (отмена): ею ход и закрывается на close. */
      let sawTurnEnd: TurnEndedSignal | null = null
      let child: ChildProcess | null = null
      /** Стоп-аборт хода; назначается после спавна (finish до его назначения безопасен). */
      let abort: ((message: string) => void) | null = null
      const textParts: string[] = []
      const splitter = createLineSplitter()
      let stderr = ''

      const mapper = createZcodeMapper({
        sessionId: name,
        onUnknown: (t) => logger.warn('незнакомое событие zcode — пропущено', { session: name, type: t }),
      })

      const finish = (outcome: TurnOutcome): void => {
        if (settled) return
        settled = true
        if (abort && l.turnAbort === abort) l.turnAbort = null
        l.busy = false
        l.lastTurnAt = now()
        if (child) {
          const c = child
          try { c.stdin?.end() } catch { /* закрыт */ }
          pendingKills.add(c)
          c.once('exit', () => { pendingKills.delete(c) })
          const backstop = setTimeout(() => { try { c.kill('SIGTERM') } catch { /* уже ушёл */ } }, 1500)
          backstop.unref?.()
          if (l.child === child) l.child = null
          child.stdout?.off('data', onData)
          child.stderr?.off('data', onErr)
          child.off('close', onClose)
          child.off('error', onError)
        }
        // Ход, снятый стопом, статус НЕ пишет: его пишет менеджер в stop().
        if (outcome.errorCode !== 'interrupted') {
          statusL(outcome.ok ? 'idle' : 'failed', {
            turnId,
            ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
            ...(!outcome.ok && outcome.message ? { message: redactString(outcome.message.slice(0, 2000)) } : {}),
          })
        }
        resolve(outcome)
      }

      /** Классификация stderr/кода выхода: вход → стоп провайдера, квота → limited, остальное — internal. */
      const classifyFailure = (fallback: string): { errorCode: string; message: string } => {
        const tail = stderr.trim().split('\n').slice(-3).join('\n').slice(0, 500)
        if (AUTH_FAIL_RE.test(tail)) {
          const msg = `zcode не пускает аккаунт — нужен вход: ${tail || 'см. pult doctor'}`
          blockProvider(name, msg)
          return { errorCode: 'provider_unavailable', message: msg }
        }
        if (QUOTA_RE.test(tail)) {
          emitL({ sessionId: name, provider: 'zcode', kind: 'limit.hit', data: { source: 'stderr', detail: tail } })
          statusL('limited', {})
          return { errorCode: 'provider_unavailable', message: `лимит/квота ZCode: ${tail || 'попробуй позже'}` }
        }
        if (NO_SESSION_RE.test(tail)) {
          // Самолечение: разговор, которого CLI не нашёл, забывается — следующий ход заведёт новый.
          logger.warn('разговора zcode нет — следующий ход начнёт его заново', { session: name, providerSessionId: l.providerSessionId, turnId })
          l.started = false
          return { errorCode: 'internal', message: `zcode не нашёл разговор (${tail || 'resume не удался'}) — следующая реплика заведёт его заново` }
        }
        return { errorCode: 'internal', message: `${fallback}${tail ? `: ${tail}` : ''}` }
      }

      const onSignal = (sig: ZcodeSignal): void => {
        if (settled) return
        switch (sig.kind) {
          case 'session_id':
            if (sig.id && sig.id !== l.providerSessionId) l.providerSessionId = sig.id
            l.started = true
            return
          case 'turn_started':
            return
          case 'turn_ended':
            sawTurnEnd = sig
            if (sig.text) textParts.push(sig.text)
            return
          case 'result': {
            sawResult = sig
            if (sig.text) textParts.push(sig.text)
            if (sig.sessionId && sig.sessionId !== l.providerSessionId) l.providerSessionId = sig.sessionId
            l.started = true
            if (!sig.ok) {
              const cls = classifyFailure(`ход завершился неуспехом (${sig.resultType ?? '?'})`)
              finish({ turnId, ok: false, errorCode: cls.errorCode, ...(textParts.length ? { text: textParts.join('\n') } : {}), message: cls.message })
              return
            }
            finish({ turnId, ok: true, ...(sig.text ? { text: sig.text } : textParts.length ? { text: textParts.join('\n') } : {}) })
            return
          }
        }
      }

      const onData = (chunk: Buffer): void => {
        let lines: string[]
        try { lines = splitter.push(chunk) } catch { return }
        for (const line of lines) {
          let native: unknown
          try { native = JSON.parse(line) } catch { continue }
          const mapped = mapper.push(native)
          for (const draft of mapped.drafts) emitL(draft)
          if (mapped.live && !gone()) for (const sig of mapped.live) opts.live?.(name, sig)
          for (const sig of mapped.signals) {
            if (settled) break
            onSignal(sig)
          }
          if (settled) return
        }
      }
      const onErr = (chunk: Buffer): void => { stderr += chunk.toString('utf8') }
      const onError = (e: Error): void => {
        if (child && l.child === child) l.child = null
        finish({ turnId, ok: false, errorCode: 'internal', message: `zcode не запустился: ${e.message}` })
      }
      const onClose = (): void => {
        if (l.child === child) l.child = null
        if (sawResult) {
          finish({ turnId, ok: sawResult.ok, ...(textParts.length ? { text: textParts.join('\n') } : {}) })
          return
        }
        // Отмена ходом CLI (SIGINT: turn.completed cancelled без result) или наш стоп — interrupted.
        if (l.stopRequested || sawTurnEnd?.resultType === 'cancelled') {
          finish({ turnId, ok: false, errorCode: 'interrupted', message: `ход ${turnId} прерван: агент остановлен` })
          return
        }
        // turn.completed был успешен, а строки result процесс не донёс — ответ засчитываем.
        if (sawTurnEnd?.ok && sawTurnEnd.text) {
          finish({ turnId, ok: true, text: sawTurnEnd.text })
          return
        }
        const cls = classifyFailure('zcode вышел без ответа')
        finish({ turnId, ok: false, errorCode: cls.errorCode, ...(textParts.length ? { text: textParts.join('\n') } : {}), message: cls.message })
      }

      // --- спавн ----------------------------------------------------------------
      try {
        // Промпт — аргументом `-p` (stdin-формата у CLI нет, ограничение маршрута A): реплика +
        // контекст режима, как у claude вторым блоком stdin-строки.
        const prompt = `${text}\n\n${approvalContext('zcode', approval, l.spec.broker)}`
        const argv = buildZcodeArgv({
          prompt,
          cwd: l.spec.cwd,
          ...(l.started && l.providerSessionId ? { resumeSessionId: l.providerSessionId } : {}),
          ...(approval ? { approval } : {}),
        })
        child = spawn(opts.bin, argv, {
          cwd: l.spec.cwd,
          env: buildChildEnv(process.env, { network: l.netEnv, extra: zcodeExtraEnv() }),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        // Шаг A: с каким уровнем ушёл процесс. Режим CLI в потоке не называет (`reported: null` — «не подтверждено»);
        // `--mode yolo` — полные права по знанию адаптера (`full`), процесс на ход — всегда новый (`fresh`).
        if (approval) l.childApproval = approval
        else delete l.childApproval
        opts.applied?.(name, { approval, reported: null, fresh: true, ...(approval === 'full' ? { full: true } : {}) })
      } catch (e) {
        logger.error('zcode не запустился: spawn бросил', { session: name, error: (e as Error).message })
        finish({ turnId, ok: false, errorCode: 'internal', message: `zcode не запустился: ${(e as Error).message.slice(0, 300)}` })
        return
      }
      l.child = child
      child.once('close', () => { closedChildren.add(child as ChildProcess) })
      child.stdin?.on('error', () => { /* труба закрылась под нами */ })
      // ПОСТОЯННЫЙ слушатель 'error': без него ENOENT на бинаре ронял бы весь демон.
      child.on('error', (e: Error) => {
        logger.error('дочерний процесс zcode не запустился', { session: name, bin: opts.bin, error: e.message })
      })
      logger.info('zcode запущен', { session: name, turnId, resume: l.started, pid: child.pid })
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onErr)
      child.on('close', onClose)
      child.on('error', onError)
      abort = (message: string): void => finish({ turnId, ok: false, errorCode: 'interrupted', message })
      l.turnAbort = abort
      // Процесс закрылся раньше подписки — ждать второго close нечего.
      if (closedChildren.has(child)) { onClose(); return }
      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
        killChild(l, 'SIGTERM')
        finish({ turnId, ok: false, errorCode: 'internal', message: 'процесс zcode не принимает реплику (stdin закрыт) — повтори её' })
      }
    })
    return { turnId, done }
  }

  return {
    provider: 'zcode',

    async startSession(spec) {
      if (providerBlocked !== null) throw Object.assign(new Error(providerBlocked), { code: 'provider_unavailable' })
      if (live.has(spec.name)) throw Object.assign(new Error(`сессия ${spec.name} уже есть`), { code: 'invalid_params' })
      // Placeholder: настоящий sess_… генерирует CLI, Пульт узнаёт его из потока первого хода.
      live.set(spec.name, {
        spec, providerSessionId: randomUUID(), started: false, child: null,
        lastTurnAt: 0, busy: false, closing: false, stopRequested: false, netEnv: {}, turnAbort: null,
      })
      return { name: spec.name, providerSessionId: randomUUID() } satisfies StartedSession
    },

    send(name, text, at) { return runTurn(need(name), text, at) },

    activeAccess(name) {
      // Шаг A: процесс хода жив — его права действуют (метка «полный» горит до его выхода). Тёплых процессов нет.
      const l = live.get(name)
      const child = l?.child
      if (!l || !child || closedChildren.has(child) || child.exitCode !== null || child.signalCode !== null) return null
      return l.childApproval ? { approval: l.childApproval } : {}
    },

    async respondPermission(_name, _requestId, _decision: PermissionDecision) {
      // Маршрут A: канала вопросов в Пульт у CLI нет — «спрашивать» ложится на guarded,
      // и запросов через брокер не приходит вовсе.
      throw Object.assign(new Error('у zcode (маршрут A) нет канала вопросов в Пульт'), { code: 'invalid_params' })
    },

    async interrupt(name) {
      const l = live.get(name)
      if (!l) return
      l.stopRequested = true
      const child = l.child
      if (child) {
        try { child.kill('SIGINT') } catch { /* уже мёртв */ }
        if (!await waitExit(child, INTERRUPT_GRACE_MS)) {
          try { child.stdin?.end() } catch { /* закрыт */ }
          try { child.kill('SIGTERM') } catch { /* уже мёртв */ }
          if (!await waitExit(child, INTERRUPT_KILL_MS)) {
            logger.warn('процесс не ушёл по SIGTERM — SIGKILL', { session: name, pid: child.pid })
            try { child.kill('SIGKILL') } catch { /* уже мёртв */ }
            await waitExit(child, INTERRUPT_KILL_MS)
          }
        }
        if (l.child === child) l.child = null
        pendingKills.delete(child)
      }
      l.turnAbort?.('ход прерван: агент остановлен')
      // `status.changed interrupted` пишет менеджер (stop()) — не здесь.
    },

    async resume(name, rec) {
      // Идемпотентно (менеджер зовёт перед КАЖДЫМ ходом): знакомую не трогаем, незнакомую
      // восстанавливаем из записи. providerSessionId в записи — только подтверждённый (его
      // пишет менеджер по session.started), поэтому `started` по нему честен.
      if (live.has(name)) return
      live.set(name, {
        spec: {
          name,
          cwd: rec.cwd,
          ...(rec.model ? { model: rec.model } : {}),
          ...(rec.effort ? { effort: rec.effort } : {}),
          mode: rec.mode,
          broker: true,
          ...(rec.approval ? { approval: rec.approval } : {}),
        },
        providerSessionId: rec.providerSessionId ?? randomUUID(),
        started: Boolean(rec.providerSessionId),
        child: null, lastTurnAt: 0, busy: false, closing: false, stopRequested: false, netEnv: {}, turnAbort: null,
      })
    },

    configure(name, next) {
      const l = live.get(name)
      if (!l) return 'next_turn'
      // Модели и усилия у zcode нет (у CLI нет флага): отказ и здесь, а не только в planConfigure
      // менеджера — адаптер не должен молча «принять» то, что не сможет передать CLI.
      if (next.model !== undefined || next.effort !== undefined) {
        throw Object.assign(new Error('у ZCode нет выбора модели и усилия — их задаёт аккаунт Z.AI'), { code: 'invalid_params' })
      }
      // Процесс всё равно на ход — «следующий ход» и есть граница применения.
      const spec = l.spec as unknown as Record<string, unknown>
      for (const k of ['approval'] as const) {
        if (next[k] === undefined) delete spec[k]
        else spec[k] = next[k]
      }
      return 'next_turn'
    },

    async close(name) {
      const l = live.get(name)
      if (!l) return
      l.closing = true
      const child = l.child
      killChild(l, 'SIGTERM')
      if (child) await waitExit(child, INTERRUPT_KILL_MS)
      live.delete(name)
      status(name, 'done', {})
    },

    blocked: () => (providerBlocked === null ? { blocked: false } : { blocked: true, reason: providerBlocked }),

    reset() {
      if (providerBlocked === null) return
      logger.info('остановка провайдера zcode снята', {})
      providerBlocked = null
    },

    async shutdown() {
      for (const l of [...live.values()]) {
        l.closing = true
        killChild(l, 'SIGTERM')
      }
      live.clear()
      for (const child of [...pendingKills]) {
        try { child.stdin?.end() } catch { /* закрыт */ }
        try { child.kill('SIGKILL') } catch { /* уже ушёл */ }
      }
      pendingKills.clear()
    },
  }
}
