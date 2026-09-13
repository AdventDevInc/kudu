import { afterEach, beforeEach, expect, it, vi } from 'vitest'
// Unlike recovery.test.ts, only child_process is mocked here so the real
// exec-utf8 tool gate is exercised for every native call the adapter makes.
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: mocks.execFile, spawn: vi.fn() }))
vi.mock('./recovery-store', () => ({ getRecoveryEntry: vi.fn(), updateRecoveryEntry: vi.fn() }))
import { readRecoveryTarget, writeRecoveryTarget } from './recovery'

type Reply = { stdout: string } | Error
const platform = process.platform
/** Answer each spawned process in order; `file` is what exec-utf8 actually executed. */
function respond(...replies: Reply[]) {
  for (const reply of replies)
    mocks.execFile.mockImplementationOnce((_file, _args, _opts, cb) =>
      reply instanceof Error ? cb(reply) : cb(null, { ...reply, stderr: '' })
    )
}
const spawned = () => mocks.execFile.mock.calls.map((call) => call[0])
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => Object.defineProperty(process, 'platform', { value: platform, configurable: true }))

it('reads service state through the allowed PowerShell executor', async () => {
  respond({ stdout: '{"start":2,"delayed":1,"running":true}' })
  expect(await readRecoveryTarget({ kind: 'service-start', name: 'Spooler' })).toEqual({
    start: 2,
    delayed: 1,
    running: true
  })
  expect(spawned()).toEqual(['powershell'])
})
it('reports an absent registry value instead of failing on the PowerShell fallback', async () => {
  respond(new Error('Command failed: reg query'), { stdout: 'MISSING\r\n' })
  expect(
    await readRecoveryTarget({ kind: 'registry-dword', key: 'HKCU\\Software\\Test', name: 'Gone' })
  ).toBeNull()
  expect(spawned()).toEqual(['cmd.exe', 'powershell'])
})
it('restores a service with sc.exe, reg.exe, and PowerShell', async () => {
  respond({ stdout: '' }, { stdout: 'DelayedAutoStart REG_DWORD 0x1' }, { stdout: '' })
  await writeRecoveryTarget(
    { kind: 'service-start', name: 'Spooler' },
    { start: 2, delayed: 1, running: true }
  )
  expect(spawned()).toEqual(['sc.exe', 'cmd.exe', 'powershell'])
  expect(mocks.execFile.mock.calls[0][1]).toEqual(['config', 'Spooler', 'start=', 'delayed-auto'])
  expect(mocks.execFile.mock.calls[2][1].at(-1)).toContain("Start-Service -Name 'Spooler'")
})
it('rejects registry targets that fail validation before spawning anything', async () => {
  await expect(
    readRecoveryTarget({ kind: 'registry-dword', key: 'HKCU\\Software\\Test', name: "x'; evil" })
  ).rejects.toThrow('Invalid registry target')
  await expect(
    readRecoveryTarget({ kind: 'registry-dword', key: 'HKCR\\Software', name: 'Value' })
  ).rejects.toThrow('Invalid registry target')
  expect(mocks.execFile).not.toHaveBeenCalled()
})
