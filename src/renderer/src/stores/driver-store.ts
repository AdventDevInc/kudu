import { create } from 'zustand'
import type {
  DriverPackage,
  DriverScanProgress,
  DriverCleanResult,
  DriverUpdate,
  DriverUpdateProgress,
  DriverUpdateInstallResult
} from '@shared/types'

interface DriverState {
  // Stale packages
  packages: DriverPackage[]
  scanning: boolean
  scanProgress: DriverScanProgress | null
  cleaning: boolean
  cleanResult: DriverCleanResult | null
  error: string | null
  totalStaleSize: number

  // Updates
  updates: DriverUpdate[]
  updateScanning: boolean
  updateProgress: DriverUpdateProgress | null
  installing: boolean
  installResult: DriverUpdateInstallResult | null
  updateError: string | null
  updatesDisabled: boolean

  // Combined
  applying: boolean
  hasScanned: boolean

  // Actions
  setPackages: (packages: DriverPackage[]) => void
  setScanning: (scanning: boolean) => void
  setScanProgress: (progress: DriverScanProgress | null) => void
  setCleaning: (cleaning: boolean) => void
  setCleanResult: (result: DriverCleanResult | null) => void
  setError: (error: string | null) => void
  setTotalStaleSize: (size: number) => void
  togglePackage: (id: string) => void
  selectAllStale: () => void
  deselectAllStale: () => void

  setUpdates: (updates: DriverUpdate[]) => void
  setUpdateScanning: (scanning: boolean) => void
  setUpdateProgress: (progress: DriverUpdateProgress | null) => void
  setInstalling: (installing: boolean) => void
  setInstallResult: (result: DriverUpdateInstallResult | null) => void
  setUpdateError: (error: string | null) => void
  setUpdatesDisabled: (disabled: boolean) => void
  toggleUpdate: (id: string) => void
  selectAllUpdates: () => void
  deselectAllUpdates: () => void

  setApplying: (applying: boolean) => void
  setHasScanned: (hasScanned: boolean) => void
  reset: () => void
}

export const useDriverStore = create<DriverState>((set) => ({
  packages: [],
  scanning: false,
  scanProgress: null,
  cleaning: false,
  cleanResult: null,
  error: null,
  totalStaleSize: 0,
  updates: [],
  updateScanning: false,
  updateProgress: null,
  installing: false,
  installResult: null,
  updateError: null,
  updatesDisabled: false,
  applying: false,
  hasScanned: false,

  setPackages: (packages) => set({ packages }),
  setScanning: (scanning) => set({ scanning }),
  setScanProgress: (scanProgress) => set({ scanProgress }),
  setCleaning: (cleaning) => set({ cleaning }),
  setCleanResult: (cleanResult) => set({ cleanResult }),
  setError: (error) => set({ error }),
  setTotalStaleSize: (totalStaleSize) => set({ totalStaleSize }),
  togglePackage: (id) =>
    set((s) => ({
      packages: s.packages.map((p) =>
        p.id === id && !p.isCurrent ? { ...p, selected: !p.selected } : p
      )
    })),
  selectAllStale: () =>
    set((s) => ({
      packages: s.packages.map((p) => (!p.isCurrent ? { ...p, selected: true } : p))
    })),
  deselectAllStale: () =>
    set((s) => ({
      packages: s.packages.map((p) => (!p.isCurrent ? { ...p, selected: false } : p))
    })),

  setUpdates: (updates) => set({ updates }),
  setUpdateScanning: (updateScanning) => set({ updateScanning }),
  setUpdateProgress: (updateProgress) => set({ updateProgress }),
  setInstalling: (installing) => set({ installing }),
  setInstallResult: (installResult) => set({ installResult }),
  setUpdateError: (updateError) => set({ updateError }),
  setUpdatesDisabled: (updatesDisabled) => set({ updatesDisabled }),
  toggleUpdate: (id) =>
    set((s) => ({
      updates: s.updates.map((u) => (u.id === id ? { ...u, selected: !u.selected } : u))
    })),
  selectAllUpdates: () =>
    set((s) => ({
      updates: s.updates.map((u) => ({ ...u, selected: true }))
    })),
  deselectAllUpdates: () =>
    set((s) => ({
      updates: s.updates.map((u) => ({ ...u, selected: false }))
    })),

  setApplying: (applying) => set({ applying }),
  setHasScanned: (hasScanned) => set({ hasScanned }),
  reset: () =>
    set({
      packages: [],
      scanning: false,
      scanProgress: null,
      cleaning: false,
      cleanResult: null,
      error: null,
      totalStaleSize: 0,
      updates: [],
      updateScanning: false,
      updateProgress: null,
      installing: false,
      installResult: null,
      updateError: null,
      updatesDisabled: false,
      applying: false,
      hasScanned: false
    })
}))
