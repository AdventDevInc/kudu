import { create } from 'zustand'
import type {
  ShredderEntry,
  ShredderProgress,
  ShredderResult
} from '@shared/types'

interface FileShredderState {
  entries: ShredderEntry[]
  status: 'idle' | 'shredding' | 'complete'
  progress: ShredderProgress | null
  result: ShredderResult | null

  addEntries: (entries: ShredderEntry[]) => void
  removeEntry: (path: string) => void
  clearEntries: () => void
  setStatus: (status: FileShredderState['status']) => void
  setProgress: (progress: ShredderProgress | null) => void
  setResult: (result: ShredderResult | null) => void
  reset: () => void
}

export const useFileShredderStore = create<FileShredderState>((set, get) => ({
  entries: [],
  status: 'idle',
  progress: null,
  result: null,

  addEntries: (newEntries) =>
    set((s) => {
      const existingPaths = new Set(s.entries.map((e) => e.path))
      const unique = newEntries.filter((e) => !existingPaths.has(e.path))
      return { entries: [...s.entries, ...unique] }
    }),
  removeEntry: (path) =>
    set((s) => ({ entries: s.entries.filter((e) => e.path !== path) })),
  clearEntries: () => set({ entries: [] }),
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) => set({ result }),
  reset: () =>
    set({
      entries: [],
      status: 'idle',
      progress: null,
      result: null
    })
}))
