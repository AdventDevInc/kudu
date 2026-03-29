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

    malwareScanDirs() {
      return [
        // High-risk: common drop locations
        { path: join(HOME, 'Downloads'),              maxDepth: 6, maxFiles: 10000 },
        { path: join(HOME, 'Desktop'),                maxDepth: 4, maxFiles: 5000 },
        { path: join(HOME, 'Documents'),              maxDepth: 4, maxFiles: 5000 },
        { path: HOME,                                 maxDepth: 1, maxFiles: 500 },
        { path: '/tmp',                               maxDepth: 3, maxFiles: 5000 },
        { path: '/private/tmp',                       maxDepth: 3, maxFiles: 5000 },
        { path: '/var/tmp',                           maxDepth: 3, maxFiles: 3000 },
        { path: '/Users/Shared',                      maxDepth: 4, maxFiles: 3000 },

        // Persistence locations — deep scan
        { path: join(LIBRARY, 'LaunchAgents'),        maxDepth: 2, maxFiles: 2000 },
        { path: join(LIBRARY, 'LaunchDaemons'),       maxDepth: 2, maxFiles: 2000 },
        { path: '/Library/LaunchAgents',              maxDepth: 2, maxFiles: 2000 },
        { path: '/Library/LaunchDaemons',             maxDepth: 2, maxFiles: 2000 },
        { path: '/Library/StartupItems',              maxDepth: 2, maxFiles: 1000 },
        { path: join(HOME, '.local', 'bin'),          maxDepth: 2, maxFiles: 1000 },
        { path: join(LIBRARY, 'Application Scripts'), maxDepth: 3, maxFiles: 2000 },
        { path: join(LIBRARY, 'Services'),            maxDepth: 3, maxFiles: 2000 },
        { path: join(LIBRARY, 'Workflows'),           maxDepth: 3, maxFiles: 2000 },

        // Medium-risk: installed software
        { path: '/usr/local/bin',                     maxDepth: 1, maxFiles: 2000 },
        { path: '/opt/local/bin',                     maxDepth: 1, maxFiles: 2000 },
        { path: '/Applications',                      maxDepth: 2, maxFiles: 3000 },
        { path: APP_SUPPORT,                          maxDepth: 3, maxFiles: 5000 },
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
