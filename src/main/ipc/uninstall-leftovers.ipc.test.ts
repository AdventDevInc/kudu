import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────

const handleMap = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler)
    })
  }
}))

vi.mock('../../shared/channels', () => ({
  IPC: {
    UNINSTALL_LEFTOVERS_SCAN: 'cleaner:uninstall-leftovers:scan',
    UNINSTALL_LEFTOVERS_CLEAN: 'cleaner:uninstall-leftovers:clean'
  }
}))

const mockScanForLeftovers = vi.fn()

vi.mock('../services/uninstall-leftovers', () => ({
  scanForLeftovers: (...args: unknown[]) => mockScanForLeftovers(...args)
}))

const mockCleanItems = vi.fn()

vi.mock('../services/file-utils', () => ({
  cleanItems: (...args: unknown[]) => mockCleanItems(...args)
}))

const mockCacheItems = vi.fn()
const mockGetCachedItems = vi.fn()

vi.mock('../services/scan-cache', () => ({
  cacheItems: (...args: unknown[]) => mockCacheItems(...args),
  getCachedItems: (...args: unknown[]) => mockGetCachedItems(...args)
}))

const mockValidateStringArray = vi.fn()

vi.mock('../services/ipc-validation', () => ({
  validateStringArray: (...args: unknown[]) => mockValidateStringArray(...args)
}))

import { registerUninstallLeftoversIpc } from './uninstall-leftovers.ipc'
import type { BrowserWindow } from 'electron'
import type { ScanResult, ScanItem } from '../../shared/types'

// ── Helpers ──────────────────────────────────────────────────

function makeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

function invoke(channel: string, ...args: unknown[]) {
  const handler = handleMap.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return handler({} /* _event */, ...args)
}

