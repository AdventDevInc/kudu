import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/channels'
import type {
  PlatformInfo,
  ScanResult,
  CleanResult,
  ProgressData,
  DiskRepairProgress,
  DiskRepairResult,
  RegistryEntry,
  StartupItem,
  StartupBootTrace,
  DiskNode,
  DriveInfo,
  KuduSettings,
  BloatwareApp,
  ScanHistoryEntry,
  NetworkItem,
  NetworkCleanResult,
  MalwareScanResult,
  MalwareScanProgress,
  MalwareActionResult,
  PrivacyShieldState,
  PrivacyApplyResult,
  PrivacyScanProgress,
  RestorePointResult,
  DriverScanResult,
  DriverCleanResult,
  DriverScanProgress,
  DriverUpdateScanResult,
  DriverUpdateInstallResult,
  DriverUpdateProgress,
  PerfSystemInfo,
  PerfSnapshot,
  PerfProcessList,
  PerfKillResult,
  DiskSmartInfo,
  UpdateStatus,
  ServiceScanResult,
  ServiceApplyResult,
  ServiceScanProgress,
  UninstallerListResult,
  UninstallProgress,
  UninstallResult,
  UpdateCheckResult,
  UpdateProgress,
  UpdateResult,
  FileTypeInfo,
  CloudActionEntry,
  ThreatSnapshot,
  DuplicateScanOptions,
  DuplicateScanResult,
  DuplicateScanProgress,
  DuplicateDeleteMode,
  DuplicateDeleteResult,
  ShredderEntry,
  ShredderProgress,
  ShredderResult,
  LargeFileScanOptions,
  LargeFileScanResult,
  LargeFileScanProgress,
  LargeFileDeleteMode,
  LargeFileDeleteResult,
  EmptyFolderScanOptions,
  EmptyFolderScanResult,
  EmptyFolderScanProgress,
  EmptyFolderDeleteResult,
  GameModeConfig,
  GameModeActivateResult,
  GameModeDeactivateResult,
  GameModeStatus,
  GameModeProgress,
  CvePageResult,
  StartupSafetyResult,
  BreachMonitorResult,
  BreachAcknowledgeResult,
} from '../shared/types'

