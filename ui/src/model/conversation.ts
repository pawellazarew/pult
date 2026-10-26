// Свёртка потока событий одной сессии в ленту разговора. ЧИСТАЯ: вход — лента и событие, выход —
// новая лента (или та же, если событие ничего не меняет — React не перерисует).
//
// Что куда ложится (docs/12 §3 п.2):
//   message.user                → реплика человека;
//   message.delta … message.done → реплика модели: дельты копятся в «идущей» реплике, `done`
//                                 заменяет её текст окончательным (он и есть правда, дельты — предпросмотр);
//   tool.called → tool.finished → свёрнутая строка инструмента;
//   agent.spawned → agent.finished → вложенный блок субагента; события с `parentId` = id его
//                                 `tool_use` ложатся внутрь (цепочка любой глубины тем же правилом);
//   permission.requested/resolved → карточка разрешения прямо в ленте;
//   net.blocked, provider.blocked, limit.hit, status.changed failed|interrupted → строка-причина.

import type { PultEvent } from './types.js'
import { num, obj, str } from './types.js'
import { parseOffers } from './permissions.js'
import type { PermissionOffers } from '../../../src/adapters/types.js'
import { browserNote, describeChanges } from '../../../src/sessions/settings.js'
import type { ConfigureChanges } from '../../../src/sessions/settings.js'

/** `stopped` — ход прервали или он провалился, а свой конец (`tool_result`) так и не пришёл. */
export type ItemState = 'running' | 'ok' | 'error' | 'stopped'

interface Base {
  /** Ключ для React: стабилен на всю жизнь элемента. */
  key: string
  /** id события, которое элемент завело. */
  id: number
  ts: string
}

export interface UserItem extends Base { type: 'user'; text: string }
export interface ModelItem extends Base {
  type: 'model'
  text: string
  /** Идут дельты, `message.done` ещё не пришёл. */
  streaming: boolean
  /** `message.done` с ошибкой платформы (`error` на конверте). */
  error?: string
  /** Codex: id элемента — по нему дельты находят свою реплику. */
  itemId?: string
  model?: string
}
export interface ToolItem extends Base {
  type: 'tool'
  toolUseId: string
  name: string
  input: Record<string, unknown>
  state: ItemState
  /** Коротко, что вернул инструмент (для раскрытой строки). */
  result?: string
  endTs?: string
  exitCode?: number
  /** Номер `tool.finished`: по нему раскрытая строка догружает вывод (`events.get`). */
  endId?: number
  /** Из лёгкой истории (src/core/history.ts): вход урезан и/или вывода нет — полное по `events.get`. */
  elided?: boolean
}
export interface AgentItem extends Base {
  type: 'agent'
  toolUseId: string
  subagentType?: string
  description?: string
  model?: string
  state: ItemState
  endTs?: string
  items: ConvItem[]
}
export interface PermItem extends Base {
  type: 'perm'
  permId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** `expired` — запрос прошлого запуска демона: ответить на него уже нельзя (см. expirePermissions). */
  state: 'pending' | 'allow' | 'deny' | 'expired'
  by?: string
  message?: string
  /** M8d: «В этой сессии» / «Всегда …», предложенные провайдером (пока ждёт). */
  offers?: PermissionOffers
  /** Показанный вход не равен исполняемому (src/perm/broker.ts). */
  concealed?: true
  /** M8d: с какой шириной разрешили — `session` | `rule` (нет — один раз) и правило, если `rule`. */
  scope?: 'session' | 'rule'
  rule?: { kind: string; label: string }
}
export interface NoticeItem extends Base {
  type: 'notice'
  tone: 'fail' | 'wait' | 'info'
  title: string
  text?: string
  /** Сброс лимита, эпоха в секундах — время рисует компонент. */
  resetsAt?: number
}

export type ConvItem = UserItem | ModelItem | ToolItem | AgentItem | PermItem | NoticeItem

export interface Conversation {
  readonly items: readonly ConvItem[]
  readonly lastId: number
}

export const EMPTY_CONVERSATION: Conversation = { items: [], lastId: 0 }

