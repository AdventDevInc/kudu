import { app } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { CustomCleaners } from './custom-cleaners'
import { CustomCleanerStore } from './custom-cleaner-store'
import { getSettings } from './settings-store'
let service: CustomCleaners | null = null
export function getCustomCleaners(): CustomCleaners {
  if (service) return service
  const platform = process.platform
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux')
    throw new Error('Unsupported operating system')
  const userData = app.getPath('userData')
  const dir = app.isPackaged ? userData : join(userData, 'Kudu-Dev')
  const protectedRoots =
    platform === 'win32'
      ? [
          process.env.WINDIR || 'C:\\Windows',
          process.env.ProgramFiles || 'C:\\Program Files',
          process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
          process.env.ProgramData || 'C:\\ProgramData',
          'C:\\Recovery'
        ]
      : [
          '/bin',
          '/sbin',
          '/usr',
          '/etc',
          '/var',
          '/lib',
          '/lib64',
          '/boot',
          '/dev',
          '/proc',
          '/sys',
          '/run',
          '/System',
          '/Library',
          '/Applications',
          '/private',
          '/opt'
        ]
  service = new CustomCleaners(
    new CustomCleanerStore(join(dir, 'custom-cleaners.json')),
    { platform, home: homedir(), userData, protectedRoots },
    () => getSettings().exclusions,
    () => getSettings().cleaner.skipRecentMinutes
  )
  return service
}
