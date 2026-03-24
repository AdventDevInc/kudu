import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──

const mockHandle = vi.fn()
const mockSend = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
}))

const mockExistsSync = vi.fn()
vi.mock('fs', () => ({ existsSync: (...args: unknown[]) => mockExistsSync(...args) }))

const mockReaddir = vi.fn()
vi.mock('fs/promises', () => ({ readdir: (...args: unknown[]) => mockReaddir(...args) }))

const mockScanDirectory = vi.fn()
const mockCleanItems = vi.fn()
vi.mock('../services/file-utils', () => ({
  scanDirectory: (...args: unknown[]) => mockScanDirectory(...args),
  cleanItems: (...args: unknown[]) => mockCleanItems(...args),
}))

const mockCacheItems = vi.fn()
vi.mock('../services/scan-cache', () => ({
  cacheItems: (...args: unknown[]) => mockCacheItems(...args),
}))

const mockGetSettings = vi.fn()
vi.mock('../services/settings-store', () => ({
  getSettings: () => mockGetSettings(),
}))

const mockCloseBrowsers = vi.fn()
const mockBrowserPaths = vi.fn()
vi.mock('../platform', () => ({
  getPlatform: () => ({
    paths: { browserPaths: () => mockBrowserPaths() },
    browser: { closeBrowsers: () => mockCloseBrowsers() },
  }),
}))

vi.mock('../services/ipc-validation', () => ({
  validateStringArray: (input: unknown) => {
    if (!Array.isArray(input)) return null
    if (!input.every((v: unknown) => typeof v === 'string')) return null
    return input as string[]
  },
}))

import { join } from 'path'
import { registerBrowserCleanerIpc } from './browser-cleaner.ipc'

// ── Helpers ──

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as (...args: unknown[]) => unknown
}

