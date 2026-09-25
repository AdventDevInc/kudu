import { lstat, open, type FileHandle } from 'fs/promises'
import { constants } from 'fs'
import type { BigIntStats } from 'fs'
import { randomBytes, randomUUID } from 'crypto'
import { CleanerType } from '../../shared/enums'
import type { CleanError, CleanResult, ScanItem, ScanResult } from '../../shared/types'
import { requireLocalOptIn } from './cache-reset-policy'
import { deleteFailureReason, isExcluded } from './file-utils'

/**
 * Privacy traces are records of what the user did (shell history, recent
 * document lists) rather than reclaimable junk. Every trace is therefore:
 *
 * - opt-in: scanned items always come back unselected;
 * - local-only: traces live in their own cache, never the shared scan cache,
 *   so cloud bulk cleanup, scheduled auto-clean and the dashboard's one-click
 *   clean can never reach them;
 * - re-verified at clean time: a trace which changed identity since the scan
 *   is skipped rather than guessed at.
 */

export interface TraceScanContext {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  exclusions: string[]
}

export interface TraceCleanOptions {
  /** Overwrite file contents before clearing them (settings.cleaner.secureDelete). */
  secureDelete: boolean
}

export interface PrivacyTrace {
  /** Absolute path, or a registry key for registry lists. Checked against exclusions. */
  path: string
  size: number
  lastModified: number
  entryCount?: number
  /** Re-verify the trace and clear it. Resolves with the number of bytes cleared. */
  clean: (options: TraceCleanOptions) => Promise<number>
}

export interface PrivacyTraceGroup {
  subcategory: string
  descriptionKey: string
  traces: PrivacyTrace[]
}

export type PrivacyTraceProvider = (ctx: TraceScanContext) => Promise<PrivacyTraceGroup[]>

/** A deliberate refusal to clear a trace; `reason` is shown to the user as-is. */
export class TraceSkipped extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

export const CHANGED_SINCE_SCAN = 'changed since scan, scan again'
export const NOT_A_REGULAR_FILE = 'not a regular file'

/**
 * Stat a candidate trace without following links. Only regular files with a
 * single hard link qualify: truncating a hard-linked file would also empty the
 * data behind its other names.
 */
export async function statTraceFile(path: string): Promise<BigIntStats | null> {
  try {
    const info = await lstat(path, { bigint: true })
    return info.isFile() && info.nlink === 1n ? info : null
  } catch {
    return null
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** Re-check that `path` is still the exact single-link regular file seen by the scan. */
async function verifyTraceFile(path: string, scanned: BigIntStats): Promise<BigIntStats> {
  const current = await lstat(path, { bigint: true })
  if (!current.isFile() || current.nlink !== 1n) throw new TraceSkipped(NOT_A_REGULAR_FILE)
  if (!sameFile(current, scanned)) throw new TraceSkipped(CHANGED_SINCE_SCAN)
  return current
}

/**
 * Open `path` without following links and confirm the handle is the exact
 * single-link regular file the scan saw. Every destructive step then goes
 * through this handle, so a file swapped in after the check is never touched.
 */
export async function openVerifiedTrace(path: string, scanned: BigIntStats): Promise<FileHandle> {
  await verifyTraceFile(path, scanned)
  // No O_CREAT: a file removed in the meantime stays removed.
  const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW || 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(opened, scanned)) {
      throw new TraceSkipped(CHANGED_SINCE_SCAN)
    }
    return handle
  } catch (err) {
    await handle.close()
    throw err
  }
}

const OVERWRITE_CHUNK = 1024 * 1024

/**
 * The cleaner's secure delete (random pass, then zeros), written through an
 * already-verified handle rather than by path.
 */
export async function overwriteThroughHandle(handle: FileHandle, size: number): Promise<void> {
  for (const fill of [(n: number) => randomBytes(n), (n: number) => Buffer.alloc(n)]) {
    for (let offset = 0; offset < size; offset += OVERWRITE_CHUNK) {
      const length = Math.min(OVERWRITE_CHUNK, size - offset)
      await handle.write(fill(length), 0, length, offset)
    }
    await handle.datasync()
  }
}

/**
 * Empty a history file in place. Truncating rather than deleting keeps the
 * file, its permissions and its ownership, so the owning program carries on
 * writing to it exactly as before. Symlinks, hard links and files replaced
 * since the scan are refused.
 */
