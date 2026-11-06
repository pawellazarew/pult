import type { ReactElement } from 'react'
import { t } from '../lib/i18n.js'
import type { Tone } from '../model/types.js'
// Стиль — ui/src/components/status-dot.css, подключён в main.tsx (глобально, см. комментарий там).

/**
 * Одна точка состояния на весь интерфейс: строка чата в боковой панели, вкладка сессии, вкладка
 * субагента, строка фазы хода, плашка статуса в шапке, рейка проектов, временные чаты.
 *
 * ЦВЕТ — ТОЛЬКО СОСТОЯНИЕ. Чей это агент, говорит значок провайдера рядом (ProviderIcon); раньше вкладка
 * красила точку в цвет провайдера (зелёный у Codex), и «работает» нельзя было отличить от «простаивает».
 *
 * Эталон вида — точка строки чата в боковой панели: синяя мигающая, пока агент работает.
 * `prefers-reduced-motion`: мигание выключено, «работает» остаётся отличимым по кольцу вокруг точки.
 */
export type DotState = 'working' | 'waiting' | 'failed' | 'done' | 'idle' | 'queued'
export type DotSize = 'sm' | 'md'

/** Тон модели (`statusView`, `chatStatus`) → состояние точки. Неизвестный тон — нейтральный «в очереди». */
export function toneState(tone: Tone | string): DotState {
  switch (tone) {
    case 'run': return 'working'
    case 'wait': return 'waiting'
    case 'fail': return 'failed'
    case 'ok': return 'done'
    default: return 'queued'
  }
}

/** Подписи для читалки экрана, когда вызывающий не дал своей. */
export function dotLabel(state: DotState): string {
  switch (state) {
    case 'working': return t('Работает')
    case 'waiting': return t('Ждёт ответа')
    case 'failed': return t('Ошибка')
    case 'done': return t('Готово')
    case 'idle': return t('Простаивает')
    case 'queued': return t('В очереди')
  }
}

/** Состояния, ради которых точку стоит показывать в плотных списках (строка, вкладка): остальное — тишина. */
export const LOUD_STATES: ReadonlySet<DotState> = new Set<DotState>(['working', 'waiting', 'failed'])

export function StatusDot({ state, size = 'sm', label, live = false, cutout = false, className, testId }: {
  state: DotState
  /** sm — 5 px (поверх значка, в плотных рядах), md — 7 px (в строке текста). */
  size?: DotSize
  /** Подпись для читалки. `null` — точка декоративная (рядом уже есть тот же текст). По умолчанию — имя состояния. */
  label?: string | null
  /** `role="status"`: смена состояния озвучивается. Только для одиночной точки, не для строк списка. */
  live?: boolean
  /** Кольцо цвета фона (`--dot-cutout`) — точка «вырезана» из значка, на который наложена. */
  cutout?: boolean
  /** Класс места: позиционирование задаёт вызывающий, вид — только этот компонент. */
  className?: string
  testId?: string
}): ReactElement {
  const decorative = label === null
  const name = decorative ? undefined : (label ?? dotLabel(state))
  return (
    <span className={`status-dot${className ? ` ${className}` : ''}`} data-state={state} data-size={size}
      data-cutout={cutout ? '1' : undefined} data-testid={testId}
      role={decorative ? undefined : live ? 'status' : 'img'} aria-label={name} aria-hidden={decorative ? 'true' : undefined} />
  )
}
