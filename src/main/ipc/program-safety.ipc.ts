import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { cloudAgent } from '../services/cloud-agent'

export function registerProgramSafetyIpc(): void {
  ipcMain.handle(IPC.PROGRAM_SAFETY_FETCH, async () => {
    return cloudAgent.getInstalledProgramSafetyRatings()
  })
}
