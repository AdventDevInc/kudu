import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Initialize i18next with English translations so formatDate's i18next.t() calls work
import i18next from 'i18next'
i18next.init({
  lng: 'en',
  resources: {
    en: {
      common: {
        justNow: 'Just now',
        minutesAgo: '{{minutes}}m ago',
        hoursAgo: '{{hours}}h ago',
        daysAgo: '{{days}}d ago'
      }
    }
  },
  defaultNS: 'common'
})

import { formatBytes, formatNumber, formatSpeed, formatDate } from './utils'

describe('formatBytes', () => {
  it('returns "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB')
  })

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB')
  })

  it('formats terabytes', () => {
    expect(formatBytes(1099511627776)).toBe('1 TB')
  })

  it('respects custom decimal places', () => {
    expect(formatBytes(1536, 0)).toBe('2 KB')
    expect(formatBytes(1536, 3)).toBe('1.5 KB')
  })
})

describe('formatNumber', () => {
  it('formats numbers with locale separators', () => {
    // Result depends on locale, just verify it returns a string
    const result = formatNumber(1234567)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('formatSpeed', () => {
  it('returns "0 B/s" for zero or negative', () => {
    expect(formatSpeed(0)).toBe('0 B/s')
    expect(formatSpeed(-100)).toBe('0 B/s')
  })

  it('formats bytes per second', () => {
    expect(formatSpeed(500)).toBe('500 B/s')
  })

  it('formats kilobytes per second', () => {
    expect(formatSpeed(1024)).toBe('1 KB/s')
  })

  it('formats megabytes per second', () => {
    expect(formatSpeed(1048576)).toBe('1 MB/s')
  })

  it('formats gigabytes per second', () => {
    expect(formatSpeed(1073741824)).toBe('1 GB/s')
  })
})

describe('formatDate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "Just now" for very recent timestamps', () => {
    const now = new Date('2025-06-15T12:00:00Z')
    expect(formatDate(now)).toBe('Just now')
  })

  it('returns minutes ago', () => {
    const fiveMinAgo = new Date('2025-06-15T11:55:00Z')
    expect(formatDate(fiveMinAgo)).toBe('5m ago')
  })

  it('returns hours ago', () => {
    const threeHoursAgo = new Date('2025-06-15T09:00:00Z')
    expect(formatDate(threeHoursAgo)).toBe('3h ago')
  })

  it('returns days ago', () => {
    const twoDaysAgo = new Date('2025-06-13T12:00:00Z')
    expect(formatDate(twoDaysAgo)).toBe('2d ago')
  })

  it('returns locale date string for old dates', () => {
    const oldDate = new Date('2024-01-01T00:00:00Z')
    const result = formatDate(oldDate)
    // Should not contain "ago"
    expect(result).not.toContain('ago')
  })

  it('accepts string dates', () => {
    const result = formatDate('2025-06-15T11:50:00Z')
    expect(result).toBe('10m ago')
  })
})
