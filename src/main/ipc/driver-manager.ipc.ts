import { ipcMain } from 'electron'
import type { WindowGetter } from './index'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { join } from 'path'
import { readdirSync, statSync } from 'fs'
import { IPC } from '../../shared/channels'
import { validateStringArray } from '../services/ipc-validation'
import { execNativeUtf8, psUtf8 } from '../services/exec-utf8'
import type {
  DriverPackage,
  DriverScanResult,
  DriverCleanResult,
  DriverScanProgress,
  DriverUpdate,
  DriverUpdateScanResult,
  DriverUpdateInstallResult,
  DriverUpdateProgress
} from '../../shared/types'

const execFileAsync = promisify(execFile)

function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)]
}

const DRIVER_STORE = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'DriverStore',
  'FileRepository'
)

function makeId(publishedName: string, version: string): string {
  return createHash('sha256')
    .update(`${publishedName}::${version}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Measure total size of a directory recursively.
 */
function dirSize(dirPath: string): number {
  let total = 0
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      try {
        if (entry.isFile()) {
          total += statSync(join(dirPath, entry.name)).size
        } else if (entry.isDirectory()) {
          total += dirSize(join(dirPath, entry.name))
        }
      } catch { /* skip inaccessible files */ }
    }
  } catch { /* skip inaccessible dirs */ }
  return total
}

/**
 * Compare dotted version strings numerically (e.g. "10.0.1" > "9.0.2").
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na !== nb) return na - nb
  }
  return 0
}

interface RawDriver {
  publishedName: string
  originalName: string
  provider: string
  className: string
  version: string
  date: string
  signer: string
}

/**
 * Parse the output of `pnputil -e` (or `/enum-drivers`) into structured entries.
 * Handles both modern and legacy field names, including the combined
 * "Driver date and version" field found on Windows 11 24H2+.
 */
function parseEnumDrivers(stdout: string): RawDriver[] {
  const drivers: RawDriver[] = []
  // Split into blocks separated by blank lines
  const blocks = stdout.split(/\n\s*\n/)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    const fields: Record<string, string> = {}
    for (const line of lines) {
      // Match "Key : Value" or "Key:  Value" (some fields omit space before colon)
      const match = line.match(/^\s*(.+?)\s*:\s+(.+)$/)
      if (match) {
        fields[match[1].trim().toLowerCase()] = match[2].trim()
      }
    }

    // Look for the published name field (varies by Windows locale)
    const publishedName =
      fields['published name'] ||
      fields['oem inf'] ||
      ''

    if (!publishedName || !publishedName.toLowerCase().startsWith('oem')) continue

    // Handle combined "driver date and version" field (e.g. "07/18/1968 10.1.45.9")
    let version = fields['driver version'] || fields['version'] || ''
    let date = fields['driver date'] || fields['date'] || ''
    const dateAndVersion = fields['driver date and version'] || ''
    if (dateAndVersion && (!version || !date)) {
      const dvMatch = dateAndVersion.match(/^(\S+)\s+(\S+)$/)
      if (dvMatch) {
        if (!date) date = dvMatch[1]
        if (!version) version = dvMatch[2]
      }
    }

    drivers.push({
      publishedName,
      originalName:
        fields['original name'] ||
        fields['original inf'] ||
        fields['driver package provider'] ||
        publishedName,
      provider:
        fields['driver package provider'] ||
        fields['provider name'] ||
        fields['provider'] ||
        'Unknown',
      className:
        fields['class name'] ||
        fields['class'] ||
        fields['device class'] ||
        'Unknown',
      version,
      date,
      signer:
        fields['signer name'] ||
        fields['signer'] ||
        ''
    })
  }

  return drivers
}

/**
 * Build a mapping from OEM published name (e.g. "oem7.inf") to FileRepository
 * folder names by reading the DriverDatabase registry. Each oem*.inf maps to
 * one or more package folders (the default value lists all, Active shows the current one).
 */
async function getOemFolderMap(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  try {
    const script = `
      Get-ChildItem 'HKLM:\\SYSTEM\\DriverDatabase\\DriverInfFiles\\oem*.inf' -ErrorAction SilentlyContinue |
        ForEach-Object {
          $name = $_.PSChildName
          $folders = @($_.GetValue(''))
          if ($folders.Count -gt 0) {
            Write-Output "$name|$($folders -join ',')"
          }
        }
    `
    const { stdout } = await execFileAsync('powershell', psArgs(script), { timeout: 15000, windowsHide: true })

    for (const line of stdout.trim().split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [oemName, foldersStr] = trimmed.split('|', 2)
      if (oemName && foldersStr) {
        map.set(oemName.toLowerCase(), foldersStr.split(',').map((f) => f.trim()).filter(Boolean))
      }
    }
  } catch { /* registry read failed, folder sizes will be 0 */ }
  return map
}

/**
 * Get the list of driver published names that are currently in use
 * by actual hardware devices.
 */
async function getActiveDriverNames(): Promise<Set<string>> {
  const active = new Set<string>()
  try {
    const script = `
      Get-CimInstance Win32_PnPSignedDriver |
        Where-Object { $_.InfName -like 'oem*.inf' } |
        Select-Object -ExpandProperty InfName |
        Sort-Object -Unique
    `
    const { stdout } = await execFileAsync('powershell', psArgs(script), { timeout: 30000, windowsHide: true })

    for (const line of stdout.trim().split('\n')) {
      const name = line.trim().toLowerCase()
      if (name) active.add(name)
    }
  } catch {
    // Fallback: if WMI fails, try pnputil /enum-devices
    try {
      const { stdout } = await execNativeUtf8('pnputil', ['/enum-devices', '/connected'], {
        timeout: 30000
      })
      const matches = stdout.matchAll(/Driver Name:\s*(oem\d+\.inf)/gi)
      for (const m of matches) {
        active.add(m[1].toLowerCase())
      }
    } catch { /* can't determine active drivers */ }
  }
  return active
}

// ── Exported core logic ──

export async function scanDrivers(
  onProgress?: (data: DriverScanProgress) => void
): Promise<DriverScanResult> {
    onProgress?.({
      phase: 'enumerating',
      current: 0,
      total: 0,
      currentDriver: 'Enumerating installed driver packages...'
    })

    // Step 1: Enumerate all OEM driver packages
    // Try legacy `-e` first (works on all Windows versions), fall back to `/enum-drivers`
    let rawDrivers: RawDriver[] = []
    try {
      let stdout = ''
      try {
        const res = await execNativeUtf8('pnputil', ['-e'], { timeout: 30000 })
        stdout = res.stdout
      } catch {
        const res = await execNativeUtf8('pnputil', ['/enum-drivers'], { timeout: 30000 })
        stdout = res.stdout
      }
      rawDrivers = parseEnumDrivers(stdout)
    } catch {
      return { packages: [], totalStaleSize: 0, totalStaleCount: 0, totalCurrentCount: 0 }
    }

    onProgress?.({
      phase: 'analyzing',
      current: 0,
      total: rawDrivers.length,
      currentDriver: 'Identifying active drivers...'
    })

    // Step 2: Determine which drivers are currently active + get folder mapping
    // Run both queries in parallel for speed
    const [activeNames, oemFolderMap] = await Promise.all([
      getActiveDriverNames(),
      getOemFolderMap()
    ])

    // Step 3: Group by provider + class to find duplicates (since legacy pnputil
    // doesn't expose the original inf name, we use provider+class as the grouping key)
    const groups = new Map<string, RawDriver[]>()
    for (const d of rawDrivers) {
      const key = `${d.provider.toLowerCase()}::${d.className.toLowerCase()}`
      const group = groups.get(key) || []
      group.push(d)
      groups.set(key, group)
    }

    // Within each group, mark the newest as current; the rest are stale
    // Also mark any driver actively bound to hardware as current
    const packages: DriverPackage[] = []
    let idx = 0

    for (const [, group] of groups) {
      // Sort by version descending using numeric comparison
      group.sort((a, b) => compareVersions(b.version, a.version))

      for (let i = 0; i < group.length; i++) {
        const d = group[i]
        const isActive = activeNames.has(d.publishedName.toLowerCase())
        const isNewest = i === 0

        onProgress?.({
          phase: 'measuring',
          current: ++idx,
          total: rawDrivers.length,
          currentDriver: `${d.provider} - ${d.className} (${d.version})`
        })

        // Find folder in FileRepository using registry-based OEM→folder mapping
        let folderPath = ''
        let size = 0
        try {
          const folders = oemFolderMap.get(d.publishedName.toLowerCase()) || []
          if (folders.length > 0) {
            // Use the first (and usually only) matching folder
            folderPath = join(DRIVER_STORE, folders[0])
            size = dirSize(folderPath)
          }
        } catch { /* skip */ }

        packages.push({
          id: makeId(d.publishedName, d.version),
          publishedName: d.publishedName,
          originalName: d.originalName,
          provider: d.provider,
          className: d.className,
          version: d.version,
          date: d.date,
          signer: d.signer,
          folderPath,
          size,
          isCurrent: isActive || isNewest,
          selected: false
        })
      }
    }

    // Pre-select stale (non-current) drivers
    for (const pkg of packages) {
      if (!pkg.isCurrent) pkg.selected = true
    }

    const stale = packages.filter((p) => !p.isCurrent)
    return {
      packages,
      totalStaleSize: stale.reduce((sum, p) => sum + p.size, 0),
      totalStaleCount: stale.length,
      totalCurrentCount: packages.length - stale.length
    }
}

export async function cleanDrivers(publishedNames: string[]): Promise<DriverCleanResult> {
      let removed = 0
      let failed = 0
      let spaceRecovered = 0
      const errors: { publishedName: string; reason: string }[] = []

      // Get OEM→folder mapping for size calculation before removal
      const oemFolderMap = await getOemFolderMap()

      for (const name of publishedNames) {
        // Validate: only allow oem*.inf names
        if (!/^oem\d+\.inf$/i.test(name)) {
          errors.push({ publishedName: name, reason: 'Invalid driver package name' })
          failed++
          continue
        }

        try {
          // Get size before removal using registry-based folder mapping
          let preSize = 0
          const folders = oemFolderMap.get(name.toLowerCase()) || []
          if (folders.length > 0) {
            preSize = dirSize(join(DRIVER_STORE, folders[0]))
          }

          await execNativeUtf8('pnputil', ['/delete-driver', name], {
            timeout: 15000
          })
          removed++
          spaceRecovered += preSize
        } catch (err: any) {
          const msg = err?.stderr || err?.message || 'Unknown error'
          if (msg.includes('currently in use') || msg.includes('in use')) {
            errors.push({ publishedName: name, reason: 'Driver is currently in use by a device' })
          } else {
            errors.push({ publishedName: name, reason: msg.slice(0, 200) })
          }
          failed++
        }
      }

      return { removed, failed, spaceRecovered, errors }
}

export async function scanDriverUpdates(
  onProgress?: (data: DriverUpdateProgress) => void
): Promise<DriverUpdateScanResult> {
    const startTime = Date.now()

    onProgress?.({
      phase: 'checking',
      current: 0,
      total: 0,
      currentDevice: 'Querying Windows Update for driver updates...',
      percent: 0
    })

    const updates: DriverUpdate[] = []

    try {
      // Use the Windows Update COM API via PowerShell to find driver updates.
      // WMI driver table is cached once before the loop for performance.
      const script = `
        $ErrorActionPreference = 'Stop'
        $session = New-Object -ComObject Microsoft.Update.Session
        $searcher = $session.CreateUpdateSearcher()
        $criteria = "IsInstalled=0 AND Type='Driver'"
        $result = $searcher.Search($criteria)

        # Cache installed driver table once (expensive query)
        # Use Get-CimInstance (works on PS 5.1+/7+), fall back to Get-WmiObject
        $wmiDrivers = @()
        try {
          $wmiDrivers = @(Get-CimInstance Win32_PnPSignedDriver | Select-Object HardWareID, DriverVersion, DriverDate)
        } catch {
          try {
            $wmiDrivers = @(Get-WmiObject Win32_PnPSignedDriver | Select-Object HardWareID, DriverVersion, DriverDate)
          } catch {}
        }

        foreach ($update in $result.Updates) {
          $driver = $update.DriverModel
          $ver = $update.DriverVerDate
          $hwId = ''
          if ($update.DriverHardwareID) { $hwId = $update.DriverHardwareID }
          $cls = $update.DriverClass
          $provider = $update.DriverProvider
          $title = $update.Title
          $size = ''
          if ($update.MaxDownloadSize -gt 0) {
            $mb = [math]::Round($update.MaxDownloadSize / 1MB, 1)
            $size = "$mb MB"
          }
          $verStr = ''
          if ($update.DriverVerDate) {
            $verStr = $update.DriverVerDate.ToString('yyyy-MM-dd')
          }

          # Look up current installed version from cached driver data
          $currentVer = ''
          $currentDate = ''
          if ($hwId -and $wmiDrivers.Count -gt 0) {
            $installed = $wmiDrivers | Where-Object { $_.HardWareID -eq $hwId } | Select-Object -First 1
            if ($installed) {
              $currentVer = $installed.DriverVersion
              if ($installed.DriverDate) {
                try {
                  if ($installed.DriverDate -is [datetime]) {
                    $currentDate = $installed.DriverDate.ToString('yyyy-MM-dd')
                  } else {
                    $currentDate = ([Management.ManagementDateTimeConverter]::ToDateTime($installed.DriverDate)).ToString('yyyy-MM-dd')
                  }
                } catch {}
              }
            }
          }

          $wuId = $update.Identity.UpdateID
          Write-Output "DRVUPD|$($driver)|$($hwId)|$($cls)|$($currentVer)|$($currentDate)|$($wuId)|$($verStr)|$($provider)|$($title)|$($size)"
        }

        if ($result.Updates.Count -eq 0) {
          Write-Output 'DRVUPD_NONE'
        }
      `

      const { stdout } = await execFileAsync('powershell', psArgs(script), { timeout: 120000, maxBuffer: 10 * 1024 * 1024, windowsHide: true })

      const lines = stdout.trim().split('\n').map((l: string) => l.trim()).filter(Boolean)

      // Pre-compute total count for progress
      const totalCount = lines.filter((l) => l.startsWith('DRVUPD|')).length

      let idx = 0
      for (const line of lines) {
        if (line === 'DRVUPD_NONE') break
        if (!line.startsWith('DRVUPD|')) continue

        const parts = line.split('|')
        if (parts.length < 11) continue

        const deviceName = parts[1] || 'Unknown Device'
        const deviceId = parts[2] || ''
        const className = parts[3] || 'Unknown'
        const currentVersion = parts[4] || ''
        const currentDate = parts[5] || ''
        const updateId = parts[6] || ''
        const availableDate = parts[7] || ''
        const provider = parts[8] || 'Unknown'
        const updateTitle = parts[9] || deviceName
        const downloadSize = parts[10] || ''

        // Extract version from the update title if available (common pattern: "vX.X.X.X")
        const versionMatch = updateTitle.match(/(\d+\.\d+\.\d+[\.\d]*)/)
        const availableVersion = versionMatch?.[1] || availableDate

        idx++
        onProgress?.({
          phase: 'checking',
          current: idx,
          total: totalCount,
          currentDevice: deviceName,
          percent: Math.round((idx / totalCount) * 100)
        })

        updates.push({
          id: makeId(updateId || deviceName, availableVersion),
          updateId,
          deviceName,
          deviceId,
          className,
          currentVersion,
          currentDate,
          availableVersion,
          availableDate,
          provider,
          updateTitle,
          downloadSize,
          selected: true
        })
      }
    } catch (err: any) {
      console.error('Driver update scan failed:', err?.message || err)
      if (err?.stderr) console.error('PowerShell stderr:', err.stderr)
      throw new Error(err?.stderr || err?.message || 'Driver update scan failed')
    }

    return {
      updates,
      totalAvailable: updates.length,
      scanDuration: Date.now() - startTime
    }
}

export async function installDriverUpdates(
  wuUpdateIds: string[],
  onProgress?: (data: DriverUpdateProgress) => void
): Promise<DriverUpdateInstallResult> {
      let installed = 0
      let failed = 0
      let rebootRequired = false
      const errors: { deviceName: string; reason: string }[] = []

      if (wuUpdateIds.length === 0) {
        return { installed: 0, failed: 0, rebootRequired: false, errors: [] }
      }

      onProgress?.({
        phase: 'downloading',
        current: 0,
        total: wuUpdateIds.length,
        currentDevice: 'Preparing driver updates...',
        percent: 0
      })

      try {
        // Build a PS array literal of the WU UpdateIDs for exact matching
        const idsArray = wuUpdateIds
          .map((id) => `'${id.replace(/'/g, "''")}'`)
          .join(',')

        const script = `
          $ErrorActionPreference = 'Stop'
          $selectedIds = @(${idsArray})

          $session = New-Object -ComObject Microsoft.Update.Session
          $searcher = $session.CreateUpdateSearcher()
          $result = $searcher.Search("IsInstalled=0 AND Type='Driver'")

          $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl

          foreach ($update in $result.Updates) {
            if ($selectedIds -contains $update.Identity.UpdateID) {
              $update.AcceptEula()
              $toInstall.Add($update) | Out-Null
            }
          }

          if ($toInstall.Count -eq 0) {
            Write-Output 'RESULT|0|0|false'
            return
          }

          # Download
          $downloader = $session.CreateUpdateDownloader()
          $downloader.Updates = $toInstall
          Write-Output "STATUS|downloading|$($toInstall.Count)"
          $dlResult = $downloader.Download()

          # Install
          $installer = $session.CreateUpdateInstaller()
          $installer.Updates = $toInstall
          Write-Output "STATUS|installing|$($toInstall.Count)"
          $installResult = $installer.Install()

          $ok = 0
          $fail = 0
          $reboot = $installResult.RebootRequired

          for ($i = 0; $i -lt $toInstall.Count; $i++) {
            $r = $installResult.GetUpdateResult($i)
            $name = $toInstall.Item($i).Title
            if ($r.ResultCode -eq 2) {
              $ok++
              Write-Output "INSTALLED|$name"
            } else {
              $fail++
              Write-Output "FAILED|$name|ResultCode=$($r.ResultCode)"
            }
          }

          Write-Output "RESULT|$ok|$fail|$reboot"
        `

        const { stdout } = await execFileAsync('powershell', psArgs(script), { timeout: 600000, maxBuffer: 10 * 1024 * 1024, windowsHide: true })

        const lines = stdout.trim().split('\n').map((l: string) => l.trim()).filter(Boolean)

        for (const line of lines) {
          if (line.startsWith('STATUS|')) {
            const parts = line.split('|')
            const phase = parts[1] === 'installing' ? 'installing' as const : 'downloading' as const
            const total = parseInt(parts[2], 10) || wuUpdateIds.length
            onProgress?.({
              phase,
              current: 0,
              total,
              currentDevice: phase === 'installing' ? 'Installing drivers...' : 'Downloading drivers...',
              percent: phase === 'installing' ? 50 : 25
            })
          } else if (line.startsWith('INSTALLED|')) {
            installed++
            const name = line.substring('INSTALLED|'.length)
            onProgress?.({
              phase: 'installing',
              current: installed + failed,
              total: wuUpdateIds.length,
              currentDevice: name,
              percent: Math.round(((installed + failed) / wuUpdateIds.length) * 100)
            })
          } else if (line.startsWith('FAILED|')) {
            failed++
            const parts = line.split('|')
            errors.push({ deviceName: parts[1] || 'Unknown', reason: parts[2] || 'Install failed' })
          } else if (line.startsWith('RESULT|')) {
            const parts = line.split('|')
            installed = parseInt(parts[1], 10) || installed
            failed = parseInt(parts[2], 10) || failed
            rebootRequired = parts[3] === 'True' || parts[3] === 'true'
          }
        }
      } catch (err: any) {
        const msg = err?.stderr || err?.message || 'Unknown error'
        errors.push({ deviceName: 'Windows Update', reason: msg.slice(0, 300) })
        if (installed === 0) failed = wuUpdateIds.length
      }

      return { installed, failed, rebootRequired, errors }
}

export function registerDriverManagerIpc(getWindow: WindowGetter): void {
  const sendProgress = (data: DriverScanProgress): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.DRIVER_PROGRESS, data)
  }

  const sendUpdateProgress = (data: DriverUpdateProgress): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.DRIVER_UPDATE_PROGRESS, data)
  }

  ipcMain.handle(IPC.DRIVER_SCAN, () => scanDrivers(sendProgress))

  ipcMain.handle(IPC.DRIVER_CLEAN, async (_event, publishedNames: string[]) => {
    const valid = validateStringArray(publishedNames, 500)
    if (!valid) return { removed: 0, failed: 0, spaceRecovered: 0, errors: [] }
    return cleanDrivers(valid)
  })

  ipcMain.handle(IPC.DRIVER_UPDATE_SCAN, () => scanDriverUpdates(sendUpdateProgress))

  ipcMain.handle(IPC.DRIVER_UPDATE_INSTALL, async (_event, wuUpdateIds: string[]) => {
    const valid = validateStringArray(wuUpdateIds, 500)
    if (!valid) return { installed: 0, failed: 0, rebootRequired: false, errors: [] }
    return installDriverUpdates(valid, sendUpdateProgress)
  })
}
