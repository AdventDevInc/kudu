import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks (available inside vi.mock factories) ──

const {
  mockHandle, mockSend,
  mockExistsSync, mockStatSync, mockOpenSync, mockReadSync, mockCloseSync, mockReaddirSync,
  mockCacheItems, mockGetCachedItem,
  mockDbExec, mockDbPragma, mockDbClose, mockDatabaseConstructor,
  mockDatabaseTargets,
} = vi.hoisted(() => ({
  mockHandle: vi.fn(),
  mockSend: vi.fn(),
  mockExistsSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockOpenSync: vi.fn(),
  mockReadSync: vi.fn(),
  mockCloseSync: vi.fn(),
  mockReaddirSync: vi.fn(),
  mockCacheItems: vi.fn(),
  mockGetCachedItem: vi.fn(),
  mockDbExec: vi.fn(),
  mockDbPragma: vi.fn(),
  mockDbClose: vi.fn(),
  mockDatabaseConstructor: vi.fn(),
  mockDatabaseTargets: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
}))

vi.mock('fs', () => {
  const methods = {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
    openSync: (...args: unknown[]) => mockOpenSync(...args),
    readSync: (...args: unknown[]) => mockReadSync(...args),
    closeSync: (...args: unknown[]) => mockCloseSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  }
  return { ...methods, default: methods }
})

vi.mock('../services/scan-cache', () => ({
  cacheItems: (...args: unknown[]) => mockCacheItems(...args),
  getCachedItem: (...args: unknown[]) => mockGetCachedItem(...args),
}))

vi.mock('better-sqlite3', () => {
  // Use a real function (not arrow) so it works with `new`
  const DatabaseMock = function (this: any, ...args: unknown[]) {
    const result = mockDatabaseConstructor(...args)
    if (result instanceof Error) throw result
    return {
      exec: (...a: unknown[]) => mockDbExec(...a),
      pragma: (...a: unknown[]) => mockDbPragma(...a),
      close: () => mockDbClose(),
    }
  } as any
  return { default: DatabaseMock }
})

vi.mock('../platform', () => ({
  getPlatform: () => ({
    paths: { databaseOptimizeTargets: () => mockDatabaseTargets() },
  }),
}))

vi.mock('../services/ipc-validation', () => ({
  validateStringArray: (input: unknown) => {
    if (!Array.isArray(input)) return null
    if (!input.every((v: unknown) => typeof v === 'string')) return null
    return input as string[]
  },
}))

import { registerDatabaseOptimizerIpc } from './database-optimizer.ipc'

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

describe('registerDatabaseOptimizerIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers DATABASE_SCAN and DATABASE_CLEAN handlers', () => {
    registerDatabaseOptimizerIpc(() => null)
    const channels = mockHandle.mock.calls.map((c) => c[0])
    expect(channels).toContain('cleaner:database:scan')
    expect(channels).toContain('cleaner:database:clean')
  })
})

