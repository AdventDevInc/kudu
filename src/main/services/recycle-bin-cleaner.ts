import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import { execTracked, psUtf8 } from './exec-utf8'

const MAX_PARALLEL_DELETES = 8

const QUERY_RECYCLE_BIN_DIRECTORIES_SCRIPT = `Add-Type -TypeDefinition 'using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Principal;
using System.Text;

public static class KuduRecycleBinDirectories {
  public static string Query() {
    var paths = new List<string>();
    string sid = WindowsIdentity.GetCurrent().User.Value;

    foreach (DriveInfo drive in DriveInfo.GetDrives()) {
      try {
        if (!drive.IsReady) continue;
        string directory = Path.Combine(drive.RootDirectory.FullName, "$Recycle.Bin", sid);
        if (!Directory.Exists(directory)) continue;
        paths.Add(Convert.ToBase64String(Encoding.UTF8.GetBytes(directory)));
      } catch { }
    }

    return string.Join(Environment.NewLine, paths.ToArray());
  }
}'; Write-Output ([KuduRecycleBinDirectories]::Query())`

const EMPTY_RECYCLE_BIN_SHELL_SCRIPT = `Add-Type -TypeDefinition 'using System;
using System.Runtime.InteropServices;

public static class KuduRecycleBinShell {
  [DllImport("Shell32.dll", CharSet = CharSet.Unicode)]
  public static extern uint SHEmptyRecycleBin(IntPtr hwnd, string pszRootPath, uint dwFlags);
}'; Write-Output ([KuduRecycleBinShell]::SHEmptyRecycleBin([IntPtr]::Zero, $null, 7))`

export interface FastRecycleBinCleanResult {
  payloadsFound: number
  payloadsDeleted: number
  payloadsFailed: number
  orphanMetadataDeleted: number
  accessDenied: boolean
}

/** Accept only the exact per-user bin shape produced by the Windows query. */
function isRecycleBinDirectory(path: string): boolean {
  return /^[A-Za-z]:\\\$Recycle\.Bin\\S-1-\d+(?:-\d+)+$/i.test(path)
}

export function parseRecycleBinDirectories(stdout: string): string[] {
  const unique = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const path = Buffer.from(line.trim(), 'base64').toString('utf-8')
      if (isRecycleBinDirectory(path)) unique.set(path.toLowerCase(), path)
    } catch {
      // Ignore malformed helper output rather than widening the delete scope.
    }
  }
  return [...unique.values()]
}

async function mapWithConcurrency<T>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const run = async (): Promise<void> => {
    while (next < values.length) {
      const index = next++
      await worker(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run))
}

/**
 * Empty one already-validated per-user Recycle Bin directory.
 *
 * `$R` payloads are removed in parallel, then their `$I` metadata records are
 * removed. If a payload fails, its metadata is deliberately retained so the
 * item is not turned into an invisible orphan. Directory links are safe here:
 * fs.rm removes the link itself and does not recurse into its target.
 */
export async function emptyRecycleBinDirectory(directory: string): Promise<FastRecycleBinCleanResult> {
  const result: FastRecycleBinCleanResult = {
    payloadsFound: 0,
    payloadsDeleted: 0,
    payloadsFailed: 0,
    orphanMetadataDeleted: 0,
    accessDenied: false,
  }

  const entries = await readdir(directory, { withFileTypes: true })
  const payloadNames = entries
    .map((entry) => entry.name)
    .filter((name) => name.toUpperCase().startsWith('$R'))
  result.payloadsFound = payloadNames.length

  await mapWithConcurrency(payloadNames, MAX_PARALLEL_DELETES, async (name) => {
    const payloadPath = join(directory, name)
    const metadataPath = join(directory, `$I${name.slice(2)}`)
    try {
      await rm(payloadPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      result.payloadsDeleted++
    } catch (err: any) {
      result.payloadsFailed++
      if (err?.code === 'EACCES' || err?.code === 'EPERM') result.accessDenied = true
      return
    }

    // Metadata is tiny and may already be absent after an interrupted empty.
    // A metadata failure does not turn the successfully removed payload into
    // a failed delete; the orphan cleanup below gets another chance at it.
    try {
      await rm(metadataPath, { force: true, maxRetries: 3, retryDelay: 50 })
    } catch (err: any) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') result.accessDenied = true
    }
  })

  // Remove only metadata whose payload is now absent. This clears the large
  // phantom `$I` tail left by an interrupted Windows shell empty operation.
  const remaining = await readdir(directory, { withFileTypes: true })
  const remainingPayloads = new Set(
    remaining
      .map((entry) => entry.name.toUpperCase())
      .filter((name) => name.startsWith('$R'))
      .map((name) => name.slice(2)),
  )
  const orphanMetadata = remaining
    .map((entry) => entry.name)
    .filter((name) => name.toUpperCase().startsWith('$I') && !remainingPayloads.has(name.slice(2).toUpperCase()))

  await mapWithConcurrency(orphanMetadata, MAX_PARALLEL_DELETES, async (name) => {
    try {
      await rm(join(directory, name), { force: true, maxRetries: 3, retryDelay: 50 })
      result.orphanMetadataDeleted++
    } catch (err: any) {
      if (err?.code === 'EACCES' || err?.code === 'EPERM') result.accessDenied = true
    }
  })

  return result
}

/** Delete the current user's bin payloads directly instead of shell-walking them serially. */
export async function emptyRecycleBinFast(): Promise<FastRecycleBinCleanResult> {
  const { stdout } = await execTracked('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    psUtf8(QUERY_RECYCLE_BIN_DIRECTORIES_SCRIPT),
  ], { windowsHide: true, timeout: 15_000 })

  const directories = parseRecycleBinDirectories(stdout)
  const results = await Promise.all(directories.map(async (directory) => {
    try {
      return await emptyRecycleBinDirectory(directory)
    } catch (err: any) {
      return {
        payloadsFound: 0,
        payloadsDeleted: 0,
        payloadsFailed: 1,
        orphanMetadataDeleted: 0,
        accessDenied: err?.code === 'EACCES' || err?.code === 'EPERM',
      }
    }
  }))
  return results.reduce<FastRecycleBinCleanResult>((total, current) => ({
    payloadsFound: total.payloadsFound + current.payloadsFound,
    payloadsDeleted: total.payloadsDeleted + current.payloadsDeleted,
    payloadsFailed: total.payloadsFailed + current.payloadsFailed,
    orphanMetadataDeleted: total.orphanMetadataDeleted + current.orphanMetadataDeleted,
    accessDenied: total.accessDenied || current.accessDenied,
  }), {
    payloadsFound: 0,
    payloadsDeleted: 0,
    payloadsFailed: 0,
    orphanMetadataDeleted: 0,
    accessDenied: false,
  })
}

/**
 * Ask Windows to finalize/refresh the bin after the direct delete. This is
 * normally an empty-bin no-op; the timeout keeps it from reintroducing the
 * unbounded shell walk that the fast path replaces.
 */
export async function finalizeRecycleBinShell(timeout = 10_000): Promise<number> {
  const { stdout } = await execTracked('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    psUtf8(EMPTY_RECYCLE_BIN_SHELL_SCRIPT),
  ], { windowsHide: true, timeout })
  return Number.parseInt(stdout.trim(), 10) || 0
}
