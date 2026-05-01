import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ──

const mockHandle = vi.fn()
const mockSend = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
}))

const mockExecFile = vi.fn()
const mockSpawn = vi.fn()
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

vi.mock('util', () => ({
  promisify: (fn: unknown) => (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      ;(fn as Function)(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    }),
}))

const mockIsAdmin = vi.fn()
vi.mock('../services/elevation', () => ({
  isAdmin: () => mockIsAdmin(),
}))

const mockGetLastTrimAt = vi.fn()
const mockSetLastTrimAt = vi.fn()
const mockIsThrottled = vi.fn()
vi.mock('../services/trim-history-store', () => ({
  getLastTrimAt: (id: string) => mockGetLastTrimAt(id),
  setLastTrimAt: (id: string, when?: number) => mockSetLastTrimAt(id, when),
  isThrottled: (id: string, now?: number) => mockIsThrottled(id, now),
}))

vi.mock('../services/exec-utf8', () => ({
  psUtf8: (s: string) => s,
}))

import { registerDiskTrimIpc, runTrimForDrive } from './disk-trim.ipc'
import type { TrimDriveInfo } from '../../shared/types'
import { EventEmitter } from 'events'

// ── Helpers ──

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as (...args: unknown[]) => unknown
}

function makeFakeChild(opts: {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  emitError?: Error
}): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  // Schedule events on next tick so the caller can attach listeners first.
  setImmediate(() => {
    if (opts.emitError) {
      child.emit('error', opts.emitError)
      return
    }
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout, 'utf-8'))
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr, 'utf-8'))
    child.emit('close', opts.exitCode ?? 0)
  })
  return child
}

const fakeWin = { isDestroyed: () => false, webContents: { send: mockSend } }
const getWindow = () => fakeWin as unknown as Electron.BrowserWindow

// ── Helper: mock platform ──

const ORIGINAL_PLATFORM = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
function resetPlatform(): void {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
}

// ── Tests ──

describe('registerDiskTrimIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers list and run handlers', () => {
    registerDiskTrimIpc(getWindow)
    const channels = mockHandle.mock.calls.map((c) => c[0])
    expect(channels).toContain('disk:trim:list')
    expect(channels).toContain('disk:trim:run')
  })
})

