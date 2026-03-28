import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: execFileMock,
}))

vi.mock('util', () => ({
  promisify: () => execFileMock,
}))

const { createWin32Browser } = await import('./browser')

describe('win32 browser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const browser = createWin32Browser()

  describe('closeBrowsers', () => {
    it('calls taskkill for each browser process', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' })

      await browser.closeBrowsers()

      const expectedProcesses = [
        'chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe',
        'opera.exe', 'firefox.exe', 'arc.exe', 'chromium.exe',
        'thorium.exe', 'supermium.exe', 'helium.exe', 'cromite.exe',
        'CatsXP.exe', 'librewolf.exe', 'waterfox.exe', 'floorp.exe', 'zen.exe',
      ]

      expect(execFileMock).toHaveBeenCalledTimes(expectedProcesses.length)
      for (const proc of expectedProcesses) {
        expect(execFileMock).toHaveBeenCalledWith(
          'taskkill',
          ['/IM', proc, '/F'],
          { timeout: 5000 }
        )
      }
    })

    it('ignores errors when a process is not running', async () => {
      execFileMock.mockRejectedValue(new Error('No running instance'))

      await expect(browser.closeBrowsers()).resolves.toBeUndefined()
    })

    it('continues killing remaining browsers after one fails', async () => {
      let callCount = 0
      execFileMock.mockImplementation(() => {
        callCount++
        if (callCount === 3) return Promise.reject(new Error('not running'))
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      await browser.closeBrowsers()

      // All 17 browsers should still be attempted
      expect(execFileMock).toHaveBeenCalledTimes(17)
    })
  })
})
