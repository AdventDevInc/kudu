import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'

vi.mock('os', () => ({ homedir: () => '/Users/TestUser', tmpdir: () => '/tmp' }))

const { createDarwinPaths } = await import('./paths')

describe('darwin paths', () => {
  const paths = createDarwinPaths()

  describe('malwareScanDirs', () => {
    const dirs = paths.malwareScanDirs().map(d => d.path)

    it('returns a non-empty array', () => {
      expect(dirs.length).toBeGreaterThan(5)
    })

    it('includes user Downloads and Desktop', () => {
      expect(dirs.some((d) => d.includes('Downloads'))).toBe(true)
      expect(dirs.some((d) => d.includes('Desktop'))).toBe(true)
    })

    it('includes /tmp', () => {
      expect(dirs).toContain('/tmp')
    })

    it('includes user LaunchAgents', () => {
      expect(dirs.some((d) => d.includes('LaunchAgents'))).toBe(true)
    })

    it('includes global LaunchAgents and LaunchDaemons', () => {
      expect(dirs).toContain('/Library/LaunchAgents')
      expect(dirs).toContain('/Library/LaunchDaemons')
    })

    it('includes /usr/local/bin and /opt/local/bin', () => {
      expect(dirs).toContain('/usr/local/bin')
      expect(dirs).toContain('/opt/local/bin')
    })

    it('includes user Documents', () => {
      expect(dirs.some((d) => d.includes('Documents'))).toBe(true)
    })
  })

  describe('malwareSystemDirs', () => {
    const dirs = paths.malwareSystemDirs()

    it('returns a non-empty array', () => {
      expect(dirs.length).toBeGreaterThan(0)
    })

    it('includes /System and /usr', () => {
      expect(dirs).toContain('/System')
      expect(dirs).toContain('/usr')
    })

    it('includes /Library and /Applications', () => {
      expect(dirs).toContain('/Library')
      expect(dirs).toContain('/Applications')
    })
  })

  describe('uninstallLeftoverDirs', () => {
    const dirs = paths.uninstallLeftoverDirs()

    it('includes Application Support, Caches, and Preferences', () => {
      const ids = dirs.map((d) => d.id)
      expect(ids).toContain('app-support')
      expect(ids).toContain('caches')
      expect(ids).toContain('preferences')
    })

    it('each entry has an id, name, and path', () => {
      for (const dir of dirs) {
        expect(dir.id).toBeTruthy()
        expect(dir.name).toBeTruthy()
        expect(dir.path).toBeTruthy()
      }
    })

    it('paths are rooted under ~/Library', () => {
      const expectedPrefix = join('/Users/TestUser', 'Library')
      for (const dir of dirs) {
        expect(dir.path).toContain(expectedPrefix)
      }
    })
  })
})
