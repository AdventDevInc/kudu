import { AppSpaceHandoffs } from '../services/app-space-handoffs'
import { ipcMain } from 'electron'
import { readdir } from 'fs/promises'
import { join } from 'path'
import { IPC } from '../../shared/channels'
import { CleanerType } from '../../shared/enums'
import type { AppSpaceReport, AppSpaceReview, ScanResult } from '../../shared/types'
import { getPlatform } from '../platform'
import { getInstalledProgramsFull } from '../services/program-uninstaller'
import { scanAppRule, scanDirectory } from '../services/file-utils'
import { cacheItems, removeCachedItems } from '../services/scan-cache'
import {
  BROWSER_CACHE_RECENCY,
  chromiumBrowsers,
  chromiumCacheTargets
} from '../services/chromium-cache'
import {
  buildAppSpaceEntries,
  uniqueAppSpaceMeasurements,
  type AppSpaceMeasurement
} from '../services/app-space'

interface SpaceRule {
  id: string
  name: string
  category: CleanerType
  scan: () => Promise<ScanResult[]>
}
async function getRules(): Promise<SpaceRule[]> {
  const paths = getPlatform().paths
  const rules: SpaceRule[] = []
  for (const [category, definitions] of [
    [CleanerType.App, paths.appPaths()],
    [CleanerType.Gaming, paths.gamingPaths()]
  ] as const) {
    for (const definition of definitions) {
      // Native command estimates can have side effects and unknown sizes; use file-based rules only.
      if (definition.cleanupAction) continue
      rules.push({
        id: `${category}:${definition.id}`,
        name: definition.name,
        category,
        scan: async () => [await scanAppRule(definition, category)]
      })
    }
  }
  const browsers = paths.browserPaths()
  for (const browser of chromiumBrowsers(browsers)) {
    rules.push({
      id: `browser:${browser.key}`,
      name: browser.label,
      category: CleanerType.Browser,
      scan: async () => {
        const results: ScanResult[] = []
        for (const target of await chromiumCacheTargets(browser))
          results.push(
            await scanDirectory(
              target.path,
              CleanerType.Browser,
              target.label,
              BROWSER_CACHE_RECENCY
            )
          )
        return results
      }
    })
  }
  for (const [key, name] of [
    ['firefox', 'Firefox'],
    ['librewolf', 'LibreWolf'],
    ['waterfox', 'Waterfox'],
    ['floorp', 'Floorp']
  ] as const) {
    const root = browsers[key].cache
    rules.push({
      id: `browser:${key}`,
      name,
      category: CleanerType.Browser,
      scan: async () => {
        const results: ScanResult[] = []
        if (!root) return results
        let profiles
        try {
          profiles = await readdir(root, { withFileTypes: true })
        } catch {
          return results
        }
        for (const profile of profiles.filter((entry) => entry.isDirectory()))
          results.push(
            await scanDirectory(
              join(root, profile.name, 'cache2', ...(key === 'firefox' ? ['entries'] : [])),
              CleanerType.Browser,
              `${name} - ${profile.name} Cache`,
              BROWSER_CACHE_RECENCY
            )
          )
        return results
      }
    })
  }
  // The platform exposes Safari only on macOS. Match the browser cleaner's
  // cache-only target, preserving cookies, history, bookmarks and profile data.
  if (browsers.safari) {
    const cache = browsers.safari.cache
    rules.push({
      id: 'browser:safari',
      name: 'Safari',
      category: CleanerType.Browser,
      scan: async () => [
        await scanDirectory(cache, CleanerType.Browser, 'Safari - Cache', BROWSER_CACHE_RECENCY)
      ]
    })
  }
  return rules
}
let scanning: Promise<AppSpaceReport> | null = null
export function registerAppSpaceIpc(): void {
  const handoffs = new AppSpaceHandoffs(removeCachedItems)
  let reviewing = false
  ipcMain.handle(IPC.APP_SPACE_SCAN, () => {
    if (scanning) return scanning
    scanning = (async () => {
      let inventoryAvailable = true
      const programs = await getInstalledProgramsFull().catch(() => {
        inventoryAvailable = false
        return []
      })
      const measurements: AppSpaceMeasurement[] = []
      let unavailableRules = 0
      for (const rule of await getRules()) {
        try {
          for (const result of await rule.scan()) measurements.push({ ...rule, result })
        } catch {
          unavailableRules++
        }
      }
      return {
        entries: buildAppSpaceEntries(programs, measurements),
        scannedAt: Date.now(),
        unavailableRules,
        inventoryAvailable
      }
    })().finally(() => {
      scanning = null
    })
    return scanning
  })
  ipcMain.handle(
    IPC.APP_SPACE_REVIEW,
    async (_event, ids: unknown, currentToken: unknown): Promise<AppSpaceReview> => {
      if (
        !Array.isArray(ids) ||
        ids.length > 50 ||
        !ids.every((id) => typeof id === 'string' && id.length < 200)
      )
        throw new Error('Invalid rule IDs')
      const wanted = new Set(ids)
      const rules = (await getRules()).filter((rule) => wanted.has(rule.id))
      if (rules.length !== wanted.size) throw new Error('Unknown cleanup rule')
      if (reviewing) throw new Error('App-space review already in progress')
      handoffs.begin(currentToken)
      reviewing = true
      try {
        const measurements: AppSpaceMeasurement[] = []
        for (const rule of rules)
          for (const result of await rule.scan()) measurements.push({ ...rule, result })
        const results = uniqueAppSpaceMeasurements(measurements)
          .map((measurement) => measurement.result)
          .filter((result) => result.items.length)
        const token = handoffs.create(
          results.flatMap((result) => result.items.map((item) => item.id))
        )
        for (const result of results) cacheItems(result.items)
        return { token, results }
      } finally {
        reviewing = false
      }
    }
  )
  ipcMain.handle(
    IPC.APP_SPACE_RETAIN,
    (_event, reviewToken: unknown, retainedToken: unknown): void => {
      handoffs.settle(reviewToken, retainedToken)
    }
  )
}
