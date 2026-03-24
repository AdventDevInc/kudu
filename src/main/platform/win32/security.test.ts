import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))

vi.mock('util', () => ({
  promisify: () => execFileMock,
}))

const { createWin32Security } = await import('./security')

describe('win32 security', () => {
  const security = createWin32Security()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('isServer', () => {
    it('returns false for Windows desktop', async () => {
      expect(await security.isServer()).toBe(false)
    })
  })

  describe('collectAntivirusStatus', () => {
    it('parses antivirus products from WMI output', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { displayName: 'Windows Defender', productState: 397568 },
        ]),
        stderr: '',
      })

      const result = await security.collectAntivirusStatus()
      expect(result.products).toHaveLength(1)
      expect(result.products[0].name).toBe('Windows Defender')
    })

    it('handles single-object output', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ displayName: 'Norton', productState: 397568 }),
        stderr: '',
      })

      const result = await security.collectAntivirusStatus()
      expect(result.products).toHaveLength(1)
      expect(result.products[0].name).toBe('Norton')
    })

    it('identifies third-party AV as primary over Windows Defender', async () => {
      // productState where enabled=true, realTimeProtection=true, signatureUpToDate=true
      // Bit 12-15 = 6 (enabled >= 1), Bit 8-11 = 0 (realtime = true), Bit 4 = 0 (sigs up to date)
      const enabledState = (6 << 12) | (0 << 8) | (0 << 4)
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { displayName: 'Windows Defender', productState: enabledState },
          { displayName: 'Kaspersky', productState: enabledState },
        ]),
        stderr: '',
      })

      const result = await security.collectAntivirusStatus()
      expect(result.primary).toBe('Kaspersky')
    })

    it('falls back to Windows Defender as primary when no third-party AV', async () => {
      const enabledState = (6 << 12) | (0 << 8) | (0 << 4)
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { displayName: 'Windows Defender', productState: enabledState },
        ]),
        stderr: '',
      })

      const result = await security.collectAntivirusStatus()
      expect(result.primary).toBe('Windows Defender')
    })

    it('defaults displayName to Unknown when missing', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ displayName: null, productState: 397568 }),
        stderr: '',
      })

      const result = await security.collectAntivirusStatus()
      expect(result.products[0].name).toBe('Unknown')
    })
  })

  describe('collectFirewallStatus', () => {
    it('parses firewall products and Windows profiles', async () => {
      // collectFirewallStatus uses Promise.allSettled with two execFile calls
      execFileMock
        .mockResolvedValueOnce({
          stdout: JSON.stringify([{ displayName: 'Windows Firewall', productState: (6 << 12) }]),
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            { Name: 'Domain', Enabled: true },
            { Name: 'Private', Enabled: true },
            { Name: 'Public', Enabled: true },
          ]),
          stderr: '',
        })

      const result = await security.collectFirewallStatus()
      expect(result.enabled).toBe(true)
      expect(result.windowsProfiles).toEqual({ domain: true, private: true, public: true })
    })

    it('handles failure of both firewall queries gracefully', async () => {
      execFileMock.mockRejectedValue(new Error('access denied'))

      const result = await security.collectFirewallStatus()
      expect(result.products).toEqual([])
      expect(result.windowsProfiles).toEqual({ domain: false, private: false, public: false })
      expect(result.enabled).toBe(false)
    })

    it('detects enabled when only Windows profiles are all on', async () => {
      execFileMock
        .mockRejectedValueOnce(new Error('no SecurityCenter2'))
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            { Name: 'Domain', Enabled: 1 },
            { Name: 'Private', Enabled: 1 },
            { Name: 'Public', Enabled: 1 },
          ]),
          stderr: '',
        })

      const result = await security.collectFirewallStatus()
      expect(result.enabled).toBe(true)
    })

    it('reports disabled when only some Windows profiles are on', async () => {
      execFileMock
        .mockRejectedValueOnce(new Error('no SecurityCenter2'))
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            { Name: 'Domain', Enabled: true },
            { Name: 'Private', Enabled: false },
            { Name: 'Public', Enabled: true },
          ]),
          stderr: '',
        })

      const result = await security.collectFirewallStatus()
      expect(result.windowsProfiles.private).toBe(false)
      // Not all profiles enabled, so windowsEnabled is false
      expect(result.enabled).toBe(false)
    })
  })

  describe('collectDiskEncryptionStatus', () => {
    it('parses BitLocker volume statuses', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { MountPoint: 'C:', VolumeStatus: 1, ProtectionStatus: 1 },
          { MountPoint: 'D:', VolumeStatus: 0, ProtectionStatus: 0 },
        ]),
        stderr: '',
      })

      const result = await security.collectDiskEncryptionStatus()
      expect(result.volumes).toHaveLength(2)
      expect(result.volumes[0]).toEqual({ mount: 'C:', status: 'FullyEncrypted', protectionOn: true })
      expect(result.volumes[1]).toEqual({ mount: 'D:', status: 'FullyDecrypted', protectionOn: false })
    })

    it('handles unknown volume status codes', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ MountPoint: 'E:', VolumeStatus: 99, ProtectionStatus: 0 }),
        stderr: '',
      })

      const result = await security.collectDiskEncryptionStatus()
      expect(result.volumes[0].status).toBe('Unknown')
    })

    it('returns empty volumes array on error', async () => {
      execFileMock.mockRejectedValue(new Error('BitLocker not available'))
      const result = await security.collectDiskEncryptionStatus()
      expect(result).toEqual({ volumes: [] })
    })
  })

  describe('collectUpdateStatus', () => {
    it('parses hotfix data and calculates days since last patch', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { HotFixID: 'KB5001234', InstalledOn: recentDate, Description: 'Security Update' },
        ]),
        stderr: '',
      })

      const result = await security.collectUpdateStatus()
      expect(result.recentPatches).toHaveLength(1)
      expect(result.recentPatches[0].id).toBe('KB5001234')
      expect(result.daysSinceLastPatch).toBeGreaterThanOrEqual(4)
      expect(result.daysSinceLastPatch).toBeLessThanOrEqual(6)
    })

    it('filters out patches without HotFixID or InstalledOn', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([
          { HotFixID: 'KB5001234', InstalledOn: '2024-01-01', Description: 'Update' },
          { HotFixID: null, InstalledOn: '2024-01-01', Description: 'Bad' },
          { HotFixID: 'KB5001235', InstalledOn: null, Description: 'Bad' },
        ]),
        stderr: '',
      })

      const result = await security.collectUpdateStatus()
      expect(result.recentPatches).toHaveLength(1)
    })

    it('handles InstalledOn as array (PowerShell DateTime[])', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({
          HotFixID: 'KB5001234',
          InstalledOn: ['2024-06-15T12:00:00Z', '2024-05-10T12:00:00Z'],
          Description: 'Security Update',
        }),
        stderr: '',
      })

      const result = await security.collectUpdateStatus()
      expect(result.recentPatches[0].installedOn).toBe('2024-06-15')
    })

    it('returns null values when no patches exist', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify([]),
        stderr: '',
      })

      const result = await security.collectUpdateStatus()
      expect(result.recentPatches).toEqual([])
      expect(result.lastPatchDate).toBeNull()
      expect(result.daysSinceLastPatch).toBeNull()
    })
  })

  describe('collectScreenLockStatus', () => {
    it('parses screen lock settings from registry data', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({
          ssActive: '1',
          ssSecure: '1',
          ssTimeout: '600',
          gpoTimeout: 300,
        }),
        stderr: '',
      })

      const result = await security.collectScreenLockStatus()
      expect(result).toEqual({
        screenSaverEnabled: true,
        lockOnResume: true,
        timeoutSec: 600,
        inactivityLockSec: 300,
      })
    })

    it('handles numeric ssActive and ssSecure values', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ ssActive: 1, ssSecure: 1, ssTimeout: '300', gpoTimeout: null }),
        stderr: '',
      })

      const result = await security.collectScreenLockStatus()
      expect(result.screenSaverEnabled).toBe(true)
      expect(result.lockOnResume).toBe(true)
      expect(result.inactivityLockSec).toBeNull()
    })

    it('handles disabled screen saver', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({ ssActive: '0', ssSecure: '0', ssTimeout: null, gpoTimeout: 0 }),
        stderr: '',
      })

      const result = await security.collectScreenLockStatus()
      expect(result.screenSaverEnabled).toBe(false)
      expect(result.lockOnResume).toBe(false)
      expect(result.timeoutSec).toBeNull()
      expect(result.inactivityLockSec).toBeNull()
    })
  })

  describe('collectPasswordPolicy', () => {
    it('parses password policy from net accounts output', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({
          minLength: 8,
          maxAge: 90,
          minAge: 1,
          history: 5,
          complexity: true,
          lockoutThreshold: 5,
          lockoutDuration: 30,
          lockoutWindow: 30,
          helloEnrolled: true,
          helloFace: true,
          helloFinger: false,
          helloPin: true,
        }),
        stderr: '',
      })

      const result = await security.collectPasswordPolicy()
      expect(result).toEqual({
        minLength: 8,
        maxAgeDays: 90,
        minAgeDays: 1,
        historyCount: 5,
        complexityRequired: true,
        lockoutThreshold: 5,
        lockoutDurationMin: 30,
        lockoutObservationMin: 30,
        windowsHello: {
          enrolled: true,
          faceEnabled: true,
          fingerprintEnabled: false,
          pinEnabled: true,
        },
      })
    })

    it('defaults non-numeric fields to 0 and booleans to false', async () => {
      execFileMock.mockResolvedValue({
        stdout: JSON.stringify({
          minLength: null,
          maxAge: 'bad',
          minAge: undefined,
          history: null,
          complexity: null,
          lockoutThreshold: null,
          lockoutDuration: null,
          lockoutWindow: null,
          helloEnrolled: null,
          helloFace: null,
          helloFinger: null,
          helloPin: null,
        }),
        stderr: '',
      })

      const result = await security.collectPasswordPolicy()
      expect(result.minLength).toBe(0)
      expect(result.maxAgeDays).toBe(0)
      expect(result.complexityRequired).toBe(false)
      expect(result.windowsHello.enrolled).toBe(false)
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
