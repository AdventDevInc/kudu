import { applyCacheResetPolicy } from './cache-reset-policy'
import { chmod, rm, rmdir, stat, lstat, readdir, open } from 'fs/promises'
import { constants, existsSync } from 'fs'
import type { Dirent, Stats } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { randomUUID, randomBytes } from 'crypto'
import type { ScanItem, ScanResult, CleanResult, DeletedFileRecord, DeletionOrigin } from '../../shared/types'
import type { AppCacheDef, DirectFileMatch, RecursivePathMatch } from '../platform/types'
import { getCachedItems, removeCachedItems } from './scan-cache'
import { getSettings } from './settings-store'
import { recordDeletions } from './deletion-log-store'
import { CooperativeScheduler } from './cooperative-scheduler'
import { cleanupTreeSize, measureCleanupTree, removedCleanupEntries } from './cleanup-measurement'

export interface DeleteResult {
  path: string
  success: boolean
  reason?: string
  /** Exact paths left behind when a recursive directory delete only partially succeeds. */
  failures?: Array<{ path: string; reason: string }>
}

/** Translate filesystem failures without conflating permissions with locks. */
export function deleteFailureReason(
  err: { code?: string; message?: string },
  platform: NodeJS.Platform = process.platform,
): string {
  if (err.code === 'EBUSY' || err.code === 'ENOTEMPTY') return 'in-use'
  // Windows reports sharing violations as EPERM. Treating them as an access
  // failure incorrectly prompts for elevation, which cannot release a lock.
  if (err.code === 'EPERM') return platform === 'win32' ? 'in-use' : 'permission-denied'
  if (err.code === 'EACCES') return 'permission-denied'
  return err.message || 'unknown-error'
}

type FilesystemFailure = { code?: string; message?: string }
const GRANULAR_DELETE_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

async function attemptDelete(
  filePath: string,
  operation: () => Promise<void>,
): Promise<FilesystemFailure | null> {
  try {
    await operation()
    return null
  } catch (err: any) {
    if (err.code === 'ENOENT') return null

    // A read-only attribute is also surfaced as EPERM on Windows. Clear it and
    // retry before deciding the path is locked; a real sharing violation will
    // simply fail the second attempt too.
    if (process.platform === 'win32' && err.code === 'EPERM') {
      try {
        const info = await lstat(filePath)
        if (info.isSymbolicLink() || info.nlink > 1) return err
        await chmod(filePath, 0o666)
        await operation()
        return null
      } catch (retryErr: any) {
        if (retryErr.code === 'ENOENT') return null
        return retryErr
      }
    }

    return err
  }
}

function recordDeleteFailure(
  failures: NonNullable<DeleteResult['failures']>,
  filePath: string,
  err: FilesystemFailure,
): void {
  failures.push({ path: filePath, reason: deleteFailureReason(err) })
}

/**
 * Remove a real directory from the leaves upward without following symlinks.
 * This is the recovery path after the fast recursive rm failed: one bad child
 * must not prevent settled siblings from being reclaimed.
 */
async function deleteDirectoryBestEffort(
  dirPath: string,
  failures: NonNullable<DeleteResult['failures']>,
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch (err: any) {
    if (err.code !== 'ENOENT') recordDeleteFailure(failures, dirPath, err)
    return
  }

  const failuresBeforeChildren = failures.length
  for (const entry of entries) {
    const childPath = join(dirPath, entry.name)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(childPath)
    } catch (err: any) {
      if (err.code !== 'ENOENT') recordDeleteFailure(failures, childPath, err)
      continue
    }

    if (info.isDirectory() && !info.isSymbolicLink()) {
      await deleteDirectoryBestEffort(childPath, failures)
      continue
    }

    const failure = await attemptDelete(childPath, () =>
      rm(childPath, { force: true, maxRetries: 3, retryDelay: 100 })
    )
    if (failure) recordDeleteFailure(failures, childPath, failure)
  }

  const directoryFailure = await attemptDelete(dirPath, () =>
    rmdir(dirPath)
  )
  // If a child already explains ENOTEMPTY, avoid also blaming every ancestor.
  if (directoryFailure && failures.length === failuresBeforeChildren) {
    recordDeleteFailure(failures, dirPath, directoryFailure)
  }
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
      const root = pattern.replace(/[\\/]+$/, '')
      if (normalized === root || normalized.startsWith(root + sep)) return true
    }
  }
  return false
}

/**
 * Overwrite a single file's contents with random data, then zeros, before deletion.
 * For directories, recursively overwrite all files within.
 */
