import { create } from 'zustand'
import type { KuduSettings } from '@shared/types'

interface SettingsState {
  settings: KuduSettings
  loaded: boolean
  setSettings: (settings: KuduSettings) => void
  updateSettings: (partial: Partial<KuduSettings>) => void
}

const defaultSettings: KuduSettings = {
  theme: 'dark',
  language: 'en',
  minimizeToTray: false,
  showNotificationOnComplete: true,
  showThreatNotifications: true,
  runAtStartup: false,
  autoUpdate: true,
  autoRestart: true,
  updateCheckIntervalHours: 4,
  cleaner: {
    skipRecentMinutes: 60,
    secureDelete: false,
    closeBrowsersBeforeClean: false,
    createRestorePoint: false,
    protectRecycleBin: true
  },
  exclusions: [],
  ignoredSoftwareUpdates: [],
  backupPath: '',
  backupMode: 'targeted',
  schedule: {
    enabled: false,
    frequency: 'weekly',
    day: 1,
    hour: 9
  },
  schedules: [],
  cloud: {
    apiKey: '',
    telemetryIntervalSec: 60,
    shareDiskHealth: true,
    shareProcessList: true,
    shareThreatMonitor: true,
    allowRemotePower: true,
    allowRemoteCleanup: true,
    allowRemoteInstalls: true,
    allowRemoteConfig: true
  },
  windowsPackageManager: 'winget',
  gameMode: {
    enabledOptimizations: [
      'svc-wsearch', 'svc-sysmain',
      'proc-kill-updaters',
      'mem-clear-standby',
      'sys-focus-assist', 'sys-power-plan', 'sys-prevent-sleep',
      'sys-disable-game-bar', 'sys-disable-fse-opt',
      'net-flush-dns'
    ],
    customProcessKillList: [],
    autoDetect: false,
    autoDeactivate: true,
    customGameProcesses: []
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: defaultSettings,
  loaded: false,
  setSettings: (settings) => set({ settings, loaded: true }),
  updateSettings: (partial) =>
    set((s) => ({
      settings: {
        ...s.settings,
        ...partial,
        cleaner: { ...s.settings.cleaner, ...(partial.cleaner ?? {}) },
        schedule: { ...s.settings.schedule, ...(partial.schedule ?? {}) },
        // schedules is an array — replace entirely when provided
        schedules: partial.schedules ?? s.settings.schedules,
        cloud: { ...s.settings.cloud, ...(partial.cloud ?? {}) },
        gameMode: { ...s.settings.gameMode, ...(partial.gameMode ?? {}) }
      }
    }))
}))

/** Re-fetch settings from main process into the store */
export function refreshSettings(): void {
  window.kudu?.settingsGet?.().then((settings) => {
    useSettingsStore.getState().setSettings(settings)
  }).catch(() => {})
}

// Hydrate settings eagerly so pages that depend on them (e.g. ThreatMonitorPage)
// don't see stale defaults before the user visits Settings.
if (typeof window !== 'undefined' && window.kudu) {
  refreshSettings()
}
