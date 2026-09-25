import { ipcMain } from 'electron'
import { homedir } from 'os'
import { IPC } from '../../shared/channels'
import { CleanerType } from '../../shared/enums'
import type { CleanResult, ScanResult } from '../../shared/types'
import { recordNativeCleanup } from '../services/cleanup-receipts'
import { validateStringArray } from '../services/ipc-validation'
import { getSettings } from '../services/settings-store'
import {
  cleanPrivacyTraces,
  scanPrivacyTraces,
  type PrivacyTrace,
  type PrivacyTraceProvider
} from '../services/privacy-traces'
import { findShellHistoryTraces } from '../services/privacy-traces-shell'
import { findLinuxRecentFileTraces } from '../services/privacy-traces-linux'
import { findMacQuarantineTraces, findMacRecentItemTraces } from '../services/privacy-traces-macos'
import {
  findWindowsRecentTraces,
  findWindowsRegistryTraces
} from '../services/privacy-traces-windows'
import type { WindowGetter } from './index'

/** Providers run in this order; each reports its own groups and skips other platforms. */
export function privacyTraceProviders(): PrivacyTraceProvider[] {
  return [
    findShellHistoryTraces,
    findWindowsRecentTraces,
    findWindowsRegistryTraces,
    findMacRecentItemTraces,
    findMacQuarantineTraces,
    findLinuxRecentFileTraces
  ]
}

/**
 * Deliberately not the shared scan cache: cloud cleanup and receipt retries
 * resolve IDs through that cache, and neither may ever clear a privacy trace.
 * Only this renderer-facing handler can.
 */
const traceCache = new Map<string, PrivacyTrace>()

export function registerPrivacyTracesIpc(getWindow: WindowGetter): void {
  const category = CleanerType.PrivacyTraces
  const sendProgress = (payload: {
    phase: 'scanning' | 'cleaning'
    currentPath: string
    progress: number
    itemsFound: number
    sizeFound: number
  }) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SCAN_PROGRESS, { ...payload, category })
  }

  ipcMain.handle(IPC.PRIVACY_TRACES_SCAN, async (): Promise<ScanResult[]> => {
    sendProgress({
      phase: 'scanning',
      currentPath: 'Scanning privacy traces...',
      progress: 0,
      itemsFound: 0,
      sizeFound: 0
    })
    const results = await scanPrivacyTraces(
      privacyTraceProviders(),
      {
        platform: process.platform,
        home: homedir(),
        env: process.env,
        exclusions: getSettings().exclusions
      },
      traceCache
    )
    sendProgress({
      phase: 'scanning',
      currentPath: 'Privacy traces scan complete',
      progress: 100,
      itemsFound: results.reduce((sum, r) => sum + r.itemCount, 0),
      sizeFound: results.reduce((sum, r) => sum + r.totalSize, 0)
    })
    return results
  })

  ipcMain.handle(
    IPC.PRIVACY_TRACES_CLEAN,
    async (_event, itemIds: string[]): Promise<CleanResult> => {
      const valid = validateStringArray(itemIds, 250_000, 100)
      if (!valid)
        return {
          totalCleaned: 0,
          filesDeleted: 0,
          filesSkipped: 0,
          errors: [],
          needsElevation: false
        }
      // A native receipt records the operation without listing the cleared
      // paths: a log of which traces existed would itself be a trace.
      return recordNativeCleanup('Privacy traces cleanup', () => {
        const settings = getSettings()
        return cleanPrivacyTraces(
          valid,
          traceCache,
          { secureDelete: settings.cleaner.secureDelete, exclusions: settings.exclusions },
          (processed, total, currentPath, cleaned) =>
            sendProgress({
              phase: 'cleaning',
              currentPath,
              progress: (processed / total) * 100,
              itemsFound: total,
              sizeFound: cleaned
            })
        )
      })
    }
  )
}
