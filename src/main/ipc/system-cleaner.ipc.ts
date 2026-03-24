import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { getPlatform } from '../platform'
import { scanDirectory, scanFile, scanMultipleDirectories, resolveChildSubdirs, cleanItems } from '../services/file-utils'
import { cacheItems } from '../services/scan-cache'
import { isAdmin } from '../services/elevation'
import type { ScanResult, CleanResult } from '../../shared/types'
import { CleanerType } from '../../shared/enums'
import type { WindowGetter } from './index'
import { validateStringArray } from '../services/ipc-validation'

export function registerSystemCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.SYSTEM_SCAN, async (): Promise<ScanResult[]> => {
    const results: ScanResult[] = []
    const category = CleanerType.System

    const elevated = isAdmin()
    const platform = getPlatform()
    const targets = platform.paths.systemCleanTargets()
    const protectedEventLogs = platform.paths.protectedEventLogs()

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
        if (target.childSubdir) {
          const childPaths = await resolveChildSubdirs([target.path], target.childSubdir)
          result = await scanMultipleDirectories(childPaths, category, target.subcategory)
        } else {
          result = await scanDirectory(target.path, category, target.subcategory)
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
    const valid = validateStringArray(itemIds)
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
