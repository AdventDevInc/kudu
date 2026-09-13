import { app, BrowserWindow, Notification, powerMonitor } from 'electron'
import { IPC } from '../../shared/channels'
import {
  getSettings,
  updateScheduleEntry,
  claimScheduleOccurrence,
  flushSettings
} from './settings-store'
import { t } from '../i18n'
import { logInfo } from './logger'
import type { KuduSettings, ScheduleEntry, ScheduleRunStatus } from '../../shared/types'

import { randomUUID } from 'crypto'
import { parse } from 'path'
import si from 'systeminformation'
import {
  dueScheduleOccurrence,
  nextScheduleOccurrence,
  scheduleDefinition,
  scheduleWaitingReason,
  type ScheduleRuntime,
  type ScheduleWaitingReason
} from '../../shared/schedule-policy'

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null

// ─── Per-entry helpers ────────────────────────────────────

/**
 * Calculate the next run time for a single schedule entry.
 */
export const getNextRunTime = nextScheduleOccurrence

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

// ─── Legacy single-schedule compat ────────────────────────

/**
 * Get the soonest next scan time across all enabled schedules.
 * Also supports legacy single schedule for backward compat.
 */
export function getNextScanTime(settings: KuduSettings): Date | null {
  // New multi-schedule path
  if (settings.schedules.length > 0) {
    let soonest: Date | null = null
    for (const entry of settings.schedules) {
      const next = getNextRunTime(entry)
      if (next && (!soonest || next < soonest)) {
        soonest = next
      }
    }
    return soonest
  }

  // Legacy fallback
  if (!settings.schedule.enabled) return null
  const legacyEntry: ScheduleEntry = {
    id: 'legacy',
    name: 'Scheduled Scan',
    enabled: settings.schedule.enabled,
    frequency: settings.schedule.frequency,
    day: settings.schedule.day,
    hour: settings.schedule.hour,
    minute: 0,
    tasks: [],
    autoApply: false,
    lastRunAt: null,
    lastRunStatus: 'never',
    createdAt: ''
  }
  return getNextRunTime(legacyEntry)
}

// ─── Trigger & notify ─────────────────────────────────────

interface ActiveRun {
  entry: ScheduleEntry
  runId: string
  dueAt: string
  window: BrowserWindow
}
let active: ActiveRun | null = null
let evaluating = false
let generation = 0
const runtime = new Map<string, ScheduleRuntime>()
export function getScheduleRuntime(): ScheduleRuntime[] {
  return [...runtime.values()]
}
function state(entry: ScheduleEntry, reason: ScheduleWaitingReason | null, running = false) {
  runtime.set(entry.id, {
    id: entry.id,
    reason,
    running,
    evaluatedAt: new Date().toISOString(),
    nextEvaluationAt: new Date(Date.now() + 60_000).toISOString()
  })
}
async function conditionReason(entry: ScheduleEntry) {
  const conditions = entry.conditions ?? {}
  let idleSeconds: number | null = null,
    onBattery: boolean | null = null,
    gameMode: boolean | null = null,
    freePercent: number | null = null
  try {
    idleSeconds = powerMonitor.getSystemIdleTime()
  } catch {
    /* unavailable */
  }
  try {
    onBattery = powerMonitor.isOnBatteryPower()
  } catch {
    /* unavailable */
  }
  if (conditions.pauseForGameMode !== false) {
    if (process.platform !== 'win32') gameMode = false
    else {
      try {
        const { getGameModeStatus } = await import('../ipc/game-mode.ipc')
        const status = getGameModeStatus()
        gameMode = status.active || status.pendingRestore
      } catch {
        /* unavailable */
      }
    }
  }
  if (conditions.freeBelowPercent !== undefined) {
    try {
      const root = parse(app.getPath('home'))
        .root.replace(/[\\/]$/, '')
        .toLowerCase()
      const disks = await Promise.race([
        si.fsSize(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Disk query timed out')), 5000)
        )
      ])
      const disk = disks.find((d) => d.mount.replace(/[\\/]$/, '').toLowerCase() === root)
      if (disk && disk.size > 0) freePercent = (100 * disk.available) / disk.size
    } catch {
      /* unknown disk condition prevents execution */
    }
  }
  return scheduleWaitingReason(
    conditions,
    { idleSeconds, onBattery, gameMode, freePercent },
    new Date()
  )
}
export async function authorizeScheduleStep(scheduleId: unknown, runId: unknown) {
  if (!active || active.entry.id !== scheduleId || active.runId !== runId)
    return { allowed: false, reason: 'unavailable' as const }
  const entry = getSettings().schedules.find((e) => e.id === scheduleId)
  let reason: ScheduleWaitingReason | null =
    !entry || !entry.enabled
      ? 'disabled'
      : scheduleDefinition(entry) !== scheduleDefinition(active.entry)
        ? 'changed'
        : await conditionReason(entry)
  if (!active || active.runId !== runId) reason = 'unavailable'
  const latest = getSettings().schedules.find((e) => e.id === scheduleId)
  if (!latest?.enabled) reason = 'disabled'
  else if (entry && scheduleDefinition(latest) !== scheduleDefinition(entry)) reason = 'changed'
  if (entry) state(entry, reason, !reason)
  return { allowed: !reason, reason }
}
async function triggerScheduleEntry(
  mainWindow: BrowserWindow | null,
  entry: ScheduleEntry,
  due: Date
): Promise<void> {
  if (active) {
    state(entry, 'busy')
    return
  }
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    state(entry, 'unavailable')
    return
  }
  const definition = structuredClone(entry)
  const startedGeneration = generation
  const reason = await conditionReason(entry)
  if (startedGeneration !== generation) return
  if (reason) {
    state(entry, reason)
    return
  }
  if (!(await claimScheduleOccurrence(entry, due.toISOString()))) return
  if (
    startedGeneration !== generation ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  )
    return
  active = {
    entry: definition,
    runId: randomUUID(),
    dueAt: due.toISOString(),
    window: mainWindow
  }
  state(entry, null, true)
  mainWindow.webContents.send(IPC.SCHEDULE_RUN_TRIGGER, {
    scheduleId: entry.id,
    runId: active.runId,
    scheduleName: entry.name,
    tasks: entry.tasks,
    autoApply: entry.autoApply,
    cleanerSubcategories: entry.cleanerSubcategories
  })
  if (!process.argv.includes('--daemon') && Notification.isSupported()) {
    new Notification({
      title: t('scheduledTaskNotificationTitle'),
      body: t('scheduledTaskNotificationBody', { name: entry.name }),
      silent: true
    }).show()
  }
}
export async function runScheduleNow(getMainWindow: () => BrowserWindow | null, id: unknown) {
  if (typeof id !== 'string') throw new Error('Invalid schedule ID')
  if (evaluating || active) throw new Error('Another scheduled run is active')
  const entry = getSettings().schedules.find((e) => e.id === id && e.enabled)
  if (!entry) throw new Error('Enable the schedule before running it')
  evaluating = true
  try {
    await triggerScheduleEntry(getMainWindow(), entry, new Date())
    return runtime.get(id)
  } finally {
    evaluating = false
  }
}

