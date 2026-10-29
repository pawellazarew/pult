/** Shared, dependency-free RU/EN translation engine. Only application-owned literals go through it. */
export type Language = 'ru' | 'en'
export type LanguageSetting = Language | 'auto'
export type Catalog = Readonly<Record<string, string>>
let language: Language = 'ru'
let contextualLanguage: (() => Language | undefined) | undefined
/** Node's request adapter supplies an async context; browser code keeps using the selected language. */
export function setLanguageResolver(resolve: () => Language | undefined): void { contextualLanguage = resolve }
export function getLanguage(): Language { return contextualLanguage?.() ?? language }
export function setLanguage(value: Language): void { language = value }
export function detectLanguage(value: string | null | undefined): Language {
  return /^ru(?:[-_.@]|$)/i.test(value ?? '') ? 'ru' : 'en'
}
export function resolveLanguage(setting: LanguageSetting, system: string | null | undefined): Language {
  return setting === 'auto' ? detectLanguage(system) : setting
}
export function isLanguageSetting(value: unknown): value is LanguageSetting { return value === 'auto' || value === 'ru' || value === 'en' }
export function translator(catalog: Catalog): {
  (source: string): string
  (source: TemplateStringsArray, ...values: unknown[]): string
} {
  return (source: string | TemplateStringsArray, ...values: unknown[]): string => {
    const key = typeof source === 'string' ? source : source.reduce((s, part, i) => s + (i ? `{${i - 1}}` : '') + part, '')
    const translated = getLanguage() === 'en' ? catalog[key] ?? key : key
    return translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match)
  }
}
