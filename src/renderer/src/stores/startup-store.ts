import { create } from 'zustand'
import type { StartupItem, StartupBootTrace, StartupSafetyRating } from '@shared/types'

interface StartupState {
  items: StartupItem[]
  loading: boolean
  sortBy: 'name' | 'impact' | 'safety'
  filterBy: 'all' | 'active' | 'disabled'
  error: string | null
  bootTrace: StartupBootTrace | null
  traceLoading: boolean
  deleteTarget: StartupItem | null

  // Safety ratings (cloud-enriched)
  safetyRatings: Record<string, StartupSafetyRating>
  safetyLoading: boolean
  expandedItemId: string | null

  setItems: (items: StartupItem[]) => void
  updateItem: (id: string, updates: Partial<StartupItem>) => void
  removeItem: (id: string) => void
  setLoading: (loading: boolean) => void
  setSortBy: (sortBy: 'name' | 'impact' | 'safety') => void
  setFilterBy: (filterBy: 'all' | 'active' | 'disabled') => void
  setError: (error: string | null) => void
  setBootTrace: (trace: StartupBootTrace | null) => void
  setTraceLoading: (loading: boolean) => void
  setDeleteTarget: (target: StartupItem | null) => void
  setSafetyRatings: (ratings: StartupSafetyRating[]) => void
  setSafetyLoading: (loading: boolean) => void
  setExpandedItemId: (id: string | null) => void
  fetchSafetyRatings: () => Promise<void>
  reset: () => void
}

export const useStartupStore = create<StartupState>((set) => ({
  items: [],
  loading: false,
  sortBy: 'impact',
  filterBy: 'all',
  error: null,
  bootTrace: null,
  traceLoading: false,
  deleteTarget: null,
  safetyRatings: {},
  safetyLoading: false,
  expandedItemId: null,

  setItems: (items) => set({ items }),
  updateItem: (id, updates) =>
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? { ...i, ...updates } : i))
    })),
  removeItem: (id) =>
    set((s) => ({
      items: s.items.filter((i) => i.id !== id)
    })),
  setLoading: (loading) => set({ loading }),
  setSortBy: (sortBy) => set({ sortBy }),
  setFilterBy: (filterBy) => set({ filterBy }),
  setError: (error) => set({ error }),
  setBootTrace: (bootTrace) => set({ bootTrace }),
  setTraceLoading: (traceLoading) => set({ traceLoading }),
  setDeleteTarget: (deleteTarget) => set({ deleteTarget }),
  setSafetyRatings: (ratings) => set({
    safetyRatings: Object.fromEntries(ratings.map((r) => [r.name, r]))
  }),
  setSafetyLoading: (safetyLoading) => set({ safetyLoading }),
  setExpandedItemId: (expandedItemId) => set({ expandedItemId }),
  fetchSafetyRatings: async () => {
    set({ safetyLoading: true })
    try {
      const result = await window.kudu.startupSafetyFetch()
      const ratings = Array.isArray(result?.ratings) ? result.ratings : []
      set({
        safetyRatings: Object.fromEntries(ratings.map((r) => [r.name, r])),
        safetyLoading: false,
      })
    } catch {
      set({ safetyLoading: false })
    }
  },
  reset: () =>
    set({
      items: [],
      loading: false,
      error: null,
      bootTrace: null,
      traceLoading: false,
      deleteTarget: null,
      safetyRatings: {},
      safetyLoading: false,
      expandedItemId: null,
    })
}))

// Listen for cloud-pushed safety rating updates (HMR-safe via guard flag)
let _safetyListenerRegistered = false
if (typeof window !== 'undefined' && window.kudu?.onStartupSafetyUpdated && !_safetyListenerRegistered) {
  _safetyListenerRegistered = true
  window.kudu.onStartupSafetyUpdated((result) => {
    const ratings = Array.isArray(result?.ratings) ? result.ratings : []
    useStartupStore.setState({
      safetyRatings: Object.fromEntries(ratings.map((r) => [r.name, r])),
      safetyLoading: false,
    })
  })
}
