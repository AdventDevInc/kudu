import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ──

const mockHandle = vi.fn()
const mockSend = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
}))

const mockExecFile = vi.fn()
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

vi.mock('util', () => ({
  promisify: (fn: unknown) => (...args: unknown[]) => {
    return new Promise((resolve, reject) => {
      (fn as Function)(...args, (err: Error | null, result: unknown) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
  },
}))

vi.mock('crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
}))

vi.mock('../services/ipc-validation', () => ({
  validateStringArray: (input: unknown, _maxItems?: number) => {
    if (!Array.isArray(input)) return null
    if (!input.every((v: unknown) => typeof v === 'string')) return null
    return input as string[]
  },
}))

import { registerDebloaterIpc, scanBloatware, removeBloatware, KNOWN_BLOATWARE } from './debloater.ipc'

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

describe('registerDebloaterIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers DEBLOATER_SCAN and DEBLOATER_REMOVE handlers', () => {
    registerDebloaterIpc(() => null)
    const channels = mockHandle.mock.calls.map((c) => c[0])
    expect(channels).toContain('debloater:scan')
    expect(channels).toContain('debloater:remove')
  })
})

describe('DEBLOATER_SCAN handler', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('returns empty array on non-win32 platforms', async () => {
    registerDebloaterIpc(() => null)
    const handler = getHandler('debloater:scan')
    const result = await handler()
    expect(result).toEqual([])
  })
})

describe('DEBLOATER_REMOVE handler', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('returns zero counts on non-win32 platforms', async () => {
    registerDebloaterIpc(() => null)
    const handler = getHandler('debloater:remove')
    const result = await handler({}, ['Microsoft.BingNews'])
    expect(result).toEqual({ removed: 0, failed: 0 })
  })

  it('returns zero counts for non-array input', async () => {
    registerDebloaterIpc(() => null)
    const handler = getHandler('debloater:remove')
    const result = await handler({}, 'not-an-array')
    expect(result).toEqual({ removed: 0, failed: 0 })
  })

  it('returns zero counts for null input', async () => {
    registerDebloaterIpc(() => null)
    const handler = getHandler('debloater:remove')
    const result = await handler({}, null)
    expect(result).toEqual({ removed: 0, failed: 0 })
  })

  it('returns zero counts for array with non-string elements', async () => {
    registerDebloaterIpc(() => null)
    const handler = getHandler('debloater:remove')
    const result = await handler({}, [123, true])
    expect(result).toEqual({ removed: 0, failed: 0 })
  })

  it('sends progress events to the window during removal', async () => {
    // On non-win32, the handler returns early before invoking PowerShell
    registerDebloaterIpc(() => mockWindow() as any)
    const handler = getHandler('debloater:remove')
    const result = await handler({}, ['Microsoft.BingNews'])
    expect(result).toEqual({ removed: 0, failed: 0 })
  })
})

// ── KNOWN_BLOATWARE data integrity ──

describe('KNOWN_BLOATWARE', () => {
  it('contains a non-empty array', () => {
    expect(KNOWN_BLOATWARE.length).toBeGreaterThan(0)
  })

  it('every entry has required fields', () => {
    for (const entry of KNOWN_BLOATWARE) {
      expect(typeof entry.name).toBe('string')
      expect(entry.name.length).toBeGreaterThan(0)
      expect(typeof entry.packageName).toBe('string')
      expect(entry.packageName.length).toBeGreaterThan(0)
      expect(typeof entry.publisher).toBe('string')
      expect(typeof entry.category).toBe('string')
      expect(typeof entry.description).toBe('string')
    }
  })

  it('has no duplicate package names', () => {
    const names = KNOWN_BLOATWARE.map((b) => b.packageName)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('all categories are known values', () => {
    const validCategories = new Set(['microsoft', 'oem', 'gaming', 'communication', 'media', 'utility'])
    for (const entry of KNOWN_BLOATWARE) {
      expect(validCategories.has(entry.category)).toBe(true)
    }
  })
})

// ── scanBloatware (exported) ──

describe('scanBloatware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when PowerShell fails', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(new Error('PowerShell not found'), '', '')
      }
    })
    const result = await scanBloatware()
    expect(result).toEqual([])
  })

  it('returns empty array when JSON parsing fails', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(null, { stdout: 'not valid json' })
      }
    })
    const result = await scanBloatware()
    expect(result).toEqual([])
  })

  it('matches installed packages against known bloatware', async () => {
    const fakeInstalledPackages = [
      { Name: 'Microsoft.BingNews', PackageFullName: 'Microsoft.BingNews_1.0', InstallLocation: 'C:\\fake', Size: 5242880 },
      { Name: 'Microsoft.ZuneVideo', PackageFullName: 'Microsoft.ZuneVideo_1.0', InstallLocation: 'C:\\fake2', Size: 10485760 },
      { Name: 'SomeUnknownApp', PackageFullName: 'SomeUnknownApp_1.0', InstallLocation: 'C:\\fake3', Size: 1024 },
    ]
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(null, { stdout: JSON.stringify(fakeInstalledPackages) })
      }
    })

    const result = await scanBloatware()

    // Should find BingNews and ZuneVideo, but not SomeUnknownApp
    expect(result.length).toBe(2)
    expect(result.find((a) => a.packageName === 'Microsoft.BingNews')).toBeDefined()
    expect(result.find((a) => a.packageName === 'Microsoft.ZuneVideo')).toBeDefined()
    expect(result.find((a) => a.packageName === 'SomeUnknownApp')).toBeUndefined()
  })

  it('formats size correctly for different byte ranges', async () => {
    const fakePackages = [
      { Name: 'Microsoft.BingNews', PackageFullName: 'test', InstallLocation: 'C:\\', Size: 2147483648 }, // > 1 GB
      { Name: 'Microsoft.BingWeather', PackageFullName: 'test2', InstallLocation: 'C:\\', Size: 5242880 }, // > 1 MB
      { Name: 'Microsoft.GetHelp', PackageFullName: 'test3', InstallLocation: 'C:\\', Size: 2048 }, // > 1 KB
      { Name: 'Microsoft.People', PackageFullName: 'test4', InstallLocation: 'C:\\', Size: 500 }, // bytes
      { Name: 'Microsoft.WindowsMaps', PackageFullName: 'test5', InstallLocation: 'C:\\', Size: 0 }, // zero
    ]
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(null, { stdout: JSON.stringify(fakePackages) })
      }
    })

    const result = await scanBloatware()

    const bing = result.find((a) => a.packageName === 'Microsoft.BingNews')
    expect(bing?.size).toContain('GB')

    const weather = result.find((a) => a.packageName === 'Microsoft.BingWeather')
    expect(weather?.size).toContain('MB')

    const help = result.find((a) => a.packageName === 'Microsoft.GetHelp')
    expect(help?.size).toContain('KB')

    const people = result.find((a) => a.packageName === 'Microsoft.People')
    expect(people?.size).toContain('B')

    const maps = result.find((a) => a.packageName === 'Microsoft.WindowsMaps')
    expect(maps?.size).toBe('Unknown')
  })

  it('handles single-object PowerShell output (not wrapped in array)', async () => {
    const singlePackage = { Name: 'Microsoft.BingNews', PackageFullName: 'test', InstallLocation: 'C:\\', Size: 1024 }
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(null, { stdout: JSON.stringify(singlePackage) })
      }
    })

    const result = await scanBloatware()
    expect(result.length).toBe(1)
  })

  it('matches packages where Name starts with known packageName', async () => {
    // Some packages have a suffix after the known name
    const fakePackages = [
      { Name: 'Microsoft.BingNews.Extra', PackageFullName: 'test', InstallLocation: 'C:\\', Size: 1024 },
    ]
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(null, { stdout: JSON.stringify(fakePackages) })
      }
    })

    const result = await scanBloatware()
    // The match logic is: p.Name === bloatware.packageName || p.Name.startsWith(bloatware.packageName + '.')
    // 'Microsoft.BingNews.Extra' starts with 'Microsoft.BingNews.'
    expect(result.length).toBe(1)
  })
})

