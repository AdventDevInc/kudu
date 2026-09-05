import type { ScanResult } from '../../shared/types'

/** Performance caches remain visible, but clearing them requires a local opt-in. */
export function applyCacheResetPolicy(result: ScanResult, cacheReset?: boolean): ScanResult {
  if (cacheReset) {
    result.group = 'Optional cache resets — next launch may be slower'
    for (const item of result.items) {
      item.cacheReset = true
      item.selected = false
    }
  }
  return result
}
