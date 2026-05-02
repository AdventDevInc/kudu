export interface PlatformInfo {
  platform: 'win32' | 'darwin' | 'linux'
  features: {
    registry: boolean
    debloater: boolean
    drivers: boolean
    restorePoint: boolean
    bootTrace: boolean
    gameMode: boolean
    firewallAudit: boolean
    contextMenu: boolean
  }
}

export interface ScanHistoryCategory {
  name: string
  itemsFound: number
  itemsCleaned: number
  spaceSaved: number
}

export type HistoryEntryType =
  | 'cleaner'
  | 'registry'
  | 'debloater'
  | 'network'
  | 'drivers'
  | 'malware'
  | 'privacy'
  | 'startup'
  | 'services'
  | 'software-update'
  | 'cve-scan'

export interface ScanHistoryEntry {
  id: string
  type: HistoryEntryType
  timestamp: string
  duration: number
  totalItemsFound: number
  totalItemsCleaned: number
  totalItemsSkipped: number
  totalSpaceSaved: number
  categories: ScanHistoryCategory[]
  errorCount: number
  /** true when the entry was created by the scheduler rather than a manual action */
  scheduled?: boolean
  /** Name of the schedule that triggered this entry */
  scheduleName?: string
}

// ─── Cloud Action History ────────────────────────────────────
export interface CloudActionEntry {
  id: string
  commandType: string
  requestId: string
  timestamp: string
  duration: number
  success: boolean
  error?: string
  /** Brief summary of what happened, e.g. "Scanned 1,204 files" */
  summary?: string
}

export interface ScanItem {
  id: string
  path: string
  size: number
  category: string
  subcategory: string
  lastModified: number
  selected: boolean
}

export interface ScanResult {
  category: string
  subcategory: string
  group?: string
  items: ScanItem[]
  totalSize: number
  itemCount: number
}

export interface CleanResult {
  totalCleaned: number
  filesDeleted: number
  filesSkipped: number
  errors: CleanError[]
  needsElevation: boolean
}

export interface CleanError {
  path: string
  reason: string
}

export interface ProgressData {
  phase: 'scanning' | 'cleaning'
  category: string
  currentPath: string
  progress: number
  itemsFound: number
  sizeFound: number
}

export interface RegistryFixAction {
  op: 'delete-value' | 'delete-key' | 'set-value' | 'disable-task' | 'delete-task'
  key?: string        // full registry key (overrides keyPath if abbreviated)
  value?: string      // value name (overrides valueName if different)
  regType?: string    // REG_DWORD, REG_SZ
  data?: string       // value data to set
}

export interface RegistryEntry {
  id: string
  type: 'obsolete' | 'invalid' | 'orphaned' | 'broken' | 'vulnerability' | 'privacy' | 'performance' | 'network' | 'service' | 'task'
  keyPath: string
  valueName: string
  issue: string
  risk: 'low' | 'medium' | 'high'
  selected: boolean
  fix?: RegistryFixAction
}

export interface StartupItem {
  id: string
  name: string
  displayName: string
  command: string
  location: string
  source: 'registry-hkcu' | 'registry-hklm' | 'startup-folder' | 'task-scheduler'
    | 'launch-agent-user' | 'launch-agent-global' | 'login-item'
    | 'systemd-user' | 'autostart-desktop' | 'cron'
  enabled: boolean
  publisher: string
  impact: 'high' | 'medium' | 'low' | 'none'
}

export interface StartupBootEntry {
  name: string
  displayName: string
  delayMs: number
  source: StartupItem['source']
  impact: StartupItem['impact']
}

export interface StartupBootTrace {
  totalBootMs: number
  lastBootDate: string | null
  mainPathMs: number
  startupAppsMs: number
  entries: StartupBootEntry[]
  available: boolean
  needsAdmin: boolean
}

export interface StartupSafetyRating {
  name: string
  safetyScore: number
  description: string
  analyzedAt: string
}

