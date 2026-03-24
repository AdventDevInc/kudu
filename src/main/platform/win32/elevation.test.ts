import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileSyncMock = vi.fn()

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
}))

describe('win32 elevation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the module-level cache by re-importing fresh each time
    vi.resetModules()
  })

  it('returns true when net session succeeds (admin)', async () => {
    execFileSyncMock.mockReturnValue(undefined)

    const { createWin32Elevation } = await import('./elevation')
    const elevation = createWin32Elevation()
    const result = elevation.isAdmin()

    expect(result).toBe(true)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'net', ['session'], { stdio: 'ignore', timeout: 5000 }
    )
  })

  it('returns false when net session throws (not admin)', async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('Access denied') })

    const { createWin32Elevation } = await import('./elevation')
    const elevation = createWin32Elevation()
    const result = elevation.isAdmin()

    expect(result).toBe(false)
  })

  it('caches the result after first call', async () => {
    execFileSyncMock.mockReturnValue(undefined)

    const { createWin32Elevation } = await import('./elevation')
    const elevation = createWin32Elevation()

    elevation.isAdmin()
    elevation.isAdmin()
    elevation.isAdmin()

    // execFileSync should only be called once due to caching
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
  })
})
