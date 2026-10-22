// Плашка обновления (M8c): что сказать человеку по `daemon.status.update` и версии окна. Чистые функции.
//
// ВЕРСИЯ ОКНА: оболочка её мостом не отдаёт, но Electron кладёт имя и версию приложения в user agent:
// «… Pult/0.1.14 Chrome/… Electron/…» (в рабочей копии — имя пакета, «pult-shell/0.1.14»). Так плашка
// работает и в окне 0.1.13, которому не нужна новая оболочка ради одной строки.
//
// Плашка тихая: одна строка над окном, без всплывающих окон и звука. «Обновить» не доступно, когда пакету
// нужно окно новее этого: новый пакет со старым окном мог бы не открыться — тогда только ссылка на релиз
// (окно сменяется руками до 0.3.1).

import { compareVersions } from '../../../src/core/semver.js'
import type { UpdateStatus } from '../../../src/core/rpc.js'

const UA_RE = /(?:^|\s)(?:Pult|pult-shell)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/

/** Версия окна из user agent Electron; не нашли — null (тогда про окно молчим). */
export function windowVersionFromUA(ua: string | undefined | null): string | null {
  return UA_RE.exec(ua ?? '')?.[1] ?? null
}

export interface UpdateBannerView {
  /** data-testid и тон плашки. */
  kind: 'available' | 'window' | 'waiting' | 'applying' | 'failed' | 'rolledback'
  text: string
  /** Страница релиза — «Что нового». */
  notes: string | null
  /** Кнопка: «Обновить» (`apply`), «Сейчас» (`force`), «Повторить» (`retry`) или никакой. */
  action: { label: string; force: boolean } | null
  /** Ключ «скрыть крестиком»: версия (до следующей) или `failure:<время>` (до следующей неудачи); null — не скрывается. */
  dismissKey: string | null
}

const turnsText = (n: number): string => {
  const mod10 = n % 10
  const mod100 = n % 100
  const word = mod10 === 1 && mod100 !== 11 ? 'идёт' : 'идут'
  return `${n} ${word}`
}

/**
 * Что показать. `dismissed` — что человек скрыл крестиком (версия или `failure:<время>`): «Доступна …» и
 * «не встало» про это больше не всплывают, но ожидание, установка и провал запуска видны всегда — их
 * человек запустил сам.
 */
export function updateBanner(u: UpdateStatus | undefined | null, windowVersion: string | null, dismissed: readonly string[] = []): UpdateBannerView | null {
  if (!u) return null
  const latest = u.latest
  const notes = latest?.notes ?? null
  switch (u.apply.state) {
    case 'waiting':
      return {
        kind: 'waiting',
        text: `Обновлю до ${u.apply.to} после окончания ходов (${turnsText(u.apply.turns)})`,
        notes, action: { label: 'Сейчас', force: true }, dismissKey: null,
      }
    case 'applying':
      return {
        kind: 'applying',
        text: `Обновляю до ${u.apply.to}… Демон перезапустится, окно переподключится само; новые реплики — после перезапуска`,
        notes: null, action: null, dismissKey: null,
      }
    case 'failed':
      return {
        kind: 'failed',
        text: `Обновление не удалось: ${u.apply.error}`,
        notes, action: u.available ? { label: 'Повторить', force: false } : null, dismissKey: null,
      }
    case 'idle':
      break
  }
  // Проба не прошла и откат — после него это уже другой демон, и только update.json помнит, что было.
  const f = u.failure ?? null
  // Старая неудача не заслоняет НОВУЮ версию: вышла версия новее не вставшей — показываем её.
  const newerThanFailure = f !== null && u.available && latest !== null && compareVersions(latest.version, f.to) > 0
  if (f && !newerThanFailure && !dismissed.includes(`failure:${f.at}`)) {
    const details = f.log ? `подробности: ${f.log}` : 'подробности были в терминале'
    return {
      kind: 'rolledback',
      text: f.back !== null
        ? `Обновление до ${f.to} не встало, вернул ${f.back} · ${details}`
        : `Обновление до ${f.to} не встало: ${f.message} · ${details}`,
      notes: null, action: null, dismissKey: `failure:${f.at}`,
    }
  }
  if (!u.available || !latest || dismissed.includes(latest.version)) return null
  const min = latest.app?.minVersion ?? null
  if (min !== null && windowVersion !== null && compareVersions(windowVersion, min) < 0) {
    return {
      kind: 'window',
      text: `Доступна ${latest.version} · Нужна новая версия окна (стоит ${windowVersion}, нужна ${min} или новее) — скачай её на странице релиза`,
      notes, action: null, dismissKey: latest.version,
    }
  }
  return {
    kind: 'available',
    text: `Доступна ${latest.version}`,
    notes, action: { label: 'Обновить', force: false }, dismissKey: latest.version,
  }
}