describe('DATABASE_SCAN handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty results when no targets are defined', async () => {
    mockDatabaseTargets.mockReturnValue([])
    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:scan')
    const results = await handler()
    expect(results).toEqual([])
  })

  it('skips targets whose basePath does not exist', async () => {
    mockDatabaseTargets.mockReturnValue([
      { basePath: '/nonexistent', label: 'Test', dbFiles: ['test.db'], multiProfile: false },
    ])
    mockExistsSync.mockReturnValue(false)

    registerDatabaseOptimizerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:database:scan')
    const results = await handler()
    expect(results).toEqual([])
  })

  it('scans databases and returns results for valid SQLite files', async () => {
    mockDatabaseTargets.mockReturnValue([
      { basePath: '/app/data', label: 'TestApp', dbFiles: ['main.db'], multiProfile: false },
    ])
    mockExistsSync.mockReturnValue(true)

    mockStatSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('-wal')) return { size: 50000 }
      return { size: 100000, mtimeMs: 1000 }
    })

    mockOpenSync.mockReturnValue(42)
    mockReadSync.mockImplementation((_fd: number, buf: Buffer) => {
      buf.write('SQLite format 3\0', 0, 16, 'utf8')
      return 16
    })

    registerDatabaseOptimizerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:database:scan')
    const results = await handler()

    expect(results).toHaveLength(1)
    expect(results[0].category).toBe('database')
    expect(results[0].subcategory).toBe('TestApp')
    expect(results[0].items.length).toBe(1)
    expect(mockCacheItems).toHaveBeenCalled()
  })

  it('skips zero-size database files', async () => {
    mockDatabaseTargets.mockReturnValue([
      { basePath: '/app/data', label: 'TestApp', dbFiles: ['empty.db'], multiProfile: false },
    ])
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ size: 0 })

    registerDatabaseOptimizerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:database:scan')
    const results = await handler()
    expect(results).toEqual([])
  })

  it('skips files that are not valid SQLite', async () => {
    mockDatabaseTargets.mockReturnValue([
      { basePath: '/app/data', label: 'TestApp', dbFiles: ['not-sqlite.db'], multiProfile: false },
    ])
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('-wal')) throw new Error('ENOENT')
      return { size: 50000, mtimeMs: 1000 }
    })
    mockOpenSync.mockReturnValue(42)
    mockReadSync.mockImplementation((_fd: number, buf: Buffer) => {
      buf.write('NOT A SQLITE DB!', 0, 16, 'utf8')
      return 16
    })

    registerDatabaseOptimizerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:database:scan')
    const results = await handler()
    expect(results).toEqual([])
  })

  it('skips databases with estimated waste below 4096 threshold', async () => {
    mockDatabaseTargets.mockReturnValue([
      { basePath: '/app/data', label: 'TestApp', dbFiles: ['tiny.db'], multiProfile: false },
    ])
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('-wal')) throw new Error('ENOENT')
      return { size: 1000, mtimeMs: 1000 }
    })
    mockOpenSync.mockReturnValue(42)
    mockReadSync.mockImplementation((_fd: number, buf: Buffer) => {
      buf.write('SQLite format 3\0', 0, 16, 'utf8')
      return 16
    })

    registerDatabaseOptimizerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:database:scan')
    const results = await handler()
    expect(results).toEqual([])
  })

  it('resolves multi-profile directories', async () => {
    mockDatabaseTargets.mockReturnValue([
      {
        basePath: '/chrome-data',
        label: 'Chrome',
        dbFiles: ['History'],
        multiProfile: true,
        profilePattern: undefined,
      },
    ])
    mockExistsSync.mockReturnValue(true)
    mockReaddirSync.mockReturnValue([
      { isDirectory: () => true, name: 'Default' },
      { isDirectory: () => true, name: 'Profile 1' },
      { isDirectory: () => false, name: 'somefile.txt' },
    ])
    mockStatSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('-wal')) return { size: 10000 }
      return { size: 100000, mtimeMs: 1000 }
    })
    mockOpenSync.mockReturnValue(42)
    mockReadSync.mockImplementation((_fd: number, buf: Buffer) => {
      buf.write('SQLite format 3\0', 0, 16, 'utf8')
      return 16
    })

    registerDatabaseOptimizerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:database:scan')
    const results = await handler()

    expect(results).toHaveLength(1)
    expect(results[0].items.length).toBe(2)
  })

  it('sends progress to window during scan', async () => {
    // Use a target whose basePath EXISTS so the progress send is reached
    mockDatabaseTargets.mockReturnValue([
      { basePath: '/app/data', label: 'Test', dbFiles: ['test.db'], multiProfile: false },
    ])
    // basePath exists but the db file stat will throw (inaccessible)
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })

    const win = mockWindow()
    registerDatabaseOptimizerIpc(() => win as any)
    const handler = getHandler('cleaner:database:scan')
    await handler()

    expect(mockSend).toHaveBeenCalledWith('scan:progress', expect.objectContaining({
      phase: 'scanning',
      category: 'database',
      progress: 100,
    }))
  })

  it('handles inaccessible targets gracefully', async () => {
    mockDatabaseTargets.mockReturnValue([
      { basePath: '/locked', label: 'Locked', dbFiles: ['locked.db'], multiProfile: false },
    ])
    mockExistsSync.mockImplementation(() => { throw new Error('EACCES') })

    registerDatabaseOptimizerIpc(() => mockWindow() as any)
    const handler = getHandler('cleaner:database:scan')
    const results = await handler()
    expect(Array.isArray(results)).toBe(true)
  })
})

