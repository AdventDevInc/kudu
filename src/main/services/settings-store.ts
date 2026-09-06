import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { logError } from './logger'
import type { KuduSettings, ScheduleEntry, ScheduleTaskType, MalwareAllowlistEntry, WindowsPackageManager, WindowState } from '../../shared/types'

let _dataDir: string | null = null
let _configPath: string | null = null

export function getDataDir(): string {
  if (!_dataDir) {
    _dataDir = app.isPackaged
      ? app.getPath('userData')
      : join(app.getPath('userData'), 'Kudu-Dev')
  }
  return _dataDir
}

function getConfigPath(): string {
  if (!_configPath) {
    _configPath = join(getDataDir(), 'config.json')
  }
  return _configPath
}

interface StoreData {
  settings: KuduSettings
  onboardingComplete: boolean
  machineId: string
  /** Last known main-window geometry; null until the window is first sized. */
  windowState: WindowState | null
}

const defaults: StoreData = {
  machineId: '',
  onboardingComplete: false,
  windowState: null,
  settings: {
    theme: 'system' as const,
    language: 'en',
    minimizeToTray: false,
    showNotificationOnComplete: true,
    showThreatNotifications: true,
    runAtStartup: false,
    autoUpdate: true,
    autoRestart: true,
    updateCheckIntervalHours: 4,
    softwareUpdaterNotifications: true,
    cleaner: {
      skipRecentMinutes: 60,
      secureDelete: false,
      closeBrowsersBeforeClean: false,
      createRestorePoint: false,
      protectRecycleBin: true,
      keepDeletionLog: false
    },
    exclusions: [],
    ignoredSoftwareUpdates: [],
    backupPath: '',
    backupMode: 'targeted' as const,
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
      // Opt-in: GHSA-67rx / remote command blast radius if API key is stolen.
      allowRemotePower: false,
      allowRemoteCleanup: false,
      allowRemoteInstalls: false,
      allowRemoteConfig: false
    },
    windowsPackageManager: 'winget' as const,
    windowsPackageManagers: ['winget', 'choco', 'scoop', 'npm'] as WindowsPackageManager[],
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
    },
    registryIgnoredTweaks: [],
    malwareAllowlist: []
  }
}

function ensureDir(): void {
  if (!existsSync(getDataDir())) {
    mkdirSync(getDataDir(), { recursive: true })
  }
}

// ── API key encryption via Electron safeStorage ──────────────────────
// Uses DPAPI (Windows), Keychain (macOS), or libsecret (Linux) to
// encrypt the cloud API key at rest.  The config.json stores a base64-
// encoded ciphertext in `cloud.apiKeyEncrypted` instead of plaintext.
// Falls back to plaintext if safeStorage is unavailable (e.g. headless
// Linux without a keyring).

const ENCRYPTED_KEY_PREFIX = 'v1:enc:' // marker so we can tell encrypted from plain

function encryptApiKey(plain: string): string {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const cipher = safeStorage.encryptString(plain)
      return ENCRYPTED_KEY_PREFIX + cipher.toString('base64')
    }
  } catch { /* fall through */ }
  return plain // fallback: store as-is if encryption unavailable
}

function decryptApiKey(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith(ENCRYPTED_KEY_PREFIX)) {
    // safeStorage may be unavailable in headless/daemon mode on Linux without
    // a keyring.  If we can't decrypt, return empty — the daemon should set
    // its own key via --api-key which will re-encrypt (or store plain).
    try {
      if (!safeStorage.isEncryptionAvailable()) return ''
      const buf = Buffer.from(stored.slice(ENCRYPTED_KEY_PREFIX.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      return '' // corrupted ciphertext — treat as unset
    }
  }
  // Legacy plaintext key — will be re-encrypted on next write
  return stored
}

/** Deep merge that handles nested objects like cleaner and schedule */
export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key of Object.keys(source) as Array<keyof T>) {
    // Guard against prototype pollution
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const srcVal = source[key]
    const tgtVal = target[key]
    if (
      srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal !== null && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal as any)
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T]
    }
  }
  return result
}

