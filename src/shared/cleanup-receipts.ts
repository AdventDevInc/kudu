import type { DeletionOrigin } from './types'

export type CleanupOutcome = 'deleted' | 'skipped' | 'failed'
export interface CleanupReceiptItem {
  id: string
  category: string
  path?: string
  outcome: CleanupOutcome
  reason: string
  attempted: boolean
  selectedBytes: number | null
  removedBytes: number
}
export interface CleanupReceipt {
  version: 1
  id: string
  parentId?: string
  startedAt: string
  completedAt: string
  origin: DeletionOrigin
  selected: number
  found: number | null
  unselected: number | null
  attempted: number
  deleted: number
  skipped: number
  failed: number
  selectedBytes: number
  unknownSizeItems: number
  removedBytes: number
  pathLogging: boolean
  volumeChanges?: Array<{ volume: string; freeBefore: number; freeAfter: number; delta: number }>
  reasons: Array<{ reason: string; count: number }>
  categories: Array<{ name: string; selected: number; removedBytes: number }>
  details: CleanupReceiptItem[]
  detailsTruncated: number
}

/** One terminal outcome per selected ID; descendants never inflate item counts. */
export function summarizeReceipt(
  meta: Pick<CleanupReceipt, 'id' | 'parentId' | 'startedAt' | 'origin' | 'pathLogging'> & {
    found?: number
  },
  items: CleanupReceiptItem[],
  completedAt = new Date().toISOString()
): CleanupReceipt {
  const unique = [...new Map(items.map((item) => [item.id, item])).values()]
  const reasons = new Map<string, number>()
  const categories = new Map<string, { name: string; selected: number; removedBytes: number }>()
  for (const item of unique) {
    if (item.reason) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1)
    const category = categories.get(item.category) ?? {
      name: item.category,
      selected: 0,
      removedBytes: 0
    }
    category.selected++
    category.removedBytes += item.removedBytes
    categories.set(item.category, category)
  }
  return {
    version: 1,
    ...meta,
    completedAt,
    selected: unique.length,
    found: meta.found ?? null,
    unselected: meta.found === undefined ? null : Math.max(0, meta.found - unique.length),
    attempted: unique.filter((i) => i.attempted).length,
    deleted: unique.filter((i) => i.outcome === 'deleted').length,
    skipped: unique.filter((i) => i.outcome === 'skipped').length,
    failed: unique.filter((i) => i.outcome === 'failed').length,
    selectedBytes: unique.reduce((sum, i) => sum + (i.selectedBytes ?? 0), 0),
    unknownSizeItems: unique.filter((i) => i.selectedBytes === null).length,
    removedBytes: unique.reduce((sum, i) => sum + i.removedBytes, 0),
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })),
    categories: [...categories.values()],
    details: unique
      .slice(0, 5000)
      .map(({ path, ...item }) => (meta.pathLogging ? { ...item, path } : item)),
    detailsTruncated: Math.max(0, unique.length - 5000)
  }
}