export async function truncateTraceFile(
  path: string,
  scanned: BigIntStats,
  options: TraceCleanOptions
): Promise<number> {
  const handle = await openVerifiedTrace(path, scanned)
  try {
    const size = Number((await handle.stat({ bigint: true })).size)
    if (options.secureDelete) {
      try {
        await overwriteThroughHandle(handle, size)
      } catch {
        // Match safeDelete: an overwrite failure must not leave the trace in place.
      }
    }
    await handle.truncate(0)
    return size
  } finally {
    await handle.close()
  }
}

/** Build a trace which truncates `path` when cleaned. */
export function truncatingTrace(path: string, info: BigIntStats): PrivacyTrace {
  return {
    path,
    size: Number(info.size),
    lastModified: Number(info.mtimeMs),
    clean: (options) => truncateTraceFile(path, info, options)
  }
}

/** Drop excluded traces and groups left empty. */
export function withoutExcluded(
  groups: PrivacyTraceGroup[],
  exclusions: string[]
): PrivacyTraceGroup[] {
  return groups
    .map((group) => ({
      ...group,
      traces: group.traces.filter((trace) => !isExcluded(trace.path, exclusions))
    }))
    .filter((group) => group.traces.length > 0)
}

/**
 * Run every provider for the platform, register the resulting traces in
 * `cache` and return them as unselected scan results. A failing provider only
 * loses its own groups.
 */
export async function scanPrivacyTraces(
  providers: PrivacyTraceProvider[],
  ctx: TraceScanContext,
  cache: Map<string, PrivacyTrace>
): Promise<ScanResult[]> {
  cache.clear()
  const category = CleanerType.PrivacyTraces
  const results: ScanResult[] = []
  for (const provider of providers) {
    let groups: PrivacyTraceGroup[]
    try {
      groups = withoutExcluded(await provider(ctx), ctx.exclusions)
    } catch {
      continue
    }
    for (const group of groups) {
      const items: ScanItem[] = group.traces.map((trace) => {
        const id = randomUUID()
        cache.set(id, trace)
        return {
          id,
          path: trace.path,
          size: trace.size,
          category,
          subcategory: group.subcategory,
          lastModified: trace.lastModified,
          selected: false,
          ...(trace.entryCount !== undefined && { entryCount: trace.entryCount })
        }
      })
      results.push(
        requireLocalOptIn({
          category,
          subcategory: group.subcategory,
          descriptionKey: group.descriptionKey,
          items,
          totalSize: items.reduce((sum, item) => sum + item.size, 0),
          itemCount: items.length
        })
      )
    }
  }
  return results
}

function traceFailureReason(err: unknown): string {
  if (err instanceof TraceSkipped) return err.reason
  const code = (err as { code?: string }).code
  if (code === 'ENOENT') return 'not-found'
  if (code === 'ELOOP') return NOT_A_REGULAR_FILE
  return deleteFailureReason(err as { code?: string; message?: string })
}

/** Clear the selected traces one by one; a failure never stops the rest. */
export async function cleanPrivacyTraces(
  ids: string[],
  cache: Map<string, PrivacyTrace>,
  options: TraceCleanOptions & { exclusions: string[] },
  onProgress?: (processed: number, total: number, currentPath: string, cleaned: number) => void
): Promise<CleanResult> {
  let totalCleaned = 0
  let filesDeleted = 0
  let filesSkipped = 0
  const errors: CleanError[] = []

  for (let i = 0; i < ids.length; i++) {
    const trace = cache.get(ids[i])
    if (!trace) {
      filesSkipped++
      errors.push({ path: ids[i], reason: 'scan-result-expired' })
    } else if (isExcluded(trace.path, options.exclusions)) {
      filesSkipped++
      errors.push({ path: trace.path, reason: 'excluded' })
    } else {
      try {
        totalCleaned += await trace.clean({ secureDelete: options.secureDelete })
        filesDeleted++
        cache.delete(ids[i])
      } catch (err) {
        filesSkipped++
        errors.push({ path: trace.path, reason: traceFailureReason(err) })
      }
    }
    onProgress?.(i + 1, ids.length, trace?.path ?? '', totalCleaned)
  }

  return { totalCleaned, filesDeleted, filesSkipped, errors, needsElevation: false }
}
