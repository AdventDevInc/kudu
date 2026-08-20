import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'
import { IPC } from '../../shared/channels'
import { getPlatform } from '../platform'
import { scanDirectory, cleanItems } from '../services/file-utils'
import { cacheItems, clearCachedCategory } from '../services/scan-cache'
import { getSettings } from '../services/settings-store'
import { CleanerType } from '../../shared/enums'
import type { ScanResult, CleanResult } from '../../shared/types'
import type { WindowGetter } from './index'
import { validateStringArray } from '../services/ipc-validation'
import { BROWSER_CACHE_RECENCY, chromiumBrowsers, chromiumCacheTargets } from '../services/chromium-cache'

export function registerBrowserCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.BROWSER_SCAN, async (): Promise<ScanResult[]> => {
    const results: ScanResult[] = []
    const category = CleanerType.Browser
    clearCachedCategory(category)
    const browserPaths = getPlatform().paths.browserPaths()
    const recency = BROWSER_CACHE_RECENCY

    // Scan all Chromium-based browsers
    for (const browser of chromiumBrowsers(browserPaths)) {
      for (const target of await chromiumCacheTargets(browser)) {
        const result = await scanDirectory(target.path, category, target.label, recency)
        if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
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
              const result = await scanDirectory(cachePath, category, `Firefox - ${dir.name} Cache`, recency)
              if (result.items.length > 0) { cacheItems(result.items); results.push(result) }
            }
          }
        }
      } catch {
        // Skip
      }
    }

    // Firefox forks — Zen is excluded here because it's already covered by the app scanner (zen-browser in apps.json)
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
              const result = await scanDirectory(cachePath, category, `${fork.label} - ${dir.name} Cache`, recency)
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
      const result = await scanDirectory(browserPaths.safari.cache, category, 'Safari - Cache', recency)
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

  // The full cleaner runs categories in a fixed order, with System before
  // Browser. Close browsers once up front so they cannot keep selected files
  // locked in any category (including when no Browser items are selected).
  ipcMain.handle(IPC.CLEANER_PREPARE_CLEAN, async (): Promise<boolean> => {
    if (!getSettings().cleaner.closeBrowsersBeforeClean) return false
    await getPlatform().browser.closeBrowsers()
    return true
  })

  ipcMain.handle(IPC.BROWSER_CLEAN, async (_event, itemIds: string[]): Promise<CleanResult> => {
    const valid = validateStringArray(itemIds, 250_000, 100)
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
