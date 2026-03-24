import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'

// Stub os.homedir before importing the module under test
vi.mock('os', () => ({ homedir: () => '/home/testuser', tmpdir: () => '/tmp' }))

const { createLinuxPaths } = await import('./paths')

const HOME = join('/home', 'testuser')

describe('linux paths', () => {
  const paths = createLinuxPaths()

  describe('malwareScanDirs', () => {
    const dirs = paths.malwareScanDirs()

    it('returns an array of scan directories', () => {
      expect(dirs.length).toBeGreaterThanOrEqual(3)
    })

    it('includes user Downloads and Desktop', () => {
      expect(dirs.some((d) => d.includes('Downloads'))).toBe(true)
      expect(dirs.some((d) => d.includes('Desktop'))).toBe(true)
    })

    it('includes user Documents', () => {
      expect(dirs.some((d) => d.includes('Documents'))).toBe(true)
    })

    it('includes /tmp', () => {
      expect(dirs).toContain('/tmp')
    })

    it('all user paths are under the home directory', () => {
      for (const d of dirs) {
        if (d !== '/tmp') {
          expect(d.startsWith(HOME)).toBe(true)
        }
      }
    })
  })

  describe('malwareSystemDirs', () => {
    const dirs = paths.malwareSystemDirs()

    it('includes standard system directories', () => {
      expect(dirs).toContain('/usr')
      expect(dirs).toContain('/lib')
      expect(dirs).toContain('/sbin')
      expect(dirs).toContain('/bin')
      expect(dirs).toContain('/opt')
    })

    it('includes /lib64', () => {
      expect(dirs).toContain('/lib64')
    })
  })

  describe('uninstallLeftoverDirs', () => {
    const dirs = paths.uninstallLeftoverDirs()

    it('includes config, cache, and data directories', () => {
      const ids = dirs.map((d) => d.id)
      expect(ids).toContain('config')
      expect(ids).toContain('cache')
      expect(ids).toContain('local-share')
    })

    it('each entry has an id, name, and path', () => {
      for (const dir of dirs) {
        expect(dir.id).toBeTruthy()
        expect(dir.name).toBeTruthy()
        expect(dir.path).toBeTruthy()
      }
    })

    it('config points to ~/.config', () => {
      const config = dirs.find((d) => d.id === 'config')
      expect(config!.path).toBe(join(HOME, '.config'))
    })

    it('cache points to ~/.cache', () => {
      const cache = dirs.find((d) => d.id === 'cache')
      expect(cache!.path).toBe(join(HOME, '.cache'))
    })

    it('data points to ~/.local/share', () => {
      const data = dirs.find((d) => d.id === 'local-share')
      expect(data!.path).toBe(join(HOME, '.local', 'share'))
    })
  })
})
