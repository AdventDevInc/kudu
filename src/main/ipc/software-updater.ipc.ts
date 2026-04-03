import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { checkForUpdates, runUpdates } from '../services/software-updater'
import type { WindowGetter } from './index'
import type { UpdateCheckResult, UpdateProgress, UpdateResult } from '../../shared/types'

export function registerSoftwareUpdaterIpc(getWindow: WindowGetter): void {
  const sendProgress = (data: UpdateProgress): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SOFTWARE_UPDATE_PROGRESS, data)
  }

  ipcMain.handle(
    IPC.SOFTWARE_UPDATE_CHECK,
    async (): Promise<UpdateCheckResult> => {
      return checkForUpdates()
    },
  )

  ipcMain.handle(
    IPC.SOFTWARE_UPDATE_RUN,
    async (_event, appIds: string[], source?: string): Promise<UpdateResult> => {
      if (!Array.isArray(appIds) || appIds.length === 0) {
        return { succeeded: 0, failed: 0, errors: [] }
      }
      const safeIds = appIds.filter(
        (id) => typeof id === 'string' && id.length > 0 && id.length < 200,
      )
      const safeSource = typeof source === 'string' ? source : undefined
      return runUpdates(safeIds, sendProgress, safeSource)
    },
  )
}