async function secureOverwrite(filePath: string): Promise<void> {
  const stats = await lstat(filePath)
  // Unlink aliases normally; overwriting them would alter data owned by another
  // path. Check ancestors too, since lstat only inspects the final component.
  if (stats.isSymbolicLink() || (stats.isFile() && stats.nlink !== 1)) return
  for (let parent = dirname(resolve(filePath)); ; parent = dirname(parent)) {
    const info = await lstat(parent)
    if (info.isSymbolicLink() || !info.isDirectory()) return
    if (dirname(parent) === parent) break
  }

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
  const fh = await open(filePath, constants.O_RDWR | (constants.O_NOFOLLOW || 0))
  try {
    // Recheck the opened file, not just the earlier path lookup. Never write to
    // a replacement or a file which acquired another hard link before open.
    const opened = await fh.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stats.dev || opened.ino !== stats.ino) return
    const writeAll = async (buffer: Buffer, position: number): Promise<void> => {
      let written = 0
      while (written < buffer.length) {
        const { bytesWritten } = await fh.write(buffer, written, buffer.length - written, position + written)
        if (bytesWritten === 0) throw new Error('Secure overwrite made no progress')
        written += bytesWritten
      }
    }
    // Pass 1: random data
    let offset = 0
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset)
      await writeAll(randomBytes(len), offset)
      offset += len
    }
    await fh.datasync()

    // Pass 2: zeros
    const zeroBuf = Buffer.alloc(Math.min(CHUNK, size))
    offset = 0
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset)
      await writeAll(zeroBuf.subarray(0, len), offset)
      offset += len
    }
    await fh.datasync()
  } finally {
    await fh.close()
  }
}

export async function safeDelete(filePath: string): Promise<DeleteResult> {
  const settings = getSettings()
  if (settings.cleaner.secureDelete) {
    try {
      await secureOverwrite(filePath)
    } catch {
      // If overwrite fails (e.g. permission), still attempt normal deletion
    }
  }

  // Recursive rm only retries transient EBUSY/EPERM/ENOTEMPTY failures when
  // maxRetries is non-zero. Cache trees are frequently touched by antivirus
  // and indexer processes for a few milliseconds after scanning.
  const initialFailure = await attemptDelete(filePath, () =>
    rm(filePath, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
  )
  if (!initialFailure) return { path: filePath, success: true }
  if (!initialFailure.code || !GRANULAR_DELETE_ERRORS.has(initialFailure.code)) {
    return { path: filePath, success: false, reason: deleteFailureReason(initialFailure) }
  }

  let rootInfo: Awaited<ReturnType<typeof lstat>>
  try {
    rootInfo = await lstat(filePath)
  } catch (err: any) {
    if (err.code === 'ENOENT') return { path: filePath, success: true }
    return { path: filePath, success: false, reason: deleteFailureReason(initialFailure) }
  }

  // Files and symlinks have no independent descendants to salvage.
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return { path: filePath, success: false, reason: deleteFailureReason(initialFailure) }
  }

  const failures: NonNullable<DeleteResult['failures']> = []
  await deleteDirectoryBestEffort(filePath, failures)
  if (failures.length === 0) {
    return { path: filePath, success: true }
  }

  return {
    path: filePath,
    success: false,
    reason: failures[0].reason,
    failures,
  }
}

/**
 * Cap on how many descendants a single directory contributes to the deletion
 * log. Beyond this the record carries a `truncated` count, so a capped audit
 * trail never reads as a complete one.
 */
