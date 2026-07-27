// ─── Chromium Cache Targets ───────────────────────────────────
// Shared by the browser cleaner IPC, the CLI, and the cloud agent so all three
// scan the same set of directories. They used to keep their own copies of this
// list, which is how Chromium's shader and CRX caches ended up missing from
// every scan (issue #265).

import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { BrowserPathConfig, BrowserPaths } from '../platform/types'
import type { ScanRecencyOptions } from './file-utils'

export interface ChromiumBrowser extends BrowserPaths {
  key: string
  label: string
  /** Opera-family builds put the profile at `base` instead of in `Default`/`Profile N` */
  hasProfiles: boolean
}

const BROWSERS: Array<{ key: string; label: string; hasProfiles: boolean }> = [
  { key: 'chrome', label: 'Chrome', hasProfiles: true },
  { key: 'edge', label: 'Edge', hasProfiles: true },
  { key: 'brave', label: 'Brave', hasProfiles: true },
  { key: 'vivaldi', label: 'Vivaldi', hasProfiles: true },
  // Opera stores profiles differently — cache is directly under the base path
  { key: 'opera', label: 'Opera', hasProfiles: false },
  { key: 'operaGX', label: 'Opera GX', hasProfiles: false },
  { key: 'arc', label: 'Arc', hasProfiles: true },
  { key: 'chromium', label: 'Chromium', hasProfiles: true },
  { key: 'thorium', label: 'Thorium', hasProfiles: true },
  { key: 'supermium', label: 'Supermium', hasProfiles: true },
  { key: 'helium', label: 'Helium', hasProfiles: true },
  { key: 'cromite', label: 'Cromite', hasProfiles: true },
  { key: 'catsxp', label: 'CatsXP', hasProfiles: true },
]

/**
 * Recency settings every browser cache scan passes to `scanDirectory`.
 *
 * The 60-minute cutoff stays as it was — a browser's live files are still left
 * alone, at any depth. What changes is that a directory is judged by what is
 * inside it rather than by its own mtime, which moves whenever an entry is
 * added or removed and so says nothing about whether the contents are in use.
 *
 * Testing it directly hid whole caches: `Code Cache` holds exactly two entries,
 * the `js` and `wasm` directories, so any recent browsing had both skipped and
 * the result dropped for being empty. That is why Chrome's Code Cache never
 * appeared while Edge's did — Edge simply wasn't being used (issue #265).
 */
export const BROWSER_CACHE_RECENCY: ScanRecencyOptions = { deepRecencyCheck: true }

/** Pair each known Chromium browser with its resolved paths. */
export function chromiumBrowsers(paths: BrowserPathConfig): ChromiumBrowser[] {
  const config = paths as unknown as Record<string, BrowserPaths | undefined>
  const browsers: ChromiumBrowser[] = []
  for (const { key, label, hasProfiles } of BROWSERS) {
    const entry = config[key]
    if (entry) browsers.push({ key, label, hasProfiles, ...entry })
  }
  return browsers
}

export interface CacheTarget {
  path: string
  /** Full subcategory label, e.g. "Chrome - Default Code Cache" */
  label: string
}

/**
 * Every cache directory of `browser` that exists on disk, labelled for display.
 * Returns an empty list when the browser isn't installed.
 */
export async function chromiumCacheTargets(browser: ChromiumBrowser): Promise<CacheTarget[]> {
  if (!existsSync(browser.base)) return []

  const targets: CacheTarget[] = []
  const add = (path: string, label: string): void => {
    if (existsSync(path)) targets.push({ path, label })
  }

  // Shared caches sit next to the profiles rather than inside them. Profile-less
  // builds treat `base` as the profile, so their profile caches land there too.
  for (const { dir, label } of browser.sharedCaches) {
    add(join(browser.base, dir), `${browser.label} - ${label}`)
  }

  if (!browser.hasProfiles) {
    for (const { dir, label } of browser.profileCaches) {
      add(join(browser.base, dir), `${browser.label} - ${label}`)
    }
    return targets
  }

  for (const profile of await getChromiumProfiles(browser.base)) {
    for (const { dir, label } of browser.profileCaches) {
      add(join(browser.base, profile, dir), `${browser.label} - ${profile} ${label}`)
    }
  }
  return targets
}

export async function getChromiumProfiles(basePath: string): Promise<string[]> {
  const profiles = ['Default']
  try {
    const entries = await readdir(basePath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('Profile ')) {
        profiles.push(entry.name)
      }
    }
  } catch {
    // Skip
  }
  return profiles
}
