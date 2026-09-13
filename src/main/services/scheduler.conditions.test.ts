import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { ScheduleEntry } from '../../shared/types'
const mocks = vi.hoisted(() => ({
  entries: [] as ScheduleEntry[],
  battery: false,
  idle: 1000,
  disks: [] as { mount: string; size: number; available: number }[],
  send: vi.fn(),
  claim: vi.fn(),
  patch: vi.fn()
}))
// Home and its volume must agree with path.parse on the host platform.
const home = process.platform === 'win32' ? 'C:\\Users\\test' : '/home/test'
const mount = process.platform === 'win32' ? 'C:\\' : '/'
vi.mock('electron', () => ({
  app: { getPath: () => home },
  BrowserWindow: class {},
  Notification: { isSupported: () => false },
  powerMonitor: { getSystemIdleTime: () => mocks.idle, isOnBatteryPower: () => mocks.battery }
}))
vi.mock('./settings-store', () => ({
  getSettings: () => ({ schedules: mocks.entries }),
  updateScheduleEntry: mocks.patch,
  flushSettings: async () => {},
  claimScheduleOccurrence: mocks.claim
}))
vi.mock('./logger', () => ({ logInfo: vi.fn() }))
vi.mock('../ipc/game-mode.ipc', () => ({
  getGameModeStatus: () => ({ active: false, pendingRestore: false })
}))
vi.mock('systeminformation', () => ({ default: { fsSize: async () => mocks.disks } }))
import {
  startScheduler,
  stopScheduler,
  authorizeScheduleStep,
  acknowledgeScheduleRun,
  completeScheduleRun,
  getScheduleRuntime
} from './scheduler'
function makeWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: mocks.send
  })
  return { destroyed: false, isDestroyed: () => false, webContents }
}
let window = makeWindow()
const entry: ScheduleEntry = {
  id: 'one',
  name: 'Test',
  enabled: true,
  frequency: 'daily',
  day: 1,
  hour: 9,
  tasks: ['cleaner:system'],
  autoApply: true,
  lastRunAt: null,
  lastRunStatus: 'never',
  createdAt: '2026-01-01',
  missedRun: 'once',
  conditions: { acOnly: true, idleMinutes: 5 }
}
const payload = (call = 0) => mocks.send.mock.calls[call][1]
const runtimeOf = (id: string) => getScheduleRuntime().find((r) => r.id === id)
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-13T09:00:00'))
  window = makeWindow()
  mocks.entries = [structuredClone(entry)]
  mocks.battery = false
  mocks.idle = 1000
  mocks.disks = [{ mount, size: 100, available: 10 }]
  mocks.send.mockReset()
  mocks.patch.mockReset().mockImplementation((id, patch) => {
    const target = mocks.entries.find((e) => e.id === id)
    if (target) Object.assign(target, patch)
  })
  mocks.claim.mockReset().mockImplementation(async (e, due) => {
    e.lastDueAt = due
    return true
  })
})
afterEach(() => {
  stopScheduler()
  vi.useRealTimers()
})
it('defers without consuming the occurrence, then starts once conditions become suitable', async () => {
  mocks.battery = true
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.claim).not.toHaveBeenCalled()
  expect(getScheduleRuntime()[0].reason).toBe('power')
  mocks.battery = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.claim).toHaveBeenCalledBefore(mocks.send)
})
it('invalidates a queued definition and rechecks power before each step', async () => {
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect((await authorizeScheduleStep('one', payload().runId)).allowed).toBe(true)
  mocks.battery = true
  expect((await authorizeScheduleStep('one', payload().runId)).reason).toBe('power')
  mocks.battery = false
  mocks.entries = [{ ...mocks.entries[0], tasks: ['registry'] }]
  expect((await authorizeScheduleStep('one', payload().runId)).reason).toBe('changed')
  expect((await authorizeScheduleStep('one', 'forged')).allowed).toBe(false)
})
it('gates disk space and the maintenance window at the start only', async () => {
  mocks.entries = [
    { ...entry, conditions: { freeBelowPercent: 20, windowStart: 9 * 60, windowEnd: 9 * 60 + 30 } }
  ]
  mocks.disks = [{ mount, size: 100, available: 50 }]
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).not.toHaveBeenCalled()
  expect(runtimeOf('one')?.reason).toBe('disk')
  mocks.disks = [{ mount, size: 100, available: 10 }]
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  // The first step freed space and the window closed; later steps still run.
  mocks.disks = [{ mount, size: 100, available: 50 }]
  vi.setSystemTime(new Date('2026-09-13T10:00:00'))
  expect((await authorizeScheduleStep('one', payload().runId)).allowed).toBe(true)
})
it('runs two schedules due in the same minute one after the other', async () => {
  mocks.entries = [
    { ...entry, missedRun: undefined },
    { ...entry, id: 'two', missedRun: undefined }
  ]
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(acknowledgeScheduleRun('one', payload().runId)).toBe(true)
  await vi.advanceTimersByTimeAsync(3 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(runtimeOf('two')?.reason).toBe('busy')
  await completeScheduleRun('one', 'success', payload().runId)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).scheduleId).toBe('two')
  expect(mocks.patch).not.toHaveBeenCalledWith(
    'two',
    expect.objectContaining({ lastRunStatus: 'skipped' })
  )
})
it('holds the execution lock for an acknowledged run and ignores stale completions', async () => {
  mocks.entries.push({ ...entry, id: 'two' })
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  acknowledgeScheduleRun('one', payload().runId)
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  await completeScheduleRun('one', 'success', 'stale')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  completeScheduleRun('one', 'success', payload().runId)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
})
it('rolls back a trigger nobody acknowledged and retries the occurrence', async () => {
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(mocks.patch).toHaveBeenCalledWith('one', { lastDueAt: null })
  expect(runtimeOf('one')).toMatchObject({ running: false, reason: 'unavailable' })
  expect((await authorizeScheduleStep('one', payload().runId)).allowed).toBe(false)
  await vi.advanceTimersByTimeAsync(40_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).runId).not.toBe(payload().runId)
  expect(acknowledgeScheduleRun('one', payload(1).runId)).toBe(true)
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
})
it('does not roll back a run that started with an authorization', async () => {
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  await authorizeScheduleStep('one', payload().runId)
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.patch).not.toHaveBeenCalled()
})
it('records a failed run and keeps scheduling when the renderer goes away', async () => {
  mocks.entries.push({ ...entry, id: 'two' })
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  acknowledgeScheduleRun('one', payload().runId)
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  expect(mocks.patch).toHaveBeenCalledWith(
    'one',
    expect.objectContaining({ lastRunStatus: 'failed' })
  )
  expect(runtimeOf('one')?.reason).toBe('interrupted')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).scheduleId).toBe('two')
  // A reload after completion must not touch the next run.
  await completeScheduleRun('two', 'success', payload(1).runId)
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(mocks.patch).not.toHaveBeenCalledWith(
    'two',
    expect.objectContaining({ lastRunStatus: 'failed' })
  )
})
it('finalizes a run whose window was destroyed and evaluates against the new window', async () => {
  mocks.entries.push({ ...entry, id: 'two' })
  let current = window
  startScheduler(() => current as any)
  await vi.advanceTimersByTimeAsync(5000)
  acknowledgeScheduleRun('one', payload().runId)
  window.isDestroyed = () => true
  window.webContents.isDestroyed = () => true
  current = makeWindow()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.patch).toHaveBeenCalledWith(
    'one',
    expect.objectContaining({ lastRunStatus: 'failed' })
  )
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).scheduleId).toBe('two')
})
it('records a skipped run when a skip-policy occurrence expires on unmet conditions', async () => {
  mocks.entries = [{ ...entry, missedRun: undefined }]
  mocks.battery = true
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000 + 60_000)
  expect(mocks.patch).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(mocks.patch).toHaveBeenCalledWith(
    'one',
    expect.objectContaining({ lastRunStatus: 'skipped' })
  )
  expect(mocks.send).not.toHaveBeenCalled()
})
it('does not dispatch when persisting the consumed occurrence fails', async () => {
  mocks.claim.mockRejectedValue(new Error('Disk full'))
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).not.toHaveBeenCalled()
})
