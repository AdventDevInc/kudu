import { beforeEach, expect, it, vi } from 'vitest'
import { join, parse } from 'path'
import { tmpdir } from 'os'
import type { StorageScope, StorageSnapshot } from '../../shared/storage-history'
const mocks = vi.hoisted(() => ({
  blocks: vi.fn(),
  sizes: vi.fn(),
  measure: vi.fn(),
  saved: [] as StorageSnapshot[],
  scopes: [] as StorageScope[],
  save: vi.fn(),
  update: vi.fn()
}))
vi.mock('systeminformation', () => ({
  default: { blockDevices: mocks.blocks, fsSize: mocks.sizes }
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/kudu-private' },
  Notification: { isSupported: () => false },
  powerMonitor: {}
}))
vi.mock('./settings-store', () => ({
  getSettings: () => ({ exclusions: [], showNotificationOnComplete: false })
}))
vi.mock('./storage-scan', () => ({
  validateStorageRoot: async (p: string) => p,
  measureStorageScope: mocks.measure
}))
vi.mock('./storage-history-store', () => ({
  getStorageIndex: async () => ({ scopes: mocks.scopes, snapshots: mocks.saved }),
  saveStorageScope: mocks.save,
  updateStorageScope: mocks.update,
  saveStorageSnapshot: async (s: StorageSnapshot) => {
    mocks.saved = mocks.saved.filter((e) => e.id !== s.id)
    mocks.saved.push(structuredClone(s))
  }
}))
vi.mock('./logger', () => ({ logError: vi.fn() }))
import { identifyStorageVolume, captureStorageScope, storageCaptureStatus } from './storage-history'
const path = join(tmpdir(), 'tracked-folder'),
  mount = parse(path).root
beforeEach(async () => {
  mocks.saved = []
  mocks.scopes = []
  vi.clearAllMocks()
  mocks.blocks.mockResolvedValue([
    {
      mount: process.platform === 'win32' ? mount.slice(0, -1) : mount,
      uuid: 'stable-volume',
      fsType: 'testfs',
      physical: 'Local'
    }
  ])
  mocks.sizes.mockResolvedValue([
    {
      mount: process.platform === 'win32' ? mount.slice(0, -1) : mount,
      type: 'testfs',
      size: 1000,
      available: 500
    }
  ])
  const volume = await identifyStorageVolume(path)
  mocks.scopes = [
    {
      id: '12345678-1234-1234-1234-123456789abc',
      name: 'Test',
      path,
      volumeId: volume.id,
      relativeRoot: volume.relativeRoot,
      daily: false,
      growthAlertBytes: null,
      freeAlertPercent: null,
      lastAttemptAt: null,
      lastAlertAt: null
    }
  ]
  mocks.measure.mockResolvedValue({
    status: 'complete',
    reason: null,
    rows: [{ path: '', bytes: 100, files: 1 }],
    totalBytes: 100,
    files: 1,
    errors: 0,
    skipped: 0
  })
})
it('normalizes bare Windows mount letters and uses volume identity instead of a drive label', async () => {
  const volume = await identifyStorageVolume(path)
  expect(volume.id).toMatch(/^[a-f0-9]{64}$/)
  expect(volume.relativeRoot).not.toContain(':')
  expect(volume.size).toBe(1000)
})
it('rejects network filesystems and missing stable identities', async () => {
  mocks.sizes.mockResolvedValue([{ mount, type: 'cifs', size: 1000, available: 500 }])
  await expect(identifyStorageVolume(path)).rejects.toThrow('local filesystem')
  mocks.sizes.mockResolvedValue([{ mount, type: 'testfs', size: 1000, available: 500 }])
  mocks.blocks.mockResolvedValue([])
  await expect(identifyStorageVolume(path)).rejects.toThrow('identity')
})
it('records an incomplete attempt before walking so a crash cannot erase its existence', async () => {
  mocks.measure.mockImplementation(async () => {
    expect(mocks.saved).toEqual([
      expect.objectContaining({
        status: 'unavailable',
        reason: expect.stringContaining('interrupted')
      })
    ])
    expect(storageCaptureStatus()?.scopeId).toBe(mocks.scopes[0].id)
    return {
      status: 'complete',
      reason: null,
      rows: [],
      totalBytes: 100,
      files: 1,
      errors: 0,
      skipped: 0
    }
  })
  await captureStorageScope(mocks.scopes[0].id)
  expect(mocks.saved).toHaveLength(1)
  expect(mocks.saved[0].status).toBe('complete')
  expect(storageCaptureStatus()).toBeNull()
})
it('records a replacement drive as unavailable without scanning it', async () => {
  mocks.blocks.mockResolvedValue([
    { mount, uuid: 'different-volume', fsType: 'testfs', physical: 'Local' }
  ])
  expect((await captureStorageScope(mocks.scopes[0].id)).status).toBe('unavailable')
  expect(mocks.measure).not.toHaveBeenCalled()
})
it('only admits one concurrent capture', async () => {
  const results = await Promise.allSettled([
    captureStorageScope(mocks.scopes[0].id),
    captureStorageScope(mocks.scopes[0].id)
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(mocks.measure).toHaveBeenCalledTimes(1)
})
