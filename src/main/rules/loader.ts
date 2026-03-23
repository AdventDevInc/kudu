// ─── Rules Loader ─────────────────────────────────────────────
// Reads JSON rule files, resolves template variables (e.g. ${HOME}),
// normalises path separators, and returns a partial PlatformPaths
// containing only the cleaner-related methods.

import { homedir, tmpdir } from 'os'
import path from 'path'
import type {
  CleanTarget,
  BrowserPathConfig,
  BrowserPaths,
  AppCacheDef,
  DatabaseTarget,
} from '../platform/types'

// ─── JSON type shapes (match the schema) ──────────────────────

export interface SystemRulesJson {
  type: 'system'
  cleanTargets: Array<{
    path: string
    subcategory: string
    needsAdmin?: boolean
    childSubdir?: string
  }>
  singleFileTargets?: Array<{ path: string; subcategory: string }>
}

export interface BrowserRulesJson {
  type: 'browsers'
  chromiumCacheDirs: {
    cache: string
    codeCache: string
    gpuCache: string
    serviceWorker: string
  }
  chromium: Array<{ key: string; base: string }>
  firefox: { base: string; cache: string }
  firefoxForks?: Array<{ key: string; base: string; cache: string }>
  safari?: { cache: string } | null
}

export interface AppRulesJson {
  type: 'apps' | 'gaming' | 'gpu-cache'
  apps: Array<{
    id: string
    name: string
    paths: string[]
    childSubdir?: string
  }>
}

export interface SteamRulesJson {
  type: 'steam'
  libraries: string[]
  redistPatterns: string[]
}

export interface DatabaseRulesJson {
  type: 'databases'
  sharedDbFileSets?: Record<string, string[]>
  targets: Array<{
    label: string
    basePath: string
    dbFiles: string | string[]
    multiProfile?: boolean
    profilePattern?: string[]
  }>
}

export interface MiscRulesJson {
  type: 'misc'
  protectedEventLogs?: string[]
  trashPath?: string | null
}

export interface RulesJsonSet {
  system: SystemRulesJson
  browsers: BrowserRulesJson
  apps: AppRulesJson
  gaming: AppRulesJson
  gpuCache: AppRulesJson
  steam: SteamRulesJson
  databases: DatabaseRulesJson
  misc: MiscRulesJson
}

// ─── Cleaner-only subset of PlatformPaths ─────────────────────

export interface CleanerPaths {
  systemCleanTargets(): CleanTarget[]
  singleFileCleanTargets(): { path: string; subcategory: string }[]
  protectedEventLogs(): string[]
  browserPaths(): BrowserPathConfig
  appPaths(): AppCacheDef[]
  gamingPaths(): AppCacheDef[]
  gpuCachePaths(): AppCacheDef[]
  steamLibraries(): string[]
  steamRedistPatterns(): string[]
  trashPath(): string | null
  databaseOptimizeTargets(): DatabaseTarget[]
}

// ─── Variable maps ────────────────────────────────────────────

function buildVariables(platform: 'win32' | 'darwin' | 'linux'): Record<string, string> {
  const HOME = homedir()
  const sep = platform === 'win32' ? path.win32 : path.posix
  switch (platform) {
    case 'win32': {
      const LOCALAPPDATA = process.env.LOCALAPPDATA || sep.join(HOME, 'AppData', 'Local')
      const APPDATA = process.env.APPDATA || sep.join(HOME, 'AppData', 'Roaming')
      return {
        HOME,
        LOCALAPPDATA,
        APPDATA,
        WINDIR: process.env.WINDIR || 'C:\\Windows',
        PROGRAMDATA: process.env.ProgramData || 'C:\\ProgramData',
        PROGRAMFILES: process.env.ProgramFiles || 'C:\\Program Files',
        PROGRAMFILES_X86: process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        TMPDIR: tmpdir(),
      }
    }
    case 'darwin': {
      const LIBRARY = sep.join(HOME, 'Library')
      return {
        HOME,
        LIBRARY,
        CACHES: sep.join(LIBRARY, 'Caches'),
        APP_SUPPORT: sep.join(LIBRARY, 'Application Support'),
        TMPDIR: tmpdir(),
      }
    }
    case 'linux':
      return {
        HOME,
        CONFIG: sep.join(HOME, '.config'),
        CACHE: sep.join(HOME, '.cache'),
        LOCAL_SHARE: sep.join(HOME, '.local', 'share'),
        TMPDIR: tmpdir(),
      }
  }
}

// ─── Path resolution ──────────────────────────────────────────

/** Replace ${VAR} references and normalise separators */
export function resolvePath(raw: string, vars: Record<string, string>, platform: 'win32' | 'darwin' | 'linux'): string {
  const resolved = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const val = vars[name]
    if (val === undefined) throw new Error(`Unknown template variable \${${name}} in path: ${raw}`)
    return val
  })
  // Normalise separators: JSON always uses '/', convert to platform separator
  if (platform === 'win32') {
    return resolved.replace(/\//g, '\\')
  }
  return resolved
}

function resolvePathArray(arr: string[], vars: Record<string, string>, platform: 'win32' | 'darwin' | 'linux'): string[] {
  return arr.map((p) => resolvePath(p, vars, platform))
}

// ─── Build CleanerPaths from JSON ─────────────────────────────

