/**
 * Runtime validation helpers for IPC inputs from the renderer process.
 * These guard against malformed or malicious data crossing the IPC boundary.
 */

import { app } from 'electron'
import { isAbsolute } from 'path'
import type { ScanHistoryEntry } from '../../shared/types'

/** Validate that a partial settings object only contains expected keys and safe values */
export function validateSettingsPartial(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const obj = input as Record<string, unknown>

  const allowedTopKeys = new Set([
    'theme', 'language',
    'minimizeToTray', 'showNotificationOnComplete', 'showThreatNotifications',
    'runAtStartup', 'autoUpdate', 'autoRestart', 'updateCheckIntervalHours',
    'cleaner', 'exclusions', 'ignoredSoftwareUpdates', 'backupPath', 'windowsPackageManager',
    'schedule', 'schedules', 'cloud', 'gameMode'
  ])

  for (const key of Object.keys(obj)) {
    if (!allowedTopKeys.has(key)) return null
  }

  // Validate theme is one of the allowed values
  if ('theme' in obj && obj.theme !== undefined) {
    if (!['dark', 'light', 'system'].includes(obj.theme as string)) return null
  }

  // Validate language is a safe locale code string (e.g. 'en', 'zh-CN')
  if ('language' in obj && obj.language !== undefined) {
    if (typeof obj.language !== 'string' || obj.language.length > 10 || !/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(obj.language)) return null
  }

  // Validate boolean fields have correct types
  const boolKeys = ['minimizeToTray', 'showNotificationOnComplete', 'showThreatNotifications', 'runAtStartup', 'autoUpdate', 'autoRestart'] as const
  for (const bk of boolKeys) {
    if (bk in obj && obj[bk] !== undefined && typeof obj[bk] !== 'boolean') return null
  }

  // Validate updateCheckIntervalHours is a reasonable number
  if ('updateCheckIntervalHours' in obj && obj.updateCheckIntervalHours !== undefined) {
    if (typeof obj.updateCheckIntervalHours !== 'number' || obj.updateCheckIntervalHours < 1 || obj.updateCheckIntervalHours > 168) return null
  }

  // Validate windowsPackageManager is one of the allowed values
  if ('windowsPackageManager' in obj && obj.windowsPackageManager !== undefined) {
    if (!['winget', 'choco'].includes(obj.windowsPackageManager as string)) return null
  }

  // Validate exclusions is an array of safe strings if present
  if ('exclusions' in obj && obj.exclusions !== undefined) {
    if (!Array.isArray(obj.exclusions)) return null
    if (!obj.exclusions.every((v: unknown) => typeof v === 'string')) return null
    // Limit number of exclusions and individual length
    if (obj.exclusions.length > 200) return null
    if (obj.exclusions.some((v: string) => v.length > 500 || v.length === 0)) return null
    // Block path traversal sequences and UNC paths in exclusions
    if (obj.exclusions.some((v: string) => v.includes('..') || v.startsWith('\\\\'))) return null
  }

  // Validate ignoredSoftwareUpdates is an array of package-id strings if present
  if ('ignoredSoftwareUpdates' in obj && obj.ignoredSoftwareUpdates !== undefined) {
    if (!Array.isArray(obj.ignoredSoftwareUpdates)) return null
    if (!obj.ignoredSoftwareUpdates.every((v: unknown) => typeof v === 'string')) return null
    if (obj.ignoredSoftwareUpdates.length > 500) return null
    if (obj.ignoredSoftwareUpdates.some((v: string) => v.length > 200 || v.length === 0)) return null
  }

  // Validate backupPath: empty string means "use default", otherwise must be an absolute,
  // safe path. Reject relative paths so persisted settings match runtime behavior in
  // getBackupDir() (which only accepts absolute paths).
  if ('backupPath' in obj && obj.backupPath !== undefined) {
    if (typeof obj.backupPath !== 'string') return null
    if (obj.backupPath.length > 1000) return null
    if (obj.backupPath.includes('..')) return null
    if (obj.backupPath.length > 0 && !isAbsolute(obj.backupPath)) return null
  }

  // Validate schedule has expected shape if present
  if ('schedule' in obj && obj.schedule !== undefined) {
    const s = obj.schedule as Record<string, unknown>
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return null
    const allowedScheduleKeys = new Set(['enabled', 'frequency', 'day', 'hour'])
    for (const key of Object.keys(s)) {
      if (!allowedScheduleKeys.has(key)) return null
    }
    if ('enabled' in s && typeof s.enabled !== 'boolean') return null
    if ('hour' in s && (typeof s.hour !== 'number' || s.hour < 0 || s.hour > 23)) return null
    if ('day' in s && (typeof s.day !== 'number' || s.day < 0 || s.day > 6)) return null
    if ('frequency' in s && !['daily', 'weekly', 'monthly'].includes(s.frequency as string)) return null
  }

  // Validate schedules array if present
  if ('schedules' in obj && obj.schedules !== undefined) {
    if (!Array.isArray(obj.schedules)) return null
    if (obj.schedules.length > 10) return null
    const validTaskTypes = new Set([
      'cleaner:system', 'cleaner:browsers', 'cleaner:apps', 'cleaner:gaming',
      'cleaner:recycleBin', 'cleaner:databases', 'registry', 'drivers', 'software-update', 'cve-scan'
    ])
    const validFrequencies = new Set(['daily', 'weekly', 'monthly'])
    const validStatuses = new Set(['success', 'partial', 'failed', 'never'])
    for (const entry of obj.schedules) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
      const e = entry as Record<string, unknown>
      if (typeof e.id !== 'string' || e.id.length > 100) return null
      if (typeof e.name !== 'string' || e.name.length > 100) return null
      if (typeof e.enabled !== 'boolean') return null
      if (!validFrequencies.has(e.frequency as string)) return null
      if (typeof e.day !== 'number' || e.day < 0 || e.day > 31) return null
      if (typeof e.hour !== 'number' || e.hour < 0 || e.hour > 23) return null
      if (e.minute !== undefined && (typeof e.minute !== 'number' || e.minute < 0 || e.minute > 59)) return null
      if (!Array.isArray(e.tasks) || e.tasks.length > 20) return null
      if (!e.tasks.every((t: unknown) => typeof t === 'string' && validTaskTypes.has(t as string))) return null
      if (typeof e.autoApply !== 'boolean') return null
      if (e.lastRunAt !== null && (typeof e.lastRunAt !== 'string' || e.lastRunAt.length > 50)) return null
      if (!validStatuses.has(e.lastRunStatus as string)) return null
      if (typeof e.createdAt !== 'string' || e.createdAt.length > 50) return null
    }
  }

  // Validate cleaner has expected shape if present
  if ('cleaner' in obj && obj.cleaner !== undefined) {
    const c = obj.cleaner as Record<string, unknown>
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return null
    const allowedCleanerKeys = new Set(['skipRecentMinutes', 'secureDelete', 'closeBrowsersBeforeClean', 'createRestorePoint'])
    for (const key of Object.keys(c)) {
      if (!allowedCleanerKeys.has(key)) return null
    }
    if ('skipRecentMinutes' in c && (typeof c.skipRecentMinutes !== 'number' || c.skipRecentMinutes < 0 || c.skipRecentMinutes > 525600)) return null
    if ('secureDelete' in c && typeof c.secureDelete !== 'boolean') return null
    if ('closeBrowsersBeforeClean' in c && typeof c.closeBrowsersBeforeClean !== 'boolean') return null
    if ('createRestorePoint' in c && typeof c.createRestorePoint !== 'boolean') return null
  }

  // Validate cloud has expected shape if present
  if ('cloud' in obj && obj.cloud !== undefined) {
    const c = obj.cloud as Record<string, unknown>
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return null
    const allowedCloudKeys = new Set(['apiKey', 'telemetryIntervalSec', 'shareDiskHealth', 'shareProcessList', 'shareThreatMonitor', 'allowRemotePower', 'allowRemoteCleanup', 'allowRemoteInstalls', 'allowRemoteConfig'])
    for (const key of Object.keys(c)) {
      if (!allowedCloudKeys.has(key)) return null
    }
    if ('apiKey' in c && (typeof c.apiKey !== 'string' || c.apiKey.length > 200)) return null
    if ('telemetryIntervalSec' in c && (typeof c.telemetryIntervalSec !== 'number' || c.telemetryIntervalSec < 10 || c.telemetryIntervalSec > 3600)) return null
    if ('shareDiskHealth' in c && typeof c.shareDiskHealth !== 'boolean') return null
    if ('shareProcessList' in c && typeof c.shareProcessList !== 'boolean') return null
    if ('shareThreatMonitor' in c && typeof c.shareThreatMonitor !== 'boolean') return null
    if ('allowRemotePower' in c && typeof c.allowRemotePower !== 'boolean') return null
    if ('allowRemoteCleanup' in c && typeof c.allowRemoteCleanup !== 'boolean') return null
    if ('allowRemoteInstalls' in c && typeof c.allowRemoteInstalls !== 'boolean') return null
    if ('allowRemoteConfig' in c && typeof c.allowRemoteConfig !== 'boolean') return null
  }

  // Validate gameMode has expected shape if present
  if ('gameMode' in obj && obj.gameMode !== undefined) {
    const g = obj.gameMode as Record<string, unknown>
    if (typeof g !== 'object' || g === null || Array.isArray(g)) return null
    const allowedGameModeKeys = new Set(['enabledOptimizations', 'customProcessKillList', 'autoDetect', 'autoDeactivate', 'customGameProcesses'])
    for (const key of Object.keys(g)) {
      if (!allowedGameModeKeys.has(key)) return null
    }
    if ('enabledOptimizations' in g) {
      if (!Array.isArray(g.enabledOptimizations)) return null
      if (g.enabledOptimizations.length > 30) return null
      const validOptIds = new Set([
        'svc-wsearch', 'svc-sysmain', 'svc-wuauserv', 'svc-spooler', 'svc-diagtrack',
        'proc-kill-browsers', 'proc-kill-chat', 'proc-kill-updaters', 'proc-kill-custom',
        'mem-clear-standby',
        'sys-focus-assist', 'sys-power-plan', 'sys-prevent-sleep',
        'sys-disable-game-bar', 'sys-disable-fse-opt', 'sys-disable-transparency',
        'net-flush-dns', 'net-disable-nagle'
      ])
      if (!g.enabledOptimizations.every((v: unknown) => typeof v === 'string' && validOptIds.has(v as string))) return null
    }
    if ('customProcessKillList' in g) {
      if (!Array.isArray(g.customProcessKillList)) return null
      if (g.customProcessKillList.length > 50) return null
      if (!g.customProcessKillList.every((v: unknown) =>
        typeof v === 'string' && v.length > 0 && v.length <= 100 &&
        /^[A-Za-z0-9._\- ]+$/.test(v)
      )) return null
    }
    if ('autoDetect' in g && typeof g.autoDetect !== 'boolean') return null
    if ('autoDeactivate' in g && typeof g.autoDeactivate !== 'boolean') return null
    if ('customGameProcesses' in g) {
      if (!Array.isArray(g.customGameProcesses)) return null
      if (g.customGameProcesses.length > 50) return null
      if (!g.customGameProcesses.every((v: unknown) =>
        typeof v === 'string' && v.length > 0 && v.length <= 100 &&
        /^[A-Za-z0-9._\- ]+$/.test(v)
      )) return null
    }
  }

  return obj
}

