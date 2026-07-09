import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────

const handleMap = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler)
    }),
  },
}))

vi.mock('../../shared/channels', () => ({
  IPC: {
    SOFTWARE_UPDATE_CHECK: 'software-update:check',
    SOFTWARE_UPDATE_RUN: 'software-update:run',
    SOFTWARE_UPDATE_PROGRESS: 'software-update:progress',
  },
}))

const mockCheckForUpdates = vi.fn()
const mockRunUpdates = vi.fn()

vi.mock('../services/software-updater', () => ({
  checkForUpdates: (...args: unknown[]) => mockCheckForUpdates(...args),
  runUpdates: (...args: unknown[]) => mockRunUpdates(...args),
}))

import { registerSoftwareUpdaterIpc } from './software-updater.ipc'
import type { BrowserWindow } from 'electron'

// ── Helpers ──────────────────────────────────────────────────

function makeWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow
}

function invoke(channel: string, ...args: unknown[]) {
  const handler = handleMap.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return handler({} /* _event */, ...args)
}

// ── Tests ────────────────────────────────────────────────────

describe('software-updater IPC', () => {
  beforeEach(() => {
    handleMap.clear()
    vi.clearAllMocks()
  })

  it('registers both IPC handlers', () => {
    const win = makeWindow()
    registerSoftwareUpdaterIpc(() => win)
    expect(handleMap.has('software-update:check')).toBe(true)
    expect(handleMap.has('software-update:run')).toBe(true)
  })

  // ── SOFTWARE_UPDATE_CHECK ──────────────────────────────────

  describe('SOFTWARE_UPDATE_CHECK', () => {
    it('delegates to checkForUpdates and returns its result', async () => {
      const expected = { apps: [], upToDate: [], totalCount: 0, majorCount: 0, minorCount: 0, patchCount: 0, packageManagerAvailable: true, packageManagerName: 'winget' }
      mockCheckForUpdates.mockResolvedValue(expected)

      registerSoftwareUpdaterIpc(() => makeWindow())
      const result = await invoke('software-update:check')
      expect(result).toEqual(expected)
      expect(mockCheckForUpdates).toHaveBeenCalledOnce()
    })

    it('propagates errors from checkForUpdates', async () => {
      mockCheckForUpdates.mockRejectedValue(new Error('network failure'))

      registerSoftwareUpdaterIpc(() => makeWindow())
      await expect(invoke('software-update:check')).rejects.toThrow('network failure')
    })
  })

  // ── SOFTWARE_UPDATE_RUN ────────────────────────────────────

  describe('SOFTWARE_UPDATE_RUN', () => {
    const item = (id: string, source = 'winget') => ({ id, source })

    it('passes safe items and sendProgress callback to runUpdates', async () => {
      const expected = { succeeded: 2, failed: 0, errors: [] }
      mockRunUpdates.mockResolvedValue(expected)

      const win = makeWindow()
      registerSoftwareUpdaterIpc(() => win)

      const result = await invoke('software-update:run', [item('app1', 'winget'), item('app2', 'choco')])
      expect(result).toEqual(expected)
      expect(mockRunUpdates).toHaveBeenCalledOnce()
      // First arg: filtered {id, source} items
      expect(mockRunUpdates.mock.calls[0][0]).toEqual([item('app1', 'winget'), item('app2', 'choco')])
      // Second arg: sendProgress function
      expect(typeof mockRunUpdates.mock.calls[0][1]).toBe('function')
    })

    it('returns empty result when items is not an array', async () => {
      registerSoftwareUpdaterIpc(() => makeWindow())
      const result = await invoke('software-update:run', 'not-an-array')
      expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
      expect(mockRunUpdates).not.toHaveBeenCalled()
    })

    it('returns empty result when items is an empty array', async () => {
      registerSoftwareUpdaterIpc(() => makeWindow())
      const result = await invoke('software-update:run', [])
      expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
      expect(mockRunUpdates).not.toHaveBeenCalled()
    })

    it('returns empty result when items is null', async () => {
      registerSoftwareUpdaterIpc(() => makeWindow())
      const result = await invoke('software-update:run', null)
      expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
      expect(mockRunUpdates).not.toHaveBeenCalled()
    })

    it('filters out malformed items (bad id or missing source)', async () => {
      mockRunUpdates.mockResolvedValue({ succeeded: 1, failed: 0, errors: [] })
      registerSoftwareUpdaterIpc(() => makeWindow())

      await invoke('software-update:run', [
        item('valid-id', 'winget'),
        { id: 42, source: 'winget' },
        { id: '', source: 'winget' },
        { id: 'no-source' },
        null,
        item('another-valid', 'npm'),
      ])
      expect(mockRunUpdates.mock.calls[0][0]).toEqual([item('valid-id', 'winget'), item('another-valid', 'npm')])
    })

    it('filters out ids that are >= 200 characters', async () => {
      mockRunUpdates.mockResolvedValue({ succeeded: 1, failed: 0, errors: [] })
      registerSoftwareUpdaterIpc(() => makeWindow())

      const longId = 'a'.repeat(200)
      const okId = 'a'.repeat(199)
      await invoke('software-update:run', [item(longId), item(okId)])
      expect(mockRunUpdates.mock.calls[0][0]).toEqual([item(okId)])
    })

    it('sendProgress sends data to window via IPC', async () => {
      mockRunUpdates.mockImplementation(async (_items: unknown[], sendProgress: (data: unknown) => void) => {
        sendProgress({ phase: 'updating', current: 1, total: 2, currentApp: 'App1', percent: 50, status: 'in-progress' })
        return { succeeded: 1, failed: 0, errors: [] }
      })

      const win = makeWindow()
      registerSoftwareUpdaterIpc(() => win)
      await invoke('software-update:run', [item('app1')])

      expect(win.webContents.send).toHaveBeenCalledWith(
        'software-update:progress',
        { phase: 'updating', current: 1, total: 2, currentApp: 'App1', percent: 50, status: 'in-progress' },
      )
    })

    it('sendProgress does not throw when window is null', async () => {
      mockRunUpdates.mockImplementation(async (_items: unknown[], sendProgress: (data: unknown) => void) => {
        sendProgress({ phase: 'updating', current: 1, total: 1, currentApp: 'X', percent: 100, status: 'done' })
        return { succeeded: 1, failed: 0, errors: [] }
      })

      registerSoftwareUpdaterIpc(() => null)
      // Should not throw
      await expect(invoke('software-update:run', [item('x')])).resolves.toBeDefined()
    })

    it('sendProgress does not throw when window is destroyed', async () => {
      mockRunUpdates.mockImplementation(async (_items: unknown[], sendProgress: (data: unknown) => void) => {
        sendProgress({ phase: 'updating', current: 1, total: 1, currentApp: 'X', percent: 100, status: 'done' })
        return { succeeded: 1, failed: 0, errors: [] }
      })

      const win = makeWindow(true) // destroyed
      registerSoftwareUpdaterIpc(() => win)
      await expect(invoke('software-update:run', [item('x')])).resolves.toBeDefined()
      expect(win.webContents.send).not.toHaveBeenCalled()
    })

    it('propagates errors from runUpdates', async () => {
      mockRunUpdates.mockRejectedValue(new Error('update failed'))

      registerSoftwareUpdaterIpc(() => makeWindow())
      await expect(invoke('software-update:run', [item('app1')])).rejects.toThrow('update failed')
    })
  })
})
