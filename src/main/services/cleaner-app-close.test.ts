import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execTracked } = vi.hoisted(() => ({ execTracked: vi.fn() }))
vi.mock('./exec-utf8', () => ({ execTracked, psUtf8: (script: string) => script }))
import { closeCleanerApps, findWindowsFileBlockers } from './cleaner-blockers'

beforeEach(() => {
  vi.clearAllMocks()
  const windowsProcess = Object.create(process)
  Object.defineProperty(windowsProcess, 'platform', { value: 'win32' })
  vi.stubGlobal('process', windowsProcess)
})
afterEach(() => vi.unstubAllGlobals())

async function detectSlack(pid: number) {
  execTracked.mockResolvedValueOnce({
    stdout: JSON.stringify([
      {
        pid,
        name: 'Slack',
        processName: 'slack',
        executablePath: "C:\\Users\\Someone's\\Slack.exe",
        started: '123456789'
      }
    ])
  })
  await findWindowsFileBlockers(['C:\\cache\\file'])
  execTracked.mockClear()
  execTracked.mockResolvedValue({ stdout: '' })
}

describe('closing confirmed cleanup blockers', () => {
  it('only closes selected apps, checks identity and requests a normal window close', async () => {
    await detectSlack(4231)
    await closeCleanerApps([4231, 9876])
    expect(execTracked).toHaveBeenCalledTimes(1)
    const script = execTracked.mock.calls[0][1][3] as string
    expect(script).toContain('Get-Process -Id 4231')
    expect(script).toContain("Someone''s")
    expect(script).toContain('123456789')
    expect(script).toContain('StartTime.ToUniversalTime().Ticks')
    expect(script).toContain('CloseMainWindow()')
    expect(script).not.toMatch(/Stop-Process|taskkill|\.Kill\(/)
  })
  it('does nothing when everything is unchecked or the PID was never detected', async () => {
    await closeCleanerApps([])
    await closeCleanerApps([98765])
    expect(execTracked).not.toHaveBeenCalled()
  })
  it('does not close apps using an expired preflight', async () => {
    await detectSlack(4232)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    try {
      await closeCleanerApps([4232])
      expect(execTracked).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })
  it('rejects invalid process selections', async () => {
    await expect(closeCleanerApps([-1])).rejects.toThrow('Invalid application selection')
    await expect(closeCleanerApps('slack')).rejects.toThrow('Invalid application selection')
    expect(execTracked).not.toHaveBeenCalled()
  })
})
