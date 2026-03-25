import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { cloudAgent } from '../services/cloud-agent'

export function registerStartupSafetyIpc(): void {
  ipcMain.handle(IPC.STARTUP_SAFETY_FETCH, async () => {
    return cloudAgent.getStartupSafetyRatings()
  })
}
