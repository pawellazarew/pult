// Test-only guard for the actual public Node runtime command. No production hooks.
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const allowed = process.env.PULT_TEST_RUNTIME_EXEC
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name]
  cp[name] = (file, args, ...rest) => {
    if (!allowed || file !== allowed || JSON.stringify(args) !== '["-v"]') throw new Error('runtime oracle prohibits this subprocess')
    if (Object.keys(rest[0]?.env ?? {}).some(key => !['HOME', 'USER', 'PATH', 'LANG', 'TERM', 'TMPDIR'].includes(key))) throw new Error('runtime oracle prohibits child environment key')
    return original(file, args, ...rest)
  }
}
for (const name of ['exec', 'execSync', 'fork']) cp[name] = () => { throw new Error('runtime oracle prohibits subprocess execution') }
syncBuiltinESMExports()
