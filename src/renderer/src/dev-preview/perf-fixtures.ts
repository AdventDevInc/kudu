import type { PerfProcess, PerfProcessList } from '@shared/types'
import { appKey } from '@shared/perf-apps'

const GB = 1024 ** 3

export function perfFixture(timestamp: number, sample: number): PerfProcessList {
  const processes: PerfProcess[] = []
  for (const [index, [name, count, bytes]] of [
    ['firefox.exe', 25, 12.2 * GB],
    ['T3 Code.exe', 10, 5.9 * GB],
    ['explorer.exe', 1, 280 * 1024 ** 2],
    ['code.exe', 16, 1.4 * GB],
    ['worker.exe', 115, 0.7 * GB]
  ].entries()) {
    for (let i = 0; i < Number(count); i++) {
      const pid = 1000 + index * 200 + i
      const path = `C:\\Program Files\\${String(name).replace(/\.exe$/, '')}\\${name}`
      processes.push({
        pid,
        birthToken: `preview:${pid}`,
        parentPid: i ? 1000 + index * 200 : 0,
        name: String(name),
        path,
        appKey: appKey(String(name), path, 'Preview', true),
        user: 'Preview',
        started: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString(),
        memBytes: Number(bytes) / Number(count) + (index === 0 ? sample * 1024 ** 2 : 0),
        memPercent: 0,
        cpuPercent: index === 0 ? 0.4 : 0.1
      })
    }
  }
  return {
    timestamp,
    processes,
    totalCount: processes.length,
    windowsMemory: {
      timestamp,
      committedBytes: 26 * GB,
      commitLimitBytes: 64 * GB,
      pagesInputPerSec: 12,
      pagesOutputPerSec: 0
    }
  }
}
