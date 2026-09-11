import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/test-kudu'
  }
}))

import { validateBlacklist } from './threat-blacklist-store'

describe('validateBlacklist', () => {
  const validBlacklist = {
    version: '1.0.0',
    updatedAt: '2025-01-01T00:00:00Z',
    domains: ['malware.example.com'],
    ips: ['1.2.3.4'],
    cidrs: ['10.0.0.0/8']
  }

  it('accepts a valid blacklist', () => {
    const result = validateBlacklist(validBlacklist)
    expect(result).not.toBeNull()
    expect(result!.version).toBe('1.0.0')
    expect(result!.domains).toHaveLength(1)
    expect(result!.ips).toHaveLength(1)
    expect(result!.cidrs).toHaveLength(1)
  })

  it('accepts empty arrays', () => {
    const result = validateBlacklist({
      ...validBlacklist,
      domains: [],
      ips: [],
      cidrs: []
    })
    expect(result).not.toBeNull()
  })

  it('rejects null', () => {
    expect(validateBlacklist(null)).toBeNull()
  })

  it('rejects non-object', () => {
    expect(validateBlacklist('string')).toBeNull()
    expect(validateBlacklist(42)).toBeNull()
  })

  it('rejects arrays', () => {
    expect(validateBlacklist([])).toBeNull()
  })

  it('rejects missing version', () => {
    expect(validateBlacklist({ ...validBlacklist, version: undefined })).toBeNull()
  })

  it('rejects empty version', () => {
    expect(validateBlacklist({ ...validBlacklist, version: '' })).toBeNull()
  })

  it('rejects version > 100 chars', () => {
    expect(validateBlacklist({ ...validBlacklist, version: 'a'.repeat(101) })).toBeNull()
  })

  it('rejects missing updatedAt', () => {
    expect(validateBlacklist({ ...validBlacklist, updatedAt: undefined })).toBeNull()
  })

  it('rejects non-array domains', () => {
    expect(validateBlacklist({ ...validBlacklist, domains: 'not-array' })).toBeNull()
  })

  it('rejects non-array ips', () => {
    expect(validateBlacklist({ ...validBlacklist, ips: {} })).toBeNull()
  })

  it('rejects non-array cidrs', () => {
    expect(validateBlacklist({ ...validBlacklist, cidrs: 123 })).toBeNull()
  })

  it('rejects non-string entries in domains', () => {
    expect(validateBlacklist({ ...validBlacklist, domains: [123] })).toBeNull()
  })

  it('rejects empty string entries', () => {
    expect(validateBlacklist({ ...validBlacklist, domains: [''] })).toBeNull()
  })

  it('rejects entries > 500 chars', () => {
    expect(validateBlacklist({ ...validBlacklist, ips: ['a'.repeat(501)] })).toBeNull()
  })

  it('rejects arrays exceeding 500,000 entries', () => {
    const huge = Array(500_001).fill('x')
    expect(validateBlacklist({ ...validBlacklist, domains: huge })).toBeNull()
  })
})