const MAX_LOGGED_DESCENDANTS = 100_000
/** Bounds both the scan and deletion-time recency revalidation. */
const MAX_RECENCY_DEPTH = 8
// This also bounds the number of IDs passed through a single cleaner IPC call.
// Keeping it aligned with that validated boundary avoids silently dropping the
// tail of large flat caches such as Firefox cache2/entries.
const MAX_RECENCY_ITEMS = 250_000
const MAX_PARALLEL_DELETES = 8

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
    ? [...new Set(itemIds.filter((v): v is string => typeof v === 'string'))]
    : []
  const items = getCachedItems(validIds)
  let totalCleaned = 0
  let filesDeleted = 0
  let filesSkipped = 0
  const errors: CleanResult['errors'] = []
  const consumedIds: string[] = []
  let lastReport = 0
  const scheduler = new CooperativeScheduler()

  // A missing cache entry used to disappear from the operation entirely. In a
  // large scan that made tens of thousands of selected files neither deleted
  // nor reported. Keep this explicit even though current scans are no longer
  // capacity-evicted, so stale renderer results can never fail silently.
  const resolvedIds = new Set(items.map((item) => item.id))
  for (const id of validIds) {
    if (!resolvedIds.has(id)) {
      filesSkipped++
      errors.push({ path: id, reason: 'scan-result-expired' })
    }
    await scheduler.yieldIfNeeded()
  }

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

  let deleteAccess = new Map<string, 'in-use' | 'permission-denied'>()
  if (process.platform === 'win32') {
    const protectedRoots = [
      process.env.WINDIR,
      process.env.PROGRAMDATA,
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
    ].filter((root): root is string => Boolean(root))
      .map((root) => root.replace(/[\\/]+$/, '').toLowerCase())
    const candidates = items
      .map((item) => item.path)
      .filter((path) => {
        const normalized = path.toLowerCase()
        return protectedRoots.some((root) => normalized === root || normalized.startsWith(`${root}\\`))
      })
    if (candidates.length > 0) {
      try {
        const { probeWindowsDeleteFailures } = await import('./delete-failure-probe')
        deleteAccess = await probeWindowsDeleteFailures(candidates)
      } catch {
        // The normal delete path remains authoritative if the probe is unavailable.
      }
    }
  }

  const processItem = async (item: ScanItem): Promise<void> => {
    if (item.cacheReset && origin === 'cloud') {
      filesSkipped++
      errors.push({ path: item.path, reason: 'Performance cache resets require local selection.' })
      onProgress?.(filesDeleted + filesSkipped, validIds.length, item.path, totalCleaned)
      return
    }
    if (item.cleanupAction) {
      // Cloud bulk cleanup has no UI for explicitly choosing native operations.
      const result = origin === 'cloud'
        ? { success: false, reason: 'Native maintenance requires local selection.' }
        : await (await import('./managed-cleanup')).runManagedCleanup(item)
      if (result.success) { filesDeleted++; consumedIds.push(item.id) }
      else { filesSkipped++; errors.push({ path: item.path, reason: result.reason || 'Native cleanup failed.' }) }
      onProgress?.(filesDeleted + filesSkipped, validIds.length, item.subcategory, totalCleaned)
      return
    }
    await scheduler.yieldIfNeeded()
    // Distinguish vanished entries from lookup failures so permission errors
    // remain retryable and can correctly request elevation.
    let rootInfo: Awaited<ReturnType<typeof lstat>>
    try {
      rootInfo = await lstat(item.path)
    } catch (err: any) {
      const missing = err.code === 'ENOENT'
      filesSkipped++
      errors.push({ path: item.path, reason: missing ? 'not-found' : deleteFailureReason(err) })
      if (missing) consumedIds.push(item.id)
      if (onProgress) {
        onProgress(filesDeleted + filesSkipped, validIds.length, item.path, totalCleaned)
        lastReport = Date.now()
      }
      return
    }

    if (isExcluded(item.path, getSettings().exclusions)) {
      filesSkipped++
      errors.push({ path: item.path, reason: 'excluded' })
      consumedIds.push(item.id)
      if (onProgress) {
        onProgress(filesDeleted + filesSkipped, validIds.length, item.path, totalCleaned)
        lastReport = Date.now()
      }
      return
    }

    // Do not spend two full retry cycles on a protected file that the current
    // token cannot delete. Directories still use granular fallback because
    // writable descendants may be salvageable even when the root is protected.
    if (
      !rootInfo.isDirectory()
      && deleteAccess.get(item.path.toLowerCase()) === 'permission-denied'
    ) {
      filesSkipped++
      errors.push({ path: item.path, reason: 'permission-denied' })
      if (onProgress) {
        onProgress(filesDeleted + filesSkipped, validIds.length, item.path, totalCleaned)
        lastReport = Date.now()
      }
      return
    }

    // Snapshot current file sizes for full or partial cleanup accounting.
    const measured = await measureCleanupTree(item.path)
    const measuredSize = measured.reduce((sum, entry) => sum + entry.size, 0)
    const descendantEntries = logDeletions && rootInfo.isDirectory()
      ? measured.filter(entry => entry.path !== item.path)
      : []
    const descendants = logDeletions && rootInfo.isDirectory()
      ? { paths: descendantEntries.slice(0, MAX_LOGGED_DESCENDANTS).map(entry => entry.path), truncated: Math.max(0, descendantEntries.length - MAX_LOGGED_DESCENDANTS) }
      : null

    // A deep-recency scan may collapse a settled tree to one directory item.
    // Recheck it after any audit enumeration and immediately before recursive
    // deletion so files created or updated since the scan remain protected.
    const retentionFailure = await revalidateRecencyItem(item, rootInfo)
    if (retentionFailure) {
      filesSkipped++
      errors.push({ path: item.path, reason: retentionFailure })
      consumedIds.push(item.id)
      if (onProgress) {
        onProgress(filesDeleted + filesSkipped, validIds.length, item.path, totalCleaned)
        lastReport = Date.now()
      }
      return
    }

    const result = await safeDelete(item.path)
    if (result.success) {
      totalCleaned += measuredSize
      filesDeleted++
      consumedIds.push(item.id)
      if (logDeletions) {
        const ts = new Date().toISOString()
        const category = item.subcategory || item.category
        const record: DeletedFileRecord = { ts, path: item.path, size: measuredSize, category, origin }
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
      const removed = await removedCleanupEntries(measured)
      totalCleaned += removed.reduce((sum, entry) => sum + entry.size, 0)
      if (logDeletions) {
        const ts = new Date().toISOString()
        for (const entry of removed) {
          pending.push({ ts, path: entry.path, size: entry.size, category: item.subcategory || item.category, origin })
          if (pending.length >= 500) flushPending()
        }
      }
      filesSkipped++
      if (result.failures?.length) {
        errors.push(...result.failures)
      } else if (result.reason) {
        errors.push({ path: item.path, reason: result.reason })
      }
    }
    if (onProgress) {
      const processed = filesDeleted + filesSkipped
      const now = Date.now()
      if (now - lastReport > 120 || processed === validIds.length) {
        lastReport = now
        onProgress(processed, validIds.length, item.path, totalCleaned)
      }
    }
    await scheduler.yieldIfNeeded()
  }

  // Files in independent cache roots can be removed concurrently. The small,
  // fixed worker pool keeps disk pressure bounded while preventing hundreds of
  // locked or protected paths from serializing their retry delays.
  // Serialize ancestor/descendant selections as well as identical paths.
  // Otherwise concurrent recursive deletes can both claim the same bytes.
  const canonical = (path: string): string => {
    const normalized = resolve(path)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  const ordered = items.map(item => ({ item, key: canonical(item.path) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const itemGroups: ScanItem[][] = []
  const groupsByPath = new Map<string, ScanItem[]>()
  for (const { item, key } of ordered) {
    let parent = key
    let group: ScanItem[] | undefined
    while (parent) {
      group = groupsByPath.get(parent)
      if (group) break
      const split = parent.lastIndexOf(sep)
      if (split < 0) break
      parent = parent.slice(0, split)
    }
    if (!group) {
      group = []
      groupsByPath.set(key, group)
      itemGroups.push(group)
    }
    group.push(item)
    await scheduler.yieldIfNeeded()
  }
  let nextGroup = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextGroup++
      if (index >= itemGroups.length) return
      for (const item of itemGroups[index]) await processItem(item)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_DELETES, itemGroups.length) }, () => worker())
  )

  // libuv flattens both NTFS ACL failures and sharing violations to EPERM.
  // Probe DELETE access without setting a delete disposition so the summary
  // can request elevation for protected paths and reserve "in use" for locks.
  if (process.platform === 'win32' && errors.some((error) => error.reason === 'in-use')) {
    try {
      const { probeWindowsDeleteFailures } = await import('./delete-failure-probe')
      const classified = await probeWindowsDeleteFailures(
        errors.filter((error) => error.reason === 'in-use').map((error) => error.path)
      )
      for (const error of errors) {
        const reason = classified.get(error.path.toLowerCase())
        if (reason) error.reason = reason
      }
    } catch {
      // Classification improves guidance but never blocks cleanup completion.
    }
  }

  if (onProgress && items.length === 0 && validIds.length > 0) {
    onProgress(filesSkipped, validIds.length, '', totalCleaned)
  }

  flushPending()
  removeCachedItems(consumedIds)

  const needsElevation = errors.some((e) => e.reason === 'permission-denied')
  return { totalCleaned, filesDeleted, filesSkipped, errors, needsElevation }
}

