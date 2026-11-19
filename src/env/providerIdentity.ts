import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { redactString } from '../core/log.js'
import type { LocatedTool, VersionRun } from './locate.js'

/** Decimal nanoseconds/integers preserve identity across Node and Rust JSON. */
export interface ProviderFileIdentity {
  path: string
  realpath: string
  dev: string
  ino: string
  size: string
  mtimeNs: string
  ctimeNs: string
}

export interface ObservedProviderTool extends LocatedTool {
  installation: ProviderFileIdentity | null
  changedDuringCheck: boolean
}

/** File observation only. Never launch a CLI on the daemon startup path. */
export function captureProviderIdentity(file: string): ProviderFileIdentity | null {
  if (!isAbsolute(file)) return null
  try {
    const realpath = realpathSync(file)
    const before = statSync(realpath, { bigint: true })
    if (!before.isFile() || (before.mode & 0o111n) === 0n) return null
    accessSync(realpath, constants.X_OK)
    const after = statSync(realpath, { bigint: true })
    if (realpathSync(file) !== realpath || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return null
    return { path: file, realpath, dev: after.dev.toString(), ino: after.ino.toString(), size: after.size.toString(),
      mtimeNs: after.mtimeNs.toString(), ctimeNs: after.ctimeNs.toString() }
  } catch { return null }
}

/** An alias and its canonical executable are the same installation. */
export function sameProviderIdentity(a: ProviderFileIdentity | null | undefined, b: ProviderFileIdentity | null | undefined): boolean {
  return !!a && !!b && a.realpath === b.realpath && a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

/** Tie the reported version to the file observed on both sides of that exact launch. */
export async function observeProviderTool(tool: LocatedTool, run: (file: string, args: string[]) => Promise<VersionRun>): Promise<ObservedProviderTool> {
  if (!tool.path) return { ...tool, installation: null, changedDuringCheck: false }
  const before = captureProviderIdentity(tool.path)
  if (!before) return { ...tool, realpath: null, version: null, versionExitCode: null, installation: null, changedDuringCheck: true }
  let result: VersionRun
  try { result = await run(tool.path, ['--version']) }
  catch { result = { status: null, stdout: '', stderr: '' } }
  const installation = captureProviderIdentity(tool.path)
  const changedDuringCheck = !sameProviderIdentity(before, installation)
  const version = result.status === 0 && !changedDuringCheck
    ? redactString((result.stdout || result.stderr).trim().split('\n')[0] ?? '').slice(0, 1024) || null : null
  return { ...tool, realpath: installation?.realpath ?? null, version, versionExitCode: result.status, installation, changedDuringCheck }
}
