import { create } from 'zustand'
import type {
  WindowsService,
  ServiceScanProgress,
  ServiceApplyResult,
  ServiceSafety,
  ServiceCategory
} from '@shared/types'

interface ServiceState {
  services: WindowsService[]
  scanning: boolean
  applying: boolean
  scanProgress: ServiceScanProgress | null
  applyResult: ServiceApplyResult | null
  error: string | null
  hasScanned: boolean

  // Filters
  searchQuery: string
  safetyFilter: 'all' | ServiceSafety
  categoryFilter: 'all' | ServiceCategory
  statusFilter: 'all' | 'running' | 'stopped' | 'disabled'

  /** Startup type a disabled service is restored to when it is re-enabled. */
  enableStartType: 'Manual' | 'Automatic'

  // Actions
  setServices: (services: WindowsService[]) => void
  setScanning: (scanning: boolean) => void
  setApplying: (applying: boolean) => void
  setScanProgress: (progress: ServiceScanProgress | null) => void
  setApplyResult: (result: ServiceApplyResult | null) => void
  setError: (error: string | null) => void
  setHasScanned: (hasScanned: boolean) => void

  setSearchQuery: (query: string) => void
  setSafetyFilter: (filter: 'all' | ServiceSafety) => void
  setCategoryFilter: (filter: 'all' | ServiceCategory) => void
  setStatusFilter: (filter: 'all' | 'running' | 'stopped' | 'disabled') => void
  setEnableStartType: (startType: 'Manual' | 'Automatic') => void

  toggleService: (name: string) => void
  selectRecommended: () => void
  deselectAll: () => void
  reset: () => void
}

export const useServiceStore = create<ServiceState>((set) => ({
  services: [],
  scanning: false,
  applying: false,
  scanProgress: null,
  applyResult: null,
  error: null,
  hasScanned: false,

  searchQuery: '',
  safetyFilter: 'all',
  categoryFilter: 'all',
  statusFilter: 'all',
  enableStartType: 'Manual',

  setServices: (services) => set({ services }),
  setScanning: (scanning) => set({ scanning }),
  setApplying: (applying) => set({ applying }),
  setScanProgress: (scanProgress) => set({ scanProgress }),
  setApplyResult: (applyResult) => set({ applyResult }),
  setError: (error) => set({ error }),
  setHasScanned: (hasScanned) => set({ hasScanned }),

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSafetyFilter: (safetyFilter) => set({ safetyFilter }),
  setCategoryFilter: (categoryFilter) => set({ categoryFilter }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setEnableStartType: (enableStartType) => set({ enableStartType }),

  // System-critical services can never be selected for disabling, but a disabled
  // one must stay selectable so it can be restored.
  toggleService: (name) =>
    set((s) => ({
      services: s.services.map((svc) =>
        svc.name === name && (svc.safety !== 'unsafe' || svc.startType === 'Disabled')
          ? { ...svc, selected: !svc.selected }
          : svc
      )
    })),

  selectRecommended: () =>
    set((s) => ({
      services: s.services.map((svc) =>
        svc.safety === 'safe' && svc.startType !== 'Disabled'
          ? { ...svc, selected: true }
          : { ...svc, selected: false }
      )
    })),

  deselectAll: () =>
    set((s) => ({
      services: s.services.map((svc) => ({ ...svc, selected: false }))
    })),

  reset: () =>
    set({
      services: [],
      scanning: false,
      applying: false,
      scanProgress: null,
      applyResult: null,
      error: null,
      hasScanned: false,
      searchQuery: '',
      safetyFilter: 'all',
      categoryFilter: 'all',
      statusFilter: 'all',
      enableStartType: 'Manual'
    })
}))
