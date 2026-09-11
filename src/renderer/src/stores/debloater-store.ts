import { create } from 'zustand'
import type { BloatwareApp } from '@shared/types'

type FilterType = 'all' | BloatwareApp['category']

interface DebloaterState {
  apps: BloatwareApp[]
  scanning: boolean
  filter: FilterType
  removing: boolean
  removeProgress: { current: number; total: number; currentApp: string; status: string } | null
  removeResult: { removed: number; failed: number } | null
  error: string | null
  hasScanned: boolean

  setApps: (apps: BloatwareApp[]) => void
  setScanning: (scanning: boolean) => void
  setFilter: (filter: FilterType) => void
  setRemoving: (removing: boolean) => void
  setRemoveProgress: (
    progress: { current: number; total: number; currentApp: string; status: string } | null
  ) => void
  setRemoveResult: (result: { removed: number; failed: number } | null) => void
  setError: (error: string | null) => void
  setHasScanned: (hasScanned: boolean) => void
  toggleApp: (id: string) => void
  selectAll: () => void
  deselectAll: () => void
  selectFiltered: (filter: FilterType, select: boolean) => void
  reset: () => void
}

export const useDebloaterStore = create<DebloaterState>((set) => ({
  apps: [],
  scanning: false,
  filter: 'all',
  removing: false,
  removeProgress: null,
  removeResult: null,
  error: null,
  hasScanned: false,

  setApps: (apps) => set({ apps }),
  setScanning: (scanning) => set({ scanning }),
  setFilter: (filter) => set({ filter }),
  setRemoving: (removing) => set({ removing }),
  setRemoveProgress: (removeProgress) => set({ removeProgress }),
  setRemoveResult: (removeResult) => set({ removeResult }),
  setError: (error) => set({ error }),
  setHasScanned: (hasScanned) => set({ hasScanned }),
  toggleApp: (id) =>
    set((s) => ({
      apps: s.apps.map((a) => (a.id === id ? { ...a, selected: !a.selected } : a))
    })),
  selectAll: () =>
    set((s) => ({
      apps: s.apps.map((a) => ({ ...a, selected: true }))
    })),
  deselectAll: () =>
    set((s) => ({
      apps: s.apps.map((a) => ({ ...a, selected: false }))
    })),
  selectFiltered: (filter, select) =>
    set((s) => ({
      apps: s.apps.map((a) => {
        const inFilter = filter === 'all' || a.category === filter
        return inFilter ? { ...a, selected: select } : a
      })
    })),
  reset: () =>
    set({
      apps: [],
      scanning: false,
      filter: 'all',
      removing: false,
      removeProgress: null,
      removeResult: null,
      error: null,
      hasScanned: false
    })
}))