export interface StartupSafetyResult {
  ratings: StartupSafetyRating[]
  pending: number
}

export interface DiskNode {
  name: string
  path: string
  size: number
  children?: DiskNode[]
  isFile?: boolean
}

export interface DriveInfo {
  letter: string
  label: string
  totalSize: number
  freeSpace: number
  usedSpace: number
}

export interface FileTypeInfo {
  extension: string
  totalSize: number
  fileCount: number
}

export interface AppStats {
  totalSpaceSaved: number
  totalFilesCleaned: number
  totalScans: number
  lastScanDate: string | null
  recentActivity: ActivityEntry[]
}

export interface ActivityEntry {
  id: string
  type: 'clean' | 'registry' | 'startup' | 'scan' | 'drivers' | 'network'
  message: string
  timestamp: string
  spaceSaved?: number
}

export interface BloatwareApp {
  id: string
  name: string
  packageName: string
  publisher: string
  category: 'microsoft' | 'oem' | 'gaming' | 'media' | 'communication' | 'utility'
  description: string
  size: string
  selected: boolean
}

export interface NetworkItem {
  id: string
  type: 'dns-cache' | 'wifi-profile' | 'arp-cache' | 'network-history'
  label: string
  detail: string
  selected: boolean
}

export interface NetworkCleanResult {
  cleaned: number
  failed: number
  details: string[]
}

export interface MalwareThreat {
  id: string
  path: string
  fileName: string
  size: number
  detectionName: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  source: 'defender' | 'heuristic' | 'signature'
  details: string
  selected: boolean
}

export type MalwareScanStep =
  | 'init'
  | 'discovering'
  | 'signatures'
  | 'heuristics'
  | 'scripts'
  | 'system'
  | 'persistence'
  | 'defender'
  | 'complete'

export interface MalwareCategoryProgress {
  id: MalwareScanStep
  label: string
  status: 'pending' | 'running' | 'done' | 'skipped'
  /** 0-100 within this category */
  progress: number
  threatsFound: number
  itemsScanned: number
  totalItems: number
}

export interface MalwareScanProgress {
  phase: 'scanning' | 'quarantining' | 'deleting'
  step: MalwareScanStep
  stepLabel: string
  currentPath: string
  progress: number
  threatsFound: number
  filesScanned: number
  totalFiles: number
  engine: string
  completedSteps: string[]
  /** Per-category progress for the multi-phase UI */
  categories: MalwareCategoryProgress[]
}

export interface MalwareScanResult {
  threats: MalwareThreat[]
  filesScanned: number
  duration: number
  engines: string[]
}

export interface MalwareActionResult {
  succeeded: number
  failed: number
  errors: { path: string; reason: string }[]
}

export interface QuarantinedItem {
  quarantinedPath: string
  originalPath: string
  originalFileName: string
  quarantinedAt: number
  size: number
}

export interface YaraRulesInfo {
  available: boolean
  engine: 'yara' | 'pending' | 'compiling'
  rulesLoaded: number
  version: string | null
  updatedAt: string | null
  source: 'cloud' | 'none'
  cachedRules: number
  compileProgress: { loaded: number; total: number } | null
}

// ─── Privacy Shield ──────────────────────────────────────────
export interface PrivacySetting {
  id: string
  category: 'telemetry' | 'ads' | 'search' | 'services' | 'tasks' | 'sync' | 'kernel' | 'network' | 'access' | 'ai' | 'browser'
  label: string
  description: string
  enabled: boolean          // true = privacy-friendly (tracking disabled)
  reversible: boolean       // true = can be reverted to Windows default
  requiresAdmin: boolean
  dependsOn?: string        // ID of a setting that must be enabled first
}

export interface PrivacyShieldState {
  settings: PrivacySetting[]
  score: number             // 0-100 privacy score
  total: number             // total settings count
  protected: number         // settings already privacy-friendly
}

export interface PrivacyScanProgress {
  current: number
  total: number
  currentLabel: string
  category: string
}

