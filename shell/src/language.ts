import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isLanguageSetting, resolveLanguage, setLanguage } from '../../src/i18n/core.js'
/** Read only the language key: never mutate config or initialize daemon services. */
export function refreshLanguage(home: string, systemLocale: string): void {
  let setting: unknown
  try { setting = (JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) as { language?: unknown }).language } catch { /* auto on missing/malformed config */ }
  const override = process.env['PULT_LANG']
  setLanguage(resolveLanguage(isLanguageSetting(override) ? override : isLanguageSetting(setting) ? setting : 'auto', systemLocale))
}