function readStore(): StoreData {
  ensureDir()
  try {
    if (existsSync(getConfigPath())) {
      const raw = readFileSync(getConfigPath(), 'utf-8')
      const parsed = JSON.parse(raw)
      const merged = deepMerge(defaults, parsed)
      // Drop the legacy `stats` block. Nothing has ever read it — the counters
      // the UI shows are derived from history.json — so it sat at zero in
      // config.json while the dashboard reported real numbers, which reads as
      // data loss to anyone who opens the file (issue #269). Deleting it here
      // clears it from existing installs on their next write.
      delete (merged as { stats?: unknown }).stats
      // Decrypt API key if stored encrypted
      if (merged.settings.cloud.apiKey) {
        merged.settings.cloud.apiKey = decryptApiKey(merged.settings.cloud.apiKey)
      }
      // Migrate legacy single-manager preference → aggregation list. Existing
      // installs kept exactly one manager (winget or choco); preserve that as
      // their scanned set so an upgrade doesn't silently start scanning every
      // manager. Fresh installs (no persisted legacy value) get the
      // aggregate-all default. Only runs when the new field was never persisted.
      if (
        parsed?.settings &&
        parsed.settings.windowsPackageManagers === undefined &&
        (parsed.settings.windowsPackageManager === 'winget' ||
          parsed.settings.windowsPackageManager === 'choco')
      ) {
        merged.settings.windowsPackageManagers = [parsed.settings.windowsPackageManager]
        // Best-effort: the migration is recomputed on the next read if it fails.
        try { writeStore(merged) } catch (err) { logError('Package-manager migration write failed', err) }
      }
      // Migrate legacy single schedule → schedules array
      if (merged.settings.schedule.enabled && merged.settings.schedules.length === 0) {
        const allCleanerTasks: ScheduleTaskType[] = [
          'cleaner:system', 'cleaner:browsers', 'cleaner:apps',
          'cleaner:gaming', 'cleaner:recycleBin', 'cleaner:databases'
        ]
        const migrated: ScheduleEntry = {
          id: randomUUID(),
          name: 'Scheduled Scan',
          enabled: true,
          frequency: merged.settings.schedule.frequency,
          day: merged.settings.schedule.day,
          hour: merged.settings.schedule.hour,
          minute: 0,
          tasks: allCleanerTasks,
          autoApply: false,
          lastRunAt: null,
          lastRunStatus: 'never',
          createdAt: new Date().toISOString()
        }
        merged.settings.schedules = [migrated]
        merged.settings.schedule.enabled = false
        // Persist migration immediately (best-effort — retried on the next read)
        try { writeStore(merged) } catch (err) { logError('Schedule migration write failed', err) }
      }
      return merged
    }
  } catch (err) {
    // Corrupt or unreadable file. Falling back to defaults resets every
    // setting and re-triggers onboarding, so leave a trace of why.
    logError('config.json could not be read — falling back to defaults', err)
  }
  return JSON.parse(JSON.stringify(defaults))
}

/**
 * Attempts for a single write. On Windows an antivirus scanner or the search
 * indexer routinely holds a just-written file open for a few milliseconds,
 * which surfaces as a transient EPERM/EBUSY — retrying clears it.
 */
const WRITE_ATTEMPTS = 3
const WRITE_RETRY_MS = 40