export interface PrivacyApplyResult {
  succeeded: number
  failed: number
  errors: { id: string; label: string; reason: string }[]
}

// ─── Driver Manager ─────────────────────────────────────────
export interface DriverPackage {
  id: string
  publishedName: string       // e.g. "oem42.inf"
  originalName: string        // e.g. "nvlddmkm.inf"
  provider: string
  className: string           // e.g. "Display adapters"
  version: string
  date: string
  signer: string
  folderPath: string          // full path in FileRepository
  size: number                // bytes
  isCurrent: boolean          // true = actively bound to hardware
  selected: boolean
}

export interface DriverScanResult {
  packages: DriverPackage[]
  totalStaleSize: number
  totalStaleCount: number
  totalCurrentCount: number
}

export interface DriverCleanResult {
  removed: number
  failed: number
  spaceRecovered: number
  errors: { publishedName: string; reason: string }[]
}

export interface DriverScanProgress {
  phase: 'enumerating' | 'analyzing' | 'measuring'
  current: number
  total: number
  currentDriver: string
}

export interface DriverUpdate {
  id: string
  updateId: string            // Windows Update Identity.UpdateID (used for install matching)
  deviceName: string
  deviceId: string
  className: string
  currentVersion: string
  currentDate: string
  availableVersion: string
  availableDate: string
  provider: string
  updateTitle: string       // Windows Update title string
  downloadSize: string      // human-readable size from WU
  selected: boolean
}

export interface DriverUpdateScanResult {
  updates: DriverUpdate[]
  totalAvailable: number
  scanDuration: number
}

export interface DriverUpdateInstallResult {
  installed: number
  failed: number
  rebootRequired: boolean
  errors: { deviceName: string; reason: string }[]
}

export interface DriverUpdateProgress {
  phase: 'checking' | 'downloading' | 'installing'
  current: number
  total: number
  currentDevice: string
  percent: number
}

export interface RestorePointResult {
  success: boolean
  error?: string
}

// ─── Performance Monitor ────────────────────────────────────
export interface PerfSystemInfo {
  cpuModel: string
  cpuCores: number
  cpuThreads: number
  totalMemBytes: number
  osVersion: string
  hostname: string
}

/** Lightweight stats for dashboard gauges — no systeminformation dependency */
export interface PerfQuickStats {
  cpuPercent: number
  memUsedBytes: number
  memTotalBytes: number
  memPercent: number
}

export interface PerfSnapshot {
  timestamp: number
  cpu: { overall: number; perCore: number[] }
  memory: { usedBytes: number; totalBytes: number; cachedBytes: number; percent: number }
  disk: { readBytesPerSec: number; writeBytesPerSec: number }
  network: { rxBytesPerSec: number; txBytesPerSec: number }
  uptime: number
}

export interface PerfProcess {
  pid: number
  name: string
  cpuPercent: number
  memBytes: number
  memPercent: number
  user: string
  started: string
  isStartupItem?: boolean
  startupItemName?: string
}

export interface PerfProcessList {
  timestamp: number
  processes: PerfProcess[]
  totalCount: number
}

export interface PerfKillResult {
  success: boolean
  error?: string
  requiresAdmin?: boolean
}

export interface DiskSmartInfo {
  device: string
  model: string
  type: 'SSD' | 'HDD' | 'NVMe' | 'Unknown'
  sizeBytes: number
  temperature: number | null
  healthStatus: 'Healthy' | 'Caution' | 'Bad' | 'Unknown'
  powerOnHours: number | null
  /** SSD/NVMe remaining life percentage (100 = new, 0 = worn out) */
  remainingLife: number | null
  readErrors: number | null
  writeErrors: number | null
  reallocatedSectors: number | null
  smartAttributes: SmartAttribute[]
}

export interface SmartAttribute {
  id: number
  name: string
  value: number
  worst: number
  thresh: number
  raw: number
}

// ─── Auto-Updater ────────────────────────────────────────────
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  progress?: number
  error?: string
}

