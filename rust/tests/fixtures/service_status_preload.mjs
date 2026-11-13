// Test-only child-process guard, not a sandbox. Only the explicit scratch
// manager executable is allowed; daemon/provider/install fallback is forbidden.
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const allowed = new Set([process.env.PULT_LAUNCHCTL, process.env.PULT_SYSTEMCTL].filter(Boolean))
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name]
  cp[name] = (file, ...args) => {
    if (!allowed.has(file)) throw new Error('status oracle prohibits this subprocess')
    return original(file, ...args)
  }
}
for (const name of ['exec', 'execSync', 'fork']) cp[name] = () => { throw new Error('status oracle prohibits subprocess execution') }
syncBuiltinESMExports()
