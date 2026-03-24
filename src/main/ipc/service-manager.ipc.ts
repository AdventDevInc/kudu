import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../shared/channels'
import type { WindowGetter } from './index'
import type {
  WindowsService,
  ServiceScanResult,
  ServiceApplyResult,
  ServiceScanProgress,
  ServiceStatus,
  ServiceStartType
} from '../../shared/types'
import { lookupServiceSafety } from '../../shared/service-safety-kb'
import { getPlatform } from '../platform'

const execFileAsync = promisify(execFile)

function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}
const PS_OPTS = { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }

// ── Helpers ──────────────────────────────────────────────────

function normalizeStartType(raw: string): ServiceStartType {
  const lower = raw.toLowerCase().trim()
  if (lower === 'auto' || lower === 'automatic') return 'Automatic'
  if (lower === 'autodelayed' || lower === 'automaticdelayed') return 'AutomaticDelayed'
  if (lower === 'manual') return 'Manual'
  if (lower === 'disabled') return 'Disabled'
  if (lower === 'boot') return 'Boot'
  if (lower === 'system') return 'System'
  return 'Manual'
}

function normalizeStatus(raw: string): ServiceStatus {
  const lower = raw.toLowerCase().trim()
  if (lower === 'running') return 'Running'
  if (lower === 'stopped') return 'Stopped'
  if (lower === 'startpending') return 'StartPending'
  if (lower === 'stoppending') return 'StopPending'
  if (lower === 'paused') return 'Paused'
  return 'Unknown'
}

// ── Exported core logic ─────────────────────────────────────

export async function scanServices(
  onProgress?: (data: ServiceScanProgress) => void
): Promise<ServiceScanResult> {
    // On non-Windows, delegate to platform abstraction
    if (process.platform !== 'win32') {
      return getPlatform().services.scan(onProgress)
    }

    onProgress?.({ phase: 'enumerating', current: 0, total: 0, currentService: 'Enumerating services...' })

    // Single PowerShell call to enumerate all services with details
    const script = `
      $services = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
        Select-Object Name, DisplayName, State, StartMode, Description, PathName
      $total = $services.Count
      $i = 0
      foreach ($svc in $services) {
        $i++
        $desc = if ($svc.Description) { $svc.Description -replace '\\|', ' ' -replace '\\r?\\n', ' ' } else { '' }
        $displayName = if ($svc.DisplayName) { $svc.DisplayName -replace '\\|', ' ' } else { $svc.Name }
        $pathName = if ($svc.PathName) { $svc.PathName } else { '' }
        $isMicrosoft = $pathName -match 'Windows' -or $pathName -match 'Microsoft' -or $pathName -eq ''
        $startMode = if ($svc.StartMode) { $svc.StartMode } else { 'Manual' }

        # Check for delayed auto-start
        try {
          $delayedKey = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$($svc.Name)"
          $delayed = (Get-ItemProperty -Path $delayedKey -Name 'DelayedAutostart' -ErrorAction SilentlyContinue).DelayedAutostart
          if ($delayed -eq 1 -and $startMode -eq 'Auto') { $startMode = 'AutoDelayed' }
        } catch {}

        Write-Output "SVC|$($svc.Name)|$displayName|$($svc.State)|$startMode|$desc|$isMicrosoft"
      }
    `

    const { stdout } = await execFileAsync('powershell', psArgs(script), PS_OPTS)

    const lines = stdout.split('\n').filter((l) => l.startsWith('SVC|'))
    const serviceNames: string[] = []
    const rawServices: {
      name: string
      displayName: string
      status: ServiceStatus
      startType: ServiceStartType
      description: string
      isMicrosoft: boolean
    }[] = []

    for (const line of lines) {
      const parts = line.trim().split('|')
      if (parts.length < 7) continue
      const name = parts[1]
      serviceNames.push(name)
      rawServices.push({
        name,
        displayName: parts[2],
        status: normalizeStatus(parts[3]),
        startType: normalizeStartType(parts[4]),
        description: parts[5],
        isMicrosoft: parts[6].trim().toLowerCase() === 'true'
      })
    }

    onProgress?.({ phase: 'classifying', current: 0, total: rawServices.length, currentService: 'Resolving dependencies...' })

    // Resolve dependencies in a second PowerShell call
    const depScript = `
      foreach ($name in @(${serviceNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')})) {
        try {
          $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
          if ($svc) {
            $deps = ($svc.ServicesDependedOn | ForEach-Object { $_.Name }) -join ','
            $dependents = ($svc.DependentServices | ForEach-Object { $_.Name }) -join ','
            Write-Output "DEP|$name|$deps|$dependents"
          }
        } catch {}
      }
    `

    let depMap: Record<string, { dependsOn: string[]; dependents: string[] }> = {}
    try {
      const { stdout: depOut } = await execFileAsync('powershell', psArgs(depScript), PS_OPTS)
      for (const line of depOut.split('\n').filter((l) => l.startsWith('DEP|'))) {
        const parts = line.trim().split('|')
        if (parts.length >= 4) {
          depMap[parts[1]] = {
            dependsOn: parts[2] ? parts[2].split(',').filter(Boolean) : [],
            dependents: parts[3] ? parts[3].split(',').filter(Boolean) : []
          }
        }
      }
    } catch {
      // Dependencies are non-critical — continue without them
    }

    // Classify and build final service list
    const services: WindowsService[] = rawServices.map((raw, i) => {
      if (i % 20 === 0) {
        onProgress?.({ phase: 'classifying', current: i, total: rawServices.length, currentService: raw.displayName })
      }

      const kb = lookupServiceSafety(raw.name)
      const deps = depMap[raw.name] ?? { dependsOn: [], dependents: [] }

      return {
        name: raw.name,
        displayName: raw.displayName,
        description: raw.description,
        status: raw.status,
        startType: raw.startType,
        safety: kb.safety,
        category: kb.category,
        isMicrosoft: raw.isMicrosoft,
        dependsOn: deps.dependsOn,
        dependents: deps.dependents,
        selected: false,
        originalStartType: raw.startType
      }
    })

    const runningCount = services.filter((s) => s.status === 'Running').length
    const disabledCount = services.filter((s) => s.startType === 'Disabled').length
    const safeToDisableCount = services.filter(
      (s) => s.safety === 'safe' && s.startType !== 'Disabled'
    ).length

    return {
      services,
      totalCount: services.length,
      runningCount,
      disabledCount,
      safeToDisableCount
    }
}

