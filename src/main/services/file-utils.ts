import { rm, stat, lstat, readdir, open, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import { randomUUID, randomBytes } from 'crypto'
import type { ScanItem, ScanResult, CleanResult, DeletedFileRecord, DeletionOrigin } from '../../shared/types'
import { getCachedItems } from './scan-cache'
import { getSettings } from './settings-store'
import { recordDeletions } from './deletion-log-store'

export interface DeleteResult {
  path: string
  success: boolean
  reason?: string
}

/**
 * Check if a path matches any of the configured exclusions.
 * Supports exact path prefixes and *.ext glob patterns.
 */
export function isExcluded(filePath: string, exclusions: string[]): boolean {
  if (exclusions.length === 0) return false
  // Only normalize to backslash on Windows; on Linux/macOS forward slash is the separator
  const toSep = process.platform === 'win32' ? /\//g : /\\/g
  const sep = process.platform === 'win32' ? '\\' : '/'
  const normalized = filePath.toLowerCase().replace(toSep, sep)
  for (const exc of exclusions) {
    const pattern = exc.toLowerCase().replace(toSep, sep)
    if (pattern.startsWith('*.')) {
      // Extension glob: *.log, *.tmp etc.
      if (normalized.endsWith(pattern.substring(1))) return true
    } else {
      // Path prefix match
      if (normalized.startsWith(pattern) || normalized === pattern) return true
    }
  }
  return false
}

/**
 * Overwrite a single file's contents with random data, then zeros, before deletion.
 * For directories, recursively overwrite all files within.
 */
async function secureOverwrite(filePath: string): Promise<void> {
  const stats = await stat(filePath)

  if (stats.isDirectory()) {
    const entries = await readdir(filePath, { withFileTypes: true })
    for (const entry of entries) {
      await secureOverwrite(join(filePath, entry.name))
    }
    return
  }

  if (!stats.isFile() || stats.size === 0) return

  const size = stats.size
  const CHUNK = 1024 * 1024 // 1 MB chunks
  const fh = await open(filePath, 'r+')
  try {
    // Pass 1: random data
    let offset = 0
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset)
      await fh.write(randomBytes(len), 0, len, offset)
      offset += len
    }
    await fh.datasync()

    // Pass 2: zeros
    const zeroBuf = Buffer.alloc(Math.min(CHUNK, size))
    offset = 0
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset)
      await fh.write(zeroBuf, 0, len, offset)
      offset += len
    }
    await fh.datasync()
  } finally {
    await fh.close()
  }
}

export async function safeDelete(filePath: string): Promise<DeleteResult> {
  try {
    const settings = getSettings()
    if (settings.cleaner.secureDelete) {
      try {
        await secureOverwrite(filePath)
      } catch {
        // If overwrite fails (e.g. permission), still attempt normal deletion
      }
    }
    await rm(filePath, { force: true, recursive: true })
    return { path: filePath, success: true }
  } catch (err: any) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      return { path: filePath, success: false, reason: 'in-use' }
    }
    if (err.code === 'EACCES') {
      return { path: filePath, success: false, reason: 'permission-denied' }
    }
    if (err.code === 'ENOENT') {
      return { path: filePath, success: true }
    }
    return { path: filePath, success: false, reason: err.message }
  }
}

/**
 * Cap on how many descendants a single directory contributes to the deletion
 * log. Beyond this the record carries a `truncated` count, so a capped audit
 * trail never reads as a complete one.
 */
const MAX_LOGGED_DESCENDANTS = 100_000

/**
 * List the files a recursive delete of `dirPath` will remove.
 *
 * Only called when deletion logging is on: a cached scan item is frequently a
 * whole directory, and recording just that one path would leave the audit trail
 * unable to answer which file went missing. Symlinks and Windows junctions are
 * listed but not descended into, matching what `rm -r` actually removes.
 *
 * Callers must confirm via lstat that the root is a real directory — a symlink
 * to one would have readdir list the *target's* files while rm only unlinks the
 * link, which would put files that still exist into the log.
 */
async function listDescendantFiles(dirPath: string): Promise<{ paths: string[]; truncated: number } | null> {
  let rootEntries: Dirent[]
  try {
    rootEntries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return null // Unreadable — nothing to expand.
  }

  const paths: string[] = []
  let truncated = 0
  const queue: Array<[string, Dirent[]]> = [[dirPath, rootEntries]]

  while (queue.length > 0) {
    const [dir, entries] = queue.shift()!
    for (const entry of entries) {
      if (paths.length >= MAX_LOGGED_DESCENDANTS) {
        truncated++
        continue
      }
      const fullPath = join(dir, entry.name)
      paths.push(fullPath)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        try {
          queue.push([fullPath, await readdir(fullPath, { withFileTypes: true })])
        } catch {
          // Unreadable subdirectory — its own path is already recorded.
        }
      }
    }
  }

  return { paths, truncated }
}

