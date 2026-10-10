import { create } from 'zustand'
import type { DownloadsScanResult, DownloadsTrashResult } from '@shared/downloads-review'

interface State {
  result: DownloadsScanResult | null
  busy: boolean
  phase: 'idle' | 'scanning' | 'moving'
  error: string | null
  outcome: DownloadsTrashResult | null
  selected: Set<string>
  toggle: (id: string) => void
  select: (ids: string[]) => void
  clearSelection: () => void
  scan: () => Promise<void>
  trash: () => Promise<void>
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
export const useDownloadsStore = create<State>((set, get) => ({
  result: null,
  busy: false,
  phase: 'idle',
  error: null,
  outcome: null,
  selected: new Set(),
  select: (ids) => set((state) => ({ selected: new Set([...state.selected, ...ids]) })),
  toggle: (id) =>
    set((state) => {
      const selected = new Set(state.selected)
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      return { selected }
    }),
  clearSelection: () => set({ selected: new Set() }),
  scan: async () => {
    if (get().busy) return
    set({
      busy: true,
      phase: 'scanning',
      error: null,
      result: null,
      selected: new Set(),
      outcome: null
    })
    try {
      set({ result: await window.kudu.downloadsScan() })
    } catch (error) {
      set({ error: message(error) })
    } finally {
      set({ busy: false, phase: 'idle' })
    }
  },
  trash: async () => {
    const { busy, result, selected } = get()
    if (busy || !result || !selected.size) return
    set({ busy: true, phase: 'moving', error: null, outcome: null })
    try {
      const outcome = await window.kudu.downloadsTrash(result.scanId, [...selected])
      set({
        outcome,
        selected: new Set(),
        result: {
          ...result,
          files: result.files.filter((file) => !outcome.trashedIds.includes(file.id))
        }
      })
    } catch (error) {
      set({ error: message(error) })
    } finally {
      set({ busy: false, phase: 'idle' })
    }
  }
}))
