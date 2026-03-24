import { describe, it, expect, vi } from 'vitest'

const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: execFileMock,
}))
vi.mock('util', () => ({
  promisify: (fn: any) => fn,
}))
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))
vi.mock('os', () => ({
  tmpdir: () => '/tmp',
  homedir: () => '/Users/TestUser',
}))
vi.mock('crypto', () => ({
  randomUUID: () => 'test-uuid',
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
