import type { ScheduleEntry } from '@shared/types'

/**
 * Calculate the next run time for a schedule entry.
 * Mirrors the logic in src/main/services/scheduler.ts for UI display.
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