export interface ScanRecencyOptions {
  /** Skip entries modified within this many minutes (default 60) */
  skipRecentMinutes?: number
  /**
   * Legacy compatibility flag. Descendant checks are always enabled, including
   * when older rule consumers pass false.
   *
   * Judge a directory by its contents rather than by its own mtime.
   *
   * A directory's mtime moves whenever an entry is added or removed inside it,
   * which says nothing about whether the contents are in use. Testing it
   * directly discards the whole subtree: Chrome's `Code Cache` holds exactly
   * two entries, the `js` and `wasm` directories, so any recent browsing had
   * both skipped and the entire result dropped for being empty (issue #265).
   *
   * A directory is only offered as one item when nothing beneath
   * it falls inside the cutoff — which is what makes the recursive delete that
   * follows safe. When something under it is live, the directory is opened and
   * its children judged the same way, so a running app keeps the files it is
   * still writing while everything settled around them is still reclaimed.
   */
  deepRecencyCheck?: boolean
}

interface RecencyScan {
  cutoff: number
  exclusions: string[]
  /** Item budget shared across the whole scan */
  remaining: number
  /** Preserve exclusion failures through a collapsed directory recheck. */
  excluded?: boolean
}

interface ResolvedEntry {
  items: Array<{ path: string; size: number; mtimeMs: number }>
  /** Nothing beneath this entry was withheld, so deleting it whole is safe */
  complete: boolean
  size: number
}

