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

    malwareScanDirs(): string[] {
      return [
        join(HOME, 'Downloads'),
        join(HOME, 'Desktop'),
        join(HOME, 'Documents'),
        HOME,                                     // files dropped directly in user home
        '/tmp',
        '/var/tmp',
        '/dev/shm',
        join(HOME, '.local', 'bin'),
        join(HOME, '.config', 'autostart'),
        CONFIG,
        LOCAL_SHARE,
        '/usr/local/bin',
        '/opt',
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
