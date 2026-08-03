import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promisify } from 'util'

// ── Mocks ──

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

const mockExecFile = vi.fn()

// The real execFile carries a promisify.custom symbol so promisify(execFile)
// resolves to { stdout, stderr } — the mock has to do the same.
vi.mock('child_process', () => {
  const fn = (...args: unknown[]) => mockExecFile(...args)
  ;(fn as any)[promisify.custom] = (cmd: string, args: string[], opts?: unknown) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mockExecFile(cmd, args, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
  return { execFile: fn }
})

vi.mock('../services/exec-utf8', () => ({
  psUtf8: (cmd: string) => cmd,
}))

const mockPlatformApply = vi.fn()
vi.mock('../platform', () => ({
  getPlatform: () => ({ services: { applyChanges: mockPlatformApply } }),
}))

import { applyServiceChanges } from './service-manager.ipc'

const originalPlatform = process.platform

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

/** Resolve the PowerShell run with the given stdout and hand back the script. */
function stubPowerShell(stdout: string): () => string {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, stdout, ''))
  return () => {
    const args = mockExecFile.mock.calls[0][1] as string[]
    return args[args.length - 1]
  }
}

beforeEach(() => {
  mockExecFile.mockReset()
  mockPlatformApply.mockReset()
  setPlatform('win32')
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('applyServiceChanges', () => {
  it('stops a service only when disabling it', async () => {
    const script = stubPowerShell('OK|Spooler|Print Spooler')
    await applyServiceChanges([{ name: 'Spooler', targetStartType: 'Disabled' }])

    expect(script()).toContain("Set-Service -Name 'Spooler' -StartupType Disabled")
    expect(script()).toContain('Stop-Service')
    expect(script()).not.toContain('Start-Service')
  })

  it('restores a disabled service to Manual without starting it', async () => {
    const script = stubPowerShell('OK|seclogon|Secondary Logon')
    const result = await applyServiceChanges([{ name: 'seclogon', targetStartType: 'Manual' }])

    expect(result).toEqual({ succeeded: 1, failed: 0, errors: [] })
    expect(script()).toContain("Set-Service -Name 'seclogon' -StartupType Manual")
    expect(script()).not.toContain('Stop-Service')
    expect(script()).not.toContain('Start-Service')
  })

  it('starts a service restored to Automatic so the change needs no reboot', async () => {
    const script = stubPowerShell('OK|seclogon|Secondary Logon')
    await applyServiceChanges([{ name: 'seclogon', targetStartType: 'Automatic' }])

    expect(script()).toContain("Set-Service -Name 'seclogon' -StartupType Automatic")
    expect(script()).toContain("Start-Service -Name 'seclogon'")
    expect(script()).not.toContain('Stop-Service')
  })

  it('refuses to disable a system-critical service', async () => {
    stubPowerShell('')
    // RpcSs is rated unsafe in the safety knowledge base
    const result = await applyServiceChanges([{ name: 'RpcSs', targetStartType: 'Disabled' }])

    expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
    expect(mockExecFile.mock.calls[0][1].join('')).not.toContain('RpcSs')
  })

  it('allows re-enabling a system-critical service', async () => {
    const script = stubPowerShell('OK|RpcSs|Remote Procedure Call (RPC)')
    const result = await applyServiceChanges([{ name: 'RpcSs', targetStartType: 'Manual' }])

    expect(result.succeeded).toBe(1)
    expect(script()).toContain("Set-Service -Name 'RpcSs' -StartupType Manual")
  })

  it('rejects an unrecognised start type instead of coercing it to Disabled', async () => {
    stubPowerShell('')
    const result = await applyServiceChanges([{ name: 'seclogon', targetStartType: 'Enabled' }])

    expect(result.errors[0].reason).toBe('Invalid start type')
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('rejects an invalid service name before running anything', async () => {
    stubPowerShell('')
    const result = await applyServiceChanges([{ name: 'svc; rm -rf /', targetStartType: 'Manual' }])

    expect(result.errors[0].reason).toBe('Invalid service name')
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('reports per-service failures from the script output', async () => {
    stubPowerShell(['OK|Fax|Fax', 'FAIL|WSearch|WSearch|Access is denied'].join('\n'))
    const result = await applyServiceChanges([
      { name: 'Fax', targetStartType: 'Disabled' },
      { name: 'WSearch', targetStartType: 'Disabled' },
    ])

    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toEqual({ name: 'WSearch', displayName: 'WSearch', reason: 'Access is denied' })
  })

  it('delegates to the platform layer off Windows', async () => {
    setPlatform('linux')
    mockPlatformApply.mockResolvedValue({ succeeded: 1, failed: 0, errors: [] })
    const changes = [{ name: 'bluetooth', targetStartType: 'Automatic' }]

    const result = await applyServiceChanges(changes)

    expect(mockPlatformApply).toHaveBeenCalledWith(changes)
    expect(result.succeeded).toBe(1)
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})