function sleepSync(ms: number): void {
  // Deliberately blocking: writeStore runs inside the write lock and callers
  // (including quit paths) rely on it being synchronous. Atomics.wait parks the
  // thread rather than spinning, and only ever runs on a failed write.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Write the whole store to disk.
 *
 * Writes to a sibling temp file and renames over the target so a crash or
 * power loss mid-write can never leave a truncated config.json — a parse
 * failure there sends readStore() back to the defaults, silently resetting
 * every setting (and re-triggering onboarding, issue #269).
 *
 * Throws if the write ultimately fails. Callers must not swallow that: a
 * silent failure here is indistinguishable from a successful save.
 */
function writeStore(data: StoreData): void {
  ensureDir()
  // Encrypt API key before writing to disk
  const toWrite = JSON.parse(JSON.stringify(data)) as StoreData
  if (toWrite.settings.cloud.apiKey) {
    toWrite.settings.cloud.apiKey = encryptApiKey(toWrite.settings.cloud.apiKey)
  }
  const json = JSON.stringify(toWrite, null, 2)
  const target = getConfigPath()
  const tmp = `${target}.${process.pid}.tmp`

  let lastErr: unknown
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    try {
      writeFileSync(tmp, json, 'utf-8')
      renameSync(tmp, target)
      return
    } catch (err) {
      lastErr = err
      try { unlinkSync(tmp) } catch { /* nothing to clean up */ }
      if (attempt < WRITE_ATTEMPTS) sleepSync(WRITE_RETRY_MS)
    }
  }
  throw lastErr
}

export function getSettings(): KuduSettings {
  return readStore().settings
}

// Simple mutex to prevent TOCTOU race on concurrent read-modify-write
let writeLock: Promise<void> = Promise.resolve()

/**
 * Serialize one read-modify-write of config.json behind the write lock.
 *
 * `mutate` runs on a copy freshly read inside the lock, so concurrent writers
 * never compute from a stale base. Returning `false` from it skips the write.
 *
 * The queue promise (`writeLock`) always resolves, so one failed write can
 * never wedge every write after it. The promise handed back to the *caller*
 * rejects when the write failed: the store must never report a save it did
 * not make, which is how the onboarding flag went missing with nothing in the
 * log to show for it (issue #269).
 */
function runLocked(what: string, mutate: (data: StoreData) => boolean | void): Promise<void> {
  const prev = writeLock
  let unlock: () => void
  writeLock = new Promise<void>((r) => { unlock = r })
  return prev.then(() => {
    try {
      const data = readStore()
      if (mutate(data) === false) return
      writeStore(data)
    } catch (err) {
      logError(`Failed to persist ${what} to config.json`, err)
      throw err
    } finally {
      unlock!()
    }
  })
}

export function setSettings(partial: Partial<KuduSettings>): void {
  // Fire-and-forget by contract — callers order writes with flushSettings().
  // runLocked has already logged anything that went wrong.
  void runLocked('settings', (data) => {
    data.settings = deepMerge(data.settings, partial)
  }).catch(() => { /* logged in runLocked */ })
}

/**
 * Atomically update a single schedule entry within the write lock.
 * Unlike setSettings({ schedules: [...] }), this reads the latest schedules
 * inside the lock so concurrent completions don't clobber each other.
 */
export function updateScheduleEntry(scheduleId: string, patch: Partial<import('../../shared/types').ScheduleEntry>): void {
  void runLocked('schedule entry', (data) => {
    data.settings.schedules = data.settings.schedules.map((s) =>
      s.id === scheduleId ? { ...s, ...patch } : s
    )
  }).catch(() => { /* logged in runLocked */ })
}

/**
 * Atomically add or remove registry-tweak ignore signatures within the write
 * lock. Reads the latest list inside the lock so a toggle can never compute
 * from a stale in-memory base and drop previously-ignored signatures (issue
 * #172). `ignored = true` adds the signatures, `false` removes them.
 */
export function updateRegistryIgnoredTweaks(signatures: string[], ignored: boolean): void {
  void runLocked('registry ignore list', (data) => {
    const set = new Set(data.settings.registryIgnoredTweaks ?? [])
    for (const sig of signatures) {
      if (!sig) continue
      if (ignored) set.add(sig)
      else set.delete(sig)
    }
    // Bound the list to match validation (oldest entries dropped first).
    data.settings.registryIgnoredTweaks = [...set].slice(-200)
  }).catch(() => { /* logged in runLocked */ })
}

/** Read the malware false-positive allowlist. */
export function getMalwareAllowlist(): MalwareAllowlistEntry[] {
  return readStore().settings.malwareAllowlist ?? []
}

/**
 * Add a file to the malware false-positive allowlist within the write lock.
 * De-dupes by content hash (a re-ignore refreshes the existing entry's
 * path/detection metadata) and caps the list to the most recent 500 entries.
 */
export function addMalwareAllowlistEntry(entry: MalwareAllowlistEntry): Promise<void> {
  return runLocked('malware allowlist', (data) => {
    const list = (data.settings.malwareAllowlist ?? []).filter((e) => e.sha256 !== entry.sha256)
    list.push(entry)
    data.settings.malwareAllowlist = list.slice(-500)
  })
}

/** Remove an allowlist entry by content hash within the write lock. */
export function removeMalwareAllowlistEntry(sha256: string): Promise<void> {
  return runLocked('malware allowlist', (data) => {
    data.settings.malwareAllowlist = (data.settings.malwareAllowlist ?? []).filter((e) => e.sha256 !== sha256)
  })
}

/** Read the last persisted main-window geometry (null on first run). */
export function getWindowState(): WindowState | null {
  return readStore().windowState ?? null
}

/**
 * Persist the main-window geometry within the write lock so a resize landing
 * at the same time as a settings write can't clobber either one.
 */
export function setWindowState(state: WindowState): Promise<void> {
  return runLocked('window geometry', (data) => {
    data.windowState = state
  })
}

/** Wait for any pending setSettings() writes to complete */
export function flushSettings(): Promise<void> {
  return writeLock
}

export function getOnboardingComplete(): boolean {
  return readStore().onboardingComplete
}

export function setOnboardingComplete(value: boolean): Promise<void> {
  return runLocked('onboarding completion', (data) => {
    data.onboardingComplete = value
  })
}

/** Permanent machine identifier — generated once, persists across unlink/relink/updates */
export function getMachineId(): string {
  const data = readStore()
  if (data.machineId) return data.machineId
  // First call ever — generate and persist (uses lock to avoid concurrent writes)
  const id = randomUUID()
  void runLocked('machine id', (fresh) => {
    // A concurrent caller may have won the race and already stored one.
    if (fresh.machineId) return false
    fresh.machineId = id
  }).catch(() => { /* logged in runLocked */ })
  return id
}
