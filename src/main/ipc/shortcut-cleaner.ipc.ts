import { ipcMain } from 'electron'
import { readdir, readFile, stat, readlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { IPC } from '../../shared/channels'
import { CleanerType } from '../../shared/enums'
import { cacheItems, clearCachedCategory } from '../services/scan-cache'
import { cleanItems, expandExclusions, isExcluded, resolveScanRoot } from '../services/file-utils'
import { getSettings } from '../services/settings-store'
import { validateStringArray } from '../services/ipc-validation'
import type { ScanItem, ScanResult, CleanResult } from '../../shared/types'
import type { WindowGetter } from './index'
import { psUtf8 } from '../services/exec-utf8'
import {
  checkShortcutTarget,
  probePath,
  type PathState,
  type ShortcutInfo
} from '../services/shortcut-target'

const execFileAsync = promisify(execFile)

// ── Shortcut target resolution ──

/**
 * Resolve the target of a Windows .lnk shortcut using PowerShell.
 * Returns target paths for all .lnk files in the given directory. Excluded
 * folders are pruned inside the walk, so they are never enumerated or opened.
 */
export async function resolveWinShortcuts(
  dir: string,
  exclusions: string[] = []
): Promise<ShortcutInfo[]> {
  if (!existsSync(dir)) return []
  // Every result is a .lnk, so a *.lnk exclusion rules out the whole folder.
  if (
    isExcluded(
      join(dir, 'x.lnk'),
      exclusions.filter((e) => e.startsWith('*.'))
    )
  )
    return []
  // Path exclusions travel as base64 JSON data, never as script text.
  const pruned = exclusions
    .filter((e) => !e.startsWith('*.'))
    .map((e) => e.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase())
  const payload = Buffer.from(JSON.stringify(pruned), 'utf8').toString('base64')
  try {
    const psScript = `
$shell = New-Object -ComObject WScript.Shell
$ex = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json)
function Skip($p) {
  $l = $p.ToLowerInvariant()
  foreach ($e in $ex) { if ($l -eq $e -or $l.StartsWith($e + [char]92)) { return $true } }
  return $false
}
function Walk($d) {
  Get-ChildItem -LiteralPath $d -ErrorAction SilentlyContinue | ForEach-Object {
    if (Skip $_.FullName) { return }
    if ($_.PSIsContainer) { Walk $_.FullName }
    elseif ($_.Extension -ieq '.lnk') {
      try {
        $sc = $shell.CreateShortcut($_.FullName)
        "$($_.FullName)|$($sc.TargetPath)"
      } catch { "$($_.FullName)|" }
    }
  }
}
Walk '${dir.replace(/'/g, "''")}'`
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', psUtf8(psScript)],
      { timeout: 30000, windowsHide: true }
    )

    const results: ShortcutInfo[] = []
    for (const line of stdout.trim().split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const sepIdx = trimmed.lastIndexOf('|')
      if (sepIdx < 0) continue
      const shortcutPath = trimmed.substring(0, sepIdx)
      const targetPath = trimmed.substring(sepIdx + 1).trim() || null
      results.push({ path: shortcutPath, targetPath })
    }
    return results
  } catch {
    return []
  }
}

/**
 * Check if a binary name can be found in common PATH directories.
 */
function binaryExistsInPath(binary: string): boolean {
  const pathDirs = (process.env.PATH || '').split(':').filter(Boolean)
  for (const dir of pathDirs) {
    if (existsSync(join(dir, binary))) return true
  }
  return false
}

async function resolveLinuxDesktopFiles(
  dir: string,
  exclusions: string[] = []
): Promise<ShortcutInfo[]> {
  if (!existsSync(dir)) return []
  const results: ShortcutInfo[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.name.endsWith('.desktop')) continue
      const fullPath = join(dir, entry.name)
      // Never open an excluded entry
      if (isExcluded(fullPath, exclusions)) continue
      try {
        const content = await readFile(fullPath, 'utf-8')
        const execMatch = content.match(/^Exec\s*=\s*(.+)$/m)
        if (execMatch) {
          // Extract the binary path (first token, strip field codes like %u %f)
          const execLine = execMatch[1].trim()
          const binary = execLine.split(/\s+/)[0].replace(/^["']|["']$/g, '')
          // Resolve to full path: if it's already absolute, use as-is;
          // otherwise check PATH directories
          let resolvedPath: string | null = null
          if (binary && binary.startsWith('/')) {
            resolvedPath = binary
          } else if (binary) {
            // Check if the binary exists anywhere in PATH
            resolvedPath = binaryExistsInPath(binary) ? binary : null
          }
          results.push({ path: fullPath, targetPath: resolvedPath })
        } else {
          results.push({ path: fullPath, targetPath: null })
        }
      } catch {
        results.push({ path: fullPath, targetPath: null })
      }
    }
  } catch {
    // Directory inaccessible
  }
  return results
}

/**
 * Resolve macOS alias/symlink targets in a directory.
 */