describe('DATABASE_CLEAN handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: constructor succeeds
    mockDatabaseConstructor.mockReturnValue(undefined)
  })

  it('returns empty result for non-array input', async () => {
    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    const result = await handler({}, 'bad')
    expect(result).toEqual({
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      errors: [],
      needsElevation: false,
    })
  })

  it('skips items not found in cache', async () => {
    mockGetCachedItem.mockReturnValue(undefined)

    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    const result = await handler({}, ['nonexistent-id'])

    expect(result).toEqual(expect.objectContaining({
      totalCleaned: 0,
      filesDeleted: 0,
      filesSkipped: 0,
    }))
  })

  it('performs VACUUM on cached database items', async () => {
    mockGetCachedItem.mockReturnValue({ id: 'test-id', path: '/data/test.db', size: 5000 })

    let callCount = 0
    mockStatSync.mockImplementation((p: string) => {
      if (p === '/data/test.db') {
        callCount++
        return { size: callCount <= 1 ? 50000 : 40000 }
      }
      if (p === '/data/test.db-wal') {
        return { size: callCount <= 1 ? 10000 : 0 }
      }
      throw new Error('ENOENT')
    })

    mockDbPragma.mockReturnValue('wal')

    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    const result = await handler({}, ['test-id'])

    expect(mockDbExec).toHaveBeenCalledWith('VACUUM')
    expect(result.filesDeleted).toBe(1)
    expect(result.totalCleaned).toBe(20000)
  })

  it('restores WAL journal mode after VACUUM if original was WAL', async () => {
    mockGetCachedItem.mockReturnValue({ id: 'test-id', path: '/data/test.db', size: 5000 })
    mockStatSync.mockReturnValue({ size: 10000 })
    mockDbPragma.mockReturnValue('wal')

    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    await handler({}, ['test-id'])

    expect(mockDbPragma).toHaveBeenCalledWith('journal_mode = WAL')
  })

  it('does not restore WAL mode when journal mode is not WAL', async () => {
    mockGetCachedItem.mockReturnValue({ id: 'test-id', path: '/data/test.db', size: 5000 })
    mockStatSync.mockReturnValue({ size: 10000 })
    mockDbPragma.mockReturnValue('delete')

    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    await handler({}, ['test-id'])

    const walSetCalls = mockDbPragma.mock.calls.filter((c) => c[0] === 'journal_mode = WAL')
    expect(walSetCalls).toHaveLength(0)
  })

  it('handles SQLITE_BUSY error as in-use', async () => {
    mockGetCachedItem.mockReturnValue({ id: 'test-id', path: '/data/busy.db', size: 5000 })
    mockStatSync.mockReturnValue({ size: 10000 })

    mockDatabaseConstructor.mockImplementation(() => {
      throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })
    })

    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    const result = await handler({}, ['test-id'])

    expect(result.filesSkipped).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].reason).toBe('in-use')
  })

  it('handles EPERM error as permission-denied and sets needsElevation', async () => {
    mockGetCachedItem.mockReturnValue({ id: 'test-id', path: '/data/locked.db', size: 5000 })
    mockStatSync.mockReturnValue({ size: 10000 })

    mockDatabaseConstructor.mockImplementation(() => {
      throw Object.assign(new Error('permission'), { code: 'EPERM' })
    })

    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    const result = await handler({}, ['test-id'])

    expect(result.filesSkipped).toBe(1)
    expect(result.errors[0].reason).toBe('permission-denied')
    expect(result.needsElevation).toBe(true)
  })

  it('handles EACCES error as permission-denied', async () => {
    mockGetCachedItem.mockReturnValue({ id: 'test-id', path: '/data/locked.db', size: 5000 })
    mockStatSync.mockReturnValue({ size: 10000 })

    mockDatabaseConstructor.mockImplementation(() => {
      throw Object.assign(new Error('access'), { code: 'EACCES' })
    })

    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    const result = await handler({}, ['test-id'])

    expect(result.errors[0].reason).toBe('permission-denied')
    expect(result.needsElevation).toBe(true)
  })

  it('handles unknown errors with the error message', async () => {
    mockGetCachedItem.mockReturnValue({ id: 'test-id', path: '/data/corrupt.db', size: 5000 })
    mockStatSync.mockReturnValue({ size: 10000 })

    mockDatabaseConstructor.mockImplementation(() => {
      throw new Error('database disk image is malformed')
    })

    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    const result = await handler({}, ['test-id'])

    expect(result.errors[0].reason).toBe('database disk image is malformed')
    expect(result.needsElevation).toBe(false)
  })

  it('does not count negative reclaimed space', async () => {
    mockGetCachedItem.mockReturnValue({ id: 'test-id', path: '/data/test.db', size: 5000 })

    let callCount = 0
    mockStatSync.mockImplementation((p: string) => {
      callCount++
      if (typeof p === 'string' && p.endsWith('-wal')) throw new Error('ENOENT')
      return { size: callCount <= 1 ? 10000 : 15000 }
    })
    mockDbPragma.mockReturnValue('delete')

    registerDatabaseOptimizerIpc(() => null)
    const handler = getHandler('cleaner:database:clean')
    const result = await handler({}, ['test-id'])

    expect(result.totalCleaned).toBe(0)
    expect(result.filesDeleted).toBe(1)
  })
})
