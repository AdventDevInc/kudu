import { create } from 'zustand'
import type { ThreatSnapshot } from '@shared/types'

interface ThreatMonitorState {
  snapshot: ThreatSnapshot | null
  loaded: boolean
  load: () => Promise<void>
}

export const useThreatMonitorStore = create<ThreatMonitorState>((set) => ({
  snapshot: null,
  loaded: false,
  load: async () => {
    try {
      const snapshot = await window.kudu.threatMonitorGetSnapshot()
      set({ snapshot: snapshot ?? null, loaded: true })
    } catch {
      set({ snapshot: null, loaded: true })
    }
  }
}))

// Load snapshot eagerly so the sidebar can show/hide the nav item.
// Guard against test environments and prevent duplicate listeners on HMR.
let _listenerRegistered = false
if (typeof window !== 'undefined' && window.kudu && !_listenerRegistered) {
  _listenerRegistered = true
  useThreatMonitorStore.getState().load()

  // The push carries only incremental new threats, so we reload the full
  // accumulated snapshot from main to keep the UI complete.
  window.kudu.onThreatMonitorUpdated(() => {
    useThreatMonitorStore.getState().load()
  })
}
