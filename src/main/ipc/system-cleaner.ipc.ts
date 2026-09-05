import { applyCacheResetPolicy } from '../services/cache-reset-policy'
import { scanManagedCleanup } from '../services/managed-cleanup'
import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { getPlatform } from '../platform'
import { scanDirectory, scanFile, scanMultipleDirectories, resolveChildSubdirs, cleanItems } from '../services/file-utils'
import { cacheItems, clearCachedCategory } from '../services/scan-cache'
import { isAdmin } from '../services/elevation'
import { getSettings } from '../services/settings-store'
import type { ScanResult, CleanResult } from '../../shared/types'
import { CleanerType } from '../../shared/enums'
import type { WindowGetter } from './index'
import { validateStringArray } from '../services/ipc-validation'

export function registerSystemCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.SYSTEM_SCAN, async (): Promise<ScanResult[]> => {
    const results: ScanResult[] = []
    const category = CleanerType.System
    clearCachedCategory(category)

    const elevated = isAdmin()
    const platform = getPlatform()
    const targets = platform.paths.systemCleanTargets()
    const protectedEventLogs = platform.paths.protectedEventLogs()
    const configuredRecency = getSettings().cleaner.skipRecentMinutes
    const skipRecentMinutes = Number.isFinite(configuredRecency)
      ? Math.max(0, configuredRecency)
      : 60

    // Find the event logs target path for filtering
    const eventLogsTarget = targets.find((t) => t.subcategory === 'Event Log Archives')

    // Skip admin-only targets when not elevated so we can report them
    const skippedForElevation: string[] = []

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]

      if (target.needsAdmin && !elevated) {
        skippedForElevation.push(target.subcategory)
        continue
      }

      try {
        // For targets with childSubdir, scan path/*/childSubdir instead of path directly
        // e.g. Flatpak: scan ~/.var/app/*/cache instead of ~/.var/app
        let result: ScanResult
        const recency = {
          skipRecentMinutes,
          deepRecencyCheck: target.deepRecencyCheck === true,
        }
        if (target.cleanupAction) {
          result = await scanManagedCleanup(target.cleanupAction, category, target.subcategory, target.path)
        } else if (target.childSubdir) {
          const childPaths = await resolveChildSubdirs([target.path], target.childSubdir)
          result = await scanMultipleDirectories(childPaths, category, target.subcategory, recency)
        } else {
          result = await scanDirectory(target.path, category, target.subcategory, recency)
        }

        // Exclude protected event logs so boot trace data survives cleaning
        if (eventLogsTarget && target.path === eventLogsTarget.path) {
          result.items = result.items.filter((item) => {
            const fileName = item.path.split(/[\\/]/).pop()?.toLowerCase() || ''
            return !protectedEventLogs.some((p) => fileName === p)
          })
          result.totalSize = result.items.reduce((s, item) => s + item.size, 0)
          result.itemCount = result.items.length
        }

        applyCacheResetPolicy(result, target.cacheReset)
        if (result.items.length > 0) {
          cacheItems(result.items)
          results.push(result)
        }

        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send(IPC.SCAN_PROGRESS, {
          phase: 'scanning',
          category,
          currentPath: target.path,
          progress: ((i + 1) / targets.length) * 100,
          itemsFound: results.reduce((s, r) => s + r.itemCount, 0),
          sizeFound: results.reduce((s, r) => s + r.totalSize, 0),
        })
      } catch {
        // Skip inaccessible targets
      }
    }

    // Scan single-file targets (e.g. full memory dump, xsession errors)
    for (const target of platform.paths.singleFileCleanTargets()) {
      try {
        const dumpResult = await scanFile(target.path, category, target.subcategory)
        if (dumpResult.items.length > 0) {
          cacheItems(dumpResult.items)
          results.push(dumpResult)
        }
      } catch {
        // Skip if not present
      }
    }

    // If any targets were skipped due to missing elevation, add a marker result
    // so the renderer can inform the user
    if (skippedForElevation.length > 0) {
      results.push({
        category,
        subcategory: '__elevation_required',
        items: [],
        totalSize: 0,
        itemCount: 0,
        group: skippedForElevation.join(', '),
      })
    }

    return results
  })

  ipcMain.handle(IPC.SYSTEM_CLEAN, async (_event, itemIds: string[]): Promise<CleanResult> => {
    // Large scans legitimately exceed the generic 10k IPC-list limit. IDs are
    // UUIDs from Kudu's own scan cache, so keep a high but bounded cleaner cap.
    const valid = validateStringArray(itemIds, 250_000, 100)
    if (!valid) return { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [], needsElevation: false }
    return cleanItems(valid, (processed, total, currentPath, cleanedSize) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(IPC.SCAN_PROGRESS, {
        phase: 'cleaning',
        category: CleanerType.System,
        currentPath,
        progress: (processed / total) * 100,
        itemsFound: total,
        sizeFound: cleanedSize,
      })
    })
  })
}
