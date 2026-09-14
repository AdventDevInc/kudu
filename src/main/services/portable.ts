import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The EXE launcher sets an environment variable; ZIPs carry a resource marker. */
export function isPortable(): boolean {
  return (
    process.platform === 'win32' &&
    app.isPackaged &&
    (!!process.env.PORTABLE_EXECUTABLE_DIR ||
      existsSync(join(process.resourcesPath, 'portable.json')))
  )
}

/** Portable runs must not change the installed copy's shared startup task. */
export function skipPortableStartup(enabled: boolean): boolean {
  if (!isPortable()) return false
  if (enabled) throw new Error('Run at startup requires the installed version of Kudu')
  return true
}
