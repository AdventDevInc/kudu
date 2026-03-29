import path from 'path'
const { join } = path.win32
import { homedir } from 'os'
import type { PlatformPaths, UninstallLeftoverDir } from '../types'
import { buildCleanerPaths } from '../../rules/loader'
import type { RulesJsonSet } from '../../rules/loader'

// JSON rule files — statically imported, bundled by Vite
import systemJson from '../../../../rules/win32/system.json'
import browsersJson from '../../../../rules/win32/browsers.json'
import appsJson from '../../../../rules/win32/apps.json'
import gamingJson from '../../../../rules/win32/gaming.json'
import gpuCacheJson from '../../../../rules/win32/gpu-cache.json'
import steamJson from '../../../../rules/win32/steam.json'
import databasesJson from '../../../../rules/win32/databases.json'
import miscJson from '../../../../rules/win32/misc.json'

const HOME = homedir()
const LOCALAPPDATA = process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local')
const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming')
const PROGRAMDATA = process.env.ProgramData || 'C:\\ProgramData'
const PROGRAMFILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
const PROGRAMFILES = process.env.ProgramFiles || 'C:\\Program Files'

const rulesJson: RulesJsonSet = {
  system: systemJson as RulesJsonSet['system'],
  browsers: browsersJson as RulesJsonSet['browsers'],
  apps: appsJson as RulesJsonSet['apps'],
  gaming: gamingJson as RulesJsonSet['gaming'],
  gpuCache: gpuCacheJson as RulesJsonSet['gpuCache'],
  steam: steamJson as RulesJsonSet['steam'],
  databases: databasesJson as RulesJsonSet['databases'],
  misc: miscJson as RulesJsonSet['misc'],
}

const cleanerPaths = buildCleanerPaths(rulesJson, 'win32')

export function createWin32Paths(): PlatformPaths {
  return {
    ...cleanerPaths,

    malwareScanDirs(): string[] {
      const userProfile = process.env.USERPROFILE || HOME
      return [
        join(userProfile, 'Downloads'),
        join(userProfile, 'Desktop'),
        join(userProfile, 'Documents'),
        userProfile,                              // files dropped directly in user home
        join(LOCALAPPDATA, 'Temp'),
        APPDATA,
        LOCALAPPDATA,
        PROGRAMDATA,
        PROGRAMFILES,
        PROGRAMFILES_X86,
        'C:\\Users\\Public',
        'C:\\Windows\\Temp',
      ]
    },

    malwareSystemDirs(): string[] {
      return [
        'c:\\windows\\system32',
        'c:\\windows\\syswow64',
        'c:\\windows',
        'c:\\windows\\servicing',
        'c:\\windows\\winsxs',
      ]
    },

    uninstallLeftoverDirs(): UninstallLeftoverDir[] {
      return [
        { id: 'localappdata', name: 'AppData Local', path: LOCALAPPDATA },
        { id: 'appdata', name: 'AppData Roaming', path: APPDATA },
        { id: 'programfiles', name: 'Program Files', path: PROGRAMFILES },
        { id: 'programfiles-x86', name: 'Program Files (x86)', path: PROGRAMFILES_X86 },
        { id: 'programdata', name: 'ProgramData', path: PROGRAMDATA },
      ]
    },
  }
}