async function resolveMacAliases(dir: string, exclusions: string[] = []): Promise<ShortcutInfo[]> {
  if (!existsSync(dir)) return []
  const results: ShortcutInfo[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      // Never read an excluded entry
      if (isExcluded(fullPath, exclusions)) continue
      try {
        if (entry.isSymbolicLink()) {
          const target = await readlink(fullPath)
          results.push({ path: fullPath, targetPath: resolve(dir, target) })
        }
      } catch {
        results.push({ path: fullPath, targetPath: null })
      }
    }
  } catch {
    // Directory inaccessible
  }
  return results
}

// ── Shortcut directories by platform ──

function getShortcutDirs(): { path: string; subcategory: string }[] {
  const home = homedir()

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return [
      { path: join(home, 'Desktop'), subcategory: 'Desktop Shortcuts' },
      {
        path: join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        subcategory: 'Start Menu Shortcuts'
      },
      {
        path: join(
          appData,
          'Microsoft',
          'Internet Explorer',
          'Quick Launch',
          'User Pinned',
          'TaskBar'
        ),
        subcategory: 'Taskbar Shortcuts'
      },
      {
        path: join(
          process.env.PROGRAMDATA || 'C:\\ProgramData',
          'Microsoft',
          'Windows',
          'Start Menu',
          'Programs'
        ),
        subcategory: 'All Users Start Menu'
      },
      {
        path: join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),
        subcategory: 'Public Desktop Shortcuts'
      }
    ]
  }

  if (process.platform === 'darwin') {
    return [
      { path: join(home, 'Desktop'), subcategory: 'Desktop Aliases' },
      { path: join(home, 'Applications'), subcategory: 'User Applications' }
    ]
  }

  // Linux
  return [
    { path: join(home, 'Desktop'), subcategory: 'Desktop Shortcuts' },
    {
      path: join(home, '.local', 'share', 'applications'),
      subcategory: 'User Application Entries'
    },
    { path: '/usr/share/applications', subcategory: 'System Application Entries' }
  ]
}

// ── IPC registration ──

export function registerShortcutCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.SHORTCUT_SCAN, async (): Promise<ScanResult[]> => {
    clearCachedCategory(CleanerType.Shortcut)
    const results: ScanResult[] = []
    const category = CleanerType.Shortcut
    const dirs = getShortcutDirs()
    const isWin = process.platform === 'win32'
    const isMac = process.platform === 'darwin'
    const exclusions = await expandExclusions(getSettings().exclusions)

    // One lookup per path per scan: many shortcuts share a drive root.
    const probed = new Map<string, Promise<PathState>>()
    const probe = (path: string): Promise<PathState> => {
      let state = probed.get(path)
      if (!state) probed.set(path, (state = probePath(path)))
      return state
    }

    for (const dir of dirs) {
      // Never enumerate a globally excluded shortcut directory. Resolve it
      // first: a Desktop that is a link into an excluded tree must not be read
      // (or cleaned) through its alias.
      const root = await resolveScanRoot(dir.path, exclusions)
      if (!root) continue
      try {
        let shortcuts: ShortcutInfo[]
        if (isWin) {
          shortcuts = await resolveWinShortcuts(root, exclusions)
        } else if (isMac) {
          shortcuts = await resolveMacAliases(root, exclusions)
        } else {
          shortcuts = await resolveLinuxDesktopFiles(root, exclusions)
        }

        const brokenItems: ScanItem[] = []
        for (const sc of shortcuts) {
          // Windows enumerates recursively, so also drop shortcuts in excluded subfolders
          if (isExcluded(sc.path, exclusions)) continue
          if (await checkShortcutTarget(sc, process.platform, probe)) {
            let size = 0
            try {
              const s = await stat(sc.path)
              size = s.size
            } catch {
              // Can't stat, that's fine
            }
            brokenItems.push({
              id: randomUUID(),
              path: sc.path,
              size,
              category,
              subcategory: dir.subcategory,
              lastModified: 0,
              selected: true
            })
          }
        }

        if (brokenItems.length > 0) {
          cacheItems(brokenItems)
          const totalSize = brokenItems.reduce((s, i) => s + i.size, 0)
          results.push({
            category,
            subcategory: dir.subcategory,
            items: brokenItems,
            totalSize,
            itemCount: brokenItems.length
          })
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.SCAN_PROGRESS, {
        phase: 'scanning',
        category,
        currentPath: 'Shortcut scan complete',
        progress: 100,
        itemsFound: results.reduce((s, r) => s + r.itemCount, 0),
        sizeFound: results.reduce((s, r) => s + r.totalSize, 0)
      })
    }

    return results
  })

  ipcMain.handle(IPC.SHORTCUT_CLEAN, async (_event, itemIds: string[]): Promise<CleanResult> => {
    const valid = validateStringArray(itemIds, 250_000, 100)
    if (!valid)
      return {
        totalCleaned: 0,
        filesDeleted: 0,
        filesSkipped: 0,
        errors: [],
        needsElevation: false
      }
    // cleanItems re-resolves exclusions (aliases included) and records receipts.
    return cleanItems(valid, (processed, total, currentPath, cleanedSize) => {
      const win = getWindow()
      if (win && !win.isDestroyed())
        win.webContents.send(IPC.SCAN_PROGRESS, {
          phase: 'cleaning',
          category: CleanerType.Shortcut,
          currentPath,
          progress: (processed / total) * 100,
          itemsFound: total,
          sizeFound: cleanedSize
        })
    })
  })
}
