import type { PerfSystemInfo, DiskSmartInfo, PerfSnapshot, PerfProcessList } from '@shared/types'

interface PerfBridge {
  perfGetSystemInfo: () => Promise<PerfSystemInfo>
  perfGetDiskHealth: () => Promise<DiskSmartInfo[]>
  perfStartMonitoring: () => Promise<void>
  perfStopMonitoring: () => Promise<void>
  onPerfSnapshot: (callback: (data: PerfSnapshot) => void) => () => void
  onPerfProcessList: (callback: (data: PerfProcessList) => void) => () => void
}

/** Subscriptions outlive failed startup attempts, and cleanup cancels delayed startup. */
export function createPerfSession(
  api: PerfBridge,
  callbacks: {
    info: (data: PerfSystemInfo) => void
    disks: (data: DiskSmartInfo[]) => void
    snapshot: (data: PerfSnapshot) => void
    processes: (data: PerfProcessList) => void
  }
) {
  let disposed = false
  let initialized = false
  const stopSnapshot = api.onPerfSnapshot(callbacks.snapshot)
  const stopProcesses = api.onPerfProcessList(callbacks.processes)
  return {
    async start(): Promise<boolean> {
      if (disposed) return false
      if (!initialized) {
        const [info, disks] = await Promise.all([api.perfGetSystemInfo(), api.perfGetDiskHealth()])
        if (disposed) return false
        callbacks.info(info)
        callbacks.disks(disks)
        initialized = true
      }
      if (disposed) return false
      await api.perfStartMonitoring()
      return !disposed
    },
    async pause(): Promise<boolean> {
      if (disposed) return false
      await api.perfStopMonitoring()
      return !disposed
    },
    dispose() {
      disposed = true
      stopSnapshot()
      stopProcesses()
      api.perfStopMonitoring().catch(() => {})
    }
  }
}
