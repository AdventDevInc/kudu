import { describe, it, expect, vi } from 'vitest'

// Mock Electron before importing the module
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/test-kudu'
  }
}))

import { deepMerge } from './settings-store'

describe('deepMerge', () => {
  it('merges flat properties', () => {
    const target = { a: 1, b: 2 }
    const source = { b: 3 }
    expect(deepMerge(target, source)).toEqual({ a: 1, b: 3 })
  })

  it('does not mutate target', () => {
    const target = { a: 1, b: 2 }
    const source = { b: 3 }
    deepMerge(target, source)
    expect(target).toEqual({ a: 1, b: 2 })
  })

  it('deep merges nested objects', () => {
    const target = { cleaner: { secureDelete: false, skipRecentMinutes: 60 } }
    const source = { cleaner: { secureDelete: true } }
    const result = deepMerge(target, source as any)
    expect(result.cleaner.secureDelete).toBe(true)
    expect(result.cleaner.skipRecentMinutes).toBe(60)
  })

  it('replaces arrays instead of merging', () => {
    const target = { exclusions: ['a', 'b'] }
    const source = { exclusions: ['c'] }
    expect(deepMerge(target, source)).toEqual({ exclusions: ['c'] })
  })

  it('handles null source values by replacing', () => {
    const target = { a: { nested: 1 } }
    const source = { a: null }
    const result = deepMerge(target, source as any)
    expect(result.a).toBeNull()
  })

  it('ignores undefined source values', () => {
    const target = { a: 1, b: 2 }
    const source = { a: undefined }
    expect(deepMerge(target, source)).toEqual({ a: 1, b: 2 })
  })

  it('handles deeply nested merging', () => {
    const target = {
      level1: {
        level2: {
          a: 1,
          b: 2
        }
      }
    }
    const source = {
      level1: {
        level2: {
          b: 99
        }
      }
    }
    const result = deepMerge(target, source as any)
    expect(result.level1.level2.a).toBe(1)
    expect(result.level1.level2.b).toBe(99)
  })

  it('handles settings-shaped data correctly', () => {
    const defaults = {
      minimizeToTray: false,
      showNotificationOnComplete: true,
      cleaner: {
        skipRecentMinutes: 60,
        secureDelete: false
      },
      exclusions: [] as string[],
      schedule: {
        enabled: false,
        frequency: 'weekly',
        day: 1,
        hour: 9
      }
    }
    const partial = {
      minimizeToTray: true,
      cleaner: { secureDelete: true },
      schedule: { enabled: true, hour: 14 }
    }

    const result = deepMerge(defaults, partial as any)
    expect(result.minimizeToTray).toBe(true)
    expect(result.showNotificationOnComplete).toBe(true)
    expect(result.cleaner.secureDelete).toBe(true)
    expect(result.cleaner.skipRecentMinutes).toBe(60)
    expect(result.schedule.enabled).toBe(true)
    expect(result.schedule.hour).toBe(14)
    expect(result.schedule.frequency).toBe('weekly')
    expect(result.schedule.day).toBe(1)
    expect(result.exclusions).toEqual([])
  })
})