/** Скрытые ключи — небольшой список: новый ключ в конец, старые вытесняются (версий и неудач немного). */
export const DISMISSED_MAX = 20
export function addDismissed(list: readonly string[], key: string): string[] {
  return [...list.filter((k) => k !== key), key].slice(-DISMISSED_MAX)
}

/** Отказ `update.apply` со старой оболочкой: метода нет в её белом списке — подсказка, как обновиться иначе. */
export function applyErrorText(code: string | null, message: string): string {
  if (code === 'method_not_allowed') return 'Это окно не умеет запускать обновление (оболочка старше 0.1.14) — в терминале: pult update'
  return `Обновление не запустилось: ${message}`
}

// --- «Настройки» → «Обновления» (⌘,): версии, состояние канала, «Проверить сейчас», «Обновить до X» -------------

/** Окно вернулось на экран, а последняя проверка старше этого — попросить демона проверить (он сам держит предел частоты). */
export const FOCUS_CHECK_STALE_MS = 3_600_000

/** Просить ли демона проверить по фокусу окна: автопроверка включена, ничего не ставится, проверка давняя или не было. */
export function focusCheckWanted(u: UpdateStatus | undefined | null, now: number): boolean {
  if (!u || !u.enabled || u.checking || u.apply.state !== 'idle') return false
  const t = u.checkedAt ? Date.parse(u.checkedAt) : Number.NaN
  return !Number.isFinite(t) || now - t >= FOCUS_CHECK_STALE_MS
}

/** «последняя проверка: 5 мин назад». */
export function checkedAgoText(iso: string | null, now: number): string {
  if (!iso) return 'последняя проверка: ещё не было'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'последняя проверка: —'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'последняя проверка: только что'
  const m = Math.round(s / 60)
  if (m < 60) return `последняя проверка: ${m} мин назад`
  const h = Math.floor(m / 60)
  if (h < 24) return `последняя проверка: ${h} ч назад`
  return `последняя проверка: ${Math.floor(h / 24)} дн назад`
}

export interface UpdateSectionView {
  /** data-state строки состояния. */
  state: 'unsupported' | 'unknown' | 'checking' | 'uptodate' | 'available' | 'window' | 'waiting' | 'applying' | 'failed' | 'error' | 'bad' | 'local'
  text: string
  /** Страница релиза — «Что нового». */
  notes: string | null
  /** «Обновить до X», «Сейчас», «Повторить» — тот же путь, что у плашки (`update.apply`). */
  action: { label: string; force: boolean } | null
  /** Можно ли нажать «Проверить сейчас». */
  canCheck: boolean
  /** «последняя проверка: …». */
  checked: string
  /** Вторая строка: прошлая проверка не удалась, хотя известное обновление осталось. */
  note: string | null
}

/**
 * Что показать в разделе «Обновления». `local` — то, что знает только окно: идёт ли его «Проверить сейчас»
 * и чем кончился сам вызов (старая оболочка, демон недоступен). Ошибка канала (сеть, 404 с подсказкой) —
 * из статуса демона.
 */
