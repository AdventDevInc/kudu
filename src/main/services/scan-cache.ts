import type { ScanItem } from '../../shared/types'

/**
 * In-memory cache of scan results so clean handlers can look up
 * item paths by ID. Each scan replaces the previous cache for that category.
 */
const itemCache = new Map<string, ScanItem>()

export function cacheItems(items: ScanItem[]): void {
  // Do not evict live scan results here. The renderer can legitimately hold
  // more than 50k items (browser caches commonly do), and dropping the oldest
  // IDs makes Clean silently ignore files that are still visible and selected.
  // Scanner entry points replace their category via clearCachedCategory(), and
  // successful clean calls remove their own IDs, which bounds stale entries
  // without making the displayed scan uncleanable.
  for (const item of items) {
    itemCache.set(item.id, item)
  }
}

/** Remove results from an older scan while preserving the other categories. */
export function clearCachedCategory(category: string): void {
  for (const [id, item] of itemCache) {
    if (item.category === category) itemCache.delete(id)
  }
}

/** Drop IDs once a clean has consumed them. */
export function removeCachedItems(ids: string[]): void {
  for (const id of ids) itemCache.delete(id)
}

export function getCachedItem(id: string): ScanItem | undefined {
  return itemCache.get(id)
}

export function getCachedItems(ids: string[]): ScanItem[] {
  const items: ScanItem[] = []
  for (const id of ids) {
    const item = itemCache.get(id)
    if (item) items.push(item)
  }
  return items
}

export function clearCache(): void {
  itemCache.clear()
}
