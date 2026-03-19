import { describe, it, expect } from 'vitest'
import { validateSettingsPartial, validateHistoryEntry } from './ipc-validation'

describe('validateSettingsPartial', () => {
  it('accepts valid boolean settings', () => {
    const input = { minimizeToTray: true, autoUpdate: false }
    expect(validateSettingsPartial(input)).toEqual(input)
  })

  it('rejects null', () => {
    expect(validateSettingsPartial(null)).toBeNull()
  })

  it('rejects arrays', () => {
    expect(validateSettingsPartial([1, 2])).toBeNull()
  })

  it('rejects primitives', () => {
    expect(validateSettingsPartial('string')).toBeNull()
    expect(validateSettingsPartial(42)).toBeNull()
  })

  it('rejects unknown top-level keys', () => {
    expect(validateSettingsPartial({ hackerField: true })).toBeNull()
  })

  it('rejects wrong types for boolean fields', () => {
    expect(validateSettingsPartial({ minimizeToTray: 'yes' })).toBeNull()
    expect(validateSettingsPartial({ runAtStartup: 1 })).toBeNull()
  })

  it('accepts valid exclusions array', () => {
    const input = { exclusions: ['C:\\keep', '*.log'] }
    expect(validateSettingsPartial(input)).toEqual(input)
  })

  it('rejects non-array exclusions', () => {
    expect(validateSettingsPartial({ exclusions: 'C:\\keep' })).toBeNull()
  })

  it('rejects exclusions with non-string entries', () => {
    expect(validateSettingsPartial({ exclusions: [123] })).toBeNull()
  })

  it('rejects too many exclusions', () => {
    const exclusions = Array.from({ length: 201 }, (_, i) => `path-${i}`)
    expect(validateSettingsPartial({ exclusions })).toBeNull()
  })

  it('rejects empty string exclusions', () => {
    expect(validateSettingsPartial({ exclusions: [''] })).toBeNull()
  })

  it('rejects overly long exclusion strings', () => {
    expect(validateSettingsPartial({ exclusions: ['x'.repeat(501)] })).toBeNull()
  })

  it('accepts valid schedule', () => {
    const input = { schedule: { enabled: true, frequency: 'daily', day: 0, hour: 9 } }
    expect(validateSettingsPartial(input)).toEqual(input)
  })

  it('rejects invalid schedule frequency', () => {
    expect(validateSettingsPartial({ schedule: { frequency: 'yearly' } })).toBeNull()
  })

  it('rejects out-of-range schedule hour', () => {
    expect(validateSettingsPartial({ schedule: { hour: 24 } })).toBeNull()
    expect(validateSettingsPartial({ schedule: { hour: -1 } })).toBeNull()
  })

  it('rejects out-of-range schedule day', () => {
    expect(validateSettingsPartial({ schedule: { day: 7 } })).toBeNull()
  })

  it('rejects schedule as array', () => {
    expect(validateSettingsPartial({ schedule: [] })).toBeNull()
  })

  it('rejects unknown schedule keys', () => {
    expect(validateSettingsPartial({ schedule: { enabled: true, foo: 'bar' } })).toBeNull()
  })

  it('accepts valid cleaner settings', () => {
    const input = { cleaner: { skipRecentMinutes: 120, secureDelete: true } }
    expect(validateSettingsPartial(input)).toEqual(input)
  })

  it('rejects cleaner with invalid skipRecentMinutes', () => {
    expect(validateSettingsPartial({ cleaner: { skipRecentMinutes: -1 } })).toBeNull()
    expect(validateSettingsPartial({ cleaner: { skipRecentMinutes: 600000 } })).toBeNull()
  })

  it('rejects cleaner with wrong boolean types', () => {
    expect(validateSettingsPartial({ cleaner: { secureDelete: 'yes' } })).toBeNull()
  })

  it('rejects unknown cleaner keys', () => {
    expect(validateSettingsPartial({ cleaner: { unknownKey: true } })).toBeNull()
  })

  it('accepts empty object', () => {
    expect(validateSettingsPartial({})).toEqual({})
  })

  it('accepts valid schedules array', () => {
    const input = {
      schedules: [{
        id: 'abc-123',
        name: 'Weekly Clean',
        enabled: true,
        frequency: 'weekly',
        day: 1,
        hour: 9,
        tasks: ['cleaner:system', 'cleaner:browsers'],
        autoApply: false,
        lastRunAt: null,
        lastRunStatus: 'never',
        createdAt: '2025-01-01T00:00:00Z'
      }]
    }
    expect(validateSettingsPartial(input)).toEqual(input)
  })

  it('rejects schedules with invalid task types', () => {
    expect(validateSettingsPartial({
      schedules: [{
        id: 'x', name: 'X', enabled: true, frequency: 'daily', day: 0, hour: 9,
        tasks: ['badtask'], autoApply: false, lastRunAt: null, lastRunStatus: 'never', createdAt: '2025-01-01T00:00:00Z'
      }]
    })).toBeNull()
  })

  it('rejects non-array schedules', () => {
    expect(validateSettingsPartial({ schedules: 'not-array' })).toBeNull()
  })

  it('rejects too many schedules', () => {
    const schedules = Array.from({ length: 11 }, (_, i) => ({
      id: `id-${i}`, name: `S${i}`, enabled: true, frequency: 'daily', day: 0, hour: 9,
      tasks: ['cleaner:system'], autoApply: false, lastRunAt: null, lastRunStatus: 'never', createdAt: '2025-01-01T00:00:00Z'
    }))
    expect(validateSettingsPartial({ schedules })).toBeNull()
  })

  it('rejects schedule entry with missing fields', () => {
    expect(validateSettingsPartial({
      schedules: [{ id: 'x', name: 'X' }]
    })).toBeNull()
  })
})

