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
  removeDeletedFiles: (deletedPaths: Set<string>, failedPaths?: Set<string>) => void
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
      else {
        // Never select every copy in a group; at least one must always be kept
        const group = s.result?.groups.find((g) => g.files.some((f) => f.path === path))
        if (group?.files.every((f) => f.path === path || next.has(f.path))) return {}
        // A hard-linked copy frees nothing, and the main process always refuses it.
        if (group?.files.find((f) => f.path === path)?.hardLinked) return {}
        next.add(path)
      }
      return { selectedPaths: next }
    }),
  selectAllDuplicates: () => {
    const result = get().result
    if (!result) return
    const selected = new Set<string>()
    for (const group of result.groups) {
      // Keep the first-listed file — the one the main process also keeps (a
      // hard-linked file before the shortest path) — and select the rest.
      for (const file of group.files.slice(1)) if (!file.hardLinked) selected.add(file.path)
    }
    set({ selectedPaths: selected })
  },
  deselectAll: () => set({ selectedPaths: new Set() }),
  removeDeletedFiles: (deletedPaths, failedPaths = new Set()) => {
    const result = get().result
    if (!result) return
    // Remove deleted files from each group, drop groups with <2 files remaining.
    // A group where a deletion was refused (changed content, no intact copy
    // left, …) no longer matches the scan, so it's dropped until scanned again.
    const groups = result.groups
      .filter((g) => !g.files.some((f) => failedPaths.has(f.path)))
      .map((g) => {
        const remaining = g.files.filter((f) => !deletedPaths.has(f.path))
        return {
          ...g,
          files: remaining,
          // Hard-linked copies free nothing when deleted, so they never count.
          reclaimableSpace:
            remaining.length >= 2
              ? g.fileSize * remaining.slice(1).filter((f) => !f.hardLinked).length
              : 0
        }
      })
      .filter((g) => g.files.length >= 2)
    const totalDuplicates = groups.reduce((s, g) => s + g.files.length - 1, 0)
    const totalReclaimable = groups.reduce((s, g) => s + g.reclaimableSpace, 0)
    // Remove deleted paths from selection
    const nextSelected = new Set<string>()
    const shown = new Set(groups.flatMap((g) => g.files.map((f) => f.path)))
    for (const p of get().selectedPaths) {
      if (!deletedPaths.has(p) && shown.has(p)) nextSelected.add(p)
    }
    set({
      result: { ...result, groups, totalDuplicates, totalReclaimable },
      selectedPaths: nextSelected
    })
  },
  reset: () =>
    set({
      status: 'idle',
      progress: null,
      result: null,
      selectedPaths: new Set(),
      deleteResult: null
    })
}))
