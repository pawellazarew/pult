// Переводчик: события `zcode -p --output-format stream-json` → словарь Пульта.
//
// Форма потока (ИЗМЕРЕНО 02.11.2026, CLI 0.17.1, фикстуры test/fixtures/zcode): построчные
// конверты `{eventId, seq, sessionId, turnId?, timestamp, type, payload}` и ОДНА итоговая
// компактная строка `{"type":"result", …}`. Виды, которые мы видели:
//   session.titleUpdated (title = первые слова реплики — Пульт озаглавит лучше, пропускаем),
//   session.resumed, session.updated (мусорный: pendingInput, счётчики, model_request_*),
//   turn.started (модель из modelSelection), model.streaming ({kind, delta}: start,
//   reasoning_start/delta/end, text_start/delta/end, finish), tool.updated ({kind: scheduled |
//   started | result | batch}), turn.completed ({response, usage, resultType}), result.
//
// ЧЕМУ ЗДЕСЬ НЕ ВЕРЯТ:
//   * `turn.completed` — НЕ закрывает ход: за ним обязана прийти строка `result` с тем же
//     смыслом и расходом. Но при отмене (SIGINT, замер: exit 130) `result` НЕ приходит вовсе —
//     поэтому сигнал конца есть у обоих, а адаптер закрывается по ПЕРВОМУ.
//   * `session.updated` пропускается целиком: повторяет usage/context в трёх видах (у
//     model_request_* usage на запрос, у финального contextWindow, который расходится с
//     projection в result — 1M против 200k в одном замере). Расход берём из `result`.
//   * незнакомый тип события не роняет ничего: логируется ОДИН раз и выбрасывается.
//
// РЕДАКЦИЯ — как у claude: текст модели и входы инструментов идут через `redact` (инвариант 7).

import type { EventDraft } from '../../core/events.js'
import { redact, redactString } from '../../core/log.js'
import type { LiveSignal } from '../../sessions/phaseTracker.js'

export type ZcodeSignal =
  /** Любой конверт несёт sessionId сессии — первый поток событий доказывает, что разговор заводится. */
  | { kind: 'session_id'; id: string }
  /** `turn.started`: начался ход CLI (не закрывает ход Пульта). */
  | { kind: 'turn_started'; model: string | null }
  /**
   * `turn.completed`: ход CLI закончился. `ok = resultType === 'success'` (видели success и
   * cancelled; непроверенных значений не знаем — всё, кроме success, считается неуспехом).
   */
  | { kind: 'turn_ended'; ok: boolean; text: string | null; resultType: string | null }
  /** Итоговая строка `result`: авторитетный конец хода — с расходом и проекцией контекста. */
  | {
    kind: 'result'
    ok: boolean
    text: string | null
    resultType: string | null
    sessionId: string
    usage: ZcodeUsage | null
    contextUsed: number | null
    contextWindow: number | null
  }

/** Нормализованный расход `usage` из конвертов `turn.completed`/`result` (схема Aps.usage CLI). */
export interface ZcodeUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  totalTokens: number | null
  modelRequestCount: number | null
}

export interface MapOutput {
  drafts: EventDraft[]
  signals: ZcodeSignal[]
  live?: LiveSignal[]
}

export interface MapperOptions {
  /** Имя сессии Пульта — оно же `sessionId` конверта события. */
  sessionId: string
  /** Зовётся один раз на каждый незнакомый тип события. */
  onUnknown?: (type: string) => void
}

