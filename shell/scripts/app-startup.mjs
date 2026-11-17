// Verification utility: wait for the debug server without confusing it with app readiness.
// Ownership discovery must run before accepting a port or a launcher exit.
export const FIRST_LAUNCH_MS = 90_000
const PORT_POLL_MS = 100

export async function waitForAppPort({ discover, hasPort, launcherExited,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const deadline = now() + FIRST_LAUNCH_MS
  while (now() < deadline) {
    discover()
    if (hasPort()) return true
    if (launcherExited()) return false
    await sleep(PORT_POLL_MS)
  }
  return false
}
