import { execFile } from 'child_process'
import { isAdmin } from './elevation'
import { psUtf8 } from './exec-utf8'

export interface RestorePointResult {
  success: boolean
  error?: string
}

/**
 * Marker the script writes when System Protection is switched off.
 *
 * The failure Checkpoint-Computer raises in that case is localised — on a
 * Russian install it reads "невозможно запустить службу, так как она
 * отключена" — so there is no stable text to match on. Checking
 * `RPSessionInterval` inside the same script and emitting our own marker keeps
 * the detection language-independent without a second PowerShell round trip.
 */
export const PROTECTION_SENTINEL = 'KUDU_SYSTEM_PROTECTION_DISABLED'

export const PROTECTION_DISABLED_ERROR =
  'System Protection is turned off, so Windows cannot create a restore point. ' +
  'Turn it on under System Properties → System Protection, or run ' +
  'Enable-ComputerRestore -Drive "C:\\" from an elevated PowerShell.'

/** Builds the PowerShell that checks System Protection and then checkpoints. */
export function buildRestorePointScript(description: string): string {
  const safe = description.replace(/'/g, "''")
  return (
    "$rp = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore'" +
    ' -ErrorAction SilentlyContinue).RPSessionInterval; ' +
    `if ($rp -ne $null -and $rp -eq 0) { Write-Error '${PROTECTION_SENTINEL}'; exit 1 }; ` +
    `Checkpoint-Computer -Description '${safe}' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop`
  )
}

/** Turns a raw failure into the most actionable message available. */
export function classifyRestorePointError(raw: string): string {
  const msg = raw || 'Unknown error'
  if (msg.includes(PROTECTION_SENTINEL)) return PROTECTION_DISABLED_ERROR
  // Windows throttles restore point creation to one per 24 hours by default.
  if (msg.includes('frequency') || msg.includes('1440')) {
    return 'A restore point was already created within the last 24 hours. Windows limits creation frequency.'
  }
  return msg.slice(0, 500)
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

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psUtf8(buildRestorePointScript(description))],
      { timeout: 60_000 },
      (err, _stdout, stderr) => {
        if (err) {
          resolve({ success: false, error: classifyRestorePointError(stderr || err.message) })
          return
        }
        resolve({ success: true })
      }
    )
  })
}
