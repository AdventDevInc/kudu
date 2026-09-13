import { expect, it } from 'vitest'
import {
  compareStorageSnapshots,
  projectStorageCapacity,
  type StorageSnapshot,
  type StorageSnapshotSummary
} from './storage-history'
const snapshot: StorageSnapshot = {
  version: 1,
  id: 'one',
  scopeId: 'scope',
  scopeKey: 'same-policy',
  createdAt: '2026-09-01T12:00:00Z',
  durationMs: 100,
  status: 'complete',
  reason: null,
  volumeId: 'volume-a',
  totalBytes: 100,
  files: 1,
  skipped: 0,
  errors: 0,
  volumeSize: 10000,
  volumeFree: 5000,
  rows: [
    { path: '', bytes: 100, files: 1 },
    { path: 'old', bytes: 100, files: 1 }
  ]
}
it('compares complete folders without claiming renamed paths are the same application', () => {
  const after = {
    ...snapshot,
    id: 'two',
    createdAt: '2026-09-02T12:00:00Z',
    totalBytes: 150,
    rows: [
      { path: '', bytes: 150, files: 1 },
      { path: 'new', bytes: 150, files: 1 }
    ]
  }
  expect(compareStorageSnapshots(snapshot, after)).toMatchObject({
    comparable: true,
    delta: 50,
    rows: [
      { path: 'new', change: 'added', before: null, after: 150 },
      { path: 'old', change: 'removed', before: 100, after: null }
    ]
  })
})
it('does not turn partial scans, offline volumes, or changed exclusions into savings', () => {
  for (const change of [
    { status: 'partial' },
    { status: 'unavailable' },
    { status: 'cancelled' },
    { scopeKey: 'different-exclusions' },
    { volumeId: 'replacement-drive' },
    { createdAt: snapshot.createdAt }
  ])
    expect(
      compareStorageSnapshots(snapshot, {
        ...snapshot,
        createdAt: '2026-09-02T12:00:00Z',
        ...change
      } as StorageSnapshot).comparable
    ).toBe(false)
})
const trend = (count = 8): StorageSnapshotSummary[] =>
  Array.from({ length: count }, (_, i) => ({
    ...snapshot,
    id: String(i),
    createdAt: new Date(Date.UTC(2026, 8, 1 + i, 12)).toISOString(),
    metadataBytes: 100,
    checksum: 'f'.repeat(64),
    volumeFree: 5000 - i * 100
  }))
it('projects stable growth only after seven days of comparable daily observations', () => {
  expect(projectStorageCapacity(trend(6))).toBeNull()
  expect(projectStorageCapacity(trend(7))).toBeNull() // seven observations span only six days
  expect(projectStorageCapacity(trend())).toMatchObject({
    bytesPerDay: 100,
    daysRemaining: 43,
    observations: 8
  })
})
it('suppresses flat, shrinking, unstable and incompatible series', () => {
  expect(projectStorageCapacity(trend().map((s) => ({ ...s, volumeFree: 5000 })))).toBeNull()
  expect(
    projectStorageCapacity(trend().map((s, i) => ({ ...s, volumeFree: 5000 + i * 100 })))
  ).toBeNull()
  expect(
    projectStorageCapacity(trend().map((s, i) => ({ ...s, volumeFree: i % 2 ? 3000 : 8000 })))
  ).toBeNull()
  expect(
    projectStorageCapacity(trend().map((s, i) => ({ ...s, scopeKey: i > 3 ? 'new' : 'old' })))
  ).toBeNull()
  expect(
    projectStorageCapacity(trend().map((s, i) => (i === 7 ? { ...s, volumeSize: 20000 } : s)))
  ).toBeNull()
})
it('uses free-space observations from partial and cancelled walks', () => {
  expect(
    projectStorageCapacity(
      trend().map((s, i) => ({ ...s, status: i % 2 ? 'partial' : 'cancelled' }))
    )
  ).toMatchObject({ observations: 8 })
})
it('manual capture bursts do not satisfy the daily observation requirement', () => {
  expect(
    projectStorageCapacity(
      trend().map((s, i) => ({
        ...s,
        createdAt: new Date(Date.UTC(2026, 8, 1, 12, i)).toISOString()
      }))
    )
  ).toBeNull()
})
