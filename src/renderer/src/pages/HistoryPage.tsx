import { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  History, Sparkles, Database, PackageMinus, Trash2, Info,
  TrendingUp, HardDrive, BarChart3, Clock, AlertCircle, Wifi, Cpu,
  ShieldCheck, Bug, Zap, Settings2, RefreshCw, Cloud, CheckCircle2, XCircle
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useHistoryStore } from '@/stores/history-store'
import { useCloudHistoryStore } from '@/stores/cloud-history-store'
import { formatBytes } from '@/lib/utils'
import { usePlatform } from '@/hooks/usePlatform'
import type { ScanHistoryEntry, HistoryEntryType, CloudActionEntry } from '@shared/types'

const typeConfigBase: Record<HistoryEntryType, { labelKey: string; icon: typeof Sparkles; color: string; bg: string }> = {
  cleaner: { labelKey: 'typeLabels.cleaner', icon: Sparkles, color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  registry: { labelKey: 'typeLabels.registry', icon: Database, color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
  debloater: { labelKey: 'typeLabels.debloater', icon: PackageMinus, color: '#a855f7', bg: 'rgba(168,85,247,0.1)' },
  network: { labelKey: 'typeLabels.network', icon: Wifi, color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  drivers: { labelKey: 'typeLabels.drivers', icon: Cpu, color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)' },
  malware: { labelKey: 'typeLabels.malware', icon: Bug, color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  privacy: { labelKey: 'typeLabels.privacy', icon: ShieldCheck, color: '#14b8a6', bg: 'rgba(20,184,166,0.1)' },
  startup: { labelKey: 'typeLabels.startup', icon: Zap, color: '#f97316', bg: 'rgba(249,115,22,0.1)' },
  services: { labelKey: 'typeLabels.services', icon: Settings2, color: '#6366f1', bg: 'rgba(99,102,241,0.1)' },
  'software-update': { labelKey: 'typeLabels.softwareUpdate', icon: RefreshCw, color: '#06b6d4', bg: 'rgba(6,182,212,0.1)' }
}

function useTypeConfig() {
  const { t } = useTranslation('history')
  return useMemo(() => {
    const result = {} as Record<HistoryEntryType, { label: string; icon: typeof Sparkles; color: string; bg: string }>
    for (const [key, val] of Object.entries(typeConfigBase)) {
      result[key as HistoryEntryType] = { ...val, label: t(val.labelKey) }
    }
    return result
  }, [t])
}

const PIE_COLORS = ['#f59e0b', '#3b82f6', '#22c55e', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#6366f1']

type ViewMode = 'overview' | 'timeline' | 'cloud'

export function HistoryPage() {
  const { t } = useTranslation('history')
  const typeConfig = useTypeConfig()
  const { features } = usePlatform()
  const { entries, loaded, load, clear } = useHistoryStore()
  const { entries: cloudEntries, loaded: cloudLoaded, load: loadCloud, clear: clearCloud } = useCloudHistoryStore()
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('overview')
  const [typeFilter, setTypeFilter] = useState<'all' | ScanHistoryEntry['type']>('all')

  useEffect(() => { load(); loadCloud() }, [])

  const filtered = useMemo(() =>
    typeFilter === 'all' ? entries : entries.filter((e) => e.type === typeFilter),
    [entries, typeFilter]
  )

  // --- Aggregated stats ---
  const stats = useMemo(() => {
    const totalSpace = entries.reduce((s, e) => s + e.totalSpaceSaved, 0)
    const totalItems = entries.reduce((s, e) => s + e.totalItemsCleaned, 0)
    const totalErrors = entries.reduce((s, e) => s + e.errorCount, 0)
    const avgDuration = entries.length > 0
      ? entries.reduce((s, e) => s + e.duration, 0) / entries.length
      : 0
    return { totalSpace, totalItems, totalErrors, avgDuration, totalScans: entries.length }
  }, [entries])

  // --- Chart data: space saved over time (grouped by day, last 30 days with data) ---
  const timelineData = useMemo(() => {
    const byDay: Record<string, { space: number; items: number }> = {}
    for (const e of filtered) {
      const key = new Date(e.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      if (!byDay[key]) byDay[key] = { space: 0, items: 0 }
      byDay[key].space += e.totalSpaceSaved
      byDay[key].items += e.totalItemsCleaned
    }
    return Object.entries(byDay)
      .slice(0, 30)
      .reverse()
      .map(([date, d]) => ({ date, space: d.space, items: d.items }))
  }, [filtered])

  // --- Chart data: breakdown by scan type ---
  const typeBreakdown = useMemo(() => {
    const byType: Record<string, { count: number; space: number; items: number }> = {}
    for (const e of entries) {
      const label = typeConfig[e.type].label
      if (!byType[label]) byType[label] = { count: 0, space: 0, items: 0 }
      byType[label].count++
      byType[label].space += e.totalSpaceSaved
      byType[label].items += e.totalItemsCleaned
    }
    return Object.entries(byType).map(([name, d]) => ({ name, ...d }))
  }, [entries, typeConfig])

  // --- Chart data: category breakdown across all scans ---
  const categoryBreakdown = useMemo(() => {
    const byCategory: Record<string, { items: number; space: number }> = {}
    for (const e of entries) {
      for (const c of e.categories) {
        if (!byCategory[c.name]) byCategory[c.name] = { items: 0, space: 0 }
        byCategory[c.name].items += c.itemsCleaned
        byCategory[c.name].space += c.spaceSaved
      }
    }
    return Object.entries(byCategory)
      .map(([name, d]) => ({ name, ...d }))
      .sort((a, b) => b.space - a.space || b.items - a.items)
      .slice(0, 8)
  }, [entries])

  // --- Weekly trend data ---
  const weeklyData = useMemo(() => {
    const weeks: Record<string, { space: number; items: number; count: number }> = {}
    for (const e of entries) {
      const d = new Date(e.timestamp)
      const weekStart = new Date(d)
      weekStart.setDate(d.getDate() - d.getDay())
      const key = weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      if (!weeks[key]) weeks[key] = { space: 0, items: 0, count: 0 }
      weeks[key].space += e.totalSpaceSaved
      weeks[key].items += e.totalItemsCleaned
      weeks[key].count++
    }
    return Object.entries(weeks)
      .slice(0, 12)
      .reverse()
      .map(([week, d]) => ({ week, ...d }))
  }, [entries])

  if (!loaded) return null

  if (entries.length === 0) {
    return (
      <div className="animate-fade-in">
        <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
        <EmptyState
          icon={History}
          title={t('emptyStateTitle')}
          description={t('emptyStateDescription')}
        />
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        action={
          <div className="flex items-center gap-2.5">
            {/* View mode toggle */}
            <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
              <button
                onClick={() => setViewMode('overview')}
                className="px-4 py-2 text-[12px] font-medium transition-colors"
                style={{
                  background: viewMode === 'overview' ? 'rgba(245,158,11,0.1)' : 'rgba(255,255,255,0.03)',
                  color: viewMode === 'overview' ? '#f59e0b' : '#6e6e76'
                }}
              >
                {t('viewOverview')}
              </button>
              <button
                onClick={() => setViewMode('timeline')}
                className="px-4 py-2 text-[12px] font-medium transition-colors"
                style={{
                  background: viewMode === 'timeline' ? 'rgba(245,158,11,0.1)' : 'rgba(255,255,255,0.03)',
                  color: viewMode === 'timeline' ? '#f59e0b' : '#6e6e76'
                }}
              >
                {t('viewTimeline')}
              </button>
              <button
                onClick={() => setViewMode('cloud')}
                className="px-4 py-2 text-[12px] font-medium transition-colors"
                style={{
                  background: viewMode === 'cloud' ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.03)',
                  color: viewMode === 'cloud' ? '#3b82f6' : '#6e6e76'
                }}
              >
                {t('viewCloud')}
              </button>
            </div>
            <button
              onClick={() => setShowClearConfirm(true)}
              className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-500 transition-all hover:text-zinc-300"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              {t('clearButton')}
            </button>
          </div>
        }
      />

      {viewMode === 'overview' ? (
        <OverviewView
          stats={stats}
          timelineData={timelineData}
          typeBreakdown={typeBreakdown}
          categoryBreakdown={categoryBreakdown}
          weeklyData={weeklyData}
          typeConfig={typeConfig}
          entries={entries}
        />
      ) : viewMode === 'timeline' ? (
        <TimelineView
          entries={filtered}
          typeFilter={typeFilter}
          setTypeFilter={setTypeFilter}
          selectedEntry={selectedEntry}
          setSelectedEntry={setSelectedEntry}
          typeConfig={typeConfig}
        />
      ) : (
        <CloudView entries={cloudEntries} loaded={cloudLoaded} />
      )}

      <ConfirmDialog
        open={showClearConfirm}
        onConfirm={() => {
          if (viewMode === 'cloud') { clearCloud() } else { clear() }
          setShowClearConfirm(false)
        }}
        onCancel={() => setShowClearConfirm(false)}
        title={viewMode === 'cloud' ? t('confirmClearCloudTitle') : t('confirmClearScanTitle')}
        description={viewMode === 'cloud'
          ? t('confirmClearCloudDescription')
          : t('confirmClearScanDescription')
        }
        confirmLabel={t('confirmClearLabel')}
        variant="danger"
      />
    </div>
  )
}

// ============ Overview View ============

function OverviewView({
  stats,
  timelineData,
  typeBreakdown,
  categoryBreakdown,
  weeklyData,
  entries,
  typeConfig
}: {
  stats: { totalSpace: number; totalItems: number; totalErrors: number; avgDuration: number; totalScans: number }
  timelineData: { date: string; space: number; items: number }[]
  typeBreakdown: { name: string; count: number; space: number; items: number }[]
  categoryBreakdown: { name: string; items: number; space: number }[]
  weeklyData: { week: string; space: number; items: number; count: number }[]
  entries: ScanHistoryEntry[]
  typeConfig: Record<HistoryEntryType, { label: string; icon: typeof Sparkles; color: string; bg: string }>
}) {
  const { t } = useTranslation('history')
  return (
    <>
      {/* Summary stat cards */}
      <div className="mb-5 grid grid-cols-4 gap-3">
        <MiniStat icon={BarChart3} label={t('overview.totalScans')} value={stats.totalScans.toString()} color="#f59e0b" />
        <MiniStat icon={HardDrive} label={t('overview.spaceRecovered')} value={formatBytes(stats.totalSpace)} color="#22c55e" />
        <MiniStat icon={TrendingUp} label={t('overview.itemsProcessed')} value={stats.totalItems.toLocaleString()} color="#3b82f6" />
        <MiniStat icon={Clock} label={t('overview.avgDuration')} value={formatDuration(stats.avgDuration, t)} color="#a855f7" />
      </div>

      {/* Charts row 1 — Area chart + Pie chart */}
      <div className="mb-5 grid grid-cols-3 gap-4">
        {/* Space saved over time */}
        <div className="col-span-2 rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
          <h3 className="mb-4 text-[12px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
            {t('overview.spaceRecoveredOverTime')}
          </h3>
          {timelineData.length > 1 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={timelineData}>
                <defs>
                  <linearGradient id="spaceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="date" tick={{ fill: '#4e4e56', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#4e4e56', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => formatBytes(v, 0)} width={60} />
                <Tooltip
                  contentStyle={{ background: '#1e1e22', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, fontSize: 12 }}
                  labelStyle={{ color: '#a1a1aa' }}
                  formatter={(value) => [formatBytes(Number(value)), t('overview.tooltipSpace')]}
                />
                <Area type="monotone" dataKey="space" stroke="#f59e0b" strokeWidth={2}
                  fill="url(#spaceGrad)" dot={false} activeDot={{ r: 4, fill: '#f59e0b' }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[220px] items-center justify-center text-[13px]" style={{ color: '#4e4e56' }}>
              {t('overview.needTwoScansForChart')}
            </div>
          )}
        </div>

        {/* Scan type distribution */}
        <div className="rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
          <h3 className="mb-4 text-[12px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
            {t('overview.scanTypeDistribution')}
          </h3>
          {typeBreakdown.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={150}>
                <PieChart>
                  <Pie
                    data={typeBreakdown}
                    cx="50%" cy="50%"
                    innerRadius={40} outerRadius={60}
                    dataKey="count"
                    stroke="none"
                  >
                    {typeBreakdown.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: '#1e1e22', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, fontSize: 12 }}
                    formatter={(value) => [Number(value), t('overview.tooltipScans')]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1.5">
                {typeBreakdown.map((item, i) => (
                  <div key={item.name} className="flex items-center gap-2">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="flex-1 text-[12px] text-zinc-400">{item.name}</span>
                    <span className="font-mono text-[11px]" style={{ color: '#6e6e76' }}>{item.count}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex h-[200px] items-center justify-center text-[13px]" style={{ color: '#4e4e56' }}>
              {t('overview.noData')}
            </div>
          )}
        </div>
      </div>

      {/* Charts row 2 — Bar charts */}
      <div className="mb-5 grid grid-cols-2 gap-4">
        {/* Category breakdown */}
        <div className="rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
          <h3 className="mb-4 text-[12px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
            {t('overview.topCategoriesBySpace')}
          </h3>
          {categoryBreakdown.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={categoryBreakdown} layout="vertical" barSize={14}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#4e4e56', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => formatBytes(v, 0)} />
                <YAxis type="category" dataKey="name" tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false}
                  tickLine={false} width={90} />
                <Tooltip
                  contentStyle={{ background: '#1e1e22', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, fontSize: 12 }}
                  formatter={(value) => [formatBytes(Number(value)), t('overview.tooltipSpace')]}
                />
                <Bar dataKey="space" radius={[0, 6, 6, 0]}>
                  {categoryBreakdown.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[220px] items-center justify-center text-[13px]" style={{ color: '#4e4e56' }}>
              {t('overview.noCategoryData')}
            </div>
          )}
        </div>

        {/* Weekly trend */}
        <div className="rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
          <h3 className="mb-4 text-[12px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
            {t('overview.weeklyActivity')}
          </h3>
          {weeklyData.length > 1 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={weeklyData} barSize={20}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="week" tick={{ fill: '#4e4e56', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#4e4e56', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: '#1e1e22', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, fontSize: 12 }}
                  labelStyle={{ color: '#a1a1aa' }}
                  formatter={(value, name) => [
                    name === 'count' ? Number(value) : formatBytes(Number(value)),
                    name === 'count' ? t('overview.tooltipScans') : t('overview.tooltipSpace')
                  ]}
                />
                <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} fillOpacity={0.8} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[220px] items-center justify-center text-[13px]" style={{ color: '#4e4e56' }}>
              {t('overview.needTwoWeeksData')}
            </div>
          )}
        </div>
      </div>

      {/* Recent 5 scans summary */}
      <div className="rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
        <h3 className="mb-4 text-[12px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
          {t('overview.recentScans')}
        </h3>
        <div className="space-y-2">
          {entries.slice(0, 5).map((entry) => (
            <RecentScanRow key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
    </>
  )
}

// ============ Timeline View ============

function TimelineView({
  entries,
  typeFilter,
  setTypeFilter,
  selectedEntry,
  setSelectedEntry,
  typeConfig
}: {
  entries: ScanHistoryEntry[]
  typeFilter: 'all' | ScanHistoryEntry['type']
  setTypeFilter: (f: 'all' | ScanHistoryEntry['type']) => void
  selectedEntry: string | null
  setSelectedEntry: (id: string | null) => void
  typeConfig: Record<HistoryEntryType, { label: string; icon: typeof Sparkles; color: string; bg: string }>
}) {
  const { t } = useTranslation('history')
  const { features } = usePlatform()
  const filters: { label: string; value: 'all' | ScanHistoryEntry['type'] }[] = [
    { label: t('timeline.filterAll'), value: 'all' },
    { label: t('timeline.filterCleaner'), value: 'cleaner' },
    ...(features.registry ? [{ label: t('timeline.filterRegistry'), value: 'registry' as const }] : []),
    ...(features.debloater ? [{ label: t('timeline.filterDebloater'), value: 'debloater' as const }] : []),
    { label: t('timeline.filterNetwork'), value: 'network' },
    ...(features.drivers ? [{ label: t('timeline.filterDrivers'), value: 'drivers' as const }] : []),
    { label: t('timeline.filterMalware'), value: 'malware' },
    { label: t('timeline.filterPrivacy'), value: 'privacy' },
    { label: t('timeline.filterStartup'), value: 'startup' },
    { label: t('timeline.filterServices'), value: 'services' },
    { label: t('timeline.filterUpdates'), value: 'software-update' }
  ]

  const detail = entries.find((e) => e.id === selectedEntry) || null

  return (
    <>
      {/* Filter pills */}
      <div className="mb-4 flex items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setTypeFilter(f.value)}
            className="rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: typeFilter === f.value ? 'rgba(245,158,11,0.1)' : 'rgba(255,255,255,0.04)',
              color: typeFilter === f.value ? '#f59e0b' : '#6e6e76'
            }}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-[12px] font-mono" style={{ color: '#4e4e56' }}>
          {t('timeline.entriesCount', { count: entries.length })}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('timeline.columnType')}</th>
              <th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('timeline.columnDate')}</th>
              <th className="px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('timeline.columnItems')}</th>
              <th className="px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('timeline.columnSpace')}</th>
              <th className="px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('timeline.columnDuration')}</th>
              <th className="px-4 py-3 text-center text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('timeline.columnStatus')}</th>
              <th className="w-10 px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const config = typeConfig[entry.type]
              const Icon = config.icon
              return (
                <tr
                  key={entry.id}
                  className="cursor-pointer transition-colors"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
                  onClick={() => setSelectedEntry(entry.id)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: config.bg }}>
                        <Icon className="h-3.5 w-3.5" style={{ color: config.color }} strokeWidth={1.8} />
                      </div>
                      <span className="text-[12.5px] font-medium text-zinc-200">{config.label}</span>
                      {entry.scheduled && (
                        <span className="rounded-full px-1.5 py-0.5 text-[9px] font-medium" style={{ background: 'rgba(99,102,241,0.1)', color: '#818cf8' }}>
                          {t('timeline.scheduledBadge')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[12px]" style={{ color: '#8e8e96' }}>
                    {new Date(entry.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    <span className="ml-1.5" style={{ color: '#4e4e56' }}>
                      {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-zinc-300">
                    {entry.totalItemsCleaned.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[12px]" style={{ color: entry.totalSpaceSaved > 0 ? '#22c55e' : '#4e4e56' }}>
                    {entry.totalSpaceSaved > 0 ? formatBytes(entry.totalSpaceSaved) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[12px]" style={{ color: '#6e6e76' }}>
                    {formatDuration(entry.duration, t)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {entry.errorCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                        <AlertCircle className="h-3 w-3" strokeWidth={2} />
                        {entry.errorCount}
                      </span>
                    ) : (
                      <CheckCircle2 className="inline h-4 w-4" style={{ color: '#22c55e' }} strokeWidth={1.8} />
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Info className="inline h-3.5 w-3.5" style={{ color: '#4e4e56' }} strokeWidth={1.8} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {entries.length === 0 && (
          <div className="py-12 text-center text-[13px]" style={{ color: '#4e4e56' }}>
            {t('timeline.noEntriesMatchFilter')}
          </div>
        )}
      </div>

      {/* Detail popup */}
      {detail && <ScanDetailPopup entry={detail} onClose={() => setSelectedEntry(null)} />}
    </>
  )
}

// ============ Scan Detail Popup ============

function ScanDetailPopup({ entry, onClose }: { entry: ScanHistoryEntry; onClose: () => void }) {
  const { t } = useTranslation('history')
  const typeConfig = useTypeConfig()
  const config = typeConfig[entry.type]
  const Icon = config.icon

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }} onClick={onClose} />
      <div
        className="relative w-full max-w-lg animate-scale-in rounded-2xl p-6"
        style={{ background: '#18181c', border: '1px solid rgba(255,255,255,0.06)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
      >
        {/* Header */}
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: config.bg }}>
            <Icon className="h-5 w-5" style={{ color: config.color }} strokeWidth={1.8} />
          </div>
          <div className="flex-1">
            <h3 className="text-[15px] font-semibold text-white">{config.label}</h3>
            <p className="text-[12px]" style={{ color: '#6e6e76' }}>
              {new Date(entry.timestamp).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
              {' ' + t('timeline.dateAt') + ' '}
              {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              {entry.scheduled && <span className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgba(99,102,241,0.1)', color: '#818cf8' }}>{t('detail.scheduledBadge')}</span>}
            </p>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors" style={{ color: '#6e6e76' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
            <XCircle className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        {/* Stats grid */}
        <div className="mb-5 grid grid-cols-4 gap-2.5">
          <DetailStat label={t('detail.statFound')} value={entry.totalItemsFound.toLocaleString()} />
          <DetailStat label={t('detail.statProcessed')} value={entry.totalItemsCleaned.toLocaleString()} />
          <DetailStat label={t('detail.statSkipped')} value={entry.totalItemsSkipped.toLocaleString()} />
          <DetailStat label={t('detail.statSpaceSaved')} value={entry.totalSpaceSaved > 0 ? formatBytes(entry.totalSpaceSaved) : '—'} />
        </div>

        {/* Duration & errors */}
        <div className="mb-5 flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-[12px]" style={{ color: '#6e6e76' }}>
            <Clock className="h-3.5 w-3.5" strokeWidth={1.6} />
            {formatDuration(entry.duration, t)}
          </div>
          {entry.errorCount > 0 && (
            <div className="flex items-center gap-1.5 text-[12px]" style={{ color: '#ef4444' }}>
              <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.8} />
              {entry.errorCount !== 1 ? t('detail.errorCountPlural', { count: entry.errorCount }) : t('detail.errorCount', { count: entry.errorCount })}
            </div>
          )}
        </div>

        {/* Category breakdown */}
        {entry.categories.length > 0 && (
          <div>
            <h4 className="mb-3 text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
              {t('detail.categoriesLabel')}
            </h4>
            <div className="space-y-2 max-h-48 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
              {entry.categories.map((cat, i) => {
                const maxItems = Math.max(...entry.categories.map((c) => c.itemsCleaned), 1)
                const percent = (cat.itemsCleaned / maxItems) * 100
                return (
                  <div key={cat.name} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 truncate text-[12px] capitalize text-zinc-400">{cat.name}</span>
                    <div className="flex-1 h-[6px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                      <div className="h-full rounded-full" style={{ width: `${percent}%`, background: PIE_COLORS[i % PIE_COLORS.length], opacity: 0.8 }} />
                    </div>
                    <span className="w-14 shrink-0 text-right font-mono text-[11px]" style={{ color: '#6e6e76' }}>{cat.itemsCleaned}</span>
                    {cat.spaceSaved > 0 && (
                      <span className="w-18 shrink-0 text-right font-mono text-[11px]" style={{ color: '#4e4e56' }}>{formatBytes(cat.spaceSaved)}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============ Cloud View ============

const cloudCommandColors: Record<string, string> = {
  'scan': '#f59e0b', 'clean': '#22c55e', 'software-update-check': '#06b6d4', 'software-update-run': '#06b6d4',
  'get-status': '#6e6e76', 'get-system-info': '#6e6e76', 'get-health-report': '#3b82f6', 'ping': '#6e6e76',
  'shutdown': '#ef4444', 'restart': '#f97316', 'windows-update-check': '#06b6d4', 'windows-update-install': '#06b6d4',
  'run-sfc': '#8b5cf6', 'run-dism': '#8b5cf6', 'get-network-config': '#22c55e', 'get-event-log': '#6366f1',
  'get-installed-apps': '#a855f7', 'driver-update-scan': '#8b5cf6', 'driver-update-install': '#8b5cf6',
  'driver-clean': '#8b5cf6', 'startup-list': '#f97316', 'startup-toggle': '#f97316', 'disk-health': '#14b8a6',
  'privacy-scan': '#14b8a6', 'privacy-apply': '#14b8a6', 'debloater-scan': '#a855f7', 'debloater-remove': '#a855f7',
  'service-scan': '#6366f1', 'service-apply': '#6366f1', 'malware-quarantine': '#ef4444', 'malware-delete': '#ef4444',
  'registry-scan': '#3b82f6', 'registry-fix': '#3b82f6',
}

const cloudCommandLabelKeys: Record<string, string> = {
  'scan': 'cloudCommandLabels.scan', 'clean': 'cloudCommandLabels.clean',
  'software-update-check': 'cloudCommandLabels.softwareUpdateCheck', 'software-update-run': 'cloudCommandLabels.softwareUpdateRun',
  'get-status': 'cloudCommandLabels.getStatus', 'get-system-info': 'cloudCommandLabels.getSystemInfo',
  'get-health-report': 'cloudCommandLabels.getHealthReport', 'ping': 'cloudCommandLabels.ping',
  'shutdown': 'cloudCommandLabels.shutdown', 'restart': 'cloudCommandLabels.restart',
  'windows-update-check': 'cloudCommandLabels.windowsUpdateCheck', 'windows-update-install': 'cloudCommandLabels.windowsUpdateInstall',
  'run-sfc': 'cloudCommandLabels.runSfc', 'run-dism': 'cloudCommandLabels.runDism',
  'get-network-config': 'cloudCommandLabels.getNetworkConfig', 'get-event-log': 'cloudCommandLabels.getEventLog',
  'get-installed-apps': 'cloudCommandLabels.getInstalledApps', 'driver-update-scan': 'cloudCommandLabels.driverUpdateScan',
  'driver-update-install': 'cloudCommandLabels.driverUpdateInstall', 'driver-clean': 'cloudCommandLabels.driverClean',
  'startup-list': 'cloudCommandLabels.startupList', 'startup-toggle': 'cloudCommandLabels.startupToggle',
  'disk-health': 'cloudCommandLabels.diskHealth', 'privacy-scan': 'cloudCommandLabels.privacyScan',
  'privacy-apply': 'cloudCommandLabels.privacyApply', 'debloater-scan': 'cloudCommandLabels.debloaterScan',
  'debloater-remove': 'cloudCommandLabels.debloaterRemove', 'service-scan': 'cloudCommandLabels.serviceScan',
  'service-apply': 'cloudCommandLabels.serviceApply', 'malware-quarantine': 'cloudCommandLabels.malwareQuarantine',
  'malware-delete': 'cloudCommandLabels.malwareDelete', 'registry-scan': 'cloudCommandLabels.registryScan',
  'registry-fix': 'cloudCommandLabels.registryFix',
}

function CloudView({ entries, loaded }: { entries: CloudActionEntry[]; loaded: boolean }) {
  const { t } = useTranslation('history')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (!loaded) return null

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Cloud}
        title={t('cloud.emptyStateTitle')}
        description={t('cloud.emptyStateDescription')}
      />
    )
  }

  const successCount = entries.filter((e) => e.success).length
  const failCount = entries.filter((e) => !e.success).length
  const avgDuration = entries.length > 0
    ? entries.reduce((s, e) => s + e.duration, 0) / entries.length
    : 0

  const detail = entries.find((e) => e.id === selectedId) || null

  return (
    <>
      {/* Stats row */}
      <div className="mb-5 grid grid-cols-4 gap-3">
        <MiniStat icon={Cloud} label={t('cloud.totalCommands')} value={entries.length.toString()} color="#3b82f6" />
        <MiniStat icon={CheckCircle2} label={t('cloud.succeeded')} value={successCount.toString()} color="#22c55e" />
        <MiniStat icon={XCircle} label={t('cloud.failed')} value={failCount.toString()} color="#ef4444" />
        <MiniStat icon={Clock} label={t('cloud.avgDuration')} value={formatDuration(avgDuration, t)} color="#a855f7" />
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <th className="w-10 px-4 py-3 text-center text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('cloud.columnStatus')}</th>
              <th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('cloud.columnCommand')}</th>
              <th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('cloud.columnSummary')}</th>
              <th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('cloud.columnDate')}</th>
              <th className="px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{t('cloud.columnDuration')}</th>
              <th className="w-10 px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const labelKey = cloudCommandLabelKeys[entry.commandType]
              const cfg = { label: labelKey ? t(labelKey) : entry.commandType, color: cloudCommandColors[entry.commandType] || '#6e6e76' }
              return (
                <tr
                  key={entry.id}
                  className="cursor-pointer transition-colors"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
                  onClick={() => setSelectedId(entry.id)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <td className="px-4 py-3 text-center">
                    {entry.success
                      ? <CheckCircle2 className="inline h-4 w-4" style={{ color: '#22c55e' }} strokeWidth={1.8} />
                      : <XCircle className="inline h-4 w-4" style={{ color: '#ef4444' }} strokeWidth={1.8} />
                    }
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-medium text-zinc-200">{cfg.label}</span>
                      <span className="rounded-full px-2 py-0.5 text-[9px] font-medium" style={{ background: `${cfg.color}15`, color: cfg.color }}>
                        {entry.commandType}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 max-w-[240px]">
                    <span className="block truncate text-[12px]" style={{ color: entry.error ? '#ef4444' : '#6e6e76' }}>
                      {entry.summary || entry.error || t('cloud.completed')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[12px]" style={{ color: '#8e8e96' }}>
                    {new Date(entry.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    <span className="ml-1.5" style={{ color: '#4e4e56' }}>
                      {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[12px]" style={{ color: '#6e6e76' }}>
                    {formatDuration(entry.duration, t)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Info className="inline h-3.5 w-3.5" style={{ color: '#4e4e56' }} strokeWidth={1.8} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Detail popup */}
      {detail && <CloudDetailPopup entry={detail} onClose={() => setSelectedId(null)} />}
    </>
  )
}

// ============ Cloud Detail Popup ============

function CloudDetailPopup({ entry, onClose }: { entry: CloudActionEntry; onClose: () => void }) {
  const { t } = useTranslation('history')
  const labelKey = cloudCommandLabelKeys[entry.commandType]
  const cfg = { label: labelKey ? t(labelKey) : entry.commandType, color: cloudCommandColors[entry.commandType] || '#6e6e76' }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }} onClick={onClose} />
      <div
        className="relative w-full max-w-md animate-scale-in rounded-2xl p-6"
        style={{ background: '#18181c', border: '1px solid rgba(255,255,255,0.06)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
      >
        {/* Header */}
        <div className="mb-5 flex items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{ background: entry.success ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)' }}
          >
            {entry.success
              ? <CheckCircle2 className="h-5 w-5" style={{ color: '#22c55e' }} strokeWidth={1.8} />
              : <XCircle className="h-5 w-5" style={{ color: '#ef4444' }} strokeWidth={1.8} />
            }
          </div>
          <div className="flex-1">
            <h3 className="text-[15px] font-semibold text-white">{cfg.label}</h3>
            <p className="text-[12px]" style={{ color: '#6e6e76' }}>
              {new Date(entry.timestamp).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
              {' ' + t('timeline.dateAt') + ' '}
              {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </p>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors" style={{ color: '#6e6e76' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
            <XCircle className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        {/* Detail rows */}
        <div className="space-y-3 rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <DetailRow label={t('cloud.detailCommand')} value={entry.commandType} color={cfg.color} />
          <DetailRow label={t('cloud.detailStatus')} value={entry.success ? t('cloud.detailStatusSuccess') : t('cloud.detailStatusFailed')} color={entry.success ? '#22c55e' : '#ef4444'} />
          <DetailRow label={t('cloud.detailDuration')} value={formatDuration(entry.duration, t)} />
          <DetailRow label={t('cloud.detailRequestId')} value={entry.requestId} mono />
          {entry.summary && <DetailRow label={t('cloud.detailSummary')} value={entry.summary} />}
          {entry.error && <DetailRow label={t('cloud.detailError')} value={entry.error} color="#ef4444" />}
        </div>
      </div>
    </div>
  )
}

function DetailRow({ label, value, color, mono }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{label}</span>
      <span className={`text-right text-[12px] break-all ${mono ? 'font-mono' : ''}`} style={{ color: color || '#a1a1aa' }}>{value}</span>
    </div>
  )
}

// ============ Shared Components ============

function MiniStat({ icon: Icon, label, value, color }: { icon: typeof BarChart3; label: string; value: string; color: string }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4" style={{ color }} strokeWidth={1.8} />
        <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>{label}</span>
      </div>
      <span className="text-[20px] font-bold tracking-tight text-zinc-100">{value}</span>
    </div>
  )
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <p className="text-[10px] font-medium uppercase tracking-wider" style={{ color: '#4e4e56' }}>{label}</p>
      <p className="mt-1 text-[16px] font-semibold text-zinc-200">{value}</p>
    </div>
  )
}

function RecentScanRow({ entry }: { entry: ScanHistoryEntry }) {
  const { t } = useTranslation('history')
  const typeConfig = useTypeConfig()
  const config = typeConfig[entry.type]
  const Icon = config.icon

  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors"
      style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: config.bg }}>
        <Icon className="h-4 w-4" style={{ color: config.color }} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-[12px] font-medium text-zinc-300">{config.label}</span>
        <p className="text-[11px]" style={{ color: '#4e4e56' }}>
          {entry.totalItemsCleaned.toLocaleString()} {t('detail.itemsSuffix')}
          {entry.totalSpaceSaved > 0 && ` · ${formatBytes(entry.totalSpaceSaved)}`}
        </p>
      </div>
      <span className="shrink-0 text-[11px]" style={{ color: '#4e4e56' }}>
        {new Date(entry.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
      </span>
    </div>
  )
}

function formatDuration(ms: number, t?: (key: string, opts?: Record<string, unknown>) => string): string {
  if (ms < 1000) return t ? t('duration.lessThanOneSecond') : '<1s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return t ? t('duration.seconds', { count: seconds }) : `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return t ? t('duration.minutesAndSeconds', { minutes, seconds: secs }) : `${minutes}m ${secs}s`
}
