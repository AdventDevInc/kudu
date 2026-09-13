import { dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { IPC } from '../../shared/channels'
import { compareStorageSnapshots, projectStorageCapacity } from '../../shared/storage-history'
import {
  getStorageIndex,
  readStorageSnapshot,
  deleteStorageHistory,
  updateStorageScope
} from '../services/storage-history-store'
import {
  addStorageScope,
  captureStorageScope,
  cancelStorageCapture,
  storageCaptureStatus
} from '../services/storage-history'
import { validateStorageRoot } from '../services/storage-scan'
import { showOpenDialog } from './open-dialog'
import type { WindowGetter } from './index'

export function registerStorageHistoryIpc(getWindow: WindowGetter) {
  ipcMain.handle(
    IPC.STORAGE_HISTORY_LIST,
    async (_event, scopeId: unknown, offset: unknown = 0) => {
      if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 900)
        throw new Error('Invalid page')
      const index = await getStorageIndex(),
        snapshots = index.snapshots.filter((s) => s.scopeId === scopeId)
      return {
        scopes: index.scopes,
        snapshots: snapshots.slice(Number(offset), Number(offset) + 50),
        total: snapshots.length,
        capture: storageCaptureStatus(),
        projection: projectStorageCapacity(snapshots)
      }
    }
  )
  ipcMain.handle(IPC.STORAGE_HISTORY_ADD, async () => {
    const result = await showOpenDialog(getWindow(), {
      title: 'Track folder storage',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return addStorageScope(result.filePaths[0])
  })
  ipcMain.handle(IPC.STORAGE_HISTORY_CONFIGURE, async (_event, id: unknown, value: unknown) => {
    if (typeof id !== 'string' || !value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid tracked folder settings')
    const input = value as Record<string, unknown>
    if (
      Object.keys(input).some(
        (k) => !['daily', 'growthAlertBytes', 'freeAlertPercent'].includes(k)
      ) ||
      typeof input.daily !== 'boolean'
    )
      throw new Error('Invalid tracked folder settings')
    if (
      input.growthAlertBytes !== null &&
      (!Number.isSafeInteger(input.growthAlertBytes) ||
        Number(input.growthAlertBytes) < 1 ||
        Number(input.growthAlertBytes) > 10 ** 15)
    )
      throw new Error('Invalid growth threshold')
    if (
      input.freeAlertPercent !== null &&
      (!Number.isInteger(input.freeAlertPercent) ||
        Number(input.freeAlertPercent) < 1 ||
        Number(input.freeAlertPercent) > 100)
    )
      throw new Error('Invalid free space threshold')
    await updateStorageScope(id, {
      daily: input.daily,
      growthAlertBytes: input.growthAlertBytes as number | null,
      freeAlertPercent: input.freeAlertPercent as number | null
    })
  })
  ipcMain.handle(IPC.STORAGE_HISTORY_CAPTURE, (_event, id: unknown) =>
    captureStorageScope(id).then((s) => s.id)
  )
  ipcMain.handle(IPC.STORAGE_HISTORY_CANCEL, () => cancelStorageCapture())
  ipcMain.handle(IPC.STORAGE_HISTORY_DELETE, (_event, id: unknown, scope: unknown = false) => {
    if (typeof scope !== 'boolean') throw new Error('Invalid deletion request')
    if (storageCaptureStatus()) throw new Error('Wait for the current capture to finish')
    return deleteStorageHistory(id, scope)
  })
  ipcMain.handle(
    IPC.STORAGE_HISTORY_COMPARE,
    async (_event, before: unknown, after: unknown, offset: unknown = 0) => {
      if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 10000)
        throw new Error('Invalid comparison page')
      const result = compareStorageSnapshots(
        await readStorageSnapshot(before),
        await readStorageSnapshot(after)
      )
      return {
        ...result,
        rows: result.rows.slice(Number(offset), Number(offset) + 50),
        total: result.rows.length
      }
    }
  )
  ipcMain.handle(IPC.STORAGE_HISTORY_EXPORT, async (_event, id: unknown) => {
    const snapshot = await readStorageSnapshot(id),
      scope = (await getStorageIndex()).scopes.find((s) => s.id === snapshot.scopeId)
    const result = await dialog.showSaveDialog({
      defaultPath: 'kudu-storage-snapshot.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, JSON.stringify({ scope, snapshot }, null, 2))
    return true
  })
  ipcMain.handle(IPC.STORAGE_HISTORY_OPEN, async (_event, id: unknown, path: unknown) => {
    if (typeof path !== 'string' || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new Error('Invalid snapshot folder')
    const snapshot = await readStorageSnapshot(id)
    if (!snapshot.rows.some((r) => r.path === path)) throw new Error('Folder not recorded')
    const scope = (await getStorageIndex()).scopes.find((s) => s.id === snapshot.scopeId)
    if (!scope) throw new Error('Tracked folder was removed')
    const target = resolve(join(scope.path, path)),
      rel = relative(scope.path, target)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
      throw new Error('Invalid snapshot folder')
    await validateStorageRoot(target)
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })
}
