import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()
vi.mock('child_process', () => ({
  execFile: execFileMock,
}))
vi.mock('util', () => ({
  promisify: (fn: any) => fn,
}))

const { createDarwinBrowser } = await import('./browser')

describe('darwin browser', () => {
  const browser = createDarwinBrowser()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('closeBrowsers', () => {
    it('calls killall for every known browser', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
      await browser.closeBrowsers()

      const calls = execFileMock.mock.calls
      expect(calls.length).toBeGreaterThan(10)
      for (const call of calls) {
        expect(call[0]).toBe('/usr/bin/killall')
        expect(call[1]).toHaveLength(1)
      }
    })

    it('includes Safari, Chrome, Firefox, and Arc', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
      await browser.closeBrowsers()

      const browserNames = execFileMock.mock.calls.map((c: any[]) => c[1][0])
      expect(browserNames).toContain('Safari')
      expect(browserNames).toContain('Google Chrome')
      expect(browserNames).toContain('firefox')
      expect(browserNames).toContain('Arc')
    })

    it('ignores errors when a browser is not running', async () => {
      execFileMock.mockRejectedValue(new Error('No matching processes'))
      await expect(browser.closeBrowsers()).resolves.toBeUndefined()
    })

    it('continues killing other browsers when one fails', async () => {
      let callCount = 0
      execFileMock.mockImplementation(() => {
        callCount++
        if (callCount === 1) return Promise.reject(new Error('not running'))
        return Promise.resolve({ stdout: '', stderr: '' })
      })
      await browser.closeBrowsers()
      // Should still call killall for all browsers
      expect(execFileMock.mock.calls.length).toBeGreaterThan(10)
    })

    it('passes a 5-second timeout to each killall call', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
      await browser.closeBrowsers()
      for (const call of execFileMock.mock.calls) {
        expect(call[2]).toEqual({ timeout: 5_000 })
      }
    })
  })
})
