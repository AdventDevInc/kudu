import { useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { GaugeCard } from '@/components/perf/GaugeCard'
import { SystemInfoHeader } from '@/components/perf/SystemInfoHeader'
import { TimeSeriesChart } from '@/components/perf/TimeSeriesChart'
import { AlertBanner } from '@/components/perf/AlertBanner'
import { DiskHealthPanel } from '@/components/perf/DiskHealthPanel'
import { ProcessTable } from '@/components/perf/ProcessTable'
import { usePerfStore } from '@/stores/perf-store'
import { formatBytes, formatSpeed } from '@/lib/utils'
import { cn } from '@/lib/utils'

export function PerformanceMonitorPage() {
  const { t } = useTranslation('performance')
  const systemInfo = usePerfStore((s) => s.systemInfo)
  const snapshot = usePerfStore((s) => s.currentSnapshot)
  const history = usePerfStore((s) => s.history)
  const isMonitoring = usePerfStore((s) => s.isMonitoring)
  const timeRange = usePerfStore((s) => s.timeRange)
  const setSystemInfo = usePerfStore((s) => s.setSystemInfo)
  const pushSnapshot = usePerfStore((s) => s.pushSnapshot)
  const setProcessList = usePerfStore((s) => s.setProcessList)
  const diskHealth = usePerfStore((s) => s.diskHealth)
  const setDiskHealth = usePerfStore((s) => s.setDiskHealth)
  const setMonitoring = usePerfStore((s) => s.setMonitoring)
  const setTimeRange = usePerfStore((s) => s.setTimeRange)
  const reset = usePerfStore((s) => s.reset)

  const [paused, setPaused] = useState(false)

  // Start monitoring on mount
  useEffect(() => {
    let snapshotUnsub: (() => void) | undefined
    let processUnsub: (() => void) | undefined

    const start = async () => {
      try {
        const [info, disks] = await Promise.all([
          window.kudu.perfGetSystemInfo(),
          window.kudu.perfGetDiskHealth()
        ])
        setSystemInfo(info)
        setDiskHealth(disks)

        snapshotUnsub = window.kudu.onPerfSnapshot((data) => {
          pushSnapshot(data)
        })

        processUnsub = window.kudu.onPerfProcessList((data) => {
          setProcessList(data.processes, data.totalCount)
        })

        await window.kudu.perfStartMonitoring()
        setMonitoring(true)
      } catch {
        toast.error(t('failedToStartToast'))
      }
    }

    start()

    return () => {
      snapshotUnsub?.()
      processUnsub?.()
      window.kudu.perfStopMonitoring().catch(() => {})
      reset()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePause = useCallback(async () => {
    if (paused) {
      await window.kudu.perfStartMonitoring()
      setPaused(false)
    } else {
      await window.kudu.perfStopMonitoring()
      setPaused(true)
    }
  }, [paused])

  const timeRangeOptions: Array<{ value: '60s' | '5m' | '15m'; label: string }> = [
    { value: '60s', label: '1m' },
    { value: '5m', label: '5m' },
    { value: '15m', label: '15m' }
  ]

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        action={
          <>
            {/* Time range pills */}
            <div
              className="flex rounded-lg p-0.5"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              {timeRangeOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTimeRange(opt.value)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-[11px] font-semibold transition-all',
                    timeRange === opt.value
                      ? 'text-amber-400'
                      : 'text-zinc-500 hover:text-zinc-300'
                  )}
                  style={
                    timeRange === opt.value
                      ? { background: 'rgba(245,158,11,0.1)' }
                      : undefined
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Pause/Resume */}
            <button
              onClick={togglePause}
              className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-colors"
              style={{
                background: paused ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.04)',
                color: paused ? '#22c55e' : '#a1a1aa',
                border: `1px solid ${paused ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.06)'}`
              }}
            >
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {paused ? t('resume') : t('pause')}
            </button>
          </>
        }
      />

      <SystemInfoHeader info={systemInfo} uptime={snapshot?.uptime ?? 0} />

      <AlertBanner snapshot={snapshot} history={history} />

      {/* Gauges */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <GaugeCard
          label={t('gaugeCpu')}
          percent={snapshot?.cpu.overall ?? 0}
          detail={
            snapshot
              ? t('cpuThreadsDetail', { count: snapshot.cpu.perCore.length })
              : t('noDataPlaceholder')
          }
        />
        <GaugeCard
          label={t('gaugeMemory')}
          percent={snapshot?.memory.percent ?? 0}
          detail={
            snapshot
              ? `${formatBytes(snapshot.memory.usedBytes, 1)} / ${formatBytes(snapshot.memory.totalBytes, 1)}`
              : t('noDataPlaceholder')
          }
        />
        <GaugeCard
          label={t('gaugeDiskIo')}
          percent={Math.min(100, ((snapshot?.disk.readBytesPerSec ?? 0) + (snapshot?.disk.writeBytesPerSec ?? 0)) / (200 * 1024 * 1024) * 100)}
          detail={
            snapshot
              ? t('diskIoDetail', { read: formatSpeed(snapshot.disk.readBytesPerSec), write: formatSpeed(snapshot.disk.writeBytesPerSec) })
              : t('noDataPlaceholder')
          }
        />
        <GaugeCard
          label={t('gaugeNetwork')}
          percent={Math.min(100, ((snapshot?.network.rxBytesPerSec ?? 0) + (snapshot?.network.txBytesPerSec ?? 0)) / (125 * 1024 * 1024) * 100)}
          detail={
            snapshot
              ? `${formatSpeed(snapshot.network.rxBytesPerSec)} / ${formatSpeed(snapshot.network.txBytesPerSec)}`
              : t('noDataPlaceholder')
          }
        />
      </div>

      {/* Charts */}
      <div className="mb-6 grid grid-cols-3 gap-4">
        <TimeSeriesChart
          history={history}
          timeRange={timeRange}
          dataKey="cpu"
          label={t('chartCpuUsage')}
          color="#f59e0b"
        />
        <TimeSeriesChart
          history={history}
          timeRange={timeRange}
          dataKey="memory"
          label={t('chartMemoryUsage')}
          color="#3b82f6"
        />
        <TimeSeriesChart
          history={history}
          timeRange={timeRange}
          dataKey="disk"
          label={t('chartDiskIo')}
          color="#22c55e"
        />
      </div>

      {/* Disk Health */}
      <DiskHealthPanel disks={diskHealth} />

      {/* Process Table */}
      <ProcessTable />
    </div>
  )
}
