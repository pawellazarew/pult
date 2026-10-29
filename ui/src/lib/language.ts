import { detectLanguage, setLanguage } from '../../../src/i18n/core.js'

/** The shell reads config and OS locale before preload exposes the bridge. No daemon/network wait. */
export async function initializeLanguage(): Promise<void> {
  const language = window.pult?.language ?? detectLanguage(navigator.language)
  setLanguage(language)
  document.documentElement.lang = language
  document.title = language === 'en' ? 'Pult' : 'Пульт'
}
