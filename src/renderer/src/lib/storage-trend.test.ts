import { describe, expect, it } from 'vitest'
import { storageTrend } from './storage-trend'
import type { StorageSnapshotSummary } from '@shared/storage-history'

const snapshot = (day: number, overrides: Partial<StorageSnapshotSummary> = {}) =>
  ({
    createdAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`,
    totalBytes: day * 100,
    status: 'complete',
    scopeKey: 'folder-a',
    volumeId: 'disk-a',
    ...overrides
  }) as StorageSnapshotSummary
describe('storage trend comparability', () => {
  it('orders complete snapshots without mixing folders, volumes, or partial totals', () => {
    const result = storageTrend([
      snapshot(5),
      snapshot(4, { status: 'partial' }),
      snapshot(2, { volumeId: 'disk-b' }),
      snapshot(3, { scopeKey: 'folder-b' }),
      snapshot(1)
    ])
    expect(result.map((point) => point.bytes)).toEqual([100, 500])
  })
  it('leaves unknown or missing history empty', () => {
    expect(storageTrend([])).toEqual([])
    expect(storageTrend([snapshot(1, { scopeKey: '' })])).toEqual([])
    expect(storageTrend([snapshot(1, { status: 'unavailable' })])).toEqual([])
  })
})
