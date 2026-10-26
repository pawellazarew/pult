// Брокер разрешений — «Inbox» демона.
//
// ЧТО ЭТО ТАКОЕ. Когда `claude` собирается сделать что-то, на что нужно разрешение, он не
// спрашивает терминал: он зовёт MCP-инструмент `mcp__pult__ask`. Тот инструмент — отдельный
// процесс (`pult mcp-ask`), который по сокету передаёт вопрос сюда и ЖДЁТ. Брокер кладёт
// вопрос в очередь, публикует событие `permission.requested` и держит обещание открытым,
// пока человек не ответит через `pult perm approve|deny`.
//
// ТРИ ПРАВИЛА, КОТОРЫЕ ДЕЛАЮТ ЭТО БЕЗОПАСНЫМ (инвариант 5):
//   1. Таймаут (по умолчанию 10 минут) отвечает ОТКАЗОМ, а не разрешением. Вопрос, на который
//      никто не ответил, — не согласие.
//   2. Остановка демона отвечает ОТКАЗОМ всем, кто ещё ждёт. Иначе заглушка висит на мёртвом
//      сокете, а `claude` — на ней.
//   3. Вход инструмента редактируется ПЕРЕД публикацией события, но решение возвращает
//      ИСХОДНЫЙ вход: `{"behavior":"allow"}` обязан нести `updatedInput`, и подсунуть туда
//      строку `<email>` вместо настоящего пути — значит сломать правку.
//      Раз показанное и исполняемое расходятся, карточка обязана это СКАЗАТЬ: флаг `concealed`
//      в событии и в `perm.list`. Иначе `ssh root@prod.example.com` выглядит как `ssh <email>`,
//      и человек разрешает команду, адресата которой не видел.
//   4. Спрашивающий умер — вопрос снимается ОТКАЗОМ (`signal` в `request`): заглушка `pult mcp-ask` живёт,
//      пока жив её `claude`, и её соединение закрывается вместе с ним. Без этого карточка висела в Inbox
//      до таймаута, а «Разрешить» на ней уходило в никуда (у Codex то же делает `cancelPermissions`).

import { randomBytes } from 'node:crypto'
import type { EventDraft } from '../core/events.js'
import { redact, redactString } from '../core/log.js'
import type { PermissionDecision, PermissionOffers } from '../adapters/types.js'

export const DEFAULT_PERM_TIMEOUT_MS = 600_000

export interface PermissionRequest {
  /** Имя сессии Пульта. */
  sessionId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** M8d: что провайдер предложил сверх «один раз» — по этому окно рисует кнопки, а `perm.resolve` сверяет scope. */
  offers?: PermissionOffers
  /** Адаптер сам скрыл или обрезал часть входа (Codex: `redact` и подрезка до брокера) — брокеру этого не видно. */
  concealed?: boolean
}

export interface PendingPermission {
  id: string
  sessionId: string
  toolName: string
  toolUseId?: string
  /** Вход в отредактированном виде — именно он уезжает в события и в CLI. */
  input: Record<string, unknown>
  /** M8d: «В этой сессии» / «Всегда …» — только то, что провайдер предложил на ЭТОТ запрос. */
  offers?: PermissionOffers
  /** Показанный вход НЕ равен исполняемому: фильтр секретов что-то заменил или длинное поле обрезано. */
  concealed?: true
  createdAt: string
  waitingMs: number
}

/** Чем снять вопрос, пока он ждёт: спрашивающий процесс завершился. */
export interface RequestOptions {
  /** Сработал — отказ с `reason` (по умолчанию «процесс агента завершился»), `by: provider_gone`. */
  signal?: AbortSignal
  reason?: string
}

/** Причина отказа по умолчанию, когда спрашивающий процесс (`pult mcp-ask` и его `claude`) умер. */
export const ASKER_GONE_REASON = 'процесс агента завершился'

export interface PermBroker {
  request(req: PermissionRequest, opts?: RequestOptions): Promise<PermissionDecision>
  list(sessionId?: string): PendingPermission[]
  /** false — такого id нет (уже решён, истёк или его не было). */
  resolve(id: string, decision: PermissionDecision, by?: string): boolean
  pendingCount(): number
  /** Отказать всем ожидающим и погасить таймеры. */
  shutdown(reason?: string): number
}

/** Scope, которого провайдер не предлагал: демон отвечает `invalid_params`, вопрос остаётся в Inbox. */
export class ScopeError extends Error {
  readonly code = 'invalid_params'
}

export interface BrokerOptions {
  emit(draft: EventDraft): void
  timeoutMs?: number
}

interface Entry {
  id: string
  req: PermissionRequest
  redacted: Record<string, unknown>
  concealed: boolean
  /**
   * M8d: предложения — тоже через `redact` (инвариант 7): префикс команды в «Всегда для …» — та же команда, и токен
   * в её аргументах не должен уехать в журнал. На провод уходит НЕ это, а исходная поправка, которую держит адаптер.
   */
  offers?: PermissionOffers
  createdAt: number
  createdAtIso: string
  timer: NodeJS.Timeout
  settle(decision: PermissionDecision, how: string): void
}

