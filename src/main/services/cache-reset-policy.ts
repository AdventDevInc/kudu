import type { ScanResult } from '../../shared/types'

/** Keep every item visible but unselected, so clearing it requires a local opt-in. */
export function requireLocalOptIn(result: ScanResult): ScanResult {
  for (const item of result.items) item.selected = false
  return result
}

/** Performance caches remain visible, but clearing them requires a local opt-in. */
export function applyCacheResetPolicy(result: ScanResult, cacheReset?: boolean): ScanResult {
  if (cacheReset) {
    result.group = 'Optional cache resets — next launch may be slower'
    for (const item of result.items) item.cacheReset = true
    requireLocalOptIn(result)
  }
  return result
}
