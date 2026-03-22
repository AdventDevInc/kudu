import { readdir, stat } from 'fs/promises'
import { join, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/channels'
import type { WindowGetter } from '../ipc/index'
import { CleanerType } from '../../shared/enums'
import { getPlatform } from '../platform'
import { SAFE_FOLDER_NAMES, SAFE_PREFIXES } from '../constants/uninstall-safelist'
import { getDirectorySize } from './file-utils'
import type { ScanItem, ScanResult } from '../../shared/types'

const execFileAsync = promisify(execFile)

interface InstalledProgram {
  displayName: string
  publisher: string
  installLocation: string
}

/**
 * Query the Windows Registry for all currently installed programs.
 * Reads from HKLM (64-bit), HKLM WOW6432Node (32-bit), and HKCU.
 */
async function getInstalledPrograms(): Promise<InstalledProgram[]> {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]

  const programs: InstalledProgram[] = []

  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/s'], {
        timeout: 20000,
        maxBuffer: 10 * 1024 * 1024,
      })

      // Split into registry key blocks
      const blocks = stdout.split(/\r?\n\r?\n/)
      for (const block of blocks) {
        const displayNameMatch = block.match(/DisplayName\s+REG_SZ\s+(.+)/i)
        if (!displayNameMatch) continue

        const displayName = displayNameMatch[1].trim()
        const publisherMatch = block.match(/Publisher\s+REG_SZ\s+(.+)/i)
        const installLocMatch = block.match(/InstallLocation\s+REG_SZ\s+(.+)/i)

        programs.push({
          displayName,
          publisher: publisherMatch ? publisherMatch[1].trim() : '',
          installLocation: installLocMatch ? installLocMatch[1].trim().replace(/\\$/, '') : '',
        })
      }
    } catch {
      // Registry key may not exist or access denied — skip
    }
  }

  return programs
}

/**
 * Build a set of normalized tokens from installed programs for matching.
 * These tokens represent folder names we'd expect to see for installed software.
 */
function buildMatchTokens(programs: InstalledProgram[]): Set<string> {
  const tokens = new Set<string>()

  for (const prog of programs) {
    const name = prog.displayName.toLowerCase().trim()
    if (name.length >= 2) {
      tokens.add(name)

      // Add first word if it's substantial (e.g., "Discord" from "Discord Inc")
      const firstWord = name.split(/[\s\-_.()]+/)[0]
      if (firstWord && firstWord.length >= 3) {
        tokens.add(firstWord)
      }

      // Add name without version numbers (e.g., "Visual Studio Code" from "Visual Studio Code 1.85")
      const withoutVersion = name.replace(/\s+[\d.]+\s*$/, '').trim()
      if (withoutVersion.length >= 3 && withoutVersion !== name) {
        tokens.add(withoutVersion)
      }
    }

    // Publisher name
    const publisher = prog.publisher.toLowerCase().trim()
    if (publisher.length >= 3) {
      tokens.add(publisher)
      // First word of publisher
      const pubFirst = publisher.split(/[\s\-_.()]+/)[0]
      if (pubFirst && pubFirst.length >= 3) {
        tokens.add(pubFirst)
      }
    }

    // Folder name from install location
    if (prog.installLocation) {
      const folder = basename(prog.installLocation).toLowerCase()
      if (folder.length >= 2) {
        tokens.add(folder)
      }
      // Also add parent folder for paths like "C:\Program Files\Company\App"
      const parent = basename(join(prog.installLocation, '..'))?.toLowerCase()
      if (parent && parent.length >= 3) {
        tokens.add(parent)
      }
    }
  }

  return tokens
}

/**
 * Conservative fuzzy matching — returns true if the folder likely belongs
 * to an installed program (meaning: do NOT flag it as a leftover).
 */
function matchesInstalledProgram(folderName: string, tokens: Set<string>): boolean {
  const lower = folderName.toLowerCase()

  // Exact match
  if (tokens.has(lower)) return true

  // Check if any token contains the folder name or vice versa (min 4 char overlap)
  for (const token of tokens) {
    // Folder name is within a token (e.g., folder "discord" in token "discord inc")
    if (token.length >= 4 && lower.length >= 4) {
      if (token.includes(lower) || lower.includes(token)) return true
    }

    // Starts with or ends with (e.g., folder "steamcmd" starts with token "steam")
    if (token.length >= 4) {
      if (lower.startsWith(token) || lower.endsWith(token)) return true
    }
    if (lower.length >= 4) {
      if (token.startsWith(lower) || token.endsWith(lower)) return true
    }
  }

  return false
}

/**
 * Check if a folder (or its immediate children) was modified recently.
 */
async function isRecentlyModified(dirPath: string, thresholdDays: number): Promise<boolean> {
  const cutoff = Date.now() - thresholdDays * 24 * 60 * 60 * 1000

  try {
    // Check the directory itself
    const dirStat = await stat(dirPath)
    if (dirStat.mtimeMs > cutoff) return true

    // Sample immediate children
    const entries = await readdir(dirPath, { withFileTypes: true })
    const sample = entries.slice(0, 20) // Check first 20 entries for speed
    for (const entry of sample) {
      try {
        const childStat = await stat(join(dirPath, entry.name))
        if (childStat.mtimeMs > cutoff) return true
      } catch {
        // Skip inaccessible
      }
    }
  } catch {
    // If we can't stat it, assume it's recent (err on side of caution)
    return true
  }

  return false
}

/**
 * Check if any running process has executables inside the given folder.
 * Uses a single PowerShell call with a short timeout.
 */
