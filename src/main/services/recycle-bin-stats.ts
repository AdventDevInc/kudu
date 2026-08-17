import { execTracked, psUtf8 } from './exec-utf8'

export interface RecycleBinStats {
  count: number
  size: number
}

const QUERY_RECYCLE_BIN_SCRIPT = `Add-Type -TypeDefinition 'using System;
using System.Globalization;
using System.IO;
using System.Collections.Generic;
using System.Security.Principal;

public static class KuduRecycleBinMetadata {
  public static string Query() {
    long count = 0;
    long totalSize = 0;
    string sid = WindowsIdentity.GetCurrent().User.Value;

    foreach (DriveInfo drive in DriveInfo.GetDrives()) {
      try {
        if (!drive.IsReady) continue;
        string directory = Path.Combine(drive.RootDirectory.FullName, "$Recycle.Bin", sid);
        if (!Directory.Exists(directory)) continue;

        var pairedPayloads = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in Directory.EnumerateFiles(directory, "$I*", SearchOption.TopDirectoryOnly)) {
          try {
            string name = Path.GetFileName(path);
            if (name.Length < 3) continue;
            string payload = Path.Combine(directory, "$R" + name.Substring(2));

            // Interrupted or externally aborted empties can leave thousands
            // of tiny $I records after their actual $R payloads are gone.
            // They are not restorable items and must not inflate the scan.
            if (!File.Exists(payload) && !Directory.Exists(payload)) continue;

            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
              FileShare.ReadWrite | FileShare.Delete)) {
              if (stream.Length < 16) continue;
              var bytes = new byte[8];
              stream.Position = 8;
              if (stream.Read(bytes, 0, bytes.Length) != bytes.Length) continue;
              long size = BitConverter.ToInt64(bytes, 0);
              count++;
              if (size > 0) totalSize += size;
              pairedPayloads.Add(payload);
            }
          } catch { }
        }

        // Also surface orphaned $R payloads. Their original metadata and
        // directory size are unavailable without a costly recursive walk,
        // but they still occupy the bin and should keep it cleanable.
        foreach (string payload in Directory.EnumerateFileSystemEntries(directory, "$R*", SearchOption.TopDirectoryOnly)) {
          try {
            if (pairedPayloads.Contains(payload)) continue;
            count++;
            if (File.Exists(payload)) {
              long size = new FileInfo(payload).Length;
              if (size > 0) totalSize += size;
            }
          } catch { }
        }
      } catch { }
    }

    return count.ToString(CultureInfo.InvariantCulture) + "|" +
      totalSize.ToString(CultureInfo.InvariantCulture);
  }
}'; Write-Output ([KuduRecycleBinMetadata]::Query())`

export function parseRecycleBinStats(stdout: string): RecycleBinStats {
  const [countText, sizeText] = stdout.trim().split('|')
  const count = Number.parseInt(countText, 10)
  const size = Number.parseInt(sizeText, 10)
  return {
    count: Number.isFinite(count) && count > 0 ? count : 0,
    size: Number.isFinite(size) && size > 0 ? size : 0,
  }
}

/**
 * Read aggregate Windows Recycle Bin statistics from its small `$I` metadata
 * records and top-level `$R` payload names. This avoids asking the shell for
 * every item's Size property, which recursively walks deleted folders and can
 * turn a large-bin scan into hours. Metadata without a payload is ignored;
 * payloads without metadata remain visible with their non-recursive size.
 */
export async function queryRecycleBinStats(): Promise<RecycleBinStats> {
  const { stdout } = await execTracked('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    psUtf8(QUERY_RECYCLE_BIN_SCRIPT),
  ], { windowsHide: true, timeout: 15_000 })
  return parseRecycleBinStats(stdout)
}