// ─── Program Uninstaller ────────────────────────────────────
export interface InstalledProgram {
  id: string
  displayName: string
  publisher: string
  displayVersion: string
  installDate: string
  estimatedSize: number
  installLocation: string
  uninstallString: string
  quietUninstallString: string
  displayIcon: string
  registryKey: string
  isSystemComponent: boolean
  isWindowsInstaller: boolean
  lastUsed: number              // timestamp ms, 0 = unknown/never seen in Prefetch
}

export interface UninstallerListResult {
  programs: InstalledProgram[]
  totalCount: number
}

export interface UninstallProgress {
  phase: 'listing' | 'uninstalling' | 'scanning-leftovers' | 'cleaning-leftovers' | 'force-removing'
  currentProgram: string
  progress: number
  detail: string
}

export interface UninstallResult {
  success: boolean
  programName: string
  exitCode: number | null
  error?: string
  leftoversFound: number
  leftoversCleaned: number
  leftoversSize: number
}

// ─── Schedules ────────────────────────────────────────────
export type ScheduleTaskType =
  | 'cleaner:system'
  | 'cleaner:browsers'
  | 'cleaner:apps'
  | 'cleaner:gaming'
  | 'cleaner:recycleBin'
  | 'cleaner:databases'
  | 'registry'
  | 'drivers'
  | 'software-update'
  | 'cve-scan'

export type ScheduleRunStatus = 'success' | 'partial' | 'failed' | 'never'

export interface ScheduleEntry {
  id: string
  name: string
  enabled: boolean
  frequency: 'daily' | 'weekly' | 'monthly'
  day: number
  hour: number
  /** Minute of the hour (0-59). Defaults to 0 for backward compatibility. */
  minute?: number
  tasks: ScheduleTaskType[]
  autoApply: boolean
  lastRunAt: string | null
  lastRunStatus: ScheduleRunStatus
  createdAt: string
}

export interface KuduSettings {
  theme: 'dark' | 'light' | 'system'
  language: string
  minimizeToTray: boolean
  showNotificationOnComplete: boolean
  showThreatNotifications: boolean
  runAtStartup: boolean
  autoUpdate: boolean
  /** Automatically restart the app to apply downloaded updates */
  autoRestart: boolean
  /** How often (in hours) to check for updates in the background */
  updateCheckIntervalHours: number
  cleaner: {
    skipRecentMinutes: number
    secureDelete: boolean
    closeBrowsersBeforeClean: boolean
    createRestorePoint: boolean
    protectRecycleBin: boolean
  }
  exclusions: string[]
  ignoredSoftwareUpdates: string[]
  schedule: {
    enabled: boolean
    frequency: 'daily' | 'weekly' | 'monthly'
    day: number
    hour: number
  }
  schedules: ScheduleEntry[]
  cloud: {
    apiKey: string
    telemetryIntervalSec: number
    shareDiskHealth: boolean
    shareProcessList: boolean
    shareThreatMonitor: boolean
    allowRemotePower: boolean
    allowRemoteCleanup: boolean
    allowRemoteInstalls: boolean
    allowRemoteConfig: boolean
  }
  /** Preferred Windows package manager for Software Updater */
  windowsPackageManager: 'winget' | 'choco'
  gameMode: GameModeConfig
}

// ─── Game Mode ──────────────────────────────────────────────

export type GameModeOptimizationId =
  | 'svc-wsearch'
  | 'svc-sysmain'
  | 'svc-wuauserv'
  | 'svc-spooler'
  | 'svc-diagtrack'
  | 'proc-kill-browsers'
  | 'proc-kill-chat'
  | 'proc-kill-updaters'
  | 'proc-kill-custom'
  | 'mem-clear-standby'
  | 'sys-focus-assist'
  | 'sys-power-plan'
  | 'sys-prevent-sleep'
  | 'sys-disable-game-bar'
  | 'sys-disable-fse-opt'
  | 'sys-disable-transparency'
  | 'net-flush-dns'
  | 'net-disable-nagle'

