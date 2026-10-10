import { describe, expect, it } from 'vitest'
import { linuxBirthToken } from './perf-process-identity'
import { groupApps } from '../../shared/perf-apps'
import { mapPerfProcesses } from './perf-processes'
import type { Systeminformation } from 'systeminformation'

describe('stable native process creation identities', () => {
  it('reads the Linux kernel start ticks even when comm contains spaces and parentheses', () => {
    const fields = ['S', ...Array.from({ length: 18 }, () => '0'), '7654321', '4096']
    expect(linuxBirthToken(`123 (a process) with (brackets)) ${fields.join(' ')}`)).toBe(
      'linux:7654321'
    )
    expect(linuxBirthToken('123 (short) S 0')).toBe('')
    expect(linuxBirthToken('malformed')).toBe('')
  })
  it('ignores SI elapsed-time rounding jitter for trends and action identity, without a time tolerance', () => {
    const input = {
      pid: 12,
      name: 'browser',
      path: '/bin',
      user: 'a',
      started: '2026-10-09 10:00:01',
      cpu: 1,
      memRss: 1024
    } as Systeminformation.ProcessesProcessData
    for (const token of ['linux:123456', 'darwin:Fri Oct 9 10:00:00 2026']) {
      const first = mapPerfProcesses([input], 1e9, false, undefined, new Map([[12, token]]))
      const next = mapPerfProcesses(
        [{ ...input, started: '2026-10-09 10:00:00' }],
        1e9,
        false,
        undefined,
        new Map([[12, token]])
      )
      expect(next[0].birthToken).toBe(first[0].birthToken)
      expect(groupApps(next, 10_000, groupApps(first, 0))[0].history).toHaveLength(2)
      const replaced = mapPerfProcesses(
        [input],
        1e9,
        false,
        undefined,
        new Map([[12, `${token}-different`]])
      )
      expect(groupApps(replaced, 10_000, groupApps(first, 0))[0].history).toHaveLength(1)
    }
  })
  it('never substitutes jittery estimates when native identity is unavailable', () => {
    const [mapped] = mapPerfProcesses(
      [{ pid: 12, started: '2026-10-09 10:00:01' } as Systeminformation.ProcessesProcessData],
      1e9,
      false
    )
    expect(mapped.birthToken).toBe('')
    expect(groupApps([mapped], 10_000, groupApps([mapped], 0))[0].history).toHaveLength(1)
  })
})
