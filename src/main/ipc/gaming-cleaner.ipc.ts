import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/channels'
import { getPlatform } from '../platform'
import { scanDirectoriesAsItems, cleanItems, getDirectorySize } from '../services/file-utils'
import { cacheItems } from '../services/scan-cache'
import { CleanerType } from '../../shared/enums'
import type { ScanItem, ScanResult, CleanResult } from '../../shared/types'
import type { WindowGetter } from './index'
import { validateStringArray } from '../services/ipc-validation'

export function registerGamingCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.GAMING_SCAN, async (): Promise<ScanResult[]> => {
    const results: ScanResult[] = []
    const category = CleanerType.Gaming

    // Launcher caches — directory-level items, one row per launcher
    for (const launcher of getPlatform().paths.gamingPaths()) {
      try {
        const result = await scanDirectoriesAsItems(
          launcher.paths, category, launcher.name, 'Launcher Caches'
        )
        if (result.items.length > 0) {
          cacheItems(result.items)
          results.push(result)
        }
      } catch {
        // Skip
      }
    }

    // GPU shader caches — directory-level items, one row per vendor
    for (const gpu of getPlatform().paths.gpuCachePaths()) {
      try {
        const result = await scanDirectoriesAsItems(
          gpu.paths, category, gpu.name, 'GPU Shader Caches'
        )
        if (result.items.length > 0) {
          cacheItems(result.items)
          results.push(result)
        }
      } catch {
        // Skip
      }
    }

    // Per-game Steam shader caches — one row per game
    try {
      const shaderResults = await scanSteamShaderCaches(category)
      for (const r of shaderResults) cacheItems(r.items)
      results.push(...shaderResults)
    } catch {
      // Skip
    }

    // Per-game redistributables — one row per game
    try {
      const redistResults = await scanSteamRedistributables(category)
      for (const r of redistResults) cacheItems(r.items)
      results.push(...redistResults)
    } catch {
      // Skip
    }

    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SCAN_PROGRESS, {
      phase: 'scanning',
      category,
      currentPath: 'Gaming scan complete',
      progress: 100,
      itemsFound: results.reduce((s, r) => s + r.itemCount, 0),
      sizeFound: results.reduce((s, r) => s + r.totalSize, 0),
    })

    return results
  })

  ipcMain.handle(IPC.GAMING_CLEAN, async (_event, itemIds: string[]): Promise<CleanResult> => {
    const valid = validateStringArray(itemIds)
    if (!valid) return { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [], needsElevation: false }
    return cleanItems(valid, (processed, total, currentPath, cleanedSize) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(IPC.SCAN_PROGRESS, {
        phase: 'cleaning',
        category: CleanerType.Gaming,
        currentPath,
        progress: (processed / total) * 100,
        itemsFound: total,
        sizeFound: cleanedSize,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Steam library discovery
// ---------------------------------------------------------------------------

async function getSteamLibraryPaths(): Promise<string[]> {
  const libraries: Set<string> = new Set()

  for (const steamDir of getPlatform().paths.steamLibraries()) {
    const vdfPath = join(steamDir, 'steamapps', 'libraryfolders.vdf')
    try {
      const content = await readFile(vdfPath, 'utf-8')
      const pathMatches = content.matchAll(/"path"\s+"([^"]+)"/g)
      for (const match of pathMatches) {
        libraries.add(match[1].replace(/\\\\/g, '\\'))
      }
    } catch {
      // VDF not found
    }
  }

  for (const dir of getPlatform().paths.steamLibraries()) {
    if (existsSync(join(dir, 'steamapps'))) {
      libraries.add(dir)
    }
  }

  return Array.from(libraries)
}

async function buildAppIdMap(steamAppsDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const files = await readdir(steamAppsDir)
    for (const file of files) {
      if (!file.startsWith('appmanifest_') || !file.endsWith('.acf')) continue
      try {
        const content = await readFile(join(steamAppsDir, file), 'utf-8')
        const idMatch = content.match(/"appid"\s+"(\d+)"/)
        const nameMatch = content.match(/"name"\s+"([^"]+)"/)
        if (idMatch && nameMatch) {
          map.set(idMatch[1], nameMatch[1])
        }
      } catch {
        // Skip unreadable manifest
      }
    }
  } catch {
    // Skip
  }
  return map
}

// ---------------------------------------------------------------------------
// Per-game Steam shader caches
// ---------------------------------------------------------------------------

async function scanSteamShaderCaches(category: string): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const libraries = await getSteamLibraryPaths()

  for (const libPath of libraries) {
    const steamAppsDir = join(libPath, 'steamapps')
    const shaderDir = join(steamAppsDir, 'shadercache')
    if (!existsSync(shaderDir)) continue

    const appIdMap = await buildAppIdMap(steamAppsDir)

    try {
      const entries = await readdir(shaderDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const cacheDir = join(shaderDir, entry.name)

        try {
          const size = await getDirectorySize(cacheDir)
          if (size < 1024) continue

          const gameName = appIdMap.get(entry.name) || `Unknown (${entry.name})`
          const subcategory = `${gameName} — Shader Cache`

          results.push({
            category,
            subcategory,
            group: 'Game Shader Caches',
            items: [{
              id: randomUUID(),
              path: cacheDir,
              size,
              category,
              subcategory,
              lastModified: Date.now(),
              selected: true,
            }],
            totalSize: size,
            itemCount: 1,
          })
        } catch {
          // Skip
        }
      }
    } catch {
      // Skip
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Per-game redistributables
// ---------------------------------------------------------------------------

async function scanSteamRedistributables(category: string): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const libraries = await getSteamLibraryPaths()

  for (const libPath of libraries) {
    const commonDir = join(libPath, 'steamapps', 'common')
    if (!existsSync(commonDir)) continue

    try {
      const games = await readdir(commonDir, { withFileTypes: true })

      for (const game of games) {
        if (!game.isDirectory()) continue
        const gameDir = join(commonDir, game.name)
        const gameItems: ScanItem[] = []
        let gameSize = 0
        const subcategory = `${game.name} — Redistributables`

        // Check top-level redist patterns
        for (const pattern of getPlatform().paths.steamRedistPatterns()) {
          const redistPath = join(gameDir, pattern)
          if (!existsSync(redistPath)) continue

          try {
            const stats = await stat(redistPath)
            const size = stats.isDirectory()
              ? await getDirectorySize(redistPath)
              : stats.size

            if (size < 1024) continue

            gameItems.push({
              id: randomUUID(),
              path: redistPath,
              size,
              category,
              subcategory,
              lastModified: stats.mtimeMs,
              selected: true,
            })
            gameSize += size
          } catch {
            // Skip
          }
        }

        // Also scan one level deep for redist folders inside subdirs
        try {
          const subdirs = await readdir(gameDir, { withFileTypes: true })
          for (const sub of subdirs) {
            if (!sub.isDirectory()) continue
            for (const pattern of getPlatform().paths.steamRedistPatterns()) {
              const redistPath = join(gameDir, sub.name, pattern)
              if (!existsSync(redistPath)) continue
              // Avoid duplicates
              if (gameItems.some(i => i.path === redistPath)) continue

              try {
                const stats = await stat(redistPath)
                const size = stats.isDirectory()
                  ? await getDirectorySize(redistPath)
                  : stats.size

                if (size < 1024) continue

                gameItems.push({
                  id: randomUUID(),
                  path: redistPath,
                  size,
                  category,
                  subcategory,
                  lastModified: stats.mtimeMs,
                  selected: true,
                })
                gameSize += size
              } catch {
                // Skip
              }
            }
          }
        } catch {
          // Skip
        }

        if (gameItems.length > 0) {
          results.push({
            category,
            subcategory,
            group: 'Redistributables',
            items: gameItems,
            totalSize: gameSize,
            itemCount: gameItems.length,
          })
        }
      }
    } catch {
      // Skip
    }
  }

  return results
}
