import { describe, it, expect, vi, beforeEach } from 'vitest'

// services.ts uses runtime require('../../ipc/service-manager.ipc') which goes
// through Node's CJS loader. We hook Module._resolveFilename to redirect to a mock.

const mockScanServices = vi.fn()
const mockApplyServiceChanges = vi.fn()

const MOCK_KEY = '/mock/service-manager.ipc'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const NativeModule = require('module')
const origResolve = NativeModule._resolveFilename
NativeModule._resolveFilename = function (request: string, parent: any, ...args: any[]) {
  if (request === '../../ipc/service-manager.ipc') {
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
    scanServices: mockScanServices,
    applyServiceChanges: mockApplyServiceChanges,
  },
  path: '/mock',
} as any

const { createWin32Services } = await import('./services')

describe('win32 services', () => {
  const services = createWin32Services()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('scan', () => {
    it('delegates to scanServices from the IPC module', async () => {
      const mockResult = { services: [{ name: 'Spooler', displayName: 'Print Spooler' }] }
      mockScanServices.mockResolvedValue(mockResult)

      const result = await services.scan()

      expect(mockScanServices).toHaveBeenCalledTimes(1)
      expect(result).toBe(mockResult)
    })

    it('passes onProgress callback to scanServices', async () => {
      mockScanServices.mockResolvedValue({ services: [] })
      const progressFn = vi.fn()

      await services.scan(progressFn)

      expect(mockScanServices).toHaveBeenCalledWith(progressFn)
    })

    it('propagates errors from scanServices', async () => {
      mockScanServices.mockRejectedValue(new Error('WMI error'))

      await expect(services.scan()).rejects.toThrow('WMI error')
    })
  })

  describe('applyChanges', () => {
    it('delegates to applyServiceChanges from the IPC module', async () => {
      const mockResult = { applied: 2, failed: 0 }
      mockApplyServiceChanges.mockResolvedValue(mockResult)

      const changes = [
        { name: 'Spooler', targetStartType: 'Disabled' },
        { name: 'wuauserv', targetStartType: 'Manual' },
      ]

      const result = await services.applyChanges(changes)

      expect(mockApplyServiceChanges).toHaveBeenCalledWith(changes)
      expect(result).toBe(mockResult)
    })

    it('propagates errors from applyServiceChanges', async () => {
      mockApplyServiceChanges.mockRejectedValue(new Error('access denied'))

      await expect(services.applyChanges([])).rejects.toThrow('access denied')
    })
  })
})