export function updateSection(
  u: UpdateStatus | undefined | null,
  windowVersion: string | null,
  local: { checking: boolean; error: string | null },
  now: number,
): UpdateSectionView {
  const base = { notes: null, action: null, canCheck: true, note: null }
  if (!u) {
    return {
      ...base, state: local.checking ? 'checking' : local.error ? 'error' : 'unsupported',
      text: local.checking ? 'Проверяю канал обновлений…' : local.error ? `Проверить не вышло: ${local.error}` : 'Демон не сообщает о канале обновлений — в терминале: pult update --check',
      checked: checkedAgoText(null, now),
    }
  }
  const checked = checkedAgoText(u.checkedAt, now)
  const latest = u.latest
  const notes = latest?.notes ?? null
  switch (u.apply.state) {
    case 'waiting':
      return { ...base, state: 'waiting', text: `Обновлю до ${u.apply.to} после окончания ходов (${turnsText(u.apply.turns)})`, notes, action: { label: 'Сейчас', force: true }, canCheck: false, checked }
    case 'applying':
      return { ...base, state: 'applying', text: `Обновляю до ${u.apply.to}… Демон перезапустится, окно переподключится само`, canCheck: false, checked }
    case 'failed':
      return { ...base, state: 'failed', text: `Обновление не удалось: ${u.apply.error}`, notes, action: u.available ? { label: 'Повторить', force: false } : null, checked }
    case 'idle':
      break
  }
  // Кнопку держит только СВОЙ вызов: `u.checking` из снимка статуса может устареть, а нажатие во время проверки
  // демона просто дождётся её итога.
  if (local.checking || u.checking) return { ...base, state: 'checking', text: 'Проверяю канал обновлений…', canCheck: !local.checking, checked }
  if (local.error) return { ...base, state: 'error', text: `Проверить не вышло: ${local.error}`, checked }
  const errNote = u.error ? `Последняя проверка не удалась: ${u.error}` : null
  if (u.available && latest) {
    const min = latest.app?.minVersion ?? null
    if (min !== null && windowVersion !== null && compareVersions(windowVersion, min) < 0) {
      return { ...base, state: 'window', text: `Доступна ${latest.version} · нужна новая версия окна (стоит ${windowVersion}, нужна ${min} или новее) — скачай её на странице релиза`, notes, checked, note: errNote }
    }
    return { ...base, state: 'available', text: `Доступна ${latest.version}`, notes, action: { label: `Обновить до ${latest.version}`, force: false }, checked, note: errNote }
  }
  if (u.error) return { ...base, state: 'error', text: `Проверить не вышло: ${u.error}`, checked }
  if (latest && u.bad) {
    return { ...base, state: 'bad', text: `В канале ${latest.version}, но на этой машине она уже не прошла пробу — сама не ставится; повторить: pult update --to ${latest.version}`, notes, checked }
  }
  if (latest && compareVersions(latest.version, u.current) > 0) {
    return { ...base, state: 'local', text: `В канале ${latest.version}; эта установка — рабочая копия, канал её не обновляет`, notes, checked }
  }
  if (latest) return { ...base, state: 'uptodate', text: `Установлена последняя версия (${u.current})`, checked }
  return { ...base, state: 'unknown', text: 'Ещё не проверял — «Проверить сейчас»', checked }
}

/** Итог ручной проверки для короткой плашки: ставить нечего — «Установлена последняя версия (X)»; иначе null. */
export function upToDateNote(u: UpdateStatus | undefined | null): string | null {
  if (!u || u.error || u.available || !u.latest || u.apply.state !== 'idle') return null
  return compareVersions(u.latest.version, u.current) > 0 ? null : `Установлена последняя версия (${u.current})`
}

/** Отказ `update.check` словами: старая оболочка не пропускает метод — подсказка про терминал. */
export function checkErrorText(code: string | null, message: string): string {
  if (code === 'method_not_allowed') return 'это окно не умеет проверять обновления (оболочка старше 0.1.14) — в терминале: pult update --check'
  return message
}
