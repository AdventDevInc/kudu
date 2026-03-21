import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Cpu,
  Search,
  Trash2,
  Shield,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Download,
  ArrowUpCircle,
  RefreshCw,
  Sparkles
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ScanProgress } from '@/components/shared/ScanProgress'
import { useHistoryStore } from '@/stores/history-store'
import { useStatsStore } from '@/stores/stats-store'
import { useDriverStore } from '@/stores/driver-store'
import { formatBytes } from '@/lib/utils'
import type {
  DriverScanProgress,
  DriverUpdateProgress
} from '@shared/types'

export function DriverManagerPage({ embedded }: { embedded?: boolean }) {
  const { t } = useTranslation('updates')
  const packages = useDriverStore((s) => s.packages)
  const scanning = useDriverStore((s) => s.scanning)
  const scanProgress = useDriverStore((s) => s.scanProgress)
  const cleaning = useDriverStore((s) => s.cleaning)
  const cleanResult = useDriverStore((s) => s.cleanResult)
  const error = useDriverStore((s) => s.error)
  const totalStaleSize = useDriverStore((s) => s.totalStaleSize)
  const updates = useDriverStore((s) => s.updates)
  const updateScanning = useDriverStore((s) => s.updateScanning)
  const updateProgress = useDriverStore((s) => s.updateProgress)
  const installing = useDriverStore((s) => s.installing)
  const installResult = useDriverStore((s) => s.installResult)
  const updateError = useDriverStore((s) => s.updateError)
  const applying = useDriverStore((s) => s.applying)
  const hasScanned = useDriverStore((s) => s.hasScanned)

  const [showConfirm, setShowConfirm] = useState(false)
  const cleanStartRef = useRef<number>(0)
  const historyStore = useHistoryStore()
  const recomputeStats = useStatsStore((s) => s.recompute)

  const isScanning = scanning || updateScanning
  const isBusy = isScanning || applying

  // Listen for progress events
  useEffect(() => {
    const cleanupDriver = window.kudu.onDriverProgress((data: DriverScanProgress) => {
      useDriverStore.getState().setScanProgress(data)
    })
    const cleanupUpdate = window.kudu.onDriverUpdateProgress((data: DriverUpdateProgress) => {
      useDriverStore.getState().setUpdateProgress(data)
    })
    return () => {
      cleanupDriver()
      cleanupUpdate()
    }
  }, [])

  // ─── Scan for both stale packages and updates ─────────────
  const handleScan = useCallback(async () => {
    const store = useDriverStore.getState()
    store.setScanning(true)
    store.setUpdateScanning(true)
    store.setPackages([])
    store.setUpdates([])
    store.setCleanResult(null)
    store.setInstallResult(null)
    store.setError(null)
    store.setUpdateError(null)
    store.setScanProgress(null)
    store.setUpdateProgress(null)

    // Run both scans in parallel
    const [staleResult, updateResult] = await Promise.allSettled([
      window.kudu.driverScan(),
      window.kudu.driverUpdateScan()
    ])

    const s = useDriverStore.getState()

    if (staleResult.status === 'fulfilled') {
      s.setPackages(staleResult.value.packages)
      s.setTotalStaleSize(staleResult.value.totalStaleSize)
      // Auto-select all stale packages
      useDriverStore.getState().selectAllStale()
    } else {
      console.error('Driver scan failed:', staleResult.reason)
      toast.error(t('driverManager.scanFailedToast'), { description: t('driverManager.scanFailedDescription') })
      s.setError(t('driverManager.scanFailedError'))
    }

    if (updateResult.status === 'fulfilled') {
      s.setUpdates(updateResult.value.updates)
    } else {
      console.error('Driver update scan failed:', updateResult.reason)
      toast.error(t('driverManager.updateScanFailedToast'), { description: t('driverManager.updateScanFailedDescription') })
      s.setUpdateError(t('driverManager.updateScanFailedError'))
    }

    const final = useDriverStore.getState()
    final.setScanning(false)
    final.setUpdateScanning(false)
    final.setScanProgress(null)
    final.setUpdateProgress(null)
    final.setHasScanned(true)
  }, [])

  // ─── Combined Update & Clean ──────────────────────────────
  const handleApply = useCallback(async () => {
    setShowConfirm(false)
    const store = useDriverStore.getState()
    store.setApplying(true)
    store.setCleanResult(null)
    store.setInstallResult(null)
    cleanStartRef.current = Date.now()

    const selectedUpdates = store.updates.filter((u) => u.selected)
    const selectedStale = store.packages.filter((p) => p.selected && !p.isCurrent)

    // Step 1: Install driver updates (if any selected)
    if (selectedUpdates.length > 0) {
      store.setInstalling(true)
      store.setUpdateProgress(null)
      const ids = selectedUpdates.map((u) => u.updateId)
      try {
        const result = await window.kudu.driverUpdateInstall(ids)
        useDriverStore.getState().setInstallResult(result)
      } catch (err) {
        console.error('Driver install failed:', err)
        toast.error(t('driverManager.installFailedToast'), { description: t('driverManager.installFailedDescription') })
        useDriverStore.getState().setUpdateError(t('driverManager.installFailedError'))
      } finally {
        const s = useDriverStore.getState()
        s.setInstalling(false)
        s.setUpdateProgress(null)
      }
    }

    // Step 2: Clean stale packages (if any selected)
    if (selectedStale.length > 0) {
      const s2 = useDriverStore.getState()
      s2.setCleaning(true)
      const names = selectedStale.map((p) => p.publishedName)
      try {
        const result = await window.kudu.driverClean(names)
        useDriverStore.getState().setCleanResult(result)

        // History tracking
        const byClass: Record<string, { found: number; cleaned: number; size: number }> = {}
        for (const pkg of selectedStale) {
          if (!byClass[pkg.className]) byClass[pkg.className] = { found: 0, cleaned: 0, size: 0 }
          byClass[pkg.className].found++
          byClass[pkg.className].size += pkg.size
        }
        const totalSelected = selectedStale.length
        for (const c in byClass) {
          byClass[c].cleaned = Math.round((byClass[c].found / totalSelected) * result.removed)
        }

        await historyStore.addEntry({
          id: Date.now().toString(),
          type: 'drivers',
          timestamp: new Date().toISOString(),
          duration: Date.now() - cleanStartRef.current,
          totalItemsFound: store.packages.length,
          totalItemsCleaned: result.removed,
          totalItemsSkipped: result.failed,
          totalSpaceSaved: result.spaceRecovered,
          categories: Object.entries(byClass).map(([name, d]) => ({
            name: `Drivers: ${name}`,
            itemsFound: d.found,
            itemsCleaned: d.cleaned,
            spaceSaved: d.size
          })),
          errorCount: result.failed
        })
        recomputeStats()
      } catch (err) {
        console.error('Driver clean failed:', err)
        toast.error(t('driverManager.cleanFailedToast'), { description: t('driverManager.cleanFailedDescription') })
        useDriverStore.getState().setError(t('driverManager.cleanFailedError'))
      } finally {
        useDriverStore.getState().setCleaning(false)
      }
    }

    // Step 3: Re-scan to refresh the list
    useDriverStore.getState().setApplying(false)
    const finalStore = useDriverStore.getState()
    const didInstall = finalStore.installResult && finalStore.installResult.installed > 0
    const didClean = finalStore.cleanResult && finalStore.cleanResult.removed > 0
    if (didInstall || didClean) {
      // Quick refresh
      finalStore.setScanning(true)
      finalStore.setUpdateScanning(true)
      const [staleResult, updateResult] = await Promise.allSettled([
        window.kudu.driverScan(),
        window.kudu.driverUpdateScan()
      ])
      const s = useDriverStore.getState()
      if (staleResult.status === 'fulfilled') {
        s.setPackages(staleResult.value.packages)
        s.setTotalStaleSize(staleResult.value.totalStaleSize)
        useDriverStore.getState().selectAllStale()
      }
      if (updateResult.status === 'fulfilled') {
        s.setUpdates(updateResult.value.updates)
      }
      s.setScanning(false)
      s.setUpdateScanning(false)
      s.setScanProgress(null)
      s.setUpdateProgress(null)
    }
  }, [])

  const stalePackages = packages.filter((p) => !p.isCurrent)
  const selectedStaleCount = stalePackages.filter((p) => p.selected).length
  const selectedUpdateCount = updates.filter((u) => u.selected).length
  const totalSelected = selectedStaleCount + selectedUpdateCount
  const allStaleSelected = stalePackages.length > 0 && stalePackages.every((p) => p.selected)
  const allUpdatesSelected = updates.length > 0 && updates.every((u) => u.selected)

  // Build confirmation description
  const confirmParts: string[] = []
  if (selectedUpdateCount > 0) {
    confirmParts.push(t('driverManager.confirmDescriptionInstall', { count: selectedUpdateCount }))
  }
  if (selectedStaleCount > 0) {
    confirmParts.push(t('driverManager.confirmDescriptionRemove', { count: selectedStaleCount }))
  }
  const confirmDesc = `${t('driverManager.confirmDescriptionPrefix')} ${confirmParts.join(` ${t('driverManager.confirmDescriptionAnd')} `)}. ${selectedUpdateCount > 0 ? `${t('driverManager.confirmDescriptionRebootNote')} ` : ''}${t('driverManager.confirmDescriptionSuffix')}`

  return (
    <div className={embedded ? '' : 'animate-fade-in'}>
      {!embedded && (
        <PageHeader
          title={t('driverManager.pageTitle')}
          description={t('driverManager.pageDescription')}
        />
      )}

      {/* Actions */}
      <div className="mb-5 flex items-center gap-2.5">
        <button
          onClick={handleScan}
          disabled={isBusy}
          className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-medium text-zinc-300 transition-all disabled:opacity-40"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <Search className={`h-4 w-4 ${isScanning ? 'animate-pulse' : ''}`} strokeWidth={1.8} />
          {isScanning ? t('driverManager.scanningButton') : t('driverManager.scanDriversButton')}
        </button>
        <button
          onClick={() => setShowConfirm(true)}
          disabled={totalSelected === 0 || isBusy}
          className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-30"
          style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: '#fff' }}
        >
          {applying ? (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          ) : (
            <Sparkles className="h-4 w-4" strokeWidth={2} />
          )}
          {applying
            ? installing
              ? t('driverManager.installingButton')
              : cleaning
                ? t('driverManager.cleaningButton')
                : t('driverManager.applyingButton')
            : t('driverManager.updateAndCleanButton', { count: totalSelected })}
        </button>
      </div>

      {/* Info banner */}
      <div
        className="mb-5 flex items-center gap-3 rounded-2xl px-5 py-4"
        style={{ background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.08)' }}
      >
        <Shield className="h-5 w-5 shrink-0 text-amber-500" strokeWidth={1.8} />
        <p className="text-[12px]" style={{ color: '#8e8e96' }}>
          <span className="font-semibold text-amber-500">{t('driverManager.safeOperationBold')}</span> — {t('driverManager.safeOperationText')}
        </p>
      </div>

      {/* Errors */}
      {error && <ErrorAlert message={error} onDismiss={() => useDriverStore.getState().setError(null)} className="mb-5" />}
      {updateError && <ErrorAlert message={updateError} onDismiss={() => useDriverStore.getState().setUpdateError(null)} className="mb-5" />}

      {/* Scan progress */}
      {scanning && scanProgress && (
        <ScanProgress
          status="scanning"
          progress={scanProgress.total > 0 ? Math.round((scanProgress.current / scanProgress.total) * 100) : 0}
          currentPath={scanProgress.currentDriver}
          className="mb-5"
        />
      )}
      {scanning && !scanProgress && (
        <ScanProgress status="scanning" progress={0} currentPath={t('driverManager.enumeratingPackages')} className="mb-5" />
      )}

      {/* Update progress (during scan or install) */}
      {(updateScanning || installing) && updateProgress && (
        <div
          className="mb-5 rounded-2xl p-4"
          style={{ background: 'rgba(59,130,246,0.04)', border: '1px solid rgba(59,130,246,0.08)' }}
        >
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-4 w-4 animate-spin text-blue-400" strokeWidth={2} />
              <span className="text-[13px] font-medium text-zinc-200">
                {updateProgress.phase === 'checking'
                  ? t('driverManager.updateProgressChecking')
                  : updateProgress.phase === 'downloading'
                    ? t('driverManager.updateProgressDownloading')
                    : t('driverManager.updateProgressInstalling')}
                {updateProgress.total > 0 && ` (${updateProgress.current}/${updateProgress.total})`}
              </span>
            </div>
            <span className="text-[12px] font-mono" style={{ color: '#6e6e76' }}>
              {updateProgress.percent}%
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${updateProgress.percent}%`,
                background: 'linear-gradient(90deg, #3b82f6 0%, #60a5fa 100%)'
              }}
            />
          </div>
          <p className="mt-2 text-[11px] truncate" style={{ color: '#6e6e76' }}>
            {updateProgress.currentDevice}
          </p>
        </div>
      )}
      {updateScanning && !updateProgress && !scanning && (
        <ScanProgress status="scanning" progress={0} currentPath={t('driverManager.queryingWindowsUpdate')} className="mb-5" />
      )}

      {/* Results summary */}
      {installResult && (
        <div className="mb-5 flex items-center gap-3 rounded-2xl p-4" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.1)' }}>
          <CheckCircle2 className="h-5 w-5 text-green-500" strokeWidth={1.8} />
          <div className="text-[13px] text-zinc-200">
            <p>
              {installResult.installed !== 1 ? t('driverManager.installedDriverUpdatesPlural', { count: installResult.installed }) : t('driverManager.installedDriverUpdates', { count: installResult.installed })}
              {installResult.failed > 0 && <span className="text-red-400"> {t('driverManager.failedCount', { count: installResult.failed })}</span>}
            </p>
            {installResult.rebootRequired && (
              <p className="mt-1 text-[12px] text-amber-400">
                {t('driverManager.rebootRequired')}
              </p>
            )}
          </div>
        </div>
      )}
      {cleanResult && (
        <div className="mb-5 flex items-center gap-3 rounded-2xl p-4" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.1)' }}>
          <CheckCircle2 className="h-5 w-5 text-green-500" strokeWidth={1.8} />
          <p className="text-[13px] text-zinc-200">
            {cleanResult.removed !== 1 ? t('driverManager.removedStalePackagesPlural', { count: cleanResult.removed }) : t('driverManager.removedStalePackages', { count: cleanResult.removed })}
            {cleanResult.spaceRecovered > 0 && <span className="text-green-400"> — {t('driverManager.spaceRecovered', { size: formatBytes(cleanResult.spaceRecovered) })}</span>}
            {cleanResult.failed > 0 && <span className="text-red-400"> {t('driverManager.failedCount', { count: cleanResult.failed })}</span>}
          </p>
        </div>
      )}

      {/* Empty state */}
      {!hasScanned && !isScanning && (
        <EmptyState
          icon={Cpu}
          title={t('driverManager.emptyStateTitle')}
          description={t('driverManager.emptyStateDescription')}
          action={
            <button
              onClick={handleScan}
              disabled={isBusy}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: '#1a0a00' }}
            >
              <Search className="h-4 w-4" strokeWidth={1.8} />
              {t('driverManager.scanDriversButton')}
            </button>
          }
        />
      )}

      {/* All up to date state */}
      {hasScanned && !isScanning && updates.length === 0 && stalePackages.length === 0 && (
        <div
          className="flex flex-col items-center justify-center py-16 rounded-2xl"
          style={{ background: 'rgba(34,197,94,0.03)', border: '1px solid rgba(34,197,94,0.08)' }}
        >
          <CheckCircle2 className="h-12 w-12 text-green-500 mb-4" strokeWidth={1.5} />
          <p className="text-[15px] font-medium text-zinc-200">{t('driverManager.allUpToDateTitle')}</p>
          <p className="mt-1 text-[12px]" style={{ color: '#6e6e76' }}>{t('driverManager.allUpToDateDescription')}</p>
        </div>
      )}

      {/* ─── Updates Section ──────────────────────────────────── */}
      {updates.length > 0 && !isScanning && (
        <div className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <ArrowUpCircle className="h-4.5 w-4.5 text-blue-400" strokeWidth={1.8} />
              <span className="text-[13px] font-semibold text-zinc-200">
                {t('driverManager.updatesAvailable', { count: updates.length })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => allUpdatesSelected ? useDriverStore.getState().deselectAllUpdates() : useDriverStore.getState().selectAllUpdates()}
                className="rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors"
                style={{ background: 'rgba(255,255,255,0.04)', color: '#6e6e76' }}
              >
                {allUpdatesSelected ? t('driverManager.deselectAll') : t('driverManager.selectAll')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {updates.map((upd) => (
              <div
                key={upd.id}
                onClick={() => useDriverStore.getState().toggleUpdate(upd.id)}
                className="flex items-center gap-4 rounded-2xl px-5 py-4 transition-colors cursor-pointer"
                style={{
                  background: upd.selected ? 'rgba(59,130,246,0.04)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${upd.selected ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.04)'}`
                }}
              >
                <div className="w-6">
                  <input type="checkbox" checked={upd.selected} readOnly className="pointer-events-none accent-blue-500 cursor-pointer" />
                </div>
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: 'rgba(59,130,246,0.1)' }}
                >
                  <ArrowUpCircle className="h-5 w-5" style={{ color: '#3b82f6' }} strokeWidth={1.8} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[13px] font-medium text-zinc-200">{upd.deviceName}</span>
                    <span className="rounded-md px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgba(59,130,246,0.1)', color: '#60a5fa' }}>
                      {upd.className}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px]" style={{ color: '#6e6e76' }}>
                    {upd.provider} — {upd.currentVersion ? `v${upd.currentVersion}` : t('driverManager.versionUnknown')} → v{upd.availableVersion}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {upd.downloadSize && (
                    <span className="text-[12px] font-medium text-zinc-400">{upd.downloadSize}</span>
                  )}
                  {upd.availableDate && (
                    <div className="mt-0.5 text-[10px] font-mono" style={{ color: '#4e4e56' }}>
                      {upd.availableDate}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Stale Packages Section ──────────────────────────── */}
      {stalePackages.length > 0 && !isScanning && (
        <div className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Trash2 className="h-4.5 w-4.5 text-amber-400" strokeWidth={1.8} />
              <span className="text-[13px] font-semibold text-zinc-200">
                {t('driverManager.stalePackages', { count: stalePackages.length })}
              </span>
              {totalStaleSize > 0 && (
                <span className="rounded-md px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>
                  {formatBytes(totalStaleSize)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => allStaleSelected ? useDriverStore.getState().deselectAllStale() : useDriverStore.getState().selectAllStale()}
                className="rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors"
                style={{ background: 'rgba(255,255,255,0.04)', color: '#6e6e76' }}
              >
                {allStaleSelected ? t('driverManager.deselectAll') : t('driverManager.selectAll')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {stalePackages.map((pkg) => (
              <div
                key={pkg.id}
                onClick={() => useDriverStore.getState().togglePackage(pkg.id)}
                className="flex items-center gap-4 rounded-2xl px-5 py-4 transition-colors cursor-pointer"
                style={{
                  background: pkg.selected ? 'rgba(245,158,11,0.04)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${pkg.selected ? 'rgba(245,158,11,0.1)' : 'rgba(255,255,255,0.04)'}`
                }}
              >
                <div className="w-6">
                  <input type="checkbox" checked={pkg.selected} readOnly className="pointer-events-none accent-amber-500 cursor-pointer" />
                </div>
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: 'rgba(245,158,11,0.1)' }}
                >
                  <AlertTriangle className="h-5 w-5" style={{ color: '#f59e0b' }} strokeWidth={1.8} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[13px] font-medium text-zinc-200">{pkg.originalName}</span>
                    <span className="rounded-md px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgba(139,92,246,0.1)', color: '#a78bfa' }}>
                      {pkg.className}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px]" style={{ color: '#6e6e76' }}>
                    {pkg.provider} — v{pkg.version}{pkg.date ? ` — ${pkg.date}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="text-[12px] font-medium text-zinc-400">{formatBytes(pkg.size)}</span>
                  <div className="mt-0.5 text-[10px] font-mono" style={{ color: '#4e4e56' }}>{pkg.publishedName}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={showConfirm}
        onConfirm={handleApply}
        onCancel={() => setShowConfirm(false)}
        title={t('driverManager.confirmTitle')}
        description={confirmDesc}
        confirmLabel={t('driverManager.confirmLabel')}
        variant="danger"
      />
    </div>
  )
}
