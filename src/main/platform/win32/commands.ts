import * as si from 'systeminformation'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformCommands, EventLogEntry, InstalledApp, OsUpdateInfo, OsUpdateInstallResult, SfcResult, DismResult, DnsEntry } from '../types'
import { psUtf8 } from '../../services/exec-utf8'

const execFileAsync = promisify(execFile)

export function createWin32Commands(): PlatformCommands {
  return {
    async shutdown(delaySec: number): Promise<void> {
      await execFileAsync('shutdown.exe', ['/s', '/t', String(delaySec)], { windowsHide: true })
    },

    async restart(delaySec: number): Promise<void> {
      await execFileAsync('shutdown.exe', ['/r', '/t', String(delaySec)], { windowsHide: true })
    },

    async getDnsServers(): Promise<DnsEntry[]> {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          psUtf8('Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,ServerAddresses | ConvertTo-Json -Compress'),
        ], { timeout: 15_000, windowsHide: true })

        const raw = JSON.parse(stdout.trim())
        const items: Array<{ InterfaceAlias: string; ServerAddresses: string[] }> =
          Array.isArray(raw) ? raw : [raw]
        return items
          .filter((d) => d.ServerAddresses?.length > 0)
          .map((d) => ({ iface: d.InterfaceAlias, servers: d.ServerAddresses }))
      } catch {
        return []
      }
    },

    async getEventLog(logName: string, maxEntries: number): Promise<EventLogEntry[]> {
      // Validate inputs to prevent injection — only allow known log names and numeric max
      const allowedLogs = new Set(['System', 'Application', 'Security'])
      const safeName = allowedLogs.has(logName) ? logName : 'System'
      const safeMax = Math.max(1, Math.min(Math.floor(Number(maxEntries)) || 50, 200))

      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        psUtf8(
          `Get-WinEvent -LogName '${safeName}' -MaxEvents ${safeMax} | ` +
          `Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message | ` +
          `ForEach-Object { [PSCustomObject]@{ ` +
          `time=$_.TimeCreated.ToString('o'); id=$_.Id; level=$_.LevelDisplayName; ` +
          `provider=$_.ProviderName; message=($_.Message -replace '\\r?\\n',' ').Substring(0, [Math]::Min(200, $_.Message.Length)) } } | ` +
          `ConvertTo-Json -Compress`
        ),
      ], { timeout: 30_000, windowsHide: true })

      const raw = JSON.parse(stdout.trim())
      const entries: Array<{ time: string; id: number; level: string; provider: string; message: string }> =
        Array.isArray(raw) ? raw : [raw]

      return entries.map((e) => ({
        time: e.time,
        eventId: e.id,
        level: e.level ?? 'Information',
        provider: e.provider ?? '',
        message: e.message ?? '',
      }))
    },

    async getInstalledApps(): Promise<InstalledApp[]> {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        psUtf8(
          `$apps = @(); ` +
          `$paths = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', ` +
          `'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); ` +
          `foreach ($p in $paths) { ` +
          `  $apps += Get-ItemProperty $p -ErrorAction SilentlyContinue | ` +
          `  Where-Object { $_.DisplayName -and $_.DisplayName.Trim() -ne '' } | ` +
          `  Select-Object DisplayName,DisplayVersion,Publisher,InstallDate,EstimatedSize } ` +
          `$apps | Sort-Object DisplayName -Unique | ConvertTo-Json -Compress`
        ),
      ], { timeout: 30_000, windowsHide: true })

      const trimmed = stdout.trim()
      if (!trimmed) return []
      const raw = JSON.parse(trimmed)
      const apps: Array<{ DisplayName: string; DisplayVersion: string; Publisher: string; InstallDate: string; EstimatedSize: number }> =
        Array.isArray(raw) ? raw : [raw]

      return apps.map((a) => ({
        name: a.DisplayName ?? '',
        version: a.DisplayVersion ?? '',
        publisher: a.Publisher ?? '',
        installDate: a.InstallDate ?? '',
        sizeKb: a.EstimatedSize ?? 0,
      }))
    },

    async checkOsUpdates(): Promise<OsUpdateInfo[]> {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          psUtf8(
            `$session = New-Object -ComObject Microsoft.Update.Session; ` +
            `$searcher = $session.CreateUpdateSearcher(); ` +
            `$result = $searcher.Search('IsInstalled=0'); ` +
            `$result.Updates | ForEach-Object { ` +
            `  [PSCustomObject]@{ Title=$_.Title; KBArticleIDs=($_.KBArticleIDs -join ','); ` +
            `  Severity=$_.MsrcSeverity; Size=$_.MaxDownloadSize; IsDownloaded=$_.IsDownloaded } ` +
            `} | ConvertTo-Json -Compress`
          ),
        ], { timeout: 120_000, windowsHide: true })

        const trimmed = stdout.trim()
        if (!trimmed) return []
        const raw = JSON.parse(trimmed)
        const updates: Array<{ Title: string; KBArticleIDs: string; Severity: string; Size: number; IsDownloaded: boolean }> =
          Array.isArray(raw) ? raw : [raw]

        return updates.map((u) => ({
          title: u.Title ?? '',
          kb: u.KBArticleIDs ?? '',
          severity: u.Severity ?? 'Unspecified',
          sizeBytes: u.Size ?? 0,
          downloaded: u.IsDownloaded === true,
        }))
      } catch {
        return []
      }
    },

    async installOsUpdates(): Promise<OsUpdateInstallResult> {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          psUtf8(
            `$session = New-Object -ComObject Microsoft.Update.Session; ` +
            `$searcher = $session.CreateUpdateSearcher(); ` +
            `$result = $searcher.Search('IsInstalled=0'); ` +
            `if ($result.Updates.Count -eq 0) { Write-Output '{"installed":0,"needsReboot":false}'; exit } ` +
            `$downloader = $session.CreateUpdateDownloader(); ` +
            `$downloader.Updates = $result.Updates; ` +
            `$downloader.Download() | Out-Null; ` +
            `$installer = $session.CreateUpdateInstaller(); ` +
            `$installer.Updates = $result.Updates; ` +
            `$installResult = $installer.Install(); ` +
            `[PSCustomObject]@{ installed=$result.Updates.Count; ` +
            `resultCode=$installResult.ResultCode; ` +
            `needsReboot=$installResult.RebootRequired } | ConvertTo-Json -Compress`
          ),
        ], { timeout: 300_000, windowsHide: true })

        const data = JSON.parse(stdout.trim())
        return {
          installed: data.installed ?? 0,
          resultCode: data.resultCode ?? -1,
          needsReboot: data.needsReboot === true,
        }
      } catch {
        return { installed: 0, resultCode: -1, needsReboot: false }
      }
    },

    async runSystemFileCheck(): Promise<SfcResult> {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          psUtf8(
            `$p = Start-Process -FilePath 'sfc.exe' -ArgumentList '/scannow' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput "$env:TEMP\\sfc_out.txt"; ` +
            `$output = Get-Content "$env:TEMP\\sfc_out.txt" -Raw -Encoding UTF8 -ErrorAction SilentlyContinue; ` +
            `Remove-Item "$env:TEMP\\sfc_out.txt" -ErrorAction SilentlyContinue; ` +
            `[PSCustomObject]@{ exitCode=$p.ExitCode; output=$output } | ConvertTo-Json -Compress`
          ),
        ], { timeout: 300_000, windowsHide: true })

        const data = JSON.parse(stdout.trim())
        const output = (data.output ?? '') as string
        let status = 'unknown'
        if (output.includes('did not find any integrity violations')) status = 'clean'
        else if (output.includes('successfully repaired')) status = 'repaired'
        else if (output.includes('found corrupt files but was unable')) status = 'corrupt_unrepairable'
        else if (output.includes('could not perform')) status = 'failed'

        return { exitCode: data.exitCode ?? -1, status }
      } catch {
        return { exitCode: -1, status: 'failed' }
      }
    },

    async runSystemImageRepair(): Promise<DismResult> {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          psUtf8(
            `$p = Start-Process -FilePath 'dism.exe' -ArgumentList '/Online','/Cleanup-Image','/RestoreHealth' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput "$env:TEMP\\dism_out.txt"; ` +
            `$output = Get-Content "$env:TEMP\\dism_out.txt" -Raw -Encoding UTF8 -ErrorAction SilentlyContinue; ` +
            `Remove-Item "$env:TEMP\\dism_out.txt" -ErrorAction SilentlyContinue; ` +
            `[PSCustomObject]@{ exitCode=$p.ExitCode; output=$output } | ConvertTo-Json -Compress`
          ),
        ], { timeout: 300_000, windowsHide: true })

        const data = JSON.parse(stdout.trim())
        const output = (data.output ?? '') as string
        let status = 'unknown'
        if (output.includes('The restore operation completed successfully')) status = 'success'
        else if (output.includes('No component store corruption detected')) status = 'clean'
        else if (output.includes('component store corruption')) status = 'corrupt'
        else if (data.exitCode === 0) status = 'success'

        return { exitCode: data.exitCode ?? -1, status }
      } catch {
        return { exitCode: -1, status: 'failed' }
      }
    },
  }
}
