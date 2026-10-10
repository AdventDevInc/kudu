import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/channels'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  identity: vi.fn(),
  kill: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mocks.handlers.set(name, fn) }
}))
vi.mock('../services/perf-monitor', () => ({
  PerfMonitorService: class {
    getProcessIdentity = mocks.identity
    killProcess = mocks.kill
  }
}))
import { registerPerfMonitorIpc } from './perf-monitor.ipc'

describe('individual process termination identity checks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerPerfMonitorIpc(() => null)
    mocks.identity.mockResolvedValue({ name: 'browser.exe', birthToken: 'old-start' })
    mocks.kill.mockResolvedValue({ success: true })
  })
  const end = (pid: number, started?: string) =>
    mocks.handlers.get(IPC.PERF_KILL_PROCESS)!({}, pid, started)
  it.each([0, 1, 4, -5, 5.5, NaN, process.pid])(
    'rejects invalid, critical and own PID %s',
    async (pid) => {
      expect((await end(pid, 'old-start')).success).toBe(false)
      expect(mocks.kill).not.toHaveBeenCalled()
    }
  )
  it('refuses a reused PID, missing start time or failed lookup', async () => {
    expect((await end(1234, 'different-start')).success).toBe(false)
    expect((await end(1234)).success).toBe(false)
    mocks.identity.mockResolvedValue(null)
    expect((await end(1234, 'old-start')).success).toBe(false)
    expect(mocks.kill).not.toHaveBeenCalled()
  })
  it('retains protected process checks after identity validation', async () => {
    mocks.identity.mockResolvedValue({ name: 'LSASS.EXE', birthToken: 'old-start' })
    expect((await end(1234, 'old-start')).success).toBe(false)
    expect(mocks.kill).not.toHaveBeenCalled()
  })
  it('ends only the selected verified PID, never its group or process tree', async () => {
    expect(await end(1234, 'old-start')).toEqual({ success: true })
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(1234, 'old-start')
  })
})
