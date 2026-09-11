import { create } from 'zustand'
import type {
  EmptyFolderScanResult,
  EmptyFolderScanProgress,
  EmptyFolderDeleteMode,
  EmptyFolderDeleteResult
} from '@shared/types'

interface EmptyFolderState {
  directory: string | null
  maxDepth: number
  excludePatterns: string[]

  status: 'idle' | 'scanning' | 'complete' | 'deleting'
  progress: EmptyFolderScanProgress | null
  result: EmptyFolderScanResult | null

  selectedPaths: Set<string>
  deleteMode: EmptyFolderDeleteMode
  deleteResult: EmptyFolderDeleteResult | null

  setDirectory: (dir: string | null) => void
  setMaxDepth: (depth: number) => void
  setExcludePatterns: (patterns: string[]) => void
  setStatus: (status: EmptyFolderState['status']) => void
  setProgress: (progress: EmptyFolderScanProgress | null) => void
  setResult: (result: EmptyFolderScanResult | null) => void
  setDeleteMode: (mode: EmptyFolderDeleteMode) => void
  setDeleteResult: (result: EmptyFolderDeleteResult | null) => void
  togglePath: (path: string) => void
  selectAll: () => void
  deselectAll: () => void
  removeDeletedFolders: (deletedPaths: Set<string>) => void
  reset: () => void
}

export const useEmptyFolderStore = create<EmptyFolderState>((set, get) => ({
  directory: null,
  maxDepth: 20,
  excludePatterns: [
    'node_modules',
    '$Recycle.Bin',
    'System Volume Information',
    'Chrome',
    'Firefox',
    'Edge',
    'BraveSoftware',
    'Opera',
    'Vivaldi',
    'Cache',
    'Code Cache',
    'GPUCache',
    'ShaderCache',
    'GrShaderCache',
    'DawnCache',
    'CacheStorage',
    'Service Worker',
    'IndexedDB',
    'Crashpad',
    'BrowserMetrics',
    'Safe Browsing'
  ],

  status: 'idle',
  progress: null,
  result: null,

  selectedPaths: new Set(),
  deleteMode: 'recycle',
  deleteResult: null,

  setDirectory: (directory) => set({ directory }),
  setMaxDepth: (maxDepth) => set({ maxDepth }),
  setExcludePatterns: (excludePatterns) => set({ excludePatterns }),
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
  selectAll: () => {
    const result = get().result
    if (!result) return
    const selected = new Set<string>()
    for (const folder of result.folders) selected.add(folder.path)
    set({ selectedPaths: selected })
  },
  deselectAll: () => set({ selectedPaths: new Set() }),
  removeDeletedFolders: (deletedPaths) => {
    const result = get().result
    if (!result) return
    const folders = result.folders.filter((f) => !deletedPaths.has(f.path))
    const nextSelected = new Set<string>()
    for (const p of get().selectedPaths) {
      if (!deletedPaths.has(p)) nextSelected.add(p)
    }
    set({
      result: { ...result, folders },
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
