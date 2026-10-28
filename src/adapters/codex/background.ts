// Фоновая работа сессии Codex (28.10.2026): субагенты и команды, пережившие ход.
//
// ЗАЧЕМ. Codex не ждёт своих субагентов и долгих команд: ход кончается (`turn/completed`, прерван или упал), а
// субагент доделывает работу ещё минуты, команда (`commandExecution`) дорабатывает тест. Их конец приходит
// верхним `agent.finished` / `tool.finished` уже после хода. Раньше это «воскрешало» сессию в `working`, и через
// 10 мин сторож тишины кричал «Похоже, завис». Теперь статус от активности не двигается (src/sessions/status.ts),
// а то, что ещё идёт, показывается как у Claude — событием `background.changed {count, tasks}` («фон · N»).
//
// ЧТО СЧИТАЕТСЯ. Открытые на конец хода элементы СВОЕГО треда: субагент (`agent.spawned` без `agent.finished`) и
// команда (`tool.called commandExecution` без `tool.finished`). Внутри хода они — инструменты хода (строка фазы), в
// фон переходят на конце хода. Начатые ВНЕ хода (`item/started` обогнал `turn/completed`, сервер работает после
// неподтверждённого стопа) — сразу фон. Счёт падает на их событии конца; всё снимается закрытием сессии и смертью
// app-server; рестарт демона забывает их вместе с памятью адаптера.
//
// СТРАХОВКА. Конец может потеряться (сервер его не прислал) — запись не должна держать «фон · 1» вечно. Признак
// жизни записи — любое уведомление её субагента или её команды (`itemId`, например `outputDelta`). Запись, которая
// молчит дольше `silenceMs`, снимается.
//
// Чистый модуль: ни процессов, ни таймеров — время приходит снаружи (`now`).

import type { EventDraft } from '../../core/events.js'
import { toolSummary } from '../../sessions/turnPhase.js'

/** Фоновая запись, которая молчит дольше этого, снимается (не дольше `backgroundMaxMs` конфига). */
export const CODEX_BACKGROUND_SILENCE_MS = 60 * 60_000

/** Задача в `background.changed` — та же форма, что у Claude (`system/background_tasks_changed`). */
export interface BackgroundTask { id: string; type: 'subagent' | 'command'; description: string }

interface Item {
  type: BackgroundTask['type']
  description: string
  /** Последний признак жизни. */
  last: number
  /** Пережил ход — уже в фоне (в счёте `background.changed`). */
  bg: boolean
}

export interface CodexBackground {
  /** Черновик события своего треда или ребёнка (`parentId`). `true` — фон изменился. */
  onDraft(draft: EventDraft): boolean
  /** Признак жизни элемента: уведомление по его `itemId` или по треду его субагента. */
  touch(id: string): void
  /** Ход начался (свой или серверный): новые элементы — инструменты хода, а не фон. */
  turnStarted(): void
  /** Ход кончился: всё, что ещё открыто, — в фон. `true` — фон изменился. */
  turnEnded(): boolean
  /** Снять записи, молчащие дольше `silenceMs`. Возвращает снятые (пусто — фон не изменился). */
  sweep(): BackgroundTask[]
  /** Всё снять (сессия закрыта, процесс умер). `true` — в фоне что-то было. */
  clear(): boolean
  /** Есть ли что сторожить таймеру. */
  pending(): boolean
  /** Данные `background.changed`. */
  data(): { count: number; tasks: BackgroundTask[] }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

export function createCodexBackground(opts: { now: () => number; silenceMs: number }): CodexBackground {
  const items = new Map<string, Item>()
  const bgCount = (): number => { let n = 0; for (const it of items.values()) if (it.bg) n += 1; return n }
  const task = (id: string, it: Item): BackgroundTask => ({ id, type: it.type, description: it.description })
  /**
   * Узел дерева → его родитель (`parentId` черновика). По нему признак жизни внука (субагент субагента, его команда)
   * доходит до записи верхнего уровня: иначе живой субагент, у которого работают только дети, снимался бы через час.
   */
  const parentOf = new Map<string, string>()
  let inTurn = false
  const touch = (id: string): void => {
    let cur: string | undefined = id
    for (let depth = 0; cur !== undefined && depth < 32; depth++) {
      const it = items.get(cur)
      if (it) { it.last = opts.now(); return }
      cur = parentOf.get(cur)
    }
  }
  /** Элемент, начатый вне хода (сервер ещё работает после конца хода или неподтверждённого стопа), — сразу фон. */
  const open = (id: string, type: Item['type'], description: string): boolean => {
    items.set(id, { type, description, last: opts.now(), bg: !inTurn })
    return !inTurn
  }

  return {
    onDraft(draft) {
      const d = obj(draft.data)
      const id = str(d['toolUseId'])
      if (draft.parentId) {
        if (id !== null && (draft.kind === 'agent.spawned' || draft.kind === 'tool.called')) parentOf.set(id, draft.parentId)
        if (id !== null && (draft.kind === 'agent.finished' || draft.kind === 'tool.finished')) parentOf.delete(id)
        touch(draft.parentId)
        return false
      }
      if (id === null) return false
      switch (draft.kind) {
        case 'agent.spawned': {
          const what = str(d['subagentType']) ?? str(d['description'])
          return open(id, 'subagent', what ? `субагент ${what}` : 'субагент')
        }
        case 'tool.called': {
          if (d['name'] !== 'commandExecution') return false
          const summary = toolSummary('commandExecution', obj(d['input']))
          return open(id, 'command', summary || 'команда')
        }
        case 'agent.finished':
        case 'tool.finished': {
          const it = items.get(id)
          if (!it) return false
          items.delete(id)
          return it.bg
        }
        default:
          return false
      }
    },

    touch,

    turnStarted() { inTurn = true },

    turnEnded() {
      inTurn = false
      let moved = false
      const t = opts.now()
      for (const it of items.values()) {
        if (it.bg) continue
        it.bg = true
        // Отсчёт молчания фона — с конца хода: элемент мог молчать весь ход, пока шли другие.
        it.last = Math.max(it.last, t)
        moved = true
      }
      return moved
    },

    sweep() {
      const t = opts.now()
      const gone: BackgroundTask[] = []
      for (const [id, it] of items) {
        if (it.bg && t - it.last > opts.silenceMs) { items.delete(id); gone.push(task(id, it)) }
      }
      return gone
    },

    clear() {
      const had = bgCount() > 0
      items.clear()
      parentOf.clear()
      inTurn = false
      return had
    },

    pending() { return bgCount() > 0 },

    data() {
      const tasks: BackgroundTask[] = []
      for (const [id, it] of items) if (it.bg) tasks.push(task(id, it))
      return { count: tasks.length, tasks }
    },
  }
}
