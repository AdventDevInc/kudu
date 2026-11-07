import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), fsStats: vi.fn() }))
vi.mock('child_process', () => ({ execFile: mocks.exec }))
vi.mock('util', () => ({ promisify: () => mocks.exec }))
vi.mock('systeminformation', () => ({ fsStats: mocks.fsStats }))
import { collectDiskThroughput } from './perf-disk'

afterEach(() => vi.restoreAllMocks())

describe('disk throughput', () => {
  it('reads Windows byte rates from the aggregate physical disk counter', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.exec.mockResolvedValue({
      stdout: JSON.stringify({ DiskReadBytesPersec: '1048576', DiskWriteBytesPersec: 2048 })
    })
    expect(await collectDiskThroughput()).toEqual({
      readBytesPerSec: 1048576,
      writeBytesPerSec: 2048
    })
    expect(mocks.exec).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        expect.stringContaining(
          'Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name=\'_Total\'"'
        )
      ]),
      expect.objectContaining({ timeout: 8000, windowsHide: true })
    )
  })

  it('uses byte rates on POSIX and clamps the first sample sentinel', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mocks.fsStats.mockResolvedValue({ rx_sec: -1, wx_sec: 8192 })
    expect(await collectDiskThroughput()).toEqual({ readBytesPerSec: 0, writeBytesPerSec: 8192 })
  })

  it.each(['invalid json', 'null', '{"DiskReadBytesPersec":-1,"DiskWriteBytesPersec":"NaN"}'])(
    'handles unavailable or invalid counters: %s',
    async (stdout) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      mocks.exec.mockResolvedValue({ stdout })
      expect(await collectDiskThroughput()).toEqual({ readBytesPerSec: 0, writeBytesPerSec: 0 })
    }
  )

  it('contains counter query failures', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.exec.mockRejectedValue(new Error('counter unavailable'))
    expect(await collectDiskThroughput()).toEqual({ readBytesPerSec: 0, writeBytesPerSec: 0 })
  })
})
