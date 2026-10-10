import { ipcMain, shell } from 'electron'
import { IPC } from '../../shared/channels'
import { scanAppPrivacy } from '../services/app-privacy'
import type { AppPrivacyReport } from '../../shared/app-privacy'

const SETTINGS = new Map([
  ['webcam', 'ms-settings:privacy-webcam'],
  ['microphone', 'ms-settings:privacy-microphone'],
  ['location', 'ms-settings:privacy-location']
])

export function registerAppPrivacyIpc(): void {
  let pending: Promise<AppPrivacyReport> | null = null
  ipcMain.handle(IPC.APP_PRIVACY_SCAN, () => {
    // Coalesce requests so repeated refreshes cannot spawn unbounded scans.
    pending ??= scanAppPrivacy().finally(() => {
      pending = null
    })
    return pending
  })
  ipcMain.handle(IPC.APP_PRIVACY_SETTINGS, async (_event, capability: unknown) => {
    const uri = typeof capability === 'string' ? SETTINGS.get(capability) : undefined
    if (process.platform !== 'win32' || !uri) throw new Error('Unsupported privacy settings page')
    await shell.openExternal(uri)
  })
}
