import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { IPC } from '../../shared/channels'
import { CleanerType } from '../../shared/enums'
import type { ScanResult, CleanResult } from '../../shared/types'
import { randomUUID } from 'crypto'
import { getPlatform } from '../platform'
import { scanDirectory, cleanItems } from '../services/file-utils'
import { cacheItems, clearCachedCategory } from '../services/scan-cache'
import { psUtf8 } from '../services/exec-utf8'
import { queryRecycleBinStats } from '../services/recycle-bin-stats'
import {
  isDeletionLoggingEnabled, listRecycleBinContents, recordEmptiedRecycleBin
} from '../services/recycle-bin-log'

const execFileAsync = promisify(execFile)

function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)]
}

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

    // Windows: SHEmptyRecycleBin Win32 API
    const sizeBeforeClean = lastScannedSize
    const countBeforeClean = lastScannedCount
    // Capture the contents first — after the bin is emptied there is nothing
    // left to enumerate.
    const logDeletions = isDeletionLoggingEnabled()
    const binContents = logDeletions ? await listRecycleBinContents() : []
    try {
      // Flags: SHERB_NOCONFIRMATION(1) | SHERB_NOPROGRESSUI(2) | SHERB_NOSOUND(4) = 7
      const { stdout: emptyStdout } = await execFileAsync('powershell.exe', psArgs(
        `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RecycleBin { [DllImport("Shell32.dll", CharSet = CharSet.Unicode)] public static extern uint SHEmptyRecycleBin(IntPtr hwnd, string pszRootPath, uint dwFlags); }'; $result = [RecycleBin]::SHEmptyRecycleBin([IntPtr]::Zero, $null, 7); Write-Output $result`
      ), { windowsHide: true })
      const resultCode = parseInt(emptyStdout.trim()) || 0

      // Verify both count and bytes. SHEmptyRecycleBin returns an HRESULT rather
      // than throwing, and it can partially succeed across multiple drives.
      const { count: remaining, size: remainingSize } = await queryRecycleBinStats()
      const totalCleaned = Math.max(0, sizeBeforeClean - remainingSize)
      const filesDeleted = Math.max(0, countBeforeClean - remaining)

      if (logDeletions) await recordEmptiedRecycleBin(binContents, 'local')

      lastScannedSize = remainingSize
      lastScannedCount = remaining

      if (remaining === 0) {
        return { totalCleaned, filesDeleted, filesSkipped: 0, errors: [], needsElevation: false }
      } else {
        // Partial clean - some items couldn't be removed
        const accessDenied = resultCode === 0x80070005
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
