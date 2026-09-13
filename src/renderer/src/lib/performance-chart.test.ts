import { describe, expect, it } from 'vitest'
import { buildTimeSeries } from './performance-chart'
import type { PerfSnapshot } from '@shared/types'

function sample(timestamp: number, value = 12): PerfSnapshot {
  return {
    timestamp,
    cpu: { overall: value, perCore: [value] },
    memory: { usedBytes: 8, totalBytes: 32, cachedBytes: 0, percent: 25 },
    disk: { readBytesPerSec: 2 * 1048576, writeBytesPerSec: 1048576 },
    network: { rxBytesPerSec: 0, txBytesPerSec: 0 },
    uptime: 0
  }
}
describe('performance graph readings', () => {
  it('uses timestamps rather than sample counts when monitoring was paused', () => {
    const history = [sample(0), sample(1000), sample(125000), sample(130000)]
    expect(buildTimeSeries(history, '60s', 'cpu').map((point) => point.time)).toEqual([
      125000, 130000
    ])
    expect(buildTimeSeries(history, '5m', 'cpu')).toHaveLength(4)
  })
  it('caps graph work and retains the latest reading', () => {
    const history = Array.from({ length: 900 }, (_, i) => sample(i * 1000, i === 899 ? 89 : 12))
    const result = buildTimeSeries(history, '15m', 'cpu')
    expect(result.length).toBeLessThanOrEqual(120)
    expect(result.at(-1)).toEqual({ time: 899000, value: 89 })
  })
  it('reports real transfer rates and leaves missing data empty', () => {
    expect(buildTimeSeries([sample(1000)], '60s', 'disk')).toEqual([
      { time: 1000, read: 2, write: 1 }
    ])
    expect(buildTimeSeries([], '60s', 'memory')).toEqual([])
  })
})
