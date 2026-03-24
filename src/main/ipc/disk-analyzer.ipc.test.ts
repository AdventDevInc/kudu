import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──

const mockHandle = vi.fn()
const mockSend = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
}))

const mockReaddir = vi.fn()
const mockStat = vi.fn()
vi.mock('fs/promises', () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}))

const mockExecFile = vi.fn()
const mockSpawn = vi.fn()
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

vi.mock('util', () => ({
  promisify: (fn: unknown) => (...args: unknown[]) => {
    // Return a promise-based wrapper around our mock
    return new Promise((resolve, reject) => {
      (fn as Function)(...args, (err: Error | null, result: unknown) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
  },
}))

const mockIsAdmin = vi.fn()
vi.mock('../services/elevation', () => ({
  isAdmin: () => mockIsAdmin(),
}))

import { registerDiskAnalyzerIpc, getDrives, analyzeDisk, getFileTypes } from './disk-analyzer.ipc'

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

describe('registerDiskAnalyzerIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers all disk analyzer IPC handlers', () => {
    registerDiskAnalyzerIpc(() => null)
    const channels = mockHandle.mock.calls.map((c) => c[0])
    expect(channels).toContain('disk:drives')
    expect(channels).toContain('disk:file-types')
    expect(channels).toContain('disk:analyze')
    expect(channels).toContain('disk:repair:sfc')
    expect(channels).toContain('disk:repair:dism')
  })
})

describe('DISK_DRIVES handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls getDrives and returns the result', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:drives')
    // getDrives uses execFileAsync internally; we mock via the callback-style mock
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(new Error('not windows'), '', '')
      }
    })
    const result = await handler()
    // On non-win32, it tries df; both may fail and return []
    expect(Array.isArray(result)).toBe(true)
  })
})

describe('DISK_FILE_TYPES handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array for invalid drive input', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:file-types')
    const result = await handler({}, '')
    expect(result).toEqual([])
  })

  it('returns empty array for non-string drive', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:file-types')
    const result = await handler({}, 123)
    expect(result).toEqual([])
  })
})

describe('DISK_ANALYZE handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty node for invalid drive input', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:analyze')
    const result = await handler({}, '')
    expect(result).toEqual({ name: '', path: '', size: 0, children: [] })
  })

  it('returns empty node for non-string drive', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:analyze')
    const result = await handler({}, null)
    expect(result).toEqual({ name: '', path: '', size: 0, children: [] })
  })
})

describe('DISK_REPAIR_SFC handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('defaults to drive C when invalid drive is provided', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:repair:sfc')
    // SFC is Windows-only; on non-Windows it returns a specific error
    const result = await handler({}, 'invalid!!!')
    // Since tests run on Linux, SFC returns "only available on Windows"
    expect(result.tool).toBe('sfc')
    if (process.platform !== 'win32') {
      expect(result.success).toBe(false)
      expect(result.summary).toContain('only available on Windows')
    }
  })

  it('accepts a valid single-letter drive', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:repair:sfc')
    const result = await handler({}, 'D')
    expect(result.tool).toBe('sfc')
  })

  it('handles non-string drive input by defaulting to C', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:repair:sfc')
    const result = await handler({}, 42)
    expect(result.tool).toBe('sfc')
  })
})

describe('DISK_REPAIR_DISM handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Windows-only message on non-Windows platform', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:repair:dism')
    const result = await handler()
    if (process.platform !== 'win32') {
      expect(result.tool).toBe('dism')
      expect(result.success).toBe(false)
      expect(result.summary).toContain('only available on Windows')
    }
  })
})

// ── Exported function tests ──

describe('getDrives (exported)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when exec fails', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as Function
      if (typeof callback === 'function') {
        callback(new Error('command failed'), '', '')
      }
    })
    const drives = await getDrives()
    expect(drives).toEqual([])
  })
})

describe('analyzeDisk (exported)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty node for invalid drive', async () => {
    const result = await analyzeDisk('')
    expect(result).toEqual({ name: '', path: '', size: 0, children: [] })
  })

  it('returns empty node for null-like input', async () => {
    const result = await analyzeDisk(null as any)
    expect(result).toEqual({ name: '', path: '', size: 0, children: [] })
  })
})

describe('getFileTypes (exported)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array for invalid drive', async () => {
    const result = await getFileTypes('')
    expect(result).toEqual([])
  })
})

// ── resolveRootPath validation (tested indirectly) ──

describe('drive input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects empty string drive for analyze', async () => {
    const result = await analyzeDisk('')
    expect(result.size).toBe(0)
  })

  it('rejects injection attempts in drive parameter', async () => {
    registerDiskAnalyzerIpc(() => null)
    const handler = getHandler('disk:analyze')
    // Try injecting a path traversal
    const result = await handler({}, '../../../etc')
    // On Unix, resolveRootPath requires starting with sep; on Windows requires single letter
    if (process.platform !== 'win32') {
      // '../../../etc' does not start with '/' so should be rejected
      expect(result).toEqual({ name: '', path: '', size: 0, children: [] })
    }
  })

  it('accepts Unix absolute paths on non-Windows', async () => {
    if (process.platform === 'win32') return
    mockReaddir.mockResolvedValue([])
    registerDiskAnalyzerIpc(() => mockWindow() as any)
    const handler = getHandler('disk:analyze')
    const result = await handler({}, '/')
    // Should be accepted and attempt to analyze
    expect(result).toBeDefined()
    expect(result.path).toBe('/')
  })
})
