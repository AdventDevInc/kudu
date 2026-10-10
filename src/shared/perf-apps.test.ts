import { describe, expect, it } from 'vitest'
import type { PerfProcess } from './types'
import {
  appKey,
  groupApps,
  memoryChange,
  verifiedParent,
  APP_HISTORY_MAX_SAMPLES
} from './perf-apps'

const proc = (overrides: Partial<PerfProcess> = {}): PerfProcess => ({
  pid: 10,
  name: 'browser.exe',
  path: 'C:\\Apps\\browser.exe',
  user: 'alice',
  started: '2026-01-01T10:00:00Z',
  cpuPercent: 2,
  memBytes: 1024,
  memPercent: 1,
  ...overrides
})

describe('app memory grouping and trends', () => {
  it('totals all processes, even well beyond the old top-100 cutoff', () => {
    const list = Array.from({ length: 250 }, (_, i) => proc({ pid: i + 10 }))
    const [app] = groupApps(list, 0)
    expect(app.processes).toHaveLength(250)
    expect(app.memBytes).toBe(250 * 1024)
    expect(app.cpuPercent).toBe(500)
  })
  it('keeps executable paths and users separate, with platform-aware casing', () => {
    expect(appKey('App', '/Apps', 'a', false)).not.toBe(appKey('app', '/Apps', 'a', false))
    expect(appKey('App.exe', 'C:\\APPS', 'A', true)).toBe(appKey('app.EXE', 'c:\\apps', 'a', true))
    const apps = groupApps(
      [proc(), proc({ path: 'D:\\Apps\\browser.exe' }), proc({ user: 'bob' }), proc({ path: '' })],
      0
    )
    expect(apps).toHaveLength(4)
    expect(apps[3].estimated).toBe(true)
    expect(groupApps([proc({ user: '' })], 0)[0].estimated).toBe(true)
  })
  it('keeps app totals across child churn, without claiming a leak', () => {
    let apps = groupApps([proc()], 0)
    apps = groupApps([proc({ memBytes: 2048 }), proc({ pid: 11 })], 10_000, apps)
    apps = groupApps([proc({ memBytes: 3072 })], 30_000, apps)
    expect(memoryChange(apps[0], 60_000)).toEqual({ bytes: 2048, seconds: 30 })
  })
  it('does not show changes until at least 30 seconds of actual observations', () => {
    let apps = groupApps([proc()], 0)
    apps = groupApps([proc({ memBytes: 2048 })], 10_000, apps)
    expect(memoryChange(apps[0], 60_000)).toBeNull()
  })
  it('resets for reused PIDs, app disappearance, missing identities, gaps and time reversal', () => {
    const initial = groupApps([proc()], 10_000)
    for (const [list, timestamp] of [
      [[proc({ started: '2026-01-01T11:00:00Z' })], 20_000],
      [[proc({ started: '' })], 20_000],
      [[proc()], 40_001],
      [[proc()], 5_000]
    ] as [PerfProcess[], number][]) {
      expect(groupApps(list, timestamp, initial)[0].history).toHaveLength(1)
    }
    expect(groupApps([proc()], 20_000, groupApps([], 15_000, initial))[0].history).toHaveLength(1)
  })
  it('bounds both history age and sample count and uses the selected time window', () => {
    let apps = groupApps([proc()], 0)
    for (let i = 1; i <= 200; i++)
      apps = groupApps([proc({ memBytes: i * 1024 })], i * 10_000, apps)
    expect(apps[0].history).toHaveLength(APP_HISTORY_MAX_SAMPLES)
    expect(memoryChange(apps[0], 60_000)?.seconds).toBe(60)
    expect(memoryChange(apps[0], 900_000)?.seconds).toBe(900)
    for (let i = 1; i <= 200; i++) apps = groupApps([proc()], 2_000_000 + i, apps)
    expect(apps[0].history).toHaveLength(APP_HISTORY_MAX_SAMPLES)
  })
  it('never invents parentage from a recycled, ambiguous or missing parent PID', () => {
    const child = proc({ pid: 20, parentPid: 10, started: '2026-01-01T10:01:00Z' })
    expect(verifiedParent(child, [proc(), child])?.pid).toBe(10)
    expect(verifiedParent(child, [proc({ started: '2026-01-01T10:02:00Z' })])).toBeUndefined()
    expect(verifiedParent(child, [proc({ started: child.started })])).toBeUndefined()
    expect(verifiedParent(child, [proc({ started: '' })])).toBeUndefined()
    expect(verifiedParent(proc({ parentPid: 10 }), [proc()])).toBeUndefined()
  })
})
