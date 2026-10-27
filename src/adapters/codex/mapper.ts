// Переводчик: уведомления `codex app-server` → словарь событий Пульта + сигналы хода.
// Один экземпляр на СЕССИЮ (не на процесс): процесс общий, а память о субагентах и о том,
// что уже сказано, — своя у каждого треда.
//
// ЧЕМУ ЗДЕСЬ НЕ ВЕРЯТ (всё измерено спайком 20.09.2026 и пробой 21.09.2026):
//   * `turn/completed.turn.items` — НЕ источник текста хода: `itemsView` был `summary` в B1 и
//     `notLoaded` с пустым `items` в B2 (ход с разрешением). Текст собирается из
//     `item/completed` с `type: "agentMessage"`, и только из них;
//   * `collab_tool_call` — устаревшее имя, его в протоколе 0.155 нет вовсе: тип элемента
//     `collabAgentToolCall`, инструменты camelCase (`spawnAgent`, `wait`, `closeAgent`, …);
//   * `subAgentActivity` с `kind: "completed"` приходит с ДРУГИМ `id`
//     (`subagent-completed-<turnId>`), чем `kind: "started"` (`call_…`). Закрывать узел дерева
//     по `id` нельзя — только по `agentThreadId`, для этого здесь и живёт `agentNodeByThread`;
//   * сбой сети — это уведомление `error` с `willRetry: true`, а не ошибка JSON-RPC и не
//     `turn.status: "failed"`. Считать попытки обязан клиент;
//   * лимит виден МАШИННО: `error.codexErrorInfo` — размеченное объединение, среди строковых
//     вариантов есть `usageLimitExceeded` и `rateLimitExceeded`. Английский текст оставлен
//     запасным признаком для серверов постарше, а не основным.
//
// РЕДАКЦИЯ: весь чужой текст (реплики модели, команды, пути, сообщения об ошибках) проходит
// через `redact`/`redactString` — инвариант 7 требует этого и от журнала, и от событий.

import { stripBlobs } from '../../core/blobs.js'
import type { ImageCapture } from '../../core/images.js'
import type { EventDraft } from '../../core/events.js'
import { redact, redactString } from '../../core/log.js'
import type { LiveSignal } from '../../sessions/phaseTracker.js'

/**
 * Тред не возобновляем, пока на нём не было ни одного хода. ИЗМЕРЕНО 21.09.2026 пробой В3:
 * `thread/start` возвращает `thread.path` (`~/.codex/sessions/.../rollout-*.jsonl`), но файла
 * по этому пути НЕТ ни сразу, ни через 2 с, ни после выхода процесса, и свежий app-server
 * отвечает на `thread/resume` ровно этой строкой. Она же — сигнал самолечения: забыть тред и
 * завести новый (см. `adapter.ts`).
 */
export const NO_ROLLOUT_RE = /no rollout found for thread id/i

/** Запасной признак лимита для серверов, где нет `codexErrorInfo`. ИЗМЕРЕНО 21.09.2026. */
export const USAGE_LIMIT_RE = /hit your usage limit/i

/** Строковые варианты `codexErrorInfo`, означающие лимит: повторять нечего, ход мёртв. */
export const LIMIT_ERROR_INFO: ReadonlySet<string> = new Set(['usageLimitExceeded', 'rateLimitExceeded'])

/** Типы элементов, которые в дерево и в текст не идут вовсе. */
const QUIET_ITEM_TYPES: ReadonlySet<string> = new Set(['userMessage', 'hookPrompt', 'reasoning', 'plan'])

