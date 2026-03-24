import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Download,
  Search,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Package,
  ArrowRight,
  Sparkles,
  XCircle,
  Filter,
  EyeOff,
  Eye,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatCard } from '@/components/shared/StatCard'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { useUpdaterStore, severityOrder } from '@/stores/updater-store'
import { useHistoryStore } from '@/stores/history-store'
import type { UpdateProgress, UpdatableApp, UpToDateApp } from '@shared/types'

const SEVERITY_STYLES_BASE = {
  major: {
    bg: 'rgba(239,68,68,0.08)',
    border: 'rgba(239,68,68,0.18)',
    text: '#f87171',
    labelKey: 'softwareUpdater.severityMajor',
  },
  minor: {
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.18)',
    text: '#fbbf24',
    labelKey: 'softwareUpdater.severityMinor',
  },
  patch: {
    bg: 'rgba(34,197,94,0.08)',
    border: 'rgba(34,197,94,0.18)',
    text: '#4ade80',
    labelKey: 'softwareUpdater.severityPatch',
  },
  unknown: {
    bg: 'rgba(113,113,122,0.08)',
    border: 'rgba(113,113,122,0.18)',
    text: '#a1a1aa',
    labelKey: 'softwareUpdater.severityUpdate',
  },
}

const SORT_LABEL_KEYS: Record<string, string> = {
  name: 'softwareUpdater.sortName',
  severity: 'softwareUpdater.sortSeverity',
  source: 'softwareUpdater.sortSource',
}

const FILTER_LABEL_KEYS: Record<string, string> = {
  all: 'softwareUpdater.filterAll',
  major: 'softwareUpdater.filterMajor',
  minor: 'softwareUpdater.filterMinor',
  patch: 'softwareUpdater.filterPatch',
}

