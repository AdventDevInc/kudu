import { app, ipcMain, shell } from 'electron'
import { IPC } from '../../shared/channels'
import { DownloadsReview } from '../services/downloads-review'
import { expandExclusions } from '../services/file-utils'
import { getSettings } from '../services/settings-store'

export function registerDownloadsReviewIpc(): void {
  const review = new DownloadsReview(
    () => app.getPath('downloads'),
    () => expandExclusions(getSettings().exclusions),
    (path) => shell.trashItem(path),
    (path) => shell.showItemInFolder(path)
  )
  ipcMain.handle(IPC.DOWNLOADS_SCAN, () => review.scan())
  ipcMain.handle(IPC.DOWNLOADS_TRASH, (_event, scanId, ids) => review.trashSelected(scanId, ids))
  ipcMain.handle(IPC.DOWNLOADS_REVEAL, (_event, scanId, id) => review.openLocation(scanId, id))
}
