import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

const mockHandle = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) }
}))

const mockScanDirectory = vi.fn()
const mockScanMultipleDirectories = vi.fn()
vi.mock('../services/file-utils', () => ({
  scanDirectory: (...args: unknown[]) => mockScanDirectory(...args),
  scanFile: vi.fn(),
  scanMultipleDirectories: (...args: unknown[]) => mockScanMultipleDirectories(...args),
  resolveChildSubdirs: vi.fn(),
  cleanItems: vi.fn()
}))

vi.mock('../services/scan-cache', () => ({
  cacheItems: vi.fn(),
  clearCachedCategory: vi.fn()
}))

vi.mock('../services/elevation', () => ({ isAdmin: () => true }))
vi.mock('../services/settings-store', () => ({
  getSettings: () => ({ cleaner: { skipRecentMinutes: 30 } })
}))
vi.mock('../services/ipc-validation', () => ({
  validateStringArray: (input: unknown) => (Array.isArray(input) ? input : null)
}))

const configuredUserTempPath = join(tmpdir(), '..', 'configured-user-temp')
const ordinaryPath = join(tmpdir(), '..', 'ordinary-cache')
const updateOrchestratorPath = join(tmpdir(), '..', 'uso-logs')
vi.mock('../platform', () => ({
  getPlatform: () => ({
    paths: {
      systemCleanTargets: () => [
        { path: configuredUserTempPath, subcategory: 'User Temp Files', deepRecencyCheck: true },
        { path: ordinaryPath, subcategory: 'Ordinary Cache' },
        { path: 'C:/Windows.old', subcategory: 'Previous Windows Installation' },
        {
          path: updateOrchestratorPath,
          subcategory: 'Update Orchestrator Logs',
          deepRecencyCheck: true
        }
      ],
      protectedEventLogs: () => [],
      singleFileCleanTargets: () => []
    }
  })
}))

import { registerSystemCleanerIpc } from './system-cleaner.ipc'

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mockHandle.mock.calls.find((entry) => entry[0] === channel)
  if (!call) throw new Error(`No handler registered for ${channel}`)
  return call[1] as (...args: unknown[]) => unknown
}

describe('system temp scanning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockScanDirectory.mockResolvedValue({
      category: 'system',
      subcategory: 'test',
      items: [],
      totalSize: 0,
      itemCount: 0
    })
  })

  it('uses the configured recency and honours each target deep-recency flag', async () => {
    registerSystemCleanerIpc(() => null)
    await getHandler('cleaner:system:scan')()

    expect(mockScanDirectory).toHaveBeenNthCalledWith(
      1,
      configuredUserTempPath,
      'system',
      'User Temp Files',
      { skipRecentMinutes: 30, deepRecencyCheck: true }
    )
    expect(mockScanDirectory).toHaveBeenNthCalledWith(2, ordinaryPath, 'system', 'Ordinary Cache', {
      skipRecentMinutes: 30,
      deepRecencyCheck: false
    })
    expect(mockScanDirectory).toHaveBeenNthCalledWith(
      4,
      updateOrchestratorPath,
      'system',
      'Update Orchestrator Logs',
      { skipRecentMinutes: 30, deepRecencyCheck: true }
    )
    expect(mockScanMultipleDirectories).not.toHaveBeenCalled()
  })
})

it('marks Windows rollback unselected and supplies the rollback warning', async () => {
  mockScanDirectory.mockImplementation(async (_path, category, subcategory) => ({
    category,
    subcategory,
    items: [{ id: subcategory, selected: true }],
    totalSize: 10,
    itemCount: 1
  }))
  registerSystemCleanerIpc(() => null)
  const results = (await getHandler('cleaner:system:scan')()) as any[]
  const rollback = results.find((r) => r.subcategory === 'Previous Windows Installation')
  expect(rollback.descriptionKey).toBe('windowsRollbackWarning')
  expect(rollback.items[0].selected).toBe(false)
  expect(results.find((r) => r.subcategory === 'Ordinary Cache').items[0].selected).toBe(true)
})