export function SoftwareUpdaterPage({ embedded }: { embedded?: boolean }) {
  const { t } = useTranslation('updates')
  const apps = useUpdaterStore((s) => s.apps)
  const loading = useUpdaterStore((s) => s.loading)
  const updating = useUpdaterStore((s) => s.updating)
  const progress = useUpdaterStore((s) => s.progress)
  const updateResult = useUpdaterStore((s) => s.updateResult)
  const error = useUpdaterStore((s) => s.error)
  const hasChecked = useUpdaterStore((s) => s.hasChecked)
  const packageManagerAvailable = useUpdaterStore((s) => s.packageManagerAvailable)
  const packageManagerName = useUpdaterStore((s) => s.packageManagerName)
  const searchQuery = useUpdaterStore((s) => s.searchQuery)
  const sortField = useUpdaterStore((s) => s.sortField)
  const sortDirection = useUpdaterStore((s) => s.sortDirection)
  const severityFilter = useUpdaterStore((s) => s.severityFilter)

  const upToDate = useUpdaterStore((s) => s.upToDate)

  const ignoredApps = useUpdaterStore((s) => s.ignoredApps)

  const [showSortMenu, setShowSortMenu] = useState(false)
  const [showFilterMenu, setShowFilterMenu] = useState(false)
  const [showUpToDate, setShowUpToDate] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const filterMenuRef = useRef<HTMLDivElement>(null)

  // Listen for progress events
  useEffect(() => {
    const cleanup = window.kudu.onSoftwareUpdateProgress((data: UpdateProgress) => {
      useUpdaterStore.getState().setProgress(data)
    })
    return () => {
      cleanup()
    }
  }, [])

  // Load persisted ignore list from settings, then auto-scan on first visit
  useEffect(() => {
    window.kudu.settingsGet().then((settings) => {
      if (settings.ignoredSoftwareUpdates?.length) {
        useUpdaterStore.getState().loadIgnoredIds(settings.ignoredSoftwareUpdates)
      }
    }).catch(() => {}).finally(() => {
      const s = useUpdaterStore.getState()
      if (!s.hasChecked && !s.loading) handleCheck()
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Close menus on outside click
  useEffect(() => {
    if (!showSortMenu && !showFilterMenu) return
    const handler = (e: globalThis.MouseEvent) => {
      if (showSortMenu && sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node))
        setShowSortMenu(false)
      if (
        showFilterMenu &&
        filterMenuRef.current &&
        !filterMenuRef.current.contains(e.target as Node)
      )
        setShowFilterMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSortMenu, showFilterMenu])

  // ─── Check for updates ──────────────────────────────────────
  const handleCheck = useCallback(async () => {
    const store = useUpdaterStore.getState()
    store.setLoading(true)
    store.setError(null)
    store.setUpdateResult(null)

    try {
      const result = await window.kudu.softwareUpdateCheck()
      const s = useUpdaterStore.getState()
      s.setApps(result.apps)
      s.setUpToDate(result.upToDate)
      s.setPackageManagerAvailable(result.packageManagerAvailable)
      s.setPackageManagerName(result.packageManagerName)
      s.setHasChecked(true)

      // Use the visible (non-ignored) count for the toast
      const visibleCount = useUpdaterStore.getState().apps.length
      if (result.packageManagerAvailable && visibleCount === 0 && useUpdaterStore.getState().ignoredApps.length === 0) {
        toast.success(t('softwareUpdater.toastAllUpToDate'))
      } else if (visibleCount > 0) {
        toast.info(visibleCount !== 1 ? t('softwareUpdater.toastUpdatesFoundPlural', { count: visibleCount }) : t('softwareUpdater.toastUpdatesFound', { count: visibleCount }))
      }
    } catch (err) {
      console.error('Update check failed:', err)
      useUpdaterStore.getState().setError(t('softwareUpdater.errorCheckFailed'))
    } finally {
      useUpdaterStore.getState().setLoading(false)
    }
  }, [])

  // ─── Run updates ────────────────────────────────────────────
  const handleUpdate = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      const store = useUpdaterStore.getState()
      store.setUpdating(true)
      store.setUpdateResult(null)
      store.setError(null)
      store.setProgress(null)

      const startTime = Date.now()
      const appsToUpdate = store.apps.filter(a => ids.includes(a.id))

      try {
        const result = await window.kudu.softwareUpdateRun(ids)
        const s = useUpdaterStore.getState()
        s.setUpdateResult(result)
        s.setProgress(null)

        if (result.succeeded > 0) {
          // Remove successfully updated apps from the list
          const failedIds = new Set(result.errors.map((e) => e.appId))
          const succeededIds = ids.filter((id) => !failedIds.has(id))
          s.removeApps(succeededIds)
          toast.success(
            result.succeeded !== 1 ? t('softwareUpdater.toastUpdateSuccessPlural', { count: result.succeeded }) : t('softwareUpdater.toastUpdateSuccess', { count: result.succeeded }),
          )
        }
        if (result.failed > 0) {
          toast.error(
            result.failed !== 1 ? t('softwareUpdater.toastUpdateFailedPlural', { count: result.failed }) : t('softwareUpdater.toastUpdateFailed', { count: result.failed }),
          )
        }

        // Log to history
        const bySeverity: Record<string, { found: number; updated: number }> = {}
        const failedAppIds = new Set(result.errors.map(e => e.appId))
        for (const app of appsToUpdate) {
          const sev = app.severity
          if (!bySeverity[sev]) bySeverity[sev] = { found: 0, updated: 0 }
          bySeverity[sev].found++
          if (!failedAppIds.has(app.id)) bySeverity[sev].updated++
        }
        await useHistoryStore.getState().addEntry({
          id: Date.now().toString(),
          type: 'software-update',
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          totalItemsFound: ids.length,
          totalItemsCleaned: result.succeeded,
          totalItemsSkipped: 0,
          totalSpaceSaved: 0,
          categories: Object.entries(bySeverity).map(([name, d]) => ({
            name: `${name} updates`, itemsFound: d.found, itemsCleaned: d.updated, spaceSaved: 0
          })),
          errorCount: result.failed
        })
      } catch (err) {
        console.error('Update failed:', err)
        useUpdaterStore.getState().setError(t('softwareUpdater.errorUpdateFailed'))
      } finally {
        useUpdaterStore.getState().setUpdating(false)
      }
    },
    [],
  )

  const handleUpdateSelected = useCallback(() => {
    const selectedIds = useUpdaterStore.getState().apps.filter((a) => a.selected).map((a) => a.id)
    handleUpdate(selectedIds)
  }, [handleUpdate])

  // ─── Filtered & sorted list ─────────────────────────────────
  const filteredApps = useMemo(() => {
    let list = apps

    if (severityFilter !== 'all') {
      list = list.filter((a) => a.severity === severityFilter)
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
      )
    }

    const dir = sortDirection === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      switch (sortField) {
        case 'severity':
          return (severityOrder[a.severity] - severityOrder[b.severity]) * dir
        case 'source':
          return a.source.localeCompare(b.source) * dir
        default:
          return a.name.localeCompare(b.name) * dir
      }
    })
  }, [apps, searchQuery, sortField, sortDirection, severityFilter])

  const selectedCount = apps.filter((a) => a.selected).length
  const allSelected = apps.length > 0 && selectedCount === apps.length
  const isBusy = loading || updating

  const majorCount = apps.filter((a) => a.severity === 'major').length
  const minorCount = apps.filter((a) => a.severity === 'minor').length
  const patchCount = apps.filter((a) => a.severity === 'patch').length

  return (
    <div className={embedded ? '' : 'animate-fade-in'}>
      {!embedded && (
        <PageHeader
          title={t('softwareUpdater.pageTitle')}
          description={t('softwareUpdater.pageDescription')}
        />
      )}

      {/* Actions */}
      <div className="mb-5 flex items-center gap-2.5">
        <button
          onClick={handleCheck}
          disabled={isBusy}
          className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40"
          style={{
            background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
            color: 'var(--text-on-accent)',
          }}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          ) : (
            <RefreshCw className="h-4 w-4" strokeWidth={2} />
          )}
          {loading ? t('softwareUpdater.checkingButton') : hasChecked ? t('softwareUpdater.recheckButton') : t('softwareUpdater.checkForUpdatesButton')}
        </button>

        {/* Search */}
        {hasChecked && apps.length > 0 && (
          <div
            className="flex items-center gap-2 rounded-xl px-4 py-2.5"
            style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border-medium)',
            }}
          >
            <Search className="h-4 w-4 text-zinc-500" strokeWidth={1.8} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => useUpdaterStore.getState().setSearchQuery(e.target.value)}
              placeholder={t('softwareUpdater.searchPlaceholder')}
              className="bg-transparent text-[13px] text-zinc-300 placeholder-zinc-600 outline-none w-48"
            />
          </div>
        )}

        {/* Severity filter */}
        {hasChecked && apps.length > 0 && (
          <div className="relative" ref={filterMenuRef}>
            <button
              onClick={() => setShowFilterMenu(!showFilterMenu)}
              className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-400 transition-all"
              style={{
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-medium)',
              }}
            >
              <Filter className="h-3.5 w-3.5" strokeWidth={1.8} />
              {t(FILTER_LABEL_KEYS[severityFilter])}
              <ChevronDown className="h-3 w-3" strokeWidth={2} />
            </button>
            {showFilterMenu && (
              <div
                className="absolute top-full left-0 z-50 mt-1 rounded-xl py-1 shadow-xl"
                style={{
                  background: '#1e1e22',
                  border: '1px solid var(--border-strong)',
                  minWidth: 120,
                }}
              >
                {Object.entries(FILTER_LABEL_KEYS).map(([key, labelKey]) => (
                  <button
                    key={key}
                    onClick={() => {
                      useUpdaterStore.getState().setSeverityFilter(key as any)
                      setShowFilterMenu(false)
                    }}
                    className="flex w-full items-center gap-2 px-4 py-2 text-[12px] text-zinc-300 hover:bg-white/5 transition-colors"
                  >
                    {t(labelKey)}
                    {severityFilter === key && (
                      <CheckCircle2 className="ml-auto h-3 w-3 text-amber-400" strokeWidth={2} />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Sort */}
        {hasChecked && apps.length > 0 && (
          <div className="relative" ref={sortMenuRef}>
            <button
              onClick={() => setShowSortMenu(!showSortMenu)}
              className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-400 transition-all"
              style={{
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-medium)',
              }}
            >
              <ArrowUpDown className="h-3.5 w-3.5" strokeWidth={1.8} />
              {t(SORT_LABEL_KEYS[sortField])}
              <ChevronDown className="h-3 w-3" strokeWidth={2} />
            </button>
            {showSortMenu && (
              <div
                className="absolute top-full left-0 z-50 mt-1 rounded-xl py-1 shadow-xl"
                style={{
                  background: '#1e1e22',
                  border: '1px solid var(--border-strong)',
                  minWidth: 140,
                }}
              >
                {Object.entries(SORT_LABEL_KEYS).map(([field, labelKey]) => (
                  <button
                    key={field}
                    onClick={() => {
                      const store = useUpdaterStore.getState()
                      if (sortField === field) {
                        store.setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                      } else {
                        store.setSortField(field as any)
                        store.setSortDirection('asc')
                      }
                      setShowSortMenu(false)
                    }}
                    className="flex w-full items-center gap-2 px-4 py-2 text-[12px] text-zinc-300 hover:bg-white/5 transition-colors"
                  >
                    {t(labelKey)}
                    {sortField === field && (
                      <span className="ml-auto text-amber-400 text-[10px]">
                        {sortDirection === 'asc' ? t('softwareUpdater.sortAsc') : t('softwareUpdater.sortDesc')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Package manager not available warning */}
      {hasChecked && !packageManagerAvailable && (
        <div
          className="mb-5 flex items-center gap-3 rounded-2xl px-5 py-4"
          style={{
            background: 'rgba(239,68,68,0.04)',
            border: '1px solid rgba(239,68,68,0.1)',
          }}
        >
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" strokeWidth={1.8} />
          <p className="text-[12px] text-zinc-400">
            {packageManagerName === 'brew' ? (
              <>
                <span className="font-semibold text-red-400">{t('softwareUpdater.packageManagerNotFound.brewNotFound')}</span> — {t('softwareUpdater.packageManagerNotFound.brewRequired')}{' '}
                <span className="text-zinc-300">{t('softwareUpdater.packageManagerNotFound.brewSite')}</span>.
              </>
            ) : packageManagerName === 'winget' ? (
              <>
                <span className="font-semibold text-red-400">{t('softwareUpdater.packageManagerNotFound.wingetNotFound')}</span> — {t('softwareUpdater.packageManagerNotFound.wingetRequired')}{' '}
                <span className="text-zinc-300">{t('softwareUpdater.packageManagerNotFound.wingetStore')}</span> {t('softwareUpdater.packageManagerNotFound.wingetSearchTerm')}
              </>
            ) : packageManagerName === 'apt' ? (
              <>
                <span className="font-semibold text-red-400">{t('softwareUpdater.packageManagerNotFound.aptNotFound')}</span> — {t('softwareUpdater.packageManagerNotFound.aptRequired')}
              </>
            ) : packageManagerName === 'dnf' ? (
              <>
                <span className="font-semibold text-red-400">{t('softwareUpdater.packageManagerNotFound.dnfNotFound')}</span> — {t('softwareUpdater.packageManagerNotFound.dnfRequired')}
              </>
            ) : packageManagerName === 'pacman' ? (
              <>
                <span className="font-semibold text-red-400">{t('softwareUpdater.packageManagerNotFound.pacmanNotFound')}</span> — {t('softwareUpdater.packageManagerNotFound.pacmanRequired')}
              </>
            ) : (
              <span className="font-semibold text-red-400">
                {t('softwareUpdater.packageManagerNotFound.noPackageManager')}
              </span>
            )}
          </p>
        </div>
      )}

      {/* Errors */}
      {error && (
        <ErrorAlert
          message={error}
          onDismiss={() => useUpdaterStore.getState().setError(null)}
          className="mb-5"
        />
      )}

      {/* Stat cards */}
      {hasChecked && packageManagerAvailable && apps.length > 0 && (
        <div className="grid grid-cols-4 gap-3 mb-5">
          <StatCard icon={Package} label={t('softwareUpdater.statOutdatedApps')} value={apps.length} variant="accent" />
          <StatCard icon={AlertTriangle} label={t('softwareUpdater.statMajorUpdates')} value={majorCount} variant="danger" />
          <StatCard icon={AlertTriangle} label={t('softwareUpdater.statMinorUpdates')} value={minorCount} variant="default" />
          <StatCard icon={CheckCircle2} label={t('softwareUpdater.statPatches')} value={patchCount} variant="success" />
        </div>
      )}

      {/* Update progress */}
      {updating && progress && (
        <div
          className="mb-5 rounded-2xl p-4"
          style={{
            background: 'rgba(245,158,11,0.04)',
            border: '1px solid var(--accent-muted-bg)',
          }}
        >
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-4 w-4 animate-spin text-amber-400" strokeWidth={2} />
              <span className="text-[13px] font-medium text-zinc-200">
                {t('softwareUpdater.updatingProgress', { app: progress.currentApp, current: progress.current, total: progress.total })}
              </span>
            </div>
            <span className="text-[12px] font-mono" style={{ color: 'var(--text-muted)' }}>
              {progress.percent}%
            </span>
          </div>
          <div
            className="h-1.5 w-full rounded-full overflow-hidden"
            style={{ background: 'var(--bg-hover-2)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${progress.percent}%`,
                background: 'linear-gradient(90deg, #f59e0b 0%, #fbbf24 100%)',
              }}
            />
          </div>
          {progress.status === 'failed' && (
            <p className="mt-2 text-[11px] text-red-400">
              {t('softwareUpdater.failedToUpdate', { app: progress.currentApp })}
            </p>
          )}
        </div>
      )}

      {/* Update result banner */}
      {updateResult && (
        <div
          className="mb-5 flex items-center gap-3 rounded-2xl p-4"
          style={{
            background:
              updateResult.failed === 0
                ? 'rgba(34,197,94,0.06)'
                : 'rgba(239,68,68,0.06)',
            border: `1px solid ${updateResult.failed === 0 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)'}`,
          }}
        >
          {updateResult.failed === 0 ? (
            <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" strokeWidth={1.8} />
          ) : (
            <XCircle className="h-5 w-5 text-red-500 shrink-0" strokeWidth={1.8} />
          )}
          <div className="text-[13px] text-zinc-200">
            {updateResult.succeeded > 0 && (
              <span className="text-green-400">
                {updateResult.succeeded !== 1 ? t('softwareUpdater.updateResultAppsUpdatedPlural', { count: updateResult.succeeded }) : t('softwareUpdater.updateResultAppsUpdated', { count: updateResult.succeeded })}
              </span>
            )}
            {updateResult.succeeded > 0 && updateResult.failed > 0 && <span> — </span>}
            {updateResult.failed > 0 && (
              <span className="text-red-400">
                {t('softwareUpdater.updateResultFailed', { count: updateResult.failed })}
              </span>
            )}
            {updateResult.errors.length > 0 && (
              <div className="mt-2">
                {updateResult.errors.map((e) => {
                  const isInstallerChange = e.reason.toLowerCase().includes('installer type changed')
                  return (
                    <div key={e.appId} className="mt-1.5">
                      <span style={{ color: 'var(--text-muted)' }} className="text-[12px]">
                        {e.name}: {e.reason}
                      </span>
                      {isInstallerChange && packageManagerName && (
                        <div
                          className="mt-1.5 rounded-lg px-3 py-2 font-mono text-[11px] text-zinc-300 select-all cursor-text"
                          style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-medium)' }}
                        >
                          {packageManagerName} uninstall {e.appId}<br />
                          {packageManagerName} install {e.appId}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Selection controls + Update button */}
      {hasChecked && apps.length > 0 && !loading && (
        <div className="mb-4 flex items-center gap-3">
          <button
            onClick={() => {
              const store = useUpdaterStore.getState()
              allSelected ? store.deselectAll() : store.selectAll()
            }}
            disabled={updating}
            className="flex items-center gap-2 text-[12px] font-medium text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
          >
            <div
              className="flex h-4 w-4 items-center justify-center rounded"
              style={{
                background: allSelected ? 'var(--accent)' : 'var(--bg-hover-2)',
                border: allSelected ? 'none' : '1px solid var(--border-stronger)',
              }}
            >
              {allSelected && (
                <CheckCircle2 className="h-3 w-3" style={{ color: 'var(--text-on-accent)' }} strokeWidth={3} />
              )}
            </div>
            {allSelected ? t('softwareUpdater.deselectAll') : t('softwareUpdater.selectAll')}
          </button>

          {selectedCount > 0 && (
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {t('softwareUpdater.selectedCount', { count: selectedCount })}
            </span>
          )}

          <div className="flex-1" />

          <button
            onClick={handleUpdateSelected}
            disabled={selectedCount === 0 || updating}
            className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-30"
            style={{
              background:
                selectedCount > 0
                  ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)'
                  : 'var(--bg-hover)',
              color: selectedCount > 0 ? '#052e16' : 'var(--text-muted)',
              border:
                selectedCount > 0 ? 'none' : '1px solid var(--border-medium)',
            }}
          >
            <Download className="h-4 w-4" strokeWidth={2} />
            {t('softwareUpdater.updateSelectedButton', { count: selectedCount })}
          </button>
        </div>
      )}

      {/* Empty state — before first check */}
      {!hasChecked && !loading && (
        <EmptyState
          icon={RefreshCw}
          title={t('softwareUpdater.emptyStateTitle')}
          description={t('softwareUpdater.emptyStateDescription')}
          action={
            <button
              onClick={handleCheck}
              disabled={isBusy}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40"
              style={{
                background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                color: 'var(--text-on-accent)',
              }}
            >
              <RefreshCw className="h-4 w-4" strokeWidth={2} />
              {t('softwareUpdater.checkForUpdatesButton')}
            </button>
          }
        />
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 className="h-10 w-10 animate-spin text-amber-400 mb-4" strokeWidth={1.5} />
          <p className="text-[13px] text-zinc-400">{t('softwareUpdater.checkingForUpdates')}</p>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
            {t('softwareUpdater.checkingSubtext')}
          </p>
        </div>
      )}

      {/* All up to date */}
      {hasChecked && !loading && apps.length === 0 && ignoredApps.length === 0 && packageManagerAvailable && (
        <EmptyState
          icon={Sparkles}
          title={t('softwareUpdater.allUpToDateTitle')}
          description={t('softwareUpdater.allUpToDateDescription')}
        />
      )}

      {/* No results from filter/search */}
      {hasChecked && !loading && filteredApps.length === 0 && apps.length > 0 && (
        <div className="flex flex-col items-center justify-center py-16">
          <Search className="h-10 w-10 text-zinc-600 mb-4" strokeWidth={1.5} />
          <p className="text-[13px] text-zinc-400">{t('softwareUpdater.noAppsMatchFilters')}</p>
        </div>
      )}

      {/* App list */}
      {hasChecked && !loading && filteredApps.length > 0 && (
        <div className="mb-6">
          <div className="grid grid-cols-1 gap-2">
            {filteredApps.map((app) => (
              <AppRow
                key={app.id}
                app={app}
                updating={updating}
                onToggle={() => useUpdaterStore.getState().toggleAppSelected(app.id)}
                onUpdate={() => handleUpdate([app.id])}
                onIgnore={() => useUpdaterStore.getState().ignoreApp(app.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Ignored apps */}
      {hasChecked && !loading && ignoredApps.length > 0 && (
        <div className="mb-6">
          <button
            onClick={() => setShowIgnored(!showIgnored)}
            className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {showIgnored ? (
              <ChevronDown className="h-4 w-4" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-4 w-4" strokeWidth={2} />
            )}
            <EyeOff className="h-4 w-4 text-zinc-500" strokeWidth={1.8} />
            {t('softwareUpdater.ignoredSection', { count: ignoredApps.length })}
          </button>

          {showIgnored && (
            <div className="grid grid-cols-1 gap-1.5">
              {ignoredApps.map((app) => (
                <IgnoredRow
                  key={app.id}
                  app={app}
                  onUnignore={() => useUpdaterStore.getState().unignoreApp(app.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Up to date apps */}
      {hasChecked && !loading && packageManagerAvailable && upToDate.length > 0 && (
        <div className="mb-6">
          <button
            onClick={() => setShowUpToDate(!showUpToDate)}
            className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {showUpToDate ? (
              <ChevronDown className="h-4 w-4" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-4 w-4" strokeWidth={2} />
            )}
            <CheckCircle2 className="h-4 w-4 text-green-500" strokeWidth={1.8} />
            {t('softwareUpdater.upToDateSection', { count: upToDate.length })}
          </button>

          {showUpToDate && (
            <div className="grid grid-cols-1 gap-1.5">
              {upToDate.map((app) => (
                <UpToDateRow key={app.id} app={app} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AppRow({
  app,
  updating,
  onToggle,
  onUpdate,
  onIgnore,
}: {
  app: UpdatableApp
  updating: boolean
  onToggle: () => void
  onUpdate: () => void
  onIgnore: () => void
}) {
  const { t } = useTranslation('updates')
  const base = SEVERITY_STYLES_BASE[app.severity]
  const severity = { ...base, label: t(base.labelKey) }

  return (
    <div
      className="flex items-center gap-4 rounded-2xl px-5 py-4 transition-colors"
      style={{
        background: app.selected ? 'rgba(245,158,11,0.03)' : 'var(--bg-subtle)',
        border: `1px solid ${app.selected ? 'rgba(245,158,11,0.1)' : 'var(--border-subtle)'}`,
      }}
    >
      {/* Checkbox */}
      <button
        onClick={onToggle}
        disabled={updating}
        className="shrink-0 disabled:opacity-40"
      >
        <div
          className="flex h-4.5 w-4.5 items-center justify-center rounded"
          style={{
            background: app.selected ? 'var(--accent)' : 'var(--bg-hover-2)',
            border: app.selected ? 'none' : '1px solid var(--border-stronger)',
            width: 18,
            height: 18,
          }}
        >
          {app.selected && (
            <CheckCircle2 className="h-3 w-3" style={{ color: 'var(--text-on-accent)' }} strokeWidth={3} />
          )}
        </div>
      </button>

      {/* App icon */}
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        style={{ background: severity.bg }}
      >
        <Package className="h-5 w-5" style={{ color: severity.text }} strokeWidth={1.8} />
      </div>

      {/* App info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-medium text-zinc-200 truncate">{app.name}</span>
          <span
            className="rounded-md px-2 py-0.5 text-[10px] font-medium shrink-0"
            style={{
              background: severity.bg,
              border: `1px solid ${severity.border}`,
              color: severity.text,
            }}
          >
            {severity.label}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
          {app.id}
        </p>
      </div>

      {/* Version comparison */}
      <div className="shrink-0 flex items-center gap-2">
        <span className="text-[12px] font-mono text-zinc-500">{app.currentVersion}</span>
        <ArrowRight className="h-3 w-3 text-zinc-600" strokeWidth={2} />
        <span className="text-[12px] font-mono font-medium" style={{ color: severity.text }}>
          {app.availableVersion}
        </span>
      </div>

      {/* Source badge */}
      <span
        className="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium"
        style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
      >
        {app.source}
      </span>

      {/* Ignore button */}
      <button
        onClick={onIgnore}
        disabled={updating}
        title={t('softwareUpdater.ignoreButton')}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-zinc-500 transition-all hover:bg-white/5 hover:text-zinc-300 disabled:opacity-30 shrink-0"
        style={{ border: '1px solid var(--border-medium)' }}
      >
        <EyeOff className="h-3.5 w-3.5" strokeWidth={1.8} />
      </button>

      {/* Update button */}
      <button
        onClick={onUpdate}
        disabled={updating}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium text-green-400 transition-all hover:bg-green-500/10 disabled:opacity-30 shrink-0"
        style={{ border: '1px solid rgba(34,197,94,0.15)' }}
      >
        <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
        {t('softwareUpdater.updateButton')}
      </button>
    </div>
  )
}

function IgnoredRow({ app, onUnignore }: { app: UpdatableApp; onUnignore: () => void }) {
  const { t } = useTranslation('updates')
  const base = SEVERITY_STYLES_BASE[app.severity]
  return (
    <div
      className="flex items-center gap-4 rounded-xl px-5 py-3"
      style={{
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border-subtle)',
        opacity: 0.7,
      }}
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ background: 'rgba(113,113,122,0.08)' }}
      >
        <EyeOff className="h-4 w-4 text-zinc-500" strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-[12px] font-medium text-zinc-400 truncate block">{app.name}</span>
        <span className="text-[10px] truncate block" style={{ color: 'var(--text-muted)' }}>
          {app.id}
        </span>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        <span className="text-[11px] font-mono text-zinc-600">{app.currentVersion}</span>
        <ArrowRight className="h-3 w-3 text-zinc-700" strokeWidth={2} />
        <span className="text-[11px] font-mono" style={{ color: base.text }}>
          {app.availableVersion}
        </span>
      </div>
      <button
        onClick={onUnignore}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium text-zinc-400 transition-all hover:bg-white/5 hover:text-zinc-200 shrink-0"
        style={{ border: '1px solid var(--border-medium)' }}
      >
        <Eye className="h-3.5 w-3.5" strokeWidth={1.8} />
        {t('softwareUpdater.unignoreButton')}
      </button>
    </div>
  )
}

function UpToDateRow({ app }: { app: UpToDateApp }) {
  const { t } = useTranslation('updates')
  return (
    <div
      className="flex items-center gap-4 rounded-xl px-5 py-3"
      style={{
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ background: 'rgba(34,197,94,0.08)' }}
      >
        <CheckCircle2 className="h-4 w-4 text-green-500" strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-[12px] font-medium text-zinc-400 truncate block">{app.name}</span>
        <span className="text-[10px] truncate block" style={{ color: 'var(--text-muted)' }}>
          {app.id}
        </span>
      </div>
      <span className="text-[11px] font-mono text-zinc-600 shrink-0">{app.version}</span>
      <span
        className="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium"
        style={{ background: 'rgba(34,197,94,0.06)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.1)' }}
      >
        {t('softwareUpdater.latestBadge')}
      </span>
    </div>
  )
}