function withheld(): ResolvedEntry {
  return { items: [], complete: false, size: 0 }
}

/** Resolve the entries inside `dirPath`, honouring the cutoff at every depth. */
async function resolveChildren(dirPath: string, ctx: RecencyScan, depth: number): Promise<ResolvedEntry> {
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return withheld()
  }

  const items: ResolvedEntry['items'] = []
  let complete = true
  let size = 0

  for (const entry of entries) {
    if (ctx.remaining <= 0) { complete = false; break }
    const childPath = join(dirPath, entry.name)
    if (isExcluded(childPath, ctx.exclusions)) { ctx.excluded = true; complete = false; continue }

    // Never descend a symlink — rm only unlinks the link, so what readdir would
    // list here is the target's contents, which this scan does not remove.
    const child = entry.isSymbolicLink()
      ? withheld()
      : await resolveEntry(childPath, entry.isDirectory(), ctx, depth)

    if (!child.complete) complete = false
    items.push(...child.items)
    size += child.size
  }

  return { items, complete, size }
}

/** Resolve a single entry into the items it contributes. */
async function resolveEntry(
  path: string,
  isDirectory: boolean,
  ctx: RecencyScan,
  depth: number
): Promise<ResolvedEntry> {
  let stats: Stats
  try {
    stats = await lstat(path)
    if (stats.isSymbolicLink()) return withheld()
  } catch {
    return withheld()
  }

  if (!isDirectory) {
    if (stats.mtimeMs > ctx.cutoff) return withheld()
    ctx.remaining--
    return { items: [{ path, size: stats.size, mtimeMs: stats.mtimeMs }], complete: true, size: stats.size }
  }

  // Out of depth: the subtree can't be shown to be settled, so leave it alone.
  if (depth <= 0) return withheld()

  const children = await resolveChildren(path, ctx, depth - 1)
  if (!children.complete) return children

  // Everything inside is settled, so collapse to one item and let a single
  // recursive delete take the lot — handing back the budget those children held.
  ctx.remaining += children.items.length - 1
  return { items: [{ path, size: children.size, mtimeMs: stats.mtimeMs }], complete: true, size: children.size }
}

/** Confirm that a retention-aware scan item is still settled at cleanup time. */
async function revalidateRecencyItem(item: ScanItem, rootInfo: Stats): Promise<'excluded' | 'recently-modified' | null> {
  if (isExcluded(item.path, getSettings().exclusions)) return 'excluded'
  if (rootInfo.isSymbolicLink()) return 'recently-modified'
  if (item.recencyCutoff !== undefined && !Number.isFinite(item.recencyCutoff)) return 'recently-modified'
  const cutoff = item.recencyCutoff ?? Infinity
  if (!rootInfo.isDirectory()) return rootInfo.isFile() && rootInfo.mtimeMs <= cutoff ? null : 'recently-modified'

  const ctx: RecencyScan = {
    cutoff,
    exclusions: getSettings().exclusions,
    remaining: MAX_RECENCY_ITEMS,
  }
  const resolved = await resolveChildren(item.path, ctx, MAX_RECENCY_DEPTH)
  return resolved.complete ? null : ctx.excluded ? 'excluded' : 'recently-modified'
}

