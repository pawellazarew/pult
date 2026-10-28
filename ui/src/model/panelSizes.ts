export const clampSize = (value: number, min: number, max: number): number => Math.min(Math.max(min, max), Math.max(min, value))

/** A saved preference is not overwritten when the window temporarily becomes smaller. */
export function savedSize(raw: string | null): number | null {
  if (raw === null || !raw.trim()) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n < 10_000 ? n : null
}

export interface WorkspaceFlags { sidebarHidden: boolean; inboxOpen: boolean; filesOpen: boolean; filesExpanded: boolean }
export function workspaceSizes(width: number, flags: WorkspaceFlags, preferred: { sidebar: number | null; right: number | null }) {
  const focused = flags.filesOpen && flags.filesExpanded
  const rightShown = !focused && (flags.inboxOpen || flags.filesOpen)
  const sidebarMin = Math.min(200, width * .25)
  const conversationMin = Math.min(320, width * .4)
  const rightMin = Math.min(300, width * .3)
  const sidebarDefault = width <= 950 ? 200 : width <= 1050 ? 232 : width <= 1200 ? 248 : 272
  const initialSidebarMax = Math.max(sidebarMin, Math.min(480, width - conversationMin - (rightShown ? rightMin : 0)))
  const sidebar = flags.sidebarHidden ? 0 : clampSize(preferred.sidebar ?? sidebarDefault, sidebarMin, initialSidebarMax)
  const rightMax = Math.max(rightMin, width - sidebar - conversationMin)
  const rightDefault = flags.filesOpen ? Math.max(420, width * .42) : width <= 950 ? 300 : width <= 1050 ? 320 : width <= 1200 ? 340 : 360
  const right = rightShown ? clampSize(preferred.right ?? rightDefault, rightMin, rightMax) : 0
  const sidebarMax = Math.max(sidebarMin, Math.min(480, width - conversationMin - right))
  return { sidebar, sidebarMin, sidebarMax, right, rightMin, rightMax, focused, rightShown }
}
