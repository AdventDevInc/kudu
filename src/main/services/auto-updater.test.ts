import { beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.fn()
const checkForUpdatesMock = vi.fn()
const onMock = vi.fn()

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
  },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: onMock,
    checkForUpdates: checkForUpdatesMock,
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}))

vi.mock('./settings-store', () => ({
  getSettings: () => ({
    autoUpdate: false,
    autoRestart: false,
    updateCheckIntervalHours: 0,
  }),
}))

vi.mock('./appimage-launchers', () => ({
  retargetAppImageLaunchers: vi.fn().mockReturnValue(0),
}))

describe('checkForUpdates UX', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    checkForUpdatesMock.mockResolvedValue(undefined)
    delete process.env.APPIMAGE
    delete process.env.PORTABLE_EXECUTABLE_DIR
  })

  it('broadcasts an error on Linux when not running as AppImage (silent no-op was the bug)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const { checkForUpdates } = await import('./auto-updater')
    await checkForUpdates()
    expect(checkForUpdatesMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'error', error: expect.stringMatching(/AppImage/i) }),
    )
  })

  it('runs electron-updater when APPIMAGE is set on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.APPIMAGE = '/home/u/Kudu-x86_64.AppImage'
    const { checkForUpdates } = await import('./auto-updater')
    await checkForUpdates()
    expect(checkForUpdatesMock).toHaveBeenCalled()
  })
})
