import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap, Shield, RefreshCw, Clock, Activity, TrendingDown, ChevronDown, ChevronUp, BarChart3, Trash2 } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/utils'
import { useStartupStore } from '@/stores/startup-store'
import { useHistoryStore } from '@/stores/history-store'
import type { StartupItem, StartupBootTrace } from '@shared/types'

const impactStyles: Record<StartupItem['impact'], { bg: string; text: string }> = {
  high: { bg: 'rgba(239,68,68,0.08)', text: '#ef4444' },
  medium: { bg: 'rgba(245,158,11,0.08)', text: '#f59e0b' },
  low: { bg: 'rgba(34,197,94,0.08)', text: '#22c55e' },
  none: { bg: 'rgba(255,255,255,0.04)', text: '#52525e' }
}

const impactBarColors: Record<string, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#22c55e'
}

const sourceKeys: Record<StartupItem['source'], string> = {
  'registry-hkcu': 'sourceUserRegistry',
  'registry-hklm': 'sourceSystemRegistry',
  'startup-folder': 'sourceStartupFolder',
  'task-scheduler': 'sourceTaskScheduler',
  'launch-agent-user': 'sourceLaunchAgentUser',
  'launch-agent-global': 'sourceLaunchAgentGlobal',
  'login-item': 'sourceLoginItem',
  'systemd-user': 'sourceSystemdUser',
  'autostart-desktop': 'sourceAutostartDesktop',
  'cron': 'sourceCron',
}

