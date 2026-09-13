import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ScheduleEntry } from '../../shared/types'
const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => state.directory },
  safeStorage: { isEncryptionAvailable: () => false }
}))
import {
  setSettings,
  getSettings,
  flushSettings,
  claimScheduleOccurrence,
  updateScheduleEntry
} from './settings-store'
const entry: ScheduleEntry = {
  id: 'one',
  name: 'Test',
  enabled: true,
  frequency: 'daily',
  day: 1,
  hour: 9,
  tasks: ['cleaner:system'],
  autoApply: true,
  lastRunAt: null,
  lastRunStatus: 'never',
  createdAt: '2026-01-01',
  missedRun: 'once',
  conditions: { acOnly: true }
}
beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'kudu-schedule-test-'))
  setSettings({ schedules: [entry] })
  await flushSettings()
})
afterEach(async () => {
  await flushSettings()
  await rm(state.directory, { recursive: true, force: true })
})
it('consumes one occurrence atomically even when two callers race', async () => {
  const due = '2026-09-13T09:00:00Z'
  expect(
    await Promise.all([claimScheduleOccurrence(entry, due), claimScheduleOccurrence(entry, due)])
  ).toEqual([true, false])
  expect(getSettings().schedules[0].lastDueAt).toBe(due)
})
it('preserves main-owned runtime when a stale editor saves new options', async () => {
  await claimScheduleOccurrence(entry, '2026-09-13T09:00:00Z')
  updateScheduleEntry('one', { lastRunAt: '2026-09-13T09:01:00Z', lastRunStatus: 'partial' })
  await flushSettings()
  setSettings({ schedules: [{ ...entry, conditions: { idleMinutes: 10 } }] })
  await flushSettings()
  expect(getSettings().schedules[0]).toMatchObject({
    lastDueAt: '2026-09-13T09:00:00Z',
    lastRunStatus: 'partial',
    conditions: { idleMinutes: 10 }
  })
})
it('rejects dispatch when a schedule was disabled or edited during a condition query', async () => {
  setSettings({ schedules: [{ ...entry, enabled: false }] })
  await flushSettings()
  expect(await claimScheduleOccurrence(entry, '2026-09-13T09:00:00Z')).toBe(false)
  setSettings({ schedules: [{ ...entry, tasks: ['registry'] }] })
  await flushSettings()
  expect(await claimScheduleOccurrence(entry, '2026-09-13T09:00:00Z')).toBe(false)
})
