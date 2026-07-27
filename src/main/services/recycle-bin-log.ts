import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { psUtf8 } from './exec-utf8'
import { getSettings } from './settings-store'
import { recordDeletions } from './deletion-log-store'
import type { DeletedFileRecord, DeletionOrigin } from '../../shared/types'

/**
 * Deletion-log support for the Windows Recycle Bin.
 *
 * Emptying the bin goes through the shell rather than cleanItems — in two
 * separate implementations, the IPC handler and the CLI — so neither picks up
 * the logging that lives in cleanItems. That leaves the one clean which
 * permanently destroys *recoverable* files as the one with no audit trail,
 * which is backwards. Both callers use the helpers here instead.
 */

const execFileAsync = promisify(execFile)

export interface RecycleBinEntry {
  /** Original location of the file, where Windows will tell us */
  path: string
  size: number
}

function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', psUtf8(script)]
}

export function isDeletionLoggingEnabled(): boolean {
  try {
    return getSettings().cleaner.keepDeletionLog === true
  } catch {
    return false
  }
}

/**
 * List what's currently in the Recycle Bin, by original location.
 * Best-effort: any failure means no records, never a blocked clean.
 */
export async function listRecycleBinContents(): Promise<RecycleBinEntry[]> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', psArgs(
      `$shell = New-Object -ComObject Shell.Application; $rb = $shell.NameSpace(0x0a); ` +
      `$out = @(); foreach ($i in $rb.Items()) { ` +
      `$origin = $rb.GetDetailsOf($i, 1); ` +
      `$out += [PSCustomObject]@{ name = $i.Name; origin = $origin; size = $i.Size } }; ` +
      `ConvertTo-Json -InputObject @($out) -Compress`
    ), { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })

    const parsed = JSON.parse(stdout.trim() || '[]')
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .filter((r) => r && typeof r.name === 'string' && r.name.length > 0)
      .map((r) => ({
        // GetDetailsOf(item, 1) is the original folder. Fall back to the bare
        // name when Windows won't say where the file came from.
        path: typeof r.origin === 'string' && r.origin.length > 0 ? join(r.origin, r.name) : r.name,
        size: typeof r.size === 'number' ? r.size : 0,
      }))
  } catch {
    return []
  }
}

/**
 * Record the entries from `before` that the bin no longer holds.
 *
 * The shell APIs don't report which items they kept, so this re-reads the bin
 * and diffs rather than assuming the empty was total — naming a file that is
 * still sitting in the bin would trade one wrong answer for another.
 */
export async function recordEmptiedRecycleBin(
  before: RecycleBinEntry[],
  origin: DeletionOrigin
): Promise<void> {
  if (before.length === 0) return

  const survivors = new Set((await listRecycleBinContents()).map((entry) => entry.path))
  const emptied = before.filter((entry) => !survivors.has(entry.path))
  if (emptied.length === 0) return

  const ts = new Date().toISOString()
  recordDeletions(emptied.map<DeletedFileRecord>((entry) => ({
    ts,
    path: entry.path,
    size: entry.size,
    category: 'Recycle Bin',
    origin,
  })))
}
