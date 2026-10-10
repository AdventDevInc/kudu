import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PerfWindowsMemory } from '../../shared/types'
import { psUtf8 } from './exec-utf8'

const execFileAsync = promisify(execFile)

export function parseWindowsMemory(value: unknown, timestamp: number): PerfWindowsMemory | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const read = (key: string): number | null => {
    const raw = data[key]
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return null
    const number = Number(raw)
    return Number.isFinite(number) && number >= 0 ? number : null
  }
  const committedBytes = read('CommittedBytes')
  const commitLimitBytes = read('CommitLimit')
  const pagesInputPerSec = read('PagesInputPersec')
  const pagesOutputPerSec = read('PagesOutputPersec')
  if (
    committedBytes === null ||
    !commitLimitBytes ||
    pagesInputPerSec === null ||
    pagesOutputPerSec === null
  )
    return null
  return { timestamp, committedBytes, commitLimitBytes, pagesInputPerSec, pagesOutputPerSec }
}

/** Named CIM properties avoid localized performance-counter paths. Slow cadence only. */
export async function collectWindowsMemory(): Promise<PerfWindowsMemory | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        psUtf8(
          '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object CommittedBytes,CommitLimit,PagesInputPersec,PagesOutputPersec | ConvertTo-Json -Compress'
        )
      ],
      { timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 }
    )
    return parseWindowsMemory(JSON.parse(stdout.trim()), Date.now())
  } catch {
    return null
  }
}
