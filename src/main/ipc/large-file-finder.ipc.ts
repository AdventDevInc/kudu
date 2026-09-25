import { BrowserWindow, ipcMain, shell } from 'electron'
import { readdir, lstat, rm } from 'fs/promises'
import type { BigIntStats } from 'fs'
import { join, extname, isAbsolute } from 'path'
import { IPC } from '../../shared/channels'
import type {
  LargeFileScanOptions,
  LargeFileEntry,
  LargeFileScanResult,
  LargeFileScanProgress,
  LargeFileDeleteMode,
  LargeFileDeleteResult
} from '../../shared/types'
import type { WindowGetter } from './index'
import { showOpenDialog } from './open-dialog'
import {
  isExcluded,
  isExcludedResolved,
  resolveScanRoot,
  expandExclusions
} from '../services/file-utils'
import { getSettings } from '../services/settings-store'

let cancelled = false
let busy = false
type FileIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>
const scannedFiles = new Map<string, FileIdentity>()

interface ScannedFile extends LargeFileEntry {
  identity: FileIdentity
}

async function refreshHardLinkChangeTimes(deleted: FileIdentity): Promise<void> {
  // An unknown inode cannot establish that two paths refer to the same file.
  if (deleted.ino === 0n) return

  for (const [filePath, expected] of scannedFiles) {
    if (
      expected.dev !== deleted.dev ||
      expected.ino !== deleted.ino ||
      expected.size !== deleted.size ||
      expected.mtimeNs !== deleted.mtimeNs ||
      expected.ctimeNs !== deleted.ctimeNs
    )
      continue

    try {
      const current = await lstat(filePath, { bigint: true })
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === expected.dev &&
        current.ino === expected.ino &&
        current.size === expected.size &&
        current.mtimeNs === expected.mtimeNs
      ) {
        // Unlinking or moving one hard link can change the shared inode's ctime.
        // Refresh only that field; never adopt a replacement or changed content.
        scannedFiles.set(filePath, { ...expected, ctimeNs: current.ctimeNs })
      }
    } catch {
      // Keep the old identity if a remaining link cannot be checked. A failed
      // refresh must not turn an already successful deletion into a failure.
    }
  }
}

function sendProgress(win: BrowserWindow | null, data: LargeFileScanProgress): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.LARGE_FILES_PROGRESS, data)
  }
}

