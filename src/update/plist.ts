// Строки верхнего уровня Info.plist (окно, 0.3.4) — без зависимостей и без node:*: его берут и демон
// (обновление окна, `pult update --check`), и клиент сокета внутри оболочки (версия окна в hello).
//
// Разбор нарочно узкий: Pult.app пишет XML-plist (electron-builder), нужны три строки —
// CFBundleIdentifier, CFBundleShortVersionString, CFBundleExecutable. Ключ, встреченный дважды (вложенный
// словарь с тем же именем), — «не знаю», а не первое попавшееся: подложенный ключ не должен выбирать значение.
// Бинарный plist (`bplist…`) здесь не читается — демон на macOS переводит его в XML через plutil (appUpdate.ts).

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }

/** Бинарный plist: текстом его не прочесть. */
export const isBinaryPlist = (text: string): boolean => text.startsWith('bplist')

/** Одна строка plist по ключу; нет, не строка или ключ встречен не один раз — null. */
export function plistString(xml: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<key>${esc}</key>\\s*<string>([^<]{0,512})</string>`, 'g')
  const keyRe = new RegExp(`<key>${esc}</key>`, 'g')
  const all = [...xml.matchAll(re)]
  if (all.length !== 1 || (xml.match(keyRe) ?? []).length !== 1) return null
  const raw = all[0]?.[1] ?? ''
  const v = raw.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m).trim()
  return v.length ? v : null
}

export interface BundleStrings {
  id: string | null
  version: string | null
  executable: string | null
}

export function bundleStrings(xml: string): BundleStrings {
  return {
    id: plistString(xml, 'CFBundleIdentifier'),
    version: plistString(xml, 'CFBundleShortVersionString'),
    executable: plistString(xml, 'CFBundleExecutable'),
  }
}
