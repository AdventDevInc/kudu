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
    UNINSTALLER_LIST: 'uninstaller:list',
    UNINSTALLER_UNINSTALL: 'uninstaller:uninstall',
    UNINSTALLER_PROGRESS: 'uninstaller:progress',
  },
}))

const mockGetInstalledProgramsFull = vi.fn()
const mockRunUninstaller = vi.fn()
const mockVerifyUninstall = vi.fn()
const mockScanLeftoversForProgram = vi.fn()

vi.mock('../services/program-uninstaller', () => ({
  getInstalledProgramsFull: (...args: unknown[]) => mockGetInstalledProgramsFull(...args),
  runUninstaller: (...args: unknown[]) => mockRunUninstaller(...args),
  verifyUninstall: (...args: unknown[]) => mockVerifyUninstall(...args),
  scanLeftoversForProgram: (...args: unknown[]) => mockScanLeftoversForProgram(...args),
}))

const mockSafeDelete = vi.fn()

vi.mock('../services/file-utils', () => ({
  safeDelete: (...args: unknown[]) => mockSafeDelete(...args),
}))

import { registerProgramUninstallerIpc } from './program-uninstaller.ipc'
import type { BrowserWindow } from 'electron'
import type { InstalledProgram } from '../../shared/types'

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

function makeProgram(overrides: Partial<InstalledProgram> = {}): InstalledProgram {
  return {
    id: 'prog-1',
    displayName: 'Test App',
    publisher: 'Test',
    displayVersion: '1.0.0',
    installDate: '2025-01-01',
    estimatedSize: 1024,
    installLocation: 'C:\\Program Files\\TestApp',
    uninstallString: 'C:\\uninstall.exe',
    quietUninstallString: '',
    displayIcon: '',
    registryKey: 'HKLM\\SOFTWARE\\TestApp',
    isSystemComponent: false,
    isWindowsInstaller: false,
    lastUsed: 0,
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('program-uninstaller IPC', () => {
  beforeEach(() => {
    handleMap.clear()
    vi.clearAllMocks()
    // Re-register to get a fresh module-level cachedPrograms
  })

  it('registers both IPC handlers', () => {
    registerProgramUninstallerIpc(() => makeWindow())
    expect(handleMap.has('uninstaller:list')).toBe(true)
    expect(handleMap.has('uninstaller:uninstall')).toBe(true)
  })

  // ── UNINSTALLER_LIST ───────────────────────────────────────

  describe('UNINSTALLER_LIST', () => {
    it('returns programs from getInstalledProgramsFull', async () => {
      const programs = [makeProgram({ id: 'a' }), makeProgram({ id: 'b' })]
      mockGetInstalledProgramsFull.mockResolvedValue(programs)

      registerProgramUninstallerIpc(() => makeWindow())
      const result = await invoke('uninstaller:list')

      expect(result).toEqual({ programs, totalCount: 2 })
      expect(mockGetInstalledProgramsFull).toHaveBeenCalledOnce()
    })

    it('returns empty list when no programs found', async () => {
      mockGetInstalledProgramsFull.mockResolvedValue([])

      registerProgramUninstallerIpc(() => makeWindow())
      const result = await invoke('uninstaller:list')

      expect(result).toEqual({ programs: [], totalCount: 0 })
    })

    it('propagates errors from getInstalledProgramsFull', async () => {
      mockGetInstalledProgramsFull.mockRejectedValue(new Error('registry read fail'))

      registerProgramUninstallerIpc(() => makeWindow())
      await expect(invoke('uninstaller:list')).rejects.toThrow('registry read fail')
    })
  })

  // ── UNINSTALLER_UNINSTALL ──────────────────────────────────

  describe('UNINSTALLER_UNINSTALL', () => {
    it('returns error when programId is not in cache', async () => {
      mockGetInstalledProgramsFull.mockResolvedValue([])

      registerProgramUninstallerIpc(() => makeWindow())
      // Populate cache with empty list
      await invoke('uninstaller:list')

      const result = await invoke('uninstaller:uninstall', 'nonexistent')
      expect(result).toMatchObject({
        success: false,
        programName: 'Unknown',
        error: expect.stringContaining('not found in cache'),
      })
    })

    it('performs full uninstall flow: uninstall -> verify -> scan -> clean', async () => {
      const program = makeProgram({ id: 'prog-1' })
      mockGetInstalledProgramsFull.mockResolvedValue([program])
      mockRunUninstaller.mockResolvedValue(0)
      mockVerifyUninstall.mockResolvedValue(true) // registry key removed
      mockScanLeftoversForProgram.mockResolvedValue([
        { path: 'C:\\leftover1', size: 100 },
        { path: 'C:\\leftover2', size: 200 },
      ])
      mockSafeDelete.mockResolvedValue({ success: true })

      const win = makeWindow()
      registerProgramUninstallerIpc(() => win)
      await invoke('uninstaller:list') // populate cache

      const result = await invoke('uninstaller:uninstall', 'prog-1')

      expect(result).toEqual({
        success: true,
        programName: 'Test App',
        exitCode: 0,
        leftoversFound: 2,
        leftoversCleaned: 2,
        leftoversSize: 300,
      })
      expect(mockRunUninstaller).toHaveBeenCalledWith(program)
      expect(mockVerifyUninstall).toHaveBeenCalledWith(program.registryKey)
      expect(mockScanLeftoversForProgram).toHaveBeenCalledWith(program)
      expect(mockSafeDelete).toHaveBeenCalledTimes(2)
    })

    it('sends progress events during uninstall phases', async () => {
      const program = makeProgram()
      mockGetInstalledProgramsFull.mockResolvedValue([program])
      mockRunUninstaller.mockResolvedValue(0)
      mockVerifyUninstall.mockResolvedValue(true)
      mockScanLeftoversForProgram.mockResolvedValue([])

      const win = makeWindow()
      registerProgramUninstallerIpc(() => win)
      await invoke('uninstaller:list')
      await invoke('uninstaller:uninstall', 'prog-1')

      const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      // Should have sent 'uninstalling' and 'scanning-leftovers' progress events
      const phases = calls
        .filter(([ch]: string[]) => ch === 'uninstaller:progress')
        .map(([, data]: [string, { phase: string }]) => data.phase)

      expect(phases).toContain('uninstalling')
      expect(phases).toContain('scanning-leftovers')
    })

    it('sends cleaning-leftovers progress when leftovers exist', async () => {
      const program = makeProgram()
      mockGetInstalledProgramsFull.mockResolvedValue([program])
      mockRunUninstaller.mockResolvedValue(0)
      mockVerifyUninstall.mockResolvedValue(true)
      mockScanLeftoversForProgram.mockResolvedValue([{ path: 'C:\\f', size: 50 }])
      mockSafeDelete.mockResolvedValue({ success: true })

      const win = makeWindow()
      registerProgramUninstallerIpc(() => win)
      await invoke('uninstaller:list')
      await invoke('uninstaller:uninstall', 'prog-1')

      const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      const phases = calls
        .filter(([ch]: string[]) => ch === 'uninstaller:progress')
        .map(([, data]: [string, { phase: string }]) => data.phase)

      expect(phases).toContain('cleaning-leftovers')
    })

    it('returns success with zero leftovers when scan finds none', async () => {
      const program = makeProgram()
      mockGetInstalledProgramsFull.mockResolvedValue([program])
      mockRunUninstaller.mockResolvedValue(0)
      mockVerifyUninstall.mockResolvedValue(true)
      mockScanLeftoversForProgram.mockResolvedValue([])

      registerProgramUninstallerIpc(() => makeWindow())
      await invoke('uninstaller:list')
      const result = await invoke('uninstaller:uninstall', 'prog-1')

      expect(result).toMatchObject({
        success: true,
        leftoversFound: 0,
        leftoversCleaned: 0,
        leftoversSize: 0,
      })
    })

    it('returns failure when verify shows program still installed (not reboot pending)', async () => {
      const program = makeProgram()
      mockGetInstalledProgramsFull.mockResolvedValue([program])
      mockRunUninstaller.mockResolvedValue(0)
      mockVerifyUninstall.mockResolvedValue(false) // still in registry

      registerProgramUninstallerIpc(() => makeWindow())
      await invoke('uninstaller:list')
      const result = await invoke('uninstaller:uninstall', 'prog-1')

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('cancelled or failed'),
      })
      // Should NOT scan for leftovers
      expect(mockScanLeftoversForProgram).not.toHaveBeenCalled()
    })

    it('continues with leftovers when exit code 3010 (reboot pending) even if verify fails', async () => {
      const program = makeProgram()
      mockGetInstalledProgramsFull.mockResolvedValue([program])
      mockRunUninstaller.mockResolvedValue(3010)
      mockVerifyUninstall.mockResolvedValue(false)
      mockScanLeftoversForProgram.mockResolvedValue([])

      registerProgramUninstallerIpc(() => makeWindow())
      await invoke('uninstaller:list')
      const result = await invoke('uninstaller:uninstall', 'prog-1')

      expect(result).toMatchObject({ success: true })
      expect(mockScanLeftoversForProgram).toHaveBeenCalled()
    })

    it('counts only successfully deleted leftovers', async () => {
      const program = makeProgram()
      mockGetInstalledProgramsFull.mockResolvedValue([program])
      mockRunUninstaller.mockResolvedValue(0)
      mockVerifyUninstall.mockResolvedValue(true)
      mockScanLeftoversForProgram.mockResolvedValue([
        { path: 'C:\\ok', size: 100 },
        { path: 'C:\\fail', size: 200 },
        { path: 'C:\\ok2', size: 300 },
      ])
      mockSafeDelete
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true })

      registerProgramUninstallerIpc(() => makeWindow())
      await invoke('uninstaller:list')
      const result = await invoke('uninstaller:uninstall', 'prog-1')

      expect(result).toMatchObject({
        success: true,
        leftoversFound: 3,
        leftoversCleaned: 2,
        leftoversSize: 400, // 100 + 300, not 200
      })
    })

    it('does not send progress when window is null', async () => {
      const program = makeProgram()
      mockGetInstalledProgramsFull.mockResolvedValue([program])
      mockRunUninstaller.mockResolvedValue(0)
      mockVerifyUninstall.mockResolvedValue(true)
      mockScanLeftoversForProgram.mockResolvedValue([])

      registerProgramUninstallerIpc(() => null)
      await invoke('uninstaller:list')
      // Should not throw
      await expect(invoke('uninstaller:uninstall', 'prog-1')).resolves.toBeDefined()
    })

    it('does not send progress when window is destroyed', async () => {
      const program = makeProgram()
      mockGetInstalledProgramsFull.mockResolvedValue([program])
      mockRunUninstaller.mockResolvedValue(0)
      mockVerifyUninstall.mockResolvedValue(true)
      mockScanLeftoversForProgram.mockResolvedValue([])

      const win = makeWindow(true)
      registerProgramUninstallerIpc(() => win)
      await invoke('uninstaller:list')
      await invoke('uninstaller:uninstall', 'prog-1')

      expect(win.webContents.send).not.toHaveBeenCalled()
    })
  })
})