function makeScanResult(items: Partial<ScanItem>[] = []): ScanResult {
  const fullItems: ScanItem[] = items.map((partial, i) => ({
    id: `item-${i}`,
    path: `C:\\leftover${i}`,
    size: 100,
    category: 'uninstallLeftovers',
    subcategory: 'files',
    lastModified: Date.now(),
    selected: true,
    ...partial
  }))
  return {
    category: 'uninstallLeftovers',
    subcategory: 'files',
    items: fullItems,
    totalSize: fullItems.reduce((s, it) => s + it.size, 0),
    itemCount: fullItems.length
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('uninstall-leftovers IPC', () => {
  beforeEach(() => {
    handleMap.clear()
    vi.clearAllMocks()
    const current = makeScanResult([{ id: 'id-1' }, { id: 'id-2' }])
    mockScanForLeftovers.mockResolvedValue([current])
    mockGetCachedItems.mockImplementation((ids: string[]) =>
      current.items.filter((i) => ids.includes(i.id))
    )
  })

  it('registers both IPC handlers', () => {
    registerUninstallLeftoversIpc(() => makeWindow())
    expect(handleMap.has('cleaner:uninstall-leftovers:scan')).toBe(true)
    expect(handleMap.has('cleaner:uninstall-leftovers:clean')).toBe(true)
  })

  // ── UNINSTALL_LEFTOVERS_SCAN ───────────────────────────────

  describe('UNINSTALL_LEFTOVERS_SCAN', () => {
    it('returns scan results from scanForLeftovers', async () => {
      const results = [makeScanResult([{ id: 'a' }, { id: 'b' }])]
      mockScanForLeftovers.mockResolvedValue(results)

      registerUninstallLeftoversIpc(() => makeWindow())
      const out = await invoke('cleaner:uninstall-leftovers:scan')

      expect(out).toEqual(results)
      expect(mockScanForLeftovers).toHaveBeenCalledOnce()
    })

    it('passes getWindow to scanForLeftovers', async () => {
      mockScanForLeftovers.mockResolvedValue([])
      const getWindow = () => makeWindow()

      registerUninstallLeftoversIpc(getWindow)
      await invoke('cleaner:uninstall-leftovers:scan')

      expect(mockScanForLeftovers).toHaveBeenCalledWith(getWindow)
    })

    it('caches items from each scan result', async () => {
      const result1 = makeScanResult([{ id: 'a' }])
      const result2 = makeScanResult([{ id: 'b' }, { id: 'c' }])
      mockScanForLeftovers.mockResolvedValue([result1, result2])

      registerUninstallLeftoversIpc(() => makeWindow())
      await invoke('cleaner:uninstall-leftovers:scan')

      expect(mockCacheItems).toHaveBeenCalledTimes(2)
      expect(mockCacheItems).toHaveBeenCalledWith(result1.items)
      expect(mockCacheItems).toHaveBeenCalledWith(result2.items)
    })

    it('caches items even when results are empty', async () => {
      const emptyResult = makeScanResult([])
      mockScanForLeftovers.mockResolvedValue([emptyResult])

      registerUninstallLeftoversIpc(() => makeWindow())
      await invoke('cleaner:uninstall-leftovers:scan')

      expect(mockCacheItems).toHaveBeenCalledWith([])
    })

    it('propagates errors from scanForLeftovers', async () => {
      mockScanForLeftovers.mockRejectedValue(new Error('scan failed'))

      registerUninstallLeftoversIpc(() => makeWindow())
      await expect(invoke('cleaner:uninstall-leftovers:scan')).rejects.toThrow('scan failed')
    })
  })

  // ── UNINSTALL_LEFTOVERS_CLEAN ──────────────────────────────

  describe('UNINSTALL_LEFTOVERS_CLEAN', () => {
    it('refuses stale selections when an application is reinstalled or new user data appears', async () => {
      mockValidateStringArray.mockReturnValue(['id-1'])
      mockScanForLeftovers.mockResolvedValue([])
      registerUninstallLeftoversIpc(() => makeWindow())
      expect(await invoke('cleaner:uninstall-leftovers:clean', ['id-1'])).toMatchObject({
        filesDeleted: 0,
        filesSkipped: 1,
        errors: [{ path: 'id-1', reason: 'scan-result-expired' }]
      })
      expect(mockCleanItems).not.toHaveBeenCalled()
    })

    it('refuses IDs cached by unrelated scanners', async () => {
      mockValidateStringArray.mockReturnValue(['id-1'])
      mockGetCachedItems.mockReturnValue([
        { ...makeScanResult([{ id: 'id-1' }]).items[0], category: 'system' }
      ])
      registerUninstallLeftoversIpc(() => makeWindow())
      expect(await invoke('cleaner:uninstall-leftovers:clean', ['id-1'])).toMatchObject({
        filesDeleted: 0,
        filesSkipped: 1
      })
      expect(mockCleanItems).not.toHaveBeenCalled()
    })

    it('does not clean when inventory revalidation fails', async () => {
      mockValidateStringArray.mockReturnValue(['id-1'])
      mockScanForLeftovers.mockRejectedValue(new Error('Inventory failed'))
      registerUninstallLeftoversIpc(() => makeWindow())
      await expect(invoke('cleaner:uninstall-leftovers:clean', ['id-1'])).rejects.toThrow(
        'Inventory failed'
      )
      expect(mockCleanItems).not.toHaveBeenCalled()
    })

    it('validates input and delegates to cleanItems', async () => {
      const ids = ['id-1', 'id-2']
      mockValidateStringArray.mockReturnValue(ids)
      const expected = {
        totalCleaned: 2,
        filesDeleted: 2,
        filesSkipped: 0,
        errors: [],
        needsElevation: false
      }
      mockCleanItems.mockResolvedValue(expected)

      registerUninstallLeftoversIpc(() => makeWindow())
      const result = await invoke('cleaner:uninstall-leftovers:clean', ids)

      expect(result).toEqual(expected)
      expect(mockValidateStringArray).toHaveBeenCalledWith(ids, 250_000, 100)
      expect(mockCleanItems).toHaveBeenCalledWith(ids)
    })

    it('returns empty result when validation fails (returns null)', async () => {
      mockValidateStringArray.mockReturnValue(null)

      registerUninstallLeftoversIpc(() => makeWindow())
      const result = await invoke('cleaner:uninstall-leftovers:clean', 'not-an-array')

      expect(result).toEqual({
        totalCleaned: 0,
        filesDeleted: 0,
        filesSkipped: 0,
        errors: [],
        needsElevation: false
      })
      expect(mockCleanItems).not.toHaveBeenCalled()
    })

    it('returns empty result when given null input', async () => {
      mockValidateStringArray.mockReturnValue(null)

      registerUninstallLeftoversIpc(() => makeWindow())
      const result = await invoke('cleaner:uninstall-leftovers:clean', null)

      expect(result).toEqual({
        totalCleaned: 0,
        filesDeleted: 0,
        filesSkipped: 0,
        errors: [],
        needsElevation: false
      })
    })

    it('returns empty result when given undefined input', async () => {
      mockValidateStringArray.mockReturnValue(null)

      registerUninstallLeftoversIpc(() => makeWindow())
      const result = await invoke('cleaner:uninstall-leftovers:clean', undefined)

      expect(result).toEqual({
        totalCleaned: 0,
        filesDeleted: 0,
        filesSkipped: 0,
        errors: [],
        needsElevation: false
      })
    })

    it('returns empty result when given a number', async () => {
      mockValidateStringArray.mockReturnValue(null)

      registerUninstallLeftoversIpc(() => makeWindow())
      const result = await invoke('cleaner:uninstall-leftovers:clean', 42)

      expect(result).toEqual({
        totalCleaned: 0,
        filesDeleted: 0,
        filesSkipped: 0,
        errors: [],
        needsElevation: false
      })
    })

    it('propagates errors from cleanItems', async () => {
      mockValidateStringArray.mockReturnValue(['id-1'])
      mockCleanItems.mockRejectedValue(new Error('delete failed'))

      registerUninstallLeftoversIpc(() => makeWindow())
      await expect(invoke('cleaner:uninstall-leftovers:clean', ['id-1'])).rejects.toThrow(
        'delete failed'
      )
    })
  })
})
