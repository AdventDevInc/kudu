import { useSampleClock } from '@/hooks/useSampleClock'
import { usePlatform } from '@/hooks/usePlatform'
import { useTranslation } from 'react-i18next'
import { usePerfStore } from '@/stores/perf-store'
import { formatBytes } from '@/lib/utils'
import { PROCESS_STALE_MS } from '@shared/perf-apps'

export function MemoryContext() {
  const { t } = useTranslation('performance')
  const { platform } = usePlatform()
  const snapshot = usePerfStore((s) => s.currentSnapshot)
  const memory = usePerfStore((s) => s.windowsMemory)
  const monitoring = usePerfStore((s) => s.isMonitoring)
  const now = useSampleClock()
  const fresh = monitoring && memory && now - memory.timestamp <= PROCESS_STALE_MS
  const available = snapshot
    ? Math.max(
        0,
        snapshot.memory.availableBytes ?? snapshot.memory.totalBytes - snapshot.memory.usedBytes
      )
    : null
  const commitPercent = fresh ? (memory.committedBytes / memory.commitLimitBytes) * 100 : null
  const unknown = t(
    platform !== 'win32'
      ? 'memoryContext.windowsOnly'
      : memory === undefined
        ? 'memoryContext.loading'
        : 'memoryContext.unavailable'
  )
  return (
    <section
      className="mb-5 rounded-2xl border p-5"
      style={{ borderColor: 'var(--border-default)', background: 'var(--card-bg)' }}
      aria-label={t('memoryContext.title')}
    >
      <div className="grid gap-5 sm:grid-cols-3">
        <div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('memoryContext.available')}
          </div>
          <div
            className="mt-1 text-xl font-semibold tabular-nums"
            style={{ color: 'var(--text-primary)' }}
          >
            {available === null ? '—' : formatBytes(available, 1)}
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {!monitoring || (snapshot && now - snapshot.timestamp > PROCESS_STALE_MS)
              ? t('memoryContext.lastAvailable')
              : t('memoryContext.availableHelp')}
          </p>
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('memoryContext.commit')}
          </div>
          <div
            className="mt-1 text-xl font-semibold tabular-nums"
            style={{
              color:
                commitPercent !== null && commitPercent >= 90
                  ? 'var(--warning)'
                  : 'var(--text-primary)'
            }}
          >
            {fresh
              ? `${formatBytes(memory.committedBytes, 1)} / ${formatBytes(memory.commitLimitBytes, 1)}`
              : '—'}
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {fresh
              ? t('memoryContext.headroom', {
                  value: formatBytes(
                    Math.max(0, memory.commitLimitBytes - memory.committedBytes),
                    1
                  ),
                  percent: commitPercent!.toFixed(0)
                })
              : unknown}
          </p>
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('memoryContext.paging')}
          </div>
          <div
            className="mt-1 text-xl font-semibold tabular-nums"
            style={{ color: 'var(--text-primary)' }}
          >
            {fresh
              ? t('memoryContext.pageRates', {
                  input: memory.pagesInputPerSec.toLocaleString(),
                  output: memory.pagesOutputPerSec.toLocaleString()
                })
              : '—'}
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {fresh ? t('memoryContext.sampled') : unknown}
          </p>
        </div>
      </div>
      <details
        className="mt-4 border-t pt-3 text-xs"
        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
      >
        <summary className="cursor-pointer font-medium">{t('memoryContext.explain')}</summary>
        <p className="mt-2 leading-relaxed">{t('memoryContext.explanation')}</p>
      </details>
    </section>
  )
}
