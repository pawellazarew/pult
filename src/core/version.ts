// Версия пакета — из package.json, а не из константы в коде: две цифры, которые надо
// держать синхронными вручную, рано или поздно разъезжаются.
// Путь считается от собранного файла: dist/core/version.js -> <корень пакета>/package.json.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function read(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION: string = read()

/**
 * `app.minVersion` в latest.json. С 0.3.16 окно выходит с тем же номером, что пакет (shell/package.json = package.json,
 * scripts/release.mjs и test/release.test.ts за этим следят), и обновляется той же кнопкой — отдельная «минимальная
 * версия окна» больше ничего не решает, и новый Пульт её не читает. Поле остаётся в манифесте ради стоящих Пультов
 * старше 0.3.16: их разбор манифеста требует его, а значение выше окна, которое у них стоит (0.1.x), сменило бы их
 * «Обновить» на «Нужна новая версия окна». Поэтому значение заморожено и не поднимается.
 */
export const WINDOW_MIN_VERSION = '0.1.13'
