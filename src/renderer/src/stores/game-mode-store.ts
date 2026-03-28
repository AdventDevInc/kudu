import { create } from 'zustand'
import type {
  GameModeConfig,
  GameModeOptimizationId,
  GameModeProgress,
} from '@shared/types'

interface GameModeStoreState {
  // Status
  active: boolean
  activatedAt: string | null

  // UI state
  status: 'idle' | 'activating' | 'deactivating'
  progress: GameModeProgress | null
  lastResult: { type: 'activate' | 'deactivate'; succeeded: number; failed: number } | null

  // Auto-detect
  detectedGame: string | null

  // Config (user preferences)
  config: GameModeConfig
  expandedCategories: Set<string>

  // Actions
  setActive: (active: boolean, activatedAt: string | null) => void
  setStatus: (status: 'idle' | 'activating' | 'deactivating') => void
  setProgress: (progress: GameModeProgress | null) => void
  setLastResult: (result: { type: 'activate' | 'deactivate'; succeeded: number; failed: number } | null) => void
  setDetectedGame: (name: string | null) => void
  setConfig: (config: GameModeConfig) => void
  toggleOptimization: (id: GameModeOptimizationId) => void
  toggleCategory: (category: string) => void
  setCustomProcessKillList: (list: string[]) => void
  setAutoDetect: (enabled: boolean) => void
  setAutoDeactivate: (enabled: boolean) => void
  setCustomGameProcesses: (list: string[]) => void
}

const defaultConfig: GameModeConfig = {
  enabledOptimizations: [
    'svc-wsearch', 'svc-sysmain',
    'proc-kill-updaters',
    'mem-clear-standby',
    'sys-focus-assist', 'sys-power-plan', 'sys-prevent-sleep',
    'sys-disable-game-bar', 'sys-disable-fse-opt',
    'net-flush-dns',
  ],
  customProcessKillList: [],
  autoDetect: false,
  autoDeactivate: true,
  customGameProcesses: [],
}

export const useGameModeStore = create<GameModeStoreState>((set, get) => ({
  active: false,
  activatedAt: null,

  status: 'idle',
  progress: null,
  lastResult: null,

  detectedGame: null,

  config: defaultConfig,
  expandedCategories: new Set<string>(),

  setActive: (active, activatedAt) => set({ active, activatedAt }),
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setLastResult: (lastResult) => set({ lastResult }),
  setDetectedGame: (detectedGame) => set({ detectedGame }),
  setConfig: (config) => set({ config }),

  toggleOptimization: (id) => {
    const { config } = get()
    const enabled = config.enabledOptimizations.includes(id)
    const updated: GameModeConfig = {
      ...config,
      enabledOptimizations: enabled
        ? config.enabledOptimizations.filter((o) => o !== id)
        : [...config.enabledOptimizations, id],
    }
    set({ config: updated })
    window.kudu?.settingsSet?.({ gameMode: updated }).catch(() => {})
  },

  toggleCategory: (category) =>
    set((s) => {
      const next = new Set(s.expandedCategories)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return { expandedCategories: next }
    }),

  setCustomProcessKillList: (list) => {
    const { config } = get()
    const updated: GameModeConfig = { ...config, customProcessKillList: list }
    set({ config: updated })
    window.kudu?.settingsSet?.({ gameMode: updated }).catch(() => {})
  },

  setAutoDetect: (enabled) => {
    const { config } = get()
    const updated: GameModeConfig = { ...config, autoDetect: enabled }
    set({ config: updated })
    window.kudu?.settingsSet?.({ gameMode: updated }).catch(() => {})
  },

  setAutoDeactivate: (enabled) => {
    const { config } = get()
    const updated: GameModeConfig = { ...config, autoDeactivate: enabled }
    set({ config: updated })
    window.kudu?.settingsSet?.({ gameMode: updated }).catch(() => {})
  },

  setCustomGameProcesses: (list) => {
    const { config } = get()
    const updated: GameModeConfig = { ...config, customGameProcesses: list }
    set({ config: updated })
    window.kudu?.settingsSet?.({ gameMode: updated }).catch(() => {})
  },
}))

/** Hydrate config from persisted settings and check active status */
export function initGameModeStore(): void {
  window.kudu?.settingsGet?.().then((settings) => {
    if (settings?.gameMode) {
      useGameModeStore.getState().setConfig(settings.gameMode)
    }
  }).catch(() => {})

  window.kudu?.gameModeStatus?.().then((status) => {
    useGameModeStore.getState().setActive(status.active, status.activatedAt)
  }).catch(() => {})

  // Listen for auto-detect events globally so the store stays in sync
  // even when the user is on a different page.
  window.kudu?.onGameModeAutoEvent?.((event) => {
    const s = useGameModeStore.getState()
    if (event.type === 'game-detected') {
      s.setDetectedGame(event.processName)
    } else {
      s.setDetectedGame(null)
    }
    // Refresh active status from main process (source of truth)
    window.kudu?.gameModeStatus?.().then((status) => {
      useGameModeStore.getState().setActive(status.active, status.activatedAt)
    }).catch(() => {})
  })
}
