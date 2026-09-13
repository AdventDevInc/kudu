import type { StorageSnapshotSummary } from '@shared/storage-history'

export function storageTrend(snapshots: StorageSnapshotSummary[]) {
  const complete = snapshots
    .filter((s) => s.status === 'complete')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const latest = complete.at(-1)
  if (!latest?.scopeKey) return []
  return complete
    .filter((s) => s.scopeKey === latest.scopeKey && s.volumeId === latest.volumeId)
    .map((s) => ({ time: Date.parse(s.createdAt), bytes: s.totalBytes }))
}
