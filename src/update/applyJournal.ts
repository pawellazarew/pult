// «Перезапустить и обновить» (0.3.16): журнал между старым и новым демоном.
//
// Одна кнопка обновляет и пакет, и окно, а пакет обновляется только перезапуском демона: старый демон, запуская
// `pult update`, кладёт сюда «откуда и куда», а НОВЫЙ при старте читает журнал и доводит окно (замена бандла или
// перезапуск окна — appUpdate.ts `applyAll`). Журнала нет — не было и кнопки (обновление из терминала, демон старше
// 0.3.16): тогда окно обновится следующим нажатием, как раньше.
//
// Новый демон начинает не сразу: `pult update` ещё пробует его (hello за 10 с, жив через 2 с) и при провале
// откатывает — заменять окно под демоном, которого вот-вот остановят, незачем. Итог пробы — в update.json
// (`last.version` = эта версия, сообщение уже не «проба идёт»).

import { readFileSync, rmSync } from 'node:fs'
import type { PultPaths } from '../core/paths.js'
import { atomicWrite } from '../service/fsutil.js'
import { PROBE_PENDING, readState } from './versions.js'

export interface ApplyJournal {
  schema: 1
  /** Версия демона, который нажал «Перезапустить». */
  from: string
  /** Версия, которую он видел в канале (поставиться может и новее — тогда окно догоняет фактическую). */
  to: string
  at: string
  /** Окна (путь исполняемого файла из hello), подключённые при нажатии: новый демон ждёт их переподключения. */
  windows: string[]
}

/** Старше — не доводить: демон, поднятый через полчаса, — уже не тот перезапуск. */
export const APPLY_JOURNAL_MAX_AGE_MS = 30 * 60_000
/** Сколько новый демон ждёт итог пробы `pult update`. */
export const APPLY_PROBE_WAIT_MS = 120_000
/** Сколько новый демон ждёт, пока окна, открытые при нажатии, переподключатся (пауза оболочки — до 5 с). */
export const APPLY_SHELLS_WAIT_MS = 10_000

export function writeApplyJournal(paths: PultPaths, j: Omit<ApplyJournal, 'schema' | 'windows'> & { windows?: string[] }): void {
  atomicWrite(paths.updateApply, JSON.stringify({ schema: 1, ...j, windows: j.windows ?? [] }, null, 2) + '\n', 0o600)
}

export function readApplyJournal(paths: PultPaths): ApplyJournal | null {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(paths.updateApply, 'utf8')) } catch { return null }
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!o || o['schema'] !== 1 || typeof o['from'] !== 'string' || typeof o['to'] !== 'string' || typeof o['at'] !== 'string') return null
  const w = Array.isArray(o['windows']) ? (o['windows'] as unknown[]).filter((x): x is string => typeof x === 'string' && x.length <= 4096).slice(0, 16) : []
  return { schema: 1, from: o['from'], to: o['to'], at: o['at'], windows: w }
}

export function dropApplyJournal(paths: PultPaths): void {
  try { rmSync(paths.updateApply, { force: true }) } catch { /* нет — и ладно */ }
}

/** Журнал годится этому демону: версия сменилась (пакет переключён) и журнал свежий. */
export function journalApplies(j: ApplyJournal, version: string, now = Date.now()): boolean {
  const age = now - Date.parse(j.at)
  return j.from !== version && Number.isFinite(age) && age >= 0 && age < APPLY_JOURNAL_MAX_AGE_MS
}

/**
 * Дождаться итога пробы `pult update` для версии `v` (update.json). true — проба прошла; false — откат, провал или
 * не дождались (`timeoutMs`, `stopped`).
 */
export async function waitPackageProbe(paths: PultPaths, v: string, o: { timeoutMs?: number; pollMs?: number; stopped?: () => boolean } = {}): Promise<boolean> {
  const deadline = Date.now() + (o.timeoutMs ?? APPLY_PROBE_WAIT_MS)
  for (;;) {
    const last = readState(paths).last
    if (last && last.version === v && last.message !== PROBE_PENDING) return last.result === 'ok' || last.result === 'already'
    if (Date.now() >= deadline || o.stopped?.()) return false
    await new Promise((r) => { setTimeout(r, o.pollMs ?? 250) })
  }
}
