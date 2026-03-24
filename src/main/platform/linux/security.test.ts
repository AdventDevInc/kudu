import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFile = vi.fn()
const mockReadFile = vi.fn()
const mockStat = vi.fn()
const mockReaddir = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}))
vi.mock('fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
  stat: (...args: any[]) => mockStat(...args),
  readdir: (...args: any[]) => mockReaddir(...args),
}))

const { createLinuxSecurity } = await import('./security')

describe('linux security', () => {
  let security: ReturnType<typeof createLinuxSecurity>

  beforeEach(() => {
    vi.clearAllMocks()
    security = createLinuxSecurity()
  })

  describe('collectAntivirusStatus', () => {
    it('detects ClamAV when clamscan is available', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        // isServerMode call
        if (cmd === 'systemctl') return Promise.resolve({ stdout: 'graphical.target\n', stderr: '' })
        if (cmd === 'loginctl') return Promise.resolve({ stdout: '1 1000 user seat0 tty1\n', stderr: '' })
        if (cmd.includes('clamscan')) return Promise.resolve({ stdout: 'ClamAV 0.103.8/26900\n', stderr: '' })
        if (cmd.includes('getenforce')) return Promise.reject(new Error('not found'))
        if (cmd.includes('aa-status')) return Promise.reject(new Error('not found'))
        return Promise.reject(new Error('not found'))
      })

      const result = await security.collectAntivirusStatus()

      expect(result.primary).toBe('ClamAV')
      expect(result.products.length).toBeGreaterThanOrEqual(1)
      expect(result.products[0].enabled).toBe(true)
    })

    it('returns empty products when nothing is installed', async () => {
      mockExecFile.mockRejectedValue(new Error('not found'))

      const result = await security.collectAntivirusStatus()

      expect(result.products).toEqual([])
      expect(result.primary).toBeNull()
    })

    it('detects SELinux in Enforcing mode', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd.includes('clamscan')) return Promise.reject(new Error('not found'))
        if (cmd === '/usr/sbin/getenforce') return Promise.resolve({ stdout: 'Enforcing\n', stderr: '' })
        if (cmd.includes('aa-status')) return Promise.reject(new Error('not found'))
        return Promise.reject(new Error('not found'))
      })

      const result = await security.collectAntivirusStatus()

      const selinux = result.products.find((p) => p.name.includes('SELinux'))
      expect(selinux).toBeDefined()
      expect(selinux!.enabled).toBe(true)
      expect(selinux!.realTimeProtection).toBe(true)
    })

    it('detects SELinux in Permissive mode as not enabled', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd.includes('clamscan')) return Promise.reject(new Error('not found'))
        if (cmd === '/usr/sbin/getenforce') return Promise.resolve({ stdout: 'Permissive\n', stderr: '' })
        if (cmd.includes('aa-status')) return Promise.reject(new Error('not found'))
        return Promise.reject(new Error('not found'))
      })

      const result = await security.collectAntivirusStatus()

      const selinux = result.products.find((p) => p.name.includes('SELinux'))
      expect(selinux).toBeDefined()
      expect(selinux!.enabled).toBe(false)
    })

    it('detects AppArmor with enforcing profiles', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd.includes('clamscan')) return Promise.reject(new Error('not found'))
        if (cmd.includes('getenforce')) return Promise.reject(new Error('not found'))
        if (cmd === '/usr/sbin/aa-status') {
          return Promise.resolve({
            stdout: JSON.stringify({
              profiles: { '/usr/bin/foo': 'enforce', '/usr/bin/bar': 'enforce', '/usr/bin/baz': 'complain' },
            }),
            stderr: '',
          })
        }
        return Promise.reject(new Error('not found'))
      })

      const result = await security.collectAntivirusStatus()

      const apparmor = result.products.find((p) => p.name.includes('AppArmor'))
      expect(apparmor).toBeDefined()
      expect(apparmor!.name).toContain('2 profiles enforcing')
      expect(apparmor!.enabled).toBe(true)
    })
  })

  describe('collectFirewallStatus', () => {
    it('detects active UFW', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === '/usr/sbin/ufw') return Promise.resolve({ stdout: 'Status: active\n\nTo    Action From\n22    ALLOW  Anywhere\n', stderr: '' })
        return Promise.reject(new Error('not found'))
      })

      const result = await security.collectFirewallStatus()

      expect(result.enabled).toBe(true)
      expect(result.products[0].name).toBe('UFW')
    })

    it('detects active firewalld', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === '/usr/sbin/ufw') return Promise.reject(new Error('not found'))
        if (cmd === '/usr/bin/firewall-cmd') return Promise.resolve({ stdout: 'running\n', stderr: '' })
        return Promise.reject(new Error('not found'))
      })

      const result = await security.collectFirewallStatus()

      expect(result.enabled).toBe(true)
      expect(result.products[0].name).toBe('firewalld')
    })

    it('detects active nftables', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === '/usr/sbin/ufw') return Promise.reject(new Error('not found'))
        if (cmd === '/usr/bin/firewall-cmd') return Promise.reject(new Error('not found'))
        if (cmd === '/usr/sbin/nft') return Promise.resolve({ stdout: 'table inet filter {\n}\n', stderr: '' })
        return Promise.reject(new Error('not found'))
      })

      const result = await security.collectFirewallStatus()

      expect(result.enabled).toBe(true)
      expect(result.products[0].name).toBe('nftables')
    })

    it('falls back to iptables', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === '/usr/sbin/ufw') return Promise.reject(new Error('not found'))
        if (cmd === '/usr/bin/firewall-cmd') return Promise.reject(new Error('not found'))
        if (cmd === '/usr/sbin/nft') return Promise.reject(new Error('not found'))
        if (cmd === '/usr/sbin/iptables') {
          return Promise.resolve({
            stdout: 'Chain INPUT (policy ACCEPT)\ntarget     prot opt source               destination\nACCEPT     tcp  --  0.0.0.0/0            0.0.0.0/0            tcp dpt:22\n',
            stderr: '',
          })
        }
        return Promise.reject(new Error('not found'))
      })

      const result = await security.collectFirewallStatus()

      expect(result.enabled).toBe(true)
      expect(result.products[0].name).toBe('iptables')
    })

    it('returns disabled when no firewall is found', async () => {
      mockExecFile.mockRejectedValue(new Error('not found'))

      const result = await security.collectFirewallStatus()

      expect(result.enabled).toBe(false)
    })
  })

  describe('collectDiskEncryptionStatus', () => {
    it('detects LUKS encrypted volumes', async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({
          blockdevices: [
            {
              name: 'sda1',
              type: 'part',
              fstype: 'crypto_LUKS',
              mountpoint: null,
              children: [
                { name: 'dm-0', type: 'crypt', fstype: 'ext4', mountpoint: '/' },
              ],
            },
          ],
        }),
        stderr: '',
      })

      const result = await security.collectDiskEncryptionStatus()

      expect(result.volumes.length).toBeGreaterThanOrEqual(1)
      expect(result.volumes.some((v) => v.status === 'FullyEncrypted')).toBe(true)
    })

    it('returns empty volumes when lsblk fails', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('not found'))

      const result = await security.collectDiskEncryptionStatus()

      expect(result.volumes).toEqual([])
    })

    it('returns empty volumes when no encryption is detected', async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({
          blockdevices: [
            { name: 'sda1', type: 'part', fstype: 'ext4', mountpoint: '/' },
          ],
        }),
        stderr: '',
      })

      const result = await security.collectDiskEncryptionStatus()

      expect(result.volumes).toEqual([])
    })
  })

  describe('collectPasswordPolicy', () => {
    it('parses /etc/login.defs for password policies', async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path === '/etc/login.defs') {
          return Promise.resolve(
            'PASS_MIN_LEN 8\nPASS_MAX_DAYS 90\nPASS_MIN_DAYS 1\n',
          )
        }
        return Promise.reject(new Error('ENOENT'))
      })

      const result = await security.collectPasswordPolicy()

      expect(result.minLength).toBe(8)
      expect(result.maxAgeDays).toBe(90)
      expect(result.minAgeDays).toBe(1)
    })

    it('parses pwquality.conf for complexity rules', async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path === '/etc/login.defs') return Promise.resolve('PASS_MIN_LEN 6\n')
        if (path === '/etc/security/pwquality.conf') {
          return Promise.resolve('minlen = 12\ndcredit = -1\nucredit = -1\nlcredit = 0\nocredit = 0\n')
        }
        return Promise.reject(new Error('ENOENT'))
      })

      const result = await security.collectPasswordPolicy()

      expect(result.minLength).toBe(12) // pwquality overrides login.defs
      expect(result.complexityRequired).toBe(true)
    })

    it('parses faillock.conf for lockout settings', async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path === '/etc/login.defs') return Promise.resolve('')
        if (path === '/etc/security/pwquality.conf') return Promise.reject(new Error('ENOENT'))
        if (path === '/etc/security/faillock.conf') {
          return Promise.resolve('deny = 5\nunlock_time = 600\n')
        }
        return Promise.reject(new Error('ENOENT'))
      })

      const result = await security.collectPasswordPolicy()

      expect(result.lockoutThreshold).toBe(5)
      expect(result.lockoutDurationMin).toBe(10)
    })

    it('returns defaults when all config files are missing', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'))

      const result = await security.collectPasswordPolicy()

      expect(result.minLength).toBe(0)
      expect(result.maxAgeDays).toBe(0)
      expect(result.complexityRequired).toBe(false)
      expect(result.lockoutThreshold).toBe(0)
    })
  })

  describe('collectSshHardening', () => {
    it('returns sshdInstalled: false when sshd binary is not found', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === 'systemctl') return Promise.resolve({ stdout: 'graphical.target\n', stderr: '' })
        if (cmd === 'loginctl') {
          return Promise.resolve({ stdout: '1 1000 user seat0 tty1\n', stderr: '' })
        }
        return Promise.reject(new Error('not found'))
      })
      mockStat.mockRejectedValue(new Error('ENOENT'))

      const result = await security.collectSshHardening()

      expect(result.sshdInstalled).toBe(false)
    })

    it('parses sshd_config for hardening directives', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === 'systemctl') return Promise.resolve({ stdout: 'graphical.target\n', stderr: '' })
        if (cmd === 'loginctl') {
          return Promise.resolve({ stdout: '1 1000 user seat0 tty1\n', stderr: '' })
        }
        return Promise.reject(new Error('not found'))
      })
      mockStat.mockResolvedValueOnce({}) // /usr/sbin/sshd exists
      mockReadFile.mockResolvedValueOnce(
        'PermitRootLogin no\nPasswordAuthentication no\nPubkeyAuthentication yes\nPermitEmptyPasswords no\n',
      )
      mockReaddir.mockRejectedValueOnce(new Error('ENOENT')) // no drop-in directory

      const result = await security.collectSshHardening()

      expect(result.sshdInstalled).toBe(true)
      expect(result.passwordAuthDisabled).toBe(true)
      expect(result.rootLoginDisabled).toBe(true)
      expect(result.pubkeyAuthEnabled).toBe(true)
      expect(result.emptyPasswordsDisabled).toBe(true)
    })

    it('detects PermitRootLogin prohibit-password as rootLoginDisabled', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === 'systemctl') return Promise.resolve({ stdout: 'graphical.target\n', stderr: '' })
        if (cmd === 'loginctl') {
          return Promise.resolve({ stdout: '1 1000 user seat0 tty1\n', stderr: '' })
        }
        return Promise.reject(new Error('not found'))
      })
      mockStat.mockResolvedValueOnce({})
      mockReadFile.mockResolvedValueOnce('PermitRootLogin prohibit-password\n')
      mockReaddir.mockRejectedValueOnce(new Error('ENOENT'))

      const result = await security.collectSshHardening()

      expect(result.rootLoginDisabled).toBe(true)
    })

    it('stops parsing at Match blocks', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === 'systemctl') return Promise.resolve({ stdout: 'graphical.target\n', stderr: '' })
        if (cmd === 'loginctl') {
          return Promise.resolve({ stdout: '1 1000 user seat0 tty1\n', stderr: '' })
        }
        return Promise.reject(new Error('not found'))
      })
      mockStat.mockResolvedValueOnce({})
      mockReadFile.mockResolvedValueOnce(
        'PasswordAuthentication no\nMatch User admin\nPasswordAuthentication yes\n',
      )
      mockReaddir.mockRejectedValueOnce(new Error('ENOENT'))

      const result = await security.collectSshHardening()

      // Should use the global value, not the one in the Match block
      expect(result.passwordAuthDisabled).toBe(true)
    })
  })

  describe('collectScreenLockStatus', () => {
    it('returns GNOME screen lock settings', async () => {
      mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
        if (args?.includes('lock-enabled')) {
          return Promise.resolve({ stdout: 'true\n', stderr: '' })
        }
        if (args?.includes('idle-delay')) {
          return Promise.resolve({ stdout: 'uint32 300\n', stderr: '' })
        }
        return Promise.reject(new Error('not found'))
      })

      const result = await security.collectScreenLockStatus()

      expect(result.lockOnResume).toBe(true)
      expect(result.screenSaverEnabled).toBe(true)
      expect(result.timeoutSec).toBe(300)
    })

    it('returns defaults when gsettings fails', async () => {
      mockExecFile.mockRejectedValue(new Error('not found'))

      const result = await security.collectScreenLockStatus()

      expect(result.lockOnResume).toBe(false)
      expect(result.screenSaverEnabled).toBe(false)
      expect(result.timeoutSec).toBeNull()
    })
  })

  describe('isServer', () => {
    it('detects multi-user.target as server mode', async () => {
      mockExecFile.mockImplementation((cmd: string) => {
        if (cmd === 'systemctl') return Promise.resolve({ stdout: 'multi-user.target\n', stderr: '' })
        return Promise.reject(new Error('not found'))
      })

      const result = await security.isServer()

      expect(result).toBe(true)
    })
  })
})
