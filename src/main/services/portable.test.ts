import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { isPortable, skipPortableStartup } from './portable'

const packaged = vi.hoisted(() => ({ isPackaged: true }))
const exists = vi.hoisted(() => vi.fn().mockReturnValue(false))
vi.mock('electron', () => ({ app: packaged }))
vi.mock('node:fs', () => ({ existsSync: exists }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

beforeEach(() => {
  vi.clearAllMocks()
  exists.mockReturnValue(false)
  packaged.isPackaged = true
  vi.stubEnv('PORTABLE_EXECUTABLE_DIR', '')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  Object.defineProperty(process, 'resourcesPath', {
    value: 'D:\\My Apps\\Kudu\\resources',
    configurable: true
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', originalPlatform)
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
  else delete (process as any).resourcesPath
})

describe('portable runtime', () => {
  it('recognizes the EXE launcher and rejects startup registration', () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\My Apps')
    expect(isPortable()).toBe(true)
    expect(() => skipPortableStartup(true)).toThrow('installed version')
    expect(skipPortableStartup(false)).toBe(true)
  })

  it('recognizes an extracted ZIP and leaves the shared startup task untouched', () => {
    exists.mockReturnValue(true)
    expect(isPortable()).toBe(true)
    expect(exists).toHaveBeenCalledWith(join(process.resourcesPath, 'portable.json'))
    expect(() => skipPortableStartup(true)).toThrow('installed version')
    expect(skipPortableStartup(false)).toBe(true)
  })

  it('preserves installed startup behavior', () => {
    expect(isPortable()).toBe(false)
    expect(skipPortableStartup(true)).toBe(false)
    expect(skipPortableStartup(false)).toBe(false)
  })

  it('ignores portable markers outside packaged Windows builds', () => {
    exists.mockReturnValue(true)
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\My Apps')
    packaged.isPackaged = false
    expect(isPortable()).toBe(false)
    packaged.isPackaged = true
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(isPortable()).toBe(false)
  })
})
