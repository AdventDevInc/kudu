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

  it('returns true when the inherited process token is elevated', async () => {
    execFileSyncMock.mockReturnValue(undefined)

    const { createWin32Elevation } = await import('./elevation')
    const elevation = createWin32Elevation()
    const result = elevation.isAdmin()

    expect(result).toBe(true)
    const [file, args, options] = execFileSyncMock.mock.calls[0]
    expect(file).toBe('powershell.exe')
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']))
    expect(args.at(-1)).toContain('WindowsIdentity]::GetCurrent()')
    expect(args.at(-1)).toContain('WindowsBuiltInRole]::Administrator')
    expect(options).toEqual({ stdio: 'ignore', timeout: 5000, windowsHide: true })
  })

  it('returns false when the inherited process token is not elevated', async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('Access denied') })

    const { createWin32Elevation } = await import('./elevation')
    const elevation = createWin32Elevation()
    const result = elevation.isAdmin()

    expect(result).toBe(false)
  })

  it('does not depend on the Server service through net session', async () => {
    execFileSyncMock.mockReturnValue(undefined)

    const { createWin32Elevation } = await import('./elevation')
    createWin32Elevation().isAdmin()

    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      'net', ['session'], expect.anything()
    )
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
