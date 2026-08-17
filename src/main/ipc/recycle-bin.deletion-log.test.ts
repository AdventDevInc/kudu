import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

// ── Mocks ──

const mockHandle = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
}))

const state = vi.hoisted(() => ({
  keepDeletionLog: false,
  /** stdout for the bin-contents enumeration, in call order */
  enumerations: [] as string[],
  /** stdout for the post-empty count check */
  statsOutputs: [] as string[],
  emptyThrows: false,
  fastThrows: false,
  finalizeTimeouts: [] as number[],
  psScripts: [] as string[],
  recorded: [] as any[],
}))

vi.mock('child_process', () => ({
  execFile: (_file: string, args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    const script = args[args.length - 1]
    state.psScripts.push(script)
    if (script.includes('SHEmptyRecycleBin')) {
      if (state.emptyThrows) return cb(new Error('access denied'))
      return cb(null, { stdout: '' })
    }
    if (script.includes('ConvertTo-Json')) {
      return cb(null, { stdout: state.enumerations.shift() ?? '[]' })
    }
    // Initial scan and post-empty count/size verification.
    return cb(null, { stdout: state.statsOutputs.shift() ?? '0|0' })
  },
}))

vi.mock('../platform', () => ({
  getPlatform: () => ({ paths: { trashPath: () => null } }), // Windows
}))

vi.mock('../services/file-utils', () => ({
  scanDirectory: vi.fn(),
  cleanItems: vi.fn(),
}))

vi.mock('../services/scan-cache', () => ({ cacheItems: vi.fn(), clearCachedCategory: vi.fn() }))

vi.mock('../services/recycle-bin-cleaner', () => ({
  emptyRecycleBinFast: async () => {
    if (state.fastThrows) throw new Error('fast clean unavailable')
    return {
      payloadsFound: 2,
      payloadsDeleted: 2,
      payloadsFailed: 0,
      orphanMetadataDeleted: 0,
      accessDenied: false,
    }
  },
  finalizeRecycleBinShell: async (timeout = 10_000) => {
    state.finalizeTimeouts.push(timeout)
    if (state.emptyThrows) throw new Error('access denied')
    return 0
  },
}))

vi.mock('../services/exec-utf8', () => ({
  psUtf8: (s: string) => s,
  execTracked: async (_file: string, args: string[]) => {
    const script = args[args.length - 1]
    state.psScripts.push(script)
    return { stdout: state.statsOutputs.shift() ?? '0|0', stderr: '' }
  },
}))

vi.mock('../services/settings-store', () => ({
  getSettings: () => ({ cleaner: { keepDeletionLog: state.keepDeletionLog } }),
}))

vi.mock('../services/deletion-log-store', () => ({
  recordDeletions: (records: unknown[]) => { state.recorded.push(...records) },
}))

import { registerRecycleBinIpc } from './recycle-bin.ipc'
import { IPC } from '../../shared/channels'

function getHandler(channel: string): (...args: unknown[]) => Promise<any> {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as (...args: unknown[]) => Promise<any>
}

async function scanThenClean(): Promise<any> {
  await getHandler(IPC.RECYCLE_BIN_SCAN)()
  return getHandler(IPC.RECYCLE_BIN_CLEAN)()
}

const binItems = (items: Array<{ name: string; origin?: string; size?: number }>) =>
  JSON.stringify(items.map((i) => ({ name: i.name, origin: i.origin ?? '', size: i.size ?? 0 })))

describe('recycle bin deletion logging (Windows)', () => {
  beforeEach(() => {
    mockHandle.mockClear()
    state.keepDeletionLog = false
    state.enumerations = []
    state.statsOutputs = ['2|4216', '0|0']
    state.emptyThrows = false
    state.fastThrows = false
    state.finalizeTimeouts = []
    state.psScripts = []
    state.recorded = []
    registerRecycleBinIpc()
  })

  it('does not enumerate the bin when logging is off', async () => {
    const result = await scanThenClean()

    expect(result.errors).toEqual([])
    expect(state.recorded).toHaveLength(0)
    expect(state.psScripts.some((s) => s.includes('ConvertTo-Json'))).toBe(false)
    expect(state.finalizeTimeouts).toEqual([10_000])
  })

  it('records each emptied item by its original location', async () => {
    state.keepDeletionLog = true
    state.enumerations = [binItems([
      { name: 'notes.txt', origin: 'C:\\Users\\dave\\Documents', size: 120 },
      { name: 'photo.png', origin: 'D:\\Pictures', size: 4096 },
    ])]

    await scanThenClean()

    expect(state.recorded.map((r) => r.path)).toEqual([
      join('C:\\Users\\dave\\Documents', 'notes.txt'),
      join('D:\\Pictures', 'photo.png'),
    ])
    expect(state.recorded.map((r) => r.size)).toEqual([120, 4096])
    for (const record of state.recorded) {
      expect(record.category).toBe('Recycle Bin')
      expect(record.origin).toBe('local')
      expect(Number.isNaN(Date.parse(record.ts))).toBe(false)
    }
  })

  it('falls back to the bare name when Windows reports no original location', async () => {
    state.keepDeletionLog = true
    state.enumerations = [binItems([{ name: 'orphan.dat' }])]

    await scanThenClean()

    expect(state.recorded.map((r) => r.path)).toEqual(['orphan.dat'])
  })

  it('on a partial empty, records only the items that are actually gone', async () => {
    state.keepDeletionLog = true
    state.statsOutputs = ['2|4216', '1|4096']
    state.enumerations = [
      binItems([
        { name: 'gone.txt', origin: 'C:\\a' },
        { name: 'locked.txt', origin: 'C:\\b' },
      ]),
      // Re-enumeration after the empty: the locked item survived.
      binItems([{ name: 'locked.txt', origin: 'C:\\b' }]),
    ]

    const result = await scanThenClean()

    expect(result.filesSkipped).toBe(1)
    expect(result.filesDeleted).toBe(1)
    expect(result.totalCleaned).toBe(120)
    expect(state.recorded.map((r) => r.path)).toEqual([join('C:\\a', 'gone.txt')])
  })

  it('survives an unparseable enumeration without blocking the clean', async () => {
    state.keepDeletionLog = true
    state.enumerations = ['not json at all']

    const result = await scanThenClean()

    expect(result.errors).toEqual([])
    expect(result.filesDeleted).toBe(2)
    expect(state.recorded).toHaveLength(0)
  })

  it('records nothing when the empty itself fails', async () => {
    state.keepDeletionLog = true
    state.enumerations = [binItems([{ name: 'notes.txt', origin: 'C:\\a' }])]
    state.fastThrows = true
    state.emptyThrows = true

    const result = await scanThenClean()

    expect(result.filesDeleted).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(state.recorded).toHaveLength(0)
    expect(state.finalizeTimeouts).toEqual([60_000])
  })
})
