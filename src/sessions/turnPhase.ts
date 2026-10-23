// Фаза хода (0.3.5): что модель делает прямо сейчас — одна живая строка под репликой человека
// («запускается…», «думает… 12 с», «пишет…», «выполняет: Bash npm test… 8 с», «ждёт тебя»).
//
// Здесь только ФОРМА — типы, константы и подпись инструмента, без node-модулей: файл импортирует и
// интерфейс окна (ui/), и демон. Вывод фазы из событий — src/sessions/phaseTracker.ts, живой канал —
// src/daemon/live.ts.

/**
 * `starting` — ход принят, а провайдер ещё молчит (страж сети, MCP, спавн, подъём app-server, тред);
 * `thinking` — провайдер отозвался, вывода ещё нет (или идут размышления);
 * `writing` — идёт текст ответа (дельты);
 * `tool` — работает инструмент (последний начатый в корне разговора);
 * `waiting` — вопрос в Inbox (разрешение или вопрос модели);
 * `background` — ход кончился, а фоновые задачи сессии (Claude) ещё идут.
 */
export type PhaseName = 'starting' | 'thinking' | 'writing' | 'tool' | 'waiting' | 'background'

export const PHASE_NAMES: readonly PhaseName[] = ['starting', 'thinking', 'writing', 'tool', 'waiting', 'background']

export interface TurnPhase {
  phase: PhaseName
  /** Начало ЭТОЙ фазы — эпоха, мс, по часам демона. Секунды окно считает само: событий раз в секунду нет. */
  since: number
  /** Начало хода (для `background` — начало фоновой работы). */
  turnSince: number
  /** `tool`: имя и короткая подпись (`toolSummary` по уже отредактированному входу). */
  tool?: { name: string; detail: string }
  /** `waiting`: какой запрос ждёт — по `permId` окно фокусирует карточку в Inbox. */
  waiting?: { kind: 'permission' | 'question'; permId: string; toolName: string }
  /** Фоновые задачи сессии, которые ещё идут (Claude `background_tasks_changed`). Нет — ноль. */
  background?: number
  /**
   * Размышления модели — хвост до `REASONING_TAIL` знаков, после `redactString`. Только в живом канале:
   * ни в журнал, ни в `agent.list` текст не попадает. Нет поля — провайдер текста не дал (у Claude блоки
   * размышлений обычно приходят пустыми — тогда просто «думает»).
   */
  reasoning?: string
}

/** Сколько текста размышлений держать и отдавать окну (хвост). */
export const REASONING_TAIL = 4096

/**
 * Живой канал фаз идёт по ТОЙ ЖЕ подписке `events.subscribe`, что и журнал, но курсор у неё — от этой базы.
 * Почему так, а не новый метод: окно 0.1.15 (оболочка) пропускает в подписку только кадры с целым `id` больше
 * последнего доставленного и сама переподписывается с этим `id` после рестарта демона. Подписка с
 * `since >= LIVE_CURSOR_BASE` — живая: журнал не доигрывается, приходят только кадры `turn.phase` со своими
 * номерами от этой базы (демон держит их выше любого `since`, поэтому переподписка оболочки работает как есть).
 * 2^50 — с запасом выше любого номера журнала и ниже `Number.MAX_SAFE_INTEGER` (2^53).
 */
export const LIVE_CURSOR_BASE = 2 ** 50

/** Вид кадра живого канала. В журнал он не пишется никогда. */
export const PHASE_FRAME_KIND = 'turn.phase'

/**
 * Данные кадра `turn.phase`: `{reset: true}` (сессия `daemon`) — «всё, что знал, забудь, дальше — текущее»
 * (первый кадр каждой живой подписки); иначе `{phase}` сессии кадра, `null` — фазы нет (ход кончился).
 */
export type PhaseFrameData = { reset: true } | { phase: TurnPhase | null }

/** Короткая подпись инструмента для свёрнутой строки и строки фазы: что именно он трогает. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) { const v = input[k]; if (typeof v === 'string' && v) return v }
    return undefined
  }
  const cmd = input['command']
  if (Array.isArray(cmd)) return cmd.filter((x) => typeof x === 'string').join(' ')
  // Поиск: что ищем важнее, где ищем.
  const pattern = pick('pattern')
  if (pattern) { const where = pick('path'); return where ? `${pattern}  в ${where}` : pattern }
  const s = pick('command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt')
  if (s) return s.length > 160 ? `${s.slice(0, 160)}…` : s
  void name
  return ''
}
