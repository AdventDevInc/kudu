import { create } from 'zustand'
import type { MonitoredEmail } from '@shared/types'
import { useSettingsStore } from './settings-store'

interface BreachState {
  emails: MonitoredEmail[]
  limit: number
  usage: number
  status: 'idle' | 'loading' | 'done'
  error: string | null
  selectedEmail: string | null
  addingEmail: boolean

  fetch: () => Promise<void>
  addEmail: (email: string) => Promise<void>
  removeEmail: (email: string) => Promise<void>
  acknowledgeBreaches: (breachIds: string[]) => Promise<void>
  setSelectedEmail: (email: string | null) => void
  reset: () => void
}

const initial = {
  emails: [] as MonitoredEmail[],
  limit: 0,
  usage: 0,
  status: 'idle' as const,
  error: null as string | null,
  selectedEmail: null as string | null,
  addingEmail: false,
}

export const useBreachStore = create<BreachState>((set, get) => ({
  ...initial,

  fetch: async () => {
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
      set({ error: msg, status: 'done' })
    }
  },

  addEmail: async (email: string) => {
    set({ addingEmail: true })
    try {
      await window.kudu.breachMonitorAdd([email])
      // POST only returns newly added emails — re-fetch to get the full list
      const result = await window.kudu.breachMonitorFetch()
      set({
        emails: result.emails,
        limit: result.limit,
        usage: result.usage,
        addingEmail: false,
        error: null,
      })
    } catch (err) {
      set({ addingEmail: false })
      throw err
    }
  },

  removeEmail: async (email: string) => {
    const prev = get().emails
    set({ emails: prev.filter((e) => e.email !== email) })
    try {
      await window.kudu.breachMonitorRemove(email)
      const result = await window.kudu.breachMonitorFetch()
      set({ emails: result.emails, limit: result.limit, usage: result.usage })
      // If we just removed the selected email, clear selection
      if (get().selectedEmail === email) set({ selectedEmail: null })
    } catch (err) {
      set({ emails: prev })
      throw err
    }
  },

  acknowledgeBreaches: async (breachIds: string[]) => {
    await window.kudu.breachMonitorAcknowledge(breachIds)
    // Optimistically mark as acknowledged locally
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

  setSelectedEmail: (email) => set({ selectedEmail: email }),
  reset: () => set(initial),
}))

// Reset breach data when cloud API key is removed (device unlinked)
let _breachListenerRegistered = false
if (typeof window !== 'undefined' && window.kudu && !_breachListenerRegistered) {
  _breachListenerRegistered = true
  let prevApiKey = useSettingsStore.getState().settings.cloud.apiKey
  useSettingsStore.subscribe((state) => {
    const key = state.settings.cloud.apiKey
    if (prevApiKey && !key) useBreachStore.getState().reset()
    prevApiKey = key
  })
}
