export declare const FIRST_LAUNCH_MS = 90000
export declare function waitForAppPort(options: {
  discover: () => void
  hasPort: () => boolean
  launcherExited: () => boolean
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<boolean>
