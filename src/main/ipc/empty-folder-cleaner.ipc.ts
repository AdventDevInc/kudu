import { BrowserWindow, ipcMain, shell } from 'electron'
import { readdir, rmdir, lstat, realpath } from 'fs/promises'
import { join, isAbsolute, basename, relative, resolve, sep } from 'path'
import { homedir } from 'os'
import { IPC } from '../../shared/channels'
import type {
  EmptyFolderScanOptions,
  EmptyFolderEntry,
  EmptyFolderScanResult,
  EmptyFolderScanProgress,
  EmptyFolderDeleteResult
} from '../../shared/types'
import type { WindowGetter } from './index'
import { showOpenDialog } from './open-dialog'

let cancelled = false

// ── Safety: paths we must never delete from ──

const PROTECTED_WIN32 = [
  'windows',
  'system32',
  'syswow64',
  'winsxs',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'boot',
  '$recycle.bin',
  'system volume information',
  'perflogs',
  'msocache',
  'config.msi',
  'drivers',
  'inf',
  'logs'
]
const PROTECTED_UNIX = [
  'bin',
  'sbin',
  'usr',
  'etc',
  'var',
  'lib',
  'lib64',
  'opt',
  'boot',
  'dev',
  'proc',
  'sys',
  'run',
  'tmp',
  'snap',
  'root',
  'lost+found',
  'system',
  'library',
  'applications',
  'cores',
  'private',
  'volumes'
]
const PROTECTED_GENERIC = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.npm',
  '.cache',
  '.local',
  '__pycache__',
  '.venv',
  '.env',
  '.ssh',
  '.gnupg',
  '.config',
  'appdata',
  '.android',
  '.gradle'
]

async function getHomePaths(): Promise<string[]> {
  const home = resolve(homedir())
  try {
    return [home, await realpath(home)]
  } catch {
    // Do not infer a canonical-home exemption when its location is unknown.
    return [home]
  }
}

function relativeToHome(folderPath: string, homePaths: string[]): string | undefined {
  for (const home of homePaths) {
    const child = relative(home, folderPath)
    if (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)) return child
  }
  return undefined
}

function isProtectedTree(folderPath: string, homePaths: string[]): boolean {
  // A canonical home can live under /var/home or another protected ancestor.
  // Ignore only the home and its ancestors, not protected names inside it.
  const scopedPath = relativeToHome(folderPath, homePaths) ?? resolve(folderPath)
  const segments = scopedPath.toLowerCase().replace(/\\/g, '/').split('/')
  const protectedNames =
    process.platform === 'win32'
      ? [...PROTECTED_WIN32, ...PROTECTED_GENERIC]
      : [...PROTECTED_UNIX, ...PROTECTED_GENERIC]
  return segments.some((segment) => protectedNames.includes(segment))
}

function isProtectedFolder(folderPath: string, homePaths: string[]): boolean {
  const normalized = resolve(folderPath)
  const name = basename(normalized).toLowerCase()
  const pathLower = normalized.toLowerCase().replace(/\\/g, '/')

  // Never touch root-level directories on any drive
  // e.g. C:\Windows, /usr, /etc
  const segments = pathLower.split('/').filter(Boolean)
  // On Windows paths like C:/Windows, segments = ['c:', 'windows'] — depth 2 means root-level folder
  // On Unix /usr — segments = ['usr'] — depth 1 means root-level folder
  const isRootLevel = process.platform === 'win32' ? segments.length <= 2 : segments.length <= 1

  if (isRootLevel) return true

  const homeRelative = relativeToHome(normalized, homePaths)
  if (homeRelative === '' || isProtectedTree(normalized, homePaths)) return true

  // Never delete user profile root folders (Desktop, Documents, Downloads, etc.)
  const userProfileDirs = [
    'desktop',
    'documents',
    'downloads',
    'pictures',
    'videos',
    'music',
    'onedrive'
  ]
  // A single relative component is directly under either spelling of the home.
  if (userProfileDirs.includes(name) && homeRelative?.toLowerCase() === name) return true

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
  rootDir: string,
  homePaths: string[]
): Promise<boolean> {
  if (cancelled) return false
  if (depth > options.maxDepth) return false
  // Root-level and profile folders may be scanned, but protected trees must
  // remain untouched even when the user selects a directory inside one.
  if (isProtectedTree(dirPath, homePaths)) return false

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
      if (
        options.excludePatterns.some((p) => entry.name === p || entryNameLower === p.toLowerCase())
      ) {
        hasNonEmptySubdirs = true
        continue
      }

      const subPath = join(dirPath, entry.name)
      const subEmpty = await findEmptyFolders(
        subPath,
        options,
        depth + 1,
        emptyFolders,
        counters,
        win,
        lastReport,
        rootDir,
        homePaths
      )
      if (!subEmpty) {
        hasNonEmptySubdirs = true
      }
    } else {
      // Sockets, FIFOs, devices and unknown entries are content too.
      hasFiles = true
    }
  }

  // This folder is empty if it has no files and all subdirectories were empty (and removed from consideration)
  const isEmpty = !hasFiles && !hasNonEmptySubdirs

  // Never mark the root scan directory or protected folders as empty
  if (isEmpty && dirPath !== rootDir && !isProtectedFolder(dirPath, homePaths)) {
    emptyFolders.push({
      path: dirPath,
      name: basename(dirPath),
      depth
    })
  }

  return isEmpty
}

