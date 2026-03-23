import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformSecurity } from '../types'
import type { HealthReport } from '../../services/cloud-agent-types'

const execFileAsync = promisify(execFile)

export function createDarwinSecurity(): PlatformSecurity {
  return {
    async isServer() { return false },
    async collectAntivirusStatus(): Promise<HealthReport['securityPosture']['antivirus']> {
      // macOS has XProtect built-in — try multiple known paths (varies by macOS version)
      const xprotectPaths = [
        '/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist',
        '/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist',
      ]
      try {
        let stdout = ''
        for (const plistPath of xprotectPaths) {
          try {
            const result = await execFileAsync('/usr/bin/defaults', [
              'read', plistPath, 'CFBundleShortVersionString',
            ], { timeout: 10_000 })
            stdout = result.stdout
            break
          } catch { /* try next path */ }
        }
        if (!stdout.trim()) throw new Error('XProtect version not found')
        const version = stdout.trim()
        return {
          products: [{
            name: `XProtect (${version})`,
            enabled: true,
            realTimeProtection: true,
            signatureUpToDate: true, // XProtect updates via macOS software update
          }],
          primary: 'XProtect',
        }
      } catch {
        return {
          products: [{ name: 'XProtect', enabled: true, realTimeProtection: true, signatureUpToDate: true }],
          primary: 'XProtect',
        }
      }
    },

    async collectFirewallStatus(): Promise<HealthReport['securityPosture']['firewall']> {
      try {
        // Use socketfilterfw which is the authoritative source for firewall state.
        // The defaults-read approach (/Library/Preferences/com.apple.alf globalstate)
        // can fail on modern macOS (Sonoma+) due to plist access restrictions,
        // causing false negatives where an enabled firewall is reported as disabled.
        const { stdout } = await execFileAsync(
          '/usr/libexec/ApplicationFirewall/socketfilterfw',
          ['--getglobalstate'],
          { timeout: 10_000 },
        )
        const enabled = /enabled/i.test(stdout)
        return {
          enabled,
          products: [{ name: 'macOS Application Firewall', enabled }],
          windowsProfiles: { domain: false, private: false, public: false }, // N/A on macOS
        }
      } catch {
        return {
          enabled: false,
          products: [],
          windowsProfiles: { domain: false, private: false, public: false },
        }
      }
    },

    async collectDiskEncryptionStatus(): Promise<HealthReport['securityPosture']['bitlocker']> {
      try {
        const { stdout } = await execFileAsync('/usr/bin/fdesetup', ['status'], { timeout: 10_000 })
        const isOn = stdout.includes('FileVault is On')
        return {
          volumes: [{
            mount: '/',
            status: isOn ? 'FullyEncrypted' : 'FullyDecrypted',
            protectionOn: isOn,
          }],
        }
      } catch {
        return { volumes: [] }
      }
    },

    async collectUpdateStatus(): Promise<HealthReport['securityPosture']['windowsUpdate']> {
      try {
        const { stdout } = await execFileAsync('/usr/sbin/system_profiler', [
          'SPInstallHistoryDataType', '-json',
        ], { timeout: 30_000 })

        const data = JSON.parse(stdout)
        const installs: Array<{ _name: string; install_date: string }> =
          data?.SPInstallHistoryDataType ?? []

        // Get the 10 most recent installs
        const sorted = installs
          .filter((i) => i.install_date)
          .sort((a, b) => new Date(b.install_date).getTime() - new Date(a.install_date).getTime())
          .slice(0, 10)

        const recentPatches = sorted.map((i) => ({
          id: i._name ?? '',
          installedOn: new Date(i.install_date).toISOString().split('T')[0],
          description: i._name ?? '',
        }))

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
      } catch {
        return { recentPatches: [], lastPatchDate: null, daysSinceLastPatch: null }
      }
    },

    async collectScreenLockStatus(): Promise<HealthReport['securityPosture']['screenLock']> {
      try {
        const [idleResult, passwordResult] = await Promise.allSettled([
          execFileAsync('/usr/bin/defaults', [
            '-currentHost', 'read', 'com.apple.screensaver', 'idleTime',
          ], { timeout: 10_000 }),
          execFileAsync('/usr/bin/defaults', [
            '-currentHost', 'read', 'com.apple.screensaver', 'askForPassword',
          ], { timeout: 10_000 }),
        ])

        const timeoutSec = idleResult.status === 'fulfilled'
          ? parseInt(idleResult.value.stdout.trim(), 10) || null
          : null
        const lockOnResume = passwordResult.status === 'fulfilled'
          ? passwordResult.value.stdout.trim() === '1'
          : false

        return {
          screenSaverEnabled: timeoutSec !== null && timeoutSec > 0,
          lockOnResume,
          timeoutSec,
          inactivityLockSec: null, // No separate GPO concept on macOS
        }
      } catch {
        return { screenSaverEnabled: false, lockOnResume: false, timeoutSec: null, inactivityLockSec: null }
      }
    },

    async collectPasswordPolicy(): Promise<HealthReport['securityPosture']['passwordPolicy']> {
      // macOS password policy via pwpolicy is complex and requires admin
      // Return sensible defaults; can be enhanced later
      try {
        const { stdout } = await execFileAsync('/usr/bin/pwpolicy', [
          '-getaccountpolicies',
        ], { timeout: 10_000 })

        // Parse XML policy document for basic fields
        const minLength = parseInt(stdout.match(/policyAttributePassword.*?(\d+)/s)?.[1] ?? '0', 10)

        return {
          minLength: isNaN(minLength) ? 0 : minLength,
          maxAgeDays: 0,
          minAgeDays: 0,
          historyCount: 0,
          complexityRequired: false,
          lockoutThreshold: 0,
          lockoutDurationMin: 0,
          lockoutObservationMin: 0,
          windowsHello: {
            enrolled: false,
            faceEnabled: false,
            fingerprintEnabled: false,
            pinEnabled: false,
          },
        }
      } catch {
        return {
          minLength: 0, maxAgeDays: 0, minAgeDays: 0, historyCount: 0,
          complexityRequired: false, lockoutThreshold: 0, lockoutDurationMin: 0,
          lockoutObservationMin: 0,
          windowsHello: { enrolled: false, faceEnabled: false, fingerprintEnabled: false, pinEnabled: false },
        }
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
