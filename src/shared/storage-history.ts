export interface StorageScope {
  id: string
  name: string
  path: string
  volumeId: string
  relativeRoot: string
  daily: boolean
  growthAlertBytes: number | null
  freeAlertPercent: number | null
  lastAttemptAt: string | null
  lastAlertAt: string | null
}
export interface StorageRow {
  path: string
  bytes: number
  files: number
}
export interface StorageSnapshot {
  version: 1
  id: string
  scopeId: string
  scopeKey: string
  createdAt: string
  durationMs: number
  status: 'complete' | 'partial' | 'cancelled' | 'unavailable'
  reason: string | null
  volumeId: string
  totalBytes: number
  files: number
  skipped: number
  errors: number
  volumeSize: number | null
  volumeFree: number | null
  rows: StorageRow[]
}
export type StorageSnapshotSummary = Omit<StorageSnapshot, 'rows'> & {
  metadataBytes: number
  checksum: string
}
export interface StorageComparison {
  comparable: boolean
  reason: string | null
  delta: number | null
  rows: Array<{
    path: string
    before: number | null
    after: number | null
    delta: number
    change: 'added' | 'removed' | 'changed'
  }>
}

export function compareStorageSnapshots(
  before: StorageSnapshot,
  after: StorageSnapshot
): StorageComparison {
  if (before.status !== 'complete' || after.status !== 'complete')
    return { comparable: false, reason: 'incomplete', delta: null, rows: [] }
  if (!before.scopeKey || before.scopeKey !== after.scopeKey || before.volumeId !== after.volumeId)
    return { comparable: false, reason: 'scope', delta: null, rows: [] }
  if (Date.parse(after.createdAt) <= Date.parse(before.createdAt))
    return { comparable: false, reason: 'order', delta: null, rows: [] }
  const old = new Map(before.rows.map((r) => [r.path, r.bytes])),
    next = new Map(after.rows.map((r) => [r.path, r.bytes]))
  const rows = [...new Set([...old.keys(), ...next.keys()])]
    .filter((path) => path !== '')
    .map((path) => ({
      path,
      before: old.get(path) ?? null,
      after: next.get(path) ?? null,
      delta: (next.get(path) ?? 0) - (old.get(path) ?? 0),
      change: !old.has(path)
        ? ('added' as const)
        : !next.has(path)
          ? ('removed' as const)
          : ('changed' as const)
    }))
    .filter((r) => r.delta !== 0 || r.change !== 'changed')
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  return { comparable: true, reason: null, delta: after.totalBytes - before.totalBytes, rows }
}

/** Estimates whole-volume capacity only from sufficiently stable free-space observations. */
export function projectStorageCapacity(snapshots: StorageSnapshotSummary[]) {
  const newest = [...snapshots].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  if (!newest || newest.status !== 'complete' || newest.volumeFree === null || !newest.volumeSize)
    return null
  const points = snapshots
    .filter(
      (s) =>
        s.status === 'complete' &&
        s.scopeKey === newest.scopeKey &&
        s.volumeId === newest.volumeId &&
        s.volumeSize === newest.volumeSize &&
        s.volumeFree !== null
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  // At most one observation per UTC day prevents manual burst captures implying confidence.
  const days = [...new Map(points.map((s) => [s.createdAt.slice(0, 10), s])).values()]
  if (days.length < 7) return null
  const span = (Date.parse(days.at(-1)!.createdAt) - Date.parse(days[0].createdAt)) / 86400000
  if (span < 7) return null
  const xs = days.map((s) => (Date.parse(s.createdAt) - Date.parse(days[0].createdAt)) / 86400000)
  const ys = days.map((s) => s.volumeSize! - s.volumeFree!)
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length,
    meanY = ys.reduce((a, b) => a + b, 0) / ys.length
  const sxx = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0)
  const slope = xs.reduce((sum, x, i) => sum + (x - meanX) * (ys[i] - meanY), 0) / sxx
  const residual = xs.reduce((sum, x, i) => sum + (ys[i] - (meanY + slope * (x - meanX))) ** 2, 0)
  const total = ys.reduce((sum, y) => sum + (y - meanY) ** 2, 0)
  const r2 = total > 0 ? 1 - residual / total : 0
  const margin = 2 * Math.sqrt(residual / (xs.length - 2) / sxx)
  if (slope <= 0 || slope - margin <= 0 || r2 < 0.8 || newest.volumeFree / slope > 3650) return null
  return {
    bytesPerDay: slope,
    daysRemaining: newest.volumeFree / slope,
    earliestDays: newest.volumeFree / (slope + margin),
    latestDays: newest.volumeFree / (slope - margin),
    observations: days.length,
    spanDays: span,
    r2
  }
}