const api = {
  // Platform
  platformInfo: (): Promise<PlatformInfo> => ipcRenderer.invoke(IPC.PLATFORM_INFO),

  // Window controls
  windowMinimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.send(IPC.WINDOW_CLOSE),

  // System cleaner
  systemScan: (): Promise<ScanResult[]> => ipcRenderer.invoke(IPC.SYSTEM_SCAN),
  systemClean: (itemIds: string[]): Promise<CleanResult> =>
    ipcRenderer.invoke(IPC.SYSTEM_CLEAN, itemIds),

  // Browser cleaner
  browserScan: (): Promise<ScanResult[]> => ipcRenderer.invoke(IPC.BROWSER_SCAN),
  browserClean: (itemIds: string[]): Promise<CleanResult> =>
    ipcRenderer.invoke(IPC.BROWSER_CLEAN, itemIds),

  // App cleaner
  appScan: (): Promise<ScanResult[]> => ipcRenderer.invoke(IPC.APP_SCAN),
  appClean: (itemIds: string[]): Promise<CleanResult> =>
    ipcRenderer.invoke(IPC.APP_CLEAN, itemIds),

  // Gaming cleaner
  gamingScan: (): Promise<ScanResult[]> => ipcRenderer.invoke(IPC.GAMING_SCAN),
  gamingClean: (itemIds: string[]): Promise<CleanResult> =>
    ipcRenderer.invoke(IPC.GAMING_CLEAN, itemIds),

  // Database optimizer
  databaseScan: (): Promise<ScanResult[]> => ipcRenderer.invoke(IPC.DATABASE_SCAN),
  databaseClean: (itemIds: string[]): Promise<CleanResult> =>
    ipcRenderer.invoke(IPC.DATABASE_CLEAN, itemIds),

  // Uninstall leftovers
  uninstallLeftoversScan: (): Promise<ScanResult[]> => ipcRenderer.invoke(IPC.UNINSTALL_LEFTOVERS_SCAN),
  uninstallLeftoversClean: (itemIds: string[]): Promise<CleanResult> =>
    ipcRenderer.invoke(IPC.UNINSTALL_LEFTOVERS_CLEAN, itemIds),

  // Recycle bin
  recycleBinScan: (): Promise<ScanResult[]> => ipcRenderer.invoke(IPC.RECYCLE_BIN_SCAN),
  recycleBinClean: (): Promise<CleanResult> => ipcRenderer.invoke(IPC.RECYCLE_BIN_CLEAN),

  // Shortcut cleaner
  shortcutScan: (): Promise<ScanResult[]> => ipcRenderer.invoke(IPC.SHORTCUT_SCAN),
  shortcutClean: (itemIds: string[]): Promise<CleanResult> =>
    ipcRenderer.invoke(IPC.SHORTCUT_CLEAN, itemIds),

  // Registry
  registryScan: (): Promise<RegistryEntry[]> => ipcRenderer.invoke(IPC.REGISTRY_SCAN),
  registryFix: (entryIds: string[]): Promise<{ fixed: number; failed: number; failures: { issue: string; reason: string }[] }> =>
    ipcRenderer.invoke(IPC.REGISTRY_FIX, entryIds),

  // Debloater
  debloaterScan: (): Promise<BloatwareApp[]> => ipcRenderer.invoke(IPC.DEBLOATER_SCAN),
  debloaterRemove: (packageNames: string[]): Promise<{ removed: number; failed: number }> =>
    ipcRenderer.invoke(IPC.DEBLOATER_REMOVE, packageNames),
  onDebloaterRemoveProgress: (callback: (data: { current: number; total: number; currentApp: string; status: 'removing' | 'done' | 'failed' }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { current: number; total: number; currentApp: string; status: 'removing' | 'done' | 'failed' }) => callback(data)
    ipcRenderer.on(IPC.DEBLOATER_REMOVE_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.DEBLOATER_REMOVE_PROGRESS, handler) }
  },

  // Startup manager
  startupList: (): Promise<StartupItem[]> => ipcRenderer.invoke(IPC.STARTUP_LIST),
  startupToggle: (name: string, location: string, command: string, source: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.STARTUP_TOGGLE, name, location, command, source, enabled),
  startupDelete: (name: string, location: string, source: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.STARTUP_DELETE, name, location, source),
  startupBootTrace: (): Promise<StartupBootTrace> => ipcRenderer.invoke(IPC.STARTUP_BOOT_TRACE),
  startupSafetyFetch: (): Promise<StartupSafetyResult> => ipcRenderer.invoke(IPC.STARTUP_SAFETY_FETCH),
  onStartupSafetyUpdated: (callback: (data: StartupSafetyResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: StartupSafetyResult) => callback(data)
    ipcRenderer.on(IPC.STARTUP_SAFETY_UPDATED, handler)
    return () => { ipcRenderer.removeListener(IPC.STARTUP_SAFETY_UPDATED, handler) }
  },

  // Network cleanup
  networkScan: (): Promise<NetworkItem[]> => ipcRenderer.invoke(IPC.NETWORK_SCAN),
  networkClean: (itemIds: string[]): Promise<NetworkCleanResult> =>
    ipcRenderer.invoke(IPC.NETWORK_CLEAN, itemIds),

  // Disk analyzer
  diskAnalyze: (driveLetter: string): Promise<DiskNode> =>
    ipcRenderer.invoke(IPC.DISK_ANALYZE, driveLetter),
  diskDrives: (): Promise<DriveInfo[]> => ipcRenderer.invoke(IPC.DISK_DRIVES),
  diskFileTypes: (driveLetter: string): Promise<FileTypeInfo[]> =>
    ipcRenderer.invoke(IPC.DISK_FILE_TYPES, driveLetter),

  // Disk repair
  diskRepairSfc: (drive: string): Promise<DiskRepairResult> =>
    ipcRenderer.invoke(IPC.DISK_REPAIR_SFC, drive),
  diskRepairDism: (): Promise<DiskRepairResult> =>
    ipcRenderer.invoke(IPC.DISK_REPAIR_DISM),
  onDiskRepairProgress: (callback: (data: DiskRepairProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DiskRepairProgress) => callback(data)
    ipcRenderer.on(IPC.DISK_REPAIR_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.DISK_REPAIR_PROGRESS, handler) }
  },

  // Onboarding
  onboardingGet: (): Promise<boolean> => ipcRenderer.invoke(IPC.ONBOARDING_GET),
  onboardingSet: (value: boolean): Promise<void> => ipcRenderer.invoke(IPC.ONBOARDING_SET, value),

  // Settings
  settingsGet: (): Promise<KuduSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  settingsSet: (settings: Partial<KuduSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, settings),

  // Elevation
  elevationCheck: (): Promise<boolean> => ipcRenderer.invoke(IPC.ELEVATION_CHECK),
  elevationRelaunch: (): Promise<void> => ipcRenderer.invoke(IPC.ELEVATION_RELAUNCH),

  // System Restore Point
  createRestorePoint: (description: string): Promise<RestorePointResult> =>
    ipcRenderer.invoke(IPC.RESTORE_POINT_CREATE, description),

  // Scheduled scans (legacy)
  scheduleNextScan: (): Promise<string | null> => ipcRenderer.invoke(IPC.SCHEDULE_NEXT_SCAN),
  applyStartup: (enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.SETTINGS_APPLY_STARTUP, enabled),
  applyTray: (enabled: boolean) => ipcRenderer.send(IPC.SETTINGS_APPLY_TRAY, enabled),
  onScheduledScanTrigger: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.SCHEDULE_SCAN_TRIGGER, handler)
    return () => { ipcRenderer.removeListener(IPC.SCHEDULE_SCAN_TRIGGER, handler) }
  },
  notifyScheduledScanComplete: (totalSize: number, itemCount: number) =>
    ipcRenderer.send(IPC.SCHEDULE_SCAN_COMPLETE, totalSize, itemCount),

  // Multi-schedule
  onScheduleRunTrigger: (callback: (data: { scheduleId: string; scheduleName: string; tasks: string[]; autoApply: boolean }) => void) => {
    const handler = (_event: any, data: any) => callback(data)
    ipcRenderer.on(IPC.SCHEDULE_RUN_TRIGGER, handler)
    return () => { ipcRenderer.removeListener(IPC.SCHEDULE_RUN_TRIGGER, handler) }
  },
  scheduleRunComplete: (scheduleId: string, status: string) =>
    ipcRenderer.send(IPC.SCHEDULE_RUN_COMPLETE, scheduleId, status),

  // Scan history
  historyGet: (): Promise<ScanHistoryEntry[]> => ipcRenderer.invoke(IPC.HISTORY_GET),
  historyAdd: (entry: ScanHistoryEntry): Promise<void> => ipcRenderer.invoke(IPC.HISTORY_ADD, entry),
  historyClear: (): Promise<void> => ipcRenderer.invoke(IPC.HISTORY_CLEAR),

  // Cloud action history
  cloudHistoryGet: (): Promise<CloudActionEntry[]> => ipcRenderer.invoke(IPC.CLOUD_HISTORY_GET),
  cloudHistoryClear: (): Promise<void> => ipcRenderer.invoke(IPC.CLOUD_HISTORY_CLEAR),

  // History push events
  onHistoryChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.HISTORY_CHANGED, handler)
    return () => { ipcRenderer.removeListener(IPC.HISTORY_CHANGED, handler) }
  },
  onCloudHistoryChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.CLOUD_HISTORY_CHANGED, handler)
    return () => { ipcRenderer.removeListener(IPC.CLOUD_HISTORY_CHANGED, handler) }
  },

  // Privacy Shield
  privacyScan: (): Promise<PrivacyShieldState> => ipcRenderer.invoke(IPC.PRIVACY_SCAN),
  privacyApply: (ids: string[]): Promise<PrivacyApplyResult> =>
    ipcRenderer.invoke(IPC.PRIVACY_APPLY, ids),
  privacyRevert: (ids: string[]): Promise<PrivacyApplyResult> =>
    ipcRenderer.invoke(IPC.PRIVACY_REVERT, ids),
  onPrivacyProgress: (callback: (data: PrivacyScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: PrivacyScanProgress) => callback(data)
    ipcRenderer.on(IPC.PRIVACY_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.PRIVACY_PROGRESS, handler) }
  },

  // Malware scanner
  malwareScan: (): Promise<MalwareScanResult> => ipcRenderer.invoke(IPC.MALWARE_SCAN),
  malwareQuarantine: (paths: string[]): Promise<MalwareActionResult> =>
    ipcRenderer.invoke(IPC.MALWARE_QUARANTINE, paths),
  malwareDelete: (paths: string[]): Promise<MalwareActionResult> =>
    ipcRenderer.invoke(IPC.MALWARE_DELETE, paths),
  malwareRestore: (quarantinedPath: string, originalPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.MALWARE_RESTORE, quarantinedPath, originalPath),
  malwareQuarantineList: (): Promise<import('../shared/types').QuarantinedItem[]> =>
    ipcRenderer.invoke(IPC.MALWARE_QUARANTINE_LIST),
  onMalwareProgress: (callback: (data: MalwareScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: MalwareScanProgress) => callback(data)
    ipcRenderer.on(IPC.MALWARE_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.MALWARE_PROGRESS, handler) }
  },

  // Driver Manager
  driverScan: (): Promise<DriverScanResult> => ipcRenderer.invoke(IPC.DRIVER_SCAN),
  driverClean: (publishedNames: string[]): Promise<DriverCleanResult> =>
    ipcRenderer.invoke(IPC.DRIVER_CLEAN, publishedNames),
  onDriverProgress: (callback: (data: DriverScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DriverScanProgress) => callback(data)
    ipcRenderer.on(IPC.DRIVER_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.DRIVER_PROGRESS, handler) }
  },

  // Driver Updates
  driverUpdateScan: (): Promise<DriverUpdateScanResult> => ipcRenderer.invoke(IPC.DRIVER_UPDATE_SCAN),
  driverUpdateInstall: (updateIds: string[]): Promise<DriverUpdateInstallResult> =>
    ipcRenderer.invoke(IPC.DRIVER_UPDATE_INSTALL, updateIds),
  onDriverUpdateProgress: (callback: (data: DriverUpdateProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DriverUpdateProgress) => callback(data)
    ipcRenderer.on(IPC.DRIVER_UPDATE_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.DRIVER_UPDATE_PROGRESS, handler) }
  },

  // Performance Monitor
  perfQuickStats: (): Promise<import('../shared/types').PerfQuickStats> => ipcRenderer.invoke(IPC.PERF_QUICK_STATS),
  perfGetSystemInfo: (): Promise<PerfSystemInfo> => ipcRenderer.invoke(IPC.PERF_GET_SYSTEM_INFO),
  perfStartMonitoring: (): Promise<void> => ipcRenderer.invoke(IPC.PERF_START_MONITORING),
  perfStopMonitoring: (): Promise<void> => ipcRenderer.invoke(IPC.PERF_STOP_MONITORING),
  perfKillProcess: (pid: number): Promise<PerfKillResult> =>
    ipcRenderer.invoke(IPC.PERF_KILL_PROCESS, pid),
  perfGetDiskHealth: (): Promise<DiskSmartInfo[]> =>
    ipcRenderer.invoke(IPC.PERF_DISK_HEALTH),
  onPerfSnapshot: (callback: (data: PerfSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: PerfSnapshot) => callback(data)
    ipcRenderer.on(IPC.PERF_SNAPSHOT, handler)
    return () => { ipcRenderer.removeListener(IPC.PERF_SNAPSHOT, handler) }
  },
  onPerfProcessList: (callback: (data: PerfProcessList) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: PerfProcessList) => callback(data)
    ipcRenderer.on(IPC.PERF_PROCESS_LIST, handler)
    return () => { ipcRenderer.removeListener(IPC.PERF_PROCESS_LIST, handler) }
  },

  // Auto-updater
  updaterCheck: (): Promise<void> => ipcRenderer.invoke(IPC.UPDATER_CHECK),
  updaterDownload: (): Promise<void> => ipcRenderer.invoke(IPC.UPDATER_DOWNLOAD),
  updaterInstall: (): Promise<void> => ipcRenderer.invoke(IPC.UPDATER_INSTALL),
  updaterGetStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.UPDATER_GET_STATUS),
  onUpdaterStatus: (callback: (data: UpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: UpdateStatus) => callback(data)
    ipcRenderer.on(IPC.UPDATER_STATUS, handler)
    return () => { ipcRenderer.removeListener(IPC.UPDATER_STATUS, handler) }
  },

  // Service Manager
  serviceScan: (): Promise<ServiceScanResult> => ipcRenderer.invoke(IPC.SERVICE_SCAN),
  serviceApply: (
    changes: { name: string; targetStartType: string }[],
    force?: boolean
  ): Promise<ServiceApplyResult> => ipcRenderer.invoke(IPC.SERVICE_APPLY, changes, force),
  onServiceProgress: (callback: (data: ServiceScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ServiceScanProgress) => callback(data)
    ipcRenderer.on(IPC.SERVICE_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.SERVICE_PROGRESS, handler) }
  },

  // Program Uninstaller
  uninstallerList: (): Promise<UninstallerListResult> => ipcRenderer.invoke(IPC.UNINSTALLER_LIST),
  uninstallerUninstall: (programId: string): Promise<UninstallResult> =>
    ipcRenderer.invoke(IPC.UNINSTALLER_UNINSTALL, programId),
  uninstallerForceRemove: (programId: string): Promise<UninstallResult> =>
    ipcRenderer.invoke(IPC.UNINSTALLER_FORCE_REMOVE, programId),
  onUninstallerProgress: (callback: (data: UninstallProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: UninstallProgress) => callback(data)
    ipcRenderer.on(IPC.UNINSTALLER_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.UNINSTALLER_PROGRESS, handler) }
  },
  programSafetyFetch: (): Promise<StartupSafetyResult> => ipcRenderer.invoke(IPC.PROGRAM_SAFETY_FETCH),
  onProgramSafetyUpdated: (callback: (data: StartupSafetyResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: StartupSafetyResult) => callback(data)
    ipcRenderer.on(IPC.PROGRAM_SAFETY_UPDATED, handler)
    return () => { ipcRenderer.removeListener(IPC.PROGRAM_SAFETY_UPDATED, handler) }
  },

  // Software Updater
  softwareUpdateCheck: (): Promise<UpdateCheckResult> =>
    ipcRenderer.invoke(IPC.SOFTWARE_UPDATE_CHECK),
  softwareUpdateRun: (appIds: string[]): Promise<UpdateResult> =>
    ipcRenderer.invoke(IPC.SOFTWARE_UPDATE_RUN, appIds),
  onSoftwareUpdateProgress: (callback: (data: UpdateProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: UpdateProgress) => callback(data)
    ipcRenderer.on(IPC.SOFTWARE_UPDATE_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.SOFTWARE_UPDATE_PROGRESS, handler) }
  },

  // Cloud Agent
  cloudLink: (apiKey: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.CLOUD_LINK, apiKey),
  cloudUnlink: (): Promise<void> => ipcRenderer.invoke(IPC.CLOUD_UNLINK),
  cloudReconnect: (): Promise<void> => ipcRenderer.invoke(IPC.CLOUD_RECONNECT),
  cloudGetStatus: (): Promise<{
    status: string
    maskedApiKey: string | null
    deviceId: string | null
    linkedAt: string | null
    lastTelemetryAt: string | null
    lastHealthReportAt: string | null
    lastCommandAt: string | null
    error: string | null
    threatBlacklist: { version: string; updatedAt: string; domains: number; ips: number; cidrs: number } | null
  }> => ipcRenderer.invoke(IPC.CLOUD_GET_STATUS),

  // Duplicate Finder
  duplicatesSelectDir: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.DUPLICATES_SELECT_DIR),
  duplicatesScan: (options: DuplicateScanOptions): Promise<DuplicateScanResult> =>
    ipcRenderer.invoke(IPC.DUPLICATES_SCAN, options),
  duplicatesCancel: (): Promise<void> =>
    ipcRenderer.invoke(IPC.DUPLICATES_CANCEL),
  duplicatesDelete: (paths: string[], mode: DuplicateDeleteMode): Promise<DuplicateDeleteResult> =>
    ipcRenderer.invoke(IPC.DUPLICATES_DELETE, paths, mode),
  duplicatesOpenLocation: (filePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.DUPLICATES_OPEN_LOCATION, filePath),
  onDuplicatesProgress: (callback: (data: DuplicateScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DuplicateScanProgress) => callback(data)
    ipcRenderer.on(IPC.DUPLICATES_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.DUPLICATES_PROGRESS, handler) }
  },

  // Large File Finder
  largeFilesSelectDir: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.LARGE_FILES_SELECT_DIR),
  largeFilesScan: (options: LargeFileScanOptions): Promise<LargeFileScanResult> =>
    ipcRenderer.invoke(IPC.LARGE_FILES_SCAN, options),
  largeFilesCancel: (): Promise<void> =>
    ipcRenderer.invoke(IPC.LARGE_FILES_CANCEL),
  largeFilesDelete: (paths: string[], mode: LargeFileDeleteMode): Promise<LargeFileDeleteResult> =>
    ipcRenderer.invoke(IPC.LARGE_FILES_DELETE, paths, mode),
  largeFilesOpenLocation: (filePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.LARGE_FILES_OPEN_LOCATION, filePath),
  onLargeFilesProgress: (callback: (data: LargeFileScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: LargeFileScanProgress) => callback(data)
    ipcRenderer.on(IPC.LARGE_FILES_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.LARGE_FILES_PROGRESS, handler) }
  },

  // Empty Folder Cleaner
  emptyFoldersSelectDir: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.EMPTY_FOLDERS_SELECT_DIR),
  emptyFoldersScan: (options: EmptyFolderScanOptions): Promise<EmptyFolderScanResult> =>
    ipcRenderer.invoke(IPC.EMPTY_FOLDERS_SCAN, options),
  emptyFoldersCancel: (): Promise<void> =>
    ipcRenderer.invoke(IPC.EMPTY_FOLDERS_CANCEL),
  emptyFoldersDelete: (paths: string[], mode: string): Promise<EmptyFolderDeleteResult> =>
    ipcRenderer.invoke(IPC.EMPTY_FOLDERS_DELETE, paths, mode),
  emptyFoldersOpenLocation: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.EMPTY_FOLDERS_OPEN_LOCATION, folderPath),
  onEmptyFoldersProgress: (callback: (data: EmptyFolderScanProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: EmptyFolderScanProgress) => callback(data)
    ipcRenderer.on(IPC.EMPTY_FOLDERS_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.EMPTY_FOLDERS_PROGRESS, handler) }
  },

  // File Shredder
  shredderSelectFiles: (): Promise<ShredderEntry[]> =>
    ipcRenderer.invoke(IPC.SHREDDER_SELECT_FILES),
  shredderSelectFolders: (): Promise<ShredderEntry[]> =>
    ipcRenderer.invoke(IPC.SHREDDER_SELECT_FOLDERS),
  shredderShred: (paths: string[]): Promise<ShredderResult> =>
    ipcRenderer.invoke(IPC.SHREDDER_SHRED, paths),
  shredderCancel: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SHREDDER_CANCEL),
  shredderOpenLocation: (filePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SHREDDER_OPEN_LOCATION, filePath),
  onShredderProgress: (callback: (data: ShredderProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ShredderProgress) => callback(data)
    ipcRenderer.on(IPC.SHREDDER_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.SHREDDER_PROGRESS, handler) }
  },

  // Threat Monitor
  threatMonitorGetSnapshot: (): Promise<ThreatSnapshot | null> => ipcRenderer.invoke(IPC.THREAT_MONITOR_GET_SNAPSHOT),
  onThreatMonitorUpdated: (callback: (data: ThreatSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ThreatSnapshot) => callback(data)
    ipcRenderer.on(IPC.THREAT_MONITOR_UPDATED, handler)
    return () => { ipcRenderer.removeListener(IPC.THREAT_MONITOR_UPDATED, handler) }
  },

  // CVE Scanner
  cveFetch: (opts?: { page?: number; severity?: string; search?: string }): Promise<CvePageResult> =>
    ipcRenderer.invoke(IPC.CVE_FETCH, opts),
  onCveUpdated: (callback: (data: CvePageResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: CvePageResult) => callback(data)
    ipcRenderer.on(IPC.CVE_UPDATED, handler)
    return () => { ipcRenderer.removeListener(IPC.CVE_UPDATED, handler) }
  },

  // Breach Monitor
  breachMonitorFetch: (): Promise<BreachMonitorResult> =>
    ipcRenderer.invoke(IPC.BREACH_MONITOR_FETCH),
  breachMonitorAdd: (emails: string[]): Promise<BreachMonitorResult> =>
    ipcRenderer.invoke(IPC.BREACH_MONITOR_ADD, emails),
  breachMonitorRemove: (email: string): Promise<void> =>
    ipcRenderer.invoke(IPC.BREACH_MONITOR_REMOVE, email),
  breachMonitorAcknowledge: (breachIds: string[]): Promise<BreachAcknowledgeResult> =>
    ipcRenderer.invoke(IPC.BREACH_MONITOR_ACKNOWLEDGE, breachIds),

  // Progress events
  onScanProgress: (callback: (data: ProgressData) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ProgressData) => callback(data)
    ipcRenderer.on(IPC.SCAN_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.SCAN_PROGRESS, handler) }
  },
  onRegistryFixProgress: (callback: (data: { current: number; total: number; currentEntry: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { current: number; total: number; currentEntry: string }) => callback(data)
    ipcRenderer.on(IPC.REGISTRY_FIX_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.REGISTRY_FIX_PROGRESS, handler) }
  },

  // Game Mode
  gameModeActivate: (config: GameModeConfig): Promise<GameModeActivateResult> =>
    ipcRenderer.invoke(IPC.GAME_MODE_ACTIVATE, config),
  gameModeDeactivate: (): Promise<GameModeDeactivateResult> =>
    ipcRenderer.invoke(IPC.GAME_MODE_DEACTIVATE),
  gameModeStatus: (): Promise<GameModeStatus> =>
    ipcRenderer.invoke(IPC.GAME_MODE_STATUS),
  onGameModeProgress: (callback: (data: GameModeProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: GameModeProgress) => callback(data)
    ipcRenderer.on(IPC.GAME_MODE_PROGRESS, handler)
    return () => { ipcRenderer.removeListener(IPC.GAME_MODE_PROGRESS, handler) }
  }
}

export type KuduAPI = typeof api

contextBridge.exposeInMainWorld('kudu', api)
