import { execFile } from 'child_process'
import { isAdmin } from './elevation'
import { psUtf8 } from './exec-utf8'

export interface RestorePointResult {
  success: boolean
  error?: string
}

/**
 * Creates a Windows System Restore point using PowerShell.
 * Requires administrator privileges and System Protection to be enabled on the target drive.
 */
export function createRestorePoint(description: string): Promise<RestorePointResult> {
  return new Promise((resolve) => {
    if (!isAdmin()) {
      resolve({ success: false, error: 'Administrator privileges required to create a restore point.' })
      return
    }

    // Checkpoint-Computer creates a system restore point.
    // -RestorePointType MODIFY_SETTINGS is the appropriate type for a cleaner operation.
    const script = `Checkpoint-Computer -Description '${description.replace(/'/g, "''")}' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop`

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)],
      { timeout: 60_000 },
      (err, _stdout, stderr) => {
        if (err) {
          // Windows throttles restore point creation to one per 24 hours by default.
          // If the error mentions frequency, give a clearer message.
          const msg = stderr || err.message || 'Unknown error'
          if (msg.includes('frequency') || msg.includes('1440')) {
            resolve({ success: false, error: 'A restore point was already created within the last 24 hours. Windows limits creation frequency.' })
          } else {
            resolve({ success: false, error: msg.slice(0, 500) })
          }
          return
        }
        resolve({ success: true })
      }
    )
  })
}
