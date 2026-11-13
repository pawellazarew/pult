// Test-only fail-fast guard, not a security sandbox. The real Node CLI must
// finish on the already-bound fake socket; fallback must never start a daemon,
// service, provider, installer or diagnostic subprocess.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { throw new Error('CLI oracle prohibits subprocess execution') }
}
syncBuiltinESMExports()
