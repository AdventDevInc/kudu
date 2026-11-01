import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

vi.mock('util', () => ({
  promisify: () => execFileMock
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
        'chrome.exe',
        'msedge.exe',
        'brave.exe',
        'vivaldi.exe',
        'opera.exe',
        'firefox.exe',
        'arc.exe',
        'chromium.exe',
        'thorium.exe',
        'supermium.exe',
        'helium.exe',
        'cromite.exe',
        'CatsXP.exe',
        'librewolf.exe',
        'waterfox.exe',
        'floorp.exe',
        'zen.exe'
      ]

      expect(execFileMock).toHaveBeenCalledTimes(expectedProcesses.length)
      for (const proc of expectedProcesses) {
        expect(execFileMock).toHaveBeenCalledWith('taskkill', ['/IM', proc, '/F'], {
          timeout: 5000
        })
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

describe('win32 browser selection', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })
  it('closes only explicitly selected allowlisted browsers', async () => {
    execFileMock.mockResolvedValue({ stdout: '' })
    await createWin32Browser().closeBrowsers(['chrome.exe', 'untrusted-process'])
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock.mock.calls[0][1]).toContain('chrome.exe')
  })
  it('keeps every browser open when all are unchecked', async () => {
    await createWin32Browser().closeBrowsers([])
    expect(execFileMock).not.toHaveBeenCalled()
  })
  it('detects running browsers by exact process name', async () => {
    execFileMock.mockResolvedValue({ stdout: '"chrome.exe","123"\n"msedge.exe","456"' })
    expect(await createWin32Browser().runningBrowsers()).toContain('chrome.exe')
  })
})