/**
 * Look up cached scan items by ID, delete each one, and return a CleanResult.
 */
export async function cleanItems(
  itemIds: unknown,
  onProgress?: (processed: number, total: number, currentPath: string, cleanedSize: number) => void,
  origin: DeletionOrigin = 'local'
): Promise<CleanResult> {
  // Validate input is a string array
  const validIds = Array.isArray(itemIds)
    ? itemIds.filter((v): v is string => typeof v === 'string')
    : []
  const items = getCachedItems(validIds)
  let totalCleaned = 0
  let filesDeleted = 0
  let filesSkipped = 0
  const errors: CleanResult['errors'] = []
  let lastReport = 0

  // Opt-in audit trail of what was removed (issue #247). Buffered so a clean of
  // 100k files doesn't turn into 100k appends, and flushed as we go so a crash
  // mid-clean still leaves a record of everything deleted up to that point.
  const logDeletions = getSettings().cleaner.keepDeletionLog === true
  const pending: DeletedFileRecord[] = []
  const flushPending = (): void => {
    if (pending.length === 0) return
    recordDeletions(pending)
    pending.length = 0
  }

  for (const item of items) {
    // lstat, not stat: it answers both questions the log depends on in one
    // call — whether the path is still there at all, and whether it is a real
    // directory rather than a symlink to one. Null means it was already gone
    // before this clean touched it.
    let rootInfo: Awaited<ReturnType<typeof lstat>> | null = null
    if (logDeletions) {
      try {
        rootInfo = await lstat(item.path)
      } catch {
        rootInfo = null
      }
    }

    // A scan item is often a whole directory that rm removes recursively, so
    // enumerate what's inside before it's gone. Only on success do these get
    // recorded, so a failed delete never leaves phantom entries behind.
    const descendants = rootInfo?.isDirectory() ? await listDescendantFiles(item.path) : null

    const result = await safeDelete(item.path)
    if (result.success) {
      totalCleaned += item.size
      filesDeleted++
      // rm(force) reports success for a path that was already missing, so a
      // temp file that vanished between the scan and the clean would otherwise
      // be logged as something Kudu deleted. Counters keep their existing
      // behavior; only the audit trail is held to what we actually removed.
      if (logDeletions && rootInfo) {
        const ts = new Date().toISOString()
        const category = item.subcategory || item.category
        const record: DeletedFileRecord = { ts, path: item.path, size: item.size, category, origin }
        if (descendants && descendants.truncated > 0) record.truncated = descendants.truncated
        pending.push(record)
        // Descendants carry size 0: the bytes are already accounted for on the
        // directory's own record, and stat-ing each one would double the I/O of
        // the clean for numbers the History page already summarizes.
        for (const path of descendants?.paths ?? []) {
          pending.push({ ts, path, size: 0, category, origin })
          if (pending.length >= 500) flushPending()
        }
        if (pending.length >= 500) flushPending()
      }
    } else {
      filesSkipped++
      if (result.reason) {
        errors.push({ path: item.path, reason: result.reason })
      }
    }
    if (onProgress) {
      const processed = filesDeleted + filesSkipped
      const now = Date.now()
      if (now - lastReport > 120 || processed === items.length) {
        lastReport = now
        onProgress(processed, items.length, item.path, totalCleaned)
      }
    }
  }

  flushPending()

  const needsElevation = errors.some((e) => e.reason === 'permission-denied')
  return { totalCleaned, filesDeleted, filesSkipped, errors, needsElevation }
}

export interface ScanRecencyOptions {
  /** Skip entries modified within this many minutes (default 60) */
  skipRecentMinutes?: number
  /**
   * Apply the guard to files only.
   *
   * A directory's mtime moves whenever an entry is added or removed inside it,
   * which says nothing about whether its contents are in use — and skipping it
   * discards the whole subtree. Chrome's `Code Cache` holds exactly two
   * entries, the `js` and `wasm` directories, so any recent browsing had both
   * skipped and the entire result dropped for being empty (issue #265).
   *
   * Files still get the guard, which is what keeps a running browser's
   * memory-mapped cache block files out of a scan.
   */
  filesOnly?: boolean
}

