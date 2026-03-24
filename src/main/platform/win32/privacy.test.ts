import { describe, it, expect } from 'vitest'

// privacy.ts uses a runtime require('../../ipc/privacy-shield.ipc') that goes
// through Node's CJS loader. Since Node can't resolve .ts files, we hook
// Module._resolveFilename to redirect to our mock, then inject the mock into
// the require cache BEFORE importing the module under test.

const mockPrivacySettings = [
  { id: 'telemetry', name: 'Telemetry', category: 'Privacy' },
  { id: 'advertising', name: 'Advertising ID', category: 'Privacy' },
]

const MOCK_KEY = '/mock/privacy-shield.ipc'

// Hook Node's module resolution to intercept the require call
// eslint-disable-next-line @typescript-eslint/no-require-imports
const NativeModule = require('module')
const origResolve = NativeModule._resolveFilename
NativeModule._resolveFilename = function (request: string, parent: any, ...args: any[]) {
  if (request === '../../ipc/privacy-shield.ipc') {
    return MOCK_KEY
  }
  return origResolve.call(this, request, parent, ...args)
}

// Pre-populate the require cache with our mock
require.cache[MOCK_KEY] = {
  id: MOCK_KEY,
  filename: MOCK_KEY,
  loaded: true,
  children: [],
  paths: [],
  exports: { PRIVACY_SETTINGS: mockPrivacySettings },
  path: '/mock',
} as any

const { createWin32Privacy } = await import('./privacy')

describe('win32 privacy', () => {
  const privacy = createWin32Privacy()

  describe('getSettings', () => {
    it('returns the PRIVACY_SETTINGS array from the IPC module', () => {
      const settings = privacy.getSettings()
      expect(settings).toEqual(mockPrivacySettings)
    })

    it('returns the expected settings entries', () => {
      const settings = privacy.getSettings()
      expect(settings).toHaveLength(2)
      expect(settings[0].id).toBe('telemetry')
      expect(settings[1].id).toBe('advertising')
    })

    it('each setting has id and name properties', () => {
      const settings = privacy.getSettings()
      for (const s of settings) {
        expect(s.id).toBeTruthy()
        expect(s.name).toBeTruthy()
      }
    })
  })
})
