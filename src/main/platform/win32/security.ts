import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformSecurity } from '../types'
import type { HealthReport } from '../../services/cloud-agent-types'
import { psUtf8 } from '../../services/exec-utf8'

const execFileAsync = promisify(execFile)

export function createWin32Security(): PlatformSecurity {
  return {
    async isServer() { return false },
    async collectAntivirusStatus(): Promise<HealthReport['securityPosture']['antivirus']> {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        psUtf8('Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object displayName,productState | ConvertTo-Json -Compress'),
      ], { timeout: 15_000, windowsHide: true })

      const raw = JSON.parse(stdout.trim())
      const items: Array<{ displayName: string; productState: number }> =
        Array.isArray(raw) ? raw : [raw]

      const products = items.map((item) => {
        const state = item.productState
        const enabled = ((state >> 12) & 0xF) >= 1
        const signatureUpToDate = ((state >> 4) & 0x1) === 0
        const realTimeProtection = ((state >> 8) & 0xF) === 0
        return {
          name: item.displayName ?? 'Unknown',
          enabled,
          realTimeProtection: enabled && realTimeProtection,
          signatureUpToDate,
        }
      })

      const thirdParty = products.filter(
        (p) => p.enabled && p.realTimeProtection && p.name !== 'Windows Defender'
      )
      const primary = thirdParty[0]?.name ?? products.find((p) => p.enabled && p.realTimeProtection)?.name ?? null

      return { products, primary }
    },

    async collectFirewallStatus(): Promise<HealthReport['securityPosture']['firewall']> {
      const [fwProducts, fwProfiles] = await Promise.allSettled([
        execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          psUtf8('Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct | Select-Object displayName,productState | ConvertTo-Json -Compress'),
        ], { timeout: 15_000, windowsHide: true }),
        execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          psUtf8('Get-NetFirewallProfile | Select-Object Name,Enabled | ConvertTo-Json -Compress'),
        ], { timeout: 15_000, windowsHide: true }),
      ])

      const products: Array<{ name: string; enabled: boolean }> = []
      if (fwProducts.status === 'fulfilled') {
        try {
          const raw = JSON.parse(fwProducts.value.stdout.trim())
          const items: Array<{ displayName: string; productState: number }> =
            Array.isArray(raw) ? raw : [raw]
          for (const item of items) {
            const enabled = ((item.productState >> 12) & 0xF) >= 1
            products.push({ name: item.displayName ?? 'Unknown', enabled })
          }
        } catch { /* ignore parse errors */ }
      }

      const windowsProfiles = { domain: false, private: false, public: false }
      if (fwProfiles.status === 'fulfilled') {
        try {
          const raw = JSON.parse(fwProfiles.value.stdout.trim())
          const profiles: Array<{ Name: string; Enabled: number | boolean }> =
            Array.isArray(raw) ? raw : [raw]
          const lookup = Object.fromEntries(profiles.map((p) => [p.Name?.toLowerCase(), !!p.Enabled]))
          windowsProfiles.domain = lookup['domain'] ?? false
          windowsProfiles.private = lookup['private'] ?? false
          windowsProfiles.public = lookup['public'] ?? false
        } catch { /* ignore parse errors */ }
      }

      const thirdPartyEnabled = products.some((p) => p.enabled)
      const windowsEnabled = windowsProfiles.domain && windowsProfiles.private && windowsProfiles.public
      const enabled = thirdPartyEnabled || windowsEnabled

      return { enabled, products, windowsProfiles }
    },

    async collectDiskEncryptionStatus(): Promise<HealthReport['securityPosture']['bitlocker']> {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          psUtf8('Get-BitLockerVolume | Select-Object MountPoint,VolumeStatus,ProtectionStatus | ConvertTo-Json -Compress'),
        ], { timeout: 15_000, windowsHide: true })

        const raw = JSON.parse(stdout.trim())
        const vols: Array<{ MountPoint: string; VolumeStatus: number; ProtectionStatus: number }> =
          Array.isArray(raw) ? raw : [raw]

        const statusMap: Record<number, HealthReport['securityPosture']['bitlocker']['volumes'][0]['status']> = {
          0: 'FullyDecrypted', 1: 'FullyEncrypted', 2: 'EncryptionInProgress', 3: 'DecryptionInProgress',
        }

        return {
          volumes: vols.map((v) => ({
            mount: v.MountPoint ?? '',
            status: statusMap[v.VolumeStatus] ?? 'Unknown',
            protectionOn: v.ProtectionStatus === 1,
          })),
        }
      } catch {
        return { volumes: [] }
      }
    },

    async collectUpdateStatus(): Promise<HealthReport['securityPosture']['windowsUpdate']> {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        psUtf8('Get-HotFix | Sort-Object InstalledOn -Descending -ErrorAction SilentlyContinue | Select-Object -First 10 HotFixID,InstalledOn,Description | ConvertTo-Json -Compress'),
      ], { timeout: 15_000, windowsHide: true })

      const raw = JSON.parse(stdout.trim())
      const patches: Array<{ HotFixID: string; InstalledOn: string; Description: string }> =
        Array.isArray(raw) ? raw : [raw]

      const recentPatches = patches
        .filter((p) => p.HotFixID && p.InstalledOn)
        .map((p) => {
          // PowerShell can serialize InstalledOn as a DateTime[] (array) for
          // hotfixes that were applied multiple times. Normalize to first element.
          const installedRaw = Array.isArray(p.InstalledOn) ? p.InstalledOn[0] : p.InstalledOn
          const date = new Date(installedRaw)
          return {
            id: p.HotFixID,
            installedOn: isNaN(date.getTime()) ? String(installedRaw ?? '') : date.toISOString().split('T')[0],
            description: (p.Description || '').slice(0, 100),
          }
        })

      let lastPatchDate: string | null = null
      let daysSinceLastPatch: number | null = null
      if (recentPatches.length > 0) {
        lastPatchDate = recentPatches[0].installedOn
        const lastDate = new Date(lastPatchDate)
        if (!isNaN(lastDate.getTime())) {
          daysSinceLastPatch = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
        }
      }

      return { recentPatches, lastPatchDate, daysSinceLastPatch }
    },

    async collectScreenLockStatus(): Promise<HealthReport['securityPosture']['screenLock']> {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        psUtf8(
          `$ss = Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name 'ScreenSaveActive','ScreenSaverIsSecure','ScreenSaveTimeOut' -ErrorAction SilentlyContinue; ` +
          `$gpo = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name 'InactivityTimeoutSecs' -ErrorAction SilentlyContinue; ` +
          `[PSCustomObject]@{ ` +
          `  ssActive = $ss.ScreenSaveActive; ` +
          `  ssSecure = $ss.ScreenSaverIsSecure; ` +
          `  ssTimeout = $ss.ScreenSaveTimeOut; ` +
          `  gpoTimeout = $gpo.InactivityTimeoutSecs ` +
          `} | ConvertTo-Json -Compress`
        ),
      ], { timeout: 15_000, windowsHide: true })

      const data = JSON.parse(stdout.trim())
      const screenSaverEnabled = data.ssActive === '1' || data.ssActive === 1
      const lockOnResume = data.ssSecure === '1' || data.ssSecure === 1
      const timeoutSec = data.ssTimeout ? parseInt(String(data.ssTimeout), 10) : null
      const inactivityLockSec = typeof data.gpoTimeout === 'number' && data.gpoTimeout > 0 ? data.gpoTimeout : null

      return {
        screenSaverEnabled,
        lockOnResume,
        timeoutSec: timeoutSec && !isNaN(timeoutSec) ? timeoutSec : null,
        inactivityLockSec,
      }
    },

    async collectPasswordPolicy(): Promise<HealthReport['securityPosture']['passwordPolicy']> {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        psUtf8(
          `$out = net accounts 2>&1; ` +
          `$lines = $out -split '\\r?\\n'; ` +
          `function val($pattern) { foreach ($l in $lines) { if ($l -match $pattern) { if ($l -match '(\\d+)') { return [int]$Matches[1] } } }; return 0 } ` +
          `$complexity = $false; ` +
          `try { $tmp = [System.IO.Path]::GetTempFileName(); ` +
          `  secedit /export /cfg $tmp /quiet 2>&1 | Out-Null; ` +
          `  $sec = Get-Content $tmp -Raw -ErrorAction SilentlyContinue; ` +
          `  Remove-Item $tmp -ErrorAction SilentlyContinue; ` +
          `  if ($sec -match 'PasswordComplexity\\s*=\\s*1') { $complexity = $true } ` +
          `} catch {} ` +
          `$helloFace = $false; $helloFinger = $false; $helloPin = $false; $helloEnrolled = $false; ` +
          `try { ` +
          `  $cpBase = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\Credential Providers'; ` +
          `  $helloFace = Test-Path "$cpBase\\{8AF662BF-65A0-4D0A-A540-A338A999D36F}"; ` +
          `  $helloFinger = Test-Path "$cpBase\\{BEC09223-B018-416D-A0AC-523971B639F5}"; ` +
          `  $helloPin = Test-Path "$cpBase\\{D6886603-9D2F-4EB2-B667-1971041FA96B}"; ` +
          `  $userSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value; ` +
          `  $ngcPath = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI\\NgcPin\\Credentials\\$userSid"; ` +
          `  $helloEnrolled = Test-Path $ngcPath ` +
          `} catch {} ` +
          `[PSCustomObject]@{ ` +
          `  minLength = val 'Minimum password length'; ` +
          `  maxAge = val 'Maximum password age'; ` +
          `  minAge = val 'Minimum password age'; ` +
          `  history = val 'password history'; ` +
          `  complexity = $complexity; ` +
          `  lockoutThreshold = val 'Lockout threshold'; ` +
          `  lockoutDuration = val 'Lockout duration'; ` +
          `  lockoutWindow = val 'Lockout observation'; ` +
          `  helloEnrolled = $helloEnrolled; ` +
          `  helloFace = $helloFace; ` +
          `  helloFinger = $helloFinger; ` +
          `  helloPin = $helloPin ` +
          `} | ConvertTo-Json -Compress`
        ),
      ], { timeout: 15_000, windowsHide: true })

      const data = JSON.parse(stdout.trim())
      return {
        minLength: typeof data.minLength === 'number' ? data.minLength : 0,
        maxAgeDays: typeof data.maxAge === 'number' ? data.maxAge : 0,
        minAgeDays: typeof data.minAge === 'number' ? data.minAge : 0,
        historyCount: typeof data.history === 'number' ? data.history : 0,
        complexityRequired: data.complexity === true,
        lockoutThreshold: typeof data.lockoutThreshold === 'number' ? data.lockoutThreshold : 0,
        lockoutDurationMin: typeof data.lockoutDuration === 'number' ? data.lockoutDuration : 0,
        lockoutObservationMin: typeof data.lockoutWindow === 'number' ? data.lockoutWindow : 0,
        windowsHello: {
          enrolled: data.helloEnrolled === true,
          faceEnabled: data.helloFace === true,
          fingerprintEnabled: data.helloFinger === true,
          pinEnabled: data.helloPin === true,
        },
      }
    },

    async collectSshHardening(): Promise<HealthReport['securityPosture']['sshHardening']> {
      return null
    },

    async collectFail2ban(): Promise<HealthReport['securityPosture']['fail2ban']> {
      return null
    },

    async collectListeningPorts(): Promise<HealthReport['securityPosture']['listeningPorts']> {
      return null
    },

    async collectAuditd(): Promise<HealthReport['securityPosture']['auditd']> {
      return null
    },

    async collectSuidSgidBinaries(): Promise<HealthReport['securityPosture']['suidSgidBinaries']> {
      return null
    },

    async collectLinuxFirewallStatus(): Promise<HealthReport['securityPosture']['firewallStatus']> {
      return null
    },
  }
}
