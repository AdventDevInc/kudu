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

  setEntries: (entries: RegistryEntry[]) => void
  setScanning: (scanning: boolean) => void
  setScanned: (scanned: boolean) => void
  setFixing: (fixing: boolean) => void
  setFixProgress: (progress: { current: number; total: number; currentEntry: string } | null) => void
  toggleCardExpand: (cardIndex: number) => void
  setFixResult: (result: FixResult | null) => void
  setShowFailures: (show: boolean) => void
  setError: (error: string | null) => void
  toggleEntry: (id: string) => void
  toggleCardAll: (types: string[]) => void
  reset: () => void
}

/**
 * Persist the user's de-selection of recurring advisory tweaks so the box isn't
 * re-ticked on the next scan/restart (issue #172). We send only the affected
 * signatures and let the main process merge them into the saved list under its
 * write lock — the renderer never holds the authoritative list, so a toggle can
 * never drop previously-ignored signatures. `selectedNow` is the state *after*
 * the toggle: deselected ⇒ ignore, selected ⇒ un-ignore.
 */
function persistTweakChoice(
  entries: Pick<RegistryEntry, 'type' | 'keyPath' | 'valueName'>[],
  selectedNow: boolean
): void {
  const signatures = entries.filter((e) => isPersistentTweak(e.type)).map(tweakSignature)
  if (signatures.length === 0) return
  window.kudu?.registrySetTweakIgnored?.(signatures, !selectedNow).catch(() => {})
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
  toggleEntry: (id) => {
    const entry = get().entries.find((e) => e.id === id)
    if (!entry) return
    const selectedNow = !entry.selected
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, selected: selectedNow } : e))
    }))
    persistTweakChoice([entry], selectedNow)
  },
  toggleCardAll: (types) => {
    const cardEntries = get().entries.filter((e) => types.includes(e.type))
    const allSelected = cardEntries.length > 0 && cardEntries.every((e) => e.selected)
    const selectedNow = !allSelected
    set((s) => ({
      entries: s.entries.map((e) =>
        types.includes(e.type) ? { ...e, selected: selectedNow } : e
      )
    }))
    persistTweakChoice(cardEntries, selectedNow)
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
