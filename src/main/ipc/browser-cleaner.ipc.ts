import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'
import { IPC } from '../../shared/channels'
import { getPlatform } from '../platform'
import { scanDirectory, cleanItems } from '../services/file-utils'
import { cacheItems } from '../services/scan-cache'
import { getSettings } from '../services/settings-store'
import { CleanerType } from '../../shared/enums'
import type { ScanResult, CleanResult } from '../../shared/types'
import type { WindowGetter } from './index'
import { validateStringArray } from '../services/ipc-validation'

interface ChromiumBrowserDef {
  key: string
  label: string
  base: string
  cache: string
  codeCache: string
  gpuCache: string
  serviceWorker: string
  hasProfiles: boolean
}

export function registerBrowserCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.BROWSER_SCAN, async (): Promise<ScanResult[]> => {
    const results: ScanResult[] = []
    const category = CleanerType.Browser
    const browserPaths = getPlatform().paths.browserPaths()

    const chromiumBrowsers: ChromiumBrowserDef[] = [
      { key: 'chrome', label: 'Chrome', ...browserPaths.chrome, hasProfiles: true },
      { key: 'edge', label: 'Edge', ...browserPaths.edge, hasProfiles: true },
      { key: 'brave', label: 'Brave', ...browserPaths.brave, hasProfiles: true },
      { key: 'vivaldi', label: 'Vivaldi', ...browserPaths.vivaldi, hasProfiles: true },
      // Opera stores profiles differently — cache is directly under the base path
      { key: 'opera', label: 'Opera', ...browserPaths.opera, hasProfiles: false },
      { key: 'operaGX', label: 'Opera GX', ...browserPaths.operaGX, hasProfiles: false },
      { key: 'arc', label: 'Arc', ...browserPaths.arc, hasProfiles: true },
      { key: 'chromium', label: 'Chromium', ...browserPaths.chromium, hasProfiles: true },
      { key: 'thorium', label: 'Thorium', ...browserPaths.thorium, hasProfiles: true },
      { key: 'supermium', label: 'Supermium', ...browserPaths.supermium, hasProfiles: true },
      { key: 'helium', label: 'Helium', ...browserPaths.helium, hasProfiles: true },
      { key: 'cromite', label: 'Cromite', ...browserPaths.cromite, hasProfiles: true },
      { key: 'catsxp', label: 'CatsXP', ...browserPaths.catsxp, hasProfiles: true },
    ]

    // Scan all Chromium-based browsers
    for (const browser of chromiumBrowsers) {
      if (!existsSync(browser.base)) continue

      if (browser.hasProfiles) {
        const profiles = await getChromiumProfiles(browser.base)
        for (const profile of profiles) {
          const cacheDirs = [
            { dir: browser.cache, label: 'Cache' },
            { dir: browser.codeCache, label: 'Code Cache' },
            { dir: browser.gpuCache, label: 'GPU Cache' },
            { dir: browser.serviceWorker, label: 'Service Worker Cache' },
          ]
          for (const { dir, label } of cacheDirs) {
            const cachePath = join(browser.base, profile, dir)
            if (existsSync(cachePath)) {
              const result = await scanDirectory(cachePath, category, `${browser.label} - ${profile} ${label}`)
              if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
            }
          }
        }
      } else {
        // Opera-style: cache dirs directly under base
        const cacheDirs = [
          { dir: browser.cache, label: 'Cache' },
          { dir: browser.codeCache, label: 'Code Cache' },
          { dir: browser.gpuCache, label: 'GPU Cache' },
          { dir: browser.serviceWorker, label: 'Service Worker Cache' },
        ]
        for (const { dir, label } of cacheDirs) {
          const cachePath = join(browser.base, dir)
          if (existsSync(cachePath)) {
            const result = await scanDirectory(cachePath, category, `${browser.label} - ${label}`)
            if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
          }
        }
      }
    }

    // Firefox
    if (existsSync(browserPaths.firefox.cache)) {
      try {
        const profileDirs = await readdir(browserPaths.firefox.cache, { withFileTypes: true })
        for (const dir of profileDirs) {
          if (dir.isDirectory()) {
            const cachePath = join(browserPaths.firefox.cache, dir.name, 'cache2', 'entries')
            if (existsSync(cachePath)) {
              const result = await scanDirectory(cachePath, category, `Firefox - ${dir.name} Cache`)
              if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
            }
          }
        }
      } catch {
        // Skip
      }
    }

    // Firefox forks (LibreWolf, Waterfox, Floorp)
    const firefoxForks = [
      { key: 'librewolf', label: 'LibreWolf', ...browserPaths.librewolf },
      { key: 'waterfox', label: 'Waterfox', ...browserPaths.waterfox },
      { key: 'floorp', label: 'Floorp', ...browserPaths.floorp },
    ]
    for (const fork of firefoxForks) {
      if (!fork.cache || !existsSync(fork.cache)) continue
      try {
        const profileDirs = await readdir(fork.cache, { withFileTypes: true })
        for (const dir of profileDirs) {
          if (dir.isDirectory()) {
            const cachePath = join(fork.cache, dir.name, 'cache2')
            if (existsSync(cachePath)) {
              const result = await scanDirectory(cachePath, category, `${fork.label} - ${dir.name} Cache`)
              if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
            }
          }
        }
      } catch {
        // Skip
      }
    }

    // Safari (macOS only) — cache directory only, never cookies/history/bookmarks
    if (browserPaths.safari && existsSync(browserPaths.safari.cache)) {
      const result = await scanDirectory(browserPaths.safari.cache, category, 'Safari - Cache')
      if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
    }

    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SCAN_PROGRESS, {
      phase: 'scanning',
      category,
      currentPath: 'Browser scan complete',
      progress: 100,
      itemsFound: results.reduce((s, r) => s + r.itemCount, 0),
      sizeFound: results.reduce((s, r) => s + r.totalSize, 0),
    })

    return results
  })

  ipcMain.handle(IPC.BROWSER_CLEAN, async (_event, itemIds: string[]): Promise<CleanResult> => {
    const valid = validateStringArray(itemIds)
    if (!valid) return { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [], needsElevation: false }
    const settings = getSettings()
    if (settings.cleaner.closeBrowsersBeforeClean) {
      await getPlatform().browser.closeBrowsers()
    }
    return cleanItems(valid, (processed, total, currentPath, cleanedSize) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(IPC.SCAN_PROGRESS, {
        phase: 'cleaning',
        category: CleanerType.Browser,
        currentPath,
        progress: (processed / total) * 100,
        itemsFound: total,
        sizeFound: cleanedSize,
      })
    })
  })
}

async function getChromiumProfiles(basePath: string): Promise<string[]> {
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
