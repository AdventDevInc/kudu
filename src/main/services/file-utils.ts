import { rm, stat, lstat, readdir, open, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import type { Dirent, Stats } from 'fs'
import { join } from 'path'
import { randomUUID, randomBytes } from 'crypto'
import type { ScanItem, ScanResult, CleanResult, DeletedFileRecord, DeletionOrigin } from '../../shared/types'
import type { AppCacheDef, DirectFileMatch, RecursivePathMatch } from '../platform/types'
import { getCachedItems, removeCachedItems } from './scan-cache'
import { getSettings } from './settings-store'
import { recordDeletions } from './deletion-log-store'

export interface DeleteResult {
  path: string
  success: boolean
  reason?: string
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
    // Recursive rm only retries transient EBUSY/EPERM/ENOTEMPTY failures when
    // maxRetries is non-zero. Cache trees are frequently touched by antivirus
    // and indexer processes for a few milliseconds after scanning.
    await rm(filePath, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
    return { path: filePath, success: true }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { path: filePath, success: true }
    }
    return { path: filePath, success: false, reason: deleteFailureReason(err) }
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
    ? [...new Set(itemIds.filter((v): v is string => typeof v === 'string'))]
    : []
  const items = getCachedItems(validIds)
  let totalCleaned = 0
  let filesDeleted = 0
  let filesSkipped = 0
  const errors: CleanResult['errors'] = []
  const consumedIds: string[] = []
  let lastReport = 0

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

  for (const item of items) {
    // lstat, not stat: it answers both questions the log depends on in one
    // call — whether the path is still there at all, and whether it is a real
    // directory rather than a symlink to one. Null means it was already gone
    // before this clean touched it.
    let rootInfo: Awaited<ReturnType<typeof lstat>> | null = null
    try {
      rootInfo = await lstat(item.path)
    } catch {
      rootInfo = null
    }

    // force:true makes rm report success for an already-vanished file. Counting
    // its scanned size as reclaimed substantially overstates what this run did.
    if (!rootInfo) {
      filesSkipped++
      errors.push({ path: item.path, reason: 'not-found' })
      consumedIds.push(item.id)
      if (onProgress) {
        onProgress(filesDeleted + filesSkipped, validIds.length, item.path, totalCleaned)
        lastReport = Date.now()
      }
      continue
    }

    // A scan item is often a whole directory that rm removes recursively, so
    // enumerate what's inside before it's gone. Only on success do these get
    // recorded, so a failed delete never leaves phantom entries behind.
    const descendants = logDeletions && rootInfo.isDirectory()
      ? await listDescendantFiles(item.path)
      : null

    const result = await safeDelete(item.path)
    if (result.success) {
      totalCleaned += item.size
      filesDeleted++
      consumedIds.push(item.id)
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
      if (now - lastReport > 120 || processed === validIds.length) {
        lastReport = now
        onProgress(processed, validIds.length, item.path, totalCleaned)
      }
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
   * Judge a directory by its contents rather than by its own mtime.
   *
   * A directory's mtime moves whenever an entry is added or removed inside it,
   * which says nothing about whether the contents are in use. Testing it
   * directly discards the whole subtree: Chrome's `Code Cache` holds exactly
   * two entries, the `js` and `wasm` directories, so any recent browsing had
   * both skipped and the entire result dropped for being empty (issue #265).
   *
   * With this on, a directory is only offered as one item when nothing beneath
   * it falls inside the cutoff — which is what makes the recursive delete that
   * follows safe. When something under it is live, the directory is opened and
   * its children judged the same way, so a running app keeps the files it is
   * still writing while everything settled around them is still reclaimed.
   */
  deepRecencyCheck?: boolean
}

/** How far the contents check descends before it gives up on a subtree. */
const MAX_RECENCY_DEPTH = 8

interface RecencyScan {
  cutoff: number
  exclusions: string[]
  /** Item budget shared across the whole scan */
  remaining: number
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
    if (isExcluded(childPath, ctx.exclusions)) { complete = false; continue }

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
    stats = await stat(path)
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

export async function scanDirectory(
  dirPath: string,
  category: string,
  subcategory: string,
  recency: number | ScanRecencyOptions = {}
): Promise<ScanResult> {
  const { skipRecentMinutes = 60, deepRecencyCheck = false } =
    typeof recency === 'number' ? { skipRecentMinutes: recency } : recency
  const items: ScanItem[] = []
  let totalSize = 0
  const cutoff = Date.now() - skipRecentMinutes * 60 * 1000
  const MAX_ITEMS = 5000
  const exclusions = getSettings().exclusions

  const add = (path: string, size: number, mtimeMs: number): void => {
    items.push({ id: randomUUID(), path, size, category, subcategory, lastModified: mtimeMs, selected: true })
    totalSize += size
  }

  if (deepRecencyCheck) {
    // The scanned directory itself is never offered — only what is inside it —
    // so the top level takes `resolveChildren` and ignores whether it collapsed.
    const resolved = await resolveChildren(dirPath, { cutoff, exclusions, remaining: MAX_ITEMS }, MAX_RECENCY_DEPTH)
    for (const item of resolved.items.slice(0, MAX_ITEMS)) add(item.path, item.size, item.mtimeMs)
    return { category, subcategory, items, totalSize, itemCount: items.length }
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (items.length >= MAX_ITEMS) break
      const fullPath = join(dirPath, entry.name)

      // Check exclusions
      if (isExcluded(fullPath, exclusions)) continue

      try {
        const stats = await stat(fullPath)

        if (stats.mtimeMs > cutoff) continue

        const size = stats.isDirectory() ? await getDirectorySize(fullPath, 2) : stats.size

        add(fullPath, size, stats.mtimeMs)
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
  let result: ScanResult

  if (app.fileMatch) {
    result = await scanMatchingFiles(app.paths, app.fileMatch, category, app.name)
  } else {
    const paths = await resolveChildSubdirs(app.paths, app.childSubdir, app.recursiveMatch)
    if (options.directoryItems && app.minAgeDays === undefined) {
      result = await scanDirectoriesAsItems(paths, category, app.name, options.group)
    } else if (app.minAgeDays === undefined) {
      result = await scanMultipleDirectories(paths, category, app.name)
    } else {
      result = await scanMultipleDirectories(paths, category, app.name, {
        skipRecentMinutes: app.minAgeDays * 24 * 60,
        deepRecencyCheck: true,
      })
    }
  }

  if (options.group && !result.group) result.group = options.group
  return result
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
