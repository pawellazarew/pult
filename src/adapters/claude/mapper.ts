// Переводчик: родные события `claude --output-format stream-json` → словарь Пульта.
//
// ПОЧЕМУ отдельный файл с состоянием, а не чистая функция на событие: две вещи нельзя решить,
// глядя на одно событие. Первая — `tool_result` не говорит, чей он: инструмент это был или
// субагент; знает это только тот, кто видел парный `tool_use`. Вторая — `api_retry` опасен не
// сам по себе, а ТРЕМЯ ПОДРЯД. Поэтому здесь живут ровно два кусочка памяти: множество id
// субагентов и счётчик повторов.
//
// ЧЕМУ ЗДЕСЬ НЕ ВЕРЯТ:
//   * `result.subtype` — он «success» даже на провале входа (инвариант 4). Судим по `is_error`
//     и `terminal_reason`;
//   * повторный `system/init` посреди сессии не значит «новая сессия»: измерено 21.09.2026 —
//     после фонового субагента приходит ВТОРОЙ ход, и он начинается со своего `init`;
//   * незнакомый тип события не роняет ничего: он логируется ОДИН раз и выбрасывается.
//
// РЕДАКЦИЯ. Текст модели и входы инструментов проходят через `redact` из core/log.ts прежде,
// чем попасть в событие. Инвариант 7 требует этого от журнала демона, но событие — тот же
// журнал, только на диске в events/*.jsonl, и адрес почты из чужого файла не имеет права
// туда попасть.

import { stripBlobs } from '../../core/blobs.js'
import type { ImageCapture } from '../../core/images.js'
import type { EventDraft } from '../../core/events.js'
import { redact, redactString } from '../../core/log.js'
import type { LiveSignal } from '../../sessions/phaseTracker.js'

/**
 * Решающая строка «аккаунт или регион» (DELTA v0.5 §1). Повторы по ней запрещены.
 *
 * ОДНОЙ СТРОКИ МАЛО. Она ищется ТОЛЬКО в конверте ошибки, никогда в обычном тексте: агент,
 * который работает над самим Пультом, цитирует её в ответе дословно — и остановил бы целиком
 * весь провайдер, со всеми чужими сессиями, до ручного `provider.reset`. Что считается
 * конвертом ошибки, решают `accountBlockAssistant` и `accountBlockResult` ниже.
 */
export const ACCOUNT_BLOCK_RE = /disabled Claude subscription access/i

/**
 * `--resume` на разговор, которого нет. ИЗМЕРЕНО 21.09.2026 (фикстура 10): ход, убитый до
 * `system/init`, не оставляет на диске ничего (`~/.claude/projects/<cwd>/` даже не заводится),
 * и следующий `--resume <uuid>` отвечает НЕ-JSON строкой `No conversation found with session
 * ID: <uuid>` плюс `result` с `subtype: "error_during_execution"`, `errors[0]` с тем же
 * текстом, без полей `result` и `terminal_reason`.
 *
 * ОБРАТНЫЙ СЛУЧАЙ НЕ ИЗМЕРЕН: что отвечает CLI на `--session-id` с УЖЕ существующим
 * разговором, мы не снимали, и угадывать здесь нечего.
 */
export const NO_CONVERSATION_RE = /No conversation found with session ID/i

/** Статусы `rate_limit_event`, при которых ходить можно: всё остальное (`rejected`, …) — лимит. */
export const LIMIT_OK: ReadonlySet<string> = new Set(['allowed', 'allowed_warning'])

export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task'])

