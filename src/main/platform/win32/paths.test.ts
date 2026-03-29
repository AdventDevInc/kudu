import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub os.homedir before importing the module under test
vi.mock('os', () => ({ homedir: () => 'C:\\Users\\TestUser', tmpdir: () => 'C:\\Users\\TestUser\\AppData\\Local\\Temp' }))

// Set deterministic env vars before import
process.env.LOCALAPPDATA = 'C:\\Users\\TestUser\\AppData\\Local'
process.env.APPDATA = 'C:\\Users\\TestUser\\AppData\\Roaming'
process.env.WINDIR = 'C:\\Windows'
process.env.ProgramData = 'C:\\ProgramData'
process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)'
process.env.ProgramFiles = 'C:\\Program Files'
process.env.USERPROFILE = 'C:\\Users\\TestUser'

const { createWin32Paths } = await import('./paths')

describe('win32 paths', () => {
  const paths = createWin32Paths()

  describe('systemCleanTargets', () => {
    const targets = paths.systemCleanTargets()

    it('returns an array of clean targets', () => {
      expect(targets.length).toBeGreaterThan(10)
    })

    it('includes user temp files under LOCALAPPDATA\\Temp', () => {
      const userTemp = targets.find((t) => t.subcategory === 'User Temp Files')
      expect(userTemp).toBeDefined()
      expect(userTemp!.path).toBe('C:\\Users\\TestUser\\AppData\\Local\\Temp')
    })

    it('includes system temp files under WINDIR\\Temp', () => {
      const sysTemp = targets.find((t) => t.subcategory === 'System Temp Files')
      expect(sysTemp).toBeDefined()
      expect(sysTemp!.path).toBe('C:\\Windows\\Temp')
    })

    it('marks system-level targets as needsAdmin', () => {
      const prefetch = targets.find((t) => t.subcategory === 'Prefetch Data')
      expect(prefetch).toBeDefined()
      expect(prefetch!.needsAdmin).toBe(true)
    })

    it('does not mark user-level targets as needsAdmin', () => {
      const userTemp = targets.find((t) => t.subcategory === 'User Temp Files')
      expect(userTemp!.needsAdmin).toBeUndefined()
    })

    it('includes Windows Update Cache and Delivery Optimization', () => {
      const wuCache = targets.find((t) => t.subcategory === 'Windows Update Cache')
      const doCach = targets.find((t) => t.subcategory === 'Delivery Optimization Cache')
      expect(wuCache).toBeDefined()
      expect(doCach).toBeDefined()
      expect(wuCache!.needsAdmin).toBe(true)
    })

    it('includes Previous Windows Installation (Windows.old)', () => {
      const old = targets.find((t) => t.subcategory === 'Previous Windows Installation')
      expect(old).toBeDefined()
      expect(old!.path).toBe('C:\\Windows.old')
      expect(old!.needsAdmin).toBe(true)
    })

    it('every target has a non-empty path and subcategory', () => {
      for (const target of targets) {
        expect(target.path).toBeTruthy()
        expect(target.subcategory).toBeTruthy()
      }
    })
  })

  describe('singleFileCleanTargets', () => {
    it('includes the full memory dump file', () => {
      const targets = paths.singleFileCleanTargets()
      expect(targets.length).toBeGreaterThanOrEqual(1)
      const dumpTarget = targets.find(t => t.path.includes('MEMORY.DMP'))
      expect(dumpTarget).toBeDefined()
      expect(dumpTarget!.subcategory).toBe('Full Memory Dump')
    })
  })

  describe('protectedEventLogs', () => {
    const logs = paths.protectedEventLogs()

    it('returns a non-empty array', () => {
      expect(logs.length).toBeGreaterThan(5)
    })

    it('includes the Security event log', () => {
      expect(logs).toContain('security.evtx')
    })

    it('includes System and Application logs', () => {
      expect(logs).toContain('system.evtx')
      expect(logs).toContain('application.evtx')
    })

    it('includes Sysmon operational log', () => {
      expect(logs.some((l) => l.includes('sysmon'))).toBe(true)
    })

    it('all entries are .evtx files', () => {
      for (const log of logs) {
        expect(log.endsWith('.evtx')).toBe(true)
      }
    })
  })

  describe('browserPaths', () => {
    const browsers = paths.browserPaths()

    it('has paths for Chrome, Edge, Brave, Firefox, and others', () => {
      expect(browsers.chrome.base).toContain('Google')
      expect(browsers.edge.base).toContain('Edge')
      expect(browsers.brave.base).toContain('Brave')
      expect(browsers.firefox.base).toContain('Mozilla')
    })

    it('Chromium browsers have consistent cache dir names', () => {
      const chromiumBrowsers = [browsers.chrome, browsers.edge, browsers.brave, browsers.vivaldi, browsers.arc, browsers.chromium]
      for (const b of chromiumBrowsers) {
        expect(b.cache).toBe('Cache\\Cache_Data')
        expect(b.codeCache).toBe('Code Cache')
        expect(b.gpuCache).toBe('GPUCache')
        expect(b.serviceWorker).toBe('Service Worker\\CacheStorage')
      }
    })

    it('Safari is null on Windows', () => {
      expect(browsers.safari).toBeNull()
    })

    it('Firefox has separate base and cache paths', () => {
      expect(browsers.firefox.base).toContain('Roaming')
      expect(browsers.firefox.cache).toContain('Local')
    })
  })

  describe('appPaths', () => {
    const apps = paths.appPaths()

    it('returns multiple app definitions', () => {
      expect(apps.length).toBeGreaterThan(15)
    })

    it('each app has a unique id', () => {
      const ids = apps.map((a) => a.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('each app has at least one path', () => {
      for (const app of apps) {
        expect(app.paths.length).toBeGreaterThanOrEqual(1)
      }
    })

    it('includes common apps (Discord, VS Code, npm)', () => {
      const ids = apps.map((a) => a.id)
      expect(ids).toContain('discord')
      expect(ids).toContain('vscode')
      expect(ids).toContain('npm')
    })
  })

  describe('gamingPaths', () => {
    const gaming = paths.gamingPaths()

    it('includes Steam, Epic, EA, and others', () => {
      const ids = gaming.map((g) => g.id)
      expect(ids).toContain('steam')
      expect(ids).toContain('epic')
      expect(ids).toContain('ea')
    })
  })

  describe('gpuCachePaths', () => {
    const gpuPaths = paths.gpuCachePaths()

    it('includes NVIDIA, AMD, and Intel', () => {
      const ids = gpuPaths.map((g) => g.id)
      expect(ids).toContain('nvidia')
      expect(ids).toContain('amd')
      expect(ids).toContain('intel')
    })
  })

  describe('malwareScanDirs', () => {
    const dirs = paths.malwareScanDirs().map(d => d.path)

    it('includes user Downloads and Desktop', () => {
      expect(dirs.some((d) => d.includes('Downloads'))).toBe(true)
      expect(dirs.some((d) => d.includes('Desktop'))).toBe(true)
    })

    it('includes Temp and AppData', () => {
      expect(dirs.some((d) => d.includes('Temp'))).toBe(true)
      expect(dirs.some((d) => d.includes('AppData'))).toBe(true)
    })
  })

  describe('malwareSystemDirs', () => {
    const dirs = paths.malwareSystemDirs()

    it('includes system32 and syswow64', () => {
      expect(dirs.some((d) => d.includes('system32'))).toBe(true)
      expect(dirs.some((d) => d.includes('syswow64'))).toBe(true)
    })

    it('all paths are lowercase', () => {
      for (const d of dirs) {
        expect(d).toBe(d.toLowerCase())
      }
    })
  })

  describe('uninstallLeftoverDirs', () => {
    const dirs = paths.uninstallLeftoverDirs()

    it('includes major Windows directories', () => {
      const ids = dirs.map((d) => d.id)
      expect(ids).toContain('localappdata')
      expect(ids).toContain('appdata')
      expect(ids).toContain('programfiles')
      expect(ids).toContain('programfiles-x86')
      expect(ids).toContain('programdata')
    })

    it('each entry has an id, name, and path', () => {
      for (const dir of dirs) {
        expect(dir.id).toBeTruthy()
        expect(dir.name).toBeTruthy()
        expect(dir.path).toBeTruthy()
      }
    })
  })

  describe('steamLibraries', () => {
    it('includes the default x86 Steam path', () => {
      const libs = paths.steamLibraries()
      expect(libs[0]).toContain('Steam')
    })
  })

  describe('steamRedistPatterns', () => {
    it('includes _CommonRedist and vcredist', () => {
      const patterns = paths.steamRedistPatterns()
      expect(patterns).toContain('_CommonRedist')
      expect(patterns).toContain('vcredist')
    })
  })

  describe('trashPath', () => {
    it('returns null on Windows (managed via COM)', () => {
      expect(paths.trashPath()).toBeNull()
    })
  })
})
