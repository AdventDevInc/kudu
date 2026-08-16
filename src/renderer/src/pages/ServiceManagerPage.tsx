import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Server,
  Search,
  Shield,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Circle,
  Link2,
  Play
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useServiceStore } from '@/stores/service-store'
import { useHistoryStore } from '@/stores/history-store'
import type { ServiceScanProgress, WindowsService, ServiceCategory } from '@shared/types'

const SAFETY_COLORS = {
  safe: { dot: 'var(--success)', bg: 'color-mix(in srgb, var(--success), transparent 91%)', border: 'color-mix(in srgb, var(--success), transparent 74%)' },
  caution: { dot: 'var(--warning)', bg: 'color-mix(in srgb, var(--warning), transparent 91%)', border: 'color-mix(in srgb, var(--warning), transparent 74%)' },
  unsafe: { dot: 'var(--danger)', bg: 'color-mix(in srgb, var(--danger), transparent 91%)', border: 'color-mix(in srgb, var(--danger), transparent 74%)' }
} as const

const STATUS_COLORS: Record<string, string> = {
  Running: 'var(--success)',
  Stopped: 'var(--text-secondary)',
  StartPending: 'var(--warning)',
  StopPending: 'var(--warning)',
  Paused: 'var(--warning)',
  Unknown: 'var(--text-muted)'
}

const START_TYPE_KEY_MAP: Record<string, string> = {
  Automatic: 'serviceManager.startTypeAutomatic',
  Manual: 'serviceManager.startTypeManual',
  Disabled: 'serviceManager.startTypeDisabled',
  Unknown: 'serviceManager.startTypeUnknown'
}

const STATUS_KEY_MAP: Record<string, string> = {
  Running: 'serviceManager.statusRunning',
  Stopped: 'serviceManager.statusStopped',
  Paused: 'serviceManager.statusPaused',
  StartPending: 'serviceManager.statusStartPending',
  StopPending: 'serviceManager.statusStopPending',
  Unknown: 'serviceManager.statusUnknown'
}

type ApplyMode = 'disable' | 'enable'

/** Selecting a disabled service means "restore it"; anything else means "disable it". */
function isTarget(svc: WindowsService, mode: ApplyMode): boolean {
  return mode === 'enable' ? svc.startType === 'Disabled' : svc.startType !== 'Disabled'
}

const CATEGORY_LABEL_KEYS: Record<ServiceCategory | 'all', string> = {
  all: 'serviceManager.filterAllCategories',
  telemetry: 'serviceManager.categoryTelemetry',
  xbox: 'serviceManager.categoryXbox',
  print: 'serviceManager.categoryPrint',
  fax: 'serviceManager.categoryFax',
  media: 'serviceManager.categoryMedia',
  network: 'serviceManager.categoryNetwork',
  bluetooth: 'serviceManager.categoryBluetooth',
  remote: 'serviceManager.categoryRemote',
  'hyper-v': 'serviceManager.categoryHyperV',
  developer: 'serviceManager.categoryDeveloper',
  misc: 'serviceManager.categoryMisc',
  core: 'serviceManager.categoryCore',
  security: 'serviceManager.categorySecurity',
  unknown: 'serviceManager.categoryOther'
}

