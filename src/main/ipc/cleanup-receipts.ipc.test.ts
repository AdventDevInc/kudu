import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScanItem } from '../../shared/types'

const mockHandle = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) },
  dialog: { showSaveDialog: vi.fn() }
}))
const mockCleanItems = vi.fn()
vi.mock('../services/file-utils', () => ({
  cleanItems: (...args: unknown[]) => mockCleanItems(...args)
}))
const mockGetSettings = vi.fn()
vi.mock('../services/settings-store', () => ({ getSettings: () => mockGetSettings() }))
const mockCloseBrowsers = vi.fn()
vi.mock('../platform', () => ({
  getPlatform: () => ({ browser: { closeBrowsers: () => mockCloseBrowsers() } })
}))
const mockRetryIds = vi.fn()
vi.mock('../services/cleanup-receipts', () => ({
  clearCleanupReceipts: vi.fn(),
  getCleanupReceipts: vi.fn(),
  getCleanupReceipt: vi.fn(),
  receiptRetryIds: (id: string) => mockRetryIds(id)
}))

import { IPC } from '../../shared/channels'
import { registerCleanupReceiptsIpc } from './cleanup-receipts.ipc'
import { cacheItems, clearCache, getCachedItem } from '../services/scan-cache'

const RECEIPT = '11111111-1111-4111-8111-111111111111'
const failed: ScanItem = {
  id: 'failed-item',
  path: '/cache/a',
  category: 'app',
  subcategory: 'App cache',
  size: 10,
  lastModified: 0,
  selected: true,
  recencyCutoff: 1_000
}
const retry = () => {
  const call = mockHandle.mock.calls.find((c) => c[0] === IPC.RECEIPTS_RETRY)
  if (!call) throw new Error('No retry handler')
  return call[1] as (event: unknown, id: unknown) => Promise<unknown>
}

describe('RECEIPTS_RETRY handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
    cacheItems([failed, { ...failed, id: 'deleted-item', category: 'browser' }])
    mockGetSettings.mockReturnValue({
      cleaner: { skipRecentMinutes: 60, closeBrowsersBeforeClean: false }
    })
    mockRetryIds.mockReturnValue([failed.id])
    mockCleanItems.mockResolvedValue({ totalCleaned: 0 })
    registerCleanupReceiptsIpc()
  })
  it('retries only server-authorized failed IDs without loosening recency protections', async () => {
    await retry()({}, RECEIPT)
    expect(mockCleanItems).toHaveBeenCalledWith([failed.id], undefined, 'local', RECEIPT)
    expect(mockCleanItems.mock.calls[0][0]).not.toContain('deleted-item')
    expect(getCachedItem(failed.id)?.recencyCutoff).toBe(1_000)
    expect(mockCloseBrowsers).not.toHaveBeenCalled()
  })
  it('rejects expired or invalid retries before touching anything', async () => {
    mockRetryIds.mockReturnValue([])
    await expect(retry()({}, RECEIPT)).rejects.toThrow('Retry details expired')
    await expect(retry()({}, '../x')).rejects.toThrow('Invalid receipt ID')
    expect(mockCleanItems).not.toHaveBeenCalled()
  })
  it('allows one retry at a time and releases the lock afterwards', async () => {
    let finish!: (value: unknown) => void
    mockCleanItems.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const first = retry()({}, RECEIPT)
    await expect(retry()({}, RECEIPT)).rejects.toThrow('already running')
    finish({ totalCleaned: 0 })
    await first
    await expect(retry()({}, RECEIPT)).resolves.toEqual({ totalCleaned: 0 })
  })
  it('closes browsers before retrying browser items when the setting is enabled', async () => {
    mockGetSettings.mockReturnValue({ cleaner: { closeBrowsersBeforeClean: true } })
    await retry()({}, RECEIPT)
    expect(mockCloseBrowsers).not.toHaveBeenCalled()
    mockRetryIds.mockReturnValue(['deleted-item'])
    await retry()({}, RECEIPT)
    expect(mockCloseBrowsers).toHaveBeenCalledTimes(1)
  })
})