export type GameModeCategory = 'services' | 'processes' | 'memory' | 'system' | 'network'

export interface GameModeConfig {
  enabledOptimizations: GameModeOptimizationId[]
  customProcessKillList: string[]
  /** Automatically activate Game Mode when a game process is detected */
  autoDetect: boolean
  /** Automatically deactivate Game Mode when the detected game exits */
  autoDeactivate: boolean
  /** User-specified game executable names to watch for (e.g. "mygame.exe") */
  customGameProcesses: string[]
}

export interface GameModeSnapshot {
  activatedAt: string
  // True while Game Mode is actively applied. Set to false when deactivation
  // runs but leaves unrestored items — the snapshot is kept so the user can
  // retry restoration without losing the captured pre-Game-Mode state.
  active: boolean
  services: Array<{ name: string; originalStartType: string; wasRunning: boolean }>
  killedProcesses: Array<{ pid: number; name: string }>
  originalPowerPlanGuid: string | null
  originalFocusAssistState: number | null
  powerSaveBlockerId: number | null
  nagleInterfaces: Array<{ path: string; originalTcpNoDelay: number | null; originalTcpAckFrequency: number | null }>
  registryTweaks: Array<{ path: string; name: string; originalValue: number | null }>
}

export interface GameModeActivateResult {
  succeeded: number
  failed: number
  errors: Array<{ optimizationId: string; reason: string }>
  snapshot: GameModeSnapshot | null
}

export interface GameModeDeactivateResult {
  restored: number
  failed: number
  errors: Array<{ optimizationId: string; reason: string }>
}

export interface GameModeProgress {
  phase: 'activating' | 'deactivating'
  current: number
  total: number
  currentLabel: string
}

export interface GameModeStatus {
  active: boolean
  activatedAt: string | null
  /** True when a previous deactivation left items unrestored. The toggle is
   * not "on", but a cleanup retry is available. */
  pendingRestore: boolean
}

// ─── Service Manager ────────────────────────────────────────
export type ServiceStatus =
  | 'Running'
  | 'Stopped'
  | 'StartPending'
  | 'StopPending'
  | 'Paused'
  | 'Unknown'

export type ServiceStartType =
  | 'Automatic'
  | 'AutomaticDelayed'
  | 'Manual'
  | 'Disabled'
  | 'Boot'
  | 'System'

export type ServiceSafety = 'safe' | 'caution' | 'unsafe'

export type ServiceCategory =
  | 'telemetry'
  | 'xbox'
  | 'print'
  | 'fax'
  | 'media'
  | 'network'
  | 'bluetooth'
  | 'remote'
  | 'hyper-v'
  | 'developer'
  | 'misc'
  | 'core'
  | 'security'
  | 'unknown'

export interface WindowsService {
  name: string
  displayName: string
  description: string
  status: ServiceStatus
  startType: ServiceStartType
  safety: ServiceSafety
  category: ServiceCategory
  isMicrosoft: boolean
  dependsOn: string[]
  dependents: string[]
  selected: boolean
  originalStartType: ServiceStartType
}

export interface ServiceScanResult {
  services: WindowsService[]
  totalCount: number
  runningCount: number
  disabledCount: number
  safeToDisableCount: number
}

export interface ServiceApplyResult {
  succeeded: number
  failed: number
  errors: { name: string; displayName: string; reason: string }[]
}

export interface ServiceScanProgress {
  phase: 'enumerating' | 'classifying'
  current: number
  total: number
  currentService: string
}

// ─── Firewall Audit (Windows-only) ──────────────────────────
export type FirewallProfile = 'Domain' | 'Private' | 'Public' | 'Any'
export type FirewallSignatureStatus = 'signed' | 'unsigned' | 'unknown' | 'not-applicable'
export type FirewallIssue = 'stale' | 'unsigned' | 'broad-scope' | 'any-remote'
export type FirewallRiskLevel = 'high' | 'medium' | 'low'

