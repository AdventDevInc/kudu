import { create } from 'zustand'
import type {
  PackageManagerStatus,
  UpdatableApp,
  UpToDateApp,
  UpdateProgress,
  UpdateResult,
} from '../../../shared/types'

type SortField = 'name' | 'severity' | 'source'
type SeverityFilter = 'all' | 'major' | 'minor' | 'patch'

/**
 * Stable composite identity for a package. With multi-manager aggregation the
 * same `id` can appear under two managers (e.g. choco + scoop "7zip"), so
 * selection and removal are keyed by `source + id`, not `id` alone.
 */
export function appKey(app: { id: string; source: string }): string {
  return `${app.source}␟${app.id}`
}

/**
 * An app is ignored if its composite key is in the set, or — for entries
 * persisted before ignores were keyed by source — its bare id is.
 */
function isAppIgnored(app: { id: string; source: string }, ignoredIds: Set<string>): boolean {
  return ignoredIds.has(appKey(app)) || ignoredIds.has(app.id)
}

interface SoftwareUpdaterState {
  apps: UpdatableApp[]
  upToDate: UpToDateApp[]
  ignoredApps: UpdatableApp[]
  ignoredIds: Set<string>
  loading: boolean
  updating: boolean
  progress: UpdateProgress | null
  updateResult: UpdateResult | null
  error: string | null
  hasChecked: boolean
  packageManagerAvailable: boolean
  packageManagerName: string | null
  managers: PackageManagerStatus[]
  searchQuery: string
  sortField: SortField
  sortDirection: 'asc' | 'desc'
  severityFilter: SeverityFilter

  setApps: (apps: UpdatableApp[]) => void
  setUpToDate: (apps: UpToDateApp[]) => void
  setLoading: (loading: boolean) => void
  setUpdating: (updating: boolean) => void
  setProgress: (progress: UpdateProgress | null) => void
  setUpdateResult: (result: UpdateResult | null) => void
  setError: (error: string | null) => void
  setHasChecked: (checked: boolean) => void
  setPackageManagerAvailable: (available: boolean) => void
  setPackageManagerName: (name: string | null) => void
  setManagers: (managers: PackageManagerStatus[]) => void
  setSearchQuery: (query: string) => void
  setSortField: (field: SortField) => void
  setSortDirection: (dir: 'asc' | 'desc') => void
  setSeverityFilter: (filter: SeverityFilter) => void
  /** Toggle selection by composite key (see {@link appKey}). */
  toggleAppSelected: (key: string) => void
  selectAll: () => void
  deselectAll: () => void
  /** Remove apps by composite key (see {@link appKey}). */
  removeApps: (keys: string[]) => void
  /** Load the persisted ignore list from settings (call once at init) */
  loadIgnoredIds: (ids: string[]) => void
  /** Move an app from the updates list to the ignored list and persist */
  ignoreApp: (app: { id: string; source: string }) => void
  /** Move an app from the ignored list back to the updates list and persist */
  unignoreApp: (app: { id: string; source: string }) => void
  reset: () => void
}

const severityOrder = { major: 0, minor: 1, patch: 2, unknown: 3 }

function persistIgnoredIds(ids: Set<string>): void {
  window.kudu?.settingsSet?.({ ignoredSoftwareUpdates: [...ids] }).catch(() => {})
}

export const useUpdaterStore = create<SoftwareUpdaterState>((set, get) => ({
  apps: [],
  upToDate: [],
  ignoredApps: [],
  ignoredIds: new Set<string>(),
  loading: false,
  updating: false,
  progress: null,
  updateResult: null,
  error: null,
  hasChecked: false,
  packageManagerAvailable: true,
  packageManagerName: null,
  managers: [],
  searchQuery: '',
  sortField: 'name',
  sortDirection: 'asc',
  severityFilter: 'all',

  setApps: (allApps) => {
    const { ignoredIds } = get()
    set({
      apps: allApps.filter((a) => !isAppIgnored(a, ignoredIds)),
      ignoredApps: allApps.filter((a) => isAppIgnored(a, ignoredIds)),
    })
  },
  setUpToDate: (upToDate) => set({ upToDate }),
  setLoading: (loading) => set({ loading }),
  setUpdating: (updating) => set({ updating }),
  setProgress: (progress) => set({ progress }),
  setUpdateResult: (updateResult) => set({ updateResult }),
  setError: (error) => set({ error }),
  setHasChecked: (hasChecked) => set({ hasChecked }),
  setPackageManagerAvailable: (packageManagerAvailable) => set({ packageManagerAvailable }),
  setPackageManagerName: (packageManagerName) => set({ packageManagerName }),
  setManagers: (managers) => set({ managers }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSortField: (sortField) =>
    set((state) => ({
      sortField,
      sortDirection: sortField === 'severity' ? 'asc' : state.sortDirection,
    })),
  setSortDirection: (sortDirection) => set({ sortDirection }),
  setSeverityFilter: (severityFilter) => set({ severityFilter }),
  toggleAppSelected: (key) =>
    set((state) => ({
      apps: state.apps.map((a) => (appKey(a) === key ? { ...a, selected: !a.selected } : a)),
    })),
  selectAll: () =>
    set((state) => ({
      apps: state.apps.map((a) => ({ ...a, selected: true })),
    })),
  deselectAll: () =>
    set((state) => ({
      apps: state.apps.map((a) => ({ ...a, selected: false })),
    })),
  removeApps: (keys) =>
    set((state) => ({
      apps: state.apps.filter((a) => !keys.includes(appKey(a))),
    })),
  loadIgnoredIds: (ids) => {
    const newIds = new Set(ids)
    set((state) => {
      // Recompute from the full set of known apps (both lists combined)
      const allApps = [...state.apps, ...state.ignoredApps]
      return {
        ignoredIds: newIds,
        apps: allApps.filter((a) => !isAppIgnored(a, newIds)),
        ignoredApps: allApps.filter((a) => isAppIgnored(a, newIds)),
      }
    })
  },
  ignoreApp: (app) =>
    set((state) => {
      const key = appKey(app)
      const found = state.apps.find((a) => appKey(a) === key)
      const newIds = new Set(state.ignoredIds)
      newIds.add(key)
      persistIgnoredIds(newIds)
      return {
        ignoredIds: newIds,
        apps: state.apps.filter((a) => appKey(a) !== key),
        ignoredApps: found ? [...state.ignoredApps, found] : state.ignoredApps,
      }
    }),
  unignoreApp: (app) =>
    set((state) => {
      const key = appKey(app)
      const found = state.ignoredApps.find((a) => appKey(a) === key)
      const newIds = new Set(state.ignoredIds)
      newIds.delete(key)
      newIds.delete(app.id) // also clear any legacy bare-id entry
      persistIgnoredIds(newIds)
      return {
        ignoredIds: newIds,
        ignoredApps: state.ignoredApps.filter((a) => appKey(a) !== key),
        apps: found ? [...state.apps, found] : state.apps,
      }
    }),
  reset: () =>
    set({
      apps: [],
      upToDate: [],
      ignoredApps: [],
      loading: false,
      updating: false,
      progress: null,
      updateResult: null,
      error: null,
      hasChecked: false,
      packageManagerAvailable: true,
      packageManagerName: null,
      managers: [],
      searchQuery: '',
      sortField: 'name',
      sortDirection: 'asc',
      severityFilter: 'all',
    }),
}))

export { severityOrder }
