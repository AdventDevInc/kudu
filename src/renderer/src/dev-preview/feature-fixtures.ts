import {
  projectStorageCapacity,
  type StorageScope,
  type StorageSnapshotSummary
} from '@shared/storage-history'
import type { RecoveryEntry } from '@shared/recovery'
import type { DiagnosticSession } from '@shared/performance-diagnostics'
import { diagnosticsFixture } from './diagnostics-fixture'

const now = Date.now()
const GB = 1024 ** 3
const scope: StorageScope = {
  id: 'preview-folder',
  name: 'Downloads',
  path: 'C:\\Users\\Preview\\Downloads',
  volumeId: 'preview-disk',
  relativeRoot: 'Downloads',
  daily: false,
  growthAlertBytes: null,
  freeAlertPercent: null,
  lastAttemptAt: null,
  lastAlertAt: null
}
const snapshots: StorageSnapshotSummary[] = [0, 1, 2, 3, 4].map((i) => ({
  version: 1,
  id: 'snapshot-' + i,
  scopeId: scope.id,
  scopeKey: 'preview-downloads',
  createdAt: new Date(now - (4 - i) * 86400000 * 3).toISOString(),
  durationMs: 4800,
  status: 'complete',
  reason: null,
  volumeId: scope.volumeId,
  totalBytes: (24 + i * 2) * GB,
  files: 2300 + i * 200,
  skipped: 0,
  errors: 0,
  volumeSize: 512 * GB,
  volumeFree: (200 - i * 2) * GB,
  metadataBytes: 4096,
  checksum: 'preview'
}))
const entries: RecoveryEntry[] = ['Diagnostic data preference', 'Background service startup'].map(
  (label, i) => ({
    version: 1,
    id: 'recovery-' + i,
    createdAt: new Date(now - i * 86400000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    source: 'privacy',
    label,
    target: { kind: 'registry-dword', key: 'HKCU\\Software\\Preview', name: 'Setting' + i },
    before: 1,
    after: 0,
    status: i === 0 ? 'ready' : 'restored'
  })
)
const recording: DiagnosticSession = {
  title: 'Morning startup',
  notes: 'Browser and everyday apps opening.',
  pinned: false,
  state: 'saved',
  cloud: null,
  upload: null,
  recording: {
    version: 1,
    recordId: '00000000-0000-4000-8000-000000000002',
    startedAt: new Date(now - 600000).toISOString(),
    durationMs: 120000,
    system: {
      platform: 'win32',
      cpuModel: 'Intel Core i7-12700K',
      logicalCores: 20,
      totalMemoryBytes: 32 * GB,
      osVersion: 'Windows 11'
    },
    samples: Array.from({ length: 61 }, (_, i) => ({
      t: i * 2000,
      memoryPercent: ((8.4 + i * 0.01) / 32) * 100,
      cpuPercent: 18 + Math.round(Math.abs(Math.sin(i * 0.3)) * 42),
      memoryUsedBytes: (8.4 + i * 0.01) * GB,
      diskReadBytesPerSec: 2 * 1024 ** 2,
      diskWriteBytesPerSec: 1024 ** 2,
      processes: []
    }))
  }
}
export const featureReads = (empty: boolean) => ({
  ...diagnosticsFixture(recording, empty),
  diagnosticsCapabilities: () => ({
    available: true,
    requiredPlan: 'pro',
    retentionDays: 30,
    provider: 'Preview'
  }),
  recoveryList: () => ({
    entries: empty ? [] : entries,
    unreadable: [],
    total: empty ? 0 : entries.length,
    backups: [],
    gameMode: null
  }),
  storageHistoryList: () => ({
    scopes: empty ? [] : [scope],
    snapshots: empty ? [] : snapshots,
    total: empty ? 0 : snapshots.length,
    capture: null,
    projection: empty ? null : projectStorageCapacity(snapshots)
  }),
  scheduleRuntime: () => []
})