export function createBroker(opts: BrokerOptions): PermBroker {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PERM_TIMEOUT_MS
  const pending = new Map<string, Entry>()
  let seq = 0
  // Метка запуска брокера в id: номер `seq` начинается с 1 в каждом новом процессе демона. После
  // аварийного выхода (SIGKILL/OOM — `permission.resolved` не пишется) в журнале остаётся
  // неотвеченный `p1` прошлого запуска, а новый демон снова выдаёт `p1` — уже другому запросу,
  // возможно другой сессии. «Разрешить» на старой карточке окна или `pult perm approve p1` по
  // старой записи разрешили бы чужую операцию. С меткой старый id просто не найдётся.
  const run = randomBytes(3).toString('hex')

  const finish = (entry: Entry, decision: PermissionDecision, how: string): void => {
    if (!pending.has(entry.id)) return
    pending.delete(entry.id)
    clearTimeout(entry.timer)
    opts.emit({
      sessionId: entry.req.sessionId,
      provider: 'pult',
      kind: 'permission.resolved',
      data: {
        id: entry.id,
        toolName: entry.req.toolName,
        ...(entry.req.toolUseId ? { toolUseId: entry.req.toolUseId } : {}),
        decision: decision.behavior,
        // M8d: ширина «да» — в журнал, чтобы история показывала «в этой сессии» / «всегда для …». У отказа её нет.
        ...(decision.behavior === 'allow' ? { scope: decision.scope ?? 'once' } : {}),
        ...(decision.behavior === 'allow' && decision.scope === 'rule' && entry.offers?.rule
          ? { rule: { kind: entry.offers.rule.kind, label: entry.offers.rule.label } } : {}),
        by: how,
        ...(decision.message ? { message: decision.message } : {}),
        waitingMs: Date.now() - entry.createdAt,
      },
    })
    entry.settle(decision, how)
  }

  return {
    request(req, ro = {}) {
      const id = `p${++seq}-${run}`
      const createdAt = Date.now()
      const createdAtIso = new Date(createdAt).toISOString()
      const redacted = redact(req.input) as Record<string, unknown>
      const concealed = req.concealed === true || JSON.stringify(redacted) !== JSON.stringify(req.input)
      // Секрет в префиксе правила (`curl -H 'Authorization: …'`) — правило НЕ предлагаем вовсе (ревью M8d): карточка
      // показала бы `<redacted>`, а в правила Codex записался бы сам секрет — человек разрешил бы то, чего не видел.
      const ruleClean = req.offers?.rule ? redactString(req.offers.rule.label) === req.offers.rule.label : false
      const kept: PermissionOffers | undefined = req.offers
        ? { ...(req.offers.session ? { session: true as const } : {}), ...(req.offers.rule && ruleClean ? { rule: req.offers.rule } : {}) }
        : undefined
      const offers = kept && (kept.session || kept.rule) ? redact(kept) as PermissionOffers : undefined
      return new Promise<PermissionDecision>((resolve) => {
        const entry: Entry = {
          id,
          req,
          redacted,
          concealed,
          ...(offers ? { offers } : {}),
          createdAt,
          createdAtIso,
          timer: setTimeout(() => {
            finish(entry, {
              behavior: 'deny',
              message: `pult: никто не ответил за ${Math.round(timeoutMs / 1000)} с — отказ по таймауту`,
            }, 'timeout')
          }, timeoutMs),
          settle: (decision) => resolve(decision),
        }
        // `unref` намеренно НЕ зовём: пока кто-то ждёт решения, демон обязан быть жив.
        pending.set(id, entry)
        const gone = (): void => {
          finish(entry, { behavior: 'deny', message: `pult: ${ro.reason ?? ASKER_GONE_REASON}` }, 'provider_gone')
        }
        opts.emit({
          sessionId: req.sessionId,
          provider: 'pult',
          kind: 'permission.requested',
          data: {
            id,
            toolName: req.toolName,
            ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
            input: redacted,
            ...(offers ? { offers } : {}),
            ...(concealed ? { concealed: true } : {}),
          },
        })
        // Подписка — ПОСЛЕ `permission.requested`: в журнале отказ всегда идёт за вопросом, даже если
        // спрашивающий умер ещё до того, как вопрос дошёл до брокера.
        if (ro.signal) {
          if (ro.signal.aborted) { gone(); return }
          const signal = ro.signal
          signal.addEventListener('abort', gone, { once: true })
          const settle = entry.settle
          entry.settle = (decision, how) => { signal.removeEventListener('abort', gone); settle(decision, how) }
        }
      })
    },

    list(sessionId) {
      const now = Date.now()
      return [...pending.values()]
        .filter((e) => sessionId === undefined || e.req.sessionId === sessionId)
        .map((e) => ({
          id: e.id,
          sessionId: e.req.sessionId,
          toolName: e.req.toolName,
          ...(e.req.toolUseId ? { toolUseId: e.req.toolUseId } : {}),
          input: e.redacted,
          ...(e.offers ? { offers: e.offers } : {}),
          ...(e.concealed ? { concealed: true as const } : {}),
          createdAt: e.createdAtIso,
          waitingMs: now - e.createdAt,
        }))
    },

    resolve(id, decision, by = 'human') {
      const entry = pending.get(id)
      if (!entry) return false
      if (entry.req.toolName === 'requestUserInput' && decision.behavior === 'allow') {
        const questions = entry.req.input['questions']
        const answers = decision.answers
        if (!Array.isArray(questions) || !answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('нужны ответы на вопросы')
        const ids = new Set<string>()
        for (const q of questions) {
          if (!q || typeof q !== 'object' || typeof q.id !== 'string') throw new Error('некорректный вопрос')
          ids.add(q.id)
          const answer = answers[q.id]
          if (!answer || !Array.isArray(answer.answers) || !answer.answers.length || answer.answers.some((v) => typeof v !== 'string' || !v.trim())) throw new Error(`нужен ответ: ${q.id}`)
          if (Array.isArray(q.options) && q.options.length && !q.isOther && answer.answers.some((v) => !q.options.some((option: { label?: unknown }) => option.label === v))) throw new Error(`неизвестный вариант: ${q.id}`)
        }
        if (Object.keys(answers).some((id) => !ids.has(id))) throw new Error('неизвестный вопрос')
        finish(entry, { behavior: 'allow', answers }, by)
        return true
      }
      // Вопрос Claude (`AskUserQuestion`) идёт через инструмент разрешений, и голое «разрешить»
      // ответов не несёт — модель получала «The user did not answer the questions» (журнал
      // 07.10.2026). Ответы CLI берёт из `updatedInput.answers`: {текст вопроса: ответ}, у
      // множественного выбора — через ", " (замер 07.10.2026, CLI 2.1.291). Собираем его ЗДЕСЬ:
      // окно `updatedInput` не шлёт (оболочка его вырезает), только ответы, сверенные с вопросами.
      if (entry.req.toolName === 'AskUserQuestion' && decision.behavior === 'allow' && decision.answers !== undefined) {
        const questions = Array.isArray(entry.req.input['questions']) ? entry.req.input['questions'] as unknown[] : []
        const answers = decision.answers
        if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('нужны ответы на вопросы')
        const out: Record<string, string> = {}
        for (const raw of questions) {
          const q = raw && typeof raw === 'object' ? raw as { question?: unknown; multiSelect?: unknown } : {}
          if (typeof q.question !== 'string') throw new Error('некорректный вопрос')
          const a = answers[q.question]
          if (!a || !Array.isArray(a.answers) || !a.answers.length || a.answers.some((v) => typeof v !== 'string' || !v.trim())) throw new Error(`нужен ответ: ${q.question}`)
          if (q.multiSelect !== true && a.answers.length > 1) throw new Error(`один ответ: ${q.question}`)
          out[q.question] = a.answers.map((v) => v.trim()).join(', ')
        }
        if (Object.keys(answers).some((k) => !(k in out))) throw new Error('неизвестный вопрос')
        finish(entry, { behavior: 'allow', updatedInput: { ...entry.req.input, answers: out } }, by)
        return true
      }
      // M8d: «да» шире одного раза — только то, что провайдер предложил на этот запрос. Иначе отказ на входе:
      // молча понизить `--session` до одного раза значило бы соврать человеку, что спрашивать больше не будут.
      const scope = decision.behavior === 'allow' ? decision.scope ?? 'once' : 'once'
      if (scope === 'session' && !entry.offers?.session) throw new ScopeError('этот запрос не предлагает «разрешить в этой сессии»')
      if (scope === 'rule' && !entry.offers?.rule) throw new ScopeError('этот запрос не предлагает постоянного правила')
      // `allow` обязан нести `updatedInput`: без него Claude считает ответ неполным. Если
      // человек ничего не переписал — возвращаем ИСХОДНЫЙ (не отредактированный) вход.
      const final: PermissionDecision = decision.behavior === 'allow'
        ? { behavior: 'allow', ...(scope !== 'once' ? { scope } : {}), updatedInput: decision.updatedInput ?? entry.req.input }
        : { behavior: 'deny', message: decision.message ?? 'pult: отказано' }
      finish(entry, final, by)
      return true
    },

    pendingCount: () => pending.size,

    shutdown(reason = 'демон останавливается') {
      const n = pending.size
      for (const entry of [...pending.values()]) {
        finish(entry, { behavior: 'deny', message: `pult: ${reason}` }, 'shutdown')
      }
      return n
    },
  }
}