export async function scanDirectory(
  dirPath: string,
  category: string,
  subcategory: string,
  recency: number | ScanRecencyOptions = {}
): Promise<ScanResult> {
  const options = typeof recency === 'number' ? { skipRecentMinutes: recency } : recency
  const requested = options.skipRecentMinutes ?? getSettings().cleaner.skipRecentMinutes ?? 60
  const minutes = Number.isFinite(requested) ? Math.max(0, requested) : 60
  const cutoff = Date.now() - minutes * 60_000
  const exclusions = getSettings().exclusions
  try {
    const root = await lstat(dirPath)
    if (!root.isDirectory() || root.isSymbolicLink() || isExcluded(dirPath, exclusions)) {
      return { category, subcategory, items: [], totalSize: 0, itemCount: 0 }
    }
  } catch {
    return { category, subcategory, items: [], totalSize: 0, itemCount: 0 }
  }
  // Descendant safety is mandatory, including for legacy callers passing false.
  const resolved = await resolveChildren(dirPath, { cutoff, exclusions, remaining: MAX_RECENCY_ITEMS }, MAX_RECENCY_DEPTH)
  const items: ScanItem[] = resolved.items.slice(0, MAX_RECENCY_ITEMS).map(item => ({
    id: randomUUID(), path: item.path, size: item.size, category, subcategory,
    lastModified: item.mtimeMs, selected: true, recencyCutoff: cutoff,
  }))
  return { category, subcategory, items, totalSize: items.reduce((sum, item) => sum + item.size, 0), itemCount: items.length }
}

/**
 * Scan multiple directories and merge their items into a single ScanResult.
 * Each item's subcategory is set to the provided label so they group together.
 */
