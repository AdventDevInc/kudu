import { useEffect, useCallback, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { GaugeCard } from '@/components/perf/GaugeCard'
import { SystemInfoHeader } from '@/components/perf/SystemInfoHeader'
import { TimeSeriesChart } from '@/components/perf/TimeSeriesChart'
import { AlertBanner } from '@/components/perf/AlertBanner'
import { DiskHealthPanel } from '@/components/perf/DiskHealthPanel'
import { AppMemoryPanel } from '@/components/perf/AppMemoryPanel'
import { MemoryContext } from '@/components/perf/MemoryContext'
import { TemperaturePanel } from '@/components/perf/TemperaturePanel'
import { usePerfStore } from '@/stores/perf-store'
import { formatBytes, formatSpeed } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { createPerfSession } from '@/lib/perf-session'

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
  const [starting, setStarting] = useState(true)
  const [startError, setStartError] = useState(false)

  const session = useRef<ReturnType<typeof createPerfSession> | null>(null)

  useEffect(() => {
    let disposed = false
    const current = createPerfSession(window.kudu, {
      info: setSystemInfo,
      disks: setDiskHealth,
      snapshot: pushSnapshot,
      processes: setProcessList
    })
    session.current = current
    current
      .start()
      .then((active) => {
        if (active) setMonitoring(true)
      })
      .catch(() => {
        if (!disposed) {
          setStartError(true)
          toast.error(t('failedToStartToast'))
        }
      })
      .finally(() => {
        if (!disposed) setStarting(false)
      })
    return () => {
      disposed = true
      current.dispose()
      session.current = null
      reset()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePause = useCallback(async () => {
    const current = session.current
    if (!current || starting) return
    setStarting(true)
    try {
      if (paused || startError) {
        if (!(await current.start())) return
        setPaused(false)
        setStartError(false)
        setMonitoring(true)
      } else {
        if (!(await current.pause())) return
        setPaused(true)
        setMonitoring(false)
      }
    } catch {
      if (session.current === current) toast.error(t('failedToStartToast'))
    } finally {
      if (session.current === current) setStarting(false)
    }
  }, [paused, startError, starting, setMonitoring, t])

  const timeRangeOptions: Array<{ value: '60s' | '5m' | '15m'; label: string }> = [
    { value: '60s', label: '1m' },
    { value: '5m', label: '5m' },
    { value: '15m', label: '15m' }
  ]

  return (
    <div className="feature-page performance-page mx-auto max-w-[1320px]">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        action={
          <>
            {/* Time range pills */}
            <div
              className="flex rounded-lg p-0.5"
              style={{ background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }}
            >
              {timeRangeOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTimeRange(opt.value)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-[11px] font-semibold transition-all',
                    timeRange === opt.value ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-300'
                  )}
                  style={
                    timeRange === opt.value ? { background: 'rgba(245,158,11,0.1)' } : undefined
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Pause/Resume */}
            <button
              onClick={togglePause}
              disabled={starting}
              className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-colors"
              style={{
                background: paused ? 'rgba(34,197,94,0.1)' : 'var(--bg-subtle-2)',
                color: paused ? '#22c55e' : 'var(--text-secondary)',
                border: `1px solid ${paused ? 'rgba(34,197,94,0.2)' : 'var(--border-medium)'}`
              }}
            >
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {startError ? t('apps.retry') : paused ? t('resume') : t('pause')}
            </button>
          </>
        }
      />

      <SystemInfoHeader info={systemInfo} uptime={snapshot?.uptime ?? 0} />

      <AlertBanner snapshot={snapshot} history={history} />

      {/* Gauges */}
      <div className="pulse-performance-metrics">
        <GaugeCard
          label={t('gaugeCpu')}
          percent={snapshot?.cpu.overall ?? null}
          detail={
            snapshot
              ? t('cpuThreadsDetail', { count: snapshot.cpu.perCore.length })
              : t('noDataPlaceholder')
          }
        />
        <GaugeCard
          label={t('gaugeMemory')}
          percent={snapshot?.memory.percent ?? null}
          detail={
            snapshot
              ? `${formatBytes(snapshot.memory.usedBytes, 1)} / ${formatBytes(snapshot.memory.totalBytes, 1)}`
              : t('noDataPlaceholder')
          }
        />
        <GaugeCard
          label={t('gaugeDiskIo')}
          percent={null}
          value={
            snapshot
              ? formatSpeed(snapshot.disk.readBytesPerSec + snapshot.disk.writeBytesPerSec)
              : t('noDataPlaceholder')
          }
          detail={
            snapshot
              ? t('diskIoDetail', {
                  read: formatSpeed(snapshot.disk.readBytesPerSec),
                  write: formatSpeed(snapshot.disk.writeBytesPerSec)
                })
              : t('noDataPlaceholder')
          }
        />
        <GaugeCard
          label={t('gaugeNetwork')}
          percent={null}
          value={
            snapshot
              ? formatSpeed(snapshot.network.rxBytesPerSec + snapshot.network.txBytesPerSec)
              : t('noDataPlaceholder')
          }
          detail={
            snapshot
              ? `${formatSpeed(snapshot.network.rxBytesPerSec)} / ${formatSpeed(snapshot.network.txBytesPerSec)}`
              : t('noDataPlaceholder')
          }
        />
      </div>

      <MemoryContext />

      <TemperaturePanel temperatures={snapshot?.temperatures} />

      {/* Charts */}
      <div className="pulse-performance-charts">
        <TimeSeriesChart
          history={history}
          timeRange={timeRange}
          dataKey="cpu"
          label={t('chartCpuUsage')}
          color="var(--accent)"
        />
        <TimeSeriesChart
          history={history}
          timeRange={timeRange}
          dataKey="memory"
          label={t('chartMemoryUsage')}
          color="var(--success)"
        />
        <TimeSeriesChart
          history={history}
          timeRange={timeRange}
          dataKey="disk"
          label={t('chartDiskIo')}
          color="var(--info)"
        />
      </div>

      {/* Disk Health */}
      <DiskHealthPanel disks={diskHealth} />

      {/* Process Table */}
      <AppMemoryPanel
        starting={starting}
        startError={startError}
        paused={!isMonitoring && !starting}
      />
    </div>
  )
}
