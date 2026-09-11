import { describe, it, expect, beforeEach } from 'vitest'
import { usePerfStore } from './perf-store'
import type { PerfSnapshot } from '@shared/types'

function makeSnapshot(timestamp: number): PerfSnapshot {
  return {
    timestamp,
    cpu: { overall: 50, perCore: [50] },
    memory: { usedBytes: 4e9, totalBytes: 8e9, cachedBytes: 1e9, percent: 50 },
    disk: { readBytesPerSec: 1e6, writeBytesPerSec: 5e5 },
    network: { rxBytesPerSec: 1e4, txBytesPerSec: 5e3 },
    uptime: 3600
  }
}

describe('perf-store', () => {
  beforeEach(() => {
    usePerfStore.getState().reset()
  })

  it('starts with empty state', () => {
    const state = usePerfStore.getState()
    expect(state.history).toEqual([])
    expect(state.currentSnapshot).toBeNull()
    expect(state.isMonitoring).toBe(false)
  })

  it('pushSnapshot sets currentSnapshot immediately', () => {
    const snap = makeSnapshot(1)
    usePerfStore.getState().pushSnapshot(snap)
    const state = usePerfStore.getState()
    expect(state.currentSnapshot).toEqual(snap)
    // Ring buffer should have 1 entry
    expect(state._ringSize).toBe(1)
  })

  it('pushSnapshot flushes history to React after throttle window', () => {
    // First push triggers flush (lastHistoryFlush starts at 0)
    usePerfStore.getState().pushSnapshot(makeSnapshot(1))
    expect(usePerfStore.getState().history.length).toBeGreaterThanOrEqual(1)
  })

  it('pushSnapshot caps ring buffer at MAX_HISTORY (900)', () => {
    for (let i = 0; i < 910; i++) {
      usePerfStore.getState().pushSnapshot(makeSnapshot(i))
    }
    const state = usePerfStore.getState()
    expect(state._ringSize).toBe(900)
    // Latest snapshot should always be current
    expect(state.currentSnapshot!.timestamp).toBe(909)
  })

  it('setProcessSort toggles direction on same column', () => {
    expect(usePerfStore.getState().processSortDir).toBe('desc')
    usePerfStore.getState().setProcessSort('cpuPercent')
    expect(usePerfStore.getState().processSortDir).toBe('asc')
    usePerfStore.getState().setProcessSort('cpuPercent')
    expect(usePerfStore.getState().processSortDir).toBe('desc')
  })

  it('setProcessSort resets to desc on new column', () => {
    usePerfStore.getState().setProcessSort('cpuPercent') // asc
    usePerfStore.getState().setProcessSort('memBytes') // new column → desc
    const state = usePerfStore.getState()
    expect(state.processSortColumn).toBe('memBytes')
    expect(state.processSortDir).toBe('desc')
  })

  it('setTimeRange updates time range', () => {
    usePerfStore.getState().setTimeRange('15m')
    expect(usePerfStore.getState().timeRange).toBe('15m')
  })

  it('setProcessFilter updates filter', () => {
    usePerfStore.getState().setProcessFilter('chrome')
    expect(usePerfStore.getState().processFilter).toBe('chrome')
  })

  it('reset preserves systemInfo but clears monitoring data', () => {
    usePerfStore.getState().setSystemInfo({
      cpuModel: 'i7',
      cpuCores: 8,
      cpuThreads: 16,
      totalMemBytes: 16e9,
      osVersion: 'Win11',
      hostname: 'TEST'
    })
    usePerfStore.getState().pushSnapshot(makeSnapshot(1))
    usePerfStore.getState().setMonitoring(true)
    usePerfStore.getState().reset()
    const state = usePerfStore.getState()
    expect(state.systemInfo).not.toBeNull() // Preserved
    expect(state.history).toEqual([])
    expect(state.isMonitoring).toBe(false)
  })
})
