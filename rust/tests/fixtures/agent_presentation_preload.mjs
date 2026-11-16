// The public CLI must connect to the explicit fake socket, never autostart or probe.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[method] = () => { throw new Error('agent presentation oracle forbids subprocesses') }
}
syncBuiltinESMExports()
