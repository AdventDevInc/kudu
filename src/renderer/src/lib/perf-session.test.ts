import { describe, expect, it, vi } from 'vitest'
import { createPerfSession } from './perf-session'
import type { PerfSystemInfo, PerfProcessList } from '@shared/types'

function fixture() {
  const info = { cpuModel: 'CPU' } as PerfSystemInfo
  let onProcesses!: (data: PerfProcessList) => void
  const stopProcesses = vi.fn()
  const stopSnapshot = vi.fn()
  const api = {
    perfGetSystemInfo: vi.fn().mockResolvedValue(info),
    perfGetDiskHealth: vi.fn().mockResolvedValue([]),
    perfStartMonitoring: vi.fn().mockResolvedValue(undefined),
    perfStopMonitoring: vi.fn().mockResolvedValue(undefined),
    onPerfSnapshot: vi.fn(() => stopSnapshot),
    onPerfProcessList: vi.fn((callback) => {
      onProcesses = callback
      return stopProcesses
    })
  }
  const callbacks = { info: vi.fn(), disks: vi.fn(), snapshot: vi.fn(), processes: vi.fn() }
  const session = createPerfSession(api, callbacks)
  return {
    api,
    callbacks,
    session,
    info,
    emit: (data: PerfProcessList) => onProcesses(data),
    stopProcesses,
    stopSnapshot
  }
}

describe('performance monitoring startup and retry', () => {
  it('recovers initial metadata rejection with working subscriptions and refreshed info', async () => {
    const f = fixture()
    f.api.perfGetSystemInfo.mockRejectedValueOnce(new Error('temporary'))
    await expect(f.session.start()).rejects.toThrow('temporary')
    expect(f.api.perfStartMonitoring).not.toHaveBeenCalled()
    expect(await f.session.start()).toBe(true)
    expect(f.api.perfGetSystemInfo).toHaveBeenCalledTimes(2)
    expect(f.callbacks.info).toHaveBeenCalledWith(f.info)
    expect(f.api.onPerfProcessList).toHaveBeenCalledTimes(1)
    const sample = { timestamp: 1, processes: [], totalCount: 0 }
    f.emit(sample)
    expect(f.callbacks.processes).toHaveBeenCalledWith(sample)
    f.session.dispose()
    expect(f.stopSnapshot).toHaveBeenCalledOnce()
    expect(f.stopProcesses).toHaveBeenCalledOnce()
  })
  it('does not restart monitoring after unmount during delayed metadata load', async () => {
    const f = fixture()
    let resolve!: (info: PerfSystemInfo) => void
    f.api.perfGetSystemInfo.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = f.session.start()
    f.session.dispose()
    resolve(f.info)
    expect(await pending).toBe(false)
    expect(f.api.perfStartMonitoring).not.toHaveBeenCalled()
    expect(f.callbacks.info).not.toHaveBeenCalled()
  })
})
