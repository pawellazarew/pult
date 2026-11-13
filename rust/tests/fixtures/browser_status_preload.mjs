// Test-only oracle guard, not a sandbox. Never probe real Chrome or spawn a
// daemon/provider/installer. homedir is a private fixture discovery seam.
import fs from 'node:fs'
import os from 'node:os'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const systems = new Set(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'])
if (!process.env.PULT_TEST_BROWSER_HOME) throw new Error('browser oracle requires private discovery context')
// The virtual fixture has a macOS-style user Applications candidate on either
// CI OS. This changes discovery inputs, not production platform handling.
Object.defineProperty(process, 'platform', { value: 'darwin' })
os.homedir = () => process.env.PULT_TEST_BROWSER_HOME
for (const name of ['statSync', 'accessSync']) {
  const original = fs[name]
  fs[name] = (path, ...args) => {
    if (systems.has(String(path))) { const error = new Error('fixture has no system Chrome'); error.code = 'ENOENT'; throw error }
    return original(path, ...args)
  }
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = () => { throw new Error('browser oracle prohibits subprocess execution') }
syncBuiltinESMExports()