export interface FirewallRule {
  // Internal name (used as -Name when disabling/removing). Unique per rule.
  name: string
  displayName: string
  description: string
  group: string
  profiles: FirewallProfile[]
  protocol: string
  localPort: string
  remoteAddress: string
  // Raw program path as Windows stores it (may contain %SystemRoot% etc.)
  program: string
  // Expanded/resolved absolute path. Empty if rule has no program filter.
  programResolved: string
  programExists: boolean
  signature: FirewallSignatureStatus
  // Microsoft-shipped rule: program lives under Windows/Program Files OR the
  // description is an MUI resource reference (e.g. "@FirewallAPI.dll,-25000").
  // We suppress broad-scope/any-remote findings on these — they're default
  // system rules and removing them tends to break Windows features.
  builtin: boolean
  enabled: boolean
  issues: FirewallIssue[]
  risk: FirewallRiskLevel
  selected: boolean
}

export interface FirewallScanResult {
  rules: FirewallRule[]
  totalCount: number
  staleCount: number
  unsignedCount: number
  broadScopeCount: number
}

export interface FirewallApplyResult {
  succeeded: number
  failed: number
  errors: { name: string; displayName: string; reason: string }[]
}

export interface FirewallScanProgress {
  phase: 'enumerating' | 'classifying' | 'verifying'
  current: number
  total: number
  currentRule: string
}

export type FirewallAction = 'disable' | 'delete'

// ─── Software Updater ──────────────────────────────────────
export type UpdateSeverity = 'major' | 'minor' | 'patch' | 'unknown'

export interface UpdatableApp {
  id: string
  name: string
  currentVersion: string
  availableVersion: string
  source: string
  severity: UpdateSeverity
  selected: boolean
}

export interface UpToDateApp {
  id: string
  name: string
  version: string
  source: string
}

export interface UpdateCheckResult {
  apps: UpdatableApp[]
  upToDate: UpToDateApp[]
  totalCount: number
  majorCount: number
  minorCount: number
  patchCount: number
  packageManagerAvailable: boolean
  packageManagerName: 'winget' | 'brew' | 'apt' | 'dnf' | 'pacman' | 'choco' | null
}

export interface UpdateProgress {
  phase: 'checking' | 'updating'
  current: number
  total: number
  currentApp: string
  percent: number
  status: 'in-progress' | 'done' | 'failed'
}

export interface UpdateResult {
  succeeded: number
  failed: number
  errors: { appId: string; name: string; reason: string }[]
}

// ─── Disk Repair ───────────────────────────────────────────
export interface DiskRepairProgress {
  tool: 'sfc' | 'dism' | 'chkdsk'
  phase: 'running' | 'done' | 'failed'
  percent: number
  message: string
}

export interface DiskRepairResult {
  tool: 'sfc' | 'dism' | 'chkdsk'
  success: boolean
  exitCode: number | null
  summary: string
  log: string
  requiresReboot: boolean
  needsAdmin: boolean
}

// ─── Disk Maintenance (SSD TRIM) ───────────────────────────
export type TrimMediaType = 'SSD' | 'NVMe' | 'HDD' | 'Unknown'
export type TrimSupport = 'supported' | 'disabled' | 'unsupported' | 'macos-managed'
export type TrimStatus =
  | 'recently-trimmed'
  | 'ok'
  | 'recommended'
  | 'not-applicable'
  | 'disabled'
  | 'unknown'

/**
 * One row in the Disk Maintenance UI.
 * `id` is the stable key — Windows: drive letter ('C'); Linux: mountpoint; macOS: BSD name.
 */
export interface TrimDriveInfo {
  id: string
  letter?: string
  mountPoint?: string
  label: string
  totalSize: number
  freeSpace: number
  mediaType: TrimMediaType
  busType?: string
  filesystem?: string
  isRemovable: boolean
  isEncrypted: boolean
  trimSupport: TrimSupport
  status: TrimStatus
  statusReason: string
  lastTrimAt: number | null
  estimatedDiscardBytes?: number
}

