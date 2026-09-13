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
import { hasMainWorkInFlight, mainWorkGeneration } from './main-work'
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
/**
 * How long an orphaned run keeps the execution lock unless the main-process work it requested
 * (cleaner deletions, registry fixes, package upgrades, driver installs) is positively known to
 * have finished. Work the renderer had not yet requested cannot be observed, so the lock is
 * held for this bound whenever no tracked operation completes after the renderer is lost.
 */
const ORPHAN_GRACE_MS = 10 * 60_000

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
  /** Whether the renderer has authorized its first step; later steps skip the start-only gates. */
  authorized: boolean
  /** When the acknowledged renderer was lost; the lock is held until its work is confirmed done. */
  orphanedAt: number | null
  /** Tracked-work completions seen when the run was orphaned; a later count is positive evidence. */
  orphanedWork: number
  /** Detaches the window listeners and the acknowledgement timer. */
  release: () => void
}
let active: ActiveRun | null = null
let evaluating = false
let generation = 0
const runtime = new Map<string, ScheduleRuntime>()
/** Definitions whose due occurrence is waiting on a condition; a silent expiry records 'skipped'. */
const pending = new Map<string, string>()
/**
 * Definitions with an outstanding Run Now request. A request stays queued, and each check
 * retries it, until the run it produced authorizes its first step; a dispatched run whose first
 * authorization fails (or that is never acknowledged) therefore retries once conditions pass.
 */
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
  if (!active || active.entry.id !== scheduleId || active.runId !== runId || active.orphanedAt)
    return { allowed: false, reason: 'unavailable' as const }
  active.acked = true
  // The renderer may authorize its first step long after dispatch (e.g. once a manual scan
  // finishes), so that check applies the full condition set; only later steps are between steps.
  const betweenSteps = active.authorized
  active.authorized = true
  const entry = getSettings().schedules.find((e) => e.id === scheduleId)
  let reason: ScheduleWaitingReason | null =
    !entry || !entry.enabled
      ? 'disabled'
      : scheduleDefinition(entry) !== scheduleDefinition(active.entry)
        ? 'changed'
        : await conditionReason(entry, betweenSteps)
  if (!active || active.runId !== runId || active.orphanedAt) reason = 'unavailable'
  const latest = getSettings().schedules.find((e) => e.id === scheduleId)
  if (!latest?.enabled) reason = 'disabled'
  else if (entry && scheduleDefinition(latest) !== scheduleDefinition(entry)) reason = 'changed'
  if (entry) state(entry, reason, !reason)
  // The run has started work: a Run Now request behind it is satisfied and must not replay.
  if (!reason && typeof scheduleId === 'string') manual.delete(scheduleId)
  return { allowed: !reason, reason }
}
/** The renderer confirms it received a trigger; unacknowledged triggers are rolled back. */
export function acknowledgeScheduleRun(scheduleId: unknown, runId: unknown): boolean {
  if (!active || active.entry.id !== scheduleId || active.runId !== runId || active.orphanedAt)
    return false
  active.acked = true
  return true
}
/** Returns a claimed occurrence so the next check retries it, unless the schedule changed. */
function restoreOccurrence(entry: ScheduleEntry): void {
  const current = getSettings().schedules.find((e) => e.id === entry.id)
  if (current && scheduleDefinition(current) === scheduleDefinition(entry))
    updateScheduleEntry(entry.id, { lastDueAt: entry.lastDueAt ?? null })
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
  // A rolled-back trigger leaves any Run Now request queued so the next check retries it.
  if (reason === 'unavailable') restoreOccurrence(entry)
  else {
    manual.delete(entry.id)
    updateScheduleEntry(entry.id, { lastRunAt: new Date().toISOString(), lastRunStatus: 'failed' })
  }
  state(entry, reason)
}
/**
 * The renderer driving an acknowledged run is gone, but cleaner deletions, registry fixes,
 * package upgrades or driver installs it requested keep running in this process. Record the
 * failure now and hold the execution lock until that work is positively confirmed finished (or
 * a grace period elapses) so a reloaded renderer or the next check cannot start an overlapping
 * workflow. The run is never replayed, so a Run Now request behind it is dropped.
 */
function orphanRun(runId: string): void {
  if (!active || active.runId !== runId || active.orphanedAt) return
  if (!active.acked) return abandonRun(runId, 'unavailable')
  const { entry } = active
  active.orphanedAt = Date.now()
  active.orphanedWork = mainWorkGeneration()
  active.release()
  manual.delete(entry.id)
  updateScheduleEntry(entry.id, { lastRunAt: new Date().toISOString(), lastRunStatus: 'failed' })
  state(entry, 'interrupted')
  settleOrphanedRun()
}
/**
 * Only positive evidence releases an orphaned run early: no tracked work in flight and at least
 * one tracked operation completed since the renderer was lost. A renderer that reloads while a
 * mutation runs leaves nothing observable until that mutation settles, and one that had not yet
 * requested its mutation leaves nothing at all, so absence of in-flight work alone proves nothing.
 */
function settleOrphanedRun(): void {
  if (!active?.orphanedAt) return
  const finished = !hasMainWorkInFlight() && mainWorkGeneration() !== active.orphanedWork
  if (!finished && Date.now() - active.orphanedAt < ORPHAN_GRACE_MS) return
  active = null
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
  // The window may have gone while the condition query ran; never claim for a lost window.
  if (windowLost(mainWindow)) {
    state(entry, 'unavailable')
    return
  }
  if (!(await claimScheduleOccurrence(entry, due.toISOString()))) return
  if (startedGeneration !== generation || windowLost(mainWindow)) {
    // Nothing was dispatched: hand the occurrence back so it is not silently consumed.
    restoreOccurrence(definition)
    if (startedGeneration === generation) state(entry, 'unavailable')
    return
  }
  const runId = randomUUID()
  const contents = mainWindow.webContents
  const lost = () => orphanRun(runId)
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
    authorized: false,
    orphanedAt: null,
    orphanedWork: 0,
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
    // The request outlives dispatch: it is satisfied only once the run authorizes its first
    // step, so a run deferred by that first check (or never acknowledged) retries later.
    manual.set(id, scheduleDefinition(entry))
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
  // A deferred run never started, so a Run Now request behind it stays queued for later
  // checks (the calendar occurrence is only restored for a 'once' policy). Any other outcome
  // means the run ran, or was given up, and the request must not replay.
  if (status !== 'deferred') manual.delete(scheduleId)
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
    // continues against whatever window the app has now once its main-process work is done.
    if (active && !active.orphanedAt && windowLost(active.window)) orphanRun(active.runId)
    settleOrphanedRun()
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
        // A dispatched Run Now request stays queued until the run authorizes its first step.
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