/** Шумные уведомления, которые мы осознанно не переводим (их же гасит optOut при старте). */
const QUIET_METHODS: ReadonlySet<string> = new Set([
  'thread/started', 'thread/status/changed', 'thread/goal/cleared', 'thread/goal/updated',
  'thread/name/updated', 'thread/settings/updated', 'turn/diff/updated', 'turn/plan/updated',
  'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/fileChange/patchUpdated',
  'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta',
  'item/plan/delta', 'item/mcpToolCall/progress', 'command/exec/outputDelta', 'process/outputDelta',
  'process/exited', 'item/commandExecution/terminalInteraction', 'serverRequest/resolved',
  'mcpServer/startupStatus/updated', 'hook/started', 'hook/completed', 'account/updated',
  'remoteControl/status/changed', 'thread/compacted',
  // Эти два адаптер разбирает САМ, до переводчика: они про аккаунт и про протокол целиком,
  // а не про тред. Сюда они попадают только при проигрывании записи целиком.
  'account/rateLimits/updated', 'deprecationNotice',
])

export type CodexSignal =
  /** Ход НАЧАЛСЯ на сервере. Только с этого момента тред возобновляем — см. `NO_ROLLOUT_RE`. */
  | { kind: 'turn_started'; providerTurnId: string }
  | { kind: 'turn_completed'; providerTurnId: string; status: string; errorMessage: string | null; errorInfo: string | null }
  /** Модель сказала текст (завершённый `agentMessage` СВОЕГО треда). */
  | { kind: 'text'; text: string; phase: string | null }
  /** `error` с `willRetry: true` — сеть моргнула, сервер сам повторяет. */
  | { kind: 'retry'; message: string; details: string | null }
  /** `error` с `willRetry: false` — ход мёртв. */
  | { kind: 'failed'; message: string; info: string | null }
  /** Лимит аккаунта: повторов нет, ход мёртв, статус `limited`. */
  | { kind: 'limit'; message: string; info: string }
  | { kind: 'subagent_started'; nodeId: string; agentThreadId: string; agentPath: string | null }
  | { kind: 'subagent_finished'; agentThreadId: string }
  | { kind: 'tokens'; input: number | null; output: number | null; cached: number | null }
  | { kind: 'warning'; text: string }

export interface MapOutput {
  drafts: EventDraft[]
  signals: CodexSignal[]
  /**
   * 0.3.5: живые сигналы фазы хода (src/sessions/phaseTracker.ts) — только своего треда. В журнал не идут: начало
   * хода на сервере, начало элемента `reasoning` и текст СВОДКИ размышлений (`summaryTextDelta`, сырой — редакция при
   * отдаче окну). Сырой текст размышлений (`item/reasoning/textDelta`) не показывается: окну хватает сводки, а
   * два потока одного элемента задвоили бы текст. Поле есть, только когда не пусто.
   */
  live?: LiveSignal[]
}

export interface CodexMapperOptions {
  images?: ImageCapture
  /** Имя сессии Пульта — оно же `sessionId` конверта события. */
  sessionId: string
  /**
   * Модель сессии, если её задали на старте. Настоящую адаптер узнаёт из ответа
   * `thread/start`/`thread/resume` (поле `model` там обязательное) и передаёт в `setModel`.
   */
  model?: string | null
  /** Зовётся ОДИН раз на каждый незнакомый метод или тип элемента. */
  onUnknown?: (what: string) => void
}

export interface PushContext {
  /**
   * Событие пришло с треда СУБАГЕНТА. Значение — id узла дерева (тот самый `call_…` из
   * `subAgentActivity/started`), под которым субагент уже висит в дереве.
   */
  parentId?: string
}

