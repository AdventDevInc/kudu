import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFile = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}))

const { createLinuxBrowser } = await import('./browser')

describe('linux browser', () => {
  const browser = createLinuxBrowser()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('closeBrowsers', () => {
    it('calls pkill for each known browser process', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await browser.closeBrowsers()

      // Should call pkill -x for every browser process name
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(10)
      for (const call of mockExecFile.mock.calls) {
        expect(call[0]).toBe('/usr/bin/pkill')
        expect(call[1][0]).toBe('-x')
      }
    })

    it('includes chrome, firefox, brave, and edge in the process list', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await browser.closeBrowsers()

      const processNames = mockExecFile.mock.calls.map((c: any[]) => c[1][1])
      expect(processNames).toContain('google-chrome')
      expect(processNames).toContain('firefox')
      expect(processNames).toContain('brave-browser')
      expect(processNames).toContain('msedge')
    })

    it('includes chromium variants', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await browser.closeBrowsers()

      const processNames = mockExecFile.mock.calls.map((c: any[]) => c[1][1])
      expect(processNames).toContain('chromium')
      expect(processNames).toContain('chromium-browser')
    })

    it('ignores errors when a process is not running', async () => {
      // pkill exits 1 when no matching process is found
      mockExecFile.mockRejectedValue(new Error('exit code 1'))

      await expect(browser.closeBrowsers()).resolves.toBeUndefined()
    })

    it('continues killing other browsers if one fails', async () => {
      let callCount = 0
      mockExecFile.mockImplementation(() => {
        callCount++
        if (callCount === 3) return Promise.reject(new Error('exit code 1'))
        return Promise.resolve({ stdout: '', stderr: '' })
      })

      await browser.closeBrowsers()

      // Should still have attempted all browsers
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(10)
    })

    it('uses exact match (-x) to avoid killing unrelated processes', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await browser.closeBrowsers()

      for (const call of mockExecFile.mock.calls) {
        expect(call[1]).toContain('-x')
        // Should NOT use -f flag
        expect(call[1]).not.toContain('-f')
      }
    })

    it('sets a 5-second timeout for each pkill call', async () => {
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' })

      await browser.closeBrowsers()

      for (const call of mockExecFile.mock.calls) {
        expect(call[2]).toEqual({ timeout: 5_000 })
      }
    })
  })
})
