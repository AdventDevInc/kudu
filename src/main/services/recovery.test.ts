import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { RecoveryEntry } from '../../shared/recovery'
const mocks = vi.hoisted(() => ({ exec: vi.fn(), get: vi.fn(), update: vi.fn() }))
vi.mock('./exec-utf8', () => ({
  execNativeUtf8: mocks.exec,
  execTracked: mocks.exec,
  psUtf8: (v: string) => v
}))
vi.mock('./recovery-store', () => ({
  getRecoveryEntry: mocks.get,
  updateRecoveryEntry: mocks.update
}))
import { restoreRecoveryEntry } from './recovery'
const platform = process.platform
const original: RecoveryEntry = {
  version: 1,
  id: '12345678-1234-1234-1234-123456789abc',
  createdAt: '2026-09-13T12:00:00Z',
  updatedAt: '2026-09-13T12:00:00Z',
  source: 'privacy',
  label: 'Setting',
  status: 'ready',
  target: { kind: 'registry-dword', key: 'HKCU\\Software\\Test', name: 'Value' },
  before: 3,
  after: 1
}
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  mocks.get.mockResolvedValue(structuredClone(original))
})
afterEach(() => Object.defineProperty(process, 'platform', { value: platform, configurable: true }))
it('does not overwrite a newer setting', async () => {
  mocks.exec.mockResolvedValue({ stdout: 'Value REG_DWORD 0x2' })
  expect((await restoreRecoveryEntry(original.id)).status).toBe('conflict')
  expect(mocks.exec).toHaveBeenCalledTimes(1)
})
it('restores the original value and verifies it before reporting success', async () => {
  mocks.exec
    .mockResolvedValueOnce({ stdout: 'Value REG_DWORD 0x1' })
    .mockResolvedValueOnce({ stdout: '' })
    .mockResolvedValueOnce({ stdout: 'Value REG_DWORD 0x3' })
  expect((await restoreRecoveryEntry(original.id)).status).toBe('restored')
  expect(mocks.exec.mock.calls[1][1]).toEqual([
    'add',
    original.target.kind === 'registry-dword' ? original.target.key : '',
    '/v',
    'Value',
    '/t',
    'REG_DWORD',
    '/d',
    '3',
    '/f'
  ])
})
it('leaves already restored settings alone', async () => {
  mocks.exec.mockResolvedValue({ stdout: 'Value REG_DWORD 0x3' })
  expect((await restoreRecoveryEntry(original.id)).status).toBe('restored')
  expect(mocks.exec.mock.calls.every((call) => call[1][0] === 'query')).toBe(true)
})
it('does not report a successful restore when verification fails', async () => {
  mocks.exec.mockResolvedValue({ stdout: 'Value REG_DWORD 0x1' })
  await expect(restoreRecoveryEntry(original.id)).rejects.toThrow('could not be verified')
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
})
const service: RecoveryEntry = {
  ...original,
  source: 'services',
  target: { kind: 'service-start', name: 'Spooler' },
  before: { start: 2, delayed: 1, running: true },
  after: { start: 4, delayed: 1, running: false }
}
it('starts a service whose configuration is restored but which is still stopped', async () => {
  mocks.get.mockResolvedValue(structuredClone(service))
  mocks.exec
    .mockResolvedValueOnce({ stdout: '{"Spooler":{"start":2,"delayed":1,"running":false}}' })
    .mockResolvedValueOnce({ stdout: '' })
    .mockResolvedValueOnce({ stdout: 'DelayedAutoStart REG_DWORD 0x1' })
    .mockResolvedValueOnce({ stdout: '' })
    .mockResolvedValueOnce({ stdout: '{"Spooler":{"start":2,"delayed":1,"running":true}}' })
  expect((await restoreRecoveryEntry(service.id)).status).toBe('restored')
  expect(mocks.exec.mock.calls.map((call) => call[0])).toEqual([
    'powershell',
    'sc.exe',
    'reg',
    'powershell',
    'powershell'
  ])
  expect(mocks.exec.mock.calls[3][1].at(-1)).toContain("Start-Service -Name 'Spooler'")
})
it('fails instead of reporting restored when the service cannot be started', async () => {
  mocks.get.mockResolvedValue(structuredClone(service))
  mocks.exec
    .mockResolvedValueOnce({ stdout: '{"Spooler":{"start":2,"delayed":1,"running":false}}' })
    .mockResolvedValueOnce({ stdout: '' })
    .mockResolvedValueOnce({ stdout: 'DelayedAutoStart REG_DWORD 0x1' })
    .mockRejectedValueOnce(new Error('Service cannot be started'))
  await expect(restoreRecoveryEntry(service.id)).rejects.toThrow('cannot be started')
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
})
it('resolves only persisted IDs and never accepts a renderer path', async () => {
  mocks.get.mockResolvedValue(undefined)
  await expect(restoreRecoveryEntry('C:\\untrusted.reg')).rejects.toThrow('not found')
  expect(mocks.exec).not.toHaveBeenCalled()
})
