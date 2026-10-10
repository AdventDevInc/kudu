import { CleanerType } from './enums'
import type { ScanResult } from './types'
export const AI_TOOLS_VIEW = 'aiTools' as const
export const AI_TOOLS_GROUP = 'AI Tools'
export type AppSpaceCleanerView =
  CleanerType.App | CleanerType.Gaming | CleanerType.Browser | typeof AI_TOOLS_VIEW
export function getAppSpaceCleanerView(results: ScanResult[]): {
  appSpaceCategory: AppSpaceCleanerView
  appSpaceAll: boolean
} {
  const views = new Set(
    results.map((result) =>
      result.category === CleanerType.App && result.group === AI_TOOLS_GROUP
        ? AI_TOOLS_VIEW
        : result.category
    )
  )
  const first = views.values().next().value
  const category =
    first === AI_TOOLS_VIEW || first === CleanerType.Gaming || first === CleanerType.Browser
      ? first
      : CleanerType.App
  return { appSpaceCategory: category, appSpaceAll: views.size > 1 }
}