export async function applyServiceChanges(
  changes: { name: string; targetStartType: string }[],
  force?: boolean
): Promise<ServiceApplyResult> {
      if (!Array.isArray(changes) || changes.length === 0) {
        return { succeeded: 0, failed: 0, errors: [] }
      }

      // On non-Windows, delegate to platform abstraction
      if (process.platform !== 'win32') {
        return getPlatform().services.applyChanges(changes)
      }

      // Validate service names — only allow safe characters
      for (const c of changes) {
        if (typeof c.name !== 'string' || typeof c.targetStartType !== 'string') {
          return { succeeded: 0, failed: 0, errors: [{ name: '', displayName: '', reason: 'Invalid change entry' }] }
        }
        if (!/^[A-Za-z0-9_.\-]{1,256}$/.test(c.name)) {
          return { succeeded: 0, failed: 0, errors: [{ name: c.name, displayName: c.name, reason: 'Invalid service name' }] }
        }
      }

      // Validate — reject unsafe services unless forced
      const validChanges = changes.filter((c) => {
        const kb = lookupServiceSafety(c.name)
        return kb.safety !== 'unsafe' || force === true
      })

      // Build a single PowerShell script for all changes
      const lines = validChanges.map((c) => {
        const safeName = c.name.replace(/'/g, "''")
        const safeType = c.targetStartType === 'Manual' ? 'Manual' : 'Disabled'
        return `
try {
  $svc = Get-Service -Name '${safeName}' -ErrorAction Stop
  $dn = $svc.DisplayName
  if ($svc.Status -eq 'Running' -and '${safeType}' -eq 'Disabled') {
    Stop-Service -Name '${safeName}' -Force -ErrorAction Stop
  }
  Set-Service -Name '${safeName}' -StartupType ${safeType} -ErrorAction Stop
  Write-Output "OK|${safeName}|$dn"
} catch {
  Write-Output "FAIL|${safeName}|${safeName}|$($_.Exception.Message)"
}`
      })

      const script = lines.join('\n')

      let succeeded = 0
      let failed = 0
      const errors: { name: string; displayName: string; reason: string }[] = []

      try {
        const { stdout } = await execFileAsync('powershell', psArgs(script), {
          ...PS_OPTS,
          timeout: validChanges.length * 10_000 + 30_000 // generous timeout
        })

        for (const line of stdout.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.startsWith('OK|')) {
            succeeded++
          } else if (trimmed.startsWith('FAIL|')) {
            failed++
            const parts = trimmed.split('|')
            errors.push({
              name: parts[1] || '',
              displayName: parts[2] || '',
              reason: parts[3] || 'Unknown error'
            })
          }
        }
      } catch (err) {
        failed = validChanges.length
        errors.push({
          name: '',
          displayName: '',
          reason: err instanceof Error ? err.message : 'PowerShell execution failed'
        })
      }

      return { succeeded, failed, errors }
}

// ── Registration ─────────────────────────────────────────────

export function registerServiceManagerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.SERVICE_SCAN, () => scanServices((data) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SERVICE_PROGRESS, data)
  }))

  ipcMain.handle(IPC.SERVICE_APPLY, async (_event, changes: { name: string; targetStartType: string }[], force?: boolean) => {
    if (!Array.isArray(changes)) return { succeeded: 0, failed: 0, errors: [] }
    return applyServiceChanges(changes, force === true)
  })
}
