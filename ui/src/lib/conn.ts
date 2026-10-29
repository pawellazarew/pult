import { t as tr } from './i18n.js'
// Подпись состояния связи с демоном для шапки и плашки. Чистые функции — тестируются без DOM.

import type { ConnState } from '../../../shell/src/contract.js'

export type Tone = 'ok' | 'run' | 'wait' | 'fail' | 'queued'

export interface ConnView {
  tone: Tone
  /** Короткая подпись в шапке. */
  label: string
  /**
   * Плашка над окном: есть только когда демона нет. Ровная строка про то, что окно делает
   * («Переподключаюсь через 1 с.»), а не техническая причина: причина между попытками меняется
   * («соединение закрыто» → «сокет не отвечает»), и строка прыгала бы при одном и том же сбое.
   */
  banner: string | null
  /** Техническая причина — в подсказку (title) плашки. */
  reason: string | null
  /** Причину надо показать прямо: её чинит человек (токен не подошёл), сама она не пройдёт. */
  reasonVisible: boolean
}

export const DAEMON_DOWN = tr('демон недоступен')

export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return tr`${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return tr`${m} мин`
  const h = Math.floor(m / 60)
  if (h < 24) return tr`${h} ч ${m % 60} мин`
  return tr`${Math.floor(h / 24)} дн ${h % 24} ч`
}

export function connView(s: ConnState): ConnView {
  switch (s.state) {
    case 'up':
      return { tone: 'ok', label: tr`демон ${s.daemon.version} · pid ${s.daemon.pid}`, banner: null, reason: null, reasonVisible: false }
    case 'connecting':
      return { tone: 'run', label: tr('подключение…'), banner: null, reason: null, reasonVisible: false }
    case 'down': {
      const banner = s.retryInMs === null
        ? tr('Сам не переподключаюсь — запусти его кнопкой.')
        : tr`Переподключаюсь через ${Math.max(1, Math.round(s.retryInMs / 1000))} с.`
      return { tone: 'fail', label: DAEMON_DOWN, banner, reason: s.reason, reasonVisible: /токен|token/i.test(s.reason) }
    }
  }
}
