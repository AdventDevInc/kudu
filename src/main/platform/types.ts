// ─── Platform Abstraction Layer ──────────────────────────────
// Each platform (win32, darwin, linux) implements these interfaces.
// Consumers call getPlatform() to get the active provider.

import type {
  ManagedCleanupAction,
  StartupItem,
  StartupBootTrace,
  PrivacySetting,
  PrivacyShieldState,
  PrivacyApplyResult,
  ServiceScanResult,
  ServiceApplyResult,
  ServiceScanProgress,
} from '../../shared/types'
import type { HealthReport } from '../services/cloud-agent-types'

// ─── Paths ─────────────────────────────────────────────────

export interface CleanTarget {
  cacheReset?: boolean
  cleanupAction?: ManagedCleanupAction
  path: string
  subcategory: string
  needsAdmin?: boolean
  /** If set, scan path/&ast;/childSubdir instead of path directly (e.g. 'cache' for Flatpak) */
  childSubdir?: string
  /** Inspect descendant timestamps and revalidate them immediately before deletion. */
  deepRecencyCheck?: boolean
}

export interface BrowserPathConfig {
  chrome: BrowserPaths
  edge: BrowserPaths
  brave: BrowserPaths
  opera: BrowserPaths
  operaGX: BrowserPaths
  vivaldi: BrowserPaths
  arc: BrowserPaths
  chromium: BrowserPaths
  thorium: BrowserPaths
  supermium: BrowserPaths
  helium: BrowserPaths
  cromite: BrowserPaths
  catsxp: BrowserPaths
  firefox: { base: string; cache: string }
  librewolf: { base: string; cache: string }
  waterfox: { base: string; cache: string }
  floorp: { base: string; cache: string }
  zen: { base: string; cache: string }
  safari: { cache: string } | null
}

export interface ChromiumCacheDir {
  /** Directory relative to the profile, or to `base` for shared entries */
  dir: string
  /** Display label appended to the browser (and profile) name */
  label: string
}

export interface BrowserPaths {
  base: string
  /** Cache directories inside each profile (Default, Profile 1, …) */
  profileCaches: ChromiumCacheDir[]
  /** Cache directories shared by every profile, directly under `base` */
  sharedCaches: ChromiumCacheDir[]
}

export interface AppCacheDef {
  cacheReset?: boolean
  cleanupAction?: ManagedCleanupAction
  id: string
  name: string
  paths: string[]
  /** Optional UI section for related cleaner rules (for example, AI Tools). */
  group?: string
  /** Only offer entries older than this many days, inspecting nested contents before deleting a directory. */
  minAgeDays?: number
  /** If set, scan paths/&ast;/childSubdir instead of paths directly (e.g. 'caches' for JetBrains on Windows) */
  childSubdir?: string
  /**
   * Recursively find exact cache directory names, but only after entering the
   * named anchor directory. This supports layouts such as
   * App/&ast;/EBWebView/&ast;/Cache without exposing session or user-data folders.
   */
  recursiveMatch?: RecursivePathMatch
  /** Match a small allowlist of direct files, optionally inside immediate child directories. */
  fileMatch?: DirectFileMatch
}

export interface RecursivePathMatch {
  /** Directory name that must be present above every returned target. */
  anchor: string
  /**
   * Optional relative patterns that locate anchor roots without recursively
   * walking each base path. Each segment is an exact name or a single `*`.
   */
  anchorPaths?: string[]
  /** Exact directory names to return beneath the anchor. */
  targets: string[]
  /** Directory names whose subtrees must never be inspected for targets. */
  excludedAncestors?: string[]
  /** Maximum directory depth below each resolved anchor (or configured base path). */
  maxDepth?: number
}

export interface DirectFileMatch {
  /** Exact file names to offer for cleanup. */
  names: string[]
  /** If set, inspect only immediate child directories ending with this suffix. */
  childDirSuffix?: string
  /** Files newer than this age are never offered. */
  minAgeDays: number
  /** Skip a candidate directory entirely when any of these direct children exist. */
  skipIfChildExists?: string[]
}

export interface UninstallLeftoverDir {
  id: string
  name: string
  path: string
}

export interface MalwareScanDir {
  path: string
  maxDepth: number
  maxFiles: number
}

export interface PlatformPaths {
  /** System cleanup targets (temp files, caches, logs, etc.) */
  systemCleanTargets(): CleanTarget[]

  /** Single-file cleanup targets (e.g. full memory dump on Windows) */
  singleFileCleanTargets(): { path: string; subcategory: string }[]