function makeBrowserPaths() {
  return {
    chrome: { base: '/home/user/.config/google-chrome', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    edge: { base: '/home/user/.config/microsoft-edge', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    brave: { base: '/fake/brave', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    vivaldi: { base: '/fake/vivaldi', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    opera: { base: '/fake/opera', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    operaGX: { base: '/fake/operaGX', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    arc: { base: '/fake/arc', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    chromium: { base: '/fake/chromium', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    thorium: { base: '/fake/thorium', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    supermium: { base: '/fake/supermium', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    helium: { base: '/fake/helium', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    cromite: { base: '/fake/cromite', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    catsxp: { base: '/fake/catsxp', cache: 'Cache', codeCache: 'Code Cache', gpuCache: 'GPUCache', serviceWorker: 'Service Worker' },
    firefox: { cache: '/fake/firefox-cache' },
    librewolf: { cache: '' },
    waterfox: { cache: '' },
    floorp: { cache: '' },
    safari: null,
  }
}

function mockWindow() {
  return { isDestroyed: () => false, webContents: { send: mockSend } }
}

// ── Tests ──

describe('registerBrowserCleanerIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers BROWSER_SCAN and BROWSER_CLEAN handlers', () => {
    registerBrowserCleanerIpc(() => null)
    const channels = mockHandle.mock.calls.map((c) => c[0])
    expect(channels).toContain('cleaner:browser:scan')
    expect(channels).toContain('cleaner:browser:clean')
  })
})

describe('BROWSER_SCAN handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBrowserPaths.mockReturnValue(makeBrowserPaths())
  })

  it('returns empty results when no browser directories exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const win = mockWindow()
    registerBrowserCleanerIpc(() => win as any)
    const handler = getHandler('cleaner:browser:scan')
    const results = await handler()
    expect(results).toEqual([])
  })

  it('scans Chromium profile cache directories when they exist', async () => {
    const chromeBase = '/home/user/.config/google-chrome'
    // Only chrome base exists, and has Default profile
    mockExistsSync.mockImplementation((p: string) => {
      if (p === chromeBase) return true
      if (p.startsWith(join(chromeBase, 'Default'))) return true
      return false
    })
    mockReaddir.mockImplementation((p: string) => {
      if (p === chromeBase) {
        return Promise.resolve([
          { isDirectory: () => true, name: 'Profile 1' },
        ])
      }
      return Promise.resolve([])
    })
    mockScanDirectory.mockResolvedValue({
      category: 'browser',
      subcategory: 'test',
      items: [{ id: '1', path: '/test', size: 100 }],
      totalSize: 100,
      itemCount: 1,
    })

    const win = mockWindow()
    registerBrowserCleanerIpc(() => win as any)
    const handler = getHandler('cleaner:browser:scan')
    const results = await handler()

    expect(Array.isArray(results)).toBe(true)
    expect(mockScanDirectory).toHaveBeenCalled()
    expect(mockCacheItems).toHaveBeenCalled()
  })

  it('scans Opera-style browsers without profiles', async () => {
    const paths = makeBrowserPaths()
    // Only opera exists
    mockBrowserPaths.mockReturnValue(paths)
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/fake/opera') return true
      if (p === join('/fake/opera', 'Cache')) return true
      return false
    })
    mockScanDirectory.mockResolvedValue({
      category: 'browser',
      subcategory: 'Opera - Cache',
      items: [{ id: '1', path: '/test', size: 50 }],
      totalSize: 50,
      itemCount: 1,
    })
    mockReaddir.mockResolvedValue([])

    registerBrowserCleanerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:browser:scan')
    await handler()

    const scanCalls = mockScanDirectory.mock.calls
    const operaCall = scanCalls.find((c) => (c[2] as string).includes('Opera'))
    expect(operaCall).toBeDefined()
  })

  it('scans Firefox profile cache directories', async () => {
    mockBrowserPaths.mockReturnValue(makeBrowserPaths())
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/fake/firefox-cache') return true
      if (p.includes(join('cache2', 'entries'))) return true
      return false
    })
    mockReaddir.mockImplementation((p: string) => {
      if (p === '/fake/firefox-cache') {
        return Promise.resolve([{ isDirectory: () => true, name: 'abc123.default' }])
      }
      // For Chromium profile listing
      return Promise.resolve([])
    })
    mockScanDirectory.mockResolvedValue({
      category: 'browser',
      subcategory: 'Firefox - abc123.default Cache',
      items: [{ id: '1', path: '/test', size: 200 }],
      totalSize: 200,
      itemCount: 1,
    })

    registerBrowserCleanerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:browser:scan')
    const results = await handler()

    expect(results.length).toBeGreaterThan(0)
  })

  it('skips scan results with zero items', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReaddir.mockResolvedValue([])
    mockScanDirectory.mockResolvedValue({
      category: 'browser',
      subcategory: 'test',
      items: [],
      totalSize: 0,
      itemCount: 0,
    })

    registerBrowserCleanerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:browser:scan')
    const results = await handler()
    expect(results).toEqual([])
  })

  it('sends scan progress to the window', async () => {
    mockExistsSync.mockReturnValue(false)
    const win = mockWindow()
    registerBrowserCleanerIpc(() => win as any)
    const handler = getHandler('cleaner:browser:scan')
    await handler()

    expect(mockSend).toHaveBeenCalledWith('scan:progress', expect.objectContaining({
      phase: 'scanning',
      category: 'browser',
      progress: 100,
    }))
  })

  it('does not send progress when window is null', async () => {
    mockExistsSync.mockReturnValue(false)
    registerBrowserCleanerIpc(() => null)
    const handler = getHandler('cleaner:browser:scan')
    await handler()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('handles Firefox readdir errors gracefully', async () => {
    mockBrowserPaths.mockReturnValue(makeBrowserPaths())
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/fake/firefox-cache') return true
      return false
    })
    mockReaddir.mockRejectedValue(new Error('EACCES'))

    registerBrowserCleanerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:browser:scan')
    const results = await handler()
    // Should not throw, should return results (possibly empty)
    expect(Array.isArray(results)).toBe(true)
  })
})

describe('BROWSER_CLEAN handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBrowserPaths.mockReturnValue(makeBrowserPaths())
  })

  it('returns empty result for invalid input (non-array)', async () => {
    registerBrowserCleanerIpc(() => null)
    const handler = getHandler('cleaner:browser:clean')
    const result = await handler({}, 'not-an-array')
    expect(result).toEqual({
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [],
      needsElevation: false,
    })
  })

  it('returns empty result for array with non-string elements', async () => {
    registerBrowserCleanerIpc(() => null)
    const handler = getHandler('cleaner:browser:clean')
    const result = await handler({}, [123, null])
    expect(result).toEqual({
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [],
      needsElevation: false,
    })
  })

  it('calls cleanItems with valid string array', async () => {
    mockGetSettings.mockReturnValue({ cleaner: { closeBrowsersBeforeClean: false } })
    mockCleanItems.mockResolvedValue({
      totalCleaned: 500,
      filesDeleted: 5,
      filesSkipped: 0,
      errors: [],
      needsElevation: false,
    })

    registerBrowserCleanerIpc(() => null)
    const handler = getHandler('cleaner:browser:clean')
    const result = await handler({}, ['id-1', 'id-2'])

    expect(mockCleanItems).toHaveBeenCalledWith(['id-1', 'id-2'])
    expect(result).toEqual(expect.objectContaining({ totalCleaned: 500 }))
  })

  it('closes browsers before cleaning when setting is enabled', async () => {
    mockGetSettings.mockReturnValue({ cleaner: { closeBrowsersBeforeClean: true } })
    mockCloseBrowsers.mockResolvedValue(undefined)
    mockCleanItems.mockResolvedValue({
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [],
      needsElevation: false,
    })

    registerBrowserCleanerIpc(() => null)
    const handler = getHandler('cleaner:browser:clean')
    await handler({}, ['id-1'])

    expect(mockCloseBrowsers).toHaveBeenCalled()
  })

  it('does not close browsers when setting is disabled', async () => {
    mockGetSettings.mockReturnValue({ cleaner: { closeBrowsersBeforeClean: false } })
    mockCleanItems.mockResolvedValue({
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [],
      needsElevation: false,
    })

    registerBrowserCleanerIpc(() => null)
    const handler = getHandler('cleaner:browser:clean')
    await handler({}, ['id-1'])

    expect(mockCloseBrowsers).not.toHaveBeenCalled()
  })
})
