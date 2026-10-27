// Горячие клавиши окна (docs/12 §3 п.7): ⌘N, ⌘1…9, ⌘I, ⌘Enter, Esc. Чистая функция: нажатие →
// действие. ⌘ — это Meta на macOS и Ctrl на остальных системах.
// О2 (docs/14, как в Conductor и cmux): ⌘⌥L — следующая, кто ждёт тебя; ⌃⌘L — отложить текущую;
// ⌥⌘U — пометить непрочитанной. Вне macOS: Ctrl+Alt+L, Ctrl+Shift+L, Ctrl+Alt+U.
// О2 «Поиск, метки» (docs/14): ⌘⇧F — поиск по всем разговорам (вне macOS Ctrl+Shift+F); ⌥↑/⌥↓ —
// предыдущая и следующая реплика человека в ленте (вне поля ввода — там ⌥↑ двигает каретку).

export type HotAction =
  | { type: 'newAgent' }
  | { type: 'quickSwitch' }
  | { type: 'toggleSidebar' }
  | { type: 'selectAgent'; index: number }
  | { type: 'toggleInbox' }
  | { type: 'approveFocused' }
  | { type: 'escape' }
  | { type: 'help' }
  | { type: 'nextWaiting' }
  | { type: 'snooze' }
  | { type: 'markUnread' }
  | { type: 'search' }
  | { type: 'userJump'; dir: -1 | 1 }
  /** M8f: ⌘, — «Настройки». */
  | { type: 'settings' }

export interface KeyLike {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Клавиши разборки очереди — по коду клавиши (⌥ на маке меняет символ: ⌥L даёт «¬»). Модификаторы —
 * точным набором: ⌘⌥L не должен срабатывать на ⌃⌘⌥L.
 */
function attentionAction(e: KeyLike, mac: boolean): HotAction | null {
  const code = e.code ?? ''
  if (code !== 'KeyL' && code !== 'KeyU') return null
  const m = `${e.metaKey ? 'M' : ''}${e.ctrlKey ? 'C' : ''}${e.altKey ? 'A' : ''}${e.shiftKey ? 'S' : ''}`
  const [next, snoozeMods, unread] = mac ? ['MA', 'MC', 'MA'] : ['CA', 'CS', 'CA']
  if (code === 'KeyL' && m === next) return { type: 'nextWaiting' }
  if (code === 'KeyL' && m === snoozeMods) return { type: 'snooze' }
  if (code === 'KeyU' && m === unread) return { type: 'markUnread' }
  return null
}

/** Подписи клавиш разборки очереди — для справки ⌘/. */
export function attentionKeys(mac: boolean): { next: string; snooze: string; unread: string } {
  return mac
    ? { next: '⌘⌥L', snooze: '⌃⌘L', unread: '⌥⌘U' }
    : { next: 'Ctrl+Alt+L', snooze: 'Ctrl+Shift+L', unread: 'Ctrl+Alt+U' }
}

/** ⌘⇧F и ⌥↑/⌥↓ — по коду клавиши и точному набору модификаторов (в русской раскладке F — «А»). */
function searchAction(e: KeyLike, mac: boolean): HotAction | null {
  const code = e.code ?? ''
  const m = `${e.metaKey ? 'M' : ''}${e.ctrlKey ? 'C' : ''}${e.altKey ? 'A' : ''}${e.shiftKey ? 'S' : ''}`
  if (code === 'KeyF' && m === (mac ? 'MS' : 'CS')) return { type: 'search' }
  if (m === 'A' && (code === 'ArrowUp' || e.key === 'ArrowUp')) return { type: 'userJump', dir: -1 }
  if (m === 'A' && (code === 'ArrowDown' || e.key === 'ArrowDown')) return { type: 'userJump', dir: 1 }
  return null
}

/** Подписи клавиш поиска и меток — для справки ⌘/ и подсказок. */
export function searchKeys(mac: boolean): { search: string; prevUser: string; nextUser: string } {
  return mac
    ? { search: '⌘⇧F', prevUser: '⌥↑', nextUser: '⌥↓' }
    : { search: 'Ctrl+Shift+F', prevUser: 'Alt+↑', nextUser: 'Alt+↓' }
}

/**
 * ⌥↑/⌥↓ уходят в ленту, только когда фокус не в поле ввода: там они двигают каретку. Исключение —
 * пустое поле реплики (фокус стоит в нём почти всегда, а двигать в нём нечего).
 */
export function userJumpAllowed(el: { tagName?: string; isContentEditable?: boolean; value?: unknown; getAttribute?(n: string): string | null } | null): boolean {
  if (!el || !el.tagName) return true
  const tag = el.tagName.toUpperCase()
  if (el.isContentEditable) return false
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return true
  return tag === 'TEXTAREA' && el.getAttribute?.('data-testid') === 'composer' && el.value === ''
}

export function hotkeyAction(e: KeyLike, mac: boolean): HotAction | null {
  const att = attentionAction(e, mac)
  if (att) return att
  const srch = searchAction(e, mac)
  if (srch) return srch
  const cmd = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (e.key === 'Escape' && !cmd && !e.altKey) return { type: 'escape' }
  if (!cmd || e.altKey) return null
  if (e.key === 'Enter' && !e.shiftKey) return { type: 'approveFocused' }
  if (e.shiftKey) return null
  // По коду клавиши, а не по символу: в русской раскладке ⌘N даёт `т`, ⌘I — `ш`.
  const code = e.code ?? ''
  if (code === 'KeyK' || e.key.toLowerCase() === 'k') return { type: 'quickSwitch' }
  if (code === 'KeyB' || e.key.toLowerCase() === 'b') return { type: 'toggleSidebar' }
  if (code === 'KeyN' || e.key.toLowerCase() === 'n') return { type: 'newAgent' }
  if (code === 'KeyI' || e.key.toLowerCase() === 'i') return { type: 'toggleInbox' }
  if (code === 'Slash' || e.key === '/') return { type: 'help' }
  // ⌘, — как «Настройки…» в любом приложении macOS (в русской раскладке — «б», поэтому по коду).
  if (code === 'Comma' || e.key === ',') return { type: 'settings' }
  const digit = /^Digit([1-9])$/.exec(code)?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : null)
  if (digit) return { type: 'selectAgent', index: Number(digit) - 1 }
  return null
}

/** Подпись клавиши для подсказок: «⌘N» на маке, «Ctrl+N» на остальных. */
export function keyLabel(k: string, mac: boolean): string {
  return mac ? `⌘${k}` : `Ctrl+${k}`
}

/**
 * ⌘Enter в поле ввода: «прервать и сказать» (О2) или горячая клавиша окна («разрешить выделенный
 * запрос»). Прерывать можно только идущий ход, с текстом и новым демоном; когда сессия ждёт тебя
 * (разрешение, вопрос, выделенный запрос), ⌘Enter остаётся «разрешить» — прервать ход вместо ответа
 * легко по привычке, а это отказ в разрешении и снятый ход (ревью M4).
 */
export function composerCmdEnter(s: {
  busy: boolean
  needsYou: boolean
  permFocused: boolean
  queueable: boolean
  hasText: boolean
  blocked: boolean
}): 'interrupt' | 'window' {
  return s.busy && !s.needsYou && !s.permFocused && s.queueable && s.hasText && !s.blocked ? 'interrupt' : 'window'
}