  /** Protected event log filenames that must never be deleted */
  protectedEventLogs(): string[]

  /** Browser profile and cache paths */
  browserPaths(): BrowserPathConfig

  /** Application cache paths */
  appPaths(): AppCacheDef[]

  /** Gaming launcher cache paths */
  gamingPaths(): AppCacheDef[]

  /** GPU shader cache paths */
  gpuCachePaths(): AppCacheDef[]

  /** Directories to scan for malware, with per-path scan limits */
  malwareScanDirs(): MalwareScanDir[]

  /** System directories to exclude from suspicious filename checks */
  malwareSystemDirs(): string[]

  /**
   * Installation roots that need elevation to write to. A trusted-publisher
   * directory beneath one of these is taken at face value.
   */
  malwareTrustedInstallRoots(): string[]

  /**
   * Installation roots writable without elevation (per-user installs, ProgramData).
   * A trusted-publisher directory here only suppresses heuristics, never
   * signature matching.
   */
  malwareTrustedUserInstallRoots(): string[]

  /** Directories to scan for uninstall leftovers */
  uninstallLeftoverDirs(): UninstallLeftoverDir[]

  /** Steam library locations for redistributable scanning */
  steamLibraries(): string[]

  /** Known redistributable folder patterns (platform-independent but kept here for consistency) */
  steamRedistPatterns(): string[]

  /** Trash / Recycle Bin path (for CLI scan/clean) */
  trashPath(): string | null

  /** SQLite database targets for vacuum optimization */
  databaseOptimizeTargets(): DatabaseTarget[]
}

export interface DatabaseTarget {
  /** Display label (e.g. "Chrome", "Firefox", "Discord") */
  label: string
  /** Base directory containing the databases */
  basePath: string
  /** Specific database filenames to look for (e.g. "History", "places.sqlite") */
  dbFiles: string[]
  /** If true, scan all profile subdirectories under basePath */
  multiProfile?: boolean
  /** Glob pattern for profile subdirectories (default: "Profile *" and "Default") */
  profilePattern?: string[]
}

// ─── Elevation ──────────────────────────────────────────────

export interface PlatformElevation {
  /** Check if the current process has admin/root privileges */
  isAdmin(): boolean
}

// ─── Security Posture ───────────────────────────────────────

export interface PlatformSecurity {
  isServer(): Promise<boolean>
  collectAntivirusStatus(): Promise<HealthReport['securityPosture']['antivirus']>
  collectFirewallStatus(): Promise<HealthReport['securityPosture']['firewall']>
  collectDiskEncryptionStatus(): Promise<HealthReport['securityPosture']['bitlocker']>
  collectUpdateStatus(): Promise<HealthReport['securityPosture']['windowsUpdate']>
  collectScreenLockStatus(): Promise<HealthReport['securityPosture']['screenLock']>
  collectPasswordPolicy(): Promise<HealthReport['securityPosture']['passwordPolicy']>
  collectSshHardening(): Promise<HealthReport['securityPosture']['sshHardening']>
  collectFail2ban(): Promise<HealthReport['securityPosture']['fail2ban']>
  collectListeningPorts(): Promise<HealthReport['securityPosture']['listeningPorts']>
  collectAuditd(): Promise<HealthReport['securityPosture']['auditd']>
  collectSuidSgidBinaries(): Promise<HealthReport['securityPosture']['suidSgidBinaries']>
  collectLinuxFirewallStatus(): Promise<HealthReport['securityPosture']['firewallStatus']>
}

// ─── System Commands ────────────────────────────────────────

export interface EventLogEntry {
  time: string
  eventId: number
  level: string
  provider: string
  message: string
}

export interface InstalledApp {
  name: string
  version: string
  publisher: string
  installDate: string
  sizeKb: number
}

export interface OsUpdateInfo {
  title: string
  kb: string
  severity: string
  sizeBytes: number
  downloaded: boolean
}

export interface OsUpdateInstallResult {
  installed: number
  resultCode: number
  needsReboot: boolean
}

export interface SfcResult {
  exitCode: number
  status: string
}

export interface DismResult {
  exitCode: number
  status: string
}

export interface DnsEntry {
  iface: string
  servers: string[]
}

export interface PlatformCommands {
  shutdown(delaySec: number): Promise<void>
  restart(delaySec: number): Promise<void>

  /** Get DNS server addresses per interface */
  getDnsServers(): Promise<DnsEntry[]>

  /** Get event log entries */
  getEventLog(logName: string, maxEntries: number): Promise<EventLogEntry[]>