export async function scanDirectory(
  dirPath: string,
  category: string,
  subcategory: string,
  recency: number | ScanRecencyOptions = {}
): Promise<ScanResult> {
  const { skipRecentMinutes = 60, filesOnly = false } =
    typeof recency === 'number' ? { skipRecentMinutes: recency } : recency
  const items: ScanItem[] = []
  let totalSize = 0
  const cutoff = Date.now() - skipRecentMinutes * 60 * 1000
  const MAX_ITEMS = 5000
  const exclusions = getSettings().exclusions

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (items.length >= MAX_ITEMS) break
      const fullPath = join(dirPath, entry.name)

      // Check exclusions
      if (isExcluded(fullPath, exclusions)) continue

      try {
        const stats = await stat(fullPath)
        const isDirectory = stats.isDirectory()

        if (stats.mtimeMs > cutoff && !(filesOnly && isDirectory)) continue

        const size = isDirectory ? await getDirectorySize(fullPath, 2) : stats.size

        const item: ScanItem = {
          id: randomUUID(),
          path: fullPath,
          size,
          category,
          subcategory,
          lastModified: stats.mtimeMs,
          selected: true
        }

        items.push(item)
        totalSize += item.size
      } catch {
        // Skip inaccessible files
      }
    }
  } catch {
    // Directory doesn't exist or is inaccessible
  }

  return {
    category,
    subcategory,
    items,
    totalSize,
    itemCount: items.length
  }
}

/**
 * Scan multiple directories and merge their items into a single ScanResult.
 * Each item's subcategory is set to the provided label so they group together.
 */
export async function scanMultipleDirectories(
  dirPaths: string[],
  category: string,
  subcategory: string,
  skipRecentMinutes = 60
): Promise<ScanResult> {
  const allItems: ScanItem[] = []
  let totalSize = 0

  for (const dirPath of dirPaths) {
    const result = await scanDirectory(dirPath, category, subcategory, skipRecentMinutes)
    allItems.push(...result.items)
    totalSize += result.totalSize
  }

  return {
    category,
    subcategory,
    items: allItems,
    totalSize,
    itemCount: allItems.length,
  }
}

export async function scanFile(
  filePath: string,
  category: string,
  subcategory: string
): Promise<ScanResult> {
  const exclusions = getSettings().exclusions
  if (isExcluded(filePath, exclusions)) {
    return { category, subcategory, items: [], totalSize: 0, itemCount: 0 }
  }

  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) {
      return { category, subcategory, items: [], totalSize: 0, itemCount: 0 }
    }
    const item: ScanItem = {
      id: randomUUID(),
      path: filePath,
      size: stats.size,
      category,
      subcategory,
      lastModified: stats.mtimeMs,
      selected: true
    }
    return { category, subcategory, items: [item], totalSize: stats.size, itemCount: 1 }
  } catch {
    return { category, subcategory, items: [], totalSize: 0, itemCount: 0 }
  }
}

/**
 * Treat each directory path as a single deletable item (not individual files inside).
 * Returns one ScanItem per existing directory with its total size.
 */
export async function scanDirectoriesAsItems(
  dirPaths: string[],
  category: string,
  subcategory: string,
  group?: string
): Promise<ScanResult> {
  const items: ScanItem[] = []
  let totalSize = 0
  const exclusions = getSettings().exclusions

  for (const dirPath of dirPaths) {
    if (isExcluded(dirPath, exclusions)) continue

    try {
      const stats = await stat(dirPath)
      if (!stats.isDirectory()) continue
      const size = await getDirectorySize(dirPath, 3)
      if (size < 1024) continue

      items.push({
        id: randomUUID(),
        path: dirPath,
        size,
        category,
        subcategory,
        lastModified: stats.mtimeMs,
        selected: true,
      })
      totalSize += size
    } catch {
      // Path doesn't exist or inaccessible
    }
  }

  return { category, subcategory, group, items, totalSize, itemCount: items.length }
}

/**
 * For paths with a childSubdir, expand paths/&ast;/childSubdir.
 * e.g. given ['/home/.var/app'] with childSubdir='cache', returns
 * ['/home/.var/app/com.spotify.Client/cache', '/home/.var/app/org.foo/cache', ...]
 * If no childSubdir, returns the original paths unchanged.
 */
export async function resolveChildSubdirs(paths: string[], childSubdir?: string): Promise<string[]> {
  if (!childSubdir) return paths

  const resolved: string[] = []
  for (const basePath of paths) {
    try {
      if (!existsSync(basePath)) continue
      const children = await readdir(basePath, { withFileTypes: true })
      for (const child of children) {
        if (child.isDirectory()) {
          const subPath = join(basePath, child.name, childSubdir)
          if (existsSync(subPath)) resolved.push(subPath)
        }
      }
    } catch { /* skip */ }
  }
  return resolved
}

export async function getDirectorySize(dirPath: string, maxDepth = 3): Promise<number> {
  if (maxDepth <= 0) return 0
  let size = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      try {
        const stats = await stat(fullPath)
        if (stats.isDirectory()) {
          size += await getDirectorySize(fullPath, maxDepth - 1)
        } else {
          size += stats.size
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // Skip
  }
  return size
}
