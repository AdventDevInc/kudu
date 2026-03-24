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
import { cacheItems } from '../services/scan-cache'
import { psUtf8 } from '../services/exec-utf8'

const execFileAsync = promisify(execFile)

function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)]
}

// Windows: track last scanned size (virtual items have no real path)
let lastScannedSize = 0
// macOS/Linux: track last scanned item IDs for cleanItems()
let lastScannedItemIds: string[] = []

export function registerRecycleBinIpc(): void {
  ipcMain.handle(IPC.RECYCLE_BIN_SCAN, async (): Promise<ScanResult[]> => {
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

    // Windows: COM-based recycle bin
    try {
      const { stdout } = await execFileAsync('powershell.exe', psArgs(
        `$shell = New-Object -ComObject Shell.Application; $rb = $shell.NameSpace(0x0a); $items = $rb.Items(); $count = $items.Count; $size = ($items | Measure-Object -Property Size -Sum).Sum; Write-Output "$count|$size"`
      ), { windowsHide: true })

      const [countStr, sizeStr] = stdout.trim().split('|')
      const count = parseInt(countStr) || 0
      const size = parseInt(sizeStr) || 0

      lastScannedSize = size

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
    try {
      // Flags: SHERB_NOCONFIRMATION(1) | SHERB_NOPROGRESSUI(2) | SHERB_NOSOUND(4) = 7
      await execFileAsync('powershell.exe', psArgs(
        `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RecycleBin { [DllImport("Shell32.dll", CharSet = CharSet.Unicode)] public static extern uint SHEmptyRecycleBin(IntPtr hwnd, string pszRootPath, uint dwFlags); }'; [RecycleBin]::SHEmptyRecycleBin([IntPtr]::Zero, $null, 7)`
      ), { windowsHide: true })

      // Verify the bin is actually empty
      const { stdout } = await execFileAsync('powershell.exe', psArgs(
        `$shell = New-Object -ComObject Shell.Application; $rb = $shell.NameSpace(0x0a); $items = $rb.Items(); Write-Output $items.Count`
      ), { windowsHide: true })
      const remaining = parseInt(stdout.trim()) || 0

      if (remaining === 0) {
        lastScannedSize = 0
        return { totalCleaned: sizeBeforeClean, filesDeleted: 1, filesSkipped: 0, errors: [], needsElevation: false }
      } else {
        // Partial clean - some items couldn't be removed
        lastScannedSize = 0
        return {
          totalCleaned: sizeBeforeClean,
          filesDeleted: 1,
          filesSkipped: remaining,
          errors: [{ path: 'Recycle Bin', reason: `${remaining} item(s) could not be removed (may be in use or protected)` }],
          needsElevation: false
        }
      }
    } catch (err: any) {
      return { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [{ path: 'Recycle Bin', reason: err.message }], needsElevation: false }
    }
  })
}
