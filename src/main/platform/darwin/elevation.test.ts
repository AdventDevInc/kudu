import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createDarwinElevation } = await import('./elevation')

describe('darwin elevation', () => {
  const elevation = createDarwinElevation()

  describe('isAdmin', () => {
    const originalGetuid = process.getuid

    beforeEach(() => {
      // Restore after each test
      process.getuid = originalGetuid
    })

    it('returns true when uid is 0 (root)', () => {
      process.getuid = (() => 0) as any
      expect(elevation.isAdmin()).toBe(true)
    })

    it('returns false when uid is non-zero', () => {
      process.getuid = (() => 501) as any
      expect(elevation.isAdmin()).toBe(false)
    })

    it('returns false when getuid is undefined', () => {
      process.getuid = undefined as any
      expect(elevation.isAdmin()).toBe(false)
    })
  })
})
