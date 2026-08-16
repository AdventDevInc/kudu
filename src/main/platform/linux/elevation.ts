import { existsSync } from 'fs'
import { isAbsolute } from 'path'
import type { PlatformElevation } from '../types'

/**
 * AppImages execute Electron from a temporary FUSE mount. Relaunching that
 * mounted executable is racy because the mount is torn down when the current
 * AppImage exits. Prefer the original AppImage file, which remains available
 * long enough for the elevated process to create its own mount.
 */
export function getLinuxRelaunchExecutable(
  exePath: string,
  appImagePath = process.env.APPIMAGE,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (appImagePath && isAbsolute(appImagePath) && pathExists(appImagePath)) {
    return appImagePath
  }
  return exePath
}

const ELEVATION_ENV_KEYS = [
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'HOME',
  'DBUS_SESSION_BUS_ADDRESS',
] as const

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Keep the authenticated helper alive until the current app has exited. This
 * makes the single-instance lock hand-off deterministic: the old process
 * releases the lock before the elevated process tries to acquire it.
 */
export function buildLinuxElevationCommand(
  executable: string,
  userDataDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  parentPid = process.pid,
): string {
  const parts: string[] = []
  for (const key of ELEVATION_ENV_KEYS) {
    if (environment[key]) parts.push(`${key}=${shellQuote(environment[key])}`)
  }
  parts.push(shellQuote(executable), '--no-sandbox', `--kudu-data-dir=${shellQuote(userDataDir)}`)

  return `(while kill -0 ${parentPid} 2>/dev/null; do sleep 0.05; done; ${parts.join(' ')}) > /dev/null 2>&1 &`
}

export function createLinuxElevation(): PlatformElevation {
  return {
    isAdmin(): boolean {
      return process.getuid?.() === 0
    },
  }
}
