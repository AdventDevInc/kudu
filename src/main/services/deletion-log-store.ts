import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { DeletedFileRecord, DeletionOrigin } from '../../shared/types'

/**
 * Append-only record of every path a cleaner deleted, so a past clean can be
 * audited from Scan History (issue #247).
 *
 * Stored as JSONL rather than JSON: a single clean can delete six figures of
 * files, and appending a line per batch keeps both memory and write cost flat.
 * Reads are on-demand only — nothing here is loaded at startup.
 *
 * This module is deliberately unaware of settings. Callers decide whether
 * logging is enabled; that keeps the store pure I/O and trivially testable.
 */

const MAX_LOG_SIZE = 8 * 1024 * 1024 // 8 MB, then rotate to .old
const DEFAULT_QUERY_LIMIT = 200
export const MAX_QUERY_LIMIT = 1000

let _dataDir: string | null = null
let _logPath: string | null = null
let _oldLogPath: string | null = null

function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = app.isPackaged
      ? app.getPath('userData')
      : join(app.getPath('userData'), 'Kudu-Dev')
  }
  return _dataDir
}

export function getDeletionLogPath(): string {
  if (!_logPath) _logPath = join(getDataDir(), 'deleted-files.jsonl')
  return _logPath
}

function getOldLogPath(): string {
  if (!_oldLogPath) _oldLogPath = join(getDataDir(), 'deleted-files.old.jsonl')
  return _oldLogPath
}

/** Test seam — clears the cached paths so a fresh userData dir takes effect. */
export function _resetDeletionLogPathCache(): void {
  _dataDir = null
  _logPath = null
  _oldLogPath = null
}

function ensureDir(): void {
  const dir = getDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function rotateIfNeeded(): void {
  try {
    const stats = statSync(getDeletionLogPath())
    if (stats.size <= MAX_LOG_SIZE) return
    try { unlinkSync(getOldLogPath()) } catch { /* no previous rotation */ }
    renameSync(getDeletionLogPath(), getOldLogPath())
  } catch {
    // No log file yet — nothing to rotate.
  }
}

/**
 * Append deleted paths to the log. Best-effort: a clean must never fail
 * because its audit trail could not be written.
 */
export function recordDeletions(records: DeletedFileRecord[]): void {
  if (records.length === 0) return
  try {
    ensureDir()
    rotateIfNeeded()
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    appendFileSync(getDeletionLogPath(), lines, 'utf-8')
  } catch {
    // Ignore — logging is an accessory to cleaning, never a precondition.
  }
}

function parseLines(raw: string, out: DeletedFileRecord[]): void {
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      if (
        parsed && typeof parsed === 'object' &&
        typeof parsed.ts === 'string' && typeof parsed.path === 'string'
      ) {
        const record: DeletedFileRecord = {
          ts: parsed.ts,
          path: parsed.path,
          size: typeof parsed.size === 'number' ? parsed.size : 0,
          category: typeof parsed.category === 'string' ? parsed.category : '',
          // Records predating origin tracking came from the local UI.
          origin: parsed.origin === 'cloud' || parsed.origin === 'cli' ? parsed.origin : 'local',
        }
        if (typeof parsed.truncated === 'number' && parsed.truncated > 0) {
          record.truncated = parsed.truncated
        }
        out.push(record)
      }
    } catch {
      // Skip a truncated or corrupt line rather than losing the whole log.
    }
  }
}

function readAll(): DeletedFileRecord[] {
  const records: DeletedFileRecord[] = []
  // Oldest first: the rotated file precedes the live one.
  for (const file of [getOldLogPath(), getDeletionLogPath()]) {
    try {
      if (existsSync(file)) parseLines(readFileSync(file, 'utf-8'), records)
    } catch {
      // Unreadable file — fall through with whatever we have.
    }
  }
  return records
}

export interface DeletionQuery {
  /** ISO timestamp, inclusive lower bound */
  from?: string
  /** ISO timestamp, inclusive upper bound */
  to?: string
  /** Restrict to deletions triggered by one surface */
  origin?: DeletionOrigin
  offset?: number
  limit?: number
}

/** Every record in a window, newest first and unpaged — also used for CSV export. */
export function queryAllDeletions(query: Omit<DeletionQuery, 'offset' | 'limit'> = {}): DeletedFileRecord[] {
  const fromMs = query.from ? Date.parse(query.from) : NaN
  const toMs = query.to ? Date.parse(query.to) : NaN

  const matched = readAll().filter((r) => {
    if (query.origin && r.origin !== query.origin) return false
    if (Number.isNaN(fromMs) && Number.isNaN(toMs)) return true
    const ts = Date.parse(r.ts)
    if (Number.isNaN(ts)) return false
    if (!Number.isNaN(fromMs) && ts < fromMs) return false
    if (!Number.isNaN(toMs) && ts > toMs) return false
    return true
  })

  // Newest first, matching how history itself is ordered.
  matched.reverse()
  return matched
}

/**
 * Read the records falling inside a time window, newest first.
 * `total` is the full match count so the caller can page through it.
 */
export function queryDeletions(query: DeletionQuery = {}): { records: DeletedFileRecord[]; total: number } {
  const offset = Math.max(0, Math.floor(query.offset ?? 0))
  const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_QUERY_LIMIT)))
  const matched = queryAllDeletions(query)
  return { records: matched.slice(offset, offset + limit), total: matched.length }
}

export function clearDeletionLog(): void {
  try {
    ensureDir()
    writeFileSync(getDeletionLogPath(), '', 'utf-8')
    try { unlinkSync(getOldLogPath()) } catch { /* nothing rotated */ }
  } catch {
    // Ignore
  }
}
