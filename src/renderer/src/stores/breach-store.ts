import { create } from 'zustand'
import type { MonitoredEmail } from '@shared/types'
import { useSettingsStore } from './settings-store'

interface BreachState {
  emails: MonitoredEmail[]
  limit: number
  usage: number
  status: 'idle' | 'loading' | 'done'
  error: string | null
  addingEmail: boolean

  fetch: (retries?: number) => Promise<void>
  addEmail: (email: string) => Promise<void>
  removeEmail: (email: string) => Promise<void>
  acknowledgeBreaches: (breachIds: string[]) => Promise<void>
  reset: () => void
}

const initial = {
  emails: [] as MonitoredEmail[],
  limit: 0,
  usage: 0,
  status: 'idle' as const,
  error: null as string | null,
  addingEmail: false,
}

export const useBreachStore = create<BreachState>((set, get) => ({
  ...initial,

  fetch: async (retries = 3) => {
    set({ status: 'loading', error: null })
    try {
      const result = await window.kudu.breachMonitorFetch()
      set({
        emails: result.emails,
        limit: result.limit,
        usage: result.usage,
        status: 'done',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch breach data'
      // Cloud agent may still be connecting — retry silently
      if (msg.includes('not connected') && retries > 0) {
        setTimeout(() => get().fetch(retries - 1), 3000)
        return
      }
      set({ error: msg, status: 'done' })
    }
  },

  addEmail: async (email: string) => {
    set({ addingEmail: true })
    try {
      await window.kudu.breachMonitorAdd([email])
    } catch (err) {
      set({ addingEmail: false })
      throw err
    }
    // Add succeeded — refresh is best-effort
    try {
      const result = await window.kudu.breachMonitorFetch()
      set({ emails: result.emails, limit: result.limit, usage: result.usage, addingEmail: false, error: null })
    } catch {
      set({ addingEmail: false })
    }
  },

  removeEmail: async (email: string) => {
    const prev = get().emails
    const prevUsage = get().usage
    set({ emails: prev.filter((e) => e.email !== email), usage: Math.max(0, prevUsage - 1) })
    try {
      await window.kudu.breachMonitorRemove(email)
    } catch (err) {
      set({ emails: prev, usage: prevUsage })
      throw err
    }
    // Delete succeeded — refresh is best-effort, don't revert on failure
    try {
      const result = await window.kudu.breachMonitorFetch()
      set({ emails: result.emails, limit: result.limit, usage: result.usage })
    } catch { /* keep optimistic removal */ }
  },

  acknowledgeBreaches: async (breachIds: string[]) => {
    // Chunk into batches of 100 to stay within IPC validation limit
    for (let i = 0; i < breachIds.length; i += 100) {
      await window.kudu.breachMonitorAcknowledge(breachIds.slice(i, i + 100))
    }
    // Mark as acknowledged locally
    const now = new Date().toISOString()
    const idSet = new Set(breachIds)
    set({
      emails: get().emails.map((em) => ({
        ...em,
        breaches: em.breaches.map((b) =>
          idSet.has(b.name) && !b.acknowledgedAt ? { ...b, acknowledgedAt: now } : b
        ),
      })),
    })
  },

  reset: () => set(initial),
}))

// Eagerly fetch breach data on startup if cloud-connected,
// and reset when cloud is unlinked
let _breachListenerRegistered = false
if (typeof window !== 'undefined' && window.kudu && !_breachListenerRegistered) {
  _breachListenerRegistered = true

  // Hydrate immediately so the sidebar badge is accurate without visiting the page
  if (useSettingsStore.getState().settings.cloud.apiKey) {
    useBreachStore.getState().fetch()
  }

  let prevApiKey = useSettingsStore.getState().settings.cloud.apiKey
  useSettingsStore.subscribe((state) => {
    const key = state.settings.cloud.apiKey
    if (prevApiKey && !key) {
      useBreachStore.getState().reset()
    } else if (!prevApiKey && key) {
      // Just linked — fetch breach data
      useBreachStore.getState().fetch()
    }
    prevApiKey = key
  })
}
