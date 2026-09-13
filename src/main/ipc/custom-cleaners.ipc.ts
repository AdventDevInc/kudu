import { dialog, ipcMain } from 'electron'
import { lstat, readFile, writeFile } from 'fs/promises'
import { IPC } from '../../shared/channels'
import { getCustomCleaners } from '../services/custom-cleaner-runtime'
import { addHistoryEntry } from '../services/history-store'
import { showOpenDialog } from './open-dialog'
import type { WindowGetter } from './index'
import { randomUUID } from 'crypto'

export function registerCustomCleanersIpc(getWindow: WindowGetter): void {
  ipcMain.handle(
    IPC.CUSTOM_CLEANERS,
    async (_event, action: unknown, value: unknown, extra: unknown) => {
      const service = getCustomCleaners()
      switch (action) {
        case 'list':
          return service.store.list()
        case 'choose': {
          const result = await showOpenDialog(getWindow(), {
            title: 'Choose a custom-cleaner folder',
            properties: ['openDirectory']
          })
          return result.canceled ? null : (result.filePaths[0] ?? null)
        }
        case 'preview':
          return service.preview(value)
        case 'page':
          return service.page(value, extra)
        case 'cancel':
          return service.cancel()
        case 'save':
          return service.save(value)
        case 'disable':
          return service.disable(value)
        case 'remove':
          return service.remove(value)
        case 'clean': {
          const receipt = await service.clean(value)
          addHistoryEntry({
            id: randomUUID(),
            type: 'cleaner',
            timestamp: receipt.finishedAt,
            cleanedFrom: receipt.startedAt,
            cleanedTo: receipt.finishedAt,
            duration: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt),
            totalItemsFound: receipt.selected,
            totalItemsCleaned: receipt.result.filesDeleted,
            totalItemsSkipped: receipt.result.filesSkipped,
            totalSpaceSaved: receipt.result.totalCleaned,
            errorCount: receipt.result.errors.length,
            categories: [
              {
                name: `Custom: ${receipt.ruleName}`,
                itemsFound: receipt.selected,
                itemsCleaned: receipt.result.filesDeleted,
                spaceSaved: receipt.result.totalCleaned
              }
            ]
          })
          return receipt
        }
        case 'export': {
          const rules = await service.store.list()
          const result = await dialog.showSaveDialog({
            title: 'Export custom cleaners',
            defaultPath: 'kudu-custom-cleaners.json',
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
          if (result.canceled || !result.filePath) return false
          await writeFile(result.filePath, JSON.stringify({ version: 1, rules }, null, 2), 'utf8')
          return true
        }
        case 'import': {
          const result = await showOpenDialog(getWindow(), {
            title: 'Import custom cleaners (disabled until reviewed)',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile']
          })
          if (result.canceled || !result.filePaths[0]) return 0
          const info = await lstat(result.filePaths[0])
          if (!info.isFile() || info.isSymbolicLink() || info.size > 131072)
            throw new Error('Choose a regular JSON file under 128 KB')
          return service.import(await readFile(result.filePaths[0], 'utf8'))
        }
        default:
          throw new Error('Unknown custom-cleaner action')
      }
    }
  )
}