/**
 * Validate that an IPC argument is a string array within reasonable bounds.
 * Returns the validated array (filtered to strings only) or an empty array on invalid input.
 */
export function validateStringArray(
  input: unknown,
  maxItems: number = 10_000,
  maxItemLength: number = 1024
): string[] | null {
  if (!Array.isArray(input)) return null
  if (input.length > maxItems) return null
  if (!input.every((v: unknown) => typeof v === 'string' && v.length <= maxItemLength)) return null
  return input as string[]
}

/** Validate a scan history entry has the expected shape and reasonable size */
export function validateHistoryEntry(input: unknown): ScanHistoryEntry | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const obj = input as Record<string, unknown>

  if (typeof obj.id !== 'string' || obj.id.length > 100) return null
  if (!['cleaner', 'registry', 'debloater', 'network', 'drivers', 'malware', 'privacy', 'startup', 'services', 'software-update', 'cve-scan'].includes(obj.type as string)) return null
  if (typeof obj.timestamp !== 'string' || obj.timestamp.length > 50) return null
  if (typeof obj.duration !== 'number' || obj.duration < 0) return null
  if (typeof obj.totalItemsFound !== 'number') return null
  if (typeof obj.totalItemsCleaned !== 'number') return null
  if (typeof obj.totalItemsSkipped !== 'number') return null
  if (typeof obj.totalSpaceSaved !== 'number') return null
  if (typeof obj.errorCount !== 'number') return null
  if (!Array.isArray(obj.categories)) return null
  // Limit categories array size to prevent disk-fill attacks
  if (obj.categories.length > 50) return null

  return obj as unknown as ScanHistoryEntry
}

