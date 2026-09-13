import { dialog, ipcMain } from 'electron'
import { writeFile } from 'fs/promises'
import { IPC } from '../../shared/channels'
import {
  clearCleanupReceipts,
  getCleanupReceipts,
  getCleanupReceipt,
  receiptRetryIds
} from '../services/cleanup-receipts'
import { cleanItems } from '../services/file-utils'
import { cacheItems, getCachedItems } from '../services/scan-cache'
import { getSettings } from '../services/settings-store'

let retrying = false
export function registerCleanupReceiptsIpc(): void {
  ipcMain.handle(IPC.RECEIPTS_LIST, async () =>
    (await getCleanupReceipts()).map((receipt) => ({
      ...receipt,
      details: [],
      retryable: receiptRetryIds(receipt.id).length
    }))
  )
  ipcMain.handle(IPC.RECEIPTS_GET, async (_event, id: unknown, page: unknown) => {
    if (
      typeof id !== 'string' ||
      !Number.isInteger(page) ||
      (page as number) < 0 ||
      (page as number) > 100
    )
      throw new Error('Invalid receipt page')
    const receipt = await getCleanupReceipt(id)
    if (!receipt) throw new Error('Receipt not found')
    return {
      items: receipt.details.slice((page as number) * 50, ((page as number) + 1) * 50),
      total: receipt.details.length
    }
  })
  ipcMain.handle(IPC.RECEIPTS_CLEAR, () => clearCleanupReceipts())
  ipcMain.handle(IPC.RECEIPTS_RETRY, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid receipt ID')
    if (retrying) throw new Error('A retry is already running')
    const ids = receiptRetryIds(id)
    if (!ids.length) throw new Error('Retry details expired. Run a fresh scan.')
    const minutes = getSettings().cleaner.skipRecentMinutes
    const cutoff = Date.now() - (Number.isFinite(minutes) ? Math.max(0, minutes) : 60) * 60_000
    cacheItems(
      getCachedItems(ids).map((item) => ({
        ...item,
        recencyCutoff: Math.max(item.recencyCutoff ?? 0, cutoff)
      }))
    )
    retrying = true
    try {
      return await cleanItems(ids, undefined, 'local', id)
    } finally {
      retrying = false
    }
  })
  ipcMain.handle(IPC.RECEIPTS_EXPORT, async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid receipt ID')
    const receipt = await getCleanupReceipt(id)
    if (!receipt) throw new Error('Receipt not found')
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: 'kudu-cleanup-receipt.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return false
    await writeFile(filePath, JSON.stringify(receipt, null, 2), 'utf8')
    return true
  })
}
