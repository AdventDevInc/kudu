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
import { cacheItems } from '../services/scan-cache'
import { cleanItems } from '../services/file-utils'
import { validateStringArray } from '../services/ipc-validation'
import type { ScanItem, ScanResult, CleanResult } from '../../shared/types'
import type { WindowGetter } from './index'

const execFileAsync = promisify(execFile)

// ── Shortcut target resolution ──

interface ShortcutInfo {
  path: string
  targetPath: string | null
}

/**
 * Resolve the target of a Windows .lnk shortcut using PowerShell.
 * Returns target paths for all .lnk files in the given directory.
 */
async function resolveWinShortcuts(dir: string): Promise<ShortcutInfo[]> {
  if (!existsSync(dir)) return []
  try {
    // PowerShell script to resolve all .lnk targets in the directory
    const psScript = `
$shell = New-Object -ComObject WScript.Shell
Get-ChildItem -Path '${dir.replace(/'/g, "''")}' -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $sc = $shell.CreateShortcut($_.FullName)
    "$($_.FullName)|$($sc.TargetPath)"
  } catch { "$($_.FullName)|" }
}`
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command', psScript,
    ], { timeout: 30000, windowsHide: true })

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

async function resolveLinuxDesktopFiles(dir: string): Promise<ShortcutInfo[]> {
  if (!existsSync(dir)) return []
  const results: ShortcutInfo[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.name.endsWith('.desktop')) continue
      const fullPath = join(dir, entry.name)
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
async function resolveMacAliases(dir: string): Promise<ShortcutInfo[]> {
  if (!existsSync(dir)) return []
  const results: ShortcutInfo[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
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
      { path: join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), subcategory: 'Start Menu Shortcuts' },
      { path: join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'), subcategory: 'Taskbar Shortcuts' },
      { path: join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), subcategory: 'All Users Start Menu' },
      { path: join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'), subcategory: 'Public Desktop Shortcuts' },
    ]
  }

  if (process.platform === 'darwin') {
    return [
      { path: join(home, 'Desktop'), subcategory: 'Desktop Aliases' },
      { path: join(home, 'Applications'), subcategory: 'User Applications' },
    ]
  }

  // Linux
  return [
    { path: join(home, 'Desktop'), subcategory: 'Desktop Shortcuts' },
    { path: join(home, '.local', 'share', 'applications'), subcategory: 'User Application Entries' },
    { path: '/usr/share/applications', subcategory: 'System Application Entries' },
  ]
}

// ── Check if a shortcut target is broken ──

/** Windows Start Menu subdirectories that contain built-in OS shortcuts */
const WIN_SYSTEM_SUBDIRS = /\\(System Tools|Administrative Tools|Accessibility|Windows PowerShell|Windows System|Windows Accessories)\\/i

/** Taskbar pinned shortcuts directory — shortcuts here were explicitly pinned by the user */
const WIN_TASKBAR_DIR = /\\User Pinned\\TaskBar\\/i

function isTargetBroken(info: ShortcutInfo): boolean {
  if (process.platform === 'win32') {
    // Never flag shortcuts in built-in Windows Start Menu subdirectories
    if (WIN_SYSTEM_SUBDIRS.test(info.path)) return false
    // Never flag taskbar shortcuts with unresolvable targets — many system
    // shortcuts (e.g. File Explorer) use shell extensions that WScript.Shell
    // cannot resolve, returning an empty TargetPath despite being valid
    if (WIN_TASKBAR_DIR.test(info.path) && !info.targetPath) return false
    // Never flag shortcuts pointing to Windows system executables
    if (info.targetPath && /\\Windows\\/i.test(info.targetPath)) return false
  }
  // If we couldn't resolve the target at all, consider it broken
  if (!info.targetPath) return true
  // Empty target
  if (info.targetPath.trim() === '') return true
  // Skip URLs and special targets
  if (/^https?:\/\//i.test(info.targetPath)) return false
  if (/^[a-z]+:/i.test(info.targetPath) && !info.targetPath.startsWith('/')) return false
  // Skip Windows UWP / shell: / explorer targets — these don't have normal file paths
  if (/^shell:/i.test(info.targetPath)) return false
  if (/^microsoft\./i.test(info.targetPath)) return false
  // Skip targets that reference Windows Apps store folder (UWP apps)
  if (/\\WindowsApps\\/i.test(info.targetPath)) return false
  // Linux: if the target was resolved via PATH (not an absolute path), it's valid
  if (process.platform !== 'win32' && !info.targetPath.startsWith('/')) return false
  // Check if the target exists on disk
  return !existsSync(info.targetPath)
}

// ── IPC registration ──

export function registerShortcutCleanerIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.SHORTCUT_SCAN, async (): Promise<ScanResult[]> => {
    const results: ScanResult[] = []
    const category = CleanerType.Shortcut
    const dirs = getShortcutDirs()
    const isWin = process.platform === 'win32'
    const isMac = process.platform === 'darwin'

    for (const dir of dirs) {
      try {
        let shortcuts: ShortcutInfo[]
        if (isWin) {
          shortcuts = await resolveWinShortcuts(dir.path)
        } else if (isMac) {
          shortcuts = await resolveMacAliases(dir.path)
        } else {
          shortcuts = await resolveLinuxDesktopFiles(dir.path)
        }

        const brokenItems: ScanItem[] = []
        for (const sc of shortcuts) {
          if (isTargetBroken(sc)) {
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
              selected: true,
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
            itemCount: brokenItems.length,
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
        sizeFound: results.reduce((s, r) => s + r.totalSize, 0),
      })
    }

    return results
  })

  ipcMain.handle(IPC.SHORTCUT_CLEAN, async (_event, itemIds: string[]): Promise<CleanResult> => {
    const valid = validateStringArray(itemIds)
    if (!valid) return { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [], needsElevation: false }
    return cleanItems(valid)
  })
}