/**
 * Send a notification when a scheduled scan completes.
 */
export function notifyScheduledScanComplete(totalSize: number, itemCount: number): void {
  if (process.argv.includes('--daemon') || !Notification.isSupported()) return
  const settings = getSettings()
  if (!settings.showNotificationOnComplete) return

  const sizeMB = (totalSize / (1024 * 1024)).toFixed(1)
  const notification = new Notification({
    title: t('scanCompleteNotificationTitle'),
    body: t('scanCompleteNotificationBody', { itemCount, sizeMB }),
    silent: false
  })
  notification.show()
}

/**
 * Update a schedule entry's last run info after completion.
 * Uses updateScheduleEntry for atomic read-modify-write inside the lock,
 * so concurrent completions from different schedules don't clobber each other.
 */
export async function completeScheduleRun(
  scheduleId: string,
  status: ScheduleRunStatus | 'deferred',
  runId?: string
): Promise<void> {
  if (!active || active.entry.id !== scheduleId || active.runId !== runId) return
  const entry = active.entry
  const reason = runtime.get(scheduleId)?.reason ?? null
  const current = getSettings().schedules.find((e) => e.id === scheduleId)
  if (
    status === 'deferred' &&
    entry.missedRun === 'once' &&
    current &&
    scheduleDefinition(current) === scheduleDefinition(entry)
  ) {
    updateScheduleEntry(scheduleId, { lastDueAt: entry.lastDueAt ?? null })
  } else {
    updateScheduleEntry(scheduleId, {
      lastRunAt: new Date().toISOString(),
      lastRunStatus: status === 'deferred' ? 'skipped' : status
    })
  }
  await flushSettings()
  if (active?.runId === runId) active = null
  state(entry, reason)
}
async function checkSchedules(getMainWindow: () => BrowserWindow | null): Promise<void> {
  if (evaluating) return
  evaluating = true
  try {
    const entries = getSettings().schedules
    for (const id of runtime.keys()) if (!entries.some((e) => e.id === id)) runtime.delete(id)
    // Never time out a live operation and start an overlapping run. A lost renderer consumes
    // this occurrence; a restart will not replay work whose completion is uncertain.
    if (
      active &&
      (active.window.isDestroyed() ||
        active.window.webContents.isDestroyed() ||
        active.window.webContents.isCrashed())
    ) {
      state(active.entry, 'interrupted')
      return
    }
    for (const entry of entries) {
      if (active?.entry.id === entry.id) continue
      const due = dueScheduleOccurrence(entry, new Date())
      if (due) await triggerScheduleEntry(getMainWindow(), entry, due)
      else state(entry, entry.enabled ? null : 'disabled')
    }
  } finally {
    evaluating = false
  }
}

/**
 * Start the scheduler that checks every minute if any schedule is due.
 */
export function startScheduler(getMainWindow: () => BrowserWindow | null): void {
  if (schedulerTimer) return

  logInfo('Scheduler started')

  schedulerTimer = setInterval(() => {
    try {
      void checkSchedules(getMainWindow).catch((err) => logInfo(`Scheduler error: ${err}`))
    } catch (err) {
      logInfo(`Scheduler error: ${err}`)
    }
  }, 60_000)

  // Also check immediately on startup (with a short delay to let the window load)
  initialCheckTimer = setTimeout(() => {
    initialCheckTimer = null
    try {
      void checkSchedules(getMainWindow).catch((err) => logInfo(`Scheduler error: ${err}`))
    } catch (err) {
      logInfo(`Scheduler initial check error: ${err}`)
    }
  }, 5_000)
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  generation++
  if (initialCheckTimer) {
    clearTimeout(initialCheckTimer)
    initialCheckTimer = null
  }
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    logInfo('Scheduler stopped')
  }
  runtime.clear()
  active = null
}