// --- путь к «области»: корень ленты или блок субагента -----------------------

/** Путь индексов до блока субагента с этим toolUseId (или null — нет такого). */
function findAgentPath(items: readonly ConvItem[], toolUseId: string): number[] | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as ConvItem
    if (it.type !== 'agent') continue
    if (it.toolUseId === toolUseId) return [i]
    const inner = findAgentPath(it.items, toolUseId)
    if (inner) return [i, ...inner]
  }
  return null
}

/** Заменить список элементов области по пути (копируя только ветку пути). */
function withScope(items: readonly ConvItem[], path: number[], fn: (scope: readonly ConvItem[]) => readonly ConvItem[]): ConvItem[] {
  if (path.length === 0) return fn(items) as ConvItem[]
  const [head, ...rest] = path as [number, ...number[]]
  const agent = items[head] as AgentItem
  const next = items.slice()
  next[head] = { ...agent, items: withScope(agent.items, rest, fn) }
  return next
}

function scopeAt(items: readonly ConvItem[], path: number[]): readonly ConvItem[] {
  let cur = items
  for (const i of path) cur = (cur[i] as AgentItem).items
  return cur
}

/** Найти элемент по предикату в любой области: путь области + индекс в ней. */
function locate(items: readonly ConvItem[], pred: (it: ConvItem) => boolean, path: number[] = []): { path: number[]; index: number } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as ConvItem
    if (pred(it)) return { path, index: i }
    if (it.type === 'agent') {
      const inner = locate(it.items, pred, [...path, i])
      if (inner) return inner
    }
  }
  return null
}

function replaceAt(items: readonly ConvItem[], where: { path: number[]; index: number }, fn: (it: ConvItem) => ConvItem): ConvItem[] {
  return withScope(items, where.path, (scope) => {
    const next = scope.slice()
    next[where.index] = fn(scope[where.index] as ConvItem)
    return next
  })
}

