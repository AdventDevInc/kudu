import { app, ipcMain, shell } from 'electron'
import { join } from 'path'
import { IPC } from '../../shared/channels'
import { CustomFolders } from '../services/custom-folders'
import { expandExclusions } from '../services/file-utils'
import { getSettings } from '../services/settings-store'
import { showOpenDialog } from './open-dialog'
import type { WindowGetter } from './index'

export function registerCustomFoldersIpc(getWindow: WindowGetter): void {
  const folders = new CustomFolders(
    join(app.getPath('userData'), 'custom-folders.json'),
    () => expandExclusions(getSettings().exclusions),
    (path) => shell.trashItem(path)
  )
  ipcMain.handle(IPC.CUSTOM_FOLDERS_LIST, () => folders.list())
  ipcMain.handle(IPC.CUSTOM_FOLDERS_PICK, async () => {
    const result = await showOpenDialog(getWindow(), { properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.CUSTOM_FOLDERS_ADD, (_event, name, path) => folders.add(name, path))
  ipcMain.handle(IPC.CUSTOM_FOLDERS_REMOVE, (_event, id) => folders.remove(id))
  ipcMain.handle(IPC.CUSTOM_FOLDERS_SCAN, (_event, id) => folders.scan(id))
  ipcMain.handle(IPC.CUSTOM_FOLDERS_TRASH, (_event, scanId, ids) =>
    folders.trashSelected(scanId, ids)
  )
}