export function registerEmptyFolderCleanerIpc(getWindow: WindowGetter): void {
  // Directory picker — Linux/macOS omit parent (see open-dialog.ts).
  ipcMain.handle(IPC.EMPTY_FOLDERS_SELECT_DIR, async () => {
    const win = getWindow()
    if (!win) return null
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = await showOpenDialog(win, opts)
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  // Cancel
  ipcMain.handle(IPC.EMPTY_FOLDERS_CANCEL, () => {
    cancelled = true
  })

  // Scan
  ipcMain.handle(
    IPC.EMPTY_FOLDERS_SCAN,
    async (_event, options: unknown): Promise<EmptyFolderScanResult> => {
      cancelled = false
      const startTime = Date.now()
      const win = getWindow()
      const emptyResult: EmptyFolderScanResult = {
        folders: [],
        totalFoldersScanned: 0,
        duration: 0,
        cancelled: false
      }

      if (!options || typeof options !== 'object') return emptyResult
      const opts = options as Record<string, unknown>

      const dir = typeof opts.directory === 'string' ? opts.directory : ''
      const safeOptions: EmptyFolderScanOptions = {
        directory: isAbsolute(dir) ? resolve(dir) : '',
        maxDepth: typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 20,
        excludePatterns: Array.isArray(opts.excludePatterns)
          ? (opts.excludePatterns as unknown[]).filter((p): p is string => typeof p === 'string')
          : []
      }

      if (!safeOptions.directory) return emptyResult

      const homePaths = await getHomePaths()
      try {
        // A selected root can itself be an alias into a protected tree.
        if (isProtectedTree(await realpath(safeOptions.directory), homePaths)) return emptyResult
      } catch {
        return emptyResult
      }

      const emptyFolders: EmptyFolderEntry[] = []
      const counters = { scanned: 0 }
      const lastReport = { time: Date.now() }
      await findEmptyFolders(
        safeOptions.directory,
        safeOptions,
        0,
        emptyFolders,
        counters,
        win,
        lastReport,
        safeOptions.directory,
        homePaths
      )

      // Sort by depth descending (deepest first — so deleting goes bottom-up)
      emptyFolders.sort((a, b) => b.depth - a.depth)

      return {
        folders: emptyFolders,
        totalFoldersScanned: counters.scanned,
        duration: Date.now() - startTime,
        cancelled
      }
    }
  )

  // Revalidate protection and emptiness for both deletion modes.
  ipcMain.handle(
    IPC.EMPTY_FOLDERS_DELETE,
    async (_event, paths: unknown, mode: unknown): Promise<EmptyFolderDeleteResult> => {
      if (!Array.isArray(paths)) return { deleted: 0, failed: 0, errors: [] }
      const safePaths = [
        ...new Set(
          paths
            .filter((p): p is string => typeof p === 'string' && isAbsolute(p))
            .map((p) => resolve(p))
        )
      ]
      const deleteMode = mode === 'permanent' ? 'permanent' : 'recycle'
      const homePaths = await getHomePaths()

      let deleted = 0
      let failed = 0
      const errors: { path: string; reason: string }[] = []

      // Sort deepest first to ensure children are removed before parents
      safePaths.sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length)

      for (const folderPath of safePaths) {
        // Double-check protection at delete time
        if (isProtectedFolder(folderPath, homePaths)) {
          failed++
          errors.push({ path: folderPath, reason: 'Protected system folder' })
          continue
        }

        try {
          const metadata = await lstat(folderPath)
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error('Path is no longer a regular folder')
          }
          if (isProtectedFolder(await realpath(folderPath), homePaths)) {
            throw new Error('Protected system folder')
          }
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
    }
  )

  // Open folder location
  ipcMain.handle(IPC.EMPTY_FOLDERS_OPEN_LOCATION, (_event, folderPath: unknown) => {
    if (typeof folderPath !== 'string' || !isAbsolute(folderPath)) return
    shell.showItemInFolder(folderPath)
  })
}
