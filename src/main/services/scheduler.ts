import { BrowserWindow, Notification } from 'electron'
import { IPC } from '../../shared/channels'
import { getSettings, updateScheduleEntry } from './settings-store'
import { t } from '../i18n'
import { logInfo } from './logger'
import type { KuduSettings, ScheduleEntry, ScheduleRunStatus } from '../../shared/types'

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null

// ─── Per-entry helpers ────────────────────────────────────

/**
 * Calculate the next run time for a single schedule entry.
 */
export function getNextRunTime(entry: ScheduleEntry): Date | null {
  if (!entry.enabled) return null

  const now = new Date()
  const next = new Date()
  const minute = entry.minute ?? 0
  next.setHours(entry.hour, minute, 0, 0)

  switch (entry.frequency) {
    case 'daily':
      if (next <= now) next.setDate(next.getDate() + 1)
      break

    case 'weekly':
      next.setDate(next.getDate() + ((entry.day - next.getDay() + 7) % 7))
      if (next <= now) next.setDate(next.getDate() + 7)
      break

    case 'monthly': {
      const clampDay = (d: Date, day: number) => {
        const max = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
        d.setDate(Math.min(day, max))
      }
      clampDay(next, entry.day)
      if (next <= now) {
        next.setMonth(next.getMonth() + 1)
        clampDay(next, entry.day)
      }
      break
    }
  }

  return next
}

/**
 * Check if a schedule entry is due to run now.
 * Uses the entry's own lastRunAt instead of global history.
 */
function isDueEntry(entry: ScheduleEntry): boolean {
  if (!entry.enabled) return false

  const now = new Date()
  const lastRun = entry.lastRunAt ? new Date(entry.lastRunAt) : null

  const target = new Date()
  const entryMinute = entry.minute ?? 0
  target.setHours(entry.hour, entryMinute, 0, 0)
  const withinWindow = Math.abs(now.getTime() - target.getTime()) <= 2 * 60_000

  switch (entry.frequency) {
    case 'daily':
      if (!withinWindow) return false
      if (lastRun && isSameDay(lastRun, now)) return false
      return true

    case 'weekly':
      if (now.getDay() !== entry.day) return false
      if (!withinWindow) return false
      if (lastRun && isSameDay(lastRun, now)) return false
      return true

    case 'monthly': {
      // Clamp day to the last day of the current month (same as getNextRunTime)
      // so that e.g. day=31 fires on the 28th in February
      const maxDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
      const effectiveDay = Math.min(entry.day, maxDay)
      if (now.getDate() !== effectiveDay) return false
      if (!withinWindow) return false
      if (lastRun && isSameDay(lastRun, now)) return false
      return true
    }
  }

  return false
}

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

/** Track in-flight schedules to prevent re-triggering before completion */
const inFlight = new Set<string>()
const inFlightTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Safety timeout: if the renderer never calls back, clear inFlight after 10 min */
const IN_FLIGHT_TIMEOUT_MS = 10 * 60_000

function triggerScheduleEntry(mainWindow: BrowserWindow | null, entry: ScheduleEntry): void {
  // Skip if this schedule is already in-flight
  if (inFlight.has(entry.id)) return

  // Skip if window is unavailable — mark as failed to prevent re-triggering
  if (!mainWindow || mainWindow.isDestroyed()) {
    logInfo(`Schedule "${entry.name}" skipped — no window available`)
    completeScheduleRun(entry.id, 'failed')
    return
  }

  logInfo(`Schedule triggered: "${entry.name}" (${entry.id})`)
  inFlight.add(entry.id)

  // Safety timeout — if the renderer never responds (crash, reload, etc.),
  // auto-clear so the schedule isn't stuck forever
  inFlightTimers.set(entry.id, setTimeout(() => {
    if (inFlight.has(entry.id)) {
      logInfo(`Schedule "${entry.name}" timed out — clearing inFlight`)
      inFlight.delete(entry.id)
      inFlightTimers.delete(entry.id)
    }
  }, IN_FLIGHT_TIMEOUT_MS))

  mainWindow.webContents.send(IPC.SCHEDULE_RUN_TRIGGER, {
    scheduleId: entry.id,
    scheduleName: entry.name,
    tasks: entry.tasks,
    autoApply: entry.autoApply
  })

  if (!process.argv.includes('--daemon') && Notification.isSupported()) {
    const notification = new Notification({
      title: t('scheduledTaskNotificationTitle'),
      body: t('scheduledTaskNotificationBody', { name: entry.name }),
      silent: true
    })
    notification.show()
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
export function completeScheduleRun(scheduleId: string, status: ScheduleRunStatus): void {
  inFlight.delete(scheduleId)
  const timer = inFlightTimers.get(scheduleId)
  if (timer) {
    clearTimeout(timer)
    inFlightTimers.delete(scheduleId)
  }
  updateScheduleEntry(scheduleId, {
    lastRunAt: new Date().toISOString(),
    lastRunStatus: status
  })
}

// ─── Scheduler loop ───────────────────────────────────────

function checkSchedules(getMainWindow: () => BrowserWindow | null): void {
  const settings = getSettings()

  // Check each enabled schedule
  for (const entry of settings.schedules) {
    if (isDueEntry(entry)) {
      triggerScheduleEntry(getMainWindow(), entry)
    }
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
      checkSchedules(getMainWindow)
    } catch (err) {
      logInfo(`Scheduler error: ${err}`)
    }
  }, 60_000)

  // Also check immediately on startup (with a short delay to let the window load)
  initialCheckTimer = setTimeout(() => {
    initialCheckTimer = null
    try {
      checkSchedules(getMainWindow)
    } catch (err) {
      logInfo(`Scheduler initial check error: ${err}`)
    }
  }, 5_000)
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  if (initialCheckTimer) {
    clearTimeout(initialCheckTimer)
    initialCheckTimer = null
  }
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    logInfo('Scheduler stopped')
  }
  // Clean up any pending inFlight timers
  for (const timer of inFlightTimers.values()) clearTimeout(timer)
  inFlightTimers.clear()
  inFlight.clear()
}
