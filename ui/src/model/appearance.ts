/** Per-device presentation preferences. These never change agent permissions or conversation data. */
export type InterfaceMode = 'normal' | 'expanded' | 'focus'
export type ThemePreference = 'system' | 'light' | 'dark'
export type UiFont = 'onest' | 'geologica' | 'system'
export type CodeFont = 'jetbrains' | 'sfmono' | 'menlo'
export type Density = 'comfortable' | 'compact'

export interface AppearancePreferences {
  mode: InterfaceMode
  theme: ThemePreference
  uiFont: UiFont
  codeFont: CodeFont
  fontSize: number
  density: Density
}

export const APPEARANCE_KEY = 'pult.appearance.v1'
export const DEFAULT_APPEARANCE: Readonly<AppearancePreferences> = Object.freeze({
  mode: 'normal', theme: 'system', uiFont: 'onest', codeFont: 'jetbrains', fontSize: 14, density: 'comfortable',
})
export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20] as const

const choice = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === 'string' && values.includes(value as T) ? value as T : fallback

export function normalizeAppearance(value: unknown): AppearancePreferences {
  const p = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    mode: choice(p.mode, ['normal', 'expanded', 'focus'], DEFAULT_APPEARANCE.mode),
    theme: choice(p.theme, ['system', 'light', 'dark'], DEFAULT_APPEARANCE.theme),
    uiFont: choice(p.uiFont, ['onest', 'geologica', 'system'], DEFAULT_APPEARANCE.uiFont),
    codeFont: choice(p.codeFont, ['jetbrains', 'sfmono', 'menlo'], DEFAULT_APPEARANCE.codeFont),
    fontSize: typeof p.fontSize === 'number' && (FONT_SIZES as readonly number[]).includes(p.fontSize) ? p.fontSize : DEFAULT_APPEARANCE.fontSize,
    density: choice(p.density, ['comfortable', 'compact'], DEFAULT_APPEARANCE.density),
  }
}

export function readAppearance(raw: string | null): AppearancePreferences {
  try { return normalizeAppearance(raw === null ? null : JSON.parse(raw)) } catch { return { ...DEFAULT_APPEARANCE } }
}

export function effectiveTheme(preference: ThemePreference, darkSystem: boolean): 'light' | 'dark' {
  return preference === 'system' ? darkSystem ? 'dark' : 'light' : preference
}

export function appearanceVariables(p: AppearancePreferences): Record<string, string> {
  const system = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  const onest = '"Onest", "Helvetica Neue", Arial, sans-serif'
  const geologica = '"Geologica", "Onest", "Helvetica Neue", Arial, sans-serif'
  return {
    '--body': p.uiFont === 'system' ? system : p.uiFont === 'geologica' ? geologica : onest,
    // Default headings retain the existing Pult type pair; other choices use one UI family throughout.
    '--disp': p.uiFont === 'system' ? system : geologica,
    '--mono': p.codeFont === 'sfmono' ? '"SF Mono", ui-monospace, Menlo, Consolas, monospace'
      : p.codeFont === 'menlo' ? 'Menlo, Consolas, monospace' : '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
    '--ui-font-size': `${p.fontSize}px`,
    '--ui-scale': String(p.fontSize / 14),
    '--density-space': p.density === 'compact' ? '.8' : '1',
  }
}
