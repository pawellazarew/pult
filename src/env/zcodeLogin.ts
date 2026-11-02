// Вход ZCode по файлу кред. У CLI нет команды «статус входа» (спайк docs/17-SPIKE-zcode.md),
// а живой `-p`-запрос стоит квоты, поэтому состояние входа меряется по файлу: есть ли в
// `~/.zcode/v2/credentials.json` ключ `oauth:*:access_token` или `zcodejwttoken`. Содержимое
// токенов НЕ читается и никуда не уходит — только наличие ключей.
// Отдельный модуль, а не часть providers.ts/doctor.ts: его импортируют оба, а те друг друга.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Каталог кред переносится env `ZCODE_DATA_BASE_DIR` (общие креды с десктопом ZCode). */
export function zcodeCredsFile(): string {
  const base = process.env['ZCODE_DATA_BASE_DIR'] ?? join(homedir(), '.zcode', 'v2')
  return join(base, 'credentials.json')
}

/**
 * `yes` — вход есть; `no` — файла нет (или токенных ключей в нём нет); `unknown` — файл есть,
 * но не разбирается: советовать `zcode login` на таком основании нельзя (инвариант: «не разобрал»
 * ≠ «не входил»), человек смотрит файл сам.
 */
export function zcodeLoginState(credsFile: string): 'yes' | 'no' | 'unknown' {
  let text: string
  try {
    text = readFileSync(credsFile, 'utf8')
  } catch {
    return 'no'
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown'
    const keys = Object.keys(parsed as Record<string, unknown>)
    return keys.some((k) => k === 'zcodejwttoken' || /^oauth:.*:access_token$/.test(k)) ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}
