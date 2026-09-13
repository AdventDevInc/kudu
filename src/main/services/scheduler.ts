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
import si from 'systeminformation'
import {
  dueScheduleOccurrence,
  nextScheduleOccurrence,
  scheduleDefinition,
  scheduleWaitingReason,
  type ScheduleConditions,
  type ScheduleRuntime,
  type ScheduleWaitingReason
} from '../../shared/schedule-policy'

/** A trigger the renderer never acknowledges is rolled back so the occurrence retries. */
const ACK_TIMEOUT_MS = 15_000

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
  acked: boolean
  /** Detaches the window listeners and the acknowledgement timer. */
  release: () => void
}
let active: ActiveRun | null = null
let evaluating = false
let generation = 0
const runtime = new Map<string, ScheduleRuntime>()
/** Definitions whose due occurrence is waiting on a condition; a silent expiry records 'skipped'. */
const pending = new Map<string, string>()
/** Definitions whose Run Now request is waiting on a condition; each check retries them. */
const manual = new Map<string, string>()
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
function normalizeMount(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}
async function conditionReason(entry: ScheduleEntry, betweenSteps = false) {
  const conditions: ScheduleConditions = { ...(entry.conditions ?? {}) }
  if (betweenSteps) {
    // Disk space and the maintenance window gate only the start: a workflow whose first step
    // frees space or crosses the window boundary keeps going.
    delete conditions.freeBelowPercent
    delete conditions.windowStart
    delete conditions.windowEnd
  }
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
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const home = normalizeMount(app.getPath('home'))
      const disks = await Promise.race([
        si.fsSize(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Disk query timed out')), 5000)
        })
      ])
      // The home directory may live on its own volume: use the deepest mount containing it.
      let disk: (typeof disks)[number] | undefined
      for (const d of disks) {
        const mount = normalizeMount(d.mount)
        const contains =
          home === mount || (home.startsWith(mount) && /[\\/]/.test(home.charAt(mount.length)))
        if (contains && (!disk || mount.length > normalizeMount(disk.mount).length)) disk = d
      }
      if (disk && disk.size > 0) freePercent = (100 * disk.available) / disk.size
    } catch {
      /* unknown disk condition prevents execution */
    } finally {
      clearTimeout(timeout)
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
  active.acked = true
  const entry = getSettings().schedules.find((e) => e.id === scheduleId)
  let reason: ScheduleWaitingReason | null =
    !entry || !entry.enabled
      ? 'disabled'
      : scheduleDefinition(entry) !== scheduleDefinition(active.entry)
        ? 'changed'
        : await conditionReason(entry, true)
  if (!active || active.runId !== runId) reason = 'unavailable'
  const latest = getSettings().schedules.find((e) => e.id === scheduleId)
  if (!latest?.enabled) reason = 'disabled'
  else if (entry && scheduleDefinition(latest) !== scheduleDefinition(entry)) reason = 'changed'
  if (entry) state(entry, reason, !reason)
  return { allowed: !reason, reason }
}
/** The renderer confirms it received a trigger; unacknowledged triggers are rolled back. */
export function acknowledgeScheduleRun(scheduleId: unknown, runId: unknown): boolean {
  if (!active || active.entry.id !== scheduleId || active.runId !== runId) return false
  active.acked = true
  return true
}
/**
 * Release the execution lock for a run whose renderer can no longer report back. An
 * unacknowledged trigger returns its occurrence so the next check retries; anything that
 * may have started work is recorded as failed and never replayed.
 */
