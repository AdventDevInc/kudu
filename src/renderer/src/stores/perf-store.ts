import { create } from 'zustand'
import type {
  PerfSystemInfo,
  PerfSnapshot,
  PerfProcess,
  PerfProcessList,
  PerfWindowsMemory,
  DiskSmartInfo
} from '@shared/types'
import { groupApps, type PerfApp } from '@shared/perf-apps'

const MAX_HISTORY = 900 // 15 minutes at 1s intervals
const CHART_THROTTLE_MS = 2000 // Only update chart-facing history every 2s

interface PerfState {
  systemInfo: PerfSystemInfo | null
  currentSnapshot: PerfSnapshot | null
  /** Ring buffer backing store — mutated in place to avoid GC pressure */
  _ringBuffer: PerfSnapshot[]
  _ringWriteIndex: number
  _ringSize: number
  /**
   * Snapshot of the ring buffer exposed to React — only updated every CHART_THROTTLE_MS
   * to avoid re-rendering charts on every 1s tick.
   */
  history: PerfSnapshot[]
  _lastHistoryFlush: number
  processList: PerfProcess[]
  processCount: number
  apps: PerfApp[]
  _appTrendInterrupted: boolean
  processTimestamp: number | null
  processError: boolean
  windowsMemory: PerfWindowsMemory | null | undefined
  isMonitoring: boolean
  timeRange: '60s' | '5m' | '15m'
  processFilter: string
  processSortColumn: 'cpuPercent' | 'memBytes' | 'name' | 'pid'
  processSortDir: 'asc' | 'desc'
  diskHealth: DiskSmartInfo[]

  setSystemInfo: (info: PerfSystemInfo) => void
  pushSnapshot: (snap: PerfSnapshot) => void
  setProcessList: (data: PerfProcessList) => void
  setMonitoring: (on: boolean) => void
  setTimeRange: (range: '60s' | '5m' | '15m') => void
  setProcessFilter: (filter: string) => void
  setProcessSort: (column: PerfState['processSortColumn']) => void
  setDiskHealth: (disks: DiskSmartInfo[]) => void
  reset: () => void
}

function ringToArray(buf: PerfSnapshot[], writeIdx: number, size: number): PerfSnapshot[] {
  if (size === 0) return []
  if (size <= buf.length) {
    // Buffer not yet wrapped — just slice
    const start = writeIdx - size
    if (start >= 0) return buf.slice(start, writeIdx)
    // Wrapped — concat tail + head
    return buf.slice(buf.length + start).concat(buf.slice(0, writeIdx))
  }
  return buf.slice(0, size)
}

export const usePerfStore = create<PerfState>((set, get) => ({
  systemInfo: null,
  currentSnapshot: null,
  _ringBuffer: new Array<PerfSnapshot>(MAX_HISTORY),
  _ringWriteIndex: 0,
  _ringSize: 0,
  history: [],
  _lastHistoryFlush: 0,
  processList: [],
  processCount: 0,
  apps: [],
  _appTrendInterrupted: true,
  processTimestamp: null,
  processError: false,
  windowsMemory: undefined,
  isMonitoring: false,
  timeRange: '60s',
  processFilter: '',
  processSortColumn: 'cpuPercent',
  processSortDir: 'desc',
  diskHealth: [],

  setSystemInfo: (info) => set({ systemInfo: info }),

  pushSnapshot: (snap) => {
    const state = get()
    const buf = state._ringBuffer
    const idx = state._ringWriteIndex
    buf[idx] = snap
    const nextIdx = (idx + 1) % MAX_HISTORY
    const nextSize = Math.min(state._ringSize + 1, MAX_HISTORY)

    const now = Date.now()
    const shouldFlush = now - state._lastHistoryFlush >= CHART_THROTTLE_MS

    if (shouldFlush) {
      set({
        currentSnapshot: snap,
        _ringWriteIndex: nextIdx,
        _ringSize: nextSize,
        history: ringToArray(buf, nextIdx, nextSize),
        _lastHistoryFlush: now
      })
    } else {
      set({
        currentSnapshot: snap,
        _ringWriteIndex: nextIdx,
        _ringSize: nextSize
      })
    }
  },

  setProcessList: (data) => {
    if (data.error) {
      set({ processError: true, windowsMemory: null })
      return
    }
    set({
      processList: data.processes,
      processCount: data.totalCount,
      apps: groupApps(data.processes, data.timestamp, get()._appTrendInterrupted ? [] : get().apps),
      _appTrendInterrupted: false,
      processTimestamp: data.timestamp,
      processError: false,
      windowsMemory: data.windowsMemory
    })
  },

  setMonitoring: (on) => set({ isMonitoring: on, ...(!on ? { _appTrendInterrupted: true } : {}) }),

  setTimeRange: (range) => set({ timeRange: range }),

  setProcessFilter: (filter) => set({ processFilter: filter }),

  setDiskHealth: (disks) => set({ diskHealth: disks }),

  setProcessSort: (column) => {
    const { processSortColumn, processSortDir } = get()
    if (processSortColumn === column) {
      set({ processSortDir: processSortDir === 'asc' ? 'desc' : 'asc' })
    } else {
      set({ processSortColumn: column, processSortDir: 'desc' })
    }
  },

  reset: () =>
    set({
      currentSnapshot: null,
      _ringBuffer: new Array<PerfSnapshot>(MAX_HISTORY),
      _ringWriteIndex: 0,
      _ringSize: 0,
      history: [],
      _lastHistoryFlush: 0,
      processList: [],
      processCount: 0,
      apps: [],
      _appTrendInterrupted: true,
      processTimestamp: null,
      processError: false,
      windowsMemory: undefined,
      isMonitoring: false,
      processFilter: '',
      diskHealth: []
    })
}))
