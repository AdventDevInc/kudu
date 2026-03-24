import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──

const mockHandle = vi.fn()
const mockSend = vi.fn()
const mockShowOpenDialog = vi.fn()
const mockShowItemInFolder = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  dialog: { showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args) },
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
  shell: { showItemInFolder: (...args: unknown[]) => mockShowItemInFolder(...args) },
}))

const mockReaddir = vi.fn()
const mockRmdir = vi.fn()
const mockStat = vi.fn()
const mockLstat = vi.fn()
const mockOpen = vi.fn()
const mockRm = vi.fn()
vi.mock('fs/promises', () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  rmdir: (...args: unknown[]) => mockRmdir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  lstat: (...args: unknown[]) => mockLstat(...args),
  open: (...args: unknown[]) => mockOpen(...args),
  rm: (...args: unknown[]) => mockRm(...args),
}))

vi.mock('crypto', () => ({
  randomBytes: (len: number) => Buffer.alloc(len, 0xAA),
}))

import { registerFileShredderIpc } from './file-shredder.ipc'

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

describe('registerFileShredderIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers all shredder IPC handlers', () => {
    registerFileShredderIpc(() => null)
    const channels = mockHandle.mock.calls.map((c) => c[0])
    expect(channels).toContain('shredder:select-files')
    expect(channels).toContain('shredder:select-folders')
    expect(channels).toContain('shredder:cancel')
    expect(channels).toContain('shredder:shred')
    expect(channels).toContain('shredder:open-location')
  })
})

describe('SHREDDER_SELECT_FILES handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when no window', async () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:select-files')
    const result = await handler()
    expect(result).toEqual([])
  })

  it('returns empty array when dialog is canceled', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:select-files')
    const result = await handler()
    expect(result).toEqual([])
  })

  it('returns empty array when no files selected', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] })
    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:select-files')
    const result = await handler()
    expect(result).toEqual([])
  })

  it('returns file entries with size information', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/home/user/secret.txt', '/home/user/data.bin'],
    })
    mockStat.mockImplementation((p: string) => {
      if (p === '/home/user/secret.txt') return Promise.resolve({ size: 1024 })
      if (p === '/home/user/data.bin') return Promise.resolve({ size: 2048 })
      return Promise.reject(new Error('ENOENT'))
    })

    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:select-files')
    const result = await handler()

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(expect.objectContaining({
      path: '/home/user/secret.txt',
      size: 1024,
      isDirectory: false,
    }))
    expect(result[0].name).toBe('secret.txt')
  })

  it('skips files that fail stat', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/home/user/gone.txt', '/home/user/exists.txt'],
    })
    mockStat.mockImplementation((p: string) => {
      if (p === '/home/user/gone.txt') return Promise.reject(new Error('ENOENT'))
      return Promise.resolve({ size: 512 })
    })

    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:select-files')
    const result = await handler()
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('/home/user/exists.txt')
  })
})

describe('SHREDDER_SELECT_FOLDERS handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when no window', async () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:select-folders')
    const result = await handler()
    expect(result).toEqual([])
  })

  it('returns empty array when dialog is canceled', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:select-folders')
    const result = await handler()
    expect(result).toEqual([])
  })

  it('returns folder entries with calculated size', async () => {
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/home/user/secret-folder'],
    })
    // getEntrySize calls lstat, readdir, stat
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true, size: 0 })
    mockReaddir.mockResolvedValue([
      { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, name: 'a.txt' },
    ])
    mockStat.mockResolvedValue({ isDirectory: () => false, size: 5000 })

    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:select-folders')
    const result = await handler()

    expect(result).toHaveLength(1)
    expect(result[0].isDirectory).toBe(true)
    expect(result[0].name).toBe('secret-folder')
  })
})

describe('SHREDDER_CANCEL handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets the cancelled flag (does not throw)', () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:cancel')
    expect(() => handler()).not.toThrow()
  })
})