async function hasRunningProcesses(folderPaths: string[]): Promise<Set<string>> {
  const running = new Set<string>()
  if (folderPaths.length === 0) return running

  try {
    // Get all running process paths in one call
    const procScript = 'Get-Process | Where-Object { $_.Path } | Select-Object -ExpandProperty Path -Unique'
    const procEncoded = Buffer.from(procScript, 'utf16le').toString('base64')
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-NoLogo', '-EncodedCommand', procEncoded,
    ], { timeout: 10000, windowsHide: true })

    const processPaths = stdout
      .split(/\r?\n/)
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)

    for (const folderPath of folderPaths) {
      const folderLower = folderPath.toLowerCase().replace(/\//g, '\\')
      for (const procPath of processPaths) {
        if (procPath.startsWith(folderLower + '\\')) {
          running.add(folderPath)
          break
        }
      }
    }
  } catch {
    // If PowerShell fails, mark nothing as running (we have other safety layers)
  }

  return running
}

/**
 * Check if a folder name is safe based on the safelist.
 */
function isSafeFolder(folderName: string): boolean {
  const lower = folderName.toLowerCase()

  // Exact match in safelist
  if (SAFE_FOLDER_NAMES.has(lower)) return true

  // Prefix match
  for (const prefix of SAFE_PREFIXES) {
    if (lower.startsWith(prefix)) return true
  }

  // Skip hidden folders (starting with .)
  if (lower.startsWith('.')) return true

  // Skip GUID-style folders {xxxxxxxx-xxxx-...}
  if (/^\{[0-9a-f-]+\}$/i.test(folderName)) return true

  return false
}

/**
 * Main scan function: finds potential uninstall leftovers.
 * Uses 5 safety layers:
 *   1. Comprehensive safelist
 *   2. Registry cross-reference with fuzzy matching
 *   3. Recency check (skip folders modified within last 30 days)
 *   4. Running process check
 *   5. Minimum size threshold
 */
export async function scanForLeftovers(getWindow: WindowGetter): Promise<ScanResult[]> {
  const results: ScanResult[] = []
  const category = CleanerType.UninstallLeftovers

  const safeSend = (channel: string, data: object) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, data)
  }

  // Step 1: Get installed programs from registry
  safeSend(IPC.SCAN_PROGRESS, {
    phase: 'scanning',
    category,
    currentPath: 'Querying installed programs...',
    progress: 5,
    itemsFound: 0,
    sizeFound: 0,
  })

  const programs = await getInstalledPrograms()
  const matchTokens = buildMatchTokens(programs)

  // Step 2: Scan each target directory
  const leftoverDirs = getPlatform().paths.uninstallLeftoverDirs()
  const totalDirs = leftoverDirs.length
  let totalItemsFound = 0
  let totalSizeFound = 0

  for (let dirIdx = 0; dirIdx < totalDirs; dirIdx++) {
    const target = leftoverDirs[dirIdx]
    const items: ScanItem[] = []

    safeSend(IPC.SCAN_PROGRESS, {
      phase: 'scanning',
      category,
      currentPath: `Scanning ${target.name}...`,
      progress: 10 + Math.round((dirIdx / totalDirs) * 70),
      itemsFound: totalItemsFound,
      sizeFound: totalSizeFound,
    })

    // Read top-level folders
    let entries: import('fs').Dirent<string>[]
    try {
      entries = await readdir(target.path, { withFileTypes: true, encoding: 'utf-8' })
    } catch {
      continue // Directory doesn't exist or access denied
    }

    // Collect candidate folders (pass safelist + registry checks first)
    const candidates: { name: string; fullPath: string }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const folderName = entry.name
      const fullPath = join(target.path, folderName)

      // Safety layer 1: Safelist
      if (isSafeFolder(folderName)) continue

      // Safety layer 2: Registry cross-reference
      if (matchesInstalledProgram(folderName, matchTokens)) continue

      candidates.push({ name: folderName, fullPath })
    }

    if (candidates.length === 0) continue

    // Safety layer 4: Batch running process check
    const runningFolders = await hasRunningProcesses(candidates.map((c) => c.fullPath))

    for (const candidate of candidates) {
      // Skip folders with running processes
      if (runningFolders.has(candidate.fullPath)) continue

      // Safety layer 3: Recency check — skip if modified within 30 days
      const recent = await isRecentlyModified(candidate.fullPath, 30)
      if (recent) continue

      // Safety layer 5: Minimum size (skip near-empty folders, not worth flagging)
      let size: number
      try {
        size = await getDirectorySize(candidate.fullPath, 2)
      } catch {
        continue
      }
      if (size < 1024) continue // Less than 1 KB

      let folderStat: Awaited<ReturnType<typeof stat>>
      try {
        folderStat = await stat(candidate.fullPath)
      } catch {
        continue
      }

      items.push({
        id: randomUUID(),
        path: candidate.fullPath,
        size,
        category,
        subcategory: target.name,
        lastModified: folderStat.mtimeMs,
        selected: false, // NEVER auto-select leftovers
      })

      totalItemsFound++
      totalSizeFound += size

      // Cap at 100 items per directory to avoid overwhelming results
      if (items.length >= 100) break
    }

    if (items.length > 0) {
      results.push({
        category,
        subcategory: target.name,
        items,
        totalSize: items.reduce((s, i) => s + i.size, 0),
        itemCount: items.length,
      })
    }
  }

  safeSend(IPC.SCAN_PROGRESS, {
    phase: 'scanning',
    category,
    currentPath: 'Leftover scan complete',
    progress: 100,
    itemsFound: totalItemsFound,
    sizeFound: totalSizeFound,
  })

  return results
}
