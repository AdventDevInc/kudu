import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { showOpenDialog } from './open-dialog'
import {
  addWeekendAppLaunch,
  updateWeekendAppLaunch,
  listWeekendAppLaunches,
  removeWeekendAppLaunch
} from '../services/weekend-app-launches'

export function registerWeekendAppLaunchesIpc(): void {
  ipcMain.handle(IPC.WEEKEND_APPS_LIST, () => listWeekendAppLaunches())
  ipcMain.handle(IPC.WEEKEND_APPS_UPDATE, (_event, id: unknown, policy: unknown) =>
    updateWeekendAppLaunch(id, policy)
  )
  ipcMain.handle(IPC.WEEKEND_APPS_ADD, async (_event, policy: unknown) => {
    if (process.platform !== 'darwin') throw new Error('This feature requires macOS.')
    const choice = await showOpenDialog(null, {
      defaultPath: '/Applications',
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['app'] }]
    })
    if (choice.canceled || !choice.filePaths[0]) return false
    await addWeekendAppLaunch(choice.filePaths[0], policy)
    return true
  })
  ipcMain.handle(IPC.WEEKEND_APPS_REMOVE, (_event, id: unknown) => removeWeekendAppLaunch(id))
}
