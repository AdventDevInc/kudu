import type { PerfSnapshot } from '@shared/types'

const rangeMs = { '60s': 60_000, '5m': 300_000, '15m': 900_000 }

/** Select by recorded time (including pauses), cap SVG work, and retain the newest reading. */
export function buildTimeSeries(
  history: PerfSnapshot[],
  range: keyof typeof rangeMs,
  metric: 'cpu' | 'memory' | 'disk'
) {
  const last = history.at(-1)
  if (!last) return []
  const visible = history.filter((sample) => sample.timestamp >= last.timestamp - rangeMs[range])
  const step = Math.max(1, Math.ceil(visible.length / 119))
  const selected = visible.filter((_, i) => i % step === 0)
  if (selected.at(-1) !== last) selected.push(last)
  return selected.map((sample) =>
    metric === 'disk'
      ? {
          time: sample.timestamp,
          read: sample.disk.readBytesPerSec / 1048576,
          write: sample.disk.writeBytesPerSec / 1048576
        }
      : {
          time: sample.timestamp,
          value: metric === 'cpu' ? sample.cpu.overall : sample.memory.percent
        }
  )
}
