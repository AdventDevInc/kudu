import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.fn()
const isDestroyed = vi.fn(() => false)
const isCrashed = vi.fn(() => false)
const healthySend = vi.fn()
const checkForUpdatesMock = vi.fn()
const onMock = vi.fn()
const markerExists = vi.hoisted(() => vi.fn().mockReturnValue(false))
vi.mock('node:fs', () => ({ existsSync: markerExists }))
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', originalPlatform)
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources)
  else delete (process as any).resourcesPath
})

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send, isDestroyed, isCrashed } },
      {
        isDestroyed: () => false,
        webContents: { send: healthySend, isDestroyed: () => false, isCrashed: () => false }
      }
    ]
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: onMock,
    checkForUpdates: checkForUpdatesMock,
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  }
}))

vi.mock('./settings-store', () => ({
  getSettings: () => ({
    autoUpdate: false,
    autoRestart: false,
    updateCheckIntervalHours: 0
  })
}))

vi.mock('./appimage-launchers', () => ({
  retargetAppImageLaunchers: vi.fn().mockReturnValue(0)
}))

describe('checkForUpdates UX', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    send.mockReset()
    isDestroyed.mockReturnValue(false)
    isCrashed.mockReturnValue(false)
    checkForUpdatesMock.mockResolvedValue(undefined)
    markerExists.mockReturnValue(false)
    vi.stubEnv('APPIMAGE', '')
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', '')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    Object.defineProperty(process, 'resourcesPath', {
      value: 'C:\\Kudu\\resources',
      configurable: true
    })
  })

  it('broadcasts an error on Linux when not running as AppImage (silent no-op was the bug)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const { checkForUpdates } = await import('./auto-updater')
    await checkForUpdates()
    expect(checkForUpdatesMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error', error: expect.stringMatching(/AppImage/i) })
    )
  })

  it('runs electron-updater when APPIMAGE is set on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.APPIMAGE = '/home/u/Kudu-x86_64.AppImage'
    const { checkForUpdates } = await import('./auto-updater')
    await checkForUpdates()
    expect(checkForUpdatesMock).toHaveBeenCalled()
  })

  it.each(['exe', 'zip'])(
    'blocks every installer update entry point for portable %s',
    async (format) => {
      if (format === 'exe') vi.stubEnv('PORTABLE_EXECUTABLE_DIR', 'D:\\Kudu')
      else markerExists.mockReturnValue(true)
      const updater = await import('./auto-updater')
      const { autoUpdater } = await import('electron-updater')
      updater.initAutoUpdater({ daemon: true })
      updater.updateCheckInterval(1)
      updater.setAutoDownload(true)
      await updater.checkForUpdates()
      await updater.downloadUpdate()
      updater.installUpdate()
      expect(onMock).not.toHaveBeenCalled()
      expect(checkForUpdatesMock).not.toHaveBeenCalled()
      expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
      expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
      expect(autoUpdater.autoDownload).toBe(false)
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          error: expect.stringMatching(/manual updates/i)
        })
      )
    }
  )

  it('retains installed Windows update checks without a portable marker', async () => {
    const { checkForUpdates } = await import('./auto-updater')
    await checkForUpdates()
    expect(checkForUpdatesMock).toHaveBeenCalled()
  })

  it.each(['destroyed', 'crashed', 'disposed during send'])(
    'keeps updater status and delivers to healthy windows when a renderer is %s',
    async (failure) => {
      if (failure === 'destroyed') isDestroyed.mockReturnValue(true)
      if (failure === 'crashed') isCrashed.mockReturnValue(true)
      if (failure === 'disposed during send') {
        send.mockImplementation(() => {
          throw new Error('Render frame was disposed before WebFrameMain could be accessed')
        })
      }
      const updater = await import('./auto-updater')
      updater.initAutoUpdater()
      const notify = onMock.mock.calls.find(([event]) => event === 'update-not-available')![1]
      expect(() => notify()).not.toThrow()
      expect(updater.getUpdateStatus()).toEqual({ state: 'not-available' })
      expect(healthySend).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
      if (failure !== 'disposed during send') expect(send).not.toHaveBeenCalled()
    }
  )
})
