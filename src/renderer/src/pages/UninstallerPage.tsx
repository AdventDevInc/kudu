import { useState, useCallback, useEffect, useRef, useMemo, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Package,
  Search,
  Loader2,
  CheckCircle2,
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Trash2,
  RefreshCw,
  ArrowUpDown,
  ChevronDown,
  AlertTriangle,
  Clock,
  CheckSquare,
  Square,
  MinusSquare,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useHistoryStore } from '@/stores/history-store'
import { useStatsStore } from '@/stores/stats-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUninstallerStore, UNUSED_THRESHOLD_DAYS } from '@/stores/uninstaller-store'
import { formatBytes } from '@/lib/utils'
import type { InstalledProgram, UninstallProgress } from '@shared/types'

function formatDate(raw: string): string {
  if (!raw || raw.length !== 8) return ''
  const year = raw.substring(0, 4)
  const month = raw.substring(4, 6)
  const day = raw.substring(6, 8)
  return `${year}-${month}-${day}`
}

const UNUSED_THRESHOLD_MS = UNUSED_THRESHOLD_DAYS * 24 * 60 * 60 * 1000

function isUnused(prog: InstalledProgram): boolean {
  if (prog.lastUsed === -1) return false // unknown (Prefetch unavailable)
  if (prog.lastUsed === 0) return true // Prefetch available but never seen
  return Date.now() - prog.lastUsed > UNUSED_THRESHOLD_MS
}

function formatLastUsed(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (ts <= 0) return t('lastUsedNeverDetected')
  const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000))
  if (days === 0) return t('lastUsedToday')
  if (days === 1) return t('lastUsedYesterday')
  if (days < 30) return t('lastUsedDaysAgo', { days })
  const months = Math.floor(days / 30)
  if (months < 12) return t('lastUsedMonthsAgo', { months })
  const years = Math.floor(months / 12)
  return t('lastUsedYearsAgo', { years })
}

const SORT_LABEL_KEYS: Record<string, string> = {
  displayName: 'sortByName',
  estimatedSize: 'sortBySize',
  installDate: 'sortByDate',
  publisher: 'sortByPublisher',
  safety: 'sortBySafety',
}

function safetyScoreColor(score: number): { bg: string; text: string } {
  if (score >= 8) return { bg: 'rgba(34,197,94,0.10)', text: '#22c55e' }
  if (score >= 5) return { bg: 'rgba(245,158,11,0.10)', text: '#f59e0b' }
  if (score >= 3) return { bg: 'rgba(249,115,22,0.10)', text: '#f97316' }
  return { bg: 'rgba(239,68,68,0.10)', text: '#ef4444' }
}

function safetyIcon(score: number) {
  if (score >= 8) return ShieldCheck
  if (score >= 5) return Shield
  return ShieldAlert
}

function SafetyTooltip({ children, text }: { children: React.ReactNode; text: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-[11px] font-medium pointer-events-none z-50 shadow-lg"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
        >
          {text}
          <div
            className="absolute top-full left-1/2 -translate-x-1/2 -mt-px w-0 h-0"
            style={{ borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '5px solid var(--border-strong)' }}
          />
        </div>
      )}
    </div>
  )
}