function formatMs(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

function BootTracePanel({ trace, loading }: { trace: StartupBootTrace | null; loading: boolean }) {
  const { t } = useTranslation('startup')
  const [expanded, setExpanded] = useState(true)

  if (loading) {
    return (
      <div className="mb-5 rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-500" />
          <span className="text-[13px] text-zinc-500">{t('bootTraceAnalyzing')}</span>
        </div>
      </div>
    )
  }

  if (!trace || !trace.available) {
    return (
      <div className="mb-5 rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-3 text-zinc-500">
          <BarChart3 className="h-4.5 w-4.5" strokeWidth={1.8} />
          <span className="text-[13px]">
            {trace?.needsAdmin
              ? t('bootTraceNeedsAdmin')
              : t('bootTraceNotAvailable')}
          </span>
        </div>
      </div>
    )
  }

  const barData = trace.entries.slice(0, 15).map((e) => {
    const clean = e.displayName.replace(/\.exe$/i, '')
    return {
    name: clean.length > 18 ? clean.slice(0, 16) + '…' : clean,
    fullName: clean,
    delay: e.delayMs,
    impact: e.impact
  }})

  const pieData = [
    { name: t('pieCoreBoot'), value: Math.max(0, trace.mainPathMs - trace.startupAppsMs), fill: '#3b82f6' },
    { name: t('pieStartupApps'), value: trace.startupAppsMs, fill: '#f59e0b' },
    { name: t('pieOther'), value: Math.max(0, trace.totalBootMs - trace.mainPathMs), fill: '#27272a' }
  ].filter((d) => d.value > 0)

  const highCount = trace.entries.filter((e) => e.impact === 'high').length
  const potentialSavings = trace.entries.filter((e) => e.impact === 'high').reduce((s, e) => s + e.delayMs, 0)

  return (
    <div className="mb-5 rounded-2xl overflow-hidden" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between p-5 text-left transition-colors hover:bg-white/2"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: 'rgba(245,158,11,0.1)' }}>
            <Activity className="h-4.5 w-4.5" style={{ color: '#f59e0b' }} strokeWidth={1.8} />
          </div>
          <div>
            <h3 className="text-[14px] font-medium text-zinc-200">{t('bootTraceTitle')}</h3>
            <p className="text-[12px]" style={{ color: '#52525e' }}>
              {trace.lastBootDate
                ? t('bootTraceLastBoot', { date: new Date(trace.lastBootDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })
                : t('bootTraceBasedOnLastBoot')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-4 text-[12px]">
            <span className="text-zinc-500">{t('bootTraceTotalBoot')} <span className="font-semibold text-zinc-300">{formatMs(trace.totalBootMs)}</span></span>
            {highCount > 0 && (
              <span className="text-red-400/80">{highCount === 1 ? t('bootTraceHighImpactApp', { count: highCount }) : t('bootTraceHighImpactApps', { count: highCount })}</span>
            )}
          </div>
          {expanded ? <ChevronUp className="h-4 w-4 text-zinc-600" /> : <ChevronDown className="h-4 w-4 text-zinc-600" />}
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5">
          {/* Stat cards row */}
          <div className="grid grid-cols-2 gap-3 mb-5 sm:grid-cols-4">
            <StatMini icon={Clock} label={t('statTotalBootTime')} value={formatMs(trace.totalBootMs)} color="#3b82f6" />
            <StatMini icon={Zap} label={t('statStartupAppsDelay')} value={formatMs(trace.startupAppsMs)} color="#f59e0b" />
            <StatMini icon={Activity} label={t('statAppsMeasured')} value={String(trace.entries.length)} color="#8b5cf6" />
            <StatMini icon={TrendingDown} label={t('statPotentialSavings')} value={potentialSavings > 0 ? formatMs(potentialSavings) : '—'} color="#22c55e" />
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* Bar chart — per-app delay */}
            <div className="lg:col-span-2 rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
              <h4 className="mb-3 text-[12px] font-medium text-zinc-400">{t('chartBootTimeImpact')}</h4>
              {barData.length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(200, barData.length * 32 + 20)}>
                  <BarChart data={barData} layout="vertical" margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
                    <XAxis
                      type="number"
                      tick={{ fill: '#52525e', fontSize: 11 }}
                      tickFormatter={(v: number) => formatMs(v)}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tick={{ fill: '#a1a1aa', fontSize: 11 }}
                      width={130}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                      contentStyle={{
                        background: '#1c1c21',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 12,
                        fontSize: 12,
                        color: '#e4e4e7',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
                      }}
                      labelStyle={{ color: '#e4e4e7' }}
                      itemStyle={{ color: '#a1a1aa' }}
                      formatter={(value: unknown) => [formatMs(value as number), t('chartTooltipDelay')]}
                      labelFormatter={(label: unknown, payload: readonly { payload?: { fullName?: string } }[]) =>
                        payload?.[0]?.payload?.fullName || String(label)
                      }
                    />
                    <Bar dataKey="delay" radius={[0, 6, 6, 0]} maxBarSize={22}>
                      {barData.map((entry, i) => (
                        <Cell key={i} fill={impactBarColors[entry.impact] || '#52525e'} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-[200px] items-center justify-center text-[13px] text-zinc-600">
                  {t('chartNoPerAppData')}
                </div>
              )}
            </div>

            {/* Pie chart — boot time breakdown */}
            <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
              <h4 className="mb-3 text-[12px] font-medium text-zinc-400">{t('chartBootTimeBreakdown')}</h4>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={48}
                    outerRadius={72}
                    paddingAngle={3}
                    dataKey="value"
                    stroke="none"
                  >
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: '#1c1c21',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 12,
                      fontSize: 12,
                      color: '#e4e4e7',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.4)'
                    }}
                    labelStyle={{ color: '#e4e4e7' }}
                    itemStyle={{ color: '#a1a1aa' }}
                    formatter={(value: unknown) => [formatMs(value as number), '']}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1.5">
                {pieData.map((d, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-2">
                      <div className="h-2.5 w-2.5 rounded-sm" style={{ background: d.fill }} />
                      <span className="text-zinc-400">{d.name}</span>
                    </div>
                    <span className="font-mono text-zinc-500">{formatMs(d.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatMini({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl p-3.5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="h-3.5 w-3.5" style={{ color }} strokeWidth={1.8} />
        <span className="text-[11px] text-zinc-500">{label}</span>
      </div>
      <span className="text-[18px] font-semibold text-zinc-200">{value}</span>
    </div>
  )
}

export function StartupPage() {
  const { t } = useTranslation('startup')
  const items = useStartupStore((s) => s.items)
  const loading = useStartupStore((s) => s.loading)
  const sortBy = useStartupStore((s) => s.sortBy)
  const filterBy = useStartupStore((s) => s.filterBy)
  const error = useStartupStore((s) => s.error)
  const bootTrace = useStartupStore((s) => s.bootTrace)
  const traceLoading = useStartupStore((s) => s.traceLoading)
  const deleteTarget = useStartupStore((s) => s.deleteTarget)

  const store = useStartupStore

  const loadItems = useCallback(async () => {
    store.getState().setLoading(true)
    store.getState().setError(null)
    try {
      const list = await window.kudu.startupList()
      store.getState().setItems(list)
    } catch (err) {
      console.error('Failed to load startup items:', err)
      store.getState().setError(t('errorFailedToLoad'))
    }
    store.getState().setLoading(false)
  }, [])

  const loadBootTrace = useCallback(async () => {
    store.getState().setTraceLoading(true)
    try {
      const trace = await window.kudu.startupBootTrace()
      store.getState().setBootTrace(trace)
    } catch (err) {
      console.error('Failed to load boot trace:', err)
    }
    store.getState().setTraceLoading(false)
  }, [])

  useEffect(() => {
    if (items.length === 0) {
      loadItems()
    }
    if (!bootTrace) {
      loadBootTrace()
    }
  }, [loadItems, loadBootTrace])

  const handleToggle = async (item: StartupItem, enabled: boolean) => {
    const startTime = Date.now()
    store.getState().updateItem(item.id, { enabled })
    try {
      const success = await window.kudu.startupToggle(item.name, item.location, item.command, item.source, enabled)
      if (!success) {
        store.getState().updateItem(item.id, { enabled: !enabled })
        toast.error(enabled ? t('toastFailedToEnable', { name: item.displayName }) : t('toastFailedToDisable', { name: item.displayName }), { description: t('toastAdminRequired') })
        store.getState().setError(t('errorFailedToToggle', { action: enabled ? 'enable' : 'disable', name: item.displayName }))
        return
      }
      await useHistoryStore.getState().addEntry({
        id: Date.now().toString(),
        type: 'startup',
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        totalItemsFound: 1,
        totalItemsCleaned: 1,
        totalItemsSkipped: 0,
        totalSpaceSaved: 0,
        categories: [{ name: enabled ? t('historyCategoryEnabled') : t('historyCategoryDisabled'), itemsFound: 1, itemsCleaned: 1, spaceSaved: 0 }],
        errorCount: 0
      })
    } catch {
      store.getState().updateItem(item.id, { enabled: !enabled })
      toast.error(enabled ? t('toastFailedToEnable', { name: item.displayName }) : t('toastFailedToDisable', { name: item.displayName }), { description: t('toastAdminRequired') })
      store.getState().setError(t('errorFailedToToggle', { action: enabled ? 'enable' : 'disable', name: item.displayName }))
    }
  }

  const handleDelete = async (item: StartupItem) => {
    const startTime = Date.now()
    try {
      const success = await window.kudu.startupDelete(item.name, item.source === 'startup-folder' ? item.command : item.location, item.source)
      if (success) {
        store.getState().removeItem(item.id)
        await useHistoryStore.getState().addEntry({
          id: Date.now().toString(),
          type: 'startup',
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          totalItemsFound: 1,
          totalItemsCleaned: 1,
          totalItemsSkipped: 0,
          totalSpaceSaved: 0,
          categories: [{ name: t('historyCategoryRemoved'), itemsFound: 1, itemsCleaned: 1, spaceSaved: 0 }],
          errorCount: 0
        })
      } else {
        toast.error(t('toastFailedToRemove', { name: item.displayName }), { description: t('toastAdminRequired') })
        store.getState().setError(t('errorFailedToRemove', { name: item.displayName }))
      }
    } catch {
      toast.error(t('toastFailedToRemove', { name: item.displayName }), { description: t('toastAdminRequired') })
      store.getState().setError(t('errorFailedToRemove', { name: item.displayName }))
    }
    store.getState().setDeleteTarget(null)
  }

  const impactOrder: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 }
  const filtered = items.filter((i) => filterBy === 'all' ? true : filterBy === 'active' ? i.enabled : !i.enabled)
  const sorted = [...filtered].sort((a, b) => sortBy === 'impact' ? impactOrder[a.impact] - impactOrder[b.impact] : a.displayName.localeCompare(b.displayName))

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        action={
          <div className="flex items-center gap-2.5">
            <select value={filterBy} onChange={(e) => store.getState().setFilterBy(e.target.value as any)}
              className="rounded-xl px-4 py-2.5 text-[13px] text-zinc-400 outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <option value="all">{t('filterAll')}</option>
              <option value="active">{t('filterActive')}</option>
              <option value="disabled">{t('filterDisabled')}</option>
            </select>
            <select value={sortBy} onChange={(e) => store.getState().setSortBy(e.target.value as any)}
              className="rounded-xl px-4 py-2.5 text-[13px] text-zinc-400 outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <option value="impact">{t('sortByImpact')}</option>
              <option value="name">{t('sortByName')}</option>
            </select>
            <button onClick={() => { loadItems(); loadBootTrace() }} disabled={loading}
              className="flex items-center justify-center rounded-xl p-2.5 text-zinc-500 transition-colors"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} strokeWidth={1.8} />
            </button>
          </div>
        }
      />

      {/* Boot Trace Impact Analysis */}
      <BootTracePanel trace={bootTrace} loading={traceLoading} />

      {error && <ErrorAlert message={error} onDismiss={() => store.getState().setError(null)} className="mb-5" />}

      {items.length === 0 && !loading && !error && (
        <EmptyState icon={Zap} title={t('emptyStateTitle')} description={t('emptyStateDescription')} />
      )}

      <div className="space-y-2.5">
        {sorted.map((item) => (
          <div key={item.id}
            className={cn('flex items-center gap-5 rounded-2xl p-5 transition-all', !item.enabled && 'opacity-50')}
            style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
            {/* Icon */}
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
              style={{ background: 'rgba(255,255,255,0.04)' }}>
              <span className="text-[14px] font-bold" style={{ color: '#4e4e56' }}>{item.displayName.charAt(0)}</span>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium text-zinc-200">{item.displayName}</span>
                {item.impact === 'none' && <Shield className="h-3.5 w-3.5" style={{ color: '#3a3a42' }} strokeWidth={1.8} />}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[12px]" style={{ color: '#52525e' }}>
                <span>{item.publisher}</span>
                <span style={{ color: '#2a2a30' }}>·</span>
                <span>{t(sourceKeys[item.source])}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[11px]" style={{ color: '#3a3a42' }} title={item.command}>
                {item.command}
              </div>
            </div>

            {/* Impact */}
            <span className="rounded-lg px-3 py-1.5 text-[11px] font-semibold capitalize"
              style={{ background: impactStyles[item.impact].bg, color: impactStyles[item.impact].text }}>
              {t('impactLabel', { level: item.impact })}
            </span>

            {/* Toggle + Delete */}
            <div className="flex items-center gap-2">
              <button onClick={() => handleToggle(item, !item.enabled)}
                className="relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors"
                style={{ background: item.enabled ? '#f59e0b' : 'rgba(255,255,255,0.08)' }}>
                <div className={cn(
                  'absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                  item.enabled ? 'translate-x-[22px]' : 'translate-x-[3px]'
                )} />
              </button>
              <button
                onClick={() => store.getState().setDeleteTarget(item)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-600 transition-colors hover:text-red-400"
                style={{ background: 'rgba(255,255,255,0.02)' }}
                title={t('removeButtonTitle', { name: item.displayName })}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {deleteTarget && (
        <ConfirmDialog
          open
          onCancel={() => store.getState().setDeleteTarget(null)}
          onConfirm={() => handleDelete(deleteTarget)}
          title={t('confirmRemoveTitle', { name: deleteTarget.displayName })}
          description={t('confirmRemoveDescription')}
          details={deleteTarget.command && deleteTarget.command !== 'undefined' ? deleteTarget.command : undefined}
          confirmLabel={t('confirmRemoveLabel')}
          variant="danger"
        />
      )}
    </div>
  )
}
