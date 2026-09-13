import { app, dialog, ipcMain, safeStorage } from 'electron'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import { IPC } from '../../shared/channels'
import { diagnosticId } from '../../shared/performance-diagnostics'
import { diagnosticCapabilities } from '../services/diagnostics-cloud'
import { DiagnosticsStore } from '../services/diagnostics-store'
import { PerformanceDiagnostics } from '../services/performance-diagnostics'

export function registerPerformanceDiagnosticsIpc(): void {
  const service = new PerformanceDiagnostics(
    new DiagnosticsStore(
      join(app.getPath('userData'), 'performance-diagnostics'),
      (value) => {
        if (
          !safeStorage.isEncryptionAvailable() ||
          (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
        )
          throw new Error(
            'Secure local storage is unavailable. Enable your system keyring before recording.'
          )
        return safeStorage.encryptString(value)
      },
      (value) => safeStorage.decryptString(value)
    )
  )
  ipcMain.handle(IPC.DIAGNOSTICS, async (_event, action: unknown, id: unknown, value: unknown) => {
    if (action === 'capabilities') return diagnosticCapabilities()
    if (action === 'status') return service.status()
    if (action === 'start') return service.start(id, value)
    if (action === 'stop') return service.recorder.stop()
    if (action === 'upload') return service.upload(id)
    if (!diagnosticId(id)) throw new Error('Invalid recording ID')
    switch (action) {
      case 'get':
        return service.get(id)
      case 'edit':
        return service.edit(id, value)
      case 'preview':
        return service.prepare(id, value)
      case 'refresh':
        return service.refresh(id)
      case 'deleteCloud':
        return service.deleteCloud(id)
      case 'remove':
        return service.remove(id)
      case 'export': {
        const s = await service.get(id)
        const result = await dialog.showSaveDialog({
          title: 'Export diagnostic recording',
          defaultPath: `kudu-diagnostic-${id}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (result.canceled || !result.filePath) return false
        // Export contains sensitive process names if collected; never export account/key hashes.
        await writeFile(
          result.filePath,
          JSON.stringify(
            {
              version: 1,
              title: s.title,
              notes: s.notes,
              recording: s.recording,
              report: s.cloud?.report ?? null
            },
            null,
            2
          ),
          'utf8'
        )
        return true
      }
      default:
        throw new Error('Unknown diagnostics action')
    }
  })
}
