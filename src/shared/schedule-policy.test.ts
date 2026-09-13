import { describe, expect, it } from 'vitest'
import {
  dueScheduleOccurrence,
  nextScheduleOccurrence,
  scheduleWaitingReason,
  validateScheduleConditions,
  type ScheduleEnvironment
} from './schedule-policy'
import type { ScheduleEntry } from './types'
const entry: ScheduleEntry = {
  id: 'one',
  name: 'Test',
  enabled: true,
  frequency: 'daily',
  day: 1,
  hour: 9,
  minute: 0,
  tasks: ['cleaner:system'],
  autoApply: false,
  lastRunAt: null,
  lastRunStatus: 'never',
  createdAt: '2026-01-01T00:00:00Z'
}
const ready: ScheduleEnvironment = {
  idleSeconds: 900,
  onBattery: false,
  gameMode: false,
  freePercent: 10
}
describe('schedule timing', () => {
  it('never dispatches early and preserves the two-minute skip policy', () => {
    expect(dueScheduleOccurrence(entry, new Date('2026-09-13T08:59:00'))).toBeNull()
    expect(dueScheduleOccurrence(entry, new Date('2026-09-13T09:01:00'))?.getHours()).toBe(9)
    expect(dueScheduleOccurrence(entry, new Date('2026-09-13T09:03:00'))).toBeNull()
  })
  it('keeps a skip occurrence alive while another run holds the lock', () => {
    const later = new Date('2026-09-13T09:05:00')
    expect(dueScheduleOccurrence(entry, later, true)?.getHours()).toBe(9)
    expect(
      dueScheduleOccurrence({ ...entry, lastDueAt: '2026-09-13T09:00:00' }, later, true)
    ).toBeNull()
  })
  it('coalesces missed runs after sleep or reboot without replaying a consumed occurrence', () => {
    const now = new Date('2026-09-13T12:00:00')
    const catchUp = { ...entry, missedRun: 'once' as const }
    const due = dueScheduleOccurrence(catchUp, now)!
    expect(due.toLocaleDateString()).toBe(now.toLocaleDateString())
    expect(dueScheduleOccurrence({ ...catchUp, lastDueAt: due.toISOString() }, now)).toBeNull()
    expect(dueScheduleOccurrence({ ...catchUp, lastRunAt: now.toISOString() }, now)).toBeNull()
  })
  it('does not catch up work predating schedule creation', () => {
    expect(
      dueScheduleOccurrence(
        { ...entry, missedRun: 'once', createdAt: new Date('2026-09-13T10:00:00').toISOString() },
        new Date('2026-09-13T12:00:00')
      )
    ).toBeNull()
  })
  it('handles month-end clamping without skipping February', () => {
    const monthly = { ...entry, frequency: 'monthly' as const, day: 31, missedRun: 'once' as const }
    expect(nextScheduleOccurrence(monthly, new Date('2026-01-31T12:00:00'))?.getMonth()).toBe(1)
    expect(nextScheduleOccurrence(monthly, new Date('2026-01-31T12:00:00'))?.getDate()).toBe(28)
    expect(dueScheduleOccurrence(monthly, new Date('2026-03-01T12:00:00'))?.getDate()).toBe(28)
  })
  it('uses local calendar weeks rather than a fixed-hour interval', () => {
    const weekly = { ...entry, frequency: 'weekly' as const, day: 0 }
    const next = nextScheduleOccurrence(weekly, new Date('2026-03-07T12:00:00'))!
    expect(next.getDay()).toBe(0)
    expect(next.getHours()).toBe(9)
  })
})
describe('schedule conditions', () => {
  it('waits for idle, AC power, Game Mode, and low space independently', () => {
    const now = new Date('2026-09-13T12:00:00')
    expect(scheduleWaitingReason({ idleMinutes: 30 }, ready, now)).toBe('idle')
    expect(scheduleWaitingReason({ acOnly: true }, { ...ready, onBattery: true }, now)).toBe(
      'power'
    )
    expect(scheduleWaitingReason({}, { ...ready, gameMode: true }, now)).toBe('game-mode')
    expect(scheduleWaitingReason({ freeBelowPercent: 5 }, ready, now)).toBe('disk')
    expect(
      scheduleWaitingReason({ acOnly: true, idleMinutes: 5, freeBelowPercent: 20 }, ready, now)
    ).toBeNull()
  })
  it('handles overnight maintenance windows and equal endpoints', () => {
    const c = { windowStart: 22 * 60, windowEnd: 6 * 60 }
    expect(scheduleWaitingReason(c, ready, new Date('2026-09-13T23:00:00'))).toBeNull()
    expect(scheduleWaitingReason(c, ready, new Date('2026-09-14T05:59:00'))).toBeNull()
    expect(scheduleWaitingReason(c, ready, new Date('2026-09-14T06:00:00'))).toBe('window')
    expect(scheduleWaitingReason({ windowStart: 0, windowEnd: 0 }, ready, new Date())).toBeNull()
  })
  it('does not invent healthy measurements when a required condition is unavailable', () => {
    for (const [conditions, missing] of [
      [{ acOnly: true }, { onBattery: null }],
      [{ idleMinutes: 5 }, { idleSeconds: null }],
      [{ freeBelowPercent: 20 }, { freePercent: null }],
      [{}, { gameMode: null }]
    ] as const)
      expect(scheduleWaitingReason(conditions, { ...ready, ...missing }, new Date())).toBe(
        'unknown'
      )
  })
  it('rejects malformed or unbounded condition settings', () => {
    for (const invalid of [
      { idleMinutes: Infinity },
      { idleMinutes: -1 },
      { idleMinutes: 1.5 },
      { windowStart: 60 },
      { windowStart: 0, windowEnd: 1440 },
      { freeBelowPercent: 0 },
      { freeBelowPercent: 101 },
      { command: 'anything' },
      { acOnly: 'true' },
      null
    ])
      expect(validateScheduleConditions(invalid)).toBe(false)
    expect(
      validateScheduleConditions({ acOnly: true, idleMinutes: 10, windowStart: 0, windowEnd: 300 })
    ).toBe(true)
    expect(validateScheduleConditions({ freeBelowPercent: 1 })).toBe(true)
  })
  it('treats a zero or missing free-space threshold as no disk condition', () => {
    const now = new Date(2025, 0, 1, 12, 0)
    const full = { idleSeconds: 0, onBattery: false, gameMode: false, freePercent: 100 }
    expect(scheduleWaitingReason({ freeBelowPercent: 0 }, full, now)).toBeNull()
    expect(scheduleWaitingReason({}, full, now)).toBeNull()
    // Nor does an unreadable disk block a schedule that never asked about it.
    expect(
      scheduleWaitingReason({ freeBelowPercent: 0 }, { ...full, freePercent: null }, now)
    ).toBeNull()
  })
})