function abandonRun(runId: string, reason: ScheduleWaitingReason): void {
  if (!active || active.runId !== runId) return
  const { entry } = active
  active.release()
  active = null
  const current = getSettings().schedules.find((e) => e.id === entry.id)
  const unchanged = current && scheduleDefinition(current) === scheduleDefinition(entry)
  if (reason === 'unavailable') {
    if (unchanged) updateScheduleEntry(entry.id, { lastDueAt: entry.lastDueAt ?? null })
  } else {
    updateScheduleEntry(entry.id, { lastRunAt: new Date().toISOString(), lastRunStatus: 'failed' })
  }
  state(entry, reason)
}
function windowLost(window: BrowserWindow): boolean {
  return window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()
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
  const runId = randomUUID()
  const contents = mainWindow.webContents
  const lost = () => abandonRun(runId, 'interrupted')
  const navigated = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ) => {
    if (details.isMainFrame && !details.isSameDocument) lost()
  }
  const ackTimer = setTimeout(() => {
    if (active?.runId === runId && !active.acked) abandonRun(runId, 'unavailable')
  }, ACK_TIMEOUT_MS)
  active = {
    entry: definition,
    runId,
    dueAt: due.toISOString(),
    window: mainWindow,
    acked: false,
    release: () => {
      clearTimeout(ackTimer)
      if (contents.isDestroyed()) return
      contents.removeListener('did-start-navigation', navigated)
      contents.removeListener('render-process-gone', lost)
      contents.removeListener('destroyed', lost)
    }
  }
  contents.on('did-start-navigation', navigated)
  contents.on('render-process-gone', lost)
  contents.on('destroyed', lost)
  state(entry, null, true)
  contents.send(IPC.SCHEDULE_RUN_TRIGGER, {
    scheduleId: entry.id,
    runId,
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
  // Run Now while a request is waiting cancels it.
  if (manual.delete(id)) {
    if (!pending.has(id)) state(entry, null)
    return runtime.get(id)
  }
  evaluating = true
  try {
    await triggerScheduleEntry(getMainWindow(), entry, new Date())
    const current = runtime.get(id)
    if (current?.reason && !current.running) manual.set(id, scheduleDefinition(entry))
    return current
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
  if (active?.runId === runId) {
    active.release()
    active = null
  }
  state(entry, reason)
}
async function checkSchedules(getMainWindow: () => BrowserWindow | null): Promise<void> {
  if (evaluating) return
  evaluating = true
  try {
    const entries = getSettings().schedules
    for (const id of runtime.keys())
      if (!entries.some((e) => e.id === id)) {
        runtime.delete(id)
        pending.delete(id)
        manual.delete(id)
      }
    // Never time out a live operation and start an overlapping run. A lost renderer consumes
    // this occurrence: the run is recorded as failed and never replayed, and scheduling
    // continues against whatever window the app has now.
    if (active && windowLost(active.window)) abandonRun(active.runId, 'interrupted')
    for (const entry of entries) {
      if (active?.entry.id === entry.id) continue
      // An occurrence blocked only by another run stays due until that run finishes.
      const busy = runtime.get(entry.id)?.reason === 'busy'
      const definition = scheduleDefinition(entry)
      const occurrence = dueScheduleOccurrence(entry, new Date(), busy)
      if (!occurrence) {
        if (entry.enabled && pending.get(entry.id) === definition) {
          updateScheduleEntry(entry.id, {
            lastRunAt: new Date().toISOString(),
            lastRunStatus: 'skipped'
          })
          await flushSettings()
        }
        pending.delete(entry.id)
      }
      // A Run Now request waits only while its definition stays enabled and unchanged.
      if (!entry.enabled || manual.get(entry.id) !== definition) manual.delete(entry.id)
      const due = occurrence ?? (manual.has(entry.id) ? new Date() : null)
      if (due) {
        await triggerScheduleEntry(getMainWindow(), entry, due)
        const current = runtime.get(entry.id)
        const waiting = !!current?.reason && !current.running
        if (waiting && occurrence) pending.set(entry.id, definition)
        else pending.delete(entry.id)
        if (!waiting) manual.delete(entry.id)
      } else {
        state(entry, entry.enabled ? null : 'disabled')
      }
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
  pending.clear()
  manual.clear()
  active?.release()
  active = null
}
