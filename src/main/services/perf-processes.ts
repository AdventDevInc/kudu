import type { Systeminformation } from 'systeminformation'
import type { PerfProcess } from '../../shared/types'
import { appKey } from '../../shared/perf-apps'

export function mapPerfProcesses(
  list: Systeminformation.ProcessesProcessData[],
  totalMem: number,
  windows: boolean,
  startupNames = new Map<string, string>(),
  birthTokens = new Map<number, string>()
): PerfProcess[] {
  const finite = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0)
  return list.map((p) => {
    const exeName = (p.name || '').toLowerCase()
    const startupName = startupNames.get(exeName.endsWith('.exe') ? exeName : `${exeName}.exe`)
    // systeminformation returns RSS in KiB on Windows, macOS and Linux.
    const memBytes = finite(p.memRss) * 1024
    return {
      pid: p.pid,
      parentPid: p.parentPid,
      name: p.name || String(p.pid),
      path: p.path || '',
      appKey: appKey(p.name || String(p.pid), p.path || '', p.user || '', windows),
      cpuPercent: finite(p.cpu),
      memBytes,
      memPercent: totalMem > 0 ? (memBytes / totalMem) * 100 : 0,
      user: p.user || '',
      started: p.started || '',
      birthToken: windows ? p.started || '' : birthTokens.get(p.pid) || '',
      isStartupItem: !!startupName,
      startupItemName: startupName
    }
  })
}
