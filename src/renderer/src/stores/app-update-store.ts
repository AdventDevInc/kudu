import { create } from 'zustand'
import type { UpdateStatus } from '@shared/types'

interface AppUpdateStore {
  status: UpdateStatus
  setStatus: (status: UpdateStatus) => void
  init: () => () => void
}

export const useAppUpdateStore = create<AppUpdateStore>((set) => ({
  status: { state: 'idle' },
  setStatus: (status) => set({ status }),
  init: () => {
    // Fetch current status
    window.kudu
      ?.updaterGetStatus?.()
      .then((s) => set({ status: s }))
      .catch(() => {})
    // Listen for live updates
    const unsub = window.kudu?.onUpdaterStatus?.((s) => set({ status: s }))
    return () => unsub?.()
  }
}))
