import { create } from 'zustand'
import type {
  DuplicateScanResult,
  DuplicateScanProgress,
  DuplicateDeleteMode,
  DuplicateDeleteResult
} from '@shared/types'

interface DuplicateState {
  // Config
  directory: string | null
  minFileSize: number
  maxFileSize: number | null
  excludePatterns: string[]
  extensionFilter: string[]
  maxDepth: number

  // Scan state
  status: 'idle' | 'scanning' | 'complete' | 'deleting'
  progress: DuplicateScanProgress | null
  result: DuplicateScanResult | null

  // Selection
  selectedPaths: Set<string>
  deleteMode: DuplicateDeleteMode
  deleteResult: DuplicateDeleteResult | null

  // Setters
  setDirectory: (dir: string | null) => void
  setMinFileSize: (size: number) => void
  setMaxFileSize: (size: number | null) => void
  setExcludePatterns: (patterns: string[]) => void
  setExtensionFilter: (exts: string[]) => void
  setMaxDepth: (depth: number) => void
  setStatus: (status: DuplicateState['status']) => void
  setProgress: (progress: DuplicateScanProgress | null) => void
  setResult: (result: DuplicateScanResult | null) => void
  setDeleteMode: (mode: DuplicateDeleteMode) => void
  setDeleteResult: (result: DuplicateDeleteResult | null) => void
  togglePath: (path: string) => void
  selectAllDuplicates: () => void
  deselectAll: () => void
  reset: () => void
}

export const useDuplicateStore = create<DuplicateState>((set, get) => ({
  directory: null,
  minFileSize: 1_048_576,
  maxFileSize: null,
  excludePatterns: ['node_modules', '.git', '$Recycle.Bin'],
  extensionFilter: [],
  maxDepth: 20,

  status: 'idle',
  progress: null,
  result: null,

  selectedPaths: new Set(),
  deleteMode: 'recycle',
  deleteResult: null,

  setDirectory: (directory) => set({ directory }),
  setMinFileSize: (minFileSize) => set({ minFileSize }),
  setMaxFileSize: (maxFileSize) => set({ maxFileSize }),
  setExcludePatterns: (excludePatterns) => set({ excludePatterns }),
  setExtensionFilter: (extensionFilter) => set({ extensionFilter }),
  setMaxDepth: (maxDepth) => set({ maxDepth }),
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) => set({ result }),
  setDeleteMode: (deleteMode) => set({ deleteMode }),
  setDeleteResult: (deleteResult) => set({ deleteResult }),
  togglePath: (path) =>
    set((s) => {
      const next = new Set(s.selectedPaths)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { selectedPaths: next }
    }),
  selectAllDuplicates: () => {
    const result = get().result
    if (!result) return
    const selected = new Set<string>()
    for (const group of result.groups) {
      // Keep the file with the shortest path, select the rest
      const sorted = [...group.files].sort((a, b) => a.path.length - b.path.length)
      for (let i = 1; i < sorted.length; i++) {
        selected.add(sorted[i].path)
      }
    }
    set({ selectedPaths: selected })
  },
  deselectAll: () => set({ selectedPaths: new Set() }),
  reset: () =>
    set({
      status: 'idle',
      progress: null,
      result: null,
      selectedPaths: new Set(),
      deleteResult: null
    })
}))
