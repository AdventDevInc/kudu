import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isExcluded } from './file-utils'

// Mock settings-store to prevent Electron import
vi.mock('./settings-store', () => ({
  getSettings: () => ({
    cleaner: { secureDelete: false, skipRecentMinutes: 60 },
    exclusions: [],
  }),
}))

// Mock scan-cache
vi.mock('./scan-cache', () => ({
  getCachedItems: () => [],
  removeCachedItems: () => {},
}))

describe('isExcluded', () => {
  it('returns false for empty exclusions', () => {
    expect(isExcluded('C:\\temp\\file.txt', [])).toBe(false)
  })

  // Extension glob matching
  it('matches *.log extension pattern', () => {
    expect(isExcluded('C:\\logs\\app.log', ['*.log'])).toBe(true)
  })

  it('matches *.tmp extension pattern', () => {
    expect(isExcluded('C:\\temp\\cache.tmp', ['*.tmp'])).toBe(true)
  })

  it('does not match different extension', () => {
    expect(isExcluded('C:\\temp\\file.txt', ['*.log'])).toBe(false)
  })

  it('extension match is case-insensitive', () => {
    expect(isExcluded('C:\\temp\\file.LOG', ['*.log'])).toBe(true)
    expect(isExcluded('C:\\temp\\file.log', ['*.LOG'])).toBe(true)
  })

  // Path prefix matching
  it('matches exact path prefix', () => {
    expect(isExcluded('C:\\Users\\keep\\file.txt', ['C:\\Users\\keep'])).toBe(true)
  })

  it('matches exact path', () => {
    expect(isExcluded('C:\\Users\\keep', ['C:\\Users\\keep'])).toBe(true)
  })

  it('path prefix match is case-insensitive', () => {
    expect(isExcluded('C:\\USERS\\keep\\file.txt', ['c:\\users\\keep'])).toBe(true)
  })

  it('normalizes forward slashes to backslashes', () => {
    expect(isExcluded('C:/temp/file.log', ['*.log'])).toBe(true)
    expect(isExcluded('C:/Users/keep/file.txt', ['C:/Users/keep'])).toBe(true)
  })

  it('does not match unrelated path', () => {
    expect(isExcluded('D:\\other\\file.txt', ['C:\\Users\\keep'])).toBe(false)
  })

  // Multiple exclusions
  it('matches any of multiple exclusions', () => {
    const exclusions = ['*.log', '*.tmp', 'C:\\protected']
    expect(isExcluded('C:\\temp\\debug.log', exclusions)).toBe(true)
    expect(isExcluded('C:\\temp\\cache.tmp', exclusions)).toBe(true)
    expect(isExcluded('C:\\protected\\data.db', exclusions)).toBe(true)
    expect(isExcluded('C:\\temp\\file.txt', exclusions)).toBe(false)
  })

  // Edge cases
  it('handles deeply nested paths', () => {
    expect(isExcluded('C:\\a\\b\\c\\d\\e\\f.log', ['*.log'])).toBe(true)
  })

  it('extension pattern requires dot', () => {
    // *.log should match .log extension, not just "log" at the end
    expect(isExcluded('C:\\temp\\catalog', ['*.log'])).toBe(false)
  })
})