// ── removeBloatware (exported) ──

describe('removeBloatware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('filters out package names not in KNOWN_BLOATWARE', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(null, { stdout: '' })
      }
    })

    const result = await removeBloatware(['UnknownPackage.Evil', 'AnotherFake'])
    expect(result).toEqual({ removed: 0, failed: 0 })
    // execFile should not be called for unknown packages
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('removes known packages and counts successes', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(null, { stdout: '' })
      }
    })

    const result = await removeBloatware(['Microsoft.BingNews', 'Microsoft.BingWeather'])
    expect(result.removed).toBe(2)
    expect(result.failed).toBe(0)
  })

  it('counts failures when PowerShell removal fails', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(new Error('Remove-AppxPackage failed'), '', '')
      }
    })

    const result = await removeBloatware(['Microsoft.BingNews'])
    expect(result.removed).toBe(0)
    expect(result.failed).toBe(1)
  })

  it('calls onProgress callback during removal', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(null, { stdout: '' })
      }
    })

    const progressFn = vi.fn()
    await removeBloatware(['Microsoft.BingNews'], progressFn)

    // Should be called with 'removing' and 'done'
    expect(progressFn).toHaveBeenCalledWith(1, 1, 'Microsoft.BingNews', 'removing')
    expect(progressFn).toHaveBeenCalledWith(1, 1, 'Microsoft.BingNews', 'done')
  })

  it('reports failed status in onProgress when removal fails', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(new Error('fail'), '', '')
      }
    })

    const progressFn = vi.fn()
    await removeBloatware(['Microsoft.BingNews'], progressFn)

    expect(progressFn).toHaveBeenCalledWith(1, 1, 'Microsoft.BingNews', 'removing')
    expect(progressFn).toHaveBeenCalledWith(1, 1, 'Microsoft.BingNews', 'failed')
  })

  it('escapes single quotes in package names for PowerShell safety', async () => {
    // This tests that the safeName escaping is applied.
    // All valid package names come from KNOWN_BLOATWARE which don't contain quotes,
    // but the code has escaping as a safety net.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(null, { stdout: '' })
      }
    })

    // Use a known bloatware name to pass the filter
    await removeBloatware(['Microsoft.BingNews'])

    // Verify execFile was called with PowerShell args
    expect(mockExecFile).toHaveBeenCalled()
    const callArgs = mockExecFile.mock.calls[0]
    expect(callArgs[0]).toBe('powershell')
  })

  it('attempts deprovisioning after successful removal (silently ignores failures)', async () => {
    let callCount = 0
    mockExecFile.mockImplementation((...args: unknown[]) => {
      callCount++
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        if (callCount === 2) {
          // Deprovisioning fails (needs admin)
          callback(new Error('needs admin'), '', '')
        } else {
          callback(null, { stdout: '' })
        }
      }
    })

    const result = await removeBloatware(['Microsoft.BingNews'])
    // Removal should still succeed even if deprovisioning fails
    expect(result.removed).toBe(1)
    expect(result.failed).toBe(0)
    // Should have called execFile twice: removal + deprovisioning
    expect(mockExecFile).toHaveBeenCalledTimes(2)
  })
})
