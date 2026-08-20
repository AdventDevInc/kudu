import { basename, join } from 'path'
import { tmpdir } from 'os'
import { lstat, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import type { CleanerBlocker, ScanItem } from '../../shared/types'
import { getCachedItems } from './scan-cache'
import { execTracked, psUtf8 } from './exec-utf8'

const MAX_CANDIDATE_FILES = 512
const MAX_GROUPS = 64
const MAX_DIRECTORY_DEPTH = 6
const MAX_VISITED_PER_ROOT = 256

const BROWSER_DISPLAY_NAMES: Record<string, string> = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  brave: 'Brave Browser',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  firefox: 'Firefox',
  arc: 'Arc',
  chromium: 'Chromium',
  thorium: 'Thorium',
  supermium: 'Supermium',
  helium: 'Helium',
  cromite: 'Cromite',
  catsxp: 'CatsXP',
  librewolf: 'LibreWolf',
  waterfox: 'Waterfox',
  floorp: 'Floorp',
  zen: 'Zen Browser',
}

interface RestartManagerProcess {
  pid?: unknown
  name?: unknown
  processName?: unknown
  executablePath?: unknown
}

const RESTART_MANAGER_SCRIPT = `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class KuduRestartManager {
  const int ERROR_SUCCESS = 0;
  const int ERROR_MORE_DATA = 234;
  const int CCH_RM_SESSION_KEY = 32;

  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  public enum RM_APP_TYPE {
    RmUnknownApp = 0, RmMainWindow = 1, RmOtherWindow = 2,
    RmService = 3, RmExplorer = 4, RmConsole = 5, RmCritical = 1000
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public RM_APP_TYPE ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint handle, int flags, StringBuilder sessionKey);

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint handle, uint fileCount,
    string[] fileNames, uint appCount, RM_UNIQUE_PROCESS[] apps,
    uint serviceCount, string[] serviceNames);

  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint handle, out uint needed, ref uint count,
    [In, Out] RM_PROCESS_INFO[] affectedApps, ref uint rebootReasons);

  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint handle);

  public static RM_PROCESS_INFO[] Find(string[] paths) {
    uint handle;
    var key = new StringBuilder(CCH_RM_SESSION_KEY + 1);
    int result = RmStartSession(out handle, 0, key);
    if (result != ERROR_SUCCESS) return new RM_PROCESS_INFO[0];

    try {
      result = RmRegisterResources(handle, (uint)paths.Length, paths, 0, null, 0, null);
      if (result != ERROR_SUCCESS) return new RM_PROCESS_INFO[0];

      uint needed = 0;
      uint count = 0;
      uint reasons = 0;
      result = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (result == ERROR_SUCCESS || needed == 0) return new RM_PROCESS_INFO[0];
      if (result != ERROR_MORE_DATA) return new RM_PROCESS_INFO[0];

      var processes = new RM_PROCESS_INFO[needed];
      count = needed;
      result = RmGetList(handle, out needed, ref count, processes, ref reasons);
      if (result != ERROR_SUCCESS) return new RM_PROCESS_INFO[0];
      if (count == processes.Length) return processes;

      var trimmed = new RM_PROCESS_INFO[count];
      Array.Copy(processes, trimmed, count);
      return trimmed;
    } finally {
      RmEndSession(handle);
    }
  }
}
'@
$paths = [string[]](Get-Content -Raw -LiteralPath '__PATH_FILE__' | ConvertFrom-Json)
$out = @([KuduRestartManager]::Find($paths) | ForEach-Object {
  $processId = [int]$_.Process.dwProcessId
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    pid = $processId
    name = [string]$_.strAppName
    processName = if ($process) { [string]$process.ProcessName } else { '' }
    executablePath = if ($process) { [string]$process.Path } else { '' }
  }
})
ConvertTo-Json -InputObject $out -Compress`

function normalizedProcessName(value: string): string {
  return value.trim().replace(/\.exe$/i, '').toLowerCase()
}

function sameWindowsPath(a: string, b: string): boolean {
  return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()
}

function friendlyProcessName(processName: string, restartManagerName: string): string {
  const normalized = normalizedProcessName(processName)
  return BROWSER_DISPLAY_NAMES[normalized]
    || restartManagerName.trim()
    || processName.trim().replace(/\.exe$/i, '')
    || 'Unknown application'
}

