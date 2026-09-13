import { dialog, ipcMain, shell } from 'electron'
import { readdir, lstat, writeFile } from 'fs/promises'
import { join } from 'path'
import { IPC } from '../../shared/channels'
import { getBackupDir } from '../services/backup-dir'
import {
  listRecoveryEntries,
  listRecoveryPage,
  removeRecoveryEntry
} from '../services/recovery-store'
import { restoreRecoveryEntry } from '../services/recovery'
import { getGameModeStatus } from './game-mode.ipc'

export function registerRecoveryIpc(): void {
  ipcMain.handle(IPC.RECOVERY_LIST, async (_event, offset: unknown = 0) => {
    if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 5000)
      throw new Error('Invalid recovery page')
    const page = await listRecoveryPage(Number(offset))
    const backups: Array<{ name: string; size: number; modifiedAt: string }> = []
    const directory = getBackupDir()
    try {
      const files = await readdir(directory, { withFileTypes: true })
      for (const f of files
        .filter((f) => f.isFile() && /^registry-backup-[A-Za-z0-9_.-]+\.reg$/.test(f.name))
        .slice(0, 100)) {
        const info = await lstat(join(directory, f.name))
        if (info.isFile() && !info.isSymbolicLink())
          backups.push({ name: f.name, size: info.size, modifiedAt: info.mtime.toISOString() })
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }
    return {
      ...page,
      backups,
      gameMode: process.platform === 'win32' ? getGameModeStatus() : null
    }
  })
  ipcMain.handle(IPC.RECOVERY_REMOVE, (_event, id: unknown) => removeRecoveryEntry(id))
  ipcMain.handle(IPC.RECOVERY_RESTORE, (_event, id: unknown) => restoreRecoveryEntry(id))
  ipcMain.handle(IPC.RECOVERY_OPEN_BACKUPS, async () => {
    const error = await shell.openPath(getBackupDir())
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.RECOVERY_EXPORT, async () => {
    const entries = await listRecoveryEntries()
    const result = await dialog.showSaveDialog({
      defaultPath: 'kudu-recovery-history.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, JSON.stringify(entries, null, 2), 'utf8')
    return true
  })
}
