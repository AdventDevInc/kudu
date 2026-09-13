// Dedicated browser-only QA entry. This module is never imported by the Electron entry.
import { defaultSettings } from '../stores/settings-store'
import { featureReads } from './feature-fixtures'
import type { ScanHistoryEntry, StartupItem, PerfSnapshot } from '@shared/types'

const GB = 1024 ** 3
const now = Date.now()
const empty = new URLSearchParams(location.search).get('state') === 'empty'
const settings = structuredClone(defaultSettings)
settings.theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
settings.language = 'en'
settings.schedules = empty
  ? []
  : [
      {
        id: 'preview-weekly',
        name: 'Weekly fresh start',
        enabled: true,
        frequency: 'weekly',
        day: 1,
        hour: 9,
        minute: 0,
        tasks: ['cleaner:system', 'cleaner:browsers'],
        autoApply: false,
        lastRunAt: null,
        lastRunStatus: 'never',
        createdAt: new Date(now).toISOString()
      }
    ]
const history: ScanHistoryEntry[] = empty
  ? []
  : Array.from({ length: 8 }, (_, i) => ({
      id: 'preview-' + i,
      type: i % 3 ? 'cleaner' : 'malware',
      timestamp: new Date(now - i * 86400000).toISOString(),
      duration: 15000 + i * 1800,
      totalItemsFound: i % 3 ? 1248 + i * 30 : 0,
      totalItemsCleaned: i % 3 ? 1248 + i * 30 : 0,
      totalItemsSkipped: 0,
      totalSpaceSaved: i % 3 ? (2.8 + i / 10) * GB : 0,
      categories: [],
      errorCount: 0
    }))
const startup: StartupItem[] = empty
  ? []
  : ['Discord', 'Steam', 'OneDrive', 'Windows Security'].map((name, i) => ({
      id: 'startup-' + i,
      name,
      displayName: name,
      command: 'C:\\Program Files\\' + name + '\\app.exe',
      location: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      source: 'registry-hkcu',
      enabled: true,
      publisher: i >= 2 ? 'Microsoft Corporation' : name,
      impact: i < 2 ? 'high' : 'low'
    }))
const callbacks = new Map<string, Set<(value: any) => void>>()
const emit = (name: string, data: unknown) =>
  callbacks.get(name)?.forEach((callback) => callback(data))
