import { ipcMain, shell } from 'electron'
import { access } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../shared/channels'
import { ICLOUD_SERVICES, type ICloudServiceStatus } from '../../shared/icloud-cleanup'
import { DeviceBackups } from '../services/device-backups'

const exec = promisify(execFile)
function requireMac() {
  if (process.platform !== 'darwin') throw new Error('iCloud management requires macOS.')
}

async function applicationPath(id: unknown): Promise<string | null> {
  const service = ICLOUD_SERVICES.find((service) => service.id === id)
  if (!service) throw new Error('Unknown iCloud service.')
  for (const folder of ['/System/Applications', '/Applications', join(homedir(), 'Applications')]) {
    for (const name of service.apps) {
      const path = join(folder, name)
      try {
        await access(path)
        return path
      } catch {
        /* try another installed location */
      }
    }
  }
  return null
}

async function openFolder(path: string) {
  await access(path)
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

export function registerICloudCleanupIpc(): void {
  const root = join(homedir(), 'Library', 'Application Support', 'MobileSync', 'Backup')
  const backups = new DeviceBackups(
    root,
    (path) => shell.trashItem(path),
    async (path, key) => {
      return (
        await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, path], {
          timeout: 5000,
          maxBuffer: 1024 * 1024
        })
      ).stdout
    }
  )

  ipcMain.handle(IPC.ICLOUD_SERVICES, async (): Promise<ICloudServiceStatus[]> => {
    requireMac()
    return Promise.all(
      ICLOUD_SERVICES.map(async ({ id }) => ({ id, canOpenApp: !!(await applicationPath(id)) }))
    )
  })
  ipcMain.handle(IPC.ICLOUD_OPEN, async (_event, target: unknown, id: unknown) => {
    requireMac()
    switch (target) {
      case 'settings':
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.preferences.AppleIDPrefPane?iCloud'
        )
        return
      case 'drive':
        return openFolder(join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs'))
      case 'backups':
        return openFolder(root)
      case 'trash':
        return openFolder(join(homedir(), '.Trash'))
      case 'app': {
        const path = await applicationPath(id)
        if (!path)
          throw new Error('This application was not found in the standard Applications folders.')
        const error = await shell.openPath(path)
        if (error) throw new Error(error)
        return
      }
      case 'guide':
        await shell.openExternal('https://support.apple.com/108922')
        return
      case 'recovery':
        await shell.openExternal('https://www.icloud.com/recovery/')
        return
      default:
        throw new Error('Unknown iCloud management action.')
    }
  })
  ipcMain.handle(IPC.DEVICE_BACKUPS_SCAN, () => {
    requireMac()
    return backups.scan()
  })
  ipcMain.handle(
    IPC.DEVICE_BACKUPS_REMOVE,
    (
      _event,
      scanId: unknown,
      ids: unknown,
      confirmation: unknown,
      devicesDisconnected: unknown
    ) => {
      requireMac()
      return backups.remove(scanId, ids, confirmation, devicesDisconnected)
    }
  )
}