export function ServiceManagerPage({ embedded }: { embedded?: boolean }) {
  const { t } = useTranslation('hardening')
  const services = useServiceStore((s) => s.services)
  const scanning = useServiceStore((s) => s.scanning)
  const applying = useServiceStore((s) => s.applying)
  const scanProgress = useServiceStore((s) => s.scanProgress)
  const applyResult = useServiceStore((s) => s.applyResult)
  const error = useServiceStore((s) => s.error)
  const hasScanned = useServiceStore((s) => s.hasScanned)
  const searchQuery = useServiceStore((s) => s.searchQuery)
  const safetyFilter = useServiceStore((s) => s.safetyFilter)
  const categoryFilter = useServiceStore((s) => s.categoryFilter)
  const statusFilter = useServiceStore((s) => s.statusFilter)
  const enableStartType = useServiceStore((s) => s.enableStartType)

  const [confirmMode, setConfirmMode] = useState<ApplyMode | null>(null)
  const [appliedMode, setAppliedMode] = useState<ApplyMode>('disable')
  const isBusy = scanning || applying

  // Listen for progress events
  useEffect(() => {
    const cleanup = window.kudu?.onServiceProgress?.((data: ServiceScanProgress) => {
      useServiceStore.getState().setScanProgress(data)
    })
    return () => { cleanup?.() }
  }, [])

  // ─── Scan ──────────────────────────────────────────────────
  const handleScan = useCallback(async () => {
    const store = useServiceStore.getState()
    store.setScanning(true)
    store.setServices([])
    store.setApplyResult(null)
    store.setError(null)
    store.setScanProgress(null)

    try {
      const result = await window.kudu.serviceScan()
      const s = useServiceStore.getState()
      s.setServices(result.services)
      s.setHasScanned(true)
    } catch (err) {
      toast.error(t('serviceManager.scanFailedToast'))
      useServiceStore
        .getState()
        .setError(err instanceof Error ? err.message : t('serviceManager.scanFailedError'))
    } finally {
      useServiceStore.getState().setScanning(false)
      useServiceStore.getState().setScanProgress(null)
    }
  }, [t])

  // Auto-scan on first visit
  useEffect(() => {
    if (!hasScanned && !scanning) handleScan()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Apply ─────────────────────────────────────────────────
  const handleApply = useCallback(async (mode: ApplyMode) => {
    setConfirmMode(null)
    const store = useServiceStore.getState()
    const selected = store.services.filter((s) => s.selected && isTarget(s, mode))
    if (selected.length === 0) return

    setAppliedMode(mode)
    store.setApplying(true)
    store.setApplyResult(null)
    store.setError(null)

    const startTime = Date.now()
    const targetStartType = mode === 'disable' ? 'Disabled' : store.enableStartType
    const changes = selected.map((s) => ({
      name: s.name,
      targetStartType
    }))

    try {
      const result = await window.kudu.serviceApply(changes)
      useServiceStore.getState().setApplyResult(result)
      if (result.succeeded > 0) {
        const key = mode === 'disable'
          ? (result.succeeded > 1 ? 'serviceManager.serviceDisabledToastPlural' : 'serviceManager.serviceDisabledToast')
          : (result.succeeded > 1 ? 'serviceManager.serviceEnabledToastPlural' : 'serviceManager.serviceEnabledToast')
        toast.success(t(key, { count: result.succeeded }))
      }
      if (result.failed > 0) toast.error(t(result.failed > 1 ? 'serviceManager.serviceFailedToastPlural' : 'serviceManager.serviceFailedToast', { count: result.failed }))

      // Re-scan to refresh state
      const scanResult = await window.kudu.serviceScan()
      useServiceStore.getState().setServices(scanResult.services)

      // Log to history
      const byCat: Record<string, { found: number; changed: number }> = {}
      for (const svc of selected) {
        const cat = svc.category
        if (!byCat[cat]) byCat[cat] = { found: 0, changed: 0 }
        byCat[cat].found++
        if (!result.errors.some(e => e.name === svc.name)) byCat[cat].changed++
      }
      await useHistoryStore.getState().addEntry({
        id: Date.now().toString(),
        type: 'services',
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        totalItemsFound: selected.length,
        totalItemsCleaned: result.succeeded,
        totalItemsSkipped: 0,
        totalSpaceSaved: 0,
        categories: Object.entries(byCat).map(([name, d]) => ({
          name, itemsFound: d.found, itemsCleaned: d.changed, spaceSaved: 0
        })),
        errorCount: result.failed
      })
    } catch (err) {
      toast.error(t('serviceManager.applyFailedToast'))
      useServiceStore
        .getState()
        .setError(err instanceof Error ? err.message : t('serviceManager.applyFailedError'))
    } finally {
      useServiceStore.getState().setApplying(false)
    }
  }, [t])

  const handleSelectRecommended = useCallback(() => {
    useServiceStore.getState().selectRecommended()
  }, [])

  // ─── Filtering ─────────────────────────────────────────────
  const filteredServices = useMemo(() => {
    let result = services

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.displayName.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)
      )
    }

    if (safetyFilter !== 'all') {
      result = result.filter((s) => s.safety === safetyFilter)
    }

    if (categoryFilter !== 'all') {
      result = result.filter((s) => s.category === categoryFilter)
    }

    if (statusFilter !== 'all') {
      if (statusFilter === 'running') result = result.filter((s) => s.status === 'Running')
      else if (statusFilter === 'stopped') result = result.filter((s) => s.status === 'Stopped')
      else if (statusFilter === 'disabled') result = result.filter((s) => s.startType === 'Disabled')
    }

    return result
  }, [services, searchQuery, safetyFilter, categoryFilter, statusFilter])

  // A selected service is either on its way to Disabled or on its way back —
  // which one depends only on where it is now.
  const disableCount = services.filter((s) => s.selected && isTarget(s, 'disable')).length
  const enableCount = services.filter((s) => s.selected && isTarget(s, 'enable')).length
  const totalSafeToDisable = services.filter(
    (s) => s.safety === 'safe' && s.startType !== 'Disabled'
  ).length
  const runningCount = services.filter((s) => s.status === 'Running').length
  const disabledCount = services.filter((s) => s.startType === 'Disabled').length

  // ─── Categories present in scan results ────────────────────
  const presentCategories = useMemo(() => {
    const cats = new Set<ServiceCategory>()
    for (const s of services) cats.add(s.category)
    return cats
  }, [services])

  // ─── Group by safety level ────────────────────────────────
  const safetyGroups = useMemo(() => {
    const groups: { key: 'safe' | 'caution' | 'unsafe'; label: string; services: typeof filteredServices }[] = [
      { key: 'safe', label: t('serviceManager.safeToDisableGroup'), services: filteredServices.filter((s) => s.safety === 'safe') },
      { key: 'caution', label: t('serviceManager.useCautionGroup'), services: filteredServices.filter((s) => s.safety === 'caution') },
      { key: 'unsafe', label: t('serviceManager.systemCriticalGroup'), services: filteredServices.filter((s) => s.safety === 'unsafe') }
    ]
    return groups.filter((g) => g.services.length > 0)
  }, [filteredServices, t])

  return (
    <div className={`service-manager-page ${embedded ? '' : 'px-8 py-8'}`}>
      {!embedded && (
        <PageHeader
          title={t('serviceManager.pageTitle')}
          description={t('serviceManager.pageDescription')}
        />
      )}

      {/* ── Action bar ───────────────────────────────────────── */}
      <div className="service-manager-actions mb-5 flex flex-wrap items-center gap-3">
        <button
          onClick={handleScan}
          disabled={isBusy}
          className="service-primary-action flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white transition-all"
          style={{
            background: 'var(--accent)',
            color: 'var(--text-on-accent)'
          }}
        >
          {scanning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" strokeWidth={2} />
          )}
          {scanning ? t('serviceManager.scanningButton') : t('serviceManager.scanServicesButton')}
        </button>

        {hasScanned && (
          <>
            <button
              onClick={handleSelectRecommended}
              disabled={isBusy || totalSafeToDisable === 0}
              className="service-recommended-action flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-all"
              style={{
                background: 'color-mix(in srgb, var(--success), transparent 88%)',
                color: 'var(--success)',
                border: '1px solid color-mix(in srgb, var(--success), transparent 68%)'
              }}
            >
              <Sparkles className="h-4 w-4" strokeWidth={2} />
              {t('serviceManager.applyRecommendedButton', { count: totalSafeToDisable })}
            </button>

            <button
              onClick={() => setConfirmMode('disable')}
              disabled={isBusy || disableCount === 0}
              className="service-danger-action flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white transition-all"
              style={{
                background: 'var(--danger)'
              }}
            >
              {applying && appliedMode === 'disable' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Shield className="h-4 w-4" strokeWidth={2} />
              )}
              {applying && appliedMode === 'disable'
                ? t('serviceManager.applyingButton')
                : t('serviceManager.disableSelectedButton', { count: disableCount })}
            </button>

            {enableCount > 0 && (
              <>
                <button
                  onClick={() => setConfirmMode('enable')}
                  disabled={isBusy}
                  className="service-info-action flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition-all"
                  style={{ background: 'var(--info)' }}
                >
                  {applying && appliedMode === 'enable' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" strokeWidth={2} />
                  )}
                  {applying && appliedMode === 'enable'
                    ? t('serviceManager.applyingButton')
                    : t('serviceManager.enableSelectedButton', { count: enableCount })}
                </button>

                <div title={t('serviceManager.enableStartTypeTitle')}>
                  <FilterDropdown
                    value={enableStartType}
                    ariaLabel={t('serviceManager.enableStartTypeTitle')}
                    options={[
                      { value: 'Manual', label: t('serviceManager.startTypeManual') },
                      { value: 'Automatic', label: t('serviceManager.startTypeAutomatic') }
                    ]}
                    onChange={(v) =>
                      useServiceStore.getState().setEnableStartType(v as 'Manual' | 'Automatic')
                    }
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* ── Info banner ──────────────────────────────────────── */}
      {hasScanned && !applyResult && (
        <div
          className="service-manager-guide mb-5 flex items-start gap-3 rounded-2xl px-5 py-4"
          style={{ background: 'var(--accent-muted-bg)', border: '1px solid color-mix(in srgb, var(--warning), transparent 72%)' }}
        >
          <Shield className="mt-0.5 h-5 w-5 shrink-0" style={{ color: 'var(--warning)' }} strokeWidth={2} />
          <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-semibold" style={{ color: 'var(--success)' }}>{t('serviceManager.infoBannerGreen')}</span> {t('serviceManager.infoBannerSafeToDisable')}{' '}
            <span className="font-semibold" style={{ color: 'var(--warning)' }}>{t('serviceManager.infoBannerAmber')}</span> {t('serviceManager.infoBannerMayAffect')}{' '}
            <span className="font-semibold" style={{ color: 'var(--danger)' }}>{t('serviceManager.infoBannerRed')}</span> {t('serviceManager.infoBannerSystemCritical')}
            {' '}{t('serviceManager.infoBannerUseRecommended')}
            {' '}{t('serviceManager.infoBannerReEnable')}
          </div>
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────── */}
      {error && (
        <ErrorAlert
          message={error}
          onDismiss={() => useServiceStore.getState().setError(null)}
          className="mb-5"
        />
      )}

      {/* ── Scan progress ────────────────────────────────────── */}
      {scanning && scanProgress && (
        <div
          className="mb-5 rounded-xl p-4"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)' }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {scanProgress.phase === 'enumerating' ? t('serviceManager.scanProgressEnumerating') : t('serviceManager.scanProgressClassifying')}
            </span>
            {scanProgress.total > 0 && (
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {scanProgress.current} / {scanProgress.total}
              </span>
            )}
          </div>
          {scanProgress.total > 0 && (
            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: '#27272a' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  background: 'var(--accent)',
                  width: `${Math.round((scanProgress.current / scanProgress.total) * 100)}%`
                }}
              />
            </div>
          )}
          <div className="mt-1.5 truncate text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {scanProgress.currentService}
          </div>
        </div>
      )}

      {/* ── Apply result ─────────────────────────────────────── */}
      {applyResult && (
        <div
          className="mb-5 rounded-xl p-4"
          style={{
            background: applyResult.failed > 0 ? 'rgba(245,158,11,0.06)' : 'rgba(34,197,94,0.06)',
            border: `1px solid ${applyResult.failed > 0 ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)'}`
          }}
        >
          <div className="flex items-center gap-2">
            {applyResult.failed > 0 ? (
              <AlertTriangle className="h-4 w-4" style={{ color: '#f59e0b' }} />
            ) : (
              <CheckCircle2 className="h-4 w-4" style={{ color: '#22c55e' }} />
            )}
            <span className="text-[13px] font-medium text-white">
              {t(
                appliedMode === 'enable'
                  ? (applyResult.succeeded !== 1 ? 'serviceManager.servicesEnabledPlural' : 'serviceManager.servicesEnabled')
                  : (applyResult.succeeded !== 1 ? 'serviceManager.servicesDisabledPlural' : 'serviceManager.servicesDisabled'),
                { count: applyResult.succeeded }
              )}
              {applyResult.failed > 0 && `, ${t('serviceManager.servicesFailed', { count: applyResult.failed })}`}
            </span>
          </div>
          {applyResult.errors.length > 0 && (
            <div className="mt-2 space-y-1">
              {applyResult.errors.map((e, i) => (
                <div key={i} className="text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
                  {e.displayName || e.name}: {e.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Empty state ──────────────────────────────────────── */}
      {!hasScanned && !scanning && (
        <EmptyState
          icon={Server}
          title={t('serviceManager.emptyStateTitle')}
          description={t('serviceManager.emptyStateDescription')}
          action={
            <button
              onClick={handleScan}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all"
              style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'var(--text-on-accent)' }}
            >
              <RefreshCw className="h-4 w-4" strokeWidth={1.8} />
              {t('serviceManager.scanServicesButton')}
            </button>
          }
        />
      )}

      {/* ── Stats row ────────────────────────────────────────── */}
      {hasScanned && !scanning && (
        <>
          <div className="service-stats-grid mb-5 grid grid-cols-4 gap-3">
            <StatCard label={t('serviceManager.statTotal')} value={services.length} tone="neutral" progress={100} />
            <StatCard label={t('serviceManager.statRunning')} value={runningCount} tone="success" progress={(runningCount / Math.max(services.length, 1)) * 100} />
            <StatCard label={t('serviceManager.statDisabled')} value={disabledCount} tone="brand" progress={(disabledCount / Math.max(services.length, 1)) * 100} />
            <StatCard label={t('serviceManager.statSafeToDisable')} value={totalSafeToDisable} tone="warning" progress={(totalSafeToDisable / Math.max(services.length, 1)) * 100} />
          </div>

          {/* ── Filter bar ─────────────────────────────────────── */}
          <div className="service-filter-bar mb-4 flex items-center gap-3">
            <div
              className="service-search-field flex flex-1 items-center gap-2 rounded-xl px-3.5 py-2.5"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)' }}
            >
              <Search className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} strokeWidth={1.8} />
              <input
                type="text"
                placeholder={t('serviceManager.searchPlaceholder')}
                aria-label={t('serviceManager.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => useServiceStore.getState().setSearchQuery(e.target.value)}
                className="w-full bg-transparent text-[13px] outline-none"
                style={{ color: 'var(--text-primary)' }}
              />
            </div>

            <FilterDropdown
              value={safetyFilter}
              ariaLabel={t('serviceManager.filterAllSafety')}
              options={[
                { value: 'all', label: t('serviceManager.filterAllSafety') },
                { value: 'safe', label: t('serviceManager.filterSafe') },
                { value: 'caution', label: t('serviceManager.filterCaution') },
                { value: 'unsafe', label: t('serviceManager.filterUnsafe') }
              ]}
              onChange={(v) => useServiceStore.getState().setSafetyFilter(v as any)}
            />

            <FilterDropdown
              value={categoryFilter}
              ariaLabel={t('serviceManager.filterAllCategories')}
              options={[
                { value: 'all', label: t('serviceManager.filterAllCategories') },
                ...Array.from(presentCategories)
                  .sort()
                  .map((c) => ({ value: c, label: t(CATEGORY_LABEL_KEYS[c]) || c }))
              ]}
              onChange={(v) => useServiceStore.getState().setCategoryFilter(v as any)}
            />

            <FilterDropdown
              value={statusFilter}
              ariaLabel={t('serviceManager.filterAllStatus')}
              options={[
                { value: 'all', label: t('serviceManager.filterAllStatus') },
                { value: 'running', label: t('serviceManager.filterRunning') },
                { value: 'stopped', label: t('serviceManager.filterStopped') },
                { value: 'disabled', label: t('serviceManager.filterDisabled') }
              ]}
              onChange={(v) => useServiceStore.getState().setStatusFilter(v as any)}
            />
          </div>

          {/* ── Service list (grouped by safety) ────────────────── */}
          {filteredServices.length === 0 ? (
            <div
              className="rounded-xl py-12 text-center text-[13px]"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', color: 'var(--text-muted)' }}
            >
              {t('serviceManager.noServicesMatch')}
            </div>
          ) : (
            <div className="service-groups space-y-4">
              {safetyGroups.map((group) => (
                <SafetyGroup key={group.key} safetyKey={group.key} label={group.label} services={group.services} />
              ))}
            </div>
          )}

          <div className="mt-3 text-right text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {t('serviceManager.showingCount', { filtered: filteredServices.length, total: services.length })}
          </div>
        </>
      )}

      {/* ── Confirm dialog ───────────────────────────────────── */}
      <ConfirmDialog
        open={confirmMode !== null}
        title={t(confirmMode === 'enable' ? 'serviceManager.confirmEnableTitle' : 'serviceManager.confirmTitle')}
        description={
          confirmMode === 'enable'
            ? t('serviceManager.confirmEnableDescription', {
                count: enableCount,
                startType: t(START_TYPE_KEY_MAP[enableStartType])
              })
            : t('serviceManager.confirmDescription', { count: disableCount })
        }
        confirmLabel={t(confirmMode === 'enable' ? 'serviceManager.confirmEnableLabel' : 'serviceManager.confirmLabel')}
        variant={confirmMode === 'enable' ? 'default' : 'danger'}
        onConfirm={() => handleApply(confirmMode ?? 'disable')}
        onCancel={() => setConfirmMode(null)}
      />
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────

function SafetyGroup({
  safetyKey,
  label,
  services
}: {
  safetyKey: 'safe' | 'caution' | 'unsafe'
  label: string
  services: WindowsService[]
}) {
  const { t } = useTranslation('hardening')
  const [collapsed, setCollapsed] = useState(false)
  const colors = SAFETY_COLORS[safetyKey]
  const selectedInGroup = services.filter((s) => s.selected).length
  const alreadyDisabled = services.filter((s) => s.startType === 'Disabled').length

  return (
    <div
      className="service-safety-group overflow-hidden rounded-2xl"
      data-safety={safetyKey}
      style={{ background: 'var(--card-bg)', border: `1px solid ${colors.border}` }}
    >
      {/* Group header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="service-group-header flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors"
        style={{ background: colors.bg }}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0" style={{ color: colors.dot }} strokeWidth={2} />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0" style={{ color: colors.dot }} strokeWidth={2} />
        )}
        <Circle className="h-2.5 w-2.5 shrink-0" fill={colors.dot} stroke="none" />
        <span className="text-[14px] font-bold" style={{ color: colors.dot }}>
          {label}
        </span>
        <span className="service-group-count rounded-full px-2.5 py-1 text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t(services.length !== 1 ? 'serviceManager.servicesCountPlural' : 'serviceManager.servicesCount', { count: services.length })}
          {alreadyDisabled > 0 && ` · ${t('serviceManager.alreadyDisabled', { count: alreadyDisabled })}`}
          {selectedInGroup > 0 && (
            <span style={{ color: colors.dot }}> · {t('serviceManager.selectedCount', { count: selectedInGroup })}</span>
          )}
        </span>
      </button>

      {!collapsed && (
        <>
          {/* Column header */}
          <div
            className="service-column-header grid items-center gap-3 px-5 py-2.5 text-[11px] font-bold uppercase tracking-wider"
            style={{
              gridTemplateColumns: '32px minmax(240px, 1fr) 132px 110px 64px',
              color: 'var(--text-muted)',
              borderTop: `1px solid ${colors.border}`,
              borderBottom: '1px solid var(--border-subtle)'
            }}
          >
            <span />
            <span>{t('serviceManager.columnService')}</span>
            <span>{t('serviceManager.columnStartupType')}</span>
            <span>{t('serviceManager.columnStatus')}</span>
            <span className="text-center">{t('serviceManager.columnDeps')}</span>
          </div>

          {/* Rows */}
          <div className="service-row-list max-h-[440px] overflow-y-auto">
            {services.map((svc) => (
              <ServiceRow key={svc.name} service={svc} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ServiceRow({ service: svc }: { service: WindowsService }) {
  const { t } = useTranslation('hardening')
  const enableStartType = useServiceStore((s) => s.enableStartType)
  const isUnsafe = svc.safety === 'unsafe'
  const isDisabled = svc.startType === 'Disabled'
  // Critical services can't be picked for disabling — but a disabled one is
  // selectable so it can be restored.
  const locked = isUnsafe && !isDisabled
  const colors = SAFETY_COLORS[svc.safety]

  return (
    <button
      onClick={() => !locked && useServiceStore.getState().toggleService(svc.name)}
      title={locked ? undefined : isDisabled ? t('serviceManager.selectToReEnableTitle') : undefined}
      className="service-row grid w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-100"
      style={{
        gridTemplateColumns: '32px minmax(240px, 1fr) 132px 110px 64px',
        background: svc.selected ? colors.bg : 'transparent',
        borderBottom: '1px solid var(--border-subtle)',
        cursor: locked ? 'default' : 'pointer'
      }}
    >
      {/* Checkbox */}
      <div className="flex justify-center">
        <div
          className="flex h-[18px] w-[18px] items-center justify-center rounded"
          style={{
            border: `1.5px solid ${svc.selected ? colors.dot : locked ? 'var(--text-faint)' : 'var(--text-muted)'}`,
            background: svc.selected ? colors.dot : 'transparent',
            opacity: locked ? 0.72 : 1
          }}
        >
          {svc.selected && <CheckCircle2 className="h-3 w-3 text-white" strokeWidth={3} />}
        </div>
      </div>

      {/* Name + description */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{svc.displayName}</span>
          {isUnsafe && (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold"
              style={{ background: 'color-mix(in srgb, var(--danger), transparent 86%)', color: 'var(--danger)' }}
            >
              {t('serviceManager.criticalBadge')}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {svc.description || svc.name}
        </div>
      </div>

      {/* Startup type */}
      <div>
        <span
          className="service-start-pill inline-block rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{
            background:
              svc.startType === 'Disabled'
                ? 'color-mix(in srgb, var(--danger), transparent 89%)'
                : svc.startType === 'Automatic' || svc.startType === 'AutomaticDelayed'
                  ? 'color-mix(in srgb, var(--info), transparent 89%)'
                  : 'var(--bg-subtle-2)',
            color:
              svc.startType === 'Disabled'
                ? 'var(--danger)'
                : svc.startType === 'Automatic' || svc.startType === 'AutomaticDelayed'
                  ? 'var(--info)'
                  : 'var(--text-secondary)'
          }}
        >
          {svc.startType === 'AutomaticDelayed' ? t('serviceManager.startTypeAutoDelayed') : t(START_TYPE_KEY_MAP[svc.startType] || 'serviceManager.startTypeUnknown')}
        </span>
        {/* Make it obvious that selecting a disabled service restores it */}
        {isDisabled && svc.selected && (
          <span className="ml-1 text-[11px] font-semibold" style={{ color: 'var(--success)' }}>
            → {t(START_TYPE_KEY_MAP[enableStartType])}
          </span>
        )}
      </div>

      {/* Status */}
      <div className="flex items-center gap-1.5">
        <div
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: STATUS_COLORS[svc.status] || 'var(--text-muted)' }}
        />
        <span className="text-[12px] font-medium" style={{ color: STATUS_COLORS[svc.status] || 'var(--text-muted)' }}>
          {t(STATUS_KEY_MAP[svc.status] || 'serviceManager.statusUnknown')}
        </span>
      </div>

      {/* Dependencies count */}
      <div className="flex items-center justify-center gap-1">
        {svc.dependents.length > 0 && (
          <span
            className="flex items-center gap-0.5 text-[11px]"
            style={{ color: 'var(--text-muted)' }}
            title={t('serviceManager.dependentsTitle', { count: svc.dependents.length })}
          >
            <Link2 className="h-3 w-3" strokeWidth={1.8} />
            {svc.dependents.length}
          </span>
        )}
      </div>
    </button>
  )
}

function StatCard({
  label,
  value,
  tone,
  progress
}: {
  label: string
  value: number
  tone: 'neutral' | 'success' | 'brand' | 'warning'
  progress: number
}) {
  return (
    <div
      className="service-stat-card rounded-2xl px-5 py-4"
      data-tone={tone}
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)' }}
    >
      <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </div>
      <div className="service-stat-value mt-1 text-[26px] font-bold">
        {value}
      </div>
      <div className="service-stat-meter" aria-hidden="true">
        <i style={{ width: `${Math.max(value > 0 ? 7 : 0, Math.min(100, progress))}%` }} />
      </div>
    </div>
  )
}

function FilterDropdown({
  value,
  ariaLabel,
  options,
  onChange
}: {
  value: string
  ariaLabel: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="relative">
      <select
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-xl py-2.5 pl-3.5 pr-9 text-[13px] font-semibold outline-none"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border-medium)', color: 'var(--text-primary)' }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
        style={{ color: 'var(--text-muted)' }}
        strokeWidth={2}
      />
    </div>
  )
}