describe('runTrimForDrive — safety rails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAdmin.mockReturnValue(true)
    mockIsThrottled.mockReturnValue(false)
    mockGetLastTrimAt.mockReturnValue(null)
  })

  afterEach(resetPlatform)

  it('macOS: returns success:false without spawning anything', async () => {
    setPlatform('darwin')
    const drives: TrimDriveInfo[] = []
    const result = await runTrimForDrive('/Volumes/Foo', getWindow, drives)
    expect(result.success).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
    // Defense in depth: ensure we never invoked trimforce regardless of args.
    const trimforceCalled = mockSpawn.mock.calls.some((c) =>
      c.some((a) => typeof a === 'string' && a.toLowerCase().includes('trimforce')) ||
      (Array.isArray(c[1]) && c[1].some((a: unknown) => typeof a === 'string' && a.toLowerCase().includes('trimforce')))
    )
    expect(trimforceCalled).toBe(false)
  })

  it('rejects HDD with success:false and never spawns', async () => {
    setPlatform('linux')
    const drives: TrimDriveInfo[] = [{
      id: '/data', mountPoint: '/data', label: 'Data', totalSize: 0, freeSpace: 0,
      mediaType: 'HDD', isRemovable: false, isEncrypted: false,
      trimSupport: 'supported', status: 'not-applicable',
      statusReason: 'HDD', lastTrimAt: null,
    }]
    const result = await runTrimForDrive('/data', getWindow, drives)
    expect(result.success).toBe(false)
    expect(result.summary).toMatch(/HDD/i)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('throttle: returns throttled:true when isThrottled is true; never spawns', async () => {
    setPlatform('linux')
    mockIsThrottled.mockReturnValue(true)
    const drives: TrimDriveInfo[] = [{
      id: '/', mountPoint: '/', label: 'Root', totalSize: 0, freeSpace: 0,
      mediaType: 'SSD', isRemovable: false, isEncrypted: false,
      trimSupport: 'supported', status: 'recently-trimmed',
      statusReason: '', lastTrimAt: Date.now() - 1000,
    }]
    const result = await runTrimForDrive('/', getWindow, drives)
    expect(result.throttled).toBe(true)
    expect(result.success).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('elevation: returns needsAdmin:true when isAdmin is false; never spawns', async () => {
    setPlatform('linux')
    mockIsAdmin.mockReturnValue(false)
    const drives: TrimDriveInfo[] = [{
      id: '/', mountPoint: '/', label: 'Root', totalSize: 0, freeSpace: 0,
      mediaType: 'SSD', isRemovable: false, isEncrypted: false,
      trimSupport: 'supported', status: 'ok', statusReason: '', lastTrimAt: null,
    }]
    const result = await runTrimForDrive('/', getWindow, drives)
    expect(result.needsAdmin).toBe(true)
    expect(result.success).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('Linux: parses "bytes were trimmed" into bytesDiscarded and persists last-trim', async () => {
    setPlatform('linux')
    mockSpawn.mockImplementation(() =>
      makeFakeChild({ stdout: '/: 1234567 bytes were trimmed\n', exitCode: 0 })
    )
    const drives: TrimDriveInfo[] = [{
      id: '/', mountPoint: '/', label: 'Root', totalSize: 0, freeSpace: 0,
      mediaType: 'SSD', isRemovable: false, isEncrypted: false,
      trimSupport: 'supported', status: 'ok', statusReason: '', lastTrimAt: null,
    }]
    const result = await runTrimForDrive('/', getWindow, drives)
    expect(result.success).toBe(true)
    expect(result.bytesDiscarded).toBe(1234567)
    expect(mockSetLastTrimAt).toHaveBeenCalledWith('/', undefined)
    expect(mockSpawn).toHaveBeenCalledWith('fstrim', ['-v', '/'])
  })

  it('Linux: detects "Operation not permitted" and sets needsAdmin', async () => {
    setPlatform('linux')
    mockSpawn.mockImplementation(() =>
      makeFakeChild({
        stderr: 'fstrim: /: FITRIM ioctl failed: Operation not permitted\n',
        exitCode: 1,
      })
    )
    const drives: TrimDriveInfo[] = [{
      id: '/', mountPoint: '/', label: 'Root', totalSize: 0, freeSpace: 0,
      mediaType: 'SSD', isRemovable: false, isEncrypted: false,
      trimSupport: 'supported', status: 'ok', statusReason: '', lastTrimAt: null,
    }]
    const result = await runTrimForDrive('/', getWindow, drives)
    expect(result.success).toBe(false)
    expect(result.needsAdmin).toBe(true)
    expect(mockSetLastTrimAt).not.toHaveBeenCalled()
  })

  it('Windows: invalid drive letter is rejected before spawn', async () => {
    setPlatform('win32')
    const drives: TrimDriveInfo[] = [{
      id: 'CC', letter: 'CC', label: 'Bad', totalSize: 0, freeSpace: 0,
      mediaType: 'SSD', isRemovable: false, isEncrypted: false,
      trimSupport: 'supported', status: 'ok', statusReason: '', lastTrimAt: null,
    }]
    const result = await runTrimForDrive('CC', getWindow, drives)
    expect(result.success).toBe(false)
    expect(result.summary).toMatch(/Invalid drive letter/i)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('Windows: success path persists last-trim and spawns Optimize-Volume', async () => {
    setPlatform('win32')
    mockSpawn.mockImplementation(() =>
      makeFakeChild({ stderr: 'VERBOSE: Retrim succeeded\n', exitCode: 0 })
    )
    const drives: TrimDriveInfo[] = [{
      id: 'C', letter: 'C', label: 'C:', totalSize: 0, freeSpace: 0,
      mediaType: 'SSD', isRemovable: false, isEncrypted: false,
      trimSupport: 'supported', status: 'ok', statusReason: '', lastTrimAt: null,
    }]
    const result = await runTrimForDrive('C', getWindow, drives)
    expect(result.success).toBe(true)
    expect(mockSetLastTrimAt).toHaveBeenCalledWith('C', undefined)
    expect(mockSpawn).toHaveBeenCalled()
    const args = mockSpawn.mock.calls[0]
    const fullCmd = JSON.stringify(args)
    expect(fullCmd).toContain('Optimize-Volume')
    expect(fullCmd).toContain('-DriveLetter C')
    expect(fullCmd).toContain('-ReTrim')
  })

  it('rejects unknown drive id', async () => {
    setPlatform('linux')
    const result = await runTrimForDrive('/nope', getWindow, [])
    expect(result.success).toBe(false)
    expect(result.summary).toMatch(/Unknown drive/i)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('respects trimSupport=unsupported (e.g. filesystem rejects DISCARD)', async () => {
    setPlatform('linux')
    const drives: TrimDriveInfo[] = [{
      id: '/legacy', mountPoint: '/legacy', label: 'legacy', totalSize: 0, freeSpace: 0,
      mediaType: 'SSD', isRemovable: false, isEncrypted: false,
      trimSupport: 'unsupported', status: 'disabled',
      statusReason: 'Unsupported FS', lastTrimAt: null,
    }]
    const result = await runTrimForDrive('/legacy', getWindow, drives)
    expect(result.success).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })
})

describe('DISK_TRIM_RUN handler — input validation & mutex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAdmin.mockReturnValue(true)
    mockIsThrottled.mockReturnValue(false)
    mockGetLastTrimAt.mockReturnValue(null)
    // The handler calls listTrimDrives() before each run, which on darwin
    // invokes `df`. Mock execFile to return empty so the promise resolves.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as Function
      if (typeof cb === 'function') cb(null, '', '')
    })
  })

  afterEach(resetPlatform)

  it('returns [] for non-array input', async () => {
    registerDiskTrimIpc(getWindow)
    const handler = getHandler('disk:trim:run')
    expect(await handler({}, 'not-array')).toEqual([])
    expect(await handler({}, null)).toEqual([])
    expect(await handler({}, 42)).toEqual([])
  })

  it('filters out non-string and oversize ids', async () => {
    setPlatform('darwin') // run path returns success:false without spawning
    registerDiskTrimIpc(getWindow)
    const handler = getHandler('disk:trim:run')
    const huge = 'x'.repeat(300)
    const results = await handler({}, [123, '', huge, '/'])
    // Only '/' survives; macOS run returns 1 result
    expect(Array.isArray(results)).toBe(true)
    expect((results as unknown[]).length).toBe(1)
  })
})

