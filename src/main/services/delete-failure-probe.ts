import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execTracked, psUtf8 } from './exec-utf8'

export type WindowsDeleteFailureReason = 'in-use' | 'permission-denied'

const MAX_PROBED_PATHS = 10_000

const DELETE_ACCESS_PROBE = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class KuduDeleteAccessProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
    IntPtr security, uint creation, uint flags, IntPtr template);

  public static int Probe(string path, bool directory) {
    using (var handle = CreateFileW(path, 0x00010000, 7, IntPtr.Zero, 3,
      directory ? 0x02000000u : 0u, IntPtr.Zero)) {
      return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
    }
  }
}
'@
$paths = [string[]](Get-Content -Raw -LiteralPath '__PATH_FILE__' | ConvertFrom-Json)
$out = @($paths | ForEach-Object {
  $path = [string]$_
  [PSCustomObject]@{
    path = $path
    code = [KuduDeleteAccessProbe]::Probe($path, [IO.Directory]::Exists($path))
  }
})
ConvertTo-Json -InputObject $out -Compress`

interface ProbeResult {
  path?: unknown
  code?: unknown
}

export function parseWindowsDeleteProbe(stdout: string): Map<string, WindowsDeleteFailureReason> {
  const classifications = new Map<string, WindowsDeleteFailureReason>()
  let parsed: ProbeResult[]
  try {
    const value = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
    parsed = Array.isArray(value) ? value : [value]
  } catch {
    return classifications
  }

  for (const result of parsed) {
    if (typeof result.path !== 'string') continue
    const code = Number(result.code)
    if (code === 5) classifications.set(result.path.toLowerCase(), 'permission-denied')
    else if (code === 32 || code === 33) classifications.set(result.path.toLowerCase(), 'in-use')
  }
  return classifications
}

/** Probe Windows DELETE access without deleting or modifying the target. */
export async function probeWindowsDeleteFailures(
  paths: string[],
): Promise<Map<string, WindowsDeleteFailureReason>> {
  const uniquePaths = [...new Set(paths)].slice(0, MAX_PROBED_PATHS)
  if (uniquePaths.length === 0) return new Map()

  const tempDir = await mkdtemp(join(tmpdir(), 'kudu-delete-probe-'))
  const pathFile = join(tempDir, 'paths.json')
  try {
    await writeFile(pathFile, JSON.stringify(uniquePaths), 'utf8')
    const script = DELETE_ACCESS_PROBE.replace('__PATH_FILE__', pathFile.replace(/'/g, "''"))
    const { stdout } = await execTracked('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      psUtf8(script),
    ], { windowsHide: true, timeout: 15_000 })
    return parseWindowsDeleteProbe(stdout)
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