describe('SHREDDER_SHRED handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty result for non-array input', async () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, 'not-an-array')
    expect(result).toEqual(expect.objectContaining({
      shredded: 0,
      failed: 0,
      bytesShredded: 0,
      cancelled: false,
    }))
  })

  it('returns empty result for empty array', async () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, [])
    expect(result).toEqual(expect.objectContaining({ shredded: 0 }))
  })

  it('filters out non-string and relative path entries', async () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, [123, 'relative/path', null])
    expect(result).toEqual(expect.objectContaining({ shredded: 0 }))
  })

  it('blocks protected system paths', async () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:shred')
    // Root-level paths should be blocked
    const result = await handler({}, ['/usr', '/etc', '/bin'])
    expect(result.failed).toBeGreaterThan(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0].reason).toContain('Protected system path')
  })

  it('shreds a single file successfully', async () => {
    const mockFh = {
      write: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: 512 })
    mockOpen.mockResolvedValue(mockFh)
    mockRm.mockResolvedValue(undefined)
    mockStat.mockResolvedValue({ size: 512 })

    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, ['/home/user/temp/secret.txt'])

    expect(result.shredded).toBe(1)
    expect(result.bytesShredded).toBe(512)
    expect(result.failed).toBe(0)
    // File handle should have been written to (random pass + zero pass)
    expect(mockFh.write).toHaveBeenCalled()
    expect(mockFh.datasync).toHaveBeenCalled()
  })

  it('handles shred errors and reports them', async () => {
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: 100 })
    mockOpen.mockRejectedValue(new Error('EACCES: permission denied'))
    mockStat.mockResolvedValue({ size: 100 })

    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, ['/home/user/temp/locked.txt'])

    expect(result.failed).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].path).toBe('/home/user/temp/locked.txt')
  })

  it('deduplicates file paths', async () => {
    const mockFh = {
      write: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: 100 })
    mockOpen.mockResolvedValue(mockFh)
    mockRm.mockResolvedValue(undefined)
    mockStat.mockResolvedValue({ size: 100 })

    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, ['/home/user/temp/file.txt', '/home/user/temp/file.txt'])

    // Should only shred once despite duplicate path
    expect(result.shredded).toBe(1)
  })

  it('skips symlinks during file shredding', async () => {
    mockLstat.mockResolvedValue({ isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false, size: 100 })

    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, ['/home/user/temp/link'])

    expect(result.shredded).toBe(0)
  })

  it('recursively collects files from directories', async () => {
    const mockFh = {
      write: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }

    let lstatCallCount = 0
    mockLstat.mockImplementation((p: string) => {
      lstatCallCount++
      if (p === '/home/user/temp/mydir') {
        return Promise.resolve({ isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true, size: 0 })
      }
      // shredFile lstat
      return Promise.resolve({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: 256 })
    })

    mockReaddir.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('mydir')) {
        return Promise.resolve([
          { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, name: 'inner.txt' },
        ])
      }
      return Promise.resolve([])
    })

    mockOpen.mockResolvedValue(mockFh)
    mockRm.mockResolvedValue(undefined)
    mockRmdir.mockResolvedValue(undefined)
    mockStat.mockResolvedValue({ size: 256 })

    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, ['/home/user/temp/mydir'])

    expect(result.shredded).toBe(1)
  })

  it('sends final progress after shredding', async () => {
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: 0 })
    mockStat.mockResolvedValue({ size: 0 })

    // shredFile skips zero-size files, rm still called
    const mockFh = {
      write: vi.fn().mockResolvedValue(undefined),
      datasync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockOpen.mockResolvedValue(mockFh)
    mockRm.mockResolvedValue(undefined)

    registerFileShredderIpc(() => mockWindow() as any)
    const handler = getHandler('shredder:shred')
    await handler({}, ['/home/user/temp/file.txt'])

    expect(mockSend).toHaveBeenCalledWith('shredder:progress', expect.objectContaining({
      progress: 100,
    }))
  })
})

describe('SHREDDER_OPEN_LOCATION handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls shell.showItemInFolder for valid absolute path', () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:open-location')
    handler({}, '/home/user/file.txt')
    expect(mockShowItemInFolder).toHaveBeenCalledWith('/home/user/file.txt')
  })

  it('ignores non-string input', () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:open-location')
    handler({}, 12345)
    expect(mockShowItemInFolder).not.toHaveBeenCalled()
  })

  it('ignores relative path input', () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:open-location')
    handler({}, 'relative/path.txt')
    expect(mockShowItemInFolder).not.toHaveBeenCalled()
  })
})

// ── Protected path validation (mirrored logic) ──

describe('protected path safety', () => {
  // We test the safety logic indirectly through the shred handler
  beforeEach(() => {
    vi.clearAllMocks()
    // Make lstat return file for all so we can check protection
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: 100 })
    mockStat.mockResolvedValue({ size: 100 })
  })

  it('blocks .git directories', async () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, ['/home/user/project/.git'])
    expect(result.errors.some((e: { path: string; reason: string }) => e.reason.includes('Protected'))).toBe(true)
  })

  it('blocks .ssh directories', async () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, ['/home/user/.ssh'])
    expect(result.errors.some((e: { path: string; reason: string }) => e.reason.includes('Protected'))).toBe(true)
  })

  it('blocks node_modules directories', async () => {
    registerFileShredderIpc(() => null)
    const handler = getHandler('shredder:shred')
    const result = await handler({}, ['/home/user/project/node_modules'])
    expect(result.errors.some((e: { path: string; reason: string }) => e.reason.includes('Protected'))).toBe(true)
  })
})
