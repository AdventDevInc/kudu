import { describe, it, expect, vi } from 'vitest'

const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: execFileMock
}))
vi.mock('util', () => ({
  promisify: (fn: any) => fn
}))
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn()
}))
vi.mock('os', () => ({
  tmpdir: () => '/tmp',
  homedir: () => '/Users/TestUser'
}))
vi.mock('crypto', () => ({
  randomUUID: () => 'test-uuid'
}))

const { createDarwinPrivacy } = await import('./privacy')

describe('darwin privacy', () => {
  const privacy = createDarwinPrivacy()

  describe('getSettings', () => {
    const settings = privacy.getSettings()

    it('returns a non-empty array of settings', () => {
      expect(settings.length).toBeGreaterThan(10)
    })

    it('every setting has required fields', () => {
      for (const setting of settings) {
        expect(setting.id).toBeTruthy()
        expect(setting.category).toBeTruthy()
        expect(setting.label).toBeTruthy()
        expect(setting.description).toBeTruthy()
        expect(typeof setting.requiresAdmin).toBe('boolean')
        expect(typeof setting.check).toBe('function')
        expect(typeof setting.apply).toBe('function')
      }
    })

    it('every setting has a unique id', () => {
      const ids = settings.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('all ids start with macos-', () => {
      for (const setting of settings) {
        expect(setting.id.startsWith('macos-')).toBe(true)
      }
    })

    it('includes telemetry settings', () => {
      const telemetry = settings.filter((s) => s.category === 'telemetry')
      expect(telemetry.length).toBeGreaterThan(0)
      const ids = telemetry.map((s) => s.id)
      expect(ids).toContain('macos-diagnostics')
      expect(ids).toContain('macos-siri-analytics')
      expect(ids).toContain('macos-crash-reporter')
    })

    it('includes ads settings', () => {
      const ads = settings.filter((s) => s.category === 'ads')
      expect(ads.length).toBeGreaterThan(0)
      expect(ads.some((s) => s.id === 'macos-ad-tracking')).toBe(true)
    })

    it('includes search settings', () => {
      const search = settings.filter((s) => s.category === 'search')
      expect(search.length).toBeGreaterThan(0)
      expect(search.some((s) => s.id === 'macos-safari-suggestions')).toBe(true)
      expect(search.some((s) => s.id === 'macos-spotlight-suggestions')).toBe(true)
    })

    it('includes sync settings', () => {
      const sync = settings.filter((s) => s.category === 'sync')
      expect(sync.length).toBeGreaterThan(0)
      expect(sync.some((s) => s.id === 'macos-handoff')).toBe(true)
    })

    it('includes AI settings', () => {
      const ai = settings.filter((s) => s.category === 'ai')
      expect(ai.length).toBeGreaterThan(0)
      expect(ai.some((s) => s.id === 'macos-siri-enabled')).toBe(true)
      expect(ai.some((s) => s.id === 'macos-apple-intelligence')).toBe(true)
    })

    it('includes browser settings', () => {
      const browser = settings.filter((s) => s.category === 'browser')
      expect(browser.length).toBeGreaterThan(0)
      expect(browser.some((s) => s.id === 'macos-safari-dnt')).toBe(true)
      expect(browser.some((s) => s.id === 'macos-chrome-metrics')).toBe(true)
      expect(browser.some((s) => s.id === 'macos-firefox-telemetry')).toBe(true)
    })

    it('includes kernel hardening settings', () => {
      const kernel = settings.filter((s) => s.category === 'kernel')
      expect(kernel.length).toBeGreaterThan(0)
      expect(kernel.some((s) => s.id === 'macos-gatekeeper')).toBe(true)
      expect(kernel.some((s) => s.id === 'macos-guest-account')).toBe(true)
    })

    it('includes network settings', () => {
      const network = settings.filter((s) => s.category === 'network')
      expect(network.length).toBeGreaterThan(0)
      expect(network.some((s) => s.id === 'macos-firewall')).toBe(true)
      expect(network.some((s) => s.id === 'macos-stealth-mode')).toBe(true)
    })

    it('includes access control settings', () => {
      const access = settings.filter((s) => s.category === 'access')
      expect(access.length).toBeGreaterThan(0)
      expect(access.some((s) => s.id === 'macos-remote-login')).toBe(true)
      expect(access.some((s) => s.id === 'macos-ssh-root-login')).toBe(true)
    })

    it('marks admin-requiring settings correctly', () => {
      const diagnostics = settings.find((s) => s.id === 'macos-diagnostics')
      expect(diagnostics!.requiresAdmin).toBe(true)

      const adTracking = settings.find((s) => s.id === 'macos-ad-tracking')
      expect(adTracking!.requiresAdmin).toBe(false)
    })

    it('stealth mode depends on firewall', () => {
      const stealth = settings.find((s) => s.id === 'macos-stealth-mode')
      expect(stealth!.dependsOn).toBe('macos-firewall')
    })

    it('covers all expected categories', () => {
      const categories = new Set(settings.map((s) => s.category))
      expect(categories).toContain('telemetry')
      expect(categories).toContain('ads')
      expect(categories).toContain('search')
      expect(categories).toContain('sync')
      expect(categories).toContain('ai')
      expect(categories).toContain('browser')
      expect(categories).toContain('kernel')
      expect(categories).toContain('network')
      expect(categories).toContain('access')
      expect(categories).toContain('services')
    })
  })
})

// Regression tests for #443: checks must not rely on root-only tools, or a
// successful elevated apply is immediately reported back as "unprotected".
describe('darwin privacy checks run unprivileged', () => {
  const settings = createDarwinPrivacy().getSettings()
  const find = (id: string) => settings.find((s) => s.id === id)!

  function mockExec(handler: (cmd: string, args: string[]) => { stdout: string } | Error) {
    execFileMock.mockReset()
    execFileMock.mockImplementation(async (cmd: string, args: string[]) => {
      const result = handler(cmd, args)
      if (result instanceof Error) throw result
      return result
    })
  }

  const calledCommands = () => execFileMock.mock.calls.map((c) => c[0] as string)

  describe('macos-remote-login', () => {
    it('reads launchd override table instead of systemsetup', async () => {
      mockExec((cmd, args) => {
        if (cmd === '/bin/launchctl' && args[0] === 'print-disabled') {
          return { stdout: 'disabled services = {\n\t"com.openssh.sshd" => disabled\n}\n' }
        }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-remote-login').check()).toBe(true)
      expect(calledCommands()).not.toContain('/usr/sbin/systemsetup')
    })

    it('reports unprotected when sshd is enabled', async () => {
      mockExec((cmd, args) => {
        if (cmd === '/bin/launchctl' && args[0] === 'print-disabled') {
          return { stdout: '"com.openssh.sshd" => enabled' }
        }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-remote-login').check()).toBe(false)
    })

    it('understands the older true/false override format', async () => {
      mockExec((cmd) => {
        if (cmd === '/bin/launchctl') return { stdout: '"com.openssh.sshd" => false' }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-remote-login').check()).toBe(false)
    })

    it('falls back to probing port 22 when launchctl gives no answer', async () => {
      mockExec((cmd, args) => {
        if (cmd === '/bin/launchctl') return { stdout: 'disabled services = {\n}\n' }
        if (cmd === '/usr/bin/nc') {
          expect(args).toContain('22')
          return new Error('connection refused')
        }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-remote-login').check()).toBe(true)
    })

    it('apply disables sshd via launchctl as well as systemsetup', async () => {
      mockExec(() => ({ stdout: '' }))
      await find('macos-remote-login').apply()
      const script = execFileMock.mock.calls[0][1].join(' ')
      expect(script).toContain('systemsetup -f -setremotelogin off')
      expect(script).toContain('launchctl disable system/com.openssh.sshd')
      expect(script).toContain('launchctl bootout system/com.openssh.sshd')
    })
  })

  describe('macos-wake-on-network', () => {
    it('reads pmset instead of systemsetup', async () => {
      mockExec((cmd) => {
        if (cmd === '/usr/bin/pmset')
          return { stdout: ' womp                 0\n sleep                1\n' }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-wake-on-network').check()).toBe(true)
      mockExec((cmd) => {
        if (cmd === '/usr/bin/pmset') return { stdout: ' womp                 1\n' }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-wake-on-network').check()).toBe(false)
    })
  })

  describe('managed browser preferences', () => {
    const chromeInstalled = (cmd: string) =>
      cmd === '/usr/bin/mdfind' ? { stdout: '/Applications/Google Chrome.app\n' } : null

    it('reads the plist directly via plutil (bypasses cfprefsd cache)', async () => {
      mockExec((cmd, args) => {
        const found = chromeInstalled(cmd)
        if (found) return found
        if (cmd === '/usr/bin/plutil') {
          expect(args).toEqual([
            '-extract',
            'MetricsReportingEnabled',
            'raw',
            '-o',
            '-',
            '/Library/Managed Preferences/com.google.Chrome.plist'
          ])
          return { stdout: 'false\n' }
        }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-chrome-metrics').check()).toBe(true)
      expect(calledCommands()).not.toContain('/usr/bin/defaults')
    })

    it('falls back to defaults read when plutil fails', async () => {
      mockExec((cmd) => {
        const found = chromeInstalled(cmd)
        if (found) return found
        if (cmd === '/usr/bin/plutil') return new Error('no such file')
        if (cmd === '/usr/bin/defaults') return { stdout: '0\n' }
        return new Error(`unexpected ${cmd}`)
      })
      expect(await find('macos-chrome-metrics').check()).toBe(true)
    })

    it('reports unprotected when the policy is absent or unreadable', async () => {
      mockExec((cmd) => chromeInstalled(cmd) ?? new Error('permission denied'))
      expect(await find('macos-chrome-metrics').check()).toBe(false)
    })

    it('chmods the managed prefs plist so the user-level check can read it back', async () => {
      mockExec(() => ({ stdout: '' }))
      await find('macos-chrome-metrics').apply()
      const script = execFileMock.mock.calls[0][1].join(' ')
      expect(script).toContain("'write' '/Library/Managed Preferences/com.google.Chrome'")
      expect(script).toContain(
        "'/bin/chmod' '644' '/Library/Managed Preferences/com.google.Chrome.plist'"
      )
    })
  })
})
