import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFile = vi.fn()
const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockMkdir = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}))
vi.mock('fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
}))

const { createLinuxPrivacy } = await import('./privacy')

describe('linux privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.XDG_CURRENT_DESKTOP
  })

  describe('getSettings', () => {
    it('returns sysctl and access control settings for unknown desktops', () => {
      process.env.XDG_CURRENT_DESKTOP = 'i3'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      // Should have sysctl kernel, network, and access control settings but no desktop settings
      expect(settings.length).toBeGreaterThan(0)

      // All settings should be from sysctl or access categories
      const categories = new Set(settings.map((s) => s.category))
      expect(categories.has('kernel') || categories.has('network') || categories.has('access')).toBe(true)
      expect(categories.has('telemetry')).toBe(false)
      expect(categories.has('services')).toBe(false)
    })

    it('includes GNOME settings for GNOME desktop', () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const ids = settings.map((s) => s.id)
      expect(ids).toContain('gnome-usage-stats')
      expect(ids).toContain('gnome-recent-files')
      expect(ids).toContain('gnome-location')
      expect(ids).toContain('gnome-crash-reporting')
      expect(ids).toContain('gnome-connectivity-check')
    })

    it('includes GNOME settings for Unity desktop', () => {
      process.env.XDG_CURRENT_DESKTOP = 'Unity'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const ids = settings.map((s) => s.id)
      expect(ids).toContain('gnome-usage-stats')
    })

    it('includes KDE settings for KDE desktop', () => {
      process.env.XDG_CURRENT_DESKTOP = 'KDE'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const ids = settings.map((s) => s.id)
      expect(ids).toContain('kde-usage-stats')
      expect(ids).toContain('kde-recent-files')
      expect(ids).toContain('kde-baloo')
      expect(ids).toContain('kde-crash-reporting')
    })

    it('includes KDE settings for Plasma desktop', () => {
      process.env.XDG_CURRENT_DESKTOP = 'plasma'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const ids = settings.map((s) => s.id)
      expect(ids).toContain('kde-usage-stats')
    })

    it('always includes sysctl kernel hardening settings', () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const ids = settings.map((s) => s.id)
      expect(ids).toContain('sysctl-aslr')
      expect(ids).toContain('sysctl-kptr-restrict')
      expect(ids).toContain('sysctl-dmesg-restrict')
      expect(ids).toContain('sysctl-ptrace-scope')
      expect(ids).toContain('sysctl-unprivileged-bpf')
    })

    it('always includes sysctl network hardening settings', () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const ids = settings.map((s) => s.id)
      expect(ids).toContain('sysctl-tcp-syncookies')
      expect(ids).toContain('sysctl-icmp-broadcast')
      expect(ids).toContain('sysctl-rp-filter')
      expect(ids).toContain('sysctl-accept-redirects')
      expect(ids).toContain('sysctl-source-route')
      expect(ids).toContain('sysctl-log-martians')
      expect(ids).toContain('sysctl-ipv6-redirects')
    })

    it('always includes access control settings', () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const ids = settings.map((s) => s.id)
      expect(ids).toContain('core-dump-disable')
      expect(ids).toContain('usb-storage-disable')
      expect(ids).toContain('ssh-root-login')
      expect(ids).toContain('ssh-password-auth')
    })

    it('marks sysctl and access settings as requiresAdmin', () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const sysctlSettings = settings.filter((s) => s.id.startsWith('sysctl-'))
      for (const s of sysctlSettings) {
        expect(s.requiresAdmin).toBe(true)
      }

      const accessSettings = settings.filter((s) => s.category === 'access')
      for (const s of accessSettings) {
        expect(s.requiresAdmin).toBe(true)
      }
    })

    it('marks GNOME desktop settings as not requiring admin (except connectivity check)', () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const gnomeUsageStats = settings.find((s) => s.id === 'gnome-usage-stats')
      expect(gnomeUsageStats!.requiresAdmin).toBe(false)

      const connectivityCheck = settings.find((s) => s.id === 'gnome-connectivity-check')
      expect(connectivityCheck!.requiresAdmin).toBe(true)
    })

    it('every setting has a non-empty id, label, and description', () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      for (const s of settings) {
        expect(s.id).toBeTruthy()
        expect(s.label).toBeTruthy()
        expect(s.description).toBeTruthy()
      }
    })

    it('every setting has check and apply functions', () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      for (const s of settings) {
        expect(typeof s.check).toBe('function')
        expect(typeof s.apply).toBe('function')
      }
    })

    it('has no duplicate setting ids', () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const ids = settings.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('is case-insensitive for desktop detection', () => {
      process.env.XDG_CURRENT_DESKTOP = 'gnome'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()

      const ids = settings.map((s) => s.id)
      expect(ids).toContain('gnome-usage-stats')
    })
  })

  describe('setting check/apply behavior', () => {
    it('gnome-usage-stats check returns true when gsettings says false', async () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const setting = settings.find((s) => s.id === 'gnome-usage-stats')!

      mockExecFile.mockResolvedValueOnce({ stdout: 'false', stderr: '' })
      const result = await setting.check()
      expect(result).toBe(true)
    })

    it('gnome-usage-stats check returns false when gsettings says true', async () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const setting = settings.find((s) => s.id === 'gnome-usage-stats')!

      mockExecFile.mockResolvedValueOnce({ stdout: 'true', stderr: '' })
      const result = await setting.check()
      expect(result).toBe(false)
    })

    it('gnome-usage-stats check returns false when gsettings fails', async () => {
      process.env.XDG_CURRENT_DESKTOP = 'GNOME'
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const setting = settings.find((s) => s.id === 'gnome-usage-stats')!

      mockExecFile.mockRejectedValueOnce(new Error('schema not found'))
      const result = await setting.check()
      expect(result).toBe(false)
    })

    it('sysctl setting check calls sysctl -n with the parameter', async () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const aslr = settings.find((s) => s.id === 'sysctl-aslr')!

      mockExecFile.mockResolvedValueOnce({ stdout: '2\n', stderr: '' })
      const result = await aslr.check()
      expect(result).toBe(true)
      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/sbin/sysctl', ['-n', 'kernel.randomize_va_space'],
        { timeout: 5_000 },
      )
    })

    it('sysctl setting check returns false on mismatch', async () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const aslr = settings.find((s) => s.id === 'sysctl-aslr')!

      mockExecFile.mockResolvedValueOnce({ stdout: '1\n', stderr: '' })
      const result = await aslr.check()
      expect(result).toBe(false)
    })

    it('core-dump-disable check verifies both sysctl and limits file', async () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const coreDump = settings.find((s) => s.id === 'core-dump-disable')!

      mockExecFile.mockResolvedValueOnce({ stdout: '0\n', stderr: '' })
      mockReadFile.mockResolvedValueOnce('* hard core 0\n')
      const result = await coreDump.check()
      expect(result).toBe(true)
    })

    it('core-dump-disable check returns false when sysctl value is wrong', async () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const coreDump = settings.find((s) => s.id === 'core-dump-disable')!

      mockExecFile.mockResolvedValueOnce({ stdout: '1\n', stderr: '' })
      const result = await coreDump.check()
      expect(result).toBe(false)
    })

    it('usb-storage-disable check reads the modprobe config file', async () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const usb = settings.find((s) => s.id === 'usb-storage-disable')!

      mockReadFile.mockResolvedValueOnce('# Kudu: block USB mass storage\ninstall usb-storage /bin/true\n')
      const result = await usb.check()
      expect(result).toBe(true)
    })

    it('usb-storage-disable check returns false when file is missing', async () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const usb = settings.find((s) => s.id === 'usb-storage-disable')!

      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
      const result = await usb.check()
      expect(result).toBe(false)
    })

    it('ssh-root-login check parses sshd_config for PermitRootLogin no', async () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const sshRoot = settings.find((s) => s.id === 'ssh-root-login')!

      mockReadFile.mockResolvedValueOnce('PermitRootLogin no\n')
      const result = await sshRoot.check()
      expect(result).toBe(true)
    })

    it('ssh-root-login check returns false when PermitRootLogin is yes', async () => {
      const privacy = createLinuxPrivacy()
      const settings = privacy.getSettings()
      const sshRoot = settings.find((s) => s.id === 'ssh-root-login')!

      mockReadFile.mockResolvedValueOnce('PermitRootLogin yes\n')
      const result = await sshRoot.check()
      expect(result).toBe(false)
    })
  })
})
