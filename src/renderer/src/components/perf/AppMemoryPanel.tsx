import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownWideNarrow, ChevronDown, ChevronRight, Layers, Search } from 'lucide-react'
import { usePerfStore } from '@/stores/perf-store'
import { formatBytes } from '@/lib/utils'
import {
  memoryChange,
  processIdentity,
  verifiedParent,
  PROCESS_STALE_MS,
  type PerfApp
} from '@shared/perf-apps'
import type { PerfProcess } from '@shared/types'
import { ProcessTable } from './ProcessTable'
import { useSampleClock } from '@/hooks/useSampleClock'

function AppDetails({
  app,
  allProcesses,
  windowMs
}: {
  app: PerfApp
  allProcesses: PerfProcess[]
  windowMs: number
}) {
  const { t } = useTranslation('performance')
  const last = app.history.at(-1)!
  const samples = app.history.filter((sample) => sample.timestamp >= last.timestamp - windowMs)
  const min = Math.min(...samples.map((s) => s.bytes))
  const max = Math.max(...samples.map((s) => s.bytes))
  const span = last.timestamp - samples[0].timestamp
  const points = samples
    .map(
      (s) =>
        `${span ? ((s.timestamp - samples[0].timestamp) / span) * 400 : 0},${max === min ? 28 : 52 - ((s.bytes - min) / (max - min)) * 48}`
    )
    .join(' ')
  return (
    <div className="space-y-4 px-4 py-4" style={{ background: 'var(--bg-subtle)' }}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          <p className="break-all font-mono">{app.path || t('apps.pathUnavailable')}</p>
          <p className="mt-2">{t('apps.groupingHelp')}</p>
          {app.estimated && (
            <p className="mt-1" style={{ color: 'var(--warning)' }}>
              {t('apps.estimatedHelp')}
            </p>
          )}
        </div>
        <div>
          <div className="flex justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
            <span>{t('apps.observedRange')}</span>
            <span>
              {formatBytes(min, 1)} – {formatBytes(max, 1)}
            </span>
          </div>
          <svg
            viewBox="0 0 400 56"
            className="mt-1 h-14 w-full"
            preserveAspectRatio="none"
            role="img"
            aria-label={t('apps.trendChart', {
              min: formatBytes(min, 1),
              max: formatBytes(max, 1),
              seconds: Math.round(span / 1000)
            })}
          >
            <polyline
              points={points}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {t('apps.trendHelp')}
          </p>
        </div>
      </div>
      <div
        className="max-h-64 overflow-auto rounded-lg border"
        style={{ borderColor: 'var(--border-default)' }}
      >
        <table className="w-full text-left text-xs">
          <thead style={{ color: 'var(--text-muted)' }}>
            <tr>
              {[
                t('columnPid'),
                t('apps.parent'),
                t('apps.started'),
                t('columnCpu'),
                t('columnMemory')
              ].map((label) => (
                <th key={label} scope="col" className="px-3 py-2 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...app.processes]
              .sort((a, b) => b.memBytes - a.memBytes)
              .map((p) => {
                const parent = verifiedParent(p, allProcesses)
                return (
                  <tr
                    key={processIdentity(p)}
                    className="border-t"
                    style={{ borderColor: 'var(--border-default)' }}
                  >
                    <td className="px-3 py-2 font-mono">{p.pid}</td>
                    <td className="px-3 py-2" title={parent?.name}>
                      {parent ? parent.pid : '—'}
                    </td>
                    <td className="px-3 py-2">{p.started || t('apps.unknown')}</td>
                    <td className="px-3 py-2 tabular-nums">{p.cpuPercent.toFixed(1)}%</td>
                    <td className="px-3 py-2 tabular-nums">{formatBytes(p.memBytes, 1)}</td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {t('apps.parentHelp')}
      </p>
    </div>
  )
}

export function AppMemoryPanel({
  starting,
  startError,
  paused
}: {
  starting: boolean
  startError: boolean
  paused: boolean
}) {
  const { t } = useTranslation('performance')
  const apps = usePerfStore((s) => s.apps)
  const processList = usePerfStore((s) => s.processList)
  const totalCount = usePerfStore((s) => s.processCount)
  const timestamp = usePerfStore((s) => s.processTimestamp)
  const error = usePerfStore((s) => s.processError)
  const timeRange = usePerfStore((s) => s.timeRange)
  const now = useSampleClock()
  const [view, setView] = useState<'apps' | 'processes'>('apps')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'memBytes' | 'cpuPercent' | 'growth'>('memBytes')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [limit, setLimit] = useState(50)
  const stale = timestamp !== null && now - timestamp > PROCESS_STALE_MS
  const windowMs = timeRange === '60s' ? 60_000 : timeRange === '5m' ? 300_000 : 900_000
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return apps
      .filter(
        (a) =>
          !q ||
          `${a.name} ${a.path} ${a.processes.map((p) => `${p.pid} ${p.user}`).join(' ')}`
            .toLowerCase()
            .includes(q)
      )
      .sort(
        (a, b) =>
          (sort === 'growth'
            ? (memoryChange(b, windowMs)?.bytes ?? -Infinity) -
              (memoryChange(a, windowMs)?.bytes ?? -Infinity)
            : b[sort] - a[sort]) || a.name.localeCompare(b.name)
      )
  }, [apps, query, sort, windowMs])
  const status = startError
    ? t('failedToStartToast')
    : error
      ? t('apps.failed')
      : paused
        ? t('apps.paused')
        : stale
          ? t('apps.stale')
          : starting || timestamp === null
            ? t('apps.loading')
            : t('apps.updated', { seconds: Math.max(0, Math.round((now - timestamp) / 1000)) })
  return (
    <section
      className="rounded-2xl border p-5"
      style={{
        background: 'var(--card-bg)',
        borderColor: 'var(--border-default)',
        color: 'var(--text-primary)'
      }}
      aria-label={t('apps.title')}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Layers className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            {t('apps.title')}
          </h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('apps.count', {
              apps: apps.length,
              observed: processList.length,
              total: totalCount
            })}
          </p>
        </div>
        <div className="flex rounded-lg p-1" style={{ background: 'var(--bg-subtle)' }}>
          {(['apps', 'processes'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setView(value)}
              aria-pressed={view === value}
              className="rounded-md px-3 py-1.5 text-xs font-medium"
              style={{
                background: view === value ? 'var(--accent-muted-bg)' : undefined,
                color: view === value ? 'var(--nav-active-fg)' : 'var(--text-muted)'
              }}
            >
              {t(value === 'apps' ? 'apps.tab' : 'processes')}
            </button>
          ))}
        </div>
      </div>
      <p
        role="status"
        className="mb-3 text-xs"
        style={{ color: error || startError || stale ? 'var(--warning)' : 'var(--text-muted)' }}
      >
        {status}
      </p>
      {view === 'processes' ? (
        <ProcessTable />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-3">
            <label
              className="flex min-w-48 flex-1 items-center gap-2 rounded-lg border px-3 py-2"
              style={{ borderColor: 'var(--border-default)' }}
            >
              <Search className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
              <input
                aria-label={t('apps.search')}
                placeholder={t('apps.search')}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setLimit(50)
                }}
                className="w-full min-w-0 bg-transparent text-xs outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <ArrowDownWideNarrow className="h-4 w-4" />
              <span className="sr-only">{t('apps.sort')}</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
                className="rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--border-default)', background: 'var(--card-bg)' }}
              >
                <option value="memBytes">{t('apps.sortMemory')}</option>
                <option value="cpuPercent">{t('apps.sortCpu')}</option>
                <option value="growth">{t('apps.sortGrowth')}</option>
              </select>
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[580px] text-left text-xs">
              <thead style={{ color: 'var(--text-muted)' }}>
                <tr>
                  {[
                    t('apps.app'),
                    t('processes'),
                    t('columnCpu'),
                    t('apps.workingSet'),
                    t('apps.change')
                  ].map((label) => (
                    <th key={label} scope="col" className="px-3 py-2 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, limit).map((app) => {
                  const change = memoryChange(app, windowMs)
                  const open = expanded === app.key
                  return (
                    <Fragment key={app.key}>
                      <tr className="border-t" style={{ borderColor: 'var(--border-default)' }}>
                        <td className="max-w-72 px-3 py-3">
                          <button
                            type="button"
                            onClick={() => setExpanded(open ? null : app.key)}
                            aria-expanded={open}
                            className="flex max-w-full items-center gap-2 text-left font-medium"
                          >
                            {open ? (
                              <ChevronDown className="h-4 w-4 shrink-0" />
                            ) : (
                              <ChevronRight className="h-4 w-4 shrink-0" />
                            )}
                            <span className="truncate" title={app.path || app.name}>
                              {app.name}
                            </span>
                            {app.estimated && (
                              <span
                                title={t('apps.estimatedHelp')}
                                className="shrink-0 text-[10px]"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                ≈
                              </span>
                            )}
                          </button>
                        </td>
                        <td className="px-3 py-3 tabular-nums">{app.processes.length}</td>
                        <td className="px-3 py-3 tabular-nums">{app.cpuPercent.toFixed(1)}%</td>
                        <td className="px-3 py-3 font-medium tabular-nums">
                          {formatBytes(app.memBytes, 1)}
                        </td>
                        <td
                          className="px-3 py-3 tabular-nums"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {change ? (
                            <>
                              <span>
                                {change.bytes > 0 ? '+' : change.bytes < 0 ? '−' : ''}
                                {formatBytes(Math.abs(change.bytes), 1)}
                              </span>
                              <span
                                className="mt-0.5 block text-[10px]"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                {t('apps.overSeconds', { seconds: change.seconds })}
                              </span>
                            </>
                          ) : (
                            <span className="text-[11px]" title={t('apps.trendHelp')}>
                              {t('apps.collecting')}
                            </span>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5}>
                            <AppDetails app={app} allProcesses={processList} windowMs={windowMs} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && timestamp !== null && (
            <p className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              {query ? t('apps.noMatches') : t('apps.empty')}
            </p>
          )}
          {filtered.length > limit && (
            <button
              type="button"
              onClick={() => setLimit((n) => n + 50)}
              className="mt-3 rounded-lg border px-3 py-2 text-xs"
              style={{ borderColor: 'var(--border-default)' }}
            >
              {t('apps.showMore', { count: filtered.length - limit })}
            </button>
          )}
          <p className="mt-4 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {t('apps.caveat')}
          </p>
        </>
      )}
    </section>
  )
}