/** Текст результата инструмента: строка или массив блоков `{type:'text', text}`; обрезан. */
export function resultText(content: unknown, limit = 4000): string | undefined {
  let s: string | undefined
  if (typeof content === 'string') s = content
  else if (Array.isArray(content)) {
    s = content
      .map((b) => { const o = obj(b); return o && typeof o['text'] === 'string' ? o['text'] : '' })
      .filter(Boolean)
      .join('\n')
  }
  if (!s) return undefined
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

function scopePath(items: readonly ConvItem[], parentId: string | undefined): number[] {
  if (!parentId) return []
  return findAgentPath(items, parentId) ?? []
}

const push = (conv: Conversation, ev: PultEvent, item: ConvItem, parentId?: string): Conversation => ({
  lastId: ev.id,
  items: withScope(conv.items, scopePath(conv.items, parentId), (scope) => [...scope, item]),
})

// --- причины провала ------------------------------------------------------------

const NET_REASON: Record<string, string> = {
  blocked_country: 'страна выхода в списке-страже',
  not_allowed_country: 'страны выхода нет в списке разрешённых',
  unknown_location: 'страну выхода определить не удалось',
  proxy_dead: 'прокси не отвечает',
  no_proxy: 'режим required, а прокси не задан',
  api_retry_storm: 'провайдер не отвечает: повторы подряд',
}

export function netBlockedText(data: Record<string, unknown>): { title: string; text: string } {
  const reason = str(data['reason']) ?? 'unknown'
  const loc = str(data['loc'])
  const guard = Array.isArray(data['guard']) ? (data['guard'] as unknown[]).filter((x) => typeof x === 'string').join(', ') : ''
  const retries = num(data['retries'])
  const why = NET_REASON[reason] ?? reason
  const parts = [
    loc ? `выход: ${loc}` : null,
    guard ? `${data['guardMode'] === 'allow' ? 'разрешены' : 'страж'}: ${guard}` : null,
    retries !== undefined ? `повторов: ${retries}` : null,
  ].filter(Boolean)
  const todo = reason === 'proxy_dead' ? 'подними прокси или переключи профиль сети'
    : reason === 'no_proxy' ? 'укажи network.<провайдер>.proxy или mode "off" в config.json'
    : reason === 'not_allowed_country' ? 'смени выход VPN на страну из списка или поправь «Настройки» → «Страж сети» и повтори реплику'
    : 'подними VPN и повтори реплику'
  return { title: `Сеть заблокирована стражем — ${why}`, text: `${parts.length ? parts.join(' · ') + ' — ' : ''}${todo}` }
}

// --- свёртка ---------------------------------------------------------------------

export function applyConversation(conv: Conversation, ev: PultEvent): Conversation {
  if (ev.id <= conv.lastId) return conv
  const d = ev.data ?? {}
  const parentId = ev.parentId
  const key = `e${ev.id}`
  const base = { key, id: ev.id, ts: ev.ts }

  switch (ev.kind) {
    case 'message.user': {
      const text = str(d['text']) ?? ''
      return push(conv, ev, { ...base, type: 'user', text })
    }

    case 'message.delta': {
      const text = typeof d['text'] === 'string' ? d['text'] : ''
      if (!text) return { ...conv, lastId: ev.id }
      const itemId = str(d['itemId'])
      const path = scopePath(conv.items, parentId)
      const scope = scopeAt(conv.items, path)
      const last = scope[scope.length - 1]
      if (last && last.type === 'model' && last.streaming && (itemId === undefined || last.itemId === undefined || last.itemId === itemId)) {
        return {
          lastId: ev.id,
          items: withScope(conv.items, path, (s) => {
            const next = s.slice()
            next[next.length - 1] = { ...last, text: last.text + text }
            return next
          }),
        }
      }
      return push(conv, ev, { ...base, type: 'model', text, streaming: true, ...(itemId ? { itemId } : {}) }, parentId)
    }

    case 'message.done': {
      const text = typeof d['text'] === 'string' ? d['text'] : ''
      const itemId = str(d['itemId'])
      const error = str(d['error'])
      const model = str(d['model'])
      const path = scopePath(conv.items, parentId)
      const scope = scopeAt(conv.items, path)
      // Идущая реплика этой области: последняя по itemId (codex) или просто последняя идущая.
      let idx = -1
      for (let i = scope.length - 1; i >= 0; i--) {
        const it = scope[i] as ConvItem
        if (it.type === 'model' && it.streaming && (itemId === undefined || it.itemId === undefined || it.itemId === itemId)) { idx = i; break }
      }
      if (idx >= 0) {
        const open = scope[idx] as ModelItem
        const done: ModelItem = {
          ...open, text: text || open.text, streaming: false,
          ...(error ? { error } : {}), ...(model ? { model } : {}),
        }
        return {
          lastId: ev.id,
          items: withScope(conv.items, path, (s) => {
            const next = s.slice()
            if (!done.text.trim() && !error) next.splice(idx, 1)
            else next[idx] = done
            return next
          }),
        }
      }
      if (!text.trim() && !error) return { ...conv, lastId: ev.id }
      return push(conv, ev, {
        ...base, type: 'model', text, streaming: false,
        ...(itemId ? { itemId } : {}), ...(error ? { error } : {}), ...(model ? { model } : {}),
      }, parentId)
    }

    case 'tool.called': {
      const toolUseId = str(d['toolUseId']) ?? key
      return push(conv, ev, {
        ...base, type: 'tool', toolUseId,
        name: str(d['name']) ?? 'tool',
        input: obj(d['input']) ?? {},
        state: 'running',
        ...(d['inputElided'] === true ? { elided: true } : {}),
      }, parentId)
    }

    case 'tool.finished': {
      const toolUseId = str(d['toolUseId'])
      const isError = d['isError'] === true
      const result = resultText(d['content'])
      const exitCode = num(d['exitCode'])
      const where = toolUseId ? locate(conv.items, (it) => it.type === 'tool' && it.toolUseId === toolUseId) : null
      const patch = {
        state: (isError ? 'error' : 'ok') as ItemState,
        endTs: ev.ts,
        endId: ev.id,
        ...(result !== undefined ? { result } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(d['elided'] === true ? { elided: true } : {}),
      }
      if (where) return { lastId: ev.id, items: replaceAt(conv.items, where, (it) => ({ ...(it as ToolItem), ...patch })) }
      // Конец без начала (у codex часть элементов начала не пишет): строка сразу законченная.
      return push(conv, ev, {
        ...base, type: 'tool', toolUseId: toolUseId ?? key,
        name: str(d['name']) ?? 'tool', input: {}, ...patch,
      }, parentId)
    }

    case 'agent.spawned': {
      const toolUseId = str(d['toolUseId']) ?? key
      const subagentType = str(d['subagentType'])
      const description = str(d['description'])
      const model = str(d['model'])
      return push(conv, ev, {
        ...base, type: 'agent', toolUseId, state: 'running', items: [],
        ...(subagentType ? { subagentType } : {}), ...(description ? { description } : {}), ...(model ? { model } : {}),
      }, parentId)
    }

    case 'agent.finished': {
      const toolUseId = str(d['toolUseId'])
      if (!toolUseId) return { ...conv, lastId: ev.id }
      const path = findAgentPath(conv.items, toolUseId)
      if (!path) return { ...conv, lastId: ev.id }
      const isError = d['isError'] === true
      const parentPath = path.slice(0, -1)
      const index = path[path.length - 1] as number
      return {
        lastId: ev.id,
        items: replaceAt(conv.items, { path: parentPath, index }, (it) => ({
          ...(it as AgentItem), state: isError ? 'error' : 'ok', endTs: ev.ts,
        })),
      }
    }

    case 'permission.requested': {
      const permId = str(d['id'])
      if (!permId) return { ...conv, lastId: ev.id }
      const toolUseId = str(d['toolUseId'])
      const offers = parseOffers(d['offers'])
      return push(conv, ev, {
        ...base, key: `perm-${permId}-${ev.id}`, type: 'perm', permId,
        toolName: str(d['toolName']) ?? 'tool',
        ...(toolUseId ? { toolUseId } : {}),
        input: obj(d['input']) ?? {},
        ...(offers ? { offers } : {}),
        ...(d['concealed'] === true ? { concealed: true as const } : {}),
        state: 'pending',
      })
    }

    case 'permission.resolved': {
      const permId = str(d['id'])
      if (!permId) return { ...conv, lastId: ev.id }
      const where = locate(conv.items, (it) => it.type === 'perm' && it.permId === permId && it.state === 'pending')
      if (!where) return { ...conv, lastId: ev.id }
      const decision = d['decision'] === 'allow' ? 'allow' : 'deny'
      const by = str(d['by'])
      const message = str(d['message'])
      const scope = decision === 'allow' && (d['scope'] === 'session' || d['scope'] === 'rule') ? d['scope'] : undefined
      const r = obj(d['rule'])
      const rule = scope === 'rule' && r && str(r['label']) ? { kind: str(r['kind']) ?? 'execpolicy', label: str(r['label']) as string } : undefined
      return {
        lastId: ev.id,
        items: replaceAt(conv.items, where, (it) => ({
          ...(it as PermItem), state: decision, ...(by ? { by } : {}), ...(message ? { message } : {}),
          ...(scope ? { scope } : {}), ...(rule ? { rule } : {}),
        })),
      }
    }

    case 'net.blocked': {
      const t = netBlockedText(d)
      return push(conv, ev, { ...base, type: 'notice', tone: 'fail', title: t.title, text: t.text })
    }

    case 'provider.blocked': {
      const provider = str(d['provider']) ?? ev.provider
      const text = str(d['text'])
      return push(conv, ev, {
        ...base, type: 'notice', tone: 'fail',
        title: `Провайдер ${provider} остановлен целиком`,
        ...(text ? { text } : {}),
      })
    }

    case 'limit.hit': {
      const resetsAt = num(d['resetsAt'])
      const type = str(d['rateLimitType'])
      // Предупреждение (старые журналы писали его как лимит): «израсходован на N%», а не «исчерпан».
      if (str(d['status']) === 'allowed_warning') {
        const windows = obj(d['windows'])
        const w = type && windows ? obj(windows[type]) : undefined
        const u = w ? num(w['utilization']) : undefined
        return push(conv, ev, {
          ...base, type: 'notice', tone: 'wait',
          title: `Лимит ${ev.provider}${type === 'seven_day' ? ' на неделю' : type === 'five_hour' ? ' на 5 ч' : ''} израсходован${u !== undefined ? ` на ${Math.round(u * 100)}%` : ''} — работать можно`,
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        })
      }
      return push(conv, ev, {
        ...base, type: 'notice', tone: 'wait',
        title: `Лимит ${ev.provider} исчерпан${type ? ` (${type})` : ''}`,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      })
    }

    case 'browser.install': {
      // О3: ход пошёл без браузера (`skipped`: не поставился, режим bypassPermissions) или Codex применит смену
      // браузера после перезапуска демона (`pending`). Установка у демона (`started|done|failed`) — без заметки.
      const state = str(d['state'])
      if (state !== 'skipped' && state !== 'pending') return { ...conv, lastId: ev.id }
      return push(conv, ev, {
        ...base, type: 'notice', tone: 'wait',
        title: state === 'skipped' ? 'Ход без браузера' : 'Браузер — после перезапуска демона',
        text: str(d['reason']) ?? '',
      })
    }

    case 'session.configured': {
      // M8f: модель, усилие или режим сменили — тихая строка «… — со следующего хода» (и о браузере, если он выключен
      // или возвращён режимом).
      // Ход идёт не на тех настройках, что в подвале (идут фоновые задачи), — заметка адаптера словами.
      const notice = str(d['notice'])
      if (notice) return push(conv, ev, { ...base, type: 'notice', tone: 'wait', title: notice })
      const changes = (obj(d['changes']) ?? {}) as ConfigureChanges
      const title = describeChanges(changes, str(d['when']) === 'after_background' ? 'after_background' : 'next_turn')
      if (!title) return { ...conv, lastId: ev.id }
      const note = browserNote(changes)
      return push(conv, ev, { ...base, type: 'notice', tone: 'info', title, ...(note ? { text: note } : {}) })
    }

    case 'turn.stalled': {
      // Сторож тишины демона (О2): ход давно молчит. Ход не обрывается — решает человек: «Стоп» или ждать.
      const ms = num(d['silentForMs'])
      return push(conv, ev, {
        ...base, type: 'notice', tone: 'wait', title: 'Похоже, завис',
        text: `${ms !== undefined ? `ход молчит ${Math.max(1, Math.round(ms / 60_000))} мин` : 'ход давно молчит'} — останови его «Стоп» или подожди`,
      })
    }

    case 'status.changed': {
      const status = str(d['status'])
      if (status === 'interrupted') {
        return settle(push(conv, ev, { ...base, type: 'notice', tone: 'info', title: 'Ход остановлен' }), ev.id, ev.ts)
      }
      if (status === 'failed') {
        // Провал, о котором уже сказала строка стража или остановки провайдера, второй раз не пишем.
        if (d['reason'] === 'net_blocked') return settle(conv, ev.id, ev.ts)
        const last = conv.items[conv.items.length - 1]
        if (last && last.type === 'notice' && last.tone === 'fail' && ev.id - last.id <= 5) return settle(conv, ev.id, ev.ts)
        const text = str(d['message']) ?? str(d['error']) ?? str(d['errorCode'])
        return settle(push(conv, ev, { ...base, type: 'notice', tone: 'fail', title: 'Ход не удался', ...(text ? { text } : {}) }), ev.id, ev.ts)
      }
      // Ход закончился — все «идущие» реплики и инструменты этого хода больше не идут.
      if (status === 'idle' || status === 'done') return settle(conv, ev.id)
      return { ...conv, lastId: ev.id }
    }

    default:
      return { ...conv, lastId: ev.id }
  }
}

/**
 * Ход закончен (готов, остановлен, провален): незакрытая реплика перестаёт «печатать».
 * Обычный конец (`idle`) инструменты не трогает — их закрывает свой конец. Но у прерванного или
 * проваленного хода своего конца может не быть вовсе: `stop` убивает процесс claude, и
 * `tool_result` для открытых инструментов и субагентов уже не придёт — спиннер крутился бы
 * вечно (и после рестарта тоже: свёртка журнала воспроизводит то же). Поэтому `stoppedAt`
 * (время конца хода) переводит всё ещё `running` в `stopped`.
 */
function settle(conv: Conversation, id: number, stoppedAt?: string): Conversation {
  let changed = false
  const fix = (items: readonly ConvItem[]): ConvItem[] => items.map((it) => {
    if (it.type === 'model' && it.streaming) { changed = true; return { ...it, streaming: false } }
    if (it.type === 'tool' && stoppedAt && it.state === 'running') { changed = true; return { ...it, state: 'stopped', endTs: stoppedAt } }
    if (it.type === 'agent') {
      const inner = fix(it.items)
      const innerChanged = inner.some((x, i) => x !== it.items[i])
      const stop = stoppedAt !== undefined && it.state === 'running'
      if (stop) changed = true
      if (!innerChanged && !stop) return it
      return { ...it, ...(innerChanged ? { items: inner } : {}), ...(stop ? { state: 'stopped' as const, endTs: stoppedAt } : {}) }
    }
    return it
  })
  const items = fix(conv.items)
  return changed ? { items, lastId: id } : { ...conv, lastId: id }
}

export function foldConversation(events: readonly PultEvent[], start: Conversation = EMPTY_CONVERSATION): Conversation {
  let c = start
  for (const ev of events) c = applyConversation(c, ev)
  return c
}

/** Сколько всего элементов (с вложенными) — для тестов и счётчиков. */
export function countItems(items: readonly ConvItem[]): number {
  let n = 0
  for (const it of items) n += 1 + (it.type === 'agent' ? countItems(it.items) : 0)
  return n
}

/**
 * M8e: что кладёт в буфер «Копировать» у реплики — ИСХОДНЫЙ текст (Markdown как набран или как пришёл), а не
 * нарисованное. У реплики модели, которая ещё печатает, и у прочих строк ленты кнопки нет — `null`.
 */
export function messageSource(it: ConvItem): string | null {
  if (it.type === 'user') return it.text || null
  if (it.type === 'model' && !it.streaming && it.text) return it.text
  return null
}

/** Короткая подпись инструмента для свёрнутой строки — та же, что у строки фазы хода (демон считает её сам). */
export { toolSummary } from '../../../src/sessions/turnPhase.js'

/** Длительность в секундах по-русски: «0,3 с», а не «0.3 с» (`toFixed` всегда пишет точку). */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} с`
}

/**
 * Демон стартовал заново: все ещё «ждущие» карточки разрешений в ленте — от прошлого запуска.
 * Их брокер умер вместе с процессом (после аварии `permission.resolved` так и не пишется), и
 * кнопки на такой карточке ушли бы в новый брокер. Карточка гаснет в `expired` — без кнопок.
 */
export function expirePermissions(conv: Conversation): Conversation {
  return expirePermissionsBefore(conv, Number.POSITIVE_INFINITY)
}

/**
 * Гасит неотвеченные карточки, заведённые раньше события `beforeId` (обычно — последнего
 * `daemon.started`): запрос прошлого запуска демона ответить уже нельзя. Лента из истории не видит
 * перезапусков (их события в сессии демона), поэтому граница приходит снаружи — из снимка.
 */
export function expirePermissionsBefore(conv: Conversation, beforeId: number): Conversation {
  let changed = false
  const fix = (items: readonly ConvItem[]): ConvItem[] => items.map((it) => {
    if (it.type === 'perm' && it.state === 'pending' && it.id < beforeId) { changed = true; return { ...it, state: 'expired' } }
    if (it.type === 'agent') {
      const inner = fix(it.items)
      return inner.some((x, i) => x !== it.items[i]) ? { ...it, items: inner } : it
    }
    return it
  })
  const items = fix(conv.items)
  return changed ? { ...conv, items } : conv
}
