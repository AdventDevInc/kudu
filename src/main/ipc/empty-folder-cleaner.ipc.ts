import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readdir, rmdir } from 'fs/promises'
import { join, isAbsolute, basename } from 'path'
import { IPC } from '../../shared/channels'
import type {
  EmptyFolderScanOptions,
  EmptyFolderEntry,
  EmptyFolderScanResult,
  EmptyFolderScanProgress,
  EmptyFolderDeleteResult
} from '../../shared/types'
import type { WindowGetter } from './index'

let cancelled = false

// ── Safety: paths we must never delete from ──

const PROTECTED_WIN32 = [
  'windows', 'system32', 'syswow64', 'winsxs', 'program files', 'program files (x86)',
  'programdata', 'recovery', 'boot', '$recycle.bin', 'system volume information',
  'perflogs', 'msocache', 'config.msi', 'drivers', 'inf', 'logs',
]
const PROTECTED_UNIX = [
  'bin', 'sbin', 'usr', 'etc', 'var', 'lib', 'lib64', 'opt', 'boot', 'dev',
  'proc', 'sys', 'run', 'tmp', 'snap', 'root', 'lost+found',
  'system', 'library', 'applications', 'cores', 'private', 'volumes',
]
const PROTECTED_GENERIC = [
  '.git', '.svn', '.hg', 'node_modules', '.npm', '.cache', '.local',
  '__pycache__', '.venv', '.env', '.ssh', '.gnupg', '.config',
  'appdata', '.android', '.gradle',
]

function isProtectedFolder(folderPath: string): boolean {
  const name = basename(folderPath).toLowerCase()
  const pathLower = folderPath.toLowerCase().replace(/\\/g, '/')

  // Never touch root-level directories on any drive
  // e.g. C:\Windows, /usr, /etc
  const segments = pathLower.split('/').filter(Boolean)
  // On Windows paths like C:/Windows, segments = ['c:', 'windows'] — depth 2 means root-level folder
  // On Unix /usr — segments = ['usr'] — depth 1 means root-level folder
  const isRootLevel = process.platform === 'win32' ? segments.length <= 2 : segments.length <= 1

  if (isRootLevel) return true

  // Check against protected lists
  const protectedNames = process.platform === 'win32'
    ? [...PROTECTED_WIN32, ...PROTECTED_GENERIC]
    : [...PROTECTED_UNIX, ...PROTECTED_GENERIC]

  if (protectedNames.includes(name)) return true

  // Never delete user profile root folders (Desktop, Documents, Downloads, etc.)
  const userProfileDirs = ['desktop', 'documents', 'downloads', 'pictures', 'videos', 'music', 'onedrive']
  if (userProfileDirs.includes(name)) {
    // Only protect if it's directly under the user profile
    const home = (process.env.HOME || process.env.USERPROFILE || '').toLowerCase().replace(/\\/g, '/')
    if (home) {
      const parent = pathLower.substring(0, pathLower.lastIndexOf('/'))
      if (parent === home || parent === home + '/') return true
    }
  }

  return false
}

function sendProgress(win: BrowserWindow | null, data: EmptyFolderScanProgress): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.EMPTY_FOLDERS_PROGRESS, data)
  }
}

/**
 * Recursively finds empty folders (bottom-up).
 * A folder is "empty" if it contains no files and no non-empty subdirectories.
 */
async function findEmptyFolders(
  dirPath: string,
  options: EmptyFolderScanOptions,
  depth: number,
  emptyFolders: EmptyFolderEntry[],
  counters: { scanned: number },
  win: BrowserWindow | null,
  lastReport: { time: number },
  rootDir: string
): Promise<boolean> {
  if (cancelled) return false
  if (depth > options.maxDepth) return false

  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return false // inaccessible — treat as non-empty for safety
  }

  counters.scanned++

  const now = Date.now()
  if (now - lastReport.time > 500) {
    lastReport.time = now
    sendProgress(win, {
      currentPath: dirPath,
      foldersScanned: counters.scanned,
      emptyFound: emptyFolders.length,
      progress: 0
    })
  }

  let hasFiles = false
  let hasNonEmptySubdirs = false

  for (const entry of entries) {
    if (cancelled) return false

    if (entry.isSymbolicLink()) {
      hasFiles = true // treat symlinks as content
      continue
    }

    if (entry.isFile()) {
      hasFiles = true
    } else if (entry.isDirectory()) {
      // Skip hidden/dot-directories and user-configured exclusions before recursing
      if (entry.name.startsWith('.')) {
        hasNonEmptySubdirs = true // treat as non-empty so parent isn't flagged
        continue
      }
      const entryNameLower = entry.name.toLowerCase()
      if (options.excludePatterns.some((p) => entry.name === p || entryNameLower === p.toLowerCase())) {
        hasNonEmptySubdirs = true
        continue
      }

      const subPath = join(dirPath, entry.name)
      const subEmpty = await findEmptyFolders(subPath, options, depth + 1, emptyFolders, counters, win, lastReport, rootDir)
      if (!subEmpty) {
        hasNonEmptySubdirs = true
      }
    }
  }

  // This folder is empty if it has no files and all subdirectories were empty (and removed from consideration)
  const isEmpty = !hasFiles && !hasNonEmptySubdirs

  // Never mark the root scan directory or protected folders as empty
  if (isEmpty && dirPath !== rootDir && !isProtectedFolder(dirPath)) {
    emptyFolders.push({
      path: dirPath,
      name: basename(dirPath),
      depth
    })
  }

  return isEmpty
}

