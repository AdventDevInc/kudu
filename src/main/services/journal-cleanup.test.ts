import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ admin: true, exclusions: [] as string[], link: '' }))
vi.mock('./exec-utf8', () => ({ execTracked: vi.fn() }))
vi.mock('./settings-store', () => ({ getSettings: () => ({ exclusions: state.exclusions }) }))
vi.mock('./elevation', () => ({ isAdmin: () => state.admin }))
vi.mock('fs/promises', () => ({ lstat: vi.fn(async (path: string) => ({ isDirectory: () => true, isSymbolicLink: () => state.link === path })) }))
import { execTracked } from './exec-utf8'
import { scanManagedCleanup, runManagedCleanup } from './managed-cleanup'
import { JOURNAL_ROOT } from './journal-cleanup'

async function scan() { return scanManagedCleanup('journal-vacuum', 'system', 'Journal Logs', JOURNAL_ROOT) }
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  state.admin = true; state.exclusions = []; state.link = ''
  vi.mocked(execTracked).mockReset().mockResolvedValue({ stdout: 'Archived and active journals take up 48.0M.', stderr: '' })
})
afterEach(() => vi.unstubAllGlobals())

describe('native journal cleanup', () => {
  it('offers unselected maintenance using read-only discovery and unknown savings', async () => {
    const result = await scan()
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ path: JOURNAL_ROOT, size: 0, selected: false, cleanupAction: 'journal-vacuum' })
    expect(execTracked).toHaveBeenCalledExactlyOnceWith('/usr/bin/journalctl', ['--no-pager', '--directory=/var/log/journal', '--disk-usage'], { timeout: 10_000 })
  })
  it('vacuuming is confined to persistent archives with bounded retention and no rotation', async () => {
    const item = (await scan()).items[0]
    expect(await runManagedCleanup(item)).toEqual({ success: true })
    expect(execTracked).toHaveBeenLastCalledWith('/usr/bin/journalctl', ['--no-pager', '--directory=/var/log/journal', '--vacuum-time=30d', '--vacuum-size=1G'], { timeout: 300_000 })
  })
  it('requires Linux and elevation both at scan and cleanup time', async () => {
    const item = (await scan()).items[0]
    state.admin = false
    vi.mocked(execTracked).mockClear()
    expect((await scan()).items).toEqual([])
    expect((await runManagedCleanup(item)).reason).toBe('permission-denied')
    state.admin = true
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    expect((await scan()).items).toEqual([])
    expect((await runManagedCleanup(item)).success).toBe(false)
    expect(execTracked).not.toHaveBeenCalled()
  })
  it.each(['/var', '/var/log', JOURNAL_ROOT])('rejects a journal ancestor replaced by a link: %s', async (path) => {
    const item = (await scan()).items[0]
    state.link = path
    vi.mocked(execTracked).mockClear()
    expect((await scan()).items).toEqual([])
    expect((await runManagedCleanup(item)).success).toBe(false)
    expect(execTracked).not.toHaveBeenCalled()
  })
  it('honors new exclusions and rejects a changed target', async () => {
    const item = (await scan()).items[0]
    vi.mocked(execTracked).mockClear()
    state.exclusions = ['keep']
    expect((await scan()).items).toEqual([])
    expect((await runManagedCleanup(item)).success).toBe(false)
    state.exclusions = []
    expect((await runManagedCleanup({ ...item, path: '/tmp' })).success).toBe(false)
    expect(execTracked).not.toHaveBeenCalled()
  })
  it('does not offer missing journalctl or fall back to deleting files on failure', async () => {
    const item = (await scan()).items[0]
    vi.mocked(execTracked).mockRejectedValue(new Error('journalctl unavailable'))
    expect((await scan()).items).toEqual([])
    expect(await runManagedCleanup(item)).toEqual({ success: false, reason: 'journalctl unavailable' })
  })
})
