import { describe, it, expect } from 'vitest'
import { parseWindowsMemory } from './perf-memory'
import { mapPerfProcesses } from './perf-processes'
import type { Systeminformation } from 'systeminformation'

describe('performance memory measurements', () => {
  const counters = {
    CommittedBytes: '1024',
    CommitLimit: '4096',
    PagesInputPersec: 0,
    PagesOutputPersec: '12'
  }
  it('accepts CIM numeric strings and legitimate zero paging without treating commit as pagefile usage', () => {
    expect(parseWindowsMemory(counters, 123)).toEqual({
      timestamp: 123,
      committedBytes: 1024,
      commitLimitBytes: 4096,
      pagesInputPerSec: 0,
      pagesOutputPerSec: 12
    })
  })
  it.each([
    null,
    [],
    {},
    { ...counters, CommitLimit: 0 },
    { ...counters, PagesInputPersec: null },
    { ...counters, CommittedBytes: '' },
    { ...counters, PagesOutputPersec: -1 },
    { ...counters, CommitLimit: Infinity }
  ])('fails closed for incomplete or invalid counters: %j', (input) => {
    expect(parseWindowsMemory(input, 1)).toBeNull()
  })
  it('converts KiB RSS to bytes on every platform before summing or calculating percentages', () => {
    for (const windows of [false, true]) {
      const list = Array.from(
        { length: 150 },
        (_, pid) =>
          ({
            pid,
            parentPid: 1,
            name: 'app',
            path: '/app',
            user: 'a',
            started: '2026-01-01',
            memRss: 1024,
            cpu: 3
          }) as Systeminformation.ProcessesProcessData
      )
      const mapped = mapPerfProcesses(list, 4 * 1024 ** 2, windows)
      expect(mapped).toHaveLength(150)
      expect(mapped[0]).toMatchObject({
        memBytes: 1024 ** 2,
        memPercent: 25,
        cpuPercent: 3,
        parentPid: 1,
        path: '/app'
      })
    }
  })
  it('sanitizes missing numeric measurements without leaking command-line arguments', () => {
    const [mapped] = mapPerfProcesses(
      [
        {
          pid: 7,
          name: 'app',
          memRss: NaN,
          cpu: Infinity,
          command: 'app --secret=x'
        } as Systeminformation.ProcessesProcessData
      ],
      0,
      true
    )
    expect(mapped).toMatchObject({ memBytes: 0, memPercent: 0, cpuPercent: 0 })
    expect(mapped).not.toHaveProperty('command')
  })
})