export function parseRestartManagerBlockers(
  stdout: string,
  currentExecutable = process.execPath,
): CleanerBlocker[] {
  let parsed: RestartManagerProcess[]
  try {
    const value = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
    parsed = Array.isArray(value) ? value : [value]
  } catch {
    return []
  }

  const ownProcessName = normalizedProcessName(basename(currentExecutable))
  const blockers = new Map<string, CleanerBlocker>()

  for (const entry of parsed) {
    const pid = typeof entry?.pid === 'number' ? entry.pid : Number(entry?.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue

    const processName = typeof entry.processName === 'string' ? entry.processName : ''
    const executablePath = typeof entry.executablePath === 'string' ? entry.executablePath : ''
    const restartManagerName = typeof entry.name === 'string' ? entry.name : ''
    const normalized = normalizedProcessName(processName)

    // Every packaged Kudu window/utility process uses the same executable.
    // It cannot be closed while this UI is asking the user what to close, so
    // omit it from the actionable list. In development, do not hide every
    // Electron process merely because the current host is electron.exe.
    if (
      (executablePath && sameWindowsPath(executablePath, currentExecutable))
      || (ownProcessName !== 'electron' && normalized === ownProcessName)
    ) continue

    const name = friendlyProcessName(processName, restartManagerName)
    const key = (normalized || name).toLowerCase()
    if (!blockers.has(key)) {
      blockers.set(key, {
        pid,
        name,
        processName: processName || restartManagerName,
        isBrowser: normalized in BROWSER_DISPLAY_NAMES,
      })
    }
  }

  return [...blockers.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function filesBelow(root: string, limit: number): Promise<string[]> {
  const files: string[] = []
  let rootInfo: Awaited<ReturnType<typeof lstat>>
  try {
    rootInfo = await lstat(root)
  } catch {
    return files
  }

  if (rootInfo.isSymbolicLink()) return files
  if (rootInfo.isFile()) return [root]
  if (!rootInfo.isDirectory()) return files

  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  let visited = 0
  for (let index = 0; index < queue.length && files.length < limit; index++) {
    const current = queue[index]
    if (current.depth >= MAX_DIRECTORY_DEPTH || visited >= MAX_VISITED_PER_ROOT) continue
    try {
      const entries = await readdir(current.path, { withFileTypes: true })
      for (const entry of entries) {
        if (files.length >= limit || visited >= MAX_VISITED_PER_ROOT) break
        visited++
        if (entry.isSymbolicLink()) continue
        const path = join(current.path, entry.name)
        if (entry.isFile()) files.push(path)
        else if (entry.isDirectory()) queue.push({ path, depth: current.depth + 1 })
      }
    } catch {
      // Missing or inaccessible candidates simply cannot contribute a warning.
    }
  }
  return files
}

/**
 * Pick actual files fairly across the largest selected subcategories. Restart
 * Manager rejects directory paths, and registering every file from a very
 * large browser cache would make the post-scan check rival the scan itself.
 */
export async function collectBlockerCandidateFiles(
  items: ScanItem[],
  maxFiles = MAX_CANDIDATE_FILES,
): Promise<string[]> {
  if (maxFiles <= 0) return []

  const groups = new Map<string, { size: number; items: ScanItem[] }>()
  for (const item of items) {
    const key = `${item.category}\u0000${item.subcategory}`
    const group = groups.get(key) || { size: 0, items: [] }
    group.size += Math.max(0, item.size)
    group.items.push(item)
    groups.set(key, group)
  }

  const selectedGroups = [...groups.values()]
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_GROUPS)
  if (selectedGroups.length === 0) return []

  const perGroup = Math.max(1, Math.floor(maxFiles / selectedGroups.length))
  const candidates = new Set<string>()

  for (const group of selectedGroups) {
    const rootsToSample = Math.min(group.items.length, perGroup)
    let groupCandidates = 0
    for (let index = 0; index < rootsToSample && candidates.size < maxFiles; index++) {
      const rootIndex = Math.floor(index * group.items.length / rootsToSample)
      const remainingForGroup = perGroup - groupCandidates
      if (remainingForGroup <= 0) break
      const paths = await filesBelow(group.items[rootIndex].path, remainingForGroup)
      for (const path of paths) {
        const before = candidates.size
        candidates.add(path)
        if (candidates.size > before) groupCandidates++
        if (candidates.size >= maxFiles) break
      }
    }
  }

  return [...candidates]
}

export async function findWindowsFileBlockers(paths: string[]): Promise<CleanerBlocker[]> {
  if (paths.length === 0) return []

  const tempDir = await mkdtemp(join(tmpdir(), 'kudu-blockers-'))
  const pathFile = join(tempDir, 'paths.json')
  try {
    await writeFile(pathFile, JSON.stringify(paths), 'utf8')
    const escapedPath = pathFile.replace(/'/g, "''")
    const script = RESTART_MANAGER_SCRIPT.replace('__PATH_FILE__', escapedPath)
    const { stdout } = await execTracked('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      psUtf8(script),
    ], { windowsHide: true, timeout: 15_000 })
    return parseRestartManagerBlockers(stdout)
  } catch {
    // This is advisory. A failed preflight must never prevent cleaning.
    return []
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function findCleanerBlockers(itemIds: unknown): Promise<CleanerBlocker[]> {
  if (process.platform !== 'win32' || !Array.isArray(itemIds)) return []
  if (
    itemIds.length > 250_000
    || !itemIds.every((id) => typeof id === 'string' && id.length <= 100)
  ) return []
  const ids = [...new Set(itemIds as string[])]
  const items = getCachedItems(ids)
  const files = await collectBlockerCandidateFiles(items)
  return findWindowsFileBlockers(files)
}
