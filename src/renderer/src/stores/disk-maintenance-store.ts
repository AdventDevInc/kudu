import { create } from 'zustand'
import type { TrimDriveInfo, TrimRunResult, TrimProgress } from '@shared/types'

export type RunState = 'idle' | 'running' | 'done' | 'failed'
export type DriveFilter = 'all' | 'ssd' | 'needs-trim'

interface DiskMaintenanceState {
  drives: TrimDriveInfo[]
  loading: boolean
  error: string | null
  selected: Set<string>
  filter: DriveFilter
  runStates: Record<string, RunState>
  results: Record<string, TrimRunResult>
  progress: Record<string, TrimProgress>
  batchRunning: boolean

  setDrives: (drives: TrimDriveInfo[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setFilter: (filter: DriveFilter) => void
  toggleSelect: (id: string) => void
  setSelected: (ids: string[]) => void
  clearSelection: () => void
  setRunState: (id: string, state: RunState) => void
  setResult: (id: string, result: TrimRunResult) => void
  setProgress: (data: TrimProgress) => void
  clearProgress: () => void
  setBatchRunning: (running: boolean) => void
  reset: () => void
}

export const useDiskMaintenanceStore = create<DiskMaintenanceState>((set) => ({
  drives: [],
  loading: false,
  error: null,
  selected: new Set(),
  filter: 'all',
  runStates: {},
  results: {},
  progress: {},
  batchRunning: false,

  setDrives: (drives) => set({ drives }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setFilter: (filter) => set({ filter }),

  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selected: next }
    }),
  setSelected: (ids) => set({ selected: new Set(ids) }),
  clearSelection: () => set({ selected: new Set() }),

  setRunState: (id, state) =>
    set((s) => ({ runStates: { ...s.runStates, [id]: state } })),
  setResult: (id, result) =>
    set((s) => ({ results: { ...s.results, [id]: result } })),
  setProgress: (data) =>
    set((s) => ({ progress: { ...s.progress, [data.driveId]: data } })),
  clearProgress: () => set({ progress: {} }),
  setBatchRunning: (batchRunning) => set({ batchRunning }),

  reset: () =>
    set({
      drives: [],
      loading: false,
      error: null,
      selected: new Set(),
      filter: 'all',
      runStates: {},
      results: {},
      progress: {},
      batchRunning: false,
    }),
}))

export function isSelectable(drive: TrimDriveInfo): boolean {
  if (drive.mediaType === 'HDD') return false
  if (drive.trimSupport === 'macos-managed') return false
  if (drive.trimSupport === 'unsupported' || drive.trimSupport === 'disabled') return false
  if (drive.isRemovable) return false
  return true
}

export function applyFilter(drives: TrimDriveInfo[], filter: DriveFilter): TrimDriveInfo[] {
  if (filter === 'ssd') {
    return drives.filter((d) => d.mediaType === 'SSD' || d.mediaType === 'NVMe')
  }
  if (filter === 'needs-trim') {
    return drives.filter((d) => d.status === 'recommended')
  }
  return drives
}
