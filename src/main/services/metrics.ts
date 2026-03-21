import { app } from 'electron'
import * as os from 'os'
import * as si from 'systeminformation'
import { getHistory } from './history-store'

export interface MetricLine {
  name: string
  type: 'gauge' | 'counter'
  help: string
  labels?: Record<string, string>
  value: number
}

export async function collectMetrics(): Promise<MetricLine[]> {
  const metrics: MetricLine[] = []

  // App info
  metrics.push({
    name: 'kudu_info',
    type: 'gauge',
    help: 'Kudu application info',
    labels: { version: app.getVersion(), platform: process.platform, arch: process.arch },
    value: 1,
  })

  // System uptime
  metrics.push({
    name: 'kudu_system_uptime_seconds',
    type: 'gauge',
    help: 'System uptime in seconds',
    value: os.uptime(),
  })

  // CPU and memory
  try {
    const [load, mem] = await Promise.all([si.currentLoad(), si.mem()])

    metrics.push({
      name: 'kudu_system_cpu_usage_percent',
      type: 'gauge',
      help: 'Current CPU usage percentage',
      value: Math.round(load.currentLoad * 100) / 100,
    })

    metrics.push({
      name: 'kudu_system_memory_total_bytes',
      type: 'gauge',
      help: 'Total system memory in bytes',
      value: mem.total,
    })

    metrics.push({
      name: 'kudu_system_memory_used_bytes',
      type: 'gauge',
      help: 'Used system memory in bytes',
      value: mem.used,
    })
  } catch {
    // systeminformation may fail on some platforms
  }

  // History-based metrics
  // These are gauges, not counters, because history is capped at 100 entries
  // and can be cleared — so values may decrease, violating counter semantics.
  const history = getHistory()

  metrics.push({
    name: 'kudu_scans_total',
    type: 'gauge',
    help: 'Total number of scans in history',
    value: history.length,
  })

  const totalItemsCleaned = history.reduce((s, e) => s + e.totalItemsCleaned, 0)
  metrics.push({
    name: 'kudu_items_cleaned_total',
    type: 'gauge',
    help: 'Total items cleaned across history',
    value: totalItemsCleaned,
  })

  const totalSpaceSaved = history.reduce((s, e) => s + e.totalSpaceSaved, 0)
  metrics.push({
    name: 'kudu_space_saved_bytes_total',
    type: 'gauge',
    help: 'Total space saved in bytes across history',
    value: totalSpaceSaved,
  })

  const totalErrors = history.reduce((s, e) => s + e.errorCount, 0)
  metrics.push({
    name: 'kudu_scan_errors_total',
    type: 'gauge',
    help: 'Total scan errors across history',
    value: totalErrors,
  })

  if (history.length > 0) {
    const latest = history[0]
    metrics.push({
      name: 'kudu_last_scan_timestamp_seconds',
      type: 'gauge',
      help: 'Timestamp of the most recent scan in seconds since epoch',
      value: Math.floor(new Date(latest.timestamp).getTime() / 1000),
    })

    metrics.push({
      name: 'kudu_last_scan_duration_seconds',
      type: 'gauge',
      help: 'Duration of the most recent scan in seconds',
      value: Math.round(latest.duration / 1000 * 100) / 100,
    })

    metrics.push({
      name: 'kudu_last_scan_items_found',
      type: 'gauge',
      help: 'Number of items found in the most recent scan',
      value: latest.totalItemsFound,
    })
  }

  return metrics
}

export function formatPrometheus(metrics: MetricLine[]): string {
  const lines: string[] = []

  for (const m of metrics) {
    lines.push(`# HELP ${m.name} ${m.help}`)
    lines.push(`# TYPE ${m.name} ${m.type}`)

    if (m.labels && Object.keys(m.labels).length > 0) {
      const labelStr = Object.entries(m.labels)
        .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
        .join(',')
      lines.push(`${m.name}{${labelStr}} ${m.value}`)
    } else {
      lines.push(`${m.name} ${m.value}`)
    }

    lines.push('')
  }

  return lines.join('\n')
}
