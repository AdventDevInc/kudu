import { execFile } from 'child_process'
import type { BigIntStats } from 'fs'
import { join } from 'path'
import {
  deletingTrace,
  listTraceFiles,
  statTraceFile,
  TraceSkipped,
  verifyTraceFile,
  type PrivacyTraceGroup,
  type TraceScanContext
} from './privacy-traces'

// ── Recent Items (shared file lists) ──

// Only the Recent* lists. FavoriteItems, FavoriteVolumes, ProjectsItems and
// everything else in this folder back the Finder sidebar and are never listed.
const RECENT_LIST =
  /^com\.apple\.LSSharedFileList\.Recent(Documents|Applications|Servers|Hosts)\.sfl[23]$/
const APP_RECENT_LIST = /\.sfl[23]$/

/**
 * Recent Items lists. Deleting a list file is how macOS itself clears it; no
 * daemon is restarted, so an app which is open may keep its in-memory list
 * until it quits or the user logs out.
 */
export async function findMacRecentItemTraces(ctx: TraceScanContext): Promise<PrivacyTraceGroup[]> {
  if (ctx.platform !== 'darwin') return []
  const dir = join(ctx.home, 'Library', 'Application Support', 'com.apple.sharedfilelist')
  const groups: PrivacyTraceGroup[] = []
  const recent = await listTraceFiles(dir, RECENT_LIST)
  if (recent.length > 0) {
    groups.push({
      subcategory: 'Recent items',
      descriptionKey: 'privacyMacRecentItemsNote',
      traces: recent.map((f) => deletingTrace(f.path, f.info))
    })
  }
  const perApp = await listTraceFiles(
    join(dir, 'com.apple.LSSharedFileList.ApplicationRecentDocuments'),
    APP_RECENT_LIST
  )
  if (perApp.length > 0) {
    groups.push({
      subcategory: 'App recent documents',
      descriptionKey: 'privacyMacRecentItemsNote',
      traces: perApp.map((f) => deletingTrace(f.path, f.info))
    })
  }
  return groups
}

// ── Download history (Quarantine Events database) ──

const SQLITE = '/usr/bin/sqlite3'

/** Run the system sqlite3 without a shell; the database path and SQL are fixed. */
function sqlite(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SQLITE, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? '') }))
      else resolve(String(stdout))
    })
  })
}

/** Map sqlite3 CLI failures to the reasons shown for skipped items. */
export function sqliteFailureReason(err: unknown): string {
  const text = `${(err as { stderr?: string }).stderr ?? ''} ${(err as Error).message ?? ''}`
  if (/database is locked|database table is locked|SQLITE_BUSY/i.test(text)) return 'in-use'
  if (/readonly database|unable to open|authori[sz]ation denied|permission denied/i.test(text))
    return 'permission-denied'
  if (/no such table/i.test(text)) return 'not-found'
  // sqlite3 before 3.31 (macOS 10.15 and older) lacks -nofollow; never run without it.
  if (/unknown option/i.test(text)) return 'unsupported on this macOS version'
  return 'could not update the download history database'
}

function parseCount(stdout: string): number | null {
  const count = Number(stdout.trim().split(/\r?\n/).pop())
  return Number.isInteger(count) && count >= 0 ? count : null
}

/** An SQLite URI which opens an existing database read-write but never creates one. */
export function existingDatabaseUri(path: string): string {
  return `file:${path.split('/').map(encodeURIComponent).join('/')}?mode=rw`
}

/** Empty LSQuarantineEvent in place. The database file itself is never deleted. */
export async function clearQuarantineEvents(path: string, scanned: BigIntStats): Promise<number> {
  await verifyTraceFile(path, scanned)
  try {
    // secure_delete zeroes the removed rows instead of leaving them in free pages.
    // -nofollow makes sqlite3 refuse the path if it was swapped for a symlink
    // after the check above, rather than deleting rows from its target.
    await sqlite([
      '-bail',
      '-nofollow',
      '-cmd',
      '.timeout 2000',
      existingDatabaseUri(path),
      'PRAGMA secure_delete = ON; DELETE FROM LSQuarantineEvent;'
    ])
  } catch (err) {
    throw new TraceSkipped(sqliteFailureReason(err))
  }
  return 0
}

/** Download history kept by Gatekeeper, reported as a row count. */
export async function findMacQuarantineTraces(ctx: TraceScanContext): Promise<PrivacyTraceGroup[]> {
  if (ctx.platform !== 'darwin') return []
  const path = join(
    ctx.home,
    'Library',
    'Preferences',
    'com.apple.LaunchServices.QuarantineEventsV2'
  )
  const info = await statTraceFile(path)
  if (!info) return []
  let count: number | null
  try {
    count = parseCount(
      await sqlite([
        '-readonly',
        '-nofollow',
        '-cmd',
        '.timeout 2000',
        path,
        'SELECT COUNT(*) FROM LSQuarantineEvent;'
      ])
    )
  } catch {
    // Locked, unreadable or not the expected schema: report nothing.
    return []
  }
  if (!count) return []
  return [
    {
      subcategory: 'Download history',
      descriptionKey: 'privacyMacQuarantineNote',
      traces: [
        {
          path,
          size: 0,
          lastModified: Number(info.mtimeMs),
          entryCount: count,
          clean: () => clearQuarantineEvents(path, info)
        }
      ]
    }
  ]
}
