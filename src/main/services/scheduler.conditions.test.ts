import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { ScheduleEntry } from '../../shared/types'
const mocks = vi.hoisted(() => ({
  entries: [] as ScheduleEntry[],
  battery: false,
  idle: 1000,
  send: vi.fn(),
  claim: vi.fn(),
  patch: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\Users\\test' },
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
import {
  startScheduler,
  stopScheduler,
  authorizeScheduleStep,
  completeScheduleRun,
  getScheduleRuntime
} from './scheduler'
const window = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, isCrashed: () => false, send: mocks.send }
}
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
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-13T09:00:00'))
  mocks.entries = [structuredClone(entry)]
  mocks.battery = false
  mocks.idle = 1000
  mocks.send.mockReset()
  mocks.patch.mockReset()
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
  const payload = mocks.send.mock.calls[0][1]
  expect((await authorizeScheduleStep('one', payload.runId)).allowed).toBe(true)
  mocks.battery = true
  expect((await authorizeScheduleStep('one', payload.runId)).reason).toBe('power')
  mocks.battery = false
  mocks.entries = [{ ...mocks.entries[0], tasks: ['registry'] }]
  expect((await authorizeScheduleStep('one', payload.runId)).reason).toBe('changed')
  expect((await authorizeScheduleStep('one', 'forged')).allowed).toBe(false)
})
it('holds the execution lock beyond ten minutes and ignores stale completions', async () => {
  mocks.entries.push({ ...entry, id: 'two' })
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  await completeScheduleRun('one', 'success', 'stale')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  const payload = mocks.send.mock.calls[0][1]
  completeScheduleRun('one', 'success', payload.runId)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
})
it('does not dispatch when persisting the consumed occurrence fails', async () => {
  mocks.claim.mockRejectedValue(new Error('Disk full'))
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).not.toHaveBeenCalled()
})