export async function scanMultipleDirectories(
  dirPaths: string[],
  category: string,
  subcategory: string,
  recency: number | ScanRecencyOptions = {}
): Promise<ScanResult> {
  const allItems: ScanItem[] = []
  let totalSize = 0

  for (const dirPath of dirPaths) {
    const result = await scanDirectory(dirPath, category, subcategory, recency)
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

/**
 * Scan an allowlist of direct files without ever treating the containing
 * directory as disposable. `childDirSuffix` is intentionally limited to one
 * directory level, which makes it suitable for layouts such as
 * LocalAppData/*-updater while keeping nested `pending` trees out of scope.
 */
export async function scanMatchingFiles(
  basePaths: string[],
  match: DirectFileMatch,
  category: string,
  subcategory: string,
): Promise<ScanResult> {
  const items: ScanItem[] = []
  let totalSize = 0
  const cutoff = Date.now() - match.minAgeDays * 24 * 60 * 60 * 1000
  const exclusions = getSettings().exclusions
  const normalize = process.platform === 'win32'
    ? (name: string): string => name.toLowerCase()
    : (name: string): string => name
  const names = new Set(match.names.map(normalize))
  const blockers = new Set((match.skipIfChildExists || []).map(normalize))
  const suffix = match.childDirSuffix ? normalize(match.childDirSuffix) : undefined
  const candidateDirs = new Set<string>()

  for (const basePath of basePaths) {
    if (match.childDirSuffix) {
      try {
        const children = await readdir(basePath, { withFileTypes: true })
        for (const child of children) {
          if (!child.isDirectory() || child.isSymbolicLink()) continue
          if (normalize(child.name).endsWith(suffix!)) candidateDirs.add(join(basePath, child.name))
        }
      } catch {
        // Missing or inaccessible base path.
      }
    } else {
      candidateDirs.add(basePath)
    }
  }

  for (const candidateDir of candidateDirs) {
    if (items.length >= 5000 || isExcluded(candidateDir, exclusions)) continue

    try {
      const rootStats = await lstat(candidateDir)
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) continue

      const entries = await readdir(candidateDir, { withFileTypes: true })
      if (entries.some((entry) => blockers.has(normalize(entry.name)))) continue

      for (const entry of entries) {
        if (items.length >= 5000) break
        if (!entry.isFile() || entry.isSymbolicLink() || !names.has(normalize(entry.name))) continue

        const filePath = join(candidateDir, entry.name)
        if (isExcluded(filePath, exclusions)) continue

        try {
          const stats = await stat(filePath)
          if (!stats.isFile() || stats.mtimeMs > cutoff) continue
          items.push({
            id: randomUUID(),
            path: filePath,
            size: stats.size,
            category,
            subcategory,
            lastModified: stats.mtimeMs,
            selected: true,
          })
          totalSize += stats.size
        } catch {
          // File changed or became inaccessible during the scan.
        }
      }
    } catch {
      // Missing or inaccessible candidate directory.
    }
  }

  return { category, subcategory, items, totalSize, itemCount: items.length }
}

/** Scan one declarative app rule with all of its safety options applied. */
export async function scanAppRule(
  app: AppCacheDef,
  category: string,
  options: { directoryItems?: boolean; group?: string } = {},
): Promise<ScanResult> {
  if (app.cleanupAction) {
    return (await import('./managed-cleanup')).scanManagedCleanup(app.cleanupAction, category, app.name, app.paths[0])
  }
  let result: ScanResult
  const group = options.group ?? app.group

  if (app.fileMatch) {
    result = await scanMatchingFiles(app.paths, app.fileMatch, category, app.name)
  } else {
    const paths = await resolveChildSubdirs(app.paths, app.childSubdir, app.recursiveMatch)
    if (options.directoryItems && app.minAgeDays === undefined) {
      result = await scanDirectoriesAsItems(paths, category, app.name, group)
    } else if (app.minAgeDays === undefined) {
      result = await scanMultipleDirectories(paths, category, app.name)
    } else {
      result = await scanMultipleDirectories(paths, category, app.name, {
        skipRecentMinutes: app.minAgeDays * 24 * 60,
        deepRecencyCheck: true,
      })
    }
  }

  if (group && !result.group) result.group = group
  return applyCacheResetPolicy(result, app.cacheReset)
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
    const stats = await lstat(filePath)
    const configured = getSettings().cleaner.skipRecentMinutes ?? 60
    const cutoff = Date.now() - (Number.isFinite(configured) ? Math.max(0, configured) : 60) * 60_000
    if (!stats.isFile() || stats.isSymbolicLink() || stats.mtimeMs > cutoff) {
      return { category, subcategory, items: [], totalSize: 0, itemCount: 0 }
    }
    const item: ScanItem = {
      id: randomUUID(),
      path: filePath,
      size: stats.size,
      category,
      subcategory,
      lastModified: stats.mtimeMs,
      selected: true,
      recencyCutoff: cutoff
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
  // Keep a whole-root row only when every descendant is eligible. Otherwise
  // offer settled children, preserving active and excluded files.
  const items: ScanItem[] = []
  const configured = getSettings().cleaner.skipRecentMinutes ?? 60
  const cutoff = Date.now() - (Number.isFinite(configured) ? Math.max(0, configured) : 60) * 60_000
  const ctx: RecencyScan = { cutoff, exclusions: getSettings().exclusions, remaining: MAX_RECENCY_ITEMS }
  for (const dirPath of dirPaths) {
    if (isExcluded(dirPath, ctx.exclusions)) continue
    try {
      const root = await lstat(dirPath)
      if (!root.isDirectory() || root.isSymbolicLink()) continue
      const resolved = await resolveEntry(dirPath, true, ctx, MAX_RECENCY_DEPTH)
      for (const item of resolved.items.filter(item => item.size >= 1024)) items.push({
        id: randomUUID(), path: item.path, size: item.size, category, subcategory,
        lastModified: item.mtimeMs, selected: true, recencyCutoff: cutoff,
      })
    } catch { /* Missing or inaccessible root. */ }
  }
  return { category, subcategory, group, items, totalSize: items.reduce((sum, item) => sum + item.size, 0), itemCount: items.length }
}

/**
 * For paths with a childSubdir, expand paths/&ast;/childSubdir.
 * e.g. given ['/home/.var/app'] with childSubdir='cache', returns
 * ['/home/.var/app/com.spotify.Client/cache', '/home/.var/app/org.foo/cache', ...]
 * A recursiveMatch instead searches below each path for exact target directory
 * names beneath a required anchor directory. Directory links are never
 * followed, and traversal is bounded by depth and directory-count limits.
 * If neither option is set, returns the original paths unchanged.
 */
export async function resolveChildSubdirs(
  paths: string[],
  childSubdir?: string,
  recursiveMatch?: RecursivePathMatch,
): Promise<string[]> {
  if (recursiveMatch) return resolveRecursivePathMatches(paths, recursiveMatch)
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

const MAX_RECURSIVE_RULE_DIRECTORIES = 100_000
const DEFAULT_RECURSIVE_RULE_DEPTH = 12

function validDirectoryName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

function parseAnchorPath(
  pattern: string,
  anchor: string,
  normalizeName: (name: string) => string,
): string[] | null {
  const segments = pattern.split('/')
  if (
    segments.some((segment) => segment !== '*' && !validDirectoryName(segment))
    || normalizeName(segments.at(-1) || '') !== anchor
  ) return null
  return segments
}

async function expandAnchorPaths(
  basePath: string,
  patterns: string[][],
  budget: { visited: number },
): Promise<string[]> {
  const resolved = new Set<string>()

  for (const segments of patterns) {
    let candidates = new Set([basePath])

    for (const segment of segments) {
      const next = new Set<string>()

      for (const candidate of candidates) {
        if (budget.visited >= MAX_RECURSIVE_RULE_DIRECTORIES) break
        budget.visited++

        if (segment === '*') {
          try {
            const children = await readdir(candidate, { withFileTypes: true })
            for (const child of children) {
              if (!child.isDirectory() || child.isSymbolicLink()) continue
              next.add(join(candidate, child.name))
              if (budget.visited + next.size >= MAX_RECURSIVE_RULE_DIRECTORIES) break
            }
          } catch {
            // Skip missing or inaccessible wildcard candidates.
          }
        } else {
          const exactPath = join(candidate, segment)
          try {
            const stats = await lstat(exactPath)
            if (stats.isDirectory() && !stats.isSymbolicLink()) next.add(exactPath)
          } catch {
            // Skip missing or inaccessible exact candidates.
          }
        }
      }

      candidates = next
      if (candidates.size === 0 || budget.visited >= MAX_RECURSIVE_RULE_DIRECTORIES) break
    }

    for (const candidate of candidates) resolved.add(candidate)
    if (budget.visited >= MAX_RECURSIVE_RULE_DIRECTORIES) break
  }

  return [...resolved]
}

/** Resolve tightly scoped recursive cache rules without following links. */
export async function resolveRecursivePathMatches(
  paths: string[],
  match: RecursivePathMatch,
): Promise<string[]> {
  if (
    !validDirectoryName(match.anchor)
    || match.targets.some((target) => !validDirectoryName(target))
    || (match.excludedAncestors || []).some((ancestor) => !validDirectoryName(ancestor))
  ) return []

  const maxDepth = Math.min(32, Math.max(1, match.maxDepth ?? DEFAULT_RECURSIVE_RULE_DEPTH))
  const normalizeName = process.platform === 'win32'
    ? (name: string): string => name.toLowerCase()
    : (name: string): string => name
  const anchor = normalizeName(match.anchor)
  const anchorPaths = match.anchorPaths?.map((pattern) => parseAnchorPath(pattern, anchor, normalizeName))
  if (anchorPaths?.some((pattern) => pattern === null)) return []
  const targets = new Set(match.targets.map(normalizeName))
  const excludedAncestors = new Set((match.excludedAncestors || []).map(normalizeName))
  const resolved = new Set<string>()
  const budget = { visited: 0 }
  const roots = new Map<string, { path: string; belowAnchor: boolean }>()

  for (const basePath of paths) {
    if (!existsSync(basePath)) continue

    if (anchorPaths) {
      const expanded = await expandAnchorPaths(basePath, anchorPaths.filter((pattern): pattern is string[] => pattern !== null), budget)
      for (const rootPath of expanded) {
        const key = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath
        roots.set(key, { path: rootPath, belowAnchor: true })
      }
    } else {
      const key = process.platform === 'win32' ? basePath.toLowerCase() : basePath
      roots.set(key, {
        path: basePath,
        belowAnchor: normalizeName(basePath.split(/[\\/]/).pop() || '') === anchor,
      })
    }
  }

  for (const root of roots.values()) {
    const queue: Array<{ path: string; depth: number; belowAnchor: boolean }> = [{
      path: root.path,
      depth: 0,
      belowAnchor: root.belowAnchor,
    }]

    for (let index = 0; index < queue.length && budget.visited < MAX_RECURSIVE_RULE_DIRECTORIES; index++) {
      const current = queue[index]
      budget.visited++

      try {
        const children = await readdir(current.path, { withFileTypes: true })
        for (const child of children) {
          if (!child.isDirectory() || child.isSymbolicLink()) continue

          const fullPath = join(current.path, child.name)
          const normalized = normalizeName(child.name)
          const belowAnchor = current.belowAnchor || normalized === anchor

          if (current.belowAnchor && excludedAncestors.has(normalized)) continue

          if (current.belowAnchor && targets.has(normalized)) {
            resolved.add(fullPath)
            continue
          }

          if (current.depth + 1 < maxDepth) {
            queue.push({ path: fullPath, depth: current.depth + 1, belowAnchor })
          }
        }
      } catch {
        // Skip inaccessible directories.
      }
    }
  }

  return [...resolved]
}

/** Full logical size by default; explicit depth limits keep app estimates bounded. */
export async function getDirectorySize(dirPath: string, maxDepth?: number): Promise<number> {
  return cleanupTreeSize(dirPath, maxDepth)
}