async function walkDirectory(
  dirPath: string,
  options: LargeFileScanOptions,
  depth: number,
  files: ScannedFile[],
  counters: { scanned: number },
  win: BrowserWindow | null,
  lastReport: { time: number },
  exclusions: string[]
): Promise<void> {
  if (cancelled) return
  if (depth > options.maxDepth) return

  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (cancelled) return

    const fullPath = join(dirPath, entry.name)

    // Never descend into or list globally excluded paths
    if (entry.isSymbolicLink() || isExcluded(fullPath, exclusions)) continue

    if (entry.isDirectory()) {
      const shouldExclude = options.excludePatterns.some(
        (p) => entry.name === p || entry.name.toLowerCase() === p.toLowerCase()
      )
      if (shouldExclude) continue

      await walkDirectory(
        fullPath,
        options,
        depth + 1,
        files,
        counters,
        win,
        lastReport,
        exclusions
      )
    } else if (entry.isFile()) {
      try {
        const s = await lstat(fullPath, { bigint: true })
        if (!s.isFile() || s.isSymbolicLink()) continue
        counters.scanned++

        if (s.size >= options.minFileSize) {
          files.push({
            path: fullPath,
            name: entry.name,
            size: Number(s.size),
            lastModified: Number(s.mtimeMs),
            extension: extname(entry.name).toLowerCase(),
            identity: s
          })
        }

        const now = Date.now()
        if (now - lastReport.time > 500) {
          lastReport.time = now
          sendProgress(win, {
            currentPath: fullPath,
            filesScanned: counters.scanned,
            largeFilesFound: files.length,
            progress: 0
          })
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }
}

export function registerLargeFileFinderIpc(getWindow: WindowGetter): void {
  // Directory picker — Linux/macOS omit parent (see open-dialog.ts).
  ipcMain.handle(IPC.LARGE_FILES_SELECT_DIR, async () => {
    const win = getWindow()
    if (!win) return null
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = await showOpenDialog(win, opts)
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  // Cancel
  ipcMain.handle(IPC.LARGE_FILES_CANCEL, () => {
    cancelled = true
  })

  // Scan
  ipcMain.handle(
    IPC.LARGE_FILES_SCAN,
    async (_event, options: unknown): Promise<LargeFileScanResult> => {
      if (busy) throw new Error('A large-file operation is already in progress')
      busy = true
      try {
        scannedFiles.clear()
        cancelled = false
        const startTime = Date.now()
        const win = getWindow()
        const emptyResult: LargeFileScanResult = {
          files: [],
          totalFilesScanned: 0,
          duration: 0,
          cancelled: false
        }

        if (!options || typeof options !== 'object') return emptyResult
        const opts = options as Record<string, unknown>

        const dir = typeof opts.directory === 'string' ? opts.directory : ''
        const safeOptions: LargeFileScanOptions = {
          directory: isAbsolute(dir) ? dir : '',
          minFileSize:
            typeof opts.minFileSize === 'number' && opts.minFileSize > 0
              ? opts.minFileSize
              : 10_485_760,
          maxDepth: typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 20,
          excludePatterns: Array.isArray(opts.excludePatterns)
            ? (opts.excludePatterns as unknown[]).filter((p): p is string => typeof p === 'string')
            : []
        }

        const exclusions = await expandExclusions(getSettings().exclusions)
        const root = safeOptions.directory
          ? await resolveScanRoot(safeOptions.directory, exclusions)
          : null
        if (!root) return emptyResult
        safeOptions.directory = root

        // Verify the root directory is readable before starting the walk.
        // On macOS, TCC restrictions can silently block access to user folders.
        try {
          await readdir(safeOptions.directory)
        } catch {
          return emptyResult
        }

        // Send an immediate progress event so the UI shows feedback right away
        sendProgress(win, {
          currentPath: safeOptions.directory,
          filesScanned: 0,
          largeFilesFound: 0,
          progress: 0
        })

        const files: ScannedFile[] = []
        const counters = { scanned: 0 }
        const lastReport = { time: Date.now() }
        await walkDirectory(
          safeOptions.directory,
          safeOptions,
          0,
          files,
          counters,
          win,
          lastReport,
          exclusions
        )

        // Sort by size descending
        files.sort((a, b) => b.size - a.size)

        // Cap at 500 results
        const topFiles = files.slice(0, 500).map(({ identity, ...file }) => {
          scannedFiles.set(file.path, identity)
          return file
        })

        return {
          files: topFiles,
          totalFilesScanned: counters.scanned,
          duration: Date.now() - startTime,
          cancelled
        }
      } finally {
        busy = false
      }
    }
  )

  // Delete
  ipcMain.handle(
    IPC.LARGE_FILES_DELETE,
    async (_event, paths: unknown, mode: unknown): Promise<LargeFileDeleteResult> => {
      if (busy) throw new Error('A large-file operation is already in progress')
      if (!Array.isArray(paths)) return { deleted: 0, failed: 0, spaceRecovered: 0, errors: [] }
      busy = true
      try {
        const safePaths = [
          ...new Set(paths.filter((p): p is string => typeof p === 'string' && isAbsolute(p)))
        ]
        const deleteMode: LargeFileDeleteMode = mode === 'permanent' ? 'permanent' : 'recycle'

        let deleted = 0
        let failed = 0
        let spaceRecovered = 0
        const errors: { path: string; reason: string }[] = []

        for (const filePath of safePaths) {
          // Re-read per item: an exclusion added or retargeted mid-run still applies.
          const exclusions = await expandExclusions(getSettings().exclusions)
          // Exclusions may have changed since the scan; re-check before touching the file.
          if (await isExcludedResolved(filePath, exclusions)) {
            failed++
            errors.push({ path: filePath, reason: 'excluded' })
            continue
          }
          try {
            const expected = scannedFiles.get(filePath)
            if (!expected) throw new Error('File is not in the current scan results. Scan again.')

            // Recheck the scanned identity, including replacements reached through a
            // changed parent directory, before passing the path to the delete API.
            const s = await lstat(filePath, { bigint: true })
            if (
              !s.isFile() ||
              s.isSymbolicLink() ||
              s.dev !== expected.dev ||
              s.ino !== expected.ino ||
              s.size !== expected.size ||
              s.mtimeNs !== expected.mtimeNs ||
              s.ctimeNs !== expected.ctimeNs
            ) {
              throw new Error('File changed since the scan. Scan again before deleting.')
            }
            const fileSize = Number(s.size)

            if (deleteMode === 'recycle') {
              await shell.trashItem(filePath)
            } else {
              await rm(filePath)
            }
            scannedFiles.delete(filePath)
            deleted++
            spaceRecovered += fileSize
            await refreshHardLinkChangeTimes(expected)
          } catch (err: any) {
            failed++
            errors.push({ path: filePath, reason: err?.message || 'Unknown error' })
          }
        }

        return { deleted, failed, spaceRecovered, errors }
      } finally {
        busy = false
      }
    }
  )

  // Open file location
  ipcMain.handle(IPC.LARGE_FILES_OPEN_LOCATION, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) return
    shell.showItemInFolder(filePath)
  })
}