let quickCount = 0
let monitoring: ReturnType<typeof setInterval> | undefined
const snapshot = (i: number): PerfSnapshot => ({
  timestamp: Date.now() - (90 - i) * 1000,
  cpu: { overall: 12 + Math.round(Math.abs(Math.sin(i * 0.9)) * 22), perCore: Array(12).fill(12) },
  memory: { usedBytes: 8.4 * GB, totalBytes: 32 * GB, cachedBytes: 2 * GB, percent: 26 },
  disk: { readBytesPerSec: (2 + (i % 6)) * 1024 ** 2, writeBytesPerSec: 1024 ** 2 },
  network: { rxBytesPerSec: 22000, txBytesPerSec: 4800 },
  uptime: 14820
})
const drive = {
  letter: 'C',
  label: 'Windows',
  totalSize: 512 * GB,
  freeSpace: 184 * GB,
  usedSpace: 328 * GB,
  isSystem: true
}
const reads: Record<string, (...args: any[]) => unknown> = {
  platformInfo: () => ({
    platform: 'win32',
    features: {
      registry: true,
      debloater: true,
      drivers: true,
      restorePoint: true,
      bootTrace: true,
      gameMode: true,
      firewallAudit: true,
      contextMenu: true
    }
  }),
  systemScan: () =>
    empty
      ? []
      : ['Temporary files', 'Windows logs', 'Crash reports'].map((subcategory, group) => ({
          category: 'system',
          subcategory,
          itemCount: 3,
          totalSize: (group + 1) * 150 * 1024 ** 2,
          items: Array.from({ length: 3 }, (_, i) => ({
            id: 'preview-file-' + group + '-' + i,
            path: 'C:\\Users\\Preview\\AppData\\Local\\Temp\\sample-' + group + '-' + i + '.tmp',
            size: (group + 1) * 50 * 1024 ** 2,
            category: 'system',
            subcategory,
            lastModified: now - 604800000,
            selected: true
          }))
        })),
  browserScan: () => [],
  appScan: () => [],
  gamingScan: () => [],
  recycleBinScan: () => [],
  shortcutScan: () => [],
  environmentScan: () => [],
  databaseScan: () => [],
  cleanerBlockers: () => [],
  serviceScan: () => ({
    services: empty
      ? []
      : ['Print Spooler', 'Bluetooth Support Service', 'Windows Search'].map((displayName, i) => ({
          name: 'preview-service-' + i,
          displayName,
          description: [
            'Manages local print jobs.',
            'Supports Bluetooth device discovery.',
            'Indexes content for faster searches.'
          ][i],
          status: 'Running',
          startType: 'Automatic',
          originalStartType: 'Automatic',
          safety: 'caution',
          category: ['print', 'bluetooth', 'misc'][i],
          isMicrosoft: true,
          dependsOn: [],
          dependents: [],
          selected: false
        })),
    totalCount: empty ? 0 : 3,
    runningCount: empty ? 0 : 3,
    disabledCount: 0,
    safeToDisableCount: 0
  }),
  privacyScan: () => ({
    settings: empty
      ? []
      : ['Diagnostic data', 'Advertising ID', 'Activity history'].map((label, i) => ({
          id: 'preview-privacy-' + i,
          category: 'telemetry',
          label,
          description: 'Review this Windows privacy preference.',
          enabled: i === 0,
          reversible: true,
          requiresAdmin: false
        })),
    score: empty ? 0 : 33,
    total: empty ? 0 : 3,
    protected: empty ? 0 : 1
  }),
  firewallScan: () => ({
    rules: [],
    totalCount: 0,
    staleCount: 0,
    unsignedCount: 0,
    broadScopeCount: 0
  }),
  diskAnalyze: () => ({
    name: 'C:',
    path: 'C:',
    size: 328 * GB,
    fileCount: 12400,
    children: ['Users', 'Windows', 'Program Files', 'Other'].map((name, i) => ({
      name,
      path: 'C:\\' + name,
      size: [124, 92, 78, 34][i] * GB,
      fileCount: 3100,
      children: []
    }))
  }),
  ...featureReads(empty),
  settingsGet: () => settings,
  settingsSet: (partial) => Object.assign(settings, partial),
  onboardingGet: () => true,
  elevationCheck: () => ({ isAdmin: true, isElevated: true }),
  updaterGetStatus: () => ({ state: 'idle' }),
  historyGet: () => history,
  historyAdd: (entry) => {
    history.unshift(entry)
    emit('onHistoryChanged', undefined)
  },
  cloudHistoryGet: () => [],
  cloudGetStatus: () => ({ status: 'disconnected' }),
  threatMonitorGetSnapshot: () => null,
  startupList: () => startup,
  startupBootTrace: () => null,
  startupSafetyFetch: () => ({}),
  programSafetyFetch: () => ({}),
  diskDrives: () => (empty ? [] : [drive]),
  diskTrimList: () =>
    empty
      ? []
      : [
          {
            ...drive,
            id: 'C',
            mediaType: 'NVMe',
            busType: 'NVMe',
            filesystem: 'NTFS',
            isRemovable: false,
            isEncrypted: false,
            trimSupport: 'supported',
            status: 'recommended',
            statusReason: 'Ready for maintenance',
            lastTrimAt: null
          }
        ],
  perfQuickStats: () => {
    quickCount++
    return {
      cpuPercent: empty ? 0 : 12 + (quickCount % 5) * 3,
      memUsedBytes: 8.4 * GB,
      memTotalBytes: 32 * GB,
      memPercent: 26
    }
  },
  perfGetSystemInfo: () => ({
    cpuModel: 'Intel Core i7-12700K',
    cpuCores: 12,
    cpuThreads: 20,
    totalMemBytes: 32 * GB,
    osVersion: 'Windows 11',
    hostname: 'DESKTOP-PREVIEW'
  }),
  perfGetDiskHealth: () => [],
  perfStartMonitoring: () => {
    if (monitoring) clearInterval(monitoring)
    if (!empty) for (let i = 0; i <= 90; i++) emit('onPerfSnapshot', snapshot(i))
    monitoring = setInterval(
      () => emit('onPerfSnapshot', { ...snapshot(quickCount++ % 90), timestamp: Date.now() }),
      1000
    )
  },
  perfStopMonitoring: () => {
    clearInterval(monitoring)
  },
  softwareUpdateCheck: () => ({
    apps: empty
      ? []
      : [
          {
            id: 'Mozilla.Firefox',
            name: 'Mozilla Firefox',
            currentVersion: '130.0',
            availableVersion: '130.0.1',
            source: 'winget',
            severity: 'patch',
            selected: true
          },
          {
            id: 'VideoLAN.VLC',
            name: 'VLC media player',
            currentVersion: '3.0.20',
            availableVersion: '3.0.21',
            source: 'winget',
            severity: 'patch',
            selected: true
          }
        ],
    upToDate: [],
    packageManagerAvailable: true,
    packageManagerName: 'winget',
    managers: [{ name: 'winget', available: true, updateCount: empty ? 0 : 2 }]
  }),
  driverUpdateScan: () => ({
    updates: [],
    totalAvailable: 0,
    scanDuration: 100,
    updatesDisabled: false
  }),
  driverScan: () => ({ drivers: [], totalStale: 0, totalStaleSize: 0 }),
  gameModeStatus: () => ({ active: false, activatedAt: null, pendingRestore: false }),
  gameModeGetStatus: () => ({ active: false, activatedAt: null, pendingRestore: false }),
  malwareAllowlistList: () => [],
  malwareQuarantineList: () => [],
  malwareYaraInfo: () => ({
    source: 'bundled',
    engine: 'yara-x',
    ruleCount: 7200,
    lastUpdated: new Date(now).toISOString(),
    ready: true
  }),
  cleanupReceipts: () => [],
  deletionLogQuery: () => ({ records: [], total: 0 }),
  uninstallerList: () => ({
    programs: empty
      ? []
      : ['Firefox', 'VLC media player', 'Visual Studio Code'].map((name, i) => ({
          id: 'app-' + i,
          displayName: name,
          publisher: ['Mozilla', 'VideoLAN', 'Microsoft'][i],
          displayVersion: '1.0.0',
          installDate: '20260820',
          estimatedSize: (130 + 50 * i) * 1024 ** 2,
          installLocation: 'C:\\Program Files\\' + name,
          uninstallString: 'preview',
          quietUninstallString: '',
          displayIcon: '',
          registryKey: 'preview',
          isSystemComponent: false,
          isWindowsInstaller: false,
          lastUsed: now - i * 86400000
        }))
  }),
  duplicatesSelectDir: () => 'C:\\Users\\Preview\\Downloads',
  largeFilesSelectDir: () => 'C:\\Users\\Preview\\Downloads',
  emptyFoldersSelectDir: () => 'C:\\Users\\Preview\\Downloads',
  shredderSelectFiles: () => [],
  shredderSelectFolders: () => [],
  cveFetch: () => ({ vulnerabilities: [], total: 0 }),
  breachMonitorFetch: () => ({ emails: [], breaches: [] })
}

window.kudu = new Proxy(
  {},
  {
    get: (_, name: string) => {
      if (/^on[A-Z]/.test(name))
        return (callback: (value: unknown) => void) => {
          const set = callbacks.get(name) ?? new Set()
          set.add(callback)
          callbacks.set(name, set)
          return () => {
            set.delete(callback)
          }
        }
      if (name === 'windowSetChromeTheme') return async () => {}
      return async (...args: unknown[]) => {
        if (name in reads) return reads[name](...args)
        throw new Error('Preview bridge: operation is not simulated (' + name + ')')
      }
    }
  }
) as typeof window.kudu

const badge = document.createElement('div')
badge.setAttribute('role', 'status')
badge.textContent = 'PRODUCT PREVIEW · SAMPLE DATA · NO SYSTEM CHANGES'
badge.style.cssText =
  'position:fixed;bottom:4px;right:12px;z-index:99999;font:9px Segoe UI;letter-spacing:1px;color:#9ba7af;pointer-events:none;'
document.body.append(badge)
await import('../main')
