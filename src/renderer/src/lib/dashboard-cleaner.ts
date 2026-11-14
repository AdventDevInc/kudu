import type { ScanResult } from '@shared/types'
import { isWindowsRollback } from '@shared/rollback-policy'

/** One-click cleaning cannot provide the per-group consent rollback removal needs. */
export function dashboardCleanIds(results: ScanResult[], excluded: Set<string>): string[] {
  return results
    .filter((result) => !excluded.has(result.subcategory) && !isWindowsRollback(result))
    .flatMap((result) =>
      result.items.filter((item) => item.selected !== false).map((item) => item.id)
    )
}
