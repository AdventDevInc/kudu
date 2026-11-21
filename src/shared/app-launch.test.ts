import { describe, expect, it } from 'vitest'
import { appLaunchKey, validateAppPolicy } from './app-launch'

describe('application launch day policy', () => {
  it('accepts only valid days and frequencies', () => {
    expect(validateAppPolicy({ days: [6, 0, 6], frequency: 'weekly' }).days).toEqual([6, 0])
    for (const value of [
      null,
      {},
      { days: [], frequency: 'daily' },
      { days: [7], frequency: 'weekly' },
      { days: [1.5], frequency: 'weekly' },
      { days: [1], frequency: 'sometimes' }
    ]) {
      expect(() => validateAppPolicy(value)).toThrow()
    }
  })
  it('supports daily selections without catching up on another weekday', () => {
    const policy = { days: [1, 3, 5], frequency: 'daily' as const }
    expect(appLaunchKey(new Date(2026, 0, 5, 12), policy)).toBe('day-2026-01-05')
    expect(appLaunchKey(new Date(2026, 0, 6, 12), policy)).toBeNull()
    expect(appLaunchKey(new Date(2026, 0, 7, 12), policy)).toBe('day-2026-01-07')
  })
  it('uses a single Monday-based week across years and daylight-saving changes', () => {
    const policy = { days: [6, 0], frequency: 'weekly' as const }
    expect(appLaunchKey(new Date(2022, 11, 31, 12), policy)).toBe(
      appLaunchKey(new Date(2023, 0, 1, 12), policy)
    )
    expect(appLaunchKey(new Date(2026, 2, 28, 12), policy)).toBe(
      appLaunchKey(new Date(2026, 2, 29, 12), policy)
    )
    expect(appLaunchKey(new Date(NaN), policy)).toBeNull()
  })
})