export type TurnSignal =
  | { kind: 'session_id'; id: string }
  /** Начался (в том числе САМ, после фонового субагента) новый ход: пришёл `system/init`. */
  | { kind: 'turn_started' }
  | {
    kind: 'result'
    ok: boolean
    terminalReason: string | null
    text: string | null
    startedInBackground: number
    apiErrorStatus: number | null
    /** `num_turns`: 0 — CLI не обращался к модели (разгрузка уведомлений, отказ до хода). */
    numTurns: number | null
    /**
     * `user_message_uuids`: на какие реплики из stdin этот `result` отвечает. CLI ставит поле,
     * только если реплика пришла со своим `uuid` (ИЗМЕРЕНО 08.10.2026, CLI 2.1.294, фикстуры 13
     * и 14). `null` — поля нет: старый CLI, реплика без `uuid` или ход, начатый самим CLI
     * (разгрузка уведомлений фоновых задач).
     */
    userMessageUuids: string[] | null
  }
  /**
   * `command_lifecycle`: судьба реплики из stdin, у которой был `uuid` — `queued` → `started` →
   * `completed`. ИЗМЕРЕНО 08.10.2026 (CLI 2.1.294, фикстура 13): разгрузка уведомлений идёт
   * МЕЖДУ `queued` и `started` нашей реплики.
   */
  | { kind: 'command'; uuid: string; state: string | null }
  /**
   * `system/task_notification`: CLI докладывает о фоновой задаче. На `--resume` после процесса,
   * снятого при живом фоновом субагенте, такое уведомление идёт ДО ответа на реплику (07.10.2026).
   */
  | { kind: 'task_notification'; status: string | null }
  /**
   * `system/background_tasks_changed`: ПОЛНЫЙ список живых фоновых задач процесса (субагенты и
   * фоновые команды). Пустой — всё доделано. ИЗМЕРЕНО 07.10.2026 (CLI 2.1.291): приходит на
   * каждый запуск и конец задачи; по нему, а не по накопительному `subagent_stats`, адаптер
   * решает, живёт ли процесс после ответа.
   */
  | { kind: 'background_tasks'; count: number }
  | { kind: 'retry_storm'; retries: number; lastError: unknown }
  | { kind: 'provider_blocked'; text: string }
  | { kind: 'limit'; status: string }

export interface MapOutput {
  drafts: EventDraft[]
  signals: TurnSignal[]
  /**
   * 0.3.5: живые сигналы фазы хода (src/sessions/phaseTracker.ts) — только своего разговора (без `parent_tool_use_id`).
   * В журнал не идут; текст размышлений — СЫРОЙ (редакция — при отдаче окну). Поле есть, только когда не пусто.
   */
  live?: LiveSignal[]
}

export interface MapperOptions {
  images?: ImageCapture
  /** Имя сессии Пульта — оно же `sessionId` конверта события. */
  sessionId: string
  /** Сколько подряд `api_retry` считаем штормом. Потолок из DELTA v0.5 §1 — три. */
  retryCeiling?: number
  /** Зовётся один раз на каждый незнакомый тип события. */
  onUnknown?: (type: string) => void
}

