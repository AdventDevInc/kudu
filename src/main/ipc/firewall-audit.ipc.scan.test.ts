import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ──

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

const mockSpawnTrackedLines = vi.fn()
vi.mock('../services/exec-utf8', () => ({
  psUtf8: (cmd: string) => cmd,
  spawnTrackedLines: (...args: unknown[]) => mockSpawnTrackedLines(...args),
}))

import { scanFirewallRules } from './firewall-audit.ipc'
import type { FirewallScanProgress } from '../../shared/types'

const originalPlatform = process.platform

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

/**
 * Stand in for the PowerShell run: replay `lines` through the onLine callback,
 * then resolve with the given process outcome.
 */
function stubScan(
  lines: string[],
  outcome: { stderr?: string; code?: number | null; timedOut?: boolean } = {}
): void {
  mockSpawnTrackedLines.mockImplementation(
    async (_file: string, _args: string[], onLine: (line: string) => void) => {
      for (const l of lines) onLine(l)
      return { stderr: outcome.stderr ?? '', code: outcome.code ?? 0, timedOut: outcome.timedOut ?? false }
    }
  )
}

// A third-party rule with a program that no longer exists → "stale".
const STALE_RULE =
  'RULE|MyApp-In|My App (In)|Lets my app listen||Private|TCP|8080|LocalSubnet|C:\\Apps\\gone.exe|C:\\Apps\\gone.exe|False||False|False|true'
// A Microsoft rule pointing at a real system binary → built-in, no findings.
const BUILTIN_RULE =
  'RULE|CoreNet-In|Core Networking (In)|@FirewallAPI.dll,-25000|@FirewallAPI.dll,-25000|Any|Any|Any|Any|%SystemRoot%\\system32\\svchost.exe|C:\\Windows\\system32\\svchost.exe|True|signed|True|False|true'

beforeEach(() => {
  mockSpawnTrackedLines.mockReset()
  setPlatform('win32')
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('scanFirewallRules', () => {
  it('returns an empty result off Windows without spawning anything', async () => {
    setPlatform('linux')
    const result = await scanFirewallRules()
    expect(result.rules).toEqual([])
    expect(result.totalCount).toBe(0)
    expect(mockSpawnTrackedLines).not.toHaveBeenCalled()
  })

  it('parses streamed rule lines and derives the issue counts', async () => {
    stubScan(['TOTAL|2', STALE_RULE, BUILTIN_RULE])
    const result = await scanFirewallRules()

    expect(result.rules).toHaveLength(2)
    expect(result.totalCount).toBe(2)
    expect(result.staleCount).toBe(1)
    expect(result.rules[0].name).toBe('MyApp-In')
    expect(result.rules[0].issues).toContain('stale')
    expect(result.rules[1].builtin).toBe(true)
    expect(result.truncated).toBe(false)
  })

  it('reports progress from PROG markers as they stream in, not after the fact', async () => {
    const seen: FirewallScanProgress[] = []
    // Record how many rules had been parsed when each progress event fired —
    // buffering the whole run would make every event arrive at the end.
    const parsedAt: number[] = []
    mockSpawnTrackedLines.mockImplementation(
      async (_f: string, _a: string[], onLine: (line: string) => void) => {
        onLine('TOTAL|2')
        onLine(STALE_RULE)
        onLine('PROG|1|2|My App (In)')
        onLine(BUILTIN_RULE)
        onLine('PROG|2|2|Core Networking (In)')
        return { stderr: '', code: 0, timedOut: false }
      }
    )

    await scanFirewallRules((p) => {
      seen.push(p)
      parsedAt.push(p.current)
    })

    const classifying = seen.filter((p) => p.phase === 'classifying')
    expect(classifying).toHaveLength(2)
    expect(classifying[0]).toMatchObject({ current: 1, total: 2, currentRule: 'My App (In)' })
    expect(classifying[1]).toMatchObject({ current: 2, total: 2, currentRule: 'Core Networking (In)' })
    expect(parsedAt).toEqual([0, 1, 2])
  })

  it('surfaces stderr rather than the echoed script when the run fails outright', async () => {
    stubScan([], { stderr: 'Get-NetFirewallRule : Access is denied.', code: 1 })

    await expect(scanFirewallRules()).rejects.toThrow(/Access is denied/)
    await expect(scanFirewallRules()).rejects.not.toThrow(/Get-NetFirewallApplicationFilter/)
  })

  it('falls back to the exit code when a failed run wrote nothing to stderr', async () => {
    stubScan([], { stderr: '', code: 1 })
    await expect(scanFirewallRules()).rejects.toThrow(/exited with code 1/)
  })

  it('reports a timeout in plain language when nothing was returned', async () => {
    stubScan([], { code: null, timedOut: true })
    await expect(scanFirewallRules()).rejects.toThrow(/timed out/i)
  })

  it('keeps rules streamed before a timeout and marks the result truncated', async () => {
    stubScan(['TOTAL|2', STALE_RULE], { code: null, timedOut: true })
    const result = await scanFirewallRules()

    expect(result.rules).toHaveLength(1)
    expect(result.totalCount).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('marks the result truncated when fewer rules arrived than were enumerated', async () => {
    stubScan(['TOTAL|5', STALE_RULE])
    const result = await scanFirewallRules()
    expect(result.truncated).toBe(true)
  })
})
