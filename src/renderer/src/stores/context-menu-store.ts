import { create } from 'zustand'
import type {
  ContextMenuApplyProgress,
  ContextMenuApplyResult,
  ContextMenuEntry,
  ContextMenuScope,
  ContextMenuSource,
  ContextMenuStatus,
} from '@shared/types'

export interface ContextMenuFilters {
  search: string
  scope: ContextMenuScope | 'all'
  source: ContextMenuSource | 'all'
  status: ContextMenuStatus | 'all'
}

interface ContextMenuState {
  entries: ContextMenuEntry[]
  scanning: boolean
  scanned: boolean
  applying: boolean
  applyProgress: ContextMenuApplyProgress | null
  applyResult: ContextMenuApplyResult | null
  showErrors: boolean
  error: string | null
  filters: ContextMenuFilters
  expandedGroups: Set<string>

  setEntries: (entries: ContextMenuEntry[]) => void
  setScanning: (v: boolean) => void
  setScanned: (v: boolean) => void
  setApplying: (v: boolean) => void
  setApplyProgress: (p: ContextMenuApplyProgress | null) => void
  setApplyResult: (r: ContextMenuApplyResult | null) => void
  setShowErrors: (v: boolean) => void
  setError: (e: string | null) => void
  setFilter: <K extends keyof ContextMenuFilters>(key: K, value: ContextMenuFilters[K]) => void
  toggleGroup: (key: string) => void
  toggleEntry: (id: string) => void
  toggleAllVisible: (visibleIds: string[], select: boolean) => void
  applyUpdates: (updates: { entryId: string; status: ContextMenuStatus }[]) => void
  removeEntries: (ids: string[]) => void
  reset: () => void
}

const initialFilters: ContextMenuFilters = { search: '', scope: 'all', source: 'all', status: 'all' }

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  entries: [],
  scanning: false,
  scanned: false,
  applying: false,
  applyProgress: null,
  applyResult: null,
  showErrors: false,
  error: null,
  filters: initialFilters,
  expandedGroups: new Set<string>(),

  setEntries: (entries) => set({ entries }),
  setScanning: (scanning) => set({ scanning }),
  setScanned: (scanned) => set({ scanned }),
  setApplying: (applying) => set({ applying }),
  setApplyProgress: (applyProgress) => set({ applyProgress }),
  setApplyResult: (applyResult) => set({ applyResult }),
  setShowErrors: (showErrors) => set({ showErrors }),
  setError: (error) => set({ error }),
  setFilter: (key, value) =>
    set((s) => ({ filters: { ...s.filters, [key]: value } })),
  toggleGroup: (key) =>
    set((s) => {
      const next = new Set(s.expandedGroups)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { expandedGroups: next }
    }),
  toggleEntry: (id) =>
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, selected: !e.selected } : e)),
    })),
  toggleAllVisible: (visibleIds, select) =>
    set((s) => {
      const ids = new Set(visibleIds)
      return {
        entries: s.entries.map((e) =>
          ids.has(e.id) && !e.protected ? { ...e, selected: select } : e
        ),
      }
    }),
  applyUpdates: (updates) =>
    set((s) => {
      const map = new Map(updates.map((u) => [u.entryId, u.status]))
      return {
        entries: s.entries.map((e) =>
          map.has(e.id) ? { ...e, status: map.get(e.id)!, selected: false } : e
        ),
      }
    }),
  removeEntries: (ids) =>
    set((s) => {
      const drop = new Set(ids)
      return { entries: s.entries.filter((e) => !drop.has(e.id)) }
    }),
  reset: () =>
    set({
      entries: [],
      scanning: false,
      scanned: false,
      applying: false,
      applyProgress: null,
      applyResult: null,
      showErrors: false,
      error: null,
      filters: initialFilters,
      expandedGroups: new Set<string>(),
    }),
}))
