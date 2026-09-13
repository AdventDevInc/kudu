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
  working: false,
  workDone: 0,
  fsSize: vi.fn(),
  patch: vi.fn()
}))
// Home and its volume must agree with path.parse on the host platform.
const home = process.platform === 'win32' ? 'C:\\Users\\test' : '/home/test'
const mount = process.platform === 'win32' ? 'C:\\' : '/'
// A separate volume holding the home directory, and a sibling that does not contain it.
const homeMount = process.platform === 'win32' ? 'C:\\Users' : '/home'
const siblingMount = process.platform === 'win32' ? 'C:\\Users\\testing' : '/home/testing'
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
vi.mock('./main-work', () => ({
  hasMainWorkInFlight: () => mocks.working,
  mainWorkGeneration: () => mocks.workDone
}))
vi.mock('../ipc/game-mode.ipc', () => ({
  getGameModeStatus: () => ({ active: false, pendingRestore: false })
}))
vi.mock('systeminformation', () => ({ default: { fsSize: () => mocks.fsSize() } }))
import {
  startScheduler,
  stopScheduler,
  authorizeScheduleStep,
  acknowledgeScheduleRun,
  completeScheduleRun,
  getScheduleRuntime,
  runScheduleNow
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
  mocks.working = false
  mocks.workDone = 0
  mocks.fsSize.mockReset().mockImplementation(async () => mocks.disks)
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
  expect((await authorizeScheduleStep('one', payload().runId)).allowed).toBe(true)
  // The first step freed space and the window closed; later steps still run.
  mocks.disks = [{ mount, size: 100, available: 50 }]
  vi.setSystemTime(new Date('2026-09-13T10:00:00'))
  expect((await authorizeScheduleStep('one', payload().runId)).allowed).toBe(true)
})
it('measures free space on the deepest volume containing the home directory', async () => {
  mocks.entries = [{ ...entry, conditions: { freeBelowPercent: 20 } }]
  mocks.disks = [
    { mount, size: 100, available: 50 },
    { mount: siblingMount, size: 100, available: 10 }
  ]
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).not.toHaveBeenCalled()
  expect(runtimeOf('one')?.reason).toBe('disk')
  mocks.disks = [
    { mount, size: 100, available: 50 },
    { mount: homeMount, size: 100, available: 10 }
  ]
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
})
it('keeps a Run Now request waiting until its conditions pass', async () => {
  // Today's occurrence is consumed, so only the manual request can start a run.
  mocks.entries = [{ ...entry, lastDueAt: new Date('2026-09-13T09:00:00').toISOString() }]
  vi.setSystemTime(new Date('2026-09-13T12:00:00'))
  mocks.battery = true
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect((await runScheduleNow(() => window as any, 'one'))?.reason).toBe('power')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).not.toHaveBeenCalled()
  expect(runtimeOf('one')?.reason).toBe('power')
  mocks.battery = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.claim).toHaveBeenCalledBefore(mocks.send)
  await completeScheduleRun('one', 'success', payload().runId)
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.patch).not.toHaveBeenCalledWith(
    'one',
    expect.objectContaining({ lastRunStatus: 'skipped' })
  )
})
it('retries a dispatched Run Now request whose first authorization is deferred', async () => {
  // Skip policy with today's occurrence consumed: only the manual request can bring it back.
  mocks.entries = [
    { ...entry, missedRun: undefined, lastDueAt: new Date('2026-09-13T09:00:00').toISOString() }
  ]
  vi.setSystemTime(new Date('2026-09-13T12:00:00'))
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect((await runScheduleNow(() => window as any, 'one'))?.running).toBe(true)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  // The renderer was busy with a manual scan; the machine is unplugged by the time it asks.
  mocks.battery = true
  expect((await authorizeScheduleStep('one', payload().runId)).reason).toBe('power')
  await completeScheduleRun('one', 'deferred', payload().runId)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(runtimeOf('one')?.reason).toBe('power')
  mocks.battery = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).runId).not.toBe(payload().runId)
  // Once the run starts its first step the request is satisfied and never replays.
  expect((await authorizeScheduleStep('one', payload(1).runId)).allowed).toBe(true)
  await completeScheduleRun('one', 'deferred', payload(1).runId)
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
})
it('drops a waiting Run Now request when the schedule is edited, disabled or cancelled', async () => {
  const consumed = new Date('2026-09-13T09:00:00').toISOString()
  mocks.entries = [{ ...entry, lastDueAt: consumed }]
  vi.setSystemTime(new Date('2026-09-13T12:00:00'))
  mocks.battery = true
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  await runScheduleNow(() => window as any, 'one')
  mocks.entries = [{ ...mocks.entries[0], tasks: ['registry'] }]
  mocks.battery = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).not.toHaveBeenCalled()
  mocks.battery = true
  await runScheduleNow(() => window as any, 'one')
  mocks.entries[0].enabled = false
  await vi.advanceTimersByTimeAsync(60_000)
  mocks.entries[0].enabled = true
  mocks.battery = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).not.toHaveBeenCalled()
  mocks.battery = true
  await runScheduleNow(() => window as any, 'one')
  expect((await runScheduleNow(() => window as any, 'one'))?.reason).toBeNull()
  mocks.battery = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).not.toHaveBeenCalled()
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
  // Nothing proves the lost renderer's work finished, so the lock is held for the grace period.
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(10 * 60_000)
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
  expect(mocks.send).toHaveBeenCalledTimes(1)
  // The deletion the lost renderer requested settles: positive evidence releases the lock.
  mocks.workDone++
  await vi.advanceTimersByTimeAsync(60_000)
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
it('holds the lock for an orphaned run until its main-process work finishes', async () => {
  mocks.entries.push({ ...entry, id: 'two' })
  mocks.working = true
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  await authorizeScheduleStep('one', payload().runId)
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(mocks.patch).toHaveBeenCalledWith(
    'one',
    expect.objectContaining({ lastRunStatus: 'failed' })
  )
  expect(runtimeOf('one')?.reason).toBe('interrupted')
  // A reloaded renderer cannot resume the orphaned run.
  expect(acknowledgeScheduleRun('one', payload().runId)).toBe(false)
  expect((await authorizeScheduleStep('one', payload().runId)).allowed).toBe(false)
  await vi.advanceTimersByTimeAsync(3 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(runtimeOf('two')?.reason).toBe('busy')
  // A completion while other work is still in flight is not enough.
  mocks.workDone++
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  mocks.working = false
  mocks.fsSize.mockReset().mockImplementation(async () => mocks.disks)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).scheduleId).toBe('two')
})
it('holds an orphaned run for the grace period when no tracked work completes', async () => {
  // The renderer reloads while a deletion it requested is still running, or before it has
  // requested one at all: nothing is in flight, yet nothing proves the work finished.
  mocks.entries.push({ ...entry, id: 'two' })
  mocks.working = false
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  await authorizeScheduleStep('one', payload().runId)
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(runtimeOf('one')?.reason).toBe('interrupted')
  await vi.advanceTimersByTimeAsync(9 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(runtimeOf('two')?.reason).toBe('busy')
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).scheduleId).toBe('two')
})
it('releases an orphaned run early once tracked work completes after the renderer is lost', async () => {
  mocks.entries.push({ ...entry, id: 'two' })
  mocks.working = false
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  await authorizeScheduleStep('one', payload().runId)
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  mocks.workDone++
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).scheduleId).toBe('two')
})
it('keeps an orphaned run locked past the grace period while tracked work is in flight', async () => {
  // A package upgrade or driver install can outlast the grace period; releasing under it would
  // let the next schedule start an overlapping workflow.
  mocks.entries.push({ ...entry, id: 'two' })
  mocks.working = true
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  acknowledgeScheduleRun('one', payload().runId)
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await vi.advanceTimersByTimeAsync(9 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(runtimeOf('two')?.reason).toBe('busy')
  // Once the work settles the grace period has long elapsed, so the lock is released.
  mocks.working = false
  mocks.workDone++
  mocks.fsSize.mockReset().mockImplementation(async () => mocks.disks)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).scheduleId).toBe('two')
})
it('releases an orphaned run after the grace period once nothing is in flight', async () => {
  // Work that was in flight ends without a completion being observed (the generation was read
  // after it settled): the deadline applies as soon as nothing can be observed.
  mocks.entries.push({ ...entry, id: 'two' })
  mocks.working = true
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  acknowledgeScheduleRun('one', payload().runId)
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  mocks.working = false
  await vi.advanceTimersByTimeAsync(4 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(mocks.send).toHaveBeenCalledTimes(2)
  expect(payload(1).scheduleId).toBe('two')
})
it('rolls back an unacknowledged trigger whose renderer goes away', async () => {
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  expect(mocks.patch).toHaveBeenCalledWith('one', { lastDueAt: null })
  expect(mocks.patch).not.toHaveBeenCalledWith(
    'one',
    expect.objectContaining({ lastRunStatus: 'failed' })
  )
})
it('applies the full condition set to the first authorization of a run', async () => {
  mocks.entries = [
    { ...entry, conditions: { freeBelowPercent: 20, windowStart: 9 * 60, windowEnd: 9 * 60 + 30 } }
  ]
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  // The renderer was busy with a manual scan; by the time it asks, the window has closed.
  vi.setSystemTime(new Date('2026-09-13T10:00:00'))
  expect((await authorizeScheduleStep('one', payload().runId)).reason).toBe('window')
  await completeScheduleRun('one', 'deferred', payload().runId)
  expect(mocks.patch).toHaveBeenCalledWith('one', { lastDueAt: null })
})
it('does not claim an occurrence for a window lost during the condition query', async () => {
  mocks.entries = [{ ...entry, conditions: { freeBelowPercent: 20 } }]
  mocks.fsSize.mockImplementation(async () => {
    window.isDestroyed = () => true
    window.webContents.isDestroyed = () => true
    return mocks.disks
  })
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.claim).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(runtimeOf('one')?.reason).toBe('unavailable')
})
it('restores the occurrence when the window is lost while the claim persists', async () => {
  mocks.claim.mockImplementation(async (e, due) => {
    e.lastDueAt = due
    window.isDestroyed = () => true
    window.webContents.isDestroyed = () => true
    return true
  })
  startScheduler(() => window as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.claim).toHaveBeenCalledTimes(1)
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.patch).toHaveBeenCalledWith('one', { lastDueAt: null })
  expect(runtimeOf('one')?.reason).toBe('unavailable')
  // The next check retries against a replacement window.
  const replacement = makeWindow()
  mocks.claim.mockImplementation(async (e, due) => {
    e.lastDueAt = due
    return true
  })
  stopScheduler()
  startScheduler(() => replacement as any)
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.send).toHaveBeenCalledTimes(1)
})