describe('validateHistoryEntry', () => {
  const validEntry = {
    id: 'entry-1',
    type: 'cleaner',
    timestamp: '2025-01-01T00:00:00Z',
    duration: 5000,
    totalItemsFound: 100,
    totalItemsCleaned: 90,
    totalItemsSkipped: 10,
    totalSpaceSaved: 1048576,
    errorCount: 0,
    categories: [{ name: 'Temp Files', itemsFound: 50, itemsCleaned: 45, spaceSaved: 524288 }],
  }

  it('accepts a valid history entry', () => {
    expect(validateHistoryEntry(validEntry)).toEqual(validEntry)
  })

  it('rejects null', () => {
    expect(validateHistoryEntry(null)).toBeNull()
  })

  it('rejects non-object', () => {
    expect(validateHistoryEntry('string')).toBeNull()
  })

  it('rejects invalid type values', () => {
    expect(validateHistoryEntry({ ...validEntry, type: 'unknown' })).toBeNull()
  })

  it('accepts all valid type values', () => {
    for (const type of ['cleaner', 'registry', 'debloater', 'network', 'drivers']) {
      expect(validateHistoryEntry({ ...validEntry, type })).not.toBeNull()
    }
  })

  it('rejects negative duration', () => {
    expect(validateHistoryEntry({ ...validEntry, duration: -1 })).toBeNull()
  })

  it('rejects overly long id', () => {
    expect(validateHistoryEntry({ ...validEntry, id: 'x'.repeat(101) })).toBeNull()
  })

  it('rejects non-array categories', () => {
    expect(validateHistoryEntry({ ...validEntry, categories: 'none' })).toBeNull()
  })

  it('rejects too many categories', () => {
    const categories = Array.from({ length: 51 }, (_, i) => ({
      name: `cat-${i}`,
      itemsFound: 1,
      itemsCleaned: 1,
      spaceSaved: 100,
    }))
    expect(validateHistoryEntry({ ...validEntry, categories })).toBeNull()
  })

  it('rejects missing required fields', () => {
    const { id, ...noId } = validEntry
    expect(validateHistoryEntry(noId)).toBeNull()
  })
})
