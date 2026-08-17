import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { IPC } from '../../shared/channels'
import { CleanerType } from '../../shared/enums'
import type { ScanResult, CleanResult } from '../../shared/types'
import { randomUUID } from 'crypto'
import { getPlatform } from '../platform'
import { scanDirectory, cleanItems } from '../services/file-utils'
import { cacheItems, clearCachedCategory } from '../services/scan-cache'
import { queryRecycleBinStats } from '../services/recycle-bin-stats'
import { emptyRecycleBinFast, finalizeRecycleBinShell } from '../services/recycle-bin-cleaner'
import {
  isDeletionLoggingEnabled, listRecycleBinContents, recordEmptiedRecycleBin
} from '../services/recycle-bin-log'

// Windows: track last scanned size (virtual items have no real path)
let lastScannedSize = 0
let lastScannedCount = 0
// macOS/Linux: track last scanned item IDs for cleanItems()
let lastScannedItemIds: string[] = []

export function registerRecycleBinIpc(): void {
  ipcMain.handle(IPC.RECYCLE_BIN_SCAN, async (): Promise<ScanResult[]> => {
    clearCachedCategory(CleanerType.RecycleBin)
    lastScannedSize = 0
    lastScannedCount = 0
    lastScannedItemIds = []
    const trashPath = getPlatform().paths.trashPath()

    if (trashPath) {
      // macOS / Linux: scan trash directory as real files
      try {
        if (!existsSync(trashPath)) return []
        const result = await scanDirectory(trashPath, CleanerType.RecycleBin, 'Trash', 0)
        if (result.items.length > 0) {
          cacheItems(result.items)
          lastScannedItemIds = result.items.map((i) => i.id)
          return [result]
        }
        return []
      } catch {
        return []
      }
    }

    // Windows: metadata-only query (does not traverse deleted file contents)
    try {
      const { count, size } = await queryRecycleBinStats()

      lastScannedSize = size
      lastScannedCount = count

      if (count === 0) return []

      return [{
        category: CleanerType.RecycleBin,
        subcategory: 'Recycle Bin',
        items: [{
          id: randomUUID(),
          path: 'Recycle Bin',
          size,
          category: CleanerType.RecycleBin,
          subcategory: 'Recycle Bin',
          lastModified: Date.now(),
          selected: true
        }],
        totalSize: size,
        itemCount: count
      }]
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC.RECYCLE_BIN_CLEAN, async (): Promise<CleanResult> => {
    const trashPath = getPlatform().paths.trashPath()

    if (trashPath) {
      // macOS / Linux: delete cached trash items via standard file-utils flow
      try {
        const result = await cleanItems(lastScannedItemIds)
        lastScannedItemIds = []
        return result
      } catch (err: any) {
        return { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [{ path: 'Trash', reason: err.message }], needsElevation: false }
      }
    }

    // Windows: delete the current user's top-level $R payloads in parallel.
    // The whole-bin shell call can stall badly on large or interrupted bins;
    // bounded workers avoid making that shell behavior the normal clean path.
    const sizeBeforeClean = lastScannedSize
    const countBeforeClean = lastScannedCount
    // Capture the contents first — after the bin is emptied there is nothing
    // left to enumerate.
    const logDeletions = isDeletionLoggingEnabled()
    const binContents = logDeletions ? await listRecycleBinContents() : []
    try {
      let resultCode = 0
      let accessDenied = false
      try {
        const fastResult = await emptyRecycleBinFast()
        accessDenied = fastResult.accessDenied
      } catch {
        // Discovery/initialization failure only: retain a bounded Windows API
        // fallback without allowing the old shell walk to hang indefinitely.
        resultCode = await finalizeRecycleBinShell(60_000)
      }

      // Verify both count and bytes. The direct delete is best-effort and can
      // partially succeed when a payload is open or protected.
      const { count: remaining, size: remainingSize } = await queryRecycleBinStats()
      const totalCleaned = Math.max(0, sizeBeforeClean - remainingSize)
      const filesDeleted = Math.max(0, countBeforeClean - remaining)

      if (remaining === 0) {
        // With no payloads left this is a quick no-op that refreshes Windows'
        // shell state/icon. Never fail an otherwise successful clean on it.
        try { await finalizeRecycleBinShell() } catch { /* shell refresh is best-effort */ }
      }

      if (logDeletions) await recordEmptiedRecycleBin(binContents, 'local')

      lastScannedSize = remainingSize
      lastScannedCount = remaining

      if (remaining === 0) {
        return { totalCleaned, filesDeleted, filesSkipped: 0, errors: [], needsElevation: false }
      } else {
        // Partial clean - some items couldn't be removed
        accessDenied ||= resultCode === 0x80070005
        return {
          totalCleaned,
          filesDeleted,
          filesSkipped: remaining,
          errors: [{ path: 'Recycle Bin', reason: `${remaining} item(s) could not be removed (may be in use or protected)` }],
          needsElevation: accessDenied
        }
      }
    } catch (err: any) {
      return { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [{ path: 'Recycle Bin', reason: err.message }], needsElevation: false }
    }
  })
}
