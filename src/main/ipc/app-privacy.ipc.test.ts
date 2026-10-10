import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const { handle, openExternal, scan } = vi.hoisted(() => ({
  handle: vi.fn(),
  openExternal: vi.fn(),
  scan: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle }, shell: { openExternal } }))
vi.mock('../services/app-privacy', () => ({ scanAppPrivacy: scan }))
import { registerAppPrivacyIpc } from './app-privacy.ipc'
import { IPC } from '../../shared/channels'

const handler = (channel: string): ((...args: unknown[]) => Promise<unknown>) =>
  handle.mock.calls.find((call) => call[0] === channel)![1]
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  registerAppPrivacyIpc()
})
afterEach(() => vi.restoreAllMocks())

describe('app privacy IPC', () => {
  it('opens only the three fixed settings destinations', async () => {
    for (const capability of ['webcam', 'microphone', 'location']) {
      await handler(IPC.APP_PRIVACY_SETTINGS)({}, capability)
      expect(openExternal).toHaveBeenLastCalledWith(`ms-settings:privacy-${capability}`)
    }
  })
  it('rejects URLs, prototype names, arbitrary capabilities and malformed arguments', async () => {
    for (const value of [
      'https://example.com',
      'ms-settings:privacy-webcam',
      'constructor',
      '__proto__',
      'webcam;calc',
      {},
      null,
      3
    ]) {
      await expect(handler(IPC.APP_PRIVACY_SETTINGS)({}, value)).rejects.toThrow('Unsupported')
    }
    expect(openExternal).not.toHaveBeenCalled()
  })
  it('rejects launching Windows settings on unsupported platforms and propagates launch failures', async () => {
    openExternal.mockRejectedValueOnce(new Error('Launch failed'))
    await expect(handler(IPC.APP_PRIVACY_SETTINGS)({}, 'webcam')).rejects.toThrow('Launch failed')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await expect(handler(IPC.APP_PRIVACY_SETTINGS)({}, 'webcam')).rejects.toThrow('Unsupported')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
  it('coalesces concurrent scans and allows refreshing once finished', async () => {
    let resolve!: (value: unknown) => void
    scan.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const a = handler(IPC.APP_PRIVACY_SCAN)()
    const b = handler(IPC.APP_PRIVACY_SCAN)()
    expect(scan).toHaveBeenCalledTimes(1)
    resolve({ records: [] })
    expect(await a).toEqual(await b)
    scan.mockResolvedValueOnce({ records: [] })
    await handler(IPC.APP_PRIVACY_SCAN)()
    expect(scan).toHaveBeenCalledTimes(2)
  })
  it('allows retry after scan failure without exposing success-shaped empty results', async () => {
    scan.mockRejectedValueOnce(new Error('Access denied'))
    await expect(handler(IPC.APP_PRIVACY_SCAN)()).rejects.toThrow('Access denied')
    scan.mockResolvedValueOnce({ records: [] })
    expect(await handler(IPC.APP_PRIVACY_SCAN)()).toEqual({ records: [] })
  })
})