export function registerEmptyFolderCleanerIpc(getWindow: WindowGetter): void {
  // Directory picker — on macOS, avoid passing parent window so the dialog
  // opens as a standalone panel instead of a sheet (sidebar items like Desktop
  // are unresponsive in sheet mode).
  ipcMain.handle(IPC.EMPTY_FOLDERS_SELECT_DIR, async () => {
    const win = getWindow()
    if (!win) return null
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = process.platform === 'darwin'
      ? await dialog.showOpenDialog(opts)
      : await dialog.showOpenDialog(win, opts)
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  // Cancel
  ipcMain.handle(IPC.EMPTY_FOLDERS_CANCEL, () => {
    cancelled = true
  })

  // Scan
  ipcMain.handle(IPC.EMPTY_FOLDERS_SCAN, async (_event, options: unknown): Promise<EmptyFolderScanResult> => {
    cancelled = false
    const startTime = Date.now()
    const win = getWindow()
    const emptyResult: EmptyFolderScanResult = { folders: [], totalFoldersScanned: 0, duration: 0, cancelled: false }

    if (!options || typeof options !== 'object') return emptyResult
    const opts = options as Record<string, unknown>

    const dir = typeof opts.directory === 'string' ? opts.directory : ''
    const safeOptions: EmptyFolderScanOptions = {
      directory: isAbsolute(dir) ? dir : '',
      maxDepth: typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 20,
      excludePatterns: Array.isArray(opts.excludePatterns)
        ? (opts.excludePatterns as unknown[]).filter((p): p is string => typeof p === 'string')
        : []
    }

    if (!safeOptions.directory) return emptyResult

    const emptyFolders: EmptyFolderEntry[] = []
    const counters = { scanned: 0 }
    const lastReport = { time: Date.now() }
    await findEmptyFolders(safeOptions.directory, safeOptions, 0, emptyFolders, counters, win, lastReport, safeOptions.directory)

    // Sort by depth descending (deepest first — so deleting goes bottom-up)
    emptyFolders.sort((a, b) => b.depth - a.depth)

    return {
      folders: emptyFolders,
      totalFoldersScanned: counters.scanned,
      duration: Date.now() - startTime,
      cancelled
    }
  })

  // Delete — always uses recycle bin for safety (rmdir only works on truly empty dirs)
  ipcMain.handle(IPC.EMPTY_FOLDERS_DELETE, async (_event, paths: unknown, mode: unknown): Promise<EmptyFolderDeleteResult> => {
    if (!Array.isArray(paths)) return { deleted: 0, failed: 0, errors: [] }
    const safePaths = paths.filter((p): p is string => typeof p === 'string' && isAbsolute(p))
    const deleteMode = mode === 'permanent' ? 'permanent' : 'recycle'

    let deleted = 0
    let failed = 0
    const errors: { path: string; reason: string }[] = []

    // Sort deepest first to ensure children are removed before parents
    safePaths.sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length)

    for (const folderPath of safePaths) {
      // Double-check protection at delete time
      if (isProtectedFolder(folderPath)) {
        failed++
        errors.push({ path: folderPath, reason: 'Protected system folder' })
        continue
      }

      try {
        // Verify folder is still empty before deleting
        const entries = await readdir(folderPath)
        if (entries.length > 0) {
          failed++
          errors.push({ path: folderPath, reason: 'Folder is no longer empty' })
          continue
        }

        if (deleteMode === 'recycle') {
          await shell.trashItem(folderPath)
        } else {
          await rmdir(folderPath)
        }
        deleted++
      } catch (err: any) {
        failed++
        errors.push({ path: folderPath, reason: err?.message || 'Unknown error' })
      }
    }

    return { deleted, failed, errors }
  })

  // Open folder location
  ipcMain.handle(IPC.EMPTY_FOLDERS_OPEN_LOCATION, (_event, folderPath: unknown) => {
    if (typeof folderPath !== 'string' || !isAbsolute(folderPath)) return
    shell.showItemInFolder(folderPath)
  })
}