export function UninstallerPage() {
  const { t } = useTranslation('uninstaller')
  const programs = useUninstallerStore((s) => s.programs)
  const loading = useUninstallerStore((s) => s.loading)
  const uninstalling = useUninstallerStore((s) => s.uninstalling)
  const progress = useUninstallerStore((s) => s.progress)
  const uninstallResult = useUninstallerStore((s) => s.uninstallResult)
  const error = useUninstallerStore((s) => s.error)
  const hasLoaded = useUninstallerStore((s) => s.hasLoaded)
  const searchQuery = useUninstallerStore((s) => s.searchQuery)
  const sortField = useUninstallerStore((s) => s.sortField)
  const sortDirection = useUninstallerStore((s) => s.sortDirection)
  const filterMode = useUninstallerStore((s) => s.filterMode)

  const selectedIds = useUninstallerStore((s) => s.selectedIds)
  const safetyRatings = useUninstallerStore((s) => s.safetyRatings)
  const safetyLoading = useUninstallerStore((s) => s.safetyLoading)
  const expandedItemId = useUninstallerStore((s) => s.expandedItemId)
  const isCloudLinked = !!useSettingsStore((s) => s.settings.cloud.apiKey)

  const [confirmProgram, setConfirmProgram] = useState<InstalledProgram | null>(null)
  const [confirmBatch, setConfirmBatch] = useState(false)
  const [showSortMenu, setShowSortMenu] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const uninstallStartRef = useRef<number>(0)
  const historyStore = useHistoryStore()
  const recomputeStats = useStatsStore((s) => s.recompute)

  // Listen for progress events
  useEffect(() => {
    const cleanup = window.kudu.onUninstallerProgress((data: UninstallProgress) => {
      useUninstallerStore.getState().setProgress(data)
    })
    return () => { cleanup() }
  }, [])

  // Auto-load on first visit
  useEffect(() => {
    if (!hasLoaded && !loading) handleLoad()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch safety ratings when cloud is linked and programs are loaded
  useEffect(() => {
    if (isCloudLinked && hasLoaded && Object.keys(safetyRatings).length === 0) {
      useUninstallerStore.getState().fetchSafetyRatings()
    }
  }, [isCloudLinked, hasLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close sort menu on click outside
  useEffect(() => {
    if (!showSortMenu) return
    const handler = (e: globalThis.MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setShowSortMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSortMenu])

  // ─── Load programs ─────────────────────────────────────────
  const handleLoad = useCallback(async () => {
    const store = useUninstallerStore.getState()
    store.setLoading(true)
    store.setError(null)
    store.setUninstallResult(null)
    store.setExpandedItemId(null)

    try {
      const result = await window.kudu.uninstallerList()
      const s = useUninstallerStore.getState()
      s.setPrograms(result.programs)
      s.setHasLoaded(true)
      if (isCloudLinked) s.fetchSafetyRatings()
    } catch (err) {
      console.error('Failed to list programs:', err)
      toast.error(t('failedToLoadToast'))
      useUninstallerStore.getState().setError(t('failedToLoadError'))
    } finally {
      useUninstallerStore.getState().setLoading(false)
    }
  }, [isCloudLinked])

  // ─── Uninstall a program ──────────────────────────────────
  const handleUninstall = useCallback(async () => {
    if (!confirmProgram) return
    const program = confirmProgram
    setConfirmProgram(null)

    const store = useUninstallerStore.getState()
    store.setUninstalling(true)
    store.setUninstallResult(null)
    store.setError(null)
    store.setProgress(null)
    uninstallStartRef.current = Date.now()

    try {
      const result = await window.kudu.uninstallerUninstall(program.id)
      const s = useUninstallerStore.getState()
      s.setUninstallResult(result)
      s.setProgress(null)

      if (result.success) {
        // Remove from list
        s.removeProgram(program.id)

        // Record in history if leftovers were cleaned
        if (result.leftoversCleaned > 0) {
          await historyStore.addEntry({
            id: Date.now().toString(),
            type: 'cleaner',
            timestamp: new Date().toISOString(),
            duration: Date.now() - uninstallStartRef.current,
            totalItemsFound: result.leftoversFound,
            totalItemsCleaned: result.leftoversCleaned,
            totalItemsSkipped: result.leftoversFound - result.leftoversCleaned,
            totalSpaceSaved: result.leftoversSize,
            categories: [
              {
                name: `Uninstall: ${result.programName}`,
                itemsFound: result.leftoversFound,
                itemsCleaned: result.leftoversCleaned,
                spaceSaved: result.leftoversSize,
              },
            ],
            errorCount: 0,
          })
          recomputeStats()
        }
      }
    } catch (err) {
      console.error('Uninstall failed:', err)
      toast.error(t('uninstallFailedToast'))
      useUninstallerStore.getState().setError(t('uninstallFailedError'))
    } finally {
      useUninstallerStore.getState().setUninstalling(false)
    }
  }, [confirmProgram, historyStore, recomputeStats])

  // ─── Batch uninstall selected programs ─────────────────────
  const handleBatchUninstall = useCallback(async () => {
    setConfirmBatch(false)
    const store = useUninstallerStore.getState()
    const toUninstall = store.programs.filter((p) => store.selectedIds.has(p.id))
    if (toUninstall.length === 0) return

    store.setUninstalling(true)
    store.setUninstallResult(null)
    store.setError(null)
    store.setProgress(null)
    uninstallStartRef.current = Date.now()

    let successCount = 0
    let failCount = 0
    let totalLeftoversCleaned = 0
    let totalLeftoversSize = 0

    for (const program of toUninstall) {
      try {
        const result = await window.kudu.uninstallerUninstall(program.id)
        const s = useUninstallerStore.getState()

        if (result.success) {
          successCount++
          s.removeProgram(program.id)
          totalLeftoversCleaned += result.leftoversCleaned
          totalLeftoversSize += result.leftoversSize

          if (result.leftoversCleaned > 0) {
            await historyStore.addEntry({
              id: Date.now().toString(),
              type: 'cleaner',
              timestamp: new Date().toISOString(),
              duration: Date.now() - uninstallStartRef.current,
              totalItemsFound: result.leftoversFound,
              totalItemsCleaned: result.leftoversCleaned,
              totalItemsSkipped: result.leftoversFound - result.leftoversCleaned,
              totalSpaceSaved: result.leftoversSize,
              categories: [
                {
                  name: `Uninstall: ${result.programName}`,
                  itemsFound: result.leftoversFound,
                  itemsCleaned: result.leftoversCleaned,
                  spaceSaved: result.leftoversSize,
                },
              ],
              errorCount: 0,
            })
          }
        } else {
          failCount++
        }
      } catch {
        failCount++
      }
    }

    const s = useUninstallerStore.getState()
    s.clearSelected()
    s.setProgress(null)
    s.setUninstalling(false)

    if (failCount === 0) {
      s.setUninstallResult({
        success: true,
        programName: successCount !== 1 ? t('batchResultProgramsPlural', { count: successCount }) : t('batchResultProgramsSingular', { count: successCount }),
        exitCode: null,
        leftoversFound: totalLeftoversCleaned,
        leftoversCleaned: totalLeftoversCleaned,
        leftoversSize: totalLeftoversSize,
      })
    } else {
      s.setUninstallResult({
        success: successCount > 0,
        programName: (successCount + failCount) !== 1 ? t('batchResultProgramsPlural', { count: successCount + failCount }) : t('batchResultProgramsSingular', { count: successCount + failCount }),
        exitCode: null,
        error: t('batchResultFailedSucceeded', { failed: failCount, succeeded: successCount }),
        leftoversFound: totalLeftoversCleaned,
        leftoversCleaned: totalLeftoversCleaned,
        leftoversSize: totalLeftoversSize,
      })
    }

    if (successCount > 0) recomputeStats()
  }, [historyStore, recomputeStats])

  // ─── Filtered & sorted list ───────────────────────────────
  const filteredPrograms = useMemo(() => {
    let list = programs

    // Filter by unused
    if (filterMode === 'unused') {
      list = list.filter(isUnused)
    }

    // Filter by search
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (p) =>
          p.displayName.toLowerCase().includes(q) ||
          p.publisher.toLowerCase().includes(q),
      )
    }

    const dir = sortDirection === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      switch (sortField) {
        case 'estimatedSize':
          return (a.estimatedSize - b.estimatedSize) * dir
        case 'installDate':
          return a.installDate.localeCompare(b.installDate) * dir
        case 'publisher':
          return a.publisher.localeCompare(b.publisher) * dir
        case 'safety': {
          const sa = safetyRatings[a.displayName]?.safetyScore ?? 99
          const sb = safetyRatings[b.displayName]?.safetyScore ?? 99
          return (sa - sb) * dir
        }
        default:
          return a.displayName.localeCompare(b.displayName) * dir
      }
    })
  }, [programs, searchQuery, sortField, sortDirection, filterMode, safetyRatings])

  // Unused stats — only meaningful when Prefetch data is available
  const hasPrefetchData = useMemo(() => programs.some((p) => p.lastUsed !== -1), [programs])
  const unusedPrograms = useMemo(() => programs.filter(isUnused), [programs])
  const unusedTotalSize = useMemo(
    () => unusedPrograms.reduce((sum, p) => sum + p.estimatedSize, 0),
    [unusedPrograms],
  )

  const isBusy = loading || uninstalling

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
      />

      {/* Actions */}
      <div className="mb-5 flex items-center gap-2.5">
        <button
          onClick={handleLoad}
          disabled={isBusy}
          className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-medium text-zinc-300 transition-all disabled:opacity-40"
          style={{
            background: 'var(--bg-hover)',
            border: '1px solid var(--border-medium)',
          }}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
          ) : (
            <RefreshCw className="h-4 w-4" strokeWidth={1.8} />
          )}
          {loading ? t('loading') : hasLoaded ? t('refresh') : t('loadPrograms')}
        </button>

        {/* Filter tabs — only show when Prefetch data is available */}
        {hasLoaded && hasPrefetchData && (
          <div
            className="flex rounded-xl overflow-hidden"
            style={{ border: '1px solid var(--border-medium)' }}
          >
            <button
              onClick={() => useUninstallerStore.getState().setFilterMode('all')}
              className="px-4 py-2.5 text-[12px] font-medium transition-colors"
              style={{
                background: filterMode === 'all' ? 'var(--bg-active)' : 'var(--bg-subtle)',
                color: filterMode === 'all' ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              {t('filterAll', { count: programs.length })}
            </button>
            <button
              onClick={() => useUninstallerStore.getState().setFilterMode('unused')}
              className="flex items-center gap-1.5 px-4 py-2.5 text-[12px] font-medium transition-colors"
              style={{
                background: filterMode === 'unused' ? 'rgba(245,158,11,0.1)' : 'var(--bg-subtle)',
                color: filterMode === 'unused' ? 'var(--accent-hover)' : 'var(--text-muted)',
                borderLeft: '1px solid var(--border-medium)',
              }}
            >
              <AlertTriangle className="h-3 w-3" strokeWidth={2} />
              {t('filterUnused', { count: unusedPrograms.length })}
            </button>
          </div>
        )}

        {/* Search */}
        {hasLoaded && (
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
              onChange={(e) => useUninstallerStore.getState().setSearchQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="bg-transparent text-[13px] text-zinc-300 placeholder-zinc-600 outline-none w-48"
            />
          </div>
        )}

        {/* Sort */}
        {hasLoaded && (
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
                style={{ background: '#1e1e22', border: '1px solid var(--border-strong)', minWidth: 140 }}
              >
                {Object.entries(SORT_LABEL_KEYS).map(([field, labelKey]) => (
                  <button
                    key={field}
                    onClick={() => {
                      const store = useUninstallerStore.getState()
                      if (sortField === field) {
                        store.setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                      } else {
                        store.setSortField(field as any)
                        store.setSortDirection(field === 'estimatedSize' ? 'desc' : 'asc')
                      }
                      setShowSortMenu(false)
                    }}
                    className="flex w-full items-center gap-2 px-4 py-2 text-[12px] text-zinc-300 hover:bg-white/5 transition-colors"
                  >
                    {t(labelKey)}
                    {sortField === field && (
                      <span className="ml-auto text-amber-400 text-[10px]">
                        {sortDirection === 'asc' ? t('sortAscending') : t('sortDescending')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Uninstall Selected */}
        {hasLoaded && selectedIds.size > 0 && (
          <button
            onClick={() => setConfirmBatch(true)}
            disabled={uninstalling}
            className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium text-red-400 transition-all disabled:opacity-30"
            style={{
              background: 'rgba(239,68,68,0.06)',
              border: '1px solid rgba(239,68,68,0.15)',
            }}
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.8} />
            {t('uninstallSelected', { count: selectedIds.size })}
          </button>
        )}
      </div>

      {/* Unused recommendation banner */}
      {hasLoaded && !loading && hasPrefetchData && unusedPrograms.length > 0 && filterMode === 'all' && (
        <div
          className="mb-5 flex items-center justify-between rounded-2xl px-5 py-4 cursor-pointer transition-colors hover:border-amber-500/20"
          style={{
            background: 'rgba(245,158,11,0.04)',
            border: '1px solid var(--accent-muted-bg)',
          }}
          onClick={() => useUninstallerStore.getState().setFilterMode('unused')}
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" strokeWidth={1.8} />
            <div>
              <p className="text-[13px] font-medium text-zinc-200">
                {unusedPrograms.length !== 1
                  ? t('unusedBannerTitlePlural', { count: unusedPrograms.length, days: UNUSED_THRESHOLD_DAYS })
                  : t('unusedBannerTitle', { count: unusedPrograms.length, days: UNUSED_THRESHOLD_DAYS })}
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {unusedTotalSize > 0
                  ? t('unusedBannerDescriptionWithSize', { size: formatBytes(unusedTotalSize) })
                  : t('unusedBannerDescriptionNoSize')}
              </p>
            </div>
          </div>
          <span
            className="rounded-full px-3 py-1 text-[11px] font-medium"
            style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--accent-hover)' }}
          >
            {t('unusedBannerViewButton')}
          </span>
        </div>
      )}

      {/* Info banner */}
      <div
        className="mb-5 flex items-center gap-3 rounded-2xl px-5 py-4"
        style={{
          background: 'rgba(245,158,11,0.04)',
          border: '1px solid rgba(245,158,11,0.08)',
        }}
      >
        <Shield className="h-5 w-5 shrink-0 text-amber-500" strokeWidth={1.8} />
        <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          <span className="font-semibold text-amber-500">{t('safeUninstallLabel')}</span> — {t('safeUninstallDescription')}
        </p>
      </div>

      {/* Errors */}
      {error && (
        <ErrorAlert
          message={error}
          onDismiss={() => useUninstallerStore.getState().setError(null)}
          className="mb-5"
        />
      )}

      {/* Uninstall progress */}
      {uninstalling && progress && (
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
                {progress.phase === 'uninstalling'
                  ? t('progressUninstalling', { programName: progress.currentProgram })
                  : progress.phase === 'scanning-leftovers'
                    ? t('progressScanningLeftovers')
                    : progress.phase === 'cleaning-leftovers'
                      ? t('progressCleaningLeftovers')
                      : t('progressLoading')}
              </span>
            </div>
            <span className="text-[12px] font-mono" style={{ color: 'var(--text-muted)' }}>
              {progress.progress}%
            </span>
          </div>
          <div
            className="h-1.5 w-full rounded-full overflow-hidden"
            style={{ background: 'var(--bg-hover-2)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${progress.progress}%`,
                background: 'linear-gradient(90deg, #f59e0b 0%, #fbbf24 100%)',
              }}
            />
          </div>
          <p className="mt-2 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
            {progress.detail}
          </p>
        </div>
      )}

      {/* Uninstall result */}
      {uninstallResult && (
        <div
          className="mb-5 flex items-center gap-3 rounded-2xl p-4"
          style={{
            background: uninstallResult.success
              ? 'rgba(34,197,94,0.06)'
              : 'rgba(239,68,68,0.06)',
            border: `1px solid ${uninstallResult.success ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)'}`,
          }}
        >
          {uninstallResult.success ? (
            <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" strokeWidth={1.8} />
          ) : (
            <Shield className="h-5 w-5 text-red-500 shrink-0" strokeWidth={1.8} />
          )}
          <div className="text-[13px] text-zinc-200">
            {uninstallResult.success ? (
              <p>
                {t('successfullyUninstalled')}{' '}
                <span className="font-medium">{uninstallResult.programName}</span>
                {uninstallResult.leftoversCleaned > 0 && (
                  <span className="text-green-400">
                    {' '}
                    — {uninstallResult.leftoversCleaned !== 1
                      ? t('leftoversCleanedPlural', { count: uninstallResult.leftoversCleaned, size: formatBytes(uninstallResult.leftoversSize) })
                      : t('leftoversCleaned', { count: uninstallResult.leftoversCleaned, size: formatBytes(uninstallResult.leftoversSize) })}
                  </span>
                )}
                {uninstallResult.leftoversFound === 0 && (
                  <span style={{ color: 'var(--text-muted)' }}> — {t('noLeftoverFilesFound')}</span>
                )}
              </p>
            ) : (
              <p>
                {t('failedToUninstall')}{' '}
                <span className="font-medium">{uninstallResult.programName}</span>
                {uninstallResult.error && (
                  <span style={{ color: 'var(--text-muted)' }}> — {uninstallResult.error}</span>
                )}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!hasLoaded && !loading && (
        <EmptyState
          icon={Package}
          title={t('emptyStateTitle')}
          description={t('emptyStateDescription')}
          action={
            <button
              onClick={handleLoad}
              disabled={isBusy}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40"
              style={{
                background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                color: 'var(--text-on-accent)',
              }}
            >
              <Search className="h-4 w-4" strokeWidth={1.8} />
              {t('loadPrograms')}
            </button>
          }
        />
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 className="h-10 w-10 animate-spin text-amber-400 mb-4" strokeWidth={1.5} />
          <p className="text-[13px] text-zinc-400">{t('loadingInstalledPrograms')}</p>
        </div>
      )}

      {/* Program list */}
      {hasLoaded && !loading && filteredPrograms.length === 0 && programs.length > 0 && (
        <div className="flex flex-col items-center justify-center py-16">
          <Search className="h-10 w-10 text-zinc-600 mb-4" strokeWidth={1.5} />
          <p className="text-[13px] text-zinc-400">
            {filterMode === 'unused' ? t('noUnusedProgramsFound') : t('noProgramsMatchSearch')}
          </p>
        </div>
      )}

      {hasLoaded && !loading && programs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16">
          <CheckCircle2 className="h-10 w-10 text-green-500 mb-4" strokeWidth={1.5} />
          <p className="text-[13px] text-zinc-400">{t('noInstalledProgramsFound')}</p>
        </div>
      )}

      {hasLoaded && !loading && filteredPrograms.length > 0 && (
        <div className="mb-6">
          <div className="mb-3 flex items-center gap-2.5">
            <button
              onClick={() => {
                const store = useUninstallerStore.getState()
                const allFilteredIds = filteredPrograms.map((p) => p.id)
                const allSelected = allFilteredIds.every((id) => selectedIds.has(id))
                if (allSelected) {
                  store.clearSelected()
                } else {
                  store.selectAll(allFilteredIds)
                }
              }}
              disabled={uninstalling}
              className="text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-30"
              title={filteredPrograms.every((p) => selectedIds.has(p.id)) ? t('deselectAll') : t('selectAll')}
            >
              {filteredPrograms.length > 0 && filteredPrograms.every((p) => selectedIds.has(p.id)) ? (
                <CheckSquare className="h-4.5 w-4.5 text-amber-400" strokeWidth={1.8} />
              ) : filteredPrograms.some((p) => selectedIds.has(p.id)) ? (
                <MinusSquare className="h-4.5 w-4.5 text-amber-400" strokeWidth={1.8} />
              ) : (
                <Square className="h-4.5 w-4.5" strokeWidth={1.8} />
              )}
            </button>
            {filterMode === 'unused' ? (
              <AlertTriangle className="h-4.5 w-4.5 text-amber-400" strokeWidth={1.8} />
            ) : (
              <Package className="h-4.5 w-4.5 text-amber-400" strokeWidth={1.8} />
            )}
            <span className="text-[13px] font-semibold text-zinc-200">
              {filterMode === 'unused' ? t('unusedProgramsHeading') : t('installedProgramsHeading')}{' '}
              {searchQuery
                ? t('programCount', { filtered: filteredPrograms.length, total: filterMode === 'unused' ? unusedPrograms.length : programs.length })
                : `(${filteredPrograms.length})`}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {filteredPrograms.map((prog) => {
              const unused = isUnused(prog)
              const isSelected = selectedIds.has(prog.id)
              const rating = safetyRatings[prog.displayName]
              const isExpanded = expandedItemId === prog.id
              return (
                <Fragment key={prog.id}>
                  <div
                    className="flex items-center gap-4 rounded-2xl px-5 py-4 transition-colors"
                    style={{
                      background: isSelected
                        ? 'var(--accent-muted-bg)'
                        : unused ? 'rgba(245,158,11,0.03)' : 'var(--bg-subtle)',
                      border: `1px solid ${isSelected ? 'var(--accent-muted-border)' : unused ? 'var(--accent-muted-bg)' : 'var(--border-subtle)'}`,
                    }}
                  >
                    <button
                      onClick={() => useUninstallerStore.getState().toggleSelected(prog.id)}
                      disabled={uninstalling}
                      className="shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-30"
                    >
                      {isSelected ? (
                        <CheckSquare className="h-5 w-5 text-amber-400" strokeWidth={1.8} />
                      ) : (
                        <Square className="h-5 w-5" strokeWidth={1.8} />
                      )}
                    </button>
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: unused ? 'rgba(245,158,11,0.1)' : 'rgba(139,92,246,0.1)' }}
                    >
                      {unused ? (
                        <AlertTriangle className="h-5 w-5" style={{ color: 'var(--accent)' }} strokeWidth={1.8} />
                      ) : (
                        <Package className="h-5 w-5" style={{ color: '#a78bfa' }} strokeWidth={1.8} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span className="text-[13px] font-medium text-zinc-200 truncate">
                          {prog.displayName}
                        </span>
                        {prog.displayVersion && (
                          <span
                            className="rounded-md px-2 py-0.5 text-[10px] font-medium shrink-0"
                            style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
                          >
                            v{prog.displayVersion}
                          </span>
                        )}
                        {unused && (
                          <span
                            className="rounded-md px-2 py-0.5 text-[10px] font-medium shrink-0"
                            style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--accent-hover)' }}
                          >
                            {t('unusedBadge')}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-3">
                        <p className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                          {prog.publisher || t('unknownPublisher')}
                          {prog.installDate ? ` — ${formatDate(prog.installDate)}` : ''}
                        </p>
                        {prog.lastUsed > 0 && (
                          <span className="flex items-center gap-1 text-[10px] shrink-0" style={{ color: unused ? 'var(--accent)' : 'var(--text-muted)' }}>
                            <Clock className="h-3 w-3" strokeWidth={1.8} />
                            {formatLastUsed(prog.lastUsed, t)}
                          </span>
                        )}
                        {prog.lastUsed === 0 && filterMode === 'unused' && (
                          <span className="flex items-center gap-1 text-[10px] shrink-0" style={{ color: 'var(--accent)' }}>
                            <Clock className="h-3 w-3" strokeWidth={1.8} />
                            {t('lastUsedNeverDetected')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-4">
                      {/* Safety badge */}
                      {isCloudLinked ? (
                        rating ? (() => {
                          const colors = safetyScoreColor(rating.safetyScore)
                          const Icon = safetyIcon(rating.safetyScore)
                          const tooltipKey = rating.safetyScore >= 8 ? 'safetyTooltipSafe'
                            : rating.safetyScore >= 5 ? 'safetyTooltipCaution'
                            : rating.safetyScore >= 3 ? 'safetyTooltipWarning'
                            : 'safetyTooltipDanger'
                          return (
                            <SafetyTooltip text={t(tooltipKey)}>
                              <button
                                onClick={() => useUninstallerStore.getState().setExpandedItemId(isExpanded ? null : prog.id)}
                                className="flex h-9 w-9 items-center justify-center rounded-xl transition-all hover:scale-110"
                                style={{ background: colors.bg }}
                              >
                                <Icon className="h-4.5 w-4.5" style={{ color: colors.text }} strokeWidth={1.8} />
                              </button>
                            </SafetyTooltip>
                          )
                        })() : (
                          <SafetyTooltip text={t(safetyLoading ? 'safetyTooltipPending' : 'safetyPending')}>
                            <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: 'var(--bg-hover)' }}>
                              {safetyLoading ? (
                                <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--text-muted)' }} strokeWidth={1.8} />
                              ) : (
                                <Shield className="h-4.5 w-4.5" style={{ color: 'var(--text-muted)', opacity: 0.5 }} strokeWidth={1.8} />
                              )}
                            </div>
                          </SafetyTooltip>
                        )
                      ) : (
                        <SafetyTooltip text={t('safetyTooltipLocked')}>
                          <button
                            onClick={() => toast.info(t('safetyLinkCloud'))}
                            className="flex h-9 w-9 items-center justify-center rounded-xl transition-all hover:scale-110"
                            style={{ background: 'var(--bg-hover)' }}
                          >
                            <ShieldOff className="h-4.5 w-4.5" style={{ color: 'var(--text-muted)', opacity: 0.3 }} strokeWidth={1.8} />
                          </button>
                        </SafetyTooltip>
                      )}
                      <div className="text-right">
                        <span className="text-[12px] font-medium text-zinc-400">
                          {formatBytes(prog.estimatedSize)}
                        </span>
                      </div>
                      <button
                        onClick={() => setConfirmProgram(prog)}
                        disabled={uninstalling}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium text-red-400 transition-all hover:bg-red-500/10 disabled:opacity-30"
                        style={{ border: '1px solid rgba(239,68,68,0.15)' }}
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                        {t('uninstallButton')}
                      </button>
                    </div>
                  </div>

                  {/* Expanded safety detail panel */}
                  {isExpanded && rating && (() => {
                    const colors = safetyScoreColor(rating.safetyScore)
                    const DetailIcon = safetyIcon(rating.safetyScore)
                    return (
                      <div
                        className="flex items-start gap-3 rounded-2xl px-5 py-4 -mt-1 animate-fade-in"
                        style={{ background: colors.bg, border: `1px solid ${colors.text}22` }}
                      >
                        <div
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                          style={{ background: colors.text + '20' }}
                        >
                          <DetailIcon className="h-5 w-5" style={{ color: colors.text }} strokeWidth={1.8} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-semibold" style={{ color: colors.text }}>
                            {t('safetyScore', { score: rating.safetyScore })}
                          </p>
                          {rating.description && (
                            <p className="mt-1 text-[12px] text-zinc-300 leading-relaxed">
                              {rating.description}
                            </p>
                          )}
                          {rating.analyzedAt && (
                            <p className="mt-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {t('safetyAnalyzed', { date: new Date(rating.analyzedAt).toLocaleDateString() })}
                            </p>
                          )}
                        </div>
                      </div>
                    )
                  })()}
                </Fragment>
              )
            })}
          </div>
        </div>
      )}

      {/* Confirm dialog — single */}
      <ConfirmDialog
        open={!!confirmProgram}
        onConfirm={handleUninstall}
        onCancel={() => setConfirmProgram(null)}
        title={t('confirmUninstallTitle', { programName: confirmProgram?.displayName ?? '' })}
        description={t('confirmUninstallDescription')}
        confirmLabel={t('confirmUninstallLabel')}
        variant="danger"
      />

      {/* Confirm dialog — batch */}
      <ConfirmDialog
        open={confirmBatch}
        onConfirm={handleBatchUninstall}
        onCancel={() => setConfirmBatch(false)}
        title={selectedIds.size !== 1 ? t('confirmBatchTitlePlural', { count: selectedIds.size }) : t('confirmBatchTitle', { count: selectedIds.size })}
        description={t('confirmBatchDescription')}
        details={programs
          .filter((p) => selectedIds.has(p.id))
          .map((p) => p.displayName)
          .join(', ')}
        confirmLabel={t('confirmBatchLabel', { count: selectedIds.size })}
        variant="danger"
      />
    </div>
  )
}
