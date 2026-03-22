import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import type { KuduSettings, AppStats, ScheduleEntry, ScheduleTaskType } from '../../shared/types'

let _dataDir: string | null = null
let _configPath: string | null = null

function getDataDir(): string {
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
  stats: AppStats
  onboardingComplete: boolean
  machineId: string
}

const defaults: StoreData = {
  machineId: '',
  onboardingComplete: false,
  settings: {
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
      createRestorePoint: false
    },
    exclusions: [],
    schedule: {
      enabled: false,
      frequency: 'weekly',
      day: 1,
      hour: 9
    },
    schedules: [],
    cloud: {
      apiKey: '',
      serverUrl: '',
      telemetryIntervalSec: 60,
      shareDiskHealth: true,
      shareProcessList: true,
      shareThreatMonitor: true,
      allowRemotePower: true,
      allowRemoteCleanup: true,
      allowRemoteInstalls: true,
      allowRemoteConfig: true
    },
    gameMode: {
      enabledOptimizations: [
        'svc-wsearch', 'svc-sysmain',
        'proc-kill-updaters',
        'mem-clear-standby',
        'sys-focus-assist', 'sys-power-plan', 'sys-prevent-sleep',
        'sys-disable-game-bar', 'sys-disable-fse-opt',
        'net-flush-dns'
      ],
      customProcessKillList: []
    }
  },
  stats: {
    totalSpaceSaved: 0,
    totalFilesCleaned: 0,
    totalScans: 0,
    lastScanDate: null,
    recentActivity: []
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
      // Decrypt API key if stored encrypted
      if (merged.settings.cloud.apiKey) {
        merged.settings.cloud.apiKey = decryptApiKey(merged.settings.cloud.apiKey)
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
          tasks: allCleanerTasks,
          autoApply: false,
          lastRunAt: null,
          lastRunStatus: 'never',
          createdAt: new Date().toISOString()
        }
        merged.settings.schedules = [migrated]
        merged.settings.schedule.enabled = false
        // Persist migration immediately
        try { writeStore(merged) } catch { /* best-effort */ }
      }
      return merged
    }
  } catch {
    // Corrupt file, use defaults
  }
  return JSON.parse(JSON.stringify(defaults))
}

function writeStore(data: StoreData): void {
  ensureDir()
  // Encrypt API key before writing to disk
  const toWrite = JSON.parse(JSON.stringify(data)) as StoreData
  if (toWrite.settings.cloud.apiKey) {
    toWrite.settings.cloud.apiKey = encryptApiKey(toWrite.settings.cloud.apiKey)
  }
  writeFileSync(getConfigPath(), JSON.stringify(toWrite, null, 2), 'utf-8')
}

export function getSettings(): KuduSettings {
  return readStore().settings
}

// Simple mutex to prevent TOCTOU race on concurrent read-modify-write
let writeLock: Promise<void> = Promise.resolve()

export function setSettings(partial: Partial<KuduSettings>): void {
  const prev = writeLock
  let unlock: () => void
  writeLock = new Promise<void>((r) => { unlock = r })
  prev.then(() => {
    try {
      const data = readStore()
      data.settings = deepMerge(data.settings, partial)
      writeStore(data)
    } finally {
      unlock!()
    }
  })
}

/**
 * Atomically update a single schedule entry within the write lock.
 * Unlike setSettings({ schedules: [...] }), this reads the latest schedules
 * inside the lock so concurrent completions don't clobber each other.
 */
export function updateScheduleEntry(scheduleId: string, patch: Partial<import('../../shared/types').ScheduleEntry>): void {
  const prev = writeLock
  let unlock: () => void
  writeLock = new Promise<void>((r) => { unlock = r })
  prev.then(() => {
    try {
      const data = readStore()
      data.settings.schedules = data.settings.schedules.map((s) =>
        s.id === scheduleId ? { ...s, ...patch } : s
      )
      writeStore(data)
    } finally {
      unlock!()
    }
  })
}

/** Wait for any pending setSettings() writes to complete */
export function flushSettings(): Promise<void> {
  return writeLock
}

export function getOnboardingComplete(): boolean {
  return readStore().onboardingComplete
}

export function setOnboardingComplete(value: boolean): void {
  const prev = writeLock
  let unlock: () => void
  writeLock = new Promise<void>((r) => { unlock = r })
  prev.then(() => {
    try {
      const data = readStore()
      data.onboardingComplete = value
      writeStore(data)
    } finally {
      unlock!()
    }
  })
}

/** Permanent machine identifier — generated once, persists across unlink/relink/updates */
export function getMachineId(): string {
  const data = readStore()
  if (data.machineId) return data.machineId
  // First call ever — generate and persist (uses lock to avoid concurrent writes)
  const id = randomUUID()
  const prev = writeLock
  let unlock: () => void
  writeLock = new Promise<void>((r) => { unlock = r })
  prev.then(() => {
    try {
      const fresh = readStore()
      if (!fresh.machineId) {
        fresh.machineId = id
        writeStore(fresh)
      }
    } finally {
      unlock!()
    }
  })
  return id
}

