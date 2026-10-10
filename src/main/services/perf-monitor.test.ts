import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/channels'

const mocks = vi.hoisted(() => ({ processes: vi.fn(), memory: vi.fn() }))
vi.mock('systeminformation', () => ({
  processes: mocks.processes,
  currentLoad: async () => ({ currentLoad: 2, cpus: [{ load: 2 }] }),
  disksIO: async () => ({ rIO_sec: 0, wIO_sec: 0 }),
  networkStats: async () => [],
  mem: async () => ({ total: 4096, available: 2048, cached: 0, active: 2048 }),
  time: () => ({ uptime: 100 })
}))
vi.mock('./perf-memory', () => ({ collectWindowsMemory: mocks.memory }))
vi.mock('./perf-posix-processes', () => ({
  PosixProcessSampler: class {
    collect = async () => {
      const data = await mocks.processes()
      return {
        totalCount: data.all,
        processes: data.list.map((p: any) => ({ ...p, memBytes: p.memRss * 1024 }))
      }
    }
  },
  getPosixProcessIdentity: vi.fn()
}))
import { PerfMonitorService } from './perf-monitor'

describe('monitor process collection lifecycle', () => {
  let service: PerfMonitorService
  const sender = () => ({ isDestroyed: () => false, send: vi.fn() })
  const data = {
    all: 125,
    list: Array.from({ length: 125 }, (_, pid) => ({
      pid,
      parentPid: 1,
      name: 'app',
      memRss: 1024,
      cpu: 1,
      started: '2026-01-01'
    }))
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    service = new PerfMonitorService()
    mocks.processes.mockResolvedValue(data)
    mocks.memory.mockResolvedValue(null)
  })
  afterEach(() => {
    service.stopMonitoring()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  it('refuses a command fallback if the PID changed after the first termination attempt', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('process exited')
    })
    vi.spyOn(service, 'getProcessIdentity').mockResolvedValue({
      name: 'replacement',
      birthToken: 'new'
    })
    expect(await service.killProcess(1234, 'old')).toMatchObject({
      success: false,
      error: expect.stringContaining('Process changed')
    })
  })
  it('sends the complete inventory and corrected bytes without waiting for a timer', async () => {
    const target = sender()
    await service.startMonitoring(target as unknown as Electron.WebContents)
    await vi.advanceTimersByTimeAsync(0)
    const payload = target.send.mock.calls.find(
      ([channel]) => channel === IPC.PERF_PROCESS_LIST
    )?.[1]
    expect(payload.processes).toHaveLength(125)
    expect(payload.processes[124].memBytes).toBe(1024 ** 2)
    expect(payload.totalCount).toBe(125)
  })
  it('reports sampling failure and retries on the next slow tick', async () => {
    mocks.processes.mockRejectedValueOnce(new Error('unavailable'))
    const target = sender()
    await service.startMonitoring(target as unknown as Electron.WebContents)
    await vi.advanceTimersByTimeAsync(0)
    expect(target.send).toHaveBeenCalledWith(
      IPC.PERF_PROCESS_LIST,
      expect.objectContaining({ error: true })
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(target.send).toHaveBeenCalledWith(
      IPC.PERF_PROCESS_LIST,
      expect.objectContaining({ totalCount: 125 })
    )
  })
  it('treats SI resolved-empty provider failures as unavailable, not a fresh empty inventory', async () => {
    mocks.processes.mockResolvedValueOnce({ all: 0, list: [] })
    const target = sender()
    await service.startMonitoring(target as unknown as Electron.WebContents)
    await vi.advanceTimersByTimeAsync(0)
    expect(target.send).toHaveBeenCalledWith(
      IPC.PERF_PROCESS_LIST,
      expect.objectContaining({ error: true })
    )
    expect(
      target.send.mock.calls.filter(
        ([channel, sample]) => channel === IPC.PERF_PROCESS_LIST && !sample.error
      )
    ).toHaveLength(0)
  })
  it('does not overlap a hung collector or publish old results after stop and restart', async () => {
    let resolve!: (value: typeof data) => void
    mocks.processes.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const first = sender()
    await service.startMonitoring(first as unknown as Electron.WebContents)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.processes).toHaveBeenCalledTimes(1)
    service.stopMonitoring()
    const second = sender()
    await service.startMonitoring(second as unknown as Electron.WebContents)
    resolve(data)
    await vi.advanceTimersByTimeAsync(0)
    expect(first.send.mock.calls.some(([channel]) => channel === IPC.PERF_PROCESS_LIST)).toBe(false)
    expect(second.send.mock.calls.some(([channel]) => channel === IPC.PERF_PROCESS_LIST)).toBe(
      false
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(second.send).toHaveBeenCalledWith(
      IPC.PERF_PROCESS_LIST,
      expect.objectContaining({ totalCount: 125 })
    )
  })
})