export interface CodexMapper {
  push(method: string, params: Record<string, unknown>, ctx?: PushContext): MapOutput
  /** Модель треда из ответа `thread/start`/`thread/resume` — она уезжает в `context.updated`. */
  setModel(model: string | null): void
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * `codexErrorInfo` — размеченное объединение: либо строка (`usageLimitExceeded`,
 * `unauthorized`, …), либо объект с ЕДИНСТВЕННЫМ ключом-именем варианта
 * (`{responseStreamDisconnected: {...}}`). Нам нужно только имя варианта.
 */
export function errorInfoName(v: unknown): string | null {
  if (typeof v === 'string') return v
  const o = obj(v)
  if (!o) return null
  const keys = Object.keys(o)
  return keys.length ? (keys[0] as string) : null
}

/**
 * Сколько токенов в контексте СВОЕГО треда — по тому же правилу, что индикатор контекста
 * самого Codex CLI: `TokenUsage::tokens_in_context_window()` в codex-rs (`protocol.rs`) берёт
 * ПОСЛЕДНЕЕ обращение (`last`, не накопленный `total`) и вычитает из `total_tokens` токены
 * рассуждения — рассуждения прошлых ходов в контекст следующего не попадают. Свой «базовый»
 * вычет (12k на системную подсказку), которым TUI нормирует «% осталось», здесь не делается:
 * показываем сырую занятость, как у Claude. ПО ПАМЯТИ ОБ ИСХОДНИКАХ, не измерено пробой:
 * в записях спайка `reasoningOutputTokens` всегда 0, и разница не видна.
 */
function contextTokens(last: Record<string, unknown>): number | null {
  const total = num(last['totalTokens'])
  if (total === null) return null
  const used = total - (num(last['reasoningOutputTokens']) ?? 0)
  return used > 0 ? used : null
}

export function createCodexMapper(opts: CodexMapperOptions): CodexMapper {
  const sessionId = opts.sessionId
  const agentNodeByThread = new Map<string, string>()
  const unknownSeen = new Set<string>()
  // Контекстное окно своего треда: модель, последнее известное окно и что уже отправлено —
  // одинаковое значение второй раз не пишется.
  let model: string | null = opts.model ?? null
  let ctxWindow: number | null = null
  let ctxSent: { used: number; window: number | null } | null = null

  const unknown = (what: string): void => {
    if (unknownSeen.has(what)) return
    unknownSeen.add(what)
    opts.onUnknown?.(what)
  }

  const push = (method: string, params: Record<string, unknown>, ctx: PushContext = {}): MapOutput => {
    const out: MapOutput = { drafts: [], signals: [] }
    const base = {
      sessionId,
      provider: 'codex' as const,
      ...(ctx.parentId ? { parentId: ctx.parentId } : {}),
    }

    switch (method) {
      case 'turn/started': {
        const turn = obj(params['turn'])
        const id = turn ? str(turn['id']) : null
        if (id) out.signals.push({ kind: 'turn_started', providerTurnId: id })
        if (!ctx.parentId) out.live = [{ kind: 'active' }]
        return out
      }

      case 'item/reasoning/summaryTextDelta': {
        const delta = str(params['delta'])
        if (!ctx.parentId && delta) out.live = [{ kind: 'reasoning', text: delta }]
        return out
      }

      // Новая часть сводки — с новой строки, а не впритык к прошлой.
      case 'item/reasoning/summaryPartAdded': {
        if (!ctx.parentId && num(params['summaryIndex']) !== 0) out.live = [{ kind: 'reasoning', text: '\n\n' }]
        return out
      }

      case 'turn/completed': {
        const turn = obj(params['turn'])
        if (!turn) return out
        const err = obj(turn['error'])
        out.signals.push({
          kind: 'turn_completed',
          providerTurnId: str(turn['id']) ?? '',
          status: str(turn['status']) ?? 'unknown',
          errorMessage: err ? redactString(str(err['message']) ?? '') : null,
          errorInfo: err ? errorInfoName(err['codexErrorInfo']) : null,
        })
        return out
      }

      case 'item/agentMessage/delta': {
        const delta = str(params['delta'])
        if (delta === null) return out
        out.drafts.push({ ...base, kind: 'message.delta', data: { text: redactString(delta), itemId: str(params['itemId']) } })
        return out
      }

      case 'item/started':
      case 'item/completed': {
        const item = obj(params['item'])
        if (!item) return out
        const done = method === 'item/completed'
        const type = str(item['type']) ?? '?'
        const id = str(item['id'])
        if (type === 'reasoning' && !done && !ctx.parentId) out.live = [{ kind: 'thinking' }]
        if (QUIET_ITEM_TYPES.has(type)) return out

        if (type === 'agentMessage') {
          if (!done) return out
          const text = str(item['text']) ?? ''
          const phase = str(item['phase'])
          out.drafts.push({
            ...base,
            kind: 'message.done',
            data: { text: redactString(text), ...(phase ? { phase } : {}), itemId: id },
          })
          // Текст РЕБЁНКА в ответ родителя не попадает: родитель перескажет его сам
          // (измерено, B4: «Subagent reply: PING»). Иначе ответ хода двоился бы.
          if (!ctx.parentId) out.signals.push({ kind: 'text', text, phase })
          return out
        }

        if (type === 'subAgentActivity') {
          const kind = str(item['kind'])
          const agentThreadId = str(item['agentThreadId'])
          const agentPath = str(item['agentPath'])
          if (!agentThreadId || id === null) return out
          if (kind === 'started') {
            if (done || agentNodeByThread.has(agentThreadId)) return out
            agentNodeByThread.set(agentThreadId, id)
            out.drafts.push({
              ...base,
              kind: 'agent.spawned',
              // `agentPath` — строка от сервера (путь агента вроде `/root/ping`): в событие
              // она идёт только через редакцию, как любой чужой текст (инвариант 7).
              data: { toolUseId: id, name: 'Agent', subagentType: agentPath === null ? null : redactString(agentPath), agentThreadId },
            })
            out.signals.push({ kind: 'subagent_started', nodeId: id, agentThreadId, agentPath })
            return out
          }
          if ((kind === 'completed' || kind === 'interrupted') && done) {
            // Закрываем узел, заведённый на `started`: у `completed` СВОЙ id, и по нему
            // дерево нашло бы пустоту.
            const nodeId = agentNodeByThread.get(agentThreadId)
            if (!nodeId) return out
            out.drafts.push({
              ...base,
              kind: 'agent.finished',
              data: { toolUseId: nodeId, isError: kind === 'interrupted', agentThreadId },
            })
            out.signals.push({ kind: 'subagent_finished', agentThreadId })
          }
          return out
        }

        if (id === null) return out

        if (type === 'commandExecution') {
          const status = str(item['status'])
          out.drafts.push(done
            ? {
              ...base,
              kind: 'tool.finished',
              data: {
                toolUseId: id,
                name: 'commandExecution',
                isError: status !== 'completed',
                status,
                exitCode: num(item['exitCode']),
              },
            }
            : {
              ...base,
              kind: 'tool.called',
              data: {
                toolUseId: id,
                name: 'commandExecution',
                input: redact({ command: item['command'], cwd: item['cwd'] }) as Record<string, unknown>,
              },
            })
          return out
        }

        if (type === 'collabAgentToolCall') {
          const tool = str(item['tool']) ?? 'collabAgentTool'
          const status = str(item['status'])
          out.drafts.push(done
            ? { ...base, kind: 'tool.finished', data: { toolUseId: id, name: tool, isError: status === 'failed', status } }
            : {
              ...base,
              kind: 'tool.called',
              data: {
                toolUseId: id,
                name: tool,
                input: redact({
                  senderThreadId: item['senderThreadId'],
                  receiverThreadIds: item['receiverThreadIds'],
                  prompt: item['prompt'],
                }) as Record<string, unknown>,
              },
            })
          return out
        }

        if (type === 'mcpToolCall') {
          // О3: вызов инструмента MCP-сервера (браузер агента) — с аргументами и итогом, как у Claude
          // (`mcp__<сервер>__<инструмент>`). Картинки итога — заглушкой (core/blobs.ts).
          const name = `mcp__${str(item['server']) ?? 'mcp'}__${str(item['tool']) ?? 'tool'}`
          const status = str(item['status'])
          const result = obj(item['result'])
          const error = obj(item['error'])
          const images = done ? opts.images?.capture(result?.['content']) ?? [] : []
          out.drafts.push(done
            ? {
              ...base,
              kind: 'tool.finished',
              data: {
                toolUseId: id, name, isError: status === 'failed' || error !== null, status,
                ...(images.length ? { images } : {}),
                ...(result ? { content: redact(stripBlobs(result['content'])) } : {}),
                ...(error ? { content: redactString(str(error['message']) ?? 'ошибка') } : {}),
              },
            }
            : { ...base, kind: 'tool.called', data: { toolUseId: id, name, input: (redact(obj(item['arguments']) ?? {}) as Record<string, unknown>) } })
          return out
        }

        // Схема app-server ImageGenerationThreadItem: savedPath (optional), result (string).
        // Бинарные результаты кладём отдельно, result не попадает в JSONL.
        if (type === 'imageGeneration') {
          const images = done ? [...new Set([
            ...(opts.images?.captureFile(item['savedPath']) ?? []),
            ...(opts.images?.captureFile(item['result']) ?? []),
            ...(opts.images?.capture({ type: 'image', data: item['result'] }) ?? []),
          ])] : []
          out.drafts.push(done
            ? { ...base, kind: 'tool.finished', data: { toolUseId: id, name: type, status: str(item['status']), isError: item['status'] === 'failed', ...(images.length ? { images } : {}) } }
            : { ...base, kind: 'tool.called', data: { toolUseId: id, name: type, input: {} } })
          return out
        }

        // Остальные 19 типов элементов протокола (fileChange, mcpToolCall, webSearch, sleep,
        // imageGeneration, …) переводятся ОДИНАКОВО: это вызовы инструментов, и дереву
        // достаточно их имени и исхода. Незнакомый тип не роняет ничего — он логируется раз.
        if (!QUIET_ITEM_TYPES.has(type)) unknown(`item/${type}`)
        out.drafts.push(done
          ? { ...base, kind: 'tool.finished', data: { toolUseId: id, name: type, isError: str(item['status']) === 'failed', status: str(item['status']) } }
          : { ...base, kind: 'tool.called', data: { toolUseId: id, name: type, input: {} } })
        return out
      }

      case 'error': {
        const err = obj(params['error'])
        const message = redactString(err ? str(err['message']) ?? '' : '')
        const details = err ? str(err['additionalDetails']) : null
        const info = errorInfoName(err?.['codexErrorInfo'])
        if ((info !== null && LIMIT_ERROR_INFO.has(info)) || USAGE_LIMIT_RE.test(message)) {
          out.signals.push({ kind: 'limit', message, info: info ?? 'usageLimitText' })
          return out
        }
        if (params['willRetry'] === true) {
          out.signals.push({ kind: 'retry', message, details: details === null ? null : redactString(details) })
          return out
        }
        out.signals.push({ kind: 'failed', message, info })
        return out
      }

      case 'warning': {
        const text = str(params['message'])
        if (text !== null) out.signals.push({ kind: 'warning', text: redactString(text) })
        return out
      }

      case 'thread/tokenUsage/updated': {
        const usage = obj(params['tokenUsage'])
        const last = usage ? obj(usage['last']) : null
        if (!last) return out
        out.signals.push({
          kind: 'tokens',
          input: num(last['inputTokens']),
          output: num(last['outputTokens']),
          cached: num(last['cachedInputTokens']),
        })
        // Контекст — только своего треда: у ребёнка-субагента своё окно (ИЗМЕРЕНО в записи 04:
        // тред ребёнка шлёт свой `thread/tokenUsage/updated`).
        if (ctx.parentId) return out
        const used = contextTokens(last)
        if (used === null) return out
        const w = usage ? num(usage['modelContextWindow']) : null
        if (w !== null && w > 0) ctxWindow = w
        if (ctxSent && ctxSent.used === used && ctxSent.window === ctxWindow) return out
        ctxSent = { used, window: ctxWindow }
        out.drafts.push({ ...base, kind: 'context.updated', data: { used, window: ctxWindow, model } })
        return out
      }

      case 'model/rerouted': {
        // Сервер сам пересадил тред на другую модель: окно прежней к ней не относится.
        const to = str(params['toModel'])
        if (ctx.parentId || to === null || to === model) return out
        model = to
        ctxWindow = null
        return out
      }

      default:
        if (!QUIET_METHODS.has(method)) unknown(method)
        return out
    }
  }

  const setModel = (m: string | null): void => {
    if (m === null || m === model) return
    if (model !== null) ctxWindow = null
    model = m
  }

  return { push, setModel }
}
