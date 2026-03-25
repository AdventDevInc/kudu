import { create } from 'zustand'
import type { InstalledProgram, UninstallProgress, UninstallResult, StartupSafetyRating } from '../../../shared/types'

type SortField = 'displayName' | 'estimatedSize' | 'installDate' | 'publisher' | 'safety'
type FilterMode = 'all' | 'unused'

interface UninstallerState {
  programs: InstalledProgram[]
  loading: boolean
  uninstalling: boolean
  progress: UninstallProgress | null
  uninstallResult: UninstallResult | null
  error: string | null
  hasLoaded: boolean
  searchQuery: string
  sortField: SortField
  sortDirection: 'asc' | 'desc'
  filterMode: FilterMode
  selectedIds: Set<string>

  // Safety ratings (cloud-enriched)
  safetyRatings: Record<string, StartupSafetyRating>
  safetyLoading: boolean
  expandedItemId: string | null

  setPrograms: (programs: InstalledProgram[]) => void
  setLoading: (loading: boolean) => void
  setUninstalling: (uninstalling: boolean) => void
  setProgress: (progress: UninstallProgress | null) => void
  setUninstallResult: (result: UninstallResult | null) => void
  setError: (error: string | null) => void
  setHasLoaded: (loaded: boolean) => void
  setSearchQuery: (query: string) => void
  setSortField: (field: SortField) => void
  setSortDirection: (dir: 'asc' | 'desc') => void
  setFilterMode: (mode: FilterMode) => void
  removeProgram: (id: string) => void
  toggleSelected: (id: string) => void
  selectAll: (ids: string[]) => void
  clearSelected: () => void
  setSafetyRatings: (ratings: StartupSafetyRating[]) => void
  setSafetyLoading: (loading: boolean) => void
  setExpandedItemId: (id: string | null) => void
  fetchSafetyRatings: () => Promise<void>
  reset: () => void
}

/** Programs not seen in Prefetch for 90+ days are considered unused */
export const UNUSED_THRESHOLD_DAYS = 90

export const useUninstallerStore = create<UninstallerState>((set) => ({
  programs: [],
  loading: false,
  uninstalling: false,
  progress: null,
  uninstallResult: null,
  error: null,
  hasLoaded: false,
  searchQuery: '',
  sortField: 'displayName',
  sortDirection: 'asc',
  filterMode: 'all',
  selectedIds: new Set<string>(),
  safetyRatings: {},
  safetyLoading: false,
  expandedItemId: null,

  setPrograms: (programs) => set({ programs, selectedIds: new Set<string>() }),
  setLoading: (loading) => set({ loading }),
  setUninstalling: (uninstalling) => set({ uninstalling }),
  setProgress: (progress) => set({ progress }),
  setUninstallResult: (uninstallResult) => set({ uninstallResult }),
  setError: (error) => set({ error }),
  setHasLoaded: (hasLoaded) => set({ hasLoaded }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSortField: (sortField) => set({ sortField }),
  setSortDirection: (sortDirection) => set({ sortDirection }),
  setFilterMode: (filterMode) => set({ filterMode }),
  removeProgram: (id) =>
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.delete(id)
      return { programs: state.programs.filter((p) => p.id !== id), selectedIds }
    }),
  toggleSelected: (id) =>
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      if (selectedIds.has(id)) selectedIds.delete(id)
      else selectedIds.add(id)
      return { selectedIds }
    }),
  selectAll: (ids) => set({ selectedIds: new Set(ids) }),
  clearSelected: () => set({ selectedIds: new Set<string>() }),
  setSafetyRatings: (ratings) => set({
    safetyRatings: Object.fromEntries(ratings.map((r) => [r.name, r])),
  }),
  setSafetyLoading: (safetyLoading) => set({ safetyLoading }),
  setExpandedItemId: (expandedItemId) => set({ expandedItemId }),
  fetchSafetyRatings: async () => {
    set({ safetyLoading: true })
    try {
      const result = await window.kudu.programSafetyFetch()
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
      programs: [],
      loading: false,
      uninstalling: false,
      progress: null,
      uninstallResult: null,
      error: null,
      hasLoaded: false,
      searchQuery: '',
      sortField: 'displayName',
      sortDirection: 'asc',
      filterMode: 'all',
      selectedIds: new Set<string>(),
      safetyRatings: {},
      safetyLoading: false,
      expandedItemId: null,
    }),
}))

// Listen for cloud-pushed safety rating updates (HMR-safe via guard flag)
let _programSafetyListenerRegistered = false
if (typeof window !== 'undefined' && window.kudu?.onProgramSafetyUpdated && !_programSafetyListenerRegistered) {
  _programSafetyListenerRegistered = true
  window.kudu.onProgramSafetyUpdated((result) => {
    const ratings = Array.isArray(result?.ratings) ? result.ratings : []
    useUninstallerStore.setState({
      safetyRatings: Object.fromEntries(ratings.map((r) => [r.name, r])),
      safetyLoading: false,
    })
  })
}