export interface TrimRunResult {
  driveId: string
  success: boolean
  needsAdmin?: boolean
  throttled?: boolean
  bytesDiscarded?: number
  durationMs: number
  exitCode: number | null
  summary: string
  log: string
  timestamp: number
}

export interface TrimProgress {
  driveId: string
  phase: 'starting' | 'running' | 'done' | 'failed'
  /** -1 = indeterminate (Windows Optimize-Volume doesn't report clean percentages) */
  percent: number
  message: string
}

// ─── Threat Monitor ────────────────────────────────────────

export interface FlaggedConnection {
  remoteAddress: string
  remotePort: number
  pid: number | null
  matchedRule: string
  matchType: 'ip' | 'cidr'
  detectedAt: string
}

export interface FlaggedDnsEntry {
  domain: string
  resolvedAddress: string | null
  matchedRule: string
  detectedAt: string
}

export interface ThreatSnapshot {
  flaggedConnections: FlaggedConnection[]
  flaggedDns: FlaggedDnsEntry[]
  blacklistVersion: string | null
  lastConnectionScanAt: string | null
  lastDnsScanAt: string | null
}

// ─── CVE Vulnerability Scanner ────────────────────────────

export type CveSeverity = 'critical' | 'high' | 'medium' | 'low' | 'none'

export interface CveVulnerability {
  id: number
  cveId: string
  appName: string
  installedVersion: string
  severity: CveSeverity
  cvssScore: number | null
  fixedIn: string | null
  description: string | null
  firstDetectedAt: string
  lastScannedAt: string
}

/** Unfiltered severity counts (always the full picture, ignoring any active severity filter) */
export interface CveSummary {
  critical: number
  high: number
  medium: number
  low: number
}

export interface CvePageResult {
  vulnerabilities: CveVulnerability[]
  summary: CveSummary
  total: number
  nextPageUrl: string | null
  /** Total CVE entries tracked in the server database */
  librarySize: number
}

// ─── Breach Monitor ──────────────────────────────────────

export interface BreachEntry {
  name: string
  title: string
  domain: string
  breachDate: string
  dataClasses: string[]
  pwnCount: number
  isVerified: boolean
  isSensitive: boolean
  acknowledgedAt: string | null
}

export interface MonitoredEmail {
  email: string
  lastCheckedAt: string | null
  fresh: boolean
  monitoringPaused: boolean
  breaches: BreachEntry[]
}

export interface BreachMonitorResult {
  emails: MonitoredEmail[]
  limit: number
  usage: number
}

export interface BreachAcknowledgeResult {
  status: string
  acknowledged: number
}

// ─── Large File Finder ────────────────────────────────────

export interface LargeFileScanOptions {
  directory: string
  minFileSize: number
  maxDepth: number
  excludePatterns: string[]
}

export interface LargeFileEntry {
  path: string
  name: string
  size: number
  lastModified: number
  extension: string
}

export interface LargeFileScanResult {
  files: LargeFileEntry[]
  totalFilesScanned: number
  duration: number
  cancelled: boolean
}

export interface LargeFileScanProgress {
  currentPath: string
  filesScanned: number
  largeFilesFound: number
  progress: number
}

export type LargeFileDeleteMode = 'recycle' | 'permanent'

export interface LargeFileDeleteResult {
  deleted: number
  failed: number
  spaceRecovered: number
  errors: { path: string; reason: string }[]
}

// ─── Empty Folder Cleaner ─────────────────────────────────

export interface EmptyFolderScanOptions {
  directory: string
  maxDepth: number
  excludePatterns: string[]
}

export interface EmptyFolderEntry {
  path: string
  name: string
  depth: number
}

export interface EmptyFolderScanResult {
  folders: EmptyFolderEntry[]
  totalFoldersScanned: number
  duration: number
  cancelled: boolean
}

