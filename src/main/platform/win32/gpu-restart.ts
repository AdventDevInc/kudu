import { execFile } from 'child_process'
import { promisify } from 'util'
import { psUtf8 } from '../../services/exec-utf8'

const execFileAsync = promisify(execFile)

export interface GpuRestartDevice {
  name: string
  instanceId: string
}

export interface GpuRestartResult {
  ok: boolean
  devices: GpuRestartDevice[]
  error?: string
}

/** Pure parser for the PowerShell ConvertTo-Json payload (#394). */
export function parseGpuRestartPayload(stdout: string): GpuRestartDevice[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    const raw = JSON.parse(trimmed) as
      { Name?: string; InstanceId?: string } | Array<{ Name?: string; InstanceId?: string }>
    const items = Array.isArray(raw) ? raw : [raw]
    return items
      .filter((d) => typeof d?.Name === 'string' && typeof d?.InstanceId === 'string')
      .map((d) => ({ name: d.Name as string, instanceId: d.InstanceId as string }))
  } catch {
    return []
  }
}

/**
 * Soft-restart display adapters via Disable/Enable-PnpDevice.
 * Prefer this over key-injection of Win+Ctrl+Shift+B. Needs elevation.
 */
export async function restartGpuDrivers(): Promise<GpuRestartResult> {
  const script = `
$ErrorActionPreference = 'Stop'
$devices = @(Get-PnpDevice -Class 'Display' -Status 'OK' -ErrorAction Stop)
if ($devices.Count -eq 0) { '[]'; exit 0 }
$restarted = @()
$stuck = @()
try {
  foreach ($d in $devices) {
    Disable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction Stop
    Start-Sleep -Milliseconds 400
    Enable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction Stop
    $restarted += [pscustomobject]@{ Name = $d.FriendlyName; InstanceId = $d.InstanceId }
  }
} finally {
  # Never leave an adapter disabled (black screen, safe-mode recovery): if
  # anything above threw, re-enable whatever is still off before bailing.
  Start-Sleep -Milliseconds 400
  foreach ($d in $devices) {
    $now = Get-PnpDevice -InstanceId $d.InstanceId -ErrorAction SilentlyContinue
    if ($now -and $now.Status -ne 'OK') {
      Enable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
      $again = Get-PnpDevice -InstanceId $d.InstanceId -ErrorAction SilentlyContinue
      if ($again -and $again.Status -ne 'OK') { $stuck += $d.FriendlyName }
    }
  }
}
if ($stuck.Count -gt 0) {
  Write-Error ('Display adapter(s) still disabled after restart: ' + ($stuck -join ', '))
  exit 1
}
$restarted | ConvertTo-Json -Compress
`.trim()

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)],
      { timeout: 60_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
    )
    const devices = parseGpuRestartPayload(stdout)
    return { ok: true, devices }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, devices: [], error: message }
  }
}
