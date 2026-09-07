import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockShowOpenDialog = vi.fn()
vi.mock('electron', () => ({
  dialog: { showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args) },
}))

const { showOpenDialog } = await import('./open-dialog')

describe('showOpenDialog', () => {
  const win = { id: 1 } as unknown as Electron.BrowserWindow
  const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'] }

  beforeEach(() => {
    mockShowOpenDialog.mockReset()
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp'] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes parent window on Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    await showOpenDialog(win, opts)
    expect(mockShowOpenDialog).toHaveBeenCalledWith(win, opts)
  })

  it('omits parent window on Linux', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    await showOpenDialog(win, opts)
    expect(mockShowOpenDialog).toHaveBeenCalledWith(opts)
  })

  it('omits parent window on macOS', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    await showOpenDialog(win, opts)
    expect(mockShowOpenDialog).toHaveBeenCalledWith(opts)
  })

  it('omits parent when window is null on Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    await showOpenDialog(null, opts)
    expect(mockShowOpenDialog).toHaveBeenCalledWith(opts)
  })
})
