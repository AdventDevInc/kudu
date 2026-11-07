import * as si from 'systeminformation'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { psUtf8 } from './exec-utf8'

const execFileAsync = promisify(execFile)
const rate = (value: unknown): number => {
  if (typeof value !== 'number' && typeof value !== 'string') return 0
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

/** disksIO reports operation counts and does not support Windows. */
export async function collectDiskThroughput(): Promise<{
  readBytesPerSec: number
  writeBytesPerSec: number
}> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          psUtf8(
            '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name=\'_Total\'" | Select-Object DiskReadBytesPersec,DiskWriteBytesPersec | ConvertTo-Json -Compress'
          )
        ],
        { timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 }
      )
      const data = JSON.parse(stdout.trim())
      return {
        readBytesPerSec: rate(data?.DiskReadBytesPersec),
        writeBytesPerSec: rate(data?.DiskWriteBytesPersec)
      }
    }
    const data = await si.fsStats()
    return { readBytesPerSec: rate(data?.rx_sec), writeBytesPerSec: rate(data?.wx_sec) }
  } catch {
    return { readBytesPerSec: 0, writeBytesPerSec: 0 }
  }
}
