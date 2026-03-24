import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readdir, stat, rm } from 'fs/promises'
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

let cancelled = false

function sendProgress(win: BrowserWindow | null, data: LargeFileScanProgress): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.LARGE_FILES_PROGRESS, data)
  }
}

async function walkDirectory(
  dirPath: string,
  options: LargeFileScanOptions,
  depth: number,
  files: LargeFileEntry[],
  counters: { scanned: number },
  win: BrowserWindow | null,
  lastReport: { time: number }
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

    if (entry.isSymbolicLink()) continue

    if (entry.isDirectory()) {
      const shouldExclude = options.excludePatterns.some(
        (p) => entry.name === p || entry.name.toLowerCase() === p.toLowerCase()
      )
      if (shouldExclude) continue

      await walkDirectory(fullPath, options, depth + 1, files, counters, win, lastReport)
    } else if (entry.isFile()) {
      try {
        const s = await stat(fullPath)
        counters.scanned++

        if (s.size >= options.minFileSize) {
          files.push({
            path: fullPath,
            name: entry.name,
            size: s.size,
            lastModified: s.mtimeMs,
            extension: extname(entry.name).toLowerCase()
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
  // Directory picker — on macOS, avoid passing parent window so the dialog
  // opens as a standalone panel instead of a sheet (sidebar items like Desktop
  // are unresponsive in sheet mode).
  ipcMain.handle(IPC.LARGE_FILES_SELECT_DIR, async () => {
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
  ipcMain.handle(IPC.LARGE_FILES_CANCEL, () => {
    cancelled = true
  })

  // Scan
  ipcMain.handle(IPC.LARGE_FILES_SCAN, async (_event, options: unknown): Promise<LargeFileScanResult> => {
    cancelled = false
    const startTime = Date.now()
    const win = getWindow()
    const emptyResult: LargeFileScanResult = { files: [], totalFilesScanned: 0, duration: 0, cancelled: false }

    if (!options || typeof options !== 'object') return emptyResult
    const opts = options as Record<string, unknown>

    const dir = typeof opts.directory === 'string' ? opts.directory : ''
    const safeOptions: LargeFileScanOptions = {
      directory: isAbsolute(dir) ? dir : '',
      minFileSize: typeof opts.minFileSize === 'number' && opts.minFileSize > 0 ? opts.minFileSize : 10_485_760,
      maxDepth: typeof opts.maxDepth === 'number' && opts.maxDepth > 0 ? opts.maxDepth : 20,
      excludePatterns: Array.isArray(opts.excludePatterns)
        ? (opts.excludePatterns as unknown[]).filter((p): p is string => typeof p === 'string')
        : []
    }

    if (!safeOptions.directory) return emptyResult

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

    const files: LargeFileEntry[] = []
    const counters = { scanned: 0 }
    const lastReport = { time: Date.now() }
    await walkDirectory(safeOptions.directory, safeOptions, 0, files, counters, win, lastReport)

    // Sort by size descending
    files.sort((a, b) => b.size - a.size)

    // Cap at 500 results
    const topFiles = files.slice(0, 500)

    return {
      files: topFiles,
      totalFilesScanned: counters.scanned,
      duration: Date.now() - startTime,
      cancelled
    }
  })

  // Delete
  ipcMain.handle(IPC.LARGE_FILES_DELETE, async (_event, paths: unknown, mode: unknown): Promise<LargeFileDeleteResult> => {
    if (!Array.isArray(paths)) return { deleted: 0, failed: 0, spaceRecovered: 0, errors: [] }
    const safePaths = paths.filter((p): p is string => typeof p === 'string' && isAbsolute(p))
    const deleteMode: LargeFileDeleteMode = mode === 'permanent' ? 'permanent' : 'recycle'

    let deleted = 0
    let failed = 0
    let spaceRecovered = 0
    const errors: { path: string; reason: string }[] = []

    for (const filePath of safePaths) {
      try {
        const s = await stat(filePath)
        const fileSize = s.size

        if (deleteMode === 'recycle') {
          await shell.trashItem(filePath)
        } else {
          await rm(filePath, { force: true })
        }
        deleted++
        spaceRecovered += fileSize
      } catch (err: any) {
        failed++
        errors.push({ path: filePath, reason: err?.message || 'Unknown error' })
      }
    }

    return { deleted, failed, spaceRecovered, errors }
  })

  // Open file location
  ipcMain.handle(IPC.LARGE_FILES_OPEN_LOCATION, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) return
    shell.showItemInFolder(filePath)
  })
}
