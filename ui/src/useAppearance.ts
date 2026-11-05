import { useEffect, useSyncExternalStore } from 'react'
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, appearanceVariables, effectiveTheme, normalizeAppearance, readAppearance } from './model/appearance.js'
import type { AppearancePreferences } from './model/appearance.js'

let snapshot: AppearancePreferences = { ...DEFAULT_APPEARANCE }
let loaded = false
const listeners = new Set<() => void>()
const serverSnapshot: AppearancePreferences = { ...DEFAULT_APPEARANCE }

function getSnapshot(): AppearancePreferences {
  if (!loaded && typeof window !== 'undefined') {
    loaded = true
    try { snapshot = readAppearance(window.localStorage.getItem(APPEARANCE_KEY)) } catch { snapshot = { ...DEFAULT_APPEARANCE } }
  }
  return snapshot
}

function publish(next: AppearancePreferences): void {
  if (JSON.stringify(snapshot) === JSON.stringify(next)) return
  snapshot = next
  for (const listener of listeners) listener()
}

function storageChanged(event: StorageEvent): void {
  if (event.key !== null && event.key !== APPEARANCE_KEY) return
  publish(readAppearance(event.key === null ? null : event.newValue))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', storageChanged)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', storageChanged)
  }
}

export function setAppearance(patch: Partial<AppearancePreferences>): void {
  const next = normalizeAppearance({ ...getSnapshot(), ...patch })
  try { window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next)) } catch { /* Preferences still work in memory when storage is unavailable. */ }
  publish(next)
}

/** Shared by the workspace and Settings: changes apply immediately and sync between windows. */
export function useAppearance(): { appearance: AppearancePreferences; setAppearance: typeof setAppearance } {
  const appearance = useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot)
  useEffect(() => {
    const root = document.documentElement
    const system = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      root.dataset.theme = effectiveTheme(appearance.theme, system.matches)
      root.dataset.themePreference = appearance.theme
      root.dataset.interfaceMode = appearance.mode
      root.dataset.density = appearance.density
      for (const [key, value] of Object.entries(appearanceVariables(appearance))) root.style.setProperty(key, value)
    }
    apply()
    system.addEventListener('change', apply)
    return () => system.removeEventListener('change', apply)
  }, [appearance])
  return { appearance, setAppearance }
}
