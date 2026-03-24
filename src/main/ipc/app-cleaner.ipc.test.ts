import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──

const mockHandle = vi.fn()
const mockSend = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
}))

const mockScanMultipleDirectories = vi.fn()
const mockResolveChildSubdirs = vi.fn()
const mockCleanItems = vi.fn()
vi.mock('../services/file-utils', () => ({
  scanMultipleDirectories: (...args: unknown[]) => mockScanMultipleDirectories(...args),
  resolveChildSubdirs: (...args: unknown[]) => mockResolveChildSubdirs(...args),
  cleanItems: (...args: unknown[]) => mockCleanItems(...args),
}))

const mockCacheItems = vi.fn()
vi.mock('../services/scan-cache', () => ({
  cacheItems: (...args: unknown[]) => mockCacheItems(...args),
}))

const mockAppPaths = vi.fn()
vi.mock('../platform', () => ({
  getPlatform: () => ({
    paths: { appPaths: () => mockAppPaths() },
  }),
}))

vi.mock('../services/ipc-validation', () => ({
  validateStringArray: (input: unknown) => {
    if (!Array.isArray(input)) return null
    if (!input.every((v: unknown) => typeof v === 'string')) return null
    return input as string[]
  },
}))

import { registerAppCleanerIpc } from './app-cleaner.ipc'

// ── Helpers ──

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as (...args: unknown[]) => unknown
}

function mockWindow() {
  return { isDestroyed: () => false, webContents: { send: mockSend } }
}

// ── Tests ──

describe('registerAppCleanerIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers APP_SCAN and APP_CLEAN handlers', () => {
    registerAppCleanerIpc(() => null)
    const channels = mockHandle.mock.calls.map((c) => c[0])
    expect(channels).toContain('cleaner:app:scan')
    expect(channels).toContain('cleaner:app:clean')
  })
})

describe('APP_SCAN handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty results when no apps are defined', async () => {
    mockAppPaths.mockReturnValue([])
    registerAppCleanerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:app:scan')
    const results = await handler()
    expect(results).toEqual([])
  })

  it('scans each app and caches items with results', async () => {
    mockAppPaths.mockReturnValue([
      { name: 'VS Code', paths: ['/home/user/.vscode/cache'], childSubdir: undefined },
      { name: 'Slack', paths: ['/home/user/.config/Slack/Cache'], childSubdir: undefined },
    ])
    mockResolveChildSubdirs.mockImplementation((paths: string[]) => Promise.resolve(paths))
    mockScanMultipleDirectories.mockImplementation((_paths: string[], _cat: string, name: string) => {
      return Promise.resolve({
        category: 'app',
        subcategory: name,
        items: [{ id: '1', path: '/test', size: 100 }],
        totalSize: 100,
        itemCount: 1,
      })
    })

    registerAppCleanerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:app:scan')
    const results = await handler()

    expect(results).toHaveLength(2)
    expect(mockCacheItems).toHaveBeenCalledTimes(2)
    expect(mockResolveChildSubdirs).toHaveBeenCalledTimes(2)
  })

  it('skips apps with zero scan items', async () => {
    mockAppPaths.mockReturnValue([
      { name: 'EmptyApp', paths: ['/empty'], childSubdir: undefined },
    ])
    mockResolveChildSubdirs.mockResolvedValue(['/empty'])
    mockScanMultipleDirectories.mockResolvedValue({
      category: 'app',
      subcategory: 'EmptyApp',
      items: [],
      totalSize: 0,
      itemCount: 0,
    })

    registerAppCleanerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:app:scan')
    const results = await handler()

    expect(results).toEqual([])
    expect(mockCacheItems).not.toHaveBeenCalled()
  })

  it('skips apps that throw errors during scan', async () => {
    mockAppPaths.mockReturnValue([
      { name: 'FailApp', paths: ['/fail'], childSubdir: undefined },
      { name: 'GoodApp', paths: ['/good'], childSubdir: undefined },
    ])
    mockResolveChildSubdirs.mockImplementation((paths: string[]) => {
      if (paths[0] === '/fail') return Promise.reject(new Error('EACCES'))
      return Promise.resolve(paths)
    })
    mockScanMultipleDirectories.mockResolvedValue({
      category: 'app',
      subcategory: 'GoodApp',
      items: [{ id: '1', path: '/test', size: 100 }],
      totalSize: 100,
      itemCount: 1,
    })

    registerAppCleanerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:app:scan')
    const results = await handler()

    // Should skip FailApp but include GoodApp
    expect(results).toHaveLength(1)
    expect(results[0].subcategory).toBe('GoodApp')
  })

  it('sends scan progress to the window', async () => {
    mockAppPaths.mockReturnValue([])
    const win = mockWindow()
    registerAppCleanerIpc(() => win as any)
    const handler = getHandler('cleaner:app:scan')
    await handler()

    expect(mockSend).toHaveBeenCalledWith('scan:progress', expect.objectContaining({
      phase: 'scanning',
      category: 'app',
      currentPath: 'App scan complete',
      progress: 100,
    }))
  })

  it('does not send progress when window is null', async () => {
    mockAppPaths.mockReturnValue([])
    registerAppCleanerIpc(() => null)
    const handler = getHandler('cleaner:app:scan')
    await handler()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('does not send progress when window is destroyed', async () => {
    mockAppPaths.mockReturnValue([])
    const win = { isDestroyed: () => true, webContents: { send: mockSend } }
    registerAppCleanerIpc(() => win as any)
    const handler = getHandler('cleaner:app:scan')
    await handler()
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('APP_CLEAN handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty result for non-array input', async () => {
    registerAppCleanerIpc(() => null)
    const handler = getHandler('cleaner:app:clean')
    const result = await handler({}, 'not-array')
    expect(result).toEqual({
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [],
      needsElevation: false,
    })
  })

  it('returns empty result for null input', async () => {
    registerAppCleanerIpc(() => null)
    const handler = getHandler('cleaner:app:clean')
    const result = await handler({}, null)
    expect(result).toEqual({
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [],
      needsElevation: false,
    })
  })

  it('returns empty result for array with non-string elements', async () => {
    registerAppCleanerIpc(() => null)
    const handler = getHandler('cleaner:app:clean')
    const result = await handler({}, [42, true])
    expect(result).toEqual({
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [],
      needsElevation: false,
    })
  })

  it('calls cleanItems with valid string IDs', async () => {
    mockCleanItems.mockResolvedValue({
      totalCleaned: 1024,
      filesDeleted: 10,
      filesSkipped: 1,
      errors: [],
      needsElevation: false,
    })

    registerAppCleanerIpc(() => null)
    const handler = getHandler('cleaner:app:clean')
    const result = await handler({}, ['uuid-1', 'uuid-2', 'uuid-3'])

    expect(mockCleanItems).toHaveBeenCalledWith(['uuid-1', 'uuid-2', 'uuid-3'], expect.any(Function))
    expect(result).toEqual(expect.objectContaining({
      totalCleaned: 1024,
      filesDeleted: 10,
    }))
  })
})
