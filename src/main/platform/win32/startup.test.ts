import { describe, it, expect, vi, beforeEach } from 'vitest'

// startup.ts uses runtime require('../../ipc/startup-manager.ipc') which goes
// through Node's CJS loader. We hook Module._resolveFilename to redirect to a mock.

const mockListStartupItems = vi.fn()
const mockToggleStartupItem = vi.fn()
const mockGetBootTrace = vi.fn()

const MOCK_KEY = '/mock/startup-manager.ipc'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const NativeModule = require('module')
const origResolve = NativeModule._resolveFilename
NativeModule._resolveFilename = function (request: string, parent: any, ...args: any[]) {
  if (request === '../../ipc/startup-manager.ipc') {
    return MOCK_KEY
  }
  return origResolve.call(this, request, parent, ...args)
}

require.cache[MOCK_KEY] = {
  id: MOCK_KEY,
  filename: MOCK_KEY,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    listStartupItems: mockListStartupItems,
    toggleStartupItem: mockToggleStartupItem,
    getBootTrace: mockGetBootTrace,
  },
  path: '/mock',
} as any

const { createWin32Startup } = await import('./startup')

describe('win32 startup', () => {
  const startup = createWin32Startup()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('listItems', () => {
    it('delegates to listStartupItems from the IPC module', async () => {
      const mockItems = [
        { name: 'Discord', location: 'HKCU\\...\\Run', command: 'discord.exe', source: 'registry', enabled: true },
      ]
      mockListStartupItems.mockResolvedValue(mockItems)

      const result = await startup.listItems()

      expect(mockListStartupItems).toHaveBeenCalledTimes(1)
      expect(result).toBe(mockItems)
    })

    it('propagates errors from listStartupItems', async () => {
      mockListStartupItems.mockRejectedValue(new Error('registry access failed'))

      await expect(startup.listItems()).rejects.toThrow('registry access failed')
    })
  })

  describe('toggleItem', () => {
    it('delegates to toggleStartupItem with all parameters', async () => {
      mockToggleStartupItem.mockResolvedValue(true)

      const result = await startup.toggleItem(
        'Discord', 'HKCU\\...\\Run', 'discord.exe', 'registry' as any, false
      )

      expect(mockToggleStartupItem).toHaveBeenCalledWith(
        'Discord', 'HKCU\\...\\Run', 'discord.exe', 'registry', false
      )
      expect(result).toBe(true)
    })

    it('returns false when toggle fails', async () => {
      mockToggleStartupItem.mockResolvedValue(false)

      const result = await startup.toggleItem(
        'Test', 'loc', 'cmd', 'registry' as any, true
      )
      expect(result).toBe(false)
    })

    it('propagates errors from toggleStartupItem', async () => {
      mockToggleStartupItem.mockRejectedValue(new Error('access denied'))

      await expect(
        startup.toggleItem('Test', 'loc', 'cmd', 'registry' as any, true)
      ).rejects.toThrow('access denied')
    })
  })

  describe('getBootTrace', () => {
    it('delegates to getBootTrace from the IPC module', async () => {
      const mockTrace = { totalBootTimeMs: 15000, items: [] }
      mockGetBootTrace.mockResolvedValue(mockTrace)

      const result = await startup.getBootTrace()

      expect(mockGetBootTrace).toHaveBeenCalledTimes(1)
      expect(result).toBe(mockTrace)
    })

    it('propagates errors from getBootTrace', async () => {
      mockGetBootTrace.mockRejectedValue(new Error('event log unavailable'))

      await expect(startup.getBootTrace()).rejects.toThrow('event log unavailable')
    })
  })
})
