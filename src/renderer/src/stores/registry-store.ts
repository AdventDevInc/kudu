import { create } from 'zustand'
import type { RegistryEntry } from '@shared/types'
import { isPersistentTweak, tweakSignature } from '@shared/registry-tweaks'

interface FixResult {
  fixed: number
  failed: number
  failures: { issue: string; reason: string }[]
}

interface RegistryState {
  entries: RegistryEntry[]
  scanning: boolean
  scanned: boolean
  fixing: boolean
  fixProgress: { current: number; total: number; currentEntry: string } | null
  expandedCards: Set<number>
  fixResult: FixResult | null
  showFailures: boolean
  error: string | null
  /** Persisted "ignore this tweak" signatures, mirrored from settings (issue #172). */
  ignoredTweaks: string[]

  setEntries: (entries: RegistryEntry[]) => void
  setScanning: (scanning: boolean) => void
  setScanned: (scanned: boolean) => void
  setFixing: (fixing: boolean) => void
  setFixProgress: (progress: { current: number; total: number; currentEntry: string } | null) => void
  toggleCardExpand: (cardIndex: number) => void
  setFixResult: (result: FixResult | null) => void
  setShowFailures: (show: boolean) => void
  setError: (error: string | null) => void
  setIgnoredTweaks: (signatures: string[]) => void
  toggleEntry: (id: string) => void
  toggleCardAll: (types: string[]) => void
  reset: () => void
}

/**
 * Persist the user's de-selection of recurring advisory tweaks so the box
 * isn't re-ticked on the next scan/restart (issue #172). `selectedNow` is the
 * entry's state *after* the toggle: selected → remove from ignore list,
 * deselected → add. Returns the updated signature list.
 */
function nextIgnoredTweaks(
  current: string[],
  entries: Pick<RegistryEntry, 'type' | 'keyPath' | 'valueName'>[],
  selectedNow: boolean
): string[] {
  const tweaks = entries.filter((e) => isPersistentTweak(e.type))
  if (tweaks.length === 0) return current
  const next = new Set(current)
  for (const e of tweaks) {
    if (selectedNow) next.delete(tweakSignature(e))
    else next.add(tweakSignature(e))
  }
  const list = [...next]
  window.kudu?.settingsSet?.({ registryIgnoredTweaks: list }).catch(() => {})
  return list
}

export const useRegistryStore = create<RegistryState>((set, get) => ({
  entries: [],
  scanning: false,
  scanned: false,
  fixing: false,
  fixProgress: null,
  expandedCards: new Set<number>(),
  fixResult: null,
  showFailures: false,
  error: null,
  ignoredTweaks: [],

  setEntries: (entries) => set({ entries }),
  setScanning: (scanning) => set({ scanning }),
  setScanned: (scanned) => set({ scanned }),
  setFixing: (fixing) => set({ fixing }),
  setFixProgress: (fixProgress) => set({ fixProgress }),
  toggleCardExpand: (cardIndex) =>
    set((s) => {
      const next = new Set(s.expandedCards)
      next.has(cardIndex) ? next.delete(cardIndex) : next.add(cardIndex)
      return { expandedCards: next }
    }),
  setFixResult: (fixResult) => set({ fixResult }),
  setShowFailures: (showFailures) => set({ showFailures }),
  setError: (error) => set({ error }),
  setIgnoredTweaks: (ignoredTweaks) => set({ ignoredTweaks }),
  toggleEntry: (id) => {
    const s = get()
    const entry = s.entries.find((e) => e.id === id)
    if (!entry) return
    const selectedNow = !entry.selected
    set({
      entries: s.entries.map((e) => (e.id === id ? { ...e, selected: selectedNow } : e)),
      ignoredTweaks: nextIgnoredTweaks(s.ignoredTweaks, [entry], selectedNow)
    })
  },
  toggleCardAll: (types) => {
    const s = get()
    const cardEntries = s.entries.filter((e) => types.includes(e.type))
    const allSelected = cardEntries.length > 0 && cardEntries.every((e) => e.selected)
    const selectedNow = !allSelected
    set({
      entries: s.entries.map((e) =>
        types.includes(e.type) ? { ...e, selected: selectedNow } : e
      ),
      ignoredTweaks: nextIgnoredTweaks(s.ignoredTweaks, cardEntries, selectedNow)
    })
  },
  reset: () =>
    set({
      entries: [],
      scanning: false,
      scanned: false,
      fixing: false,
      fixProgress: null,
      fixResult: null,
      showFailures: false,
      error: null
    })
}))

// Hydrate the persisted "ignore this tweak" list once at startup so toggles
// don't clobber it before the user's first scan (issue #172).
if (typeof window !== 'undefined' && window.kudu?.settingsGet) {
  window.kudu
    .settingsGet()
    .then((settings) => {
      if (Array.isArray(settings?.registryIgnoredTweaks)) {
        useRegistryStore.getState().setIgnoredTweaks(settings.registryIgnoredTweaks)
      }
    })
    .catch(() => {})
}
