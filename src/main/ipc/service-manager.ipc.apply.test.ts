import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promisify } from 'util'

type ServiceState = { start: number; delayed: number | null; running: boolean }
const recovery = vi.hoisted(() => ({
  record: vi.fn(),
  read: vi.fn(),
  states: new Map<string, ServiceState>()
}))
vi.mock('../services/recovery-store', () => ({
  recordRecoveryChanges: recovery.record
}))
vi.mock('../services/recovery', () => ({
  readServiceStates: recovery.read
}))

// ── Mocks ──

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
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
  psUtf8: (cmd: string) => cmd
}))

const mockPlatformApply = vi.fn()
vi.mock('../platform', () => ({
  getPlatform: () => ({ services: { applyChanges: mockPlatformApply } })
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
  recovery.states = new Map()
  // Unknown services read as Manual/stopped; a test may seed a specific state.
  recovery.read.mockReset().mockImplementation(async (names: string[]) => {
    const map = new Map<string, ServiceState>()
    for (const name of names)
      map.set(name, recovery.states.get(name) ?? { start: 3, delayed: null, running: false })
    return map
  })
  // Journal like the real store: run the batch, then read back the after-states.
  recovery.record
    .mockReset()
    .mockImplementation(
      async (
        _source: unknown,
        _changes: unknown[],
        apply: () => Promise<(string | undefined)[]>,
        readAfter?: () => Promise<unknown[]>
      ) => {
        const failures = await apply()
        await readAfter?.()
        return failures
      }
    )
  setPlatform('win32')
})

/** The journal entries handed to the recovery store by the last apply. */
const journaled = () => recovery.record.mock.calls[0][1] as { before: unknown; after: unknown }[]

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

  it('clears the delayed-start flag when re-enabling a service as Automatic', async () => {
    recovery.states.set('seclogon', { start: 4, delayed: 1, running: false })
    const script = stubPowerShell('OK|seclogon|Secondary Logon')
    await applyServiceChanges([{ name: 'seclogon', targetStartType: 'Automatic' }])

    // Set-Service in Windows PowerShell leaves DelayedAutoStart alone, so the script
    // must write it and the journal must predict the value it writes.
    expect(script()).toContain(
      "Set-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\seclogon' -Name DelayedAutoStart -Value 0 -Type DWord"
    )
    expect(journaled()).toEqual([
      {
        label: 'seclogon',
        target: { kind: 'service-start', name: 'seclogon' },
        before: { start: 4, delayed: 1, running: false },
        after: { start: 2, delayed: 0, running: true }
      }
    ])
  })

  it('sets delayed start through the registry flag Windows PowerShell cannot set', async () => {
    const script = stubPowerShell('OK|seclogon|Secondary Logon')
    await applyServiceChanges([{ name: 'seclogon', targetStartType: 'AutomaticDelayed' }])

    expect(script()).toContain("Set-Service -Name 'seclogon' -StartupType Automatic")
    expect(script()).not.toContain('AutomaticDelayedStart')
    expect(script()).toContain('-Name DelayedAutoStart -Value 1 -Type DWord')
    expect(journaled()[0].after).toEqual({ start: 2, delayed: 1, running: true })
  })

  it('predicts that Manual and Disabled leave the delayed-start flag untouched', async () => {
    recovery.states.set('Fax', { start: 2, delayed: 1, running: true })
    recovery.states.set('seclogon', { start: 2, delayed: null, running: true })
    const script = stubPowerShell('OK|Fax|Fax\nOK|seclogon|Secondary Logon')
    await applyServiceChanges([
      { name: 'Fax', targetStartType: 'Disabled' },
      { name: 'seclogon', targetStartType: 'Manual' }
    ])

    expect(script()).not.toContain('DelayedAutoStart')
    expect(journaled().map((c) => c.after)).toEqual([
      { start: 4, delayed: 1, running: false },
      { start: 3, delayed: null, running: true }
    ])
  })

  it('snapshots, applies, and verifies a batch with one process per step', async () => {
    stubPowerShell('OK|Fax|Fax\nOK|WSearch|Windows Search\nOK|seclogon|Secondary Logon')
    const changes = [
      { name: 'Fax', targetStartType: 'Disabled' },
      { name: 'WSearch', targetStartType: 'Disabled' },
      { name: 'seclogon', targetStartType: 'Manual' }
    ]
    const result = await applyServiceChanges(changes)

    expect(result).toEqual({ succeeded: 3, failed: 0, errors: [] })
    // One before-read, one apply, one after-read — not three per service.
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(recovery.read.mock.calls).toEqual([
      [['Fax', 'WSearch', 'seclogon']],
      [['Fax', 'WSearch', 'seclogon']]
    ])
    expect(recovery.record).toHaveBeenCalledTimes(1)
    expect(journaled().map((c) => c.before)).toHaveLength(3)
  })

  it('does not touch a service whose original state cannot be captured', async () => {
    recovery.read.mockImplementation(
      async () => new Map([['Fax', { start: 2, delayed: 0, running: true }]])
    )
    const script = stubPowerShell('OK|Fax|Fax')
    const result = await applyServiceChanges([
      { name: 'Fax', targetStartType: 'Disabled' },
      { name: 'Ghost', targetStartType: 'Disabled' }
    ])

    expect(result.succeeded).toBe(1)
    expect(result.errors).toEqual([
      { name: 'Ghost', displayName: 'Ghost', reason: 'Original service state unavailable' }
    ])
    expect(script()).not.toContain('Ghost')
  })

  it('fails every change without mutating when the snapshot itself fails', async () => {
    recovery.read.mockRejectedValue(new Error('PowerShell unavailable'))
    stubPowerShell('OK|Fax|Fax')
    const result = await applyServiceChanges([{ name: 'Fax', targetStartType: 'Disabled' }])

    expect(result).toEqual({
      succeeded: 0,
      failed: 1,
      errors: [{ name: 'Fax', displayName: 'Fax', reason: 'PowerShell unavailable' }]
    })
    expect(mockExecFile).not.toHaveBeenCalled()
    expect(recovery.record).not.toHaveBeenCalled()
  })

  it('refuses to disable a system-critical service', async () => {
    stubPowerShell('')
    // RpcSs is rated unsafe in the safety knowledge base
    const result = await applyServiceChanges([{ name: 'RpcSs', targetStartType: 'Disabled' }])

    expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
    expect(mockExecFile).not.toHaveBeenCalled()
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
    stubPowerShell('OK|Fax|Fax\nFAIL|WSearch|WSearch|Access is denied')
    const result = await applyServiceChanges([
      { name: 'Fax', targetStartType: 'Disabled' },
      { name: 'WSearch', targetStartType: 'Disabled' }
    ])

    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toEqual({
      name: 'WSearch',
      displayName: 'WSearch',
      reason: 'Access is denied'
    })
    // The journal learns which entry failed so Recovery does not offer a bogus restore.
    expect(await recovery.record.mock.results[0].value).toEqual([undefined, 'Access is denied'])
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