  /** Get installed applications inventory */
  getInstalledApps(): Promise<InstalledApp[]>

  /** Check for OS-level updates. Returns null if not supported. */
  checkOsUpdates(): Promise<OsUpdateInfo[] | null>

  /** Install OS-level updates. Returns null if not supported. */
  installOsUpdates(): Promise<OsUpdateInstallResult | null>

  /** Run system file checker. Returns null if not supported. */
  runSystemFileCheck(): Promise<SfcResult | null>

  /** Run system image repair. Returns null if not supported. */
  runSystemImageRepair(): Promise<DismResult | null>
}

// ─── Startup Manager ────────────────────────────────────────

export interface PlatformStartup {
  listItems(): Promise<StartupItem[]>
  toggleItem(
    name: string,
    location: string,
    command: string,
    source: StartupItem['source'],
    enabled: boolean
  ): Promise<boolean>
  deleteItem?(name: string, location: string, source: StartupItem['source']): Promise<boolean>
  getBootTrace?(): Promise<StartupBootTrace>
}

// ─── Privacy ────────────────────────────────────────────────

export interface PrivacySettingDef {
  id: string
  category: PrivacySetting['category']
  label: string
  description: string
  requiresAdmin: boolean
  dependsOn?: string        // ID of a setting that must be enabled first
  check: () => Promise<boolean>
  apply: () => Promise<void>
  revert?: () => Promise<void>
  applicable?: () => Promise<boolean>
}

export interface PlatformPrivacy {
  getSettings(): PrivacySettingDef[]
}

// ─── Services ───────────────────────────────────────────────

export interface PlatformServices {
  scan(onProgress?: (data: ServiceScanProgress) => void): Promise<ServiceScanResult>
  applyChanges(changes: Array<{ name: string; targetStartType: string }>): Promise<ServiceApplyResult>
}

// ─── Malware ────────────────────────────────────────────────

export interface NativeAvResult {
  isThreat: boolean
  threatName: string
}

export interface PlatformMalware {
  /** Whether PE (Windows executable) analysis should run */
  shouldAnalyzePE(): boolean

  /** Scan a file with the platform's native antivirus. Returns null if not available. */
  scanWithNativeAv?(filePath: string): Promise<NativeAvResult | null>

  /** Scannable file extensions for this platform */
  scannableExtensions(): string[]
}

// ─── Browser Process Management ─────────────────────────────

export interface PlatformBrowser {
  /** Kill running browser processes before cache cleaning */
  closeBrowsers(): Promise<void>
}

// ─── Allowed Malware Paths ──────────────────────────────────

export interface PlatformMalwarePaths {
  /** Check if a file path is within directories allowed for malware operations */
  isAllowedMalwarePath(filePath: string): boolean
}

// ─── Network Scanning ──────────────────────────────────────

export interface ActiveConnection {
  remoteAddress: string
  remotePort: number
  localPort: number
  pid: number | null
}

export interface DnsCacheEntry {
  domain: string
  resolvedAddress: string | null
}

export interface WifiProfile {
  name: string
  security: string
}

export interface PlatformNetwork {
  /** Get established TCP connections with remote address, port, and PID */
  getEstablishedConnections(): Promise<ActiveConnection[]>
  /** Get TCP ports currently in LISTEN state. Used to distinguish inbound vs outbound connections on servers. */
  getListeningPorts(): Promise<number[]>
  /** Get DNS cache entries. Returns empty array if not supported on this platform. */
  getDnsCacheEntries(): Promise<DnsCacheEntry[]>
  /** Flush the DNS resolver cache. Returns true on success. */
  flushDnsCache?(): Promise<boolean>
  /** List saved Wi-Fi profiles. */
  getWifiProfiles?(): Promise<WifiProfile[]>
  /** Delete a saved Wi-Fi profile by name. */
  deleteWifiProfile?(name: string): Promise<boolean>
  /** Clear the ARP cache. Returns true on success. */
  clearArpCache?(): Promise<boolean>
}

// ─── Top-level Provider ─────────────────────────────────────

export interface PlatformProvider {
  readonly platform: 'win32' | 'darwin' | 'linux'
  readonly paths: PlatformPaths
  readonly elevation: PlatformElevation
  readonly security: PlatformSecurity
  readonly commands: PlatformCommands
  readonly startup: PlatformStartup
  readonly privacy: PlatformPrivacy
  readonly services: PlatformServices
  readonly malware: PlatformMalware
  readonly browser: PlatformBrowser
  readonly malwarePaths: PlatformMalwarePaths
  readonly network: PlatformNetwork
}