export interface EmptyFolderScanProgress {
  currentPath: string
  foldersScanned: number
  emptyFound: number
  progress: number
}

export type EmptyFolderDeleteMode = 'recycle' | 'permanent'

export interface EmptyFolderDeleteResult {
  deleted: number
  failed: number
  errors: { path: string; reason: string }[]
}

// ─── File Shredder ───────────────────────────────────────

export interface ShredderEntry {
  path: string
  name: string
  size: number
  isDirectory: boolean
}

export interface ShredderProgress {
  currentPath: string
  filesShredded: number
  totalFiles: number
  bytesShredded: number
  totalBytes: number
  progress: number
}

export interface ShredderResult {
  shredded: number
  failed: number
  bytesShredded: number
  duration: number
  errors: { path: string; reason: string }[]
  cancelled: boolean
}

// ─── Duplicate Finder ─────────────────────────────────────

export interface DuplicateScanOptions {
  directory: string
  minFileSize: number
  maxFileSize: number | null
  excludePatterns: string[]
  extensionFilter: string[]
  maxDepth: number
}

export interface DuplicateFile {
  path: string
  size: number
  lastModified: number
}

export interface DuplicateGroup {
  hash: string
  fullHash: string
  fileSize: number
  files: DuplicateFile[]
  reclaimableSpace: number
}

export interface DuplicateScanResult {
  groups: DuplicateGroup[]
  totalDuplicates: number
  totalReclaimable: number
  totalFilesScanned: number
  duration: number
  cancelled: boolean
}

export type DuplicateScanPhase = 'walking' | 'grouping' | 'partial-hash' | 'full-hash' | 'complete'

export interface DuplicateScanProgress {
  phase: DuplicateScanPhase
  currentPath: string
  filesScanned: number
  duplicatesFound: number
  reclaimableSpace: number
  progress: number
  filesToHash?: number
  filesHashed?: number
}

export type DuplicateDeleteMode = 'recycle' | 'permanent'

export interface DuplicateDeleteResult {
  deleted: number
  failed: number
  spaceRecovered: number
  errors: { path: string; reason: string }[]
}

// ─── Context Menu Cleaner ──────────────────────────────────────────────

export type ContextMenuEntryKind = 'verb' | 'handler'

export type ContextMenuScope =
  | 'AllFiles'
  | 'Directory'
  | 'DirectoryBackground'
  | 'Folder'
  | 'Drive'
  | 'AllFilesystemObjects'
  | 'ProgID'

export type ContextMenuHive = 'HKCR' | 'HKCU'

export type ContextMenuSource =
  | '7-Zip'
  | 'WinRAR'
  | 'OneDrive'
  | 'Notepad++'
  | 'VSCode'
  | 'Defender'
  | 'Git'
  | 'Dropbox'
  | 'Google Drive'
  | 'PowerToys'
  | 'Microsoft'
  | 'Windows'
  | 'Unknown'

export type ContextMenuStatus = 'enabled' | 'disabled'

export type ContextMenuAction = 'disable' | 'enable' | 'delete'

export interface ContextMenuEntry {
  id: string
  kind: ContextMenuEntryKind
  keyPath: string
  name: string
  displayName: string
  scope: ContextMenuScope
  hive: ContextMenuHive
  clsid: string | null
  dllPath: string | null
  command: string | null
  source: ContextMenuSource
  status: ContextMenuStatus
  protected: boolean
  requiresAdmin: boolean
  selected: boolean
}

export interface ContextMenuScanResult {
  entries: ContextMenuEntry[]
  scanDuration: number
  scanned: number
}

export interface ContextMenuApplyRequest {
  entryId: string
  action: ContextMenuAction
}

export interface ContextMenuApplyResult {
  succeeded: number
  failed: number
  errors: { entryId: string; displayName: string; reason: string }[]
  updates: { entryId: string; status: ContextMenuStatus }[]
}

export interface ContextMenuApplyProgress {
  current: number
  total: number
  currentLabel: string
}