export function buildCleanerPaths(json: RulesJsonSet, platform: 'win32' | 'darwin' | 'linux'): CleanerPaths {
  const vars = buildVariables(platform)
  const j = platform === 'win32' ? path.win32.join : path.posix.join

  return {
    systemCleanTargets(): CleanTarget[] {
      return json.system.cleanTargets.map((t) => {
        const target: CleanTarget = {
          path: resolvePath(t.path, vars, platform),
          subcategory: t.subcategory,
        }
        if (t.needsAdmin) target.needsAdmin = true
        if (t.childSubdir) target.childSubdir = t.childSubdir
        return target
      })
    },

    singleFileCleanTargets(): { path: string; subcategory: string }[] {
      return (json.system.singleFileTargets || []).map((t) => ({
        path: resolvePath(t.path, vars, platform),
        subcategory: t.subcategory,
      }))
    },

    protectedEventLogs(): string[] {
      return json.misc.protectedEventLogs || []
    },

    browserPaths(): BrowserPathConfig {
      const dirs = json.browsers.chromiumCacheDirs
      const cacheDirsResolved = {
        cache: resolvePath(dirs.cache, vars, platform),
        codeCache: resolvePath(dirs.codeCache, vars, platform),
        gpuCache: resolvePath(dirs.gpuCache, vars, platform),
        serviceWorker: resolvePath(dirs.serviceWorker, vars, platform),
      }

      const config: Record<string, BrowserPaths> = {}
      for (const browser of json.browsers.chromium) {
        config[browser.key] = {
          base: resolvePath(browser.base, vars, platform),
          ...cacheDirsResolved,
        }
      }

      const firefoxResolved = {
        base: resolvePath(json.browsers.firefox.base, vars, platform),
        cache: resolvePath(json.browsers.firefox.cache, vars, platform),
      }

      const firefoxForks: Record<string, { base: string; cache: string }> = {}
      for (const fork of json.browsers.firefoxForks || []) {
        firefoxForks[fork.key] = {
          base: resolvePath(fork.base, vars, platform),
          cache: resolvePath(fork.cache, vars, platform),
        }
      }

      const safariResolved = json.browsers.safari
        ? { cache: resolvePath(json.browsers.safari.cache, vars, platform) }
        : null

      return {
        chrome: config.chrome,
        edge: config.edge,
        brave: config.brave,
        opera: config.opera,
        operaGX: config.operaGX,
        vivaldi: config.vivaldi,
        arc: config.arc,
        chromium: config.chromium,
        thorium: config.thorium,
        supermium: config.supermium,
        helium: config.helium,
        cromite: config.cromite,
        catsxp: config.catsxp,
        firefox: firefoxResolved,
        librewolf: firefoxForks.librewolf || { base: '', cache: '' },
        waterfox: firefoxForks.waterfox || { base: '', cache: '' },
        floorp: firefoxForks.floorp || { base: '', cache: '' },
        safari: safariResolved,
      } as BrowserPathConfig
    },

    appPaths(): AppCacheDef[] {
      return json.apps.apps.map((a) => {
        const def: AppCacheDef = {
          id: a.id,
          name: a.name,
          paths: resolvePathArray(a.paths, vars, platform),
        }
        if (a.childSubdir) def.childSubdir = a.childSubdir
        return def
      })
    },

    gamingPaths(): AppCacheDef[] {
      return json.gaming.apps.map((a) => {
        const def: AppCacheDef = {
          id: a.id,
          name: a.name,
          paths: resolvePathArray(a.paths, vars, platform),
        }
        if (a.childSubdir) def.childSubdir = a.childSubdir
        return def
      })
    },

    gpuCachePaths(): AppCacheDef[] {
      return json.gpuCache.apps.map((a) => {
        const def: AppCacheDef = {
          id: a.id,
          name: a.name,
          paths: resolvePathArray(a.paths, vars, platform),
        }
        if (a.childSubdir) def.childSubdir = a.childSubdir
        return def
      })
    },

    steamLibraries(): string[] {
      return resolvePathArray(json.steam.libraries, vars, platform)
    },

    steamRedistPatterns(): string[] {
      // Redist patterns may contain backslash-separated paths on win32
      return json.steam.redistPatterns.map((p) => {
        if (platform === 'win32') return p.replace(/\//g, '\\')
        return p
      })
    },

    trashPath(): string | null {
      const tp = json.misc.trashPath
      if (tp == null) return null
      return resolvePath(tp, vars, platform)
    },

    databaseOptimizeTargets(): DatabaseTarget[] {
      const shared = json.databases.sharedDbFileSets || {}
      return json.databases.targets.map((t) => {
        // Resolve dbFiles — either a $reference or an inline array
        let dbFiles: string[]
        if (typeof t.dbFiles === 'string') {
          const key = t.dbFiles.slice(1) // strip leading $
          const set = shared[key]
          if (!set) throw new Error(`Unknown sharedDbFileSets reference '${t.dbFiles}' in database target '${t.label}'`)
          dbFiles = set
        } else {
          dbFiles = t.dbFiles
        }

        // Resolve subdirectory separators in dbFiles (e.g. Network/Cookies)
        dbFiles = dbFiles.map((f) => {
          if (platform === 'win32') return f.replace(/\//g, '\\')
          return f
        })

        const target: DatabaseTarget = {
          label: t.label,
          basePath: resolvePath(t.basePath, vars, platform),
          dbFiles,
        }
        if (t.multiProfile) target.multiProfile = true
        if (t.profilePattern) target.profilePattern = t.profilePattern
        return target
      })
    },
  }
}