export interface ZcodeMapper {
  push(native: unknown): MapOutput
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function parseUsage(raw: unknown): ZcodeUsage | null {
  const u = obj(raw)
  if (!u) return null
  return {
    inputTokens: numOrNull(u['inputTokens']),
    outputTokens: numOrNull(u['outputTokens']),
    cacheReadTokens: numOrNull(u['cacheReadTokens']),
    cacheWriteTokens: numOrNull(u['cacheWriteTokens']),
    reasoningTokens: numOrNull(u['reasoningTokens']),
    totalTokens: numOrNull(u['totalTokens']),
    modelRequestCount: numOrNull(u['modelRequestCount']),
  }
}

/** Окно/занято из `projection` строки `result`; `null`-поля CLI допускает — тогда события нет. */
function contextDraft(base: { sessionId: string; provider: 'zcode' }, projection: unknown, model: string | null): EventDraft | null {
  const p = obj(projection)
  if (!p) return null
  const used = numOrNull(p['contextUsed'])
  const window = numOrNull(p['contextWindow'])
  if (used === null) return null
  return { ...base, kind: 'context.updated', data: { used, window, ...(model ? { model } : {}) } }
}

/**
 * `resultType`: `success` измерен, `cancelled` — отмена. У ИТОГОВОЙ строки `result` поля нет
 * вовсе (замер 02.11.2026) — «нет поля» значит успех: неуспех там выражается отсутствием самой
 * строки (отмена) или exit 1 без неё. Явный незнакомый результат честно считаем неуспехом.
 */
const resultOk = (resultType: string | null): boolean => resultType === null || resultType === 'success'

export function createZcodeMapper(opts: MapperOptions): ZcodeMapper {
  const sessionId = opts.sessionId
  const unknownSeen = new Set<string>()
  // Модель сессии: знает только `turn.started` (modelSelection.modelId, замер: "GLM-5.3"); она
  // же уходит в session.started и context.updated.
  let model: string | null = null
  let sessionStartedEmitted = false

  const unknown = (type: string): void => {
    if (unknownSeen.has(type)) return
    unknownSeen.add(type)
    opts.onUnknown?.(type)
  }

  const push = (native: unknown): MapOutput => {
    const out: MapOutput = { drafts: [], signals: [] }
    const ev = obj(native)
    if (!ev) { unknown('not-an-object'); return out }
    const base = { sessionId, provider: 'zcode' as const }
    const type = str(ev['type'])
    const payload = obj(ev['payload'])

    // Первый поток событий несёт sessionId разговора — он же единственное доказательство, что
    // разговор заводится на стороне CLI (аналог system/init у claude).
    const sid = str(ev['sessionId'])
    if (sid) out.signals.push({ kind: 'session_id', id: sid })

    switch (type) {
      case 'turn.started': {
        // Модель — в `intent.modelSelection.modelId` (замер: "GLM-5.3"); прямого поля на payload нет.
        const sel = obj(obj(payload?.['intent'])?.['modelSelection']) ?? obj(payload?.['modelSelection'])
        const m = str(sel?.['modelId'])
        if (m) model = m
        out.signals.push({ kind: 'turn_started', model })
        out.live = [{ kind: 'active' }]
        if (!sessionStartedEmitted) {
          sessionStartedEmitted = true
          out.drafts.push({
            ...base,
            kind: 'session.started',
            data: { providerSessionId: sid ?? null, ...(model ? { model } : {}), cwd: null, tools: null, mcpServers: [] },
          })
        }
        return out
      }

      case 'model.streaming': {
        const kind = str(payload?.['kind'])
        const delta = str(payload?.['delta']) ?? ''
        // Фаза хода — живыми сигналами, в журнал они не пишутся (0.3.5).
        if (kind === 'start') out.live = [{ kind: 'request' }]
        else if (kind === 'reasoning_start') out.live = [{ kind: 'thinking' }]
        else if (kind === 'reasoning_delta') { if (delta) out.live = [{ kind: 'reasoning', text: delta }] }
        else if (kind === 'text_delta') {
          if (delta) {
            out.drafts.push({ ...base, kind: 'message.delta', data: { text: redactString(delta) } })
            out.live = [{ kind: 'output' }]
          }
        }
        return out
      }

      case 'tool.updated': {
        const kind = str(payload?.['kind'])
        const toolCallId = str(payload?.['toolCallId'])
        if (!toolCallId) return out
        if (kind === 'scheduled') {
          out.drafts.push({
            ...base,
            kind: 'tool.called',
            data: { toolUseId: toolCallId, name: str(payload?.['toolName']) ?? 'tool', input: redact(obj(payload?.['input']) ?? {}) as Record<string, unknown> },
          })
        } else if (kind === 'result') {
          const res = obj(payload?.['result'])
          const content = res !== null ? str(res['content']) : null
          out.drafts.push({
            ...base,
            kind: 'tool.finished',
            data: {
              toolUseId: toolCallId,
              isError: res !== null && res['success'] !== true,
              content: content === null ? null : redactString(content),
            },
          })
        }
        // `started` дублирует scheduled в те же микросекунды, `batch` — сводка пачки: не события.
        return out
      }

      case 'turn.completed': {
        const text = str(payload?.['response'])
        const resultType = str(payload?.['resultType'])
        const ok = resultOk(resultType)
        out.signals.push({ kind: 'turn_ended', ok, text: text === null ? null : redactString(text), resultType })
        // Ответ модели целиком — из конверта хода: дельты уже ушли message.delta, а строка
        // `result` может не прийти вовсе (отмена). Здесь же расход хода (usage у обоих конвертов).
        if (text) out.drafts.push({ ...base, kind: 'message.done', data: { text: redactString(text), ...(model ? { model } : {}) } })
        const usage = parseUsage(payload?.['usage'])
        if (usage) {
          out.drafts.push({ ...base, kind: 'usage.updated', data: { source: 'result', usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_input_tokens: usage.cacheReadTokens,
            cache_creation_input_tokens: usage.cacheWriteTokens,
            reasoning_tokens: usage.reasoningTokens,
            ...(usage.modelRequestCount !== null ? { modelRequestCount: usage.modelRequestCount } : {}),
          } } })
        }
        return out
      }

      case 'result': {
        const text = str(ev['response'])
        const resultType = str(ev['resultType'])
        out.signals.push({
          kind: 'result',
          ok: resultOk(resultType),
          text: text === null ? null : redactString(text),
          resultType,
          sessionId: sid ?? '',
          usage: parseUsage(ev['usage']),
          contextUsed: numOrNull(obj(ev['projection'])?.['contextUsed']),
          contextWindow: numOrNull(obj(ev['projection'])?.['contextWindow']),
        })
        // Расход и контекст — авторитетные, из projection: у session.updated contextWindow
        // расходился с ним в одном замере (1M против 200k).
        const usage = parseUsage(ev['usage'])
        if (usage) {
          out.drafts.push({ ...base, kind: 'usage.updated', data: { source: 'result', usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_input_tokens: usage.cacheReadTokens,
            cache_creation_input_tokens: usage.cacheWriteTokens,
            reasoning_tokens: usage.reasoningTokens,
            ...(usage.modelRequestCount !== null ? { modelRequestCount: usage.modelRequestCount } : {}),
          } } })
        }
        const ctx = contextDraft(base, ev['projection'], model)
        if (ctx) out.drafts.push(ctx)
        return out
      }

      case 'session.titleUpdated':
      case 'session.resumed':
      case 'session.updated':
      case 'streamRecovery.updated':
        return out

      default:
        unknown(type ?? '?')
        return out
    }
  }

  return { push }
}
