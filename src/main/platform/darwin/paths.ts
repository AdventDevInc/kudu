import { homedir } from 'os'
import { join } from 'path'
import type { PlatformPaths, UninstallLeftoverDir } from '../types'
import { buildCleanerPaths } from '../../rules/loader'
import type { RulesJsonSet } from '../../rules/loader'

// JSON rule files — statically imported, bundled by Vite
import systemJson from '../../../../rules/darwin/system.json'
import browsersJson from '../../../../rules/darwin/browsers.json'
import appsJson from '../../../../rules/darwin/apps.json'
import gamingJson from '../../../../rules/darwin/gaming.json'
import gpuCacheJson from '../../../../rules/darwin/gpu-cache.json'
import steamJson from '../../../../rules/darwin/steam.json'
import databasesJson from '../../../../rules/darwin/databases.json'
import miscJson from '../../../../rules/darwin/misc.json'

const HOME = homedir()
const LIBRARY = join(HOME, 'Library')
const CACHES = join(LIBRARY, 'Caches')
const APP_SUPPORT = join(LIBRARY, 'Application Support')

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

const cleanerPaths = buildCleanerPaths(rulesJson, 'darwin')

export function createDarwinPaths(): PlatformPaths {
  return {
    ...cleanerPaths,

    malwareScanDirs(): string[] {
      return [
        join(HOME, 'Downloads'),
        join(HOME, 'Desktop'),
        join(HOME, 'Documents'),
        HOME,                                     // files dropped directly in user home
        '/tmp',
        '/private/tmp',
        '/var/tmp',
        join(LIBRARY, 'LaunchAgents'),
        join(LIBRARY, 'LaunchDaemons'),
        '/Library/LaunchAgents',
        '/Library/LaunchDaemons',
        '/Library/StartupItems',
        join(HOME, '.local', 'bin'),
        join(LIBRARY, 'Application Scripts'),
        join(LIBRARY, 'Services'),
        join(LIBRARY, 'Workflows'),
        '/usr/local/bin',
        '/opt/local/bin',
        '/Applications',
        '/Users/Shared',
        APP_SUPPORT,
      ]
    },

    malwareSystemDirs(): string[] {
      return [
        '/System',
        '/usr',
        '/Library',
        '/Applications',
      ]
    },

    uninstallLeftoverDirs(): UninstallLeftoverDir[] {
      return [
        { id: 'app-support', name: 'Application Support', path: APP_SUPPORT },
        { id: 'caches', name: 'Caches', path: CACHES },
        { id: 'preferences', name: 'Preferences', path: join(LIBRARY, 'Preferences') },
      ]
    },
  }
}
