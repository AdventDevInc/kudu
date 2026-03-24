import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: execFileMock,
}))
vi.mock('util', () => ({
  promisify: (fn: any) => fn,
}))

const { createDarwinSecurity } = await import('./security')

describe('darwin security', () => {
  const security = createDarwinSecurity()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('isServer', () => {
    it('returns false (macOS is not treated as a server)', async () => {
      expect(await security.isServer()).toBe(false)
    })
  })

  describe('collectAntivirusStatus', () => {
    it('returns XProtect with version when found', async () => {
      execFileMock.mockResolvedValueOnce({ stdout: '5200\n', stderr: '' })
      const result = await security.collectAntivirusStatus()
      expect(result.primary).toBe('XProtect')
      expect(result.products).toHaveLength(1)
      expect(result.products[0].name).toBe('XProtect (5200)')
      expect(result.products[0].enabled).toBe(true)
      expect(result.products[0].realTimeProtection).toBe(true)
    })

    it('tries second plist path if first fails', async () => {
      execFileMock
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce({ stdout: '2170\n', stderr: '' })

      const result = await security.collectAntivirusStatus()
      expect(result.products[0].name).toBe('XProtect (2170)')
      expect(execFileMock).toHaveBeenCalledTimes(2)
    })

    it('returns default XProtect when version cannot be found', async () => {
      execFileMock.mockRejectedValue(new Error('not found'))
      const result = await security.collectAntivirusStatus()
      expect(result.primary).toBe('XProtect')
      expect(result.products[0].name).toBe('XProtect')
      expect(result.products[0].enabled).toBe(true)
    })

    it('returns default XProtect when stdout is empty', async () => {
      execFileMock.mockResolvedValue({ stdout: '  \n', stderr: '' })
      const result = await security.collectAntivirusStatus()
      expect(result.products[0].name).toBe('XProtect')
    })
  })

  describe('collectFirewallStatus', () => {
    it('returns enabled when socketfilterfw reports enabled', async () => {
      execFileMock.mockResolvedValue({ stdout: 'Firewall is enabled. (State = 1)' })
      const result = await security.collectFirewallStatus()
      expect(result.enabled).toBe(true)
      expect(result.products[0].name).toBe('macOS Application Firewall')
      expect(result.products[0].enabled).toBe(true)
    })

    it('returns disabled when socketfilterfw reports disabled', async () => {
      execFileMock.mockResolvedValue({ stdout: 'Firewall is disabled. (State = 0)' })
      const result = await security.collectFirewallStatus()
      expect(result.enabled).toBe(false)
      expect(result.products[0].enabled).toBe(false)
    })

    it('returns disabled on error', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await security.collectFirewallStatus()
      expect(result.enabled).toBe(false)
      expect(result.products).toEqual([])
    })
  })

  describe('collectDiskEncryptionStatus', () => {
    it('returns FullyEncrypted when FileVault is On', async () => {
      execFileMock.mockResolvedValue({ stdout: 'FileVault is On.' })
      const result = await security.collectDiskEncryptionStatus()
      expect(result.volumes).toHaveLength(1)
      expect(result.volumes[0].status).toBe('FullyEncrypted')
      expect(result.volumes[0].protectionOn).toBe(true)
      expect(result.volumes[0].mount).toBe('/')
    })

    it('returns FullyDecrypted when FileVault is Off', async () => {
      execFileMock.mockResolvedValue({ stdout: 'FileVault is Off.' })
      const result = await security.collectDiskEncryptionStatus()
      expect(result.volumes[0].status).toBe('FullyDecrypted')
      expect(result.volumes[0].protectionOn).toBe(false)
    })

    it('returns empty volumes on error', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await security.collectDiskEncryptionStatus()
      expect(result.volumes).toEqual([])
    })
  })

  describe('collectUpdateStatus', () => {
    it('parses install history and returns recent patches', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({
          SPInstallHistoryDataType: [
            { _name: 'macOS 15.2', install_date: '2025-12-15T10:00:00Z' },
            { _name: 'Safari 18.0', install_date: '2025-12-10T10:00:00Z' },
          ],
        }),
      })

      const result = await security.collectUpdateStatus()
      expect(result.recentPatches).toHaveLength(2)
      expect(result.recentPatches[0].id).toBe('macOS 15.2')
      expect(result.lastPatchDate).toBe('2025-12-15')
      expect(result.daysSinceLastPatch).toBeGreaterThanOrEqual(0)
    })

    it('returns empty data on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await security.collectUpdateStatus()
      expect(result.recentPatches).toEqual([])
      expect(result.lastPatchDate).toBeNull()
      expect(result.daysSinceLastPatch).toBeNull()
    })

    it('sorts by install date descending', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({
          SPInstallHistoryDataType: [
            { _name: 'Old', install_date: '2025-01-01T00:00:00Z' },
            { _name: 'New', install_date: '2025-12-01T00:00:00Z' },
          ],
        }),
      })

      const result = await security.collectUpdateStatus()
      expect(result.recentPatches[0].id).toBe('New')
    })

    it('filters out entries without install_date', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({
          SPInstallHistoryDataType: [
            { _name: 'No Date' },
            { _name: 'Has Date', install_date: '2025-06-01T00:00:00Z' },
          ],
        }),
      })

      const result = await security.collectUpdateStatus()
      expect(result.recentPatches).toHaveLength(1)
      expect(result.recentPatches[0].id).toBe('Has Date')
    })
  })

  describe('collectScreenLockStatus', () => {
    it('returns enabled screen saver and lock on resume', async () => {
      execFileMock
        .mockResolvedValueOnce({ stdout: '300\n' })  // idleTime
        .mockResolvedValueOnce({ stdout: '1\n' })     // askForPassword

      const result = await security.collectScreenLockStatus()
      expect(result.screenSaverEnabled).toBe(true)
      expect(result.lockOnResume).toBe(true)
      expect(result.timeoutSec).toBe(300)
    })

    it('returns disabled screen saver when idleTime is 0', async () => {
      execFileMock
        .mockResolvedValueOnce({ stdout: '0\n' })
        .mockResolvedValueOnce({ stdout: '1\n' })

      const result = await security.collectScreenLockStatus()
      expect(result.screenSaverEnabled).toBe(false)
    })

    it('handles failures gracefully', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await security.collectScreenLockStatus()
      expect(result.screenSaverEnabled).toBe(false)
      expect(result.lockOnResume).toBe(false)
      expect(result.timeoutSec).toBeNull()
    })
  })

  describe('collectPasswordPolicy', () => {
    it('parses password policy XML for minLength', async () => {
      execFileMock.mockResolvedValue({
        stdout: '<dict><key>policyAttributePassword</key><integer>8</integer></dict>',
      })

      const result = await security.collectPasswordPolicy()
      expect(result.minLength).toBe(8)
    })

    it('returns defaults on failure', async () => {
      execFileMock.mockRejectedValue(new Error('fail'))
      const result = await security.collectPasswordPolicy()
      expect(result.minLength).toBe(0)
      expect(result.complexityRequired).toBe(false)
    })
  })

  describe('stub methods returning null', () => {
    it('collectSshHardening returns null', async () => {
      expect(await security.collectSshHardening()).toBeNull()
    })

    it('collectFail2ban returns null', async () => {
      expect(await security.collectFail2ban()).toBeNull()
    })

    it('collectListeningPorts returns null', async () => {
      expect(await security.collectListeningPorts()).toBeNull()
    })

    it('collectAuditd returns null', async () => {
      expect(await security.collectAuditd()).toBeNull()
    })

    it('collectSuidSgidBinaries returns null', async () => {
      expect(await security.collectSuidSgidBinaries()).toBeNull()
    })

    it('collectLinuxFirewallStatus returns null', async () => {
      expect(await security.collectLinuxFirewallStatus()).toBeNull()
    })
  })
})
