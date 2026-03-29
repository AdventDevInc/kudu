import { homedir } from 'os'
import { join } from 'path'
import type { PlatformPaths, UninstallLeftoverDir } from '../types'
import { buildCleanerPaths } from '../../rules/loader'
import type { RulesJsonSet } from '../../rules/loader'

// JSON rule files — statically imported, bundled by Vite
import systemJson from '../../../../rules/linux/system.json'
import browsersJson from '../../../../rules/linux/browsers.json'
import appsJson from '../../../../rules/linux/apps.json'
import gamingJson from '../../../../rules/linux/gaming.json'
import gpuCacheJson from '../../../../rules/linux/gpu-cache.json'
import steamJson from '../../../../rules/linux/steam.json'
import databasesJson from '../../../../rules/linux/databases.json'
import miscJson from '../../../../rules/linux/misc.json'

const HOME = homedir()
const CONFIG = join(HOME, '.config')
const CACHE = join(HOME, '.cache')
const LOCAL_SHARE = join(HOME, '.local', 'share')

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

const cleanerPaths = buildCleanerPaths(rulesJson, 'linux')

export function createLinuxPaths(): PlatformPaths {
  return {
    ...cleanerPaths,

    malwareScanDirs() {
      return [
        // High-risk: common drop locations
        { path: join(HOME, 'Downloads'),            maxDepth: 6, maxFiles: 10000 },
        { path: join(HOME, 'Desktop'),              maxDepth: 4, maxFiles: 5000 },
        { path: join(HOME, 'Documents'),            maxDepth: 4, maxFiles: 5000 },
        { path: HOME,                               maxDepth: 1, maxFiles: 500 },
        { path: '/tmp',                             maxDepth: 3, maxFiles: 5000 },
        { path: '/var/tmp',                         maxDepth: 3, maxFiles: 3000 },
        { path: '/dev/shm',                         maxDepth: 2, maxFiles: 2000 },

        // Persistence & config locations
        { path: join(HOME, '.local', 'bin'),        maxDepth: 2, maxFiles: 1000 },
        { path: join(HOME, '.config', 'autostart'), maxDepth: 2, maxFiles: 1000 },
        { path: CONFIG,                             maxDepth: 3, maxFiles: 5000 },
        { path: LOCAL_SHARE,                        maxDepth: 3, maxFiles: 5000 },

        // System binaries — shallow scan
        { path: '/usr/local/bin',                   maxDepth: 1, maxFiles: 2000 },
        { path: '/opt',                             maxDepth: 2, maxFiles: 3000 },
      ]
    },

    malwareSystemDirs(): string[] {
      return ['/usr', '/lib', '/lib64', '/sbin', '/bin', '/opt']
    },

    uninstallLeftoverDirs(): UninstallLeftoverDir[] {
      return [
        { id: 'config', name: 'Config', path: CONFIG },
        { id: 'cache', name: 'Cache', path: CACHE },
        { id: 'local-share', name: 'Data', path: LOCAL_SHARE },
      ]
    },
  }
}
