import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExistsSync = vi.fn()
vi.mock('fs', () => ({ existsSync: (...args: unknown[]) => mockExistsSync(...args) }))

const mockReaddir = vi.fn()
vi.mock('fs/promises', () => ({ readdir: (...args: unknown[]) => mockReaddir(...args) }))

import { join } from 'path'
import {
  BROWSER_CACHE_RECENCY,
  chromiumBrowsers,
  chromiumCacheTargets,
  getChromiumProfiles,
} from './chromium-cache'
import type { BrowserPathConfig } from '../platform/types'

const PROFILE_CACHES = [
  { dir: 'Cache', label: 'Cache' },
  { dir: 'Code Cache', label: 'Code Cache' },
]
const SHARED_CACHES = [
  { dir: 'component_crx_cache', label: 'Component Extension Cache' },
  { dir: 'GrShaderCache', label: 'Skia Shader Cache' },
]

function browser(base: string) {
  return { base, profileCaches: PROFILE_CACHES, sharedCaches: SHARED_CACHES }
}

function makePaths(): BrowserPathConfig {
  const keys = ['chrome', 'edge', 'brave', 'opera', 'operaGX', 'vivaldi', 'arc', 'chromium', 'thorium', 'supermium', 'helium', 'cromite', 'catsxp']
  const config: Record<string, unknown> = {}
  for (const key of keys) config[key] = browser(`/fake/${key}`)
  config.firefox = { base: '/fake/ff', cache: '/fake/ff-cache' }
  config.safari = null
  return config as unknown as BrowserPathConfig
}

describe('chromiumBrowsers', () => {
  it('pairs every known browser with its resolved paths', () => {
    const browsers = chromiumBrowsers(makePaths())
    expect(browsers).toHaveLength(13)
    expect(browsers.find((b) => b.key === 'chrome')?.label).toBe('Chrome')
    expect(browsers.find((b) => b.key === 'chrome')?.base).toBe('/fake/chrome')
  })

  it('marks only the Opera family as profile-less', () => {
    const profileLess = chromiumBrowsers(makePaths()).filter((b) => !b.hasProfiles).map((b) => b.key)
    expect(profileLess).toEqual(['opera', 'operaGX'])
  })

  it('skips browsers the platform rules do not define', () => {
    const partial = { chrome: browser('/fake/chrome') } as unknown as BrowserPathConfig
    expect(chromiumBrowsers(partial).map((b) => b.key)).toEqual(['chrome'])
  })
})

describe('chromiumCacheTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReaddir.mockResolvedValue([])
  })

  const chrome = { key: 'chrome', label: 'Chrome', hasProfiles: true, ...browser('/fake/chrome') }

  it('returns nothing when the browser is not installed', async () => {
    mockExistsSync.mockReturnValue(false)
    expect(await chromiumCacheTargets(chrome)).toEqual([])
  })

  it('labels per-profile caches with the profile name', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReaddir.mockResolvedValue([{ isDirectory: () => true, name: 'Profile 1' }])

    const targets = await chromiumCacheTargets(chrome)
    expect(targets).toContainEqual({ path: join('/fake/chrome', 'Default', 'Code Cache'), label: 'Chrome - Default Code Cache' })
    expect(targets).toContainEqual({ path: join('/fake/chrome', 'Profile 1', 'Cache'), label: 'Chrome - Profile 1 Cache' })
  })

  // Issue #265: these live beside the profiles, so scanning only profile
  // subdirectories missed them entirely (~370 MB on the reporter's machine).
  it('scans shared caches once, directly under the user-data base', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReaddir.mockResolvedValue([{ isDirectory: () => true, name: 'Profile 1' }])

    const targets = await chromiumCacheTargets(chrome)
    const shared = targets.filter((t) => t.path.includes('GrShaderCache'))
    expect(shared).toEqual([{ path: join('/fake/chrome', 'GrShaderCache'), label: 'Chrome - Skia Shader Cache' }])
    expect(targets).toContainEqual({ path: join('/fake/chrome', 'component_crx_cache'), label: 'Chrome - Component Extension Cache' })
  })

  it('puts every cache directly under the base for profile-less builds', async () => {
    mockExistsSync.mockReturnValue(true)
    const opera = { key: 'opera', label: 'Opera', hasProfiles: false, ...browser('/fake/opera') }

    const targets = await chromiumCacheTargets(opera)
    expect(targets.map((t) => t.label)).toEqual([
      'Opera - Component Extension Cache',
      'Opera - Skia Shader Cache',
      'Opera - Cache',
      'Opera - Code Cache',
    ])
    expect(targets.every((t) => t.path.startsWith(join('/fake/opera')))).toBe(true)
    expect(mockReaddir).not.toHaveBeenCalled()
  })

  it('omits cache directories that do not exist', async () => {
    mockExistsSync.mockImplementation((p: string) => p === '/fake/chrome' || p.endsWith('Code Cache'))

    const targets = await chromiumCacheTargets(chrome)
    expect(targets).toEqual([
      { path: join('/fake/chrome', 'Default', 'Code Cache'), label: 'Chrome - Default Code Cache' },
    ])
  })
})

describe('getChromiumProfiles', () => {
  beforeEach(() => vi.clearAllMocks())

  it('always includes Default and adds numbered profiles', async () => {
    mockReaddir.mockResolvedValue([
      { isDirectory: () => true, name: 'Profile 1' },
      { isDirectory: () => true, name: 'Profile 2' },
      { isDirectory: () => true, name: 'ShaderCache' },
      { isDirectory: () => false, name: 'Local State' },
    ])
    expect(await getChromiumProfiles('/fake/chrome')).toEqual(['Default', 'Profile 1', 'Profile 2'])
  })

  it('falls back to Default when the base is unreadable', async () => {
    mockReaddir.mockRejectedValue(new Error('EACCES'))
    expect(await getChromiumProfiles('/fake/chrome')).toEqual(['Default'])
  })
})

describe('BROWSER_CACHE_RECENCY', () => {
  // `Code Cache` holds just the `js` and `wasm` directories, so a browser used
  // in the last hour had both skipped and the result dropped for being empty
  // (issue #265). Directories are judged by their contents instead.
  it('judges directories by their contents', () => {
    expect(BROWSER_CACHE_RECENCY.deepRecencyCheck).toBe(true)
  })

  it('leaves the default cutoff in place', () => {
    expect(BROWSER_CACHE_RECENCY.skipRecentMinutes).toBeUndefined()
  })
})
