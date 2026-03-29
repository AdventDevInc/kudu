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

    malwareScanDirs() {
      const userProfile = process.env.USERPROFILE || HOME
      return [
        // High-risk: common malware drop locations — deep scan, high file limits
        { path: join(userProfile, 'Downloads'),  maxDepth: 6, maxFiles: 10000 },
        { path: join(userProfile, 'Desktop'),    maxDepth: 4, maxFiles: 5000 },
        { path: join(userProfile, 'Documents'),  maxDepth: 4, maxFiles: 5000 },
        { path: userProfile,                     maxDepth: 1, maxFiles: 500 },
        { path: join(LOCALAPPDATA, 'Temp'),      maxDepth: 4, maxFiles: 10000 },
        { path: 'C:\\Windows\\Temp',             maxDepth: 3, maxFiles: 5000 },
        { path: 'C:\\Users\\Public',             maxDepth: 4, maxFiles: 3000 },

        // Medium-risk: persistence & dropper locations — moderate scan
        { path: APPDATA,                         maxDepth: 5, maxFiles: 8000 },
        { path: LOCALAPPDATA,                    maxDepth: 4, maxFiles: 8000 },
        { path: PROGRAMDATA,                     maxDepth: 3, maxFiles: 5000 },

        // Lower-risk: installed programs — shallow scan for trojaned executables
        { path: PROGRAMFILES,                    maxDepth: 2, maxFiles: 3000 },
        { path: PROGRAMFILES_X86,                maxDepth: 2, maxFiles: 3000 },
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
