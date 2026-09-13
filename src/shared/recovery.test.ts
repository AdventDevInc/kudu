import { describe, expect, it } from 'vitest'
import { recoveryDecision, validateRecoveryEntry, type RecoveryEntry } from './recovery'

const entry: RecoveryEntry = {
  version: 1,
  id: '12345678-1234-1234-1234-123456789abc',
  createdAt: '2026-09-13T12:00:00Z',
  updatedAt: '2026-09-13T12:00:00Z',
  source: 'privacy',
  label: 'Setting',
  status: 'ready',
  target: { kind: 'registry-dword', key: 'HKCU\\Software\\Test', name: 'Value' },
  before: null,
  after: 1
}
describe('recovery safeguards', () => {
  it('distinguishes idempotent restores, eligible changes, and newer values', () => {
    expect(recoveryDecision(null, null, 1)).toBe('already-restored')
    expect(recoveryDecision(1, null, 1)).toBe('restore')
    expect(recoveryDecision(2, null, 1)).toBe('conflict')
  })
  it('treats a changed delayed start as a service conflict but not volatile running state', () => {
    const before = { start: 2, delayed: 1, running: true }
    const after = { start: 4, delayed: 1, running: false }
    expect(recoveryDecision({ ...after, delayed: 0 }, before, after)).toBe('conflict')
    expect(recoveryDecision({ ...after, running: true }, before, after)).toBe('restore')
    expect(recoveryDecision({ ...before, running: false }, before, after)).toBe('already-restored')
  })
  it('rejects unsupported types and script-bearing targets', () => {
    expect(validateRecoveryEntry(entry)).toBe(true)
    for (const name of ["bad'; Start-Process evil; '", '$env:SECRET', '../outside'])
      expect(validateRecoveryEntry({ ...entry, target: { ...entry.target, name } })).toBe(false)
    expect(validateRecoveryEntry({ ...entry, after: true })).toBe(false)
    expect(
      validateRecoveryEntry({ ...entry, target: { kind: 'command', name: 'reg import' } })
    ).toBe(false)
  })
})