export interface ClaudeMapper {
  push(native: unknown): MapOutput
  /** Виденные id субагентов — нужны тесту и дереву. */
  agentIds(): ReadonlySet<string>
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Конверт `assistant`, в котором отказ платформы настоящий. ИЗМЕРЕНО 21.09.2026 (фикстура
 * `09-account-region-block.jsonl`): CLI ставит на конверт `error: "api_error"` и
 * `is_api_error_message: true`, а сам текст отказа кладёт обычным блоком `text`.
 */
const accountBlockAssistant = (ev: Record<string, unknown>): boolean =>
  str(ev['error']) !== null || ev['is_api_error_message'] === true

/**
 * Конверт `result`, в котором отказ платформы настоящий. Там же измерено: `is_error: true` и
 * `terminal_reason: "api_error"` (`subtype` при этом «success» — инвариант 4, ему не верим).
 * Проверяются ОБА поля: одного `is_error` хватило бы фикстуре, но `terminal_reason` — то,
 * что говорит ПОЧЕМУ, и отказ без `is_error` мимо него не проедет.
 */
const accountBlockResult = (isError: boolean, terminalReason: string | null): boolean =>
  isError || terminalReason === 'api_error'

/**
 * Сколько токенов в контексте после обращения к модели — подсказка этого обращения целиком:
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Так же считает
 * индикатор контекста самого Claude Code (`context_window.used_percentage` строки состояния —
 * «только входные токены, без output_tokens»): ответ модели попадёт в контекст следующей
 * подсказкой и будет посчитан там. ИЗМЕРЕНО на фикстурах: `usage` одинаков у всех конвертов
 * одного `message.id` (CLI режет ответ по блокам), поэтому повторы гасит сравнение с прошлым.
 * `0` — подсказки не было (синтетический конверт отказа в фикстурах 08/09): не событие.
 */
function promptTokens(usage: Record<string, unknown> | null): number | null {
  if (!usage) return null
  const n = (k: string): number => numOrNull(usage[k]) ?? 0
  const total = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens')
  return total > 0 ? total : null
}

/**
 * Окно модели из `result.modelUsage` — словаря «id модели → расход», где у каждой модели есть
 * `contextWindow` (ИЗМЕРЕНО: `"claude-haiku-4-5-20251001": {…, "contextWindow": 200000}`).
 * Моделей в словаре может быть несколько (субагент на другой модели), поэтому берётся ТА, что
 * отвечала в разговоре сессии: точное совпадение id, иначе ключ, начинающийся с него (суффикс
 * вида `[1m]` у модели с большим окном — НЕ ИЗМЕРЕНО, страховка), иначе единственная запись.
 */
function windowFromModelUsage(modelUsage: Record<string, unknown> | null, model: string | null): number | null {
  if (!modelUsage) return null
  const windowOf = (k: string): number | null => {
    const w = numOrNull(obj(modelUsage[k])?.['contextWindow'])
    return w !== null && w > 0 ? w : null
  }
  const keys = Object.keys(modelUsage).filter((k) => windowOf(k) !== null)
  if (model !== null) {
    if (keys.includes(model)) return windowOf(model)
    const prefixed = keys.find((k) => k.startsWith(model))
    if (prefixed !== undefined) return windowOf(prefixed)
  }
  return keys.length === 1 ? windowOf(keys[0] as string) : null
}

export function createClaudeMapper(opts: MapperOptions): ClaudeMapper {
  const sessionId = opts.sessionId
  const ceiling = opts.retryCeiling ?? 3
  const agentIds = new Set<string>()
  const unknownSeen = new Set<string>()
  let retries = 0
  // ИЗМЕРЕНО: `system/init` приходит на КАЖДЫЙ ход, в том числе на второй ход тёплого
  // процесса и на ход-уведомление после фонового субагента. `session.started` при этом
  // событие о СЕССИИ, а не о ходе: второй раз его слать нельзя — свёртка статуса по нему
  // сбрасывает сессию в `idle` посреди работы.
  let sessionStartedEmitted = false
  // Контекстное окно СВОЕГО разговора (`context.updated`). Окно модели приходит только в
  // `result`, а подсказка — с каждой репликой, поэтому помнятся обе половины и модель.
  // Реплики субагентов (`parent_tool_use_id`) не трогают ни одну: у субагента своё окно.
  let ctxUsed: number | null = null
  let ctxWindow: number | null = null
  let ctxModel: string | null = null
  let ctxSent: { used: number; window: number | null } | null = null

  const contextDraft = (base: Pick<EventDraft, 'sessionId' | 'provider'>): EventDraft | null => {
    if (ctxUsed === null) return null
    if (ctxSent && ctxSent.used === ctxUsed && ctxSent.window === ctxWindow) return null
    ctxSent = { used: ctxUsed, window: ctxWindow }
    return { ...base, kind: 'context.updated', data: { used: ctxUsed, window: ctxWindow, model: ctxModel } }
  }

  const unknown = (type: string): void => {
    if (unknownSeen.has(type)) return
    unknownSeen.add(type)
    opts.onUnknown?.(type)
  }

  const push = (native: unknown): MapOutput => {
    const out: MapOutput = { drafts: [], signals: [] }
    const ev = obj(native)
    if (!ev) { unknown('not-an-object'); return out }
    const type = str(ev['type'])
    const parentId = str(ev['parent_tool_use_id']) ?? undefined
    const base = { sessionId, provider: 'claude' as const, ...(parentId ? { parentId } : {}) }

    // Любое СОДЕРЖАТЕЛЬНОЕ событие сбрасывает счётчик повторов: транспорт ожил.
    if (type === 'assistant' || type === 'user' || type === 'stream_event') retries = 0

    switch (type) {
      case 'system': {
        const subtype = str(ev['subtype'])
        if (subtype === 'init') {
          const id = str(ev['session_id'])
          if (id) out.signals.push({ kind: 'session_id', id })
          out.signals.push({ kind: 'turn_started' })
          if (!parentId) out.live = [{ kind: 'active' }]
          if (sessionStartedEmitted) return out
          sessionStartedEmitted = true
          out.drafts.push({
            ...base,
            kind: 'session.started',
            data: {
              providerSessionId: id ?? null,
              model: str(ev['model']),
              cwd: str(ev['cwd']),
              tools: Array.isArray(ev['tools']) ? (ev['tools'] as unknown[]).length : 0,
              mcpServers: ev['mcp_servers'] ?? [],
            },
          })
          return out
        }
        if (subtype === 'api_retry') {
          retries += 1
          if (retries >= ceiling) {
            out.signals.push({ kind: 'retry_storm', retries, lastError: ev['error'] ?? null })
            retries = 0
          }
          return out
        }
        if (subtype === 'task_notification') {
          out.signals.push({ kind: 'task_notification', status: str(ev['status']) })
          return out
        }
        if (subtype === 'background_tasks_changed') {
          const tasks = Array.isArray(ev['tasks']) ? (ev['tasks'] as unknown[]).map((t) => {
            const o = obj(t)
            const description = o ? str(o['description']) : null
            return { id: o ? str(o['task_id']) : null, type: o ? str(o['task_type']) : null, description: description === null ? null : redactString(description) }
          }) : []
          out.signals.push({ kind: 'background_tasks', count: tasks.length })
          out.drafts.push({ ...base, kind: 'background.changed', data: { count: tasks.length, tasks } })
          return out
        }
        // Жизненный цикл отдельной фоновой задачи: старт, ход, правка статуса. Список целиком
        // приходит в `background_tasks_changed`, текст субагента — через --forward-subagent-text.
        if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_updated') return out
        // `status` и `thinking_tokens` в словарь не переводятся: они не меняют ни статус, ни
        // содержимое, а поток ими забит.
        if (subtype !== 'status' && subtype !== 'thinking_tokens') unknown(`system/${subtype ?? '?'}`)
        return out
      }

      case 'stream_event': {
        const inner = obj(ev['event'])
        if (!inner) return out
        // 0.3.5: фаза хода. Новое обращение к модели, начало блока размышлений и их текст — живыми сигналами:
        // в журнал они не пишутся. Пустой `thinking_delta` (размышления скрыты) — без текста: строка просто «думает».
        if (!parentId) {
          const it = str(inner['type'])
          if (it === 'message_start') { out.live = [{ kind: 'request' }]; return out }
          if (it === 'content_block_start') {
            const bt = str(obj(inner['content_block'])?.['type'])
            if (bt === 'thinking' || bt === 'redacted_thinking') out.live = [{ kind: 'thinking' }]
            return out
          }
          if (it === 'content_block_delta') {
            const dl = obj(inner['delta'])
            const thought = dl && dl['type'] === 'thinking_delta' ? str(dl['thinking']) : null
            if (thought) { out.live = [{ kind: 'reasoning', text: thought }]; return out }
          }
        }
        if (inner['type'] !== 'content_block_delta') return out
        const delta = obj(inner['delta'])
        if (!delta || delta['type'] !== 'text_delta') return out
        const text = str(delta['text'])
        if (text === null) return out
        out.drafts.push({
          ...base,
          kind: 'message.delta',
          data: { text: redactString(text), index: numOrNull(inner['index']) },
        })
        return out
      }

      case 'assistant': {
        const msg = obj(ev['message'])
        const blocks = msg && Array.isArray(msg['content']) ? (msg['content'] as unknown[]) : []
        const model = msg ? str(msg['model']) : null
        // Отказ платформы приходит именно так: `error` на конверте плюс текст в содержимом.
        const errName = str(ev['error'])
        // Решающая строка ищется ТОЛЬКО в конверте ошибки: в обычном ответе она значит, что
        // агент про неё РАССКАЗЫВАЕТ (например, работая над самим Пультом), а не что отказ
        // случился. Без этой калитки такой ответ останавливал провайдер целиком.
        const blockEnvelope = accountBlockAssistant(ev)
        for (const raw of blocks) {
          const b = obj(raw)
          if (!b) continue
          const bt = str(b['type'])
          if (bt === 'text') {
            const text = str(b['text']) ?? ''
            if (blockEnvelope && ACCOUNT_BLOCK_RE.test(text)) out.signals.push({ kind: 'provider_blocked', text })
            out.drafts.push({ ...base, kind: 'message.done', data: { text: redactString(text), ...(model ? { model } : {}), ...(errName ? { error: errName } : {}) } })
            continue
          }
          if (bt !== 'tool_use') continue
          const id = str(b['id'])
          const name = str(b['name']) ?? 'tool'
          const input = obj(b['input']) ?? {}
          if (id === null) continue
          if (SUBAGENT_TOOL_NAMES.has(name)) {
            agentIds.add(id)
            out.drafts.push({
              ...base,
              kind: 'agent.spawned',
              data: {
                toolUseId: id,
                name,
                subagentType: str(input['subagent_type']),
                description: str(input['description']),
                ...(model ? { model } : {}),
              },
            })
          } else {
            out.drafts.push({
              ...base,
              kind: 'tool.called',
              data: { toolUseId: id, name, input: redact(input) as Record<string, unknown> },
            })
          }
        }
        // Контекст — только своего разговора: у реплики субагента `parentId` есть.
        const used = parentId ? null : promptTokens(msg ? obj(msg['usage']) : null)
        if (used !== null) {
          // Другая модель — другое окно: прошлое до её `result` не годится.
          if (model !== null && ctxModel !== null && model !== ctxModel) ctxWindow = null
          if (model !== null) ctxModel = model
          ctxUsed = used
          const ctx = contextDraft(base)
          if (ctx) out.drafts.push(ctx)
        }
        return out
      }

      case 'user': {
        const msg = obj(ev['message'])
        const blocks = msg && Array.isArray(msg['content']) ? (msg['content'] as unknown[]) : []
        for (const raw of blocks) {
          const b = obj(raw)
          if (!b || str(b['type']) !== 'tool_result') continue
          const id = str(b['tool_use_id'])
          if (id === null) continue
          const isError = b['is_error'] === true
          const images = opts.images?.capture(b['content']) ?? []
          out.drafts.push({
            ...base,
            kind: agentIds.has(id) ? 'agent.finished' : 'tool.finished',
            // Base64 заменяется заглушкой, сохранённые изображения передаются отдельными небольшими ссылками.
            data: { toolUseId: id, isError, content: redact(stripBlobs(b['content'])), ...(images.length ? { images } : {}) },
          })
        }
        return out
      }

      case 'rate_limit_event': {
        const info = obj(ev['rate_limit_info'])
        if (!info) return out
        const windows = obj(info['unifiedWindows']) ?? {}
        const five = obj(windows['five_hour'])
        const seven = obj(windows['seven_day'])
        const status = str(info['status']) ?? 'unknown'
        const data = {
          source: 'rate_limit_event',
          status,
          rateLimitType: str(info['rateLimitType']),
          resetsAt: numOrNull(info['resetsAt']),
          isUsingOverage: info['isUsingOverage'] === true,
          windows: {
            five_hour: five ? { utilization: numOrNull(five['utilization']), resetsAt: numOrNull(five['resetsAt']) } : null,
            seven_day: seven ? { utilization: numOrNull(seven['utilization']), resetsAt: numOrNull(seven['resetsAt']) } : null,
          },
        }
        out.drafts.push({ ...base, kind: 'usage.updated', data })
        // `allowed_warning` — ПРЕДУПРЕЖДЕНИЕ, а не лимит: окно перешло порог (замер 07.10.2026 —
        // недельное на 75%), работать можно. Пока оно считалось лимитом, сессия становилась
        // `limited`, лента писала «лимит исчерпан, сброс через 3 дня», а окно запирало ввод.
        if (!LIMIT_OK.has(status)) {
          out.drafts.push({ ...base, kind: 'limit.hit', data })
          out.signals.push({ kind: 'limit', status })
        }
        return out
      }

      case 'result': {
        const usage = obj(ev['usage'])
        const stats = obj(ev['subagent_stats'])
        // `permission_denials` — собственный учёт CLI: что он спросил и получил отказ. Это
        // единственная сверка со следом брокера (`permission.requested`/`permission.resolved`):
        // разойдутся — значит через хозяина разрешений прошло что-то мимо очереди.
        // `tool_input` несёт пути и команды, поэтому идёт через `redact`, как любой вход.
        const denials = Array.isArray(ev['permission_denials'])
          ? (ev['permission_denials'] as unknown[]).map((d) => {
            const o = obj(d)
            if (!o) return { toolName: null, toolUseId: null, input: null }
            return {
              toolName: str(o['tool_name']),
              toolUseId: str(o['tool_use_id']),
              input: redact(o['tool_input']),
            }
          })
          : []
        const text = str(ev['result'])
        const isError = ev['is_error'] === true
        const terminalReason = str(ev['terminal_reason'])
        // ИНВАРИАНТ 4: судим по is_error и terminal_reason, НИКОГДА по subtype.
        const ok = !isError && (terminalReason === null || terminalReason === 'completed')
        // Та же калитка, что и у `assistant`: успешный ход, пересказавший решающую строку,
        // провайдер не останавливает.
        if (text !== null && accountBlockResult(isError, terminalReason) && ACCOUNT_BLOCK_RE.test(text)) {
          out.signals.push({ kind: 'provider_blocked', text })
        }
        // ИЗМЕРЕНО 21.09.2026 (фикстура 10): у `subtype: "error_during_execution"` поля
        // `result` НЕТ ВОВСЕ, а причина лежит в `errors[]`. Без этой подмены `pult agent
        // prompt --wait` печатал «ход не удался: internal — » с пустым хвостом, и человек
        // не видел ни слова о том, что случилось. Берём только строки: форма остальных
        // элементов не измерена.
        const errors = Array.isArray(ev['errors'])
          ? (ev['errors'] as unknown[]).filter((e): e is string => typeof e === 'string')
          : []
        const message = text ?? (!ok && errors.length ? errors.join('; ') : null)
        out.drafts.push({
          ...base,
          kind: 'usage.updated',
          data: {
            source: 'result',
            totalCostUsd: numOrNull(ev['total_cost_usd']),
            durationMs: numOrNull(ev['duration_ms']),
            numTurns: numOrNull(ev['num_turns']),
            permissionDenials: denials,
            usage: usage
              ? {
                input_tokens: numOrNull(usage['input_tokens']),
                cache_creation_input_tokens: numOrNull(usage['cache_creation_input_tokens']),
                cache_read_input_tokens: numOrNull(usage['cache_read_input_tokens']),
                output_tokens: numOrNull(usage['output_tokens']),
              }
              : null,
          },
        })
        // Окно модели известно только здесь. `result.usage` для контекста НЕ годится: это
        // сумма всех обращений хода (фикстура 04: input 26 = 10 + 8 + 8), а не одна подсказка.
        const window = windowFromModelUsage(obj(ev['modelUsage']), ctxModel)
        if (window !== null) {
          ctxWindow = window
          const ctx = contextDraft(base)
          if (ctx) out.drafts.push(ctx)
        }
        out.signals.push({
          kind: 'result',
          ok,
          terminalReason,
          text: message === null ? null : redactString(message),
          startedInBackground: stats ? (numOrNull(stats['started_in_background']) ?? 0) : 0,
          apiErrorStatus: numOrNull(ev['api_error_status']),
          numTurns: numOrNull(ev['num_turns']),
          userMessageUuids: Array.isArray(ev['user_message_uuids'])
            ? (ev['user_message_uuids'] as unknown[]).filter((u): u is string => typeof u === 'string')
            : null,
        })
        return out
      }

      // Служебное событие о реплике из stdin: в словарь Пульта не переводится, нужно ходу.
      case 'command_lifecycle': {
        const uuid = str(ev['command_uuid'])
        if (uuid !== null) out.signals.push({ kind: 'command', uuid, state: str(ev['state']) })
        return out
      }

      default:
        unknown(type ?? '?')
        return out
    }
  }

  return { push, agentIds: () => agentIds }
}
