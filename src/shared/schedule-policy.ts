import type { ScheduleEntry } from './types'

export interface ScheduleConditions {
  idleMinutes?: number
  acOnly?: boolean
  pauseForGameMode?: boolean
  /** Local wall-clock minutes since midnight; equal endpoints mean all day. */
  windowStart?: number
  windowEnd?: number
  /** Only run when the home volume has less than this percent free (1-100); 0 or unset is off. */
  freeBelowPercent?: number
}
export interface ScheduleEnvironment {
  idleSeconds: number | null
  onBattery: boolean | null
  gameMode: boolean | null
  freePercent: number | null
}
export type ScheduleWaitingReason =
  | 'idle'
  | 'power'
  | 'game-mode'
  | 'window'
  | 'disk'
  | 'unknown'
  | 'busy'
  | 'disabled'
  | 'changed'
  | 'unavailable'
  | 'interrupted'
export interface ScheduleRuntime {
  id: string
  reason: ScheduleWaitingReason | null
  running: boolean
  evaluatedAt: string
  nextEvaluationAt: string
}

export function validateScheduleConditions(value: unknown): value is ScheduleConditions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const c = value as Record<string, unknown>
  if (
    Object.keys(c).some(
      (k) =>
        ![
          'idleMinutes',
          'acOnly',
          'pauseForGameMode',
          'windowStart',
          'windowEnd',
          'freeBelowPercent'
        ].includes(k)
    )
  )
    return false
  for (const key of ['acOnly', 'pauseForGameMode'])
    if (c[key] !== undefined && typeof c[key] !== 'boolean') return false
  for (const [key, min, max] of [
    ['idleMinutes', 0, 120],
    ['windowStart', 0, 1439],
    ['windowEnd', 0, 1439],
    // The settings UI offers 1-100; a threshold of 0 could never be met, so it is rejected.
    ['freeBelowPercent', 1, 100]
  ] as const)
    if (
      c[key] !== undefined &&
      (!Number.isInteger(c[key]) || Number(c[key]) < min || Number(c[key]) > max)
    )
      return false
  return (c.windowStart === undefined) === (c.windowEnd === undefined)
}

export function scheduleWaitingReason(
  c: ScheduleConditions,
  env: ScheduleEnvironment,
  now: Date
): ScheduleWaitingReason | null {
  if (c.pauseForGameMode !== false) {
    if (env.gameMode === null) return 'unknown'
    if (env.gameMode) return 'game-mode'
  }
  if (c.acOnly) {
    if (env.onBattery === null) return 'unknown'
    if (env.onBattery) return 'power'
  }
  if (c.idleMinutes) {
    if (env.idleSeconds === null) return 'unknown'
    if (env.idleSeconds < c.idleMinutes * 60) return 'idle'
  }
  if (c.windowStart !== undefined && c.windowEnd !== undefined && c.windowStart !== c.windowEnd) {
    const minute = now.getHours() * 60 + now.getMinutes()
    const inside =
      c.windowStart < c.windowEnd
        ? minute >= c.windowStart && minute < c.windowEnd
        : minute >= c.windowStart || minute < c.windowEnd
    if (!inside) return 'window'
  }
  // Stored entries may predate the minimum: a zero threshold is treated as no condition.
  if (c.freeBelowPercent) {
    if (env.freePercent === null) return 'unknown'
    if (env.freePercent >= c.freeBelowPercent) return 'disk'
  }
  return null
}

/** Previous local calendar occurrence. Coalesces an arbitrary backlog to one run. */
export function previousScheduleOccurrence(entry: ScheduleEntry, now: Date): Date {
  const d = new Date(now)
  d.setHours(entry.hour, entry.minute ?? 0, 0, 0)
  if (entry.frequency === 'weekly') {
    d.setDate(d.getDate() - ((d.getDay() - entry.day + 7) % 7))
    if (d > now) d.setDate(d.getDate() - 7)
  } else if (entry.frequency === 'monthly') {
    d.setDate(1)
    const clamp = () =>
      d.setDate(Math.min(entry.day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))
    clamp()
    if (d > now) {
      d.setDate(1)
      d.setMonth(d.getMonth() - 1)
      clamp()
    }
  } else if (d > now) d.setDate(d.getDate() - 1)
  return d
}

/**
 * `waitingForRun` keeps a 'skip' occurrence alive while another schedule holds the
 * execution lock, so two entries due in the same minute both run, in sequence.
 */
export function dueScheduleOccurrence(
  entry: ScheduleEntry,
  now: Date,
  waitingForRun = false
): Date | null {
  if (!entry.enabled) return null
  const due = previousScheduleOccurrence(entry, now)
  const created = Date.parse(entry.createdAt)
  const consumed = Math.max(
    Date.parse(entry.lastDueAt ?? '') || 0,
    Date.parse(entry.lastRunAt ?? '') || 0
  )
  if (due.getTime() <= consumed || (Number.isFinite(created) && due.getTime() < created))
    return null
  if (entry.missedRun !== 'once' && !waitingForRun && now.getTime() - due.getTime() > 2 * 60_000)
    return null
  return due
}

export function nextScheduleOccurrence(entry: ScheduleEntry, now = new Date()): Date | null {
  if (!entry.enabled) return null
  const d = new Date(now)
  d.setHours(entry.hour, entry.minute ?? 0, 0, 0)
  if (entry.frequency === 'weekly') {
    d.setDate(d.getDate() + ((entry.day - d.getDay() + 7) % 7))
    if (d <= now) d.setDate(d.getDate() + 7)
  } else if (entry.frequency === 'monthly') {
    d.setDate(1)
    const clamp = () =>
      d.setDate(Math.min(entry.day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))
    clamp()
    if (d <= now) {
      d.setDate(1)
      d.setMonth(d.getMonth() + 1)
      clamp()
    }
  } else if (d <= now) d.setDate(d.getDate() + 1)
  return d
}

/** A changed definition invalidates an already queued run. Runtime fields do not. */
export function scheduleDefinition(entry: ScheduleEntry): string {
  return JSON.stringify([
    entry.name,
    entry.enabled,
    entry.tasks,
    entry.autoApply,
    entry.conditions,
    entry.cleanerSubcategories,
    entry.frequency,
    entry.day,
    entry.hour,
    entry.minute,
    entry.missedRun
  ])
}
