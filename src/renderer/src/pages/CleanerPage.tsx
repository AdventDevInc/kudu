import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Monitor,
  Globe,
  AppWindow,
  Gamepad2,
  Trash2,
  Link2Off,
  Database,
  Variable,
  Search,
  Sparkles,
  ChevronRight,
  Folder,
  AlertTriangle,
  ShieldAlert,
  Loader2
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { ScanProgress } from '@/components/shared/ScanProgress'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { EmptyState } from '@/components/shared/EmptyState'
import { CleanSummary } from '@/components/cleaner/CleanSummary'
import { cn, formatBytes, formatNumber } from '@/lib/utils'
import { useScanStore } from '@/stores/scan-store'
import { useStatsStore } from '@/stores/stats-store'
import { useHistoryStore } from '@/stores/history-store'
import { useSettingsStore } from '@/stores/settings-store'
import { ScanStatus, CleanerType } from '@shared/enums'
import type { ScanResult } from '@shared/types'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'

interface CategoryDef {
  type: CleanerType
  labelKey: string
  icon: LucideIcon
  descriptionKey: string
}

const categories: CategoryDef[] = [
  { type: CleanerType.System, labelKey: 'categorySystem', icon: Monitor, descriptionKey: 'categorySystemDescription' },
  { type: CleanerType.Browser, labelKey: 'categoryBrowsers', icon: Globe, descriptionKey: 'categoryBrowsersDescription' },
  { type: CleanerType.App, labelKey: 'categoryApplications', icon: AppWindow, descriptionKey: 'categoryApplicationsDescription' },
  { type: CleanerType.Gaming, labelKey: 'categoryGaming', icon: Gamepad2, descriptionKey: 'categoryGamingDescription' },
  { type: CleanerType.RecycleBin, labelKey: 'categoryRecycleBin', icon: Trash2, descriptionKey: 'categoryRecycleBinDescription' },
  { type: CleanerType.Shortcut, labelKey: 'categoryShortcuts', icon: Link2Off, descriptionKey: 'categoryShortcutsDescription' },
  { type: CleanerType.Environment, labelKey: 'categoryEnvironment', icon: Variable, descriptionKey: 'categoryEnvironmentDescription' },
  { type: CleanerType.Database, labelKey: 'categoryDatabases', icon: Database, descriptionKey: 'categoryDatabasesDescription' }
]

export function CleanerPage() {
  const { t } = useTranslation('cleaner')
  const store = useScanStore()
  const recomputeStats = useStatsStore((s) => s.recompute)
  const historyStore = useHistoryStore()
  const createRestorePointEnabled = useSettingsStore((s) => s.settings.cleaner.createRestorePoint)
  const [activeCategory, setActiveCategory] = useState<CleanerType>(CleanerType.System)
  const [showConfirm, setShowConfirm] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const cleanStartRef = useRef<number>(0)
  const [scanningCategory, setScanningCategory] = useState<CleanerType | null>(null)

  const scanIndexRef = useRef(0)
  const cleanIndexRef = useRef(0)
  const cleanTotalRef = useRef(1)

  useEffect(() => {
    if (!window.kudu?.onScanProgress) return
    return window.kudu.onScanProgress((data) => {
      // Each cleaner reports 0-100% independently. Scale to overall progress
      // based on which category we're currently processing.
      if (data.phase === 'cleaning') {
        const total = cleanTotalRef.current
        const base = (cleanIndexRef.current / total) * 100
        const slice = (data.progress / total)
        store.setProgress({ ...data, progress: base + slice })
      } else {
        const total = categories.length
        const base = (scanIndexRef.current / total) * 100
        const slice = (data.progress / total)
        store.setProgress({ ...data, progress: base + slice })
      }
    })
  }, [])

  const [failedCategories, setFailedCategories] = useState<string[]>([])
  const [elevationSkipped, setElevationSkipped] = useState<string[]>([])

  const handleRelaunch = useCallback(() => {
    window.kudu.elevationRelaunch()
  }, [])

  const handleScan = useCallback(async () => {
    store.setStatus(ScanStatus.Scanning)
    store.setResults([])
    setExpandedGroups(new Set())
    setFailedCategories([])
    setElevationSkipped([])
    const failed: string[] = []
    const skippedForElevation: string[] = []
    try {
      const scanFns: Partial<Record<CleanerType, () => Promise<ScanResult[]>>> = {
        [CleanerType.System]: () => window.kudu.systemScan(),
        [CleanerType.Browser]: () => window.kudu.browserScan(),
        [CleanerType.App]: () => window.kudu.appScan(),
        [CleanerType.Gaming]: () => window.kudu.gamingScan(),
        [CleanerType.RecycleBin]: () => window.kudu.recycleBinScan(),
        [CleanerType.Shortcut]: () => window.kudu.shortcutScan(),
        [CleanerType.Environment]: () => window.kudu.environmentScan(),
        [CleanerType.Database]: () => window.kudu.databaseScan()
      }
      for (let ci = 0; ci < categories.length; ci++) {
        const cat = categories[ci]
        scanIndexRef.current = ci
        setScanningCategory(cat.type)
        try {
          const scanFn = scanFns[cat.type]
          if (!scanFn) continue
          const results = await scanFn()
          // Extract elevation-required markers before adding to store
          const elevationMarker = results.find((r) => r.subcategory === '__elevation_required')
          if (elevationMarker?.group) {
            skippedForElevation.push(...elevationMarker.group.split(', '))
          }
          store.addResults(results.filter((r) => r.subcategory !== '__elevation_required'))
        } catch {
          failed.push(t(cat.labelKey))
        }
      }
      if (failed.length > 0) setFailedCategories(failed)
      if (skippedForElevation.length > 0) setElevationSkipped(skippedForElevation)
      setScanningCategory(null)
      store.setStatus(ScanStatus.Complete)
    } catch {
      setScanningCategory(null)
      store.setStatus(ScanStatus.Error)
    }
    store.setProgress(null)
  }, [])

  const handleClean = useCallback(async () => {
    setShowConfirm(false)
    store.setStatus(ScanStatus.Cleaning)
    cleanStartRef.current = Date.now()
    try {
      // Create a system restore point before cleaning if enabled
      if (createRestorePointEnabled) {
        try {
          const rpResult = await window.kudu.createRestorePoint(
            `Kudu clean — ${new Date().toLocaleString()}`
          )
          if (rpResult.success) {
            toast.success(t('toastRestorePointCreated'))
          } else {
            toast.warning(t('toastRestorePointSkipped'), { description: rpResult.error })
          }
        } catch {
          toast.warning(t('toastRestorePointSkipped'), { description: t('toastRestorePointSkippedDescription') })
        }
      }

      const selectedIds = store.getSelectedIds()
      const cleanFns: Partial<Record<CleanerType, (ids: string[]) => Promise<any>>> = {
        [CleanerType.System]: (ids) => window.kudu.systemClean(ids),
        [CleanerType.Browser]: (ids) => window.kudu.browserClean(ids),
        [CleanerType.App]: (ids) => window.kudu.appClean(ids),
        [CleanerType.Gaming]: (ids) => window.kudu.gamingClean(ids),
        [CleanerType.RecycleBin]: () => window.kudu.recycleBinClean(),
        [CleanerType.Shortcut]: (ids) => window.kudu.shortcutClean(ids),
        [CleanerType.Environment]: (ids) => window.kudu.environmentClean(ids),
        [CleanerType.Database]: (ids) => window.kudu.databaseClean(ids)
      }
      let totalCleaned = 0, totalFiles = 0, totalSkipped = 0, anyNeedsElevation = false
      const allErrors: { path: string; reason: string }[] = []
      const categoryBreakdown: Array<{ name: string; type: string; found: number; cleaned: number; space: number }> = []

      // Compute how many categories actually have items to clean so progress
      // scales to 100% even when only a subset of categories is active.
      const activeCount = categories.filter((cat) => {
        const catItems = store.results.filter((r) => r.category === cat.type).flatMap((r) => r.items)
        return catItems.some((item) => selectedIds.includes(item.id))
      }).length
      cleanTotalRef.current = Math.max(activeCount, 1)
      let activeIndex = 0

      store.setProgress({ phase: 'cleaning', category: '', currentPath: '', progress: 0, itemsFound: 0, sizeFound: 0 })

      for (let ci = 0; ci < categories.length; ci++) {
        const cat = categories[ci]
        const catResults = store.results.filter((r) => r.category === cat.type)
        const catItemsAll = catResults.flatMap((r) => r.items)
        const catItemIds = catItemsAll
          .filter((item) => selectedIds.includes(item.id))
          .map((item) => item.id)
        if (catItemIds.length > 0) {
          cleanIndexRef.current = activeIndex
          try {
            const cleanFn = cleanFns[cat.type]
            if (!cleanFn) continue
            const result = await cleanFn(catItemIds)
            if (result) {
              totalCleaned += result.totalCleaned || 0
              totalFiles += result.filesDeleted || 0
              totalSkipped += result.filesSkipped || 0
              if (result.needsElevation) anyNeedsElevation = true
              if (result.errors?.length) allErrors.push(...result.errors)
              categoryBreakdown.push({
                name: t(cat.labelKey),
                type: cat.type,
                found: catItemsAll.length,
                cleaned: result.filesDeleted || 0,
                space: result.totalCleaned || 0
              })
            }
          } catch { /* continue */ }
          activeIndex++
        } else if (catItemsAll.length > 0) {
          categoryBreakdown.push({ name: t(cat.labelKey), type: cat.type, found: catItemsAll.length, cleaned: 0, space: 0 })
        }
      }

      const totalFound = store.results.reduce((s, r) => s + r.itemCount, 0)
      const duration = Date.now() - cleanStartRef.current
      await historyStore.addEntry({
        id: Date.now().toString(),
        type: 'cleaner',
        timestamp: new Date().toISOString(),
        duration,
        totalItemsFound: totalFound,
        totalItemsCleaned: totalFiles,
        totalItemsSkipped: totalSkipped,
        totalSpaceSaved: totalCleaned,
        categories: categoryBreakdown.map((d) => ({
          name: d.name, itemsFound: d.found, itemsCleaned: d.cleaned, spaceSaved: d.space
        })),
        errorCount: allErrors.length
      })
      recomputeStats()

      store.setCleanSummary({
        totalCleaned,
        filesDeleted: totalFiles,
        filesSkipped: totalSkipped,
        errors: allErrors,
        needsElevation: anyNeedsElevation,
        categories: categoryBreakdown,
        duration,
        totalSizeBefore: store.getTotalSize()
      })
      store.setStatus(ScanStatus.Complete)
    } catch {
      store.setStatus(ScanStatus.Error)
    }
    store.setProgress(null)
  }, [store.results, createRestorePointEnabled])

  const categoryResults = (type: CleanerType) => store.results.filter((r) => r.category === type)
  const categoryItemCount = (type: CleanerType) => categoryResults(type).reduce((sum, r) => sum + r.itemCount, 0)

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSubcategorySelection = (result: ScanResult) => {
    store.toggleSubcategory(result)
  }

  const isScanning = store.status === ScanStatus.Scanning
  const isCleaning = store.status === ScanStatus.Cleaning
  const hasResults = store.results.length > 0

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        action={
          <div className="flex items-center gap-2.5">
            <button
              onClick={handleScan}
              disabled={isScanning || isCleaning}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-medium text-zinc-300 transition-all disabled:opacity-40"
              style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-medium)' }}
            >
              <Search className="h-4 w-4" strokeWidth={1.8} />
              {t('scanButton')}
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              disabled={!hasResults || isScanning || isCleaning || store.getSelectedIds().length === 0}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-30"
              style={{
                background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                color: 'var(--text-on-accent)',
                boxShadow: hasResults ? '0 4px 20px rgba(245,158,11,0.2)' : 'none'
              }}
            >
              <Sparkles className="h-4 w-4" strokeWidth={2} />
              {t('cleanButton')}
            </button>
          </div>
        }
      />

      <div className="flex gap-5">
        {/* Category sidebar */}
        <div className="w-56 shrink-0 space-y-1.5">
          {categories.map((cat) => {
            const count = categoryItemCount(cat.type)
            const isActive = activeCategory === cat.type
            return (
              <button
                key={cat.type}
                onClick={() => setActiveCategory(cat.type)}
                className="relative flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-all"
                style={{
                  background: isActive ? 'var(--accent-muted-bg)' : 'transparent',
                  color: isActive ? 'var(--accent-hover)' : 'var(--text-muted)'
                }}
              >
                {isActive && (
                  <div className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full" style={{ background: 'var(--accent)' }} />
                )}
                {scanningCategory === cat.type ? (
                  <Loader2 className="h-[17px] w-[17px] shrink-0 animate-spin text-amber-400" strokeWidth={1.8} />
                ) : (
                  <cat.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium">{t(cat.labelKey)}</span>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{t(cat.descriptionKey)}</p>
                </div>
                {count > 0 && (
                  <span
                    className="rounded-md px-1.5 py-0.5 font-mono text-[11px]"
                    style={{ background: 'var(--bg-hover-2)', color: 'var(--text-muted)' }}
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}

          {hasResults && (
            <div className="mt-5 rounded-2xl p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
              <p className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('totalRecoverable')}</p>
              <p className="text-[20px] font-bold tracking-tight text-amber-400">{formatBytes(store.getTotalSize())}</p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {t('itemsCount', { count: formatNumber(store.results.reduce((s, r) => s + r.itemCount, 0)) })}
              </p>
              <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <p className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('selectedLabel')}</p>
                <p className="text-[15px] font-semibold text-zinc-200">{formatBytes(store.getSelectedSize())}</p>
              </div>
            </div>
          )}
        </div>

        {/* Item panel */}
        <div className="flex-1 min-w-0">
          {(isScanning || isCleaning) && store.progress && (
            <ScanProgress
              status={isScanning ? 'scanning' : 'cleaning'}
              progress={store.progress.progress}
              currentPath={store.progress.currentPath}
              itemsFound={store.progress.itemsFound}
              sizeFound={store.progress.sizeFound}
              className="mb-5"
            />
          )}

          {failedCategories.length > 0 && store.status === ScanStatus.Complete && (
            <div
              className="mb-5 flex items-center gap-3 rounded-2xl px-4 py-3"
              style={{ background: 'var(--accent-muted-bg)', border: '1px solid rgba(245,158,11,0.12)' }}
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" strokeWidth={1.8} />
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {t('scannersFailed')} <span className="text-amber-400 font-medium">{failedCategories.join(', ')}</span>
              </p>
            </div>
          )}

          {elevationSkipped.length > 0 && store.status === ScanStatus.Complete && !store.cleanSummary && (
            <div
              className="mb-5 flex items-center gap-3 rounded-2xl px-4 py-3"
              style={{ background: 'var(--accent-muted-bg)', border: '1px solid var(--accent-muted-border)' }}
            >
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" strokeWidth={1.8} />
              <div className="flex-1 min-w-0">
                <p className="text-[12px] text-zinc-300">
                  <span className="font-medium">{t('categoriesSkipped', { count: elevationSkipped.length })}</span>
                  <span style={{ color: 'var(--text-muted)' }}> {t('categoriesSkippedSuffix')}</span>
                </p>
                <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                  {elevationSkipped.slice(0, 4).join(', ')}{elevationSkipped.length > 4 ? ` ${t('categoriesSkippedMore', { count: elevationSkipped.length - 4 })}` : ''}
                </p>
              </div>
              <button
                onClick={handleRelaunch}
                className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium text-amber-400 transition-colors hover:bg-amber-500/15"
                style={{ border: '1px solid rgba(245,158,11,0.2)' }}
              >
                {t('relaunchAsAdmin')}
              </button>
            </div>
          )}

          {store.cleanSummary && store.status === ScanStatus.Complete && (
            <CleanSummary summary={store.cleanSummary} onRelaunchAsAdmin={handleRelaunch} />
          )}

          {!hasResults && !isScanning && (
            <EmptyState
              icon={Search}
              title={t('noScanResultsTitle')}
              description={t('noScanResultsDescription')}
              action={
                <button
                  onClick={handleScan}
                  disabled={isCleaning}
                  className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'var(--text-on-accent)' }}
                >
                  <Search className="h-4 w-4" strokeWidth={1.8} />
                  {t('startScan')}
                </button>
              }
            />
          )}

          {hasResults && (
            <div key={activeCategory} className="space-y-2">
              <div className="mb-3 flex items-center justify-between px-1">
                <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {t('categoryItemsHeading', { category: t(categories.find((c) => c.type === activeCategory)?.labelKey ?? '') })}
                </span>
                <button
                  onClick={() => store.toggleCategory(activeCategory)}
                  className="text-[12px] font-medium text-amber-500 hover:text-amber-400"
                >
                  {t('toggleAll')}
                </button>
              </div>

              {categoryResults(activeCategory).length === 0 && (
                <div className="py-12 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  {t('noItemsInCategory')}
                </div>
              )}

              {(() => {
                const results = categoryResults(activeCategory)
                // Group results by group label (ungrouped first, then grouped sections)
                const ungrouped = results.filter((r) => !r.group)
                const grouped = new Map<string, ScanResult[]>()
                for (const r of results) {
                  if (!r.group) continue
                  if (!grouped.has(r.group)) grouped.set(r.group, [])
                  grouped.get(r.group)!.push(r)
                }

                const sections: { label?: string; items: ScanResult[] }[] = []
                if (ungrouped.length > 0) sections.push({ items: ungrouped })
                for (const [label, items] of grouped) sections.push({ label, items })

                return sections.map((section) => (
                  <div key={section.label || '_ungrouped'}>
                    {section.label && (
                      <div className="mt-4 mb-2 flex items-center gap-2 px-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                          {section.label}
                        </span>
                        <div className="flex-1 h-px" style={{ background: 'var(--bg-hover-2)' }} />
                        <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                          {formatBytes(section.items.reduce((s, r) => s + r.totalSize, 0))}
                        </span>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {section.items.map((result) => {
                        const groupKey = `${result.category}:${result.subcategory}`
                        const isExpanded = expandedGroups.has(groupKey)
                        const selectedInGroup = result.items.filter((item) => store.selectedItems.has(item.id)).length
                        const allSelected = selectedInGroup === result.items.length
                        const someSelected = selectedInGroup > 0 && !allSelected

                        return (
                          <div key={result.subcategory} className="rounded-xl overflow-hidden"
                            style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
                            {/* Group header */}
                            <div className="flex items-center gap-3 px-4 py-3.5 cursor-pointer"
                              onClick={() => toggleGroup(groupKey)}
                              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-subtle)' }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                              {/* Checkbox */}
                              <div onClick={(e) => { e.stopPropagation(); toggleSubcategorySelection(result) }}
                                className="flex items-center">
                                <div className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] cursor-pointer"
                                  style={{
                                    background: allSelected || someSelected ? 'var(--accent)' : 'var(--bg-hover-2)',
                                    border: allSelected || someSelected ? 'none' : '1.5px solid var(--border-stronger)'
                                  }}>
                                  {allSelected && (
                                    <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                                      <path d="M2.5 6l2.5 2.5 4.5-5" stroke="var(--text-on-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  )}
                                  {someSelected && (
                                    <div className="h-[2px] w-2 rounded-full" style={{ background: 'var(--text-on-accent)' }} />
                                  )}
                                </div>
                              </div>

                              {/* Expand arrow */}
                              <ChevronRight
                                className={cn('h-3.5 w-3.5 shrink-0 transition-transform', isExpanded && 'rotate-90')}
                                style={{ color: 'var(--text-muted)' }}
                                strokeWidth={2}
                              />

                              {/* Folder icon */}
                              <Folder className="h-4 w-4 shrink-0" style={{ color: allSelected ? 'var(--accent)' : 'var(--text-muted)' }} strokeWidth={1.8} />

                              {/* Label */}
                              <div className="flex-1 min-w-0">
                                <span className="text-[13px] font-medium text-zinc-300">{result.subcategory}</span>
                              </div>

                              {/* Stats */}
                              <span className="rounded-md px-2 py-0.5 font-mono text-[11px] shrink-0"
                                style={{ background: 'var(--bg-subtle-2)', color: 'var(--text-secondary)' }}>
                                {t(result.itemCount === 1 ? 'itemCount' : 'itemCountPlural', { count: formatNumber(result.itemCount) })}
                              </span>
                              <span className="font-mono text-[12px] font-medium shrink-0" style={{ color: 'var(--text-muted)' }}>
                                {formatBytes(result.totalSize)}
                              </span>
                            </div>

                            {/* Expanded item list */}
                            {isExpanded && (
                              <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
                                {result.items.slice(0, 50).map((item) => {
                                  const checked = store.selectedItems.has(item.id)
                                  const pathLabel = item.path.split(/[/\\]/).slice(-2).join('/') || item.path
                                  return (
                                    <label key={item.id}
                                      className="flex items-center gap-3 px-4 py-2 pl-14 cursor-pointer transition-colors"
                                      style={{ background: checked ? 'rgba(245,158,11,0.03)' : 'transparent' }}
                                      onMouseEnter={(e) => { e.currentTarget.style.background = checked ? 'rgba(245,158,11,0.05)' : 'var(--bg-subtle)' }}
                                      onMouseLeave={(e) => { e.currentTarget.style.background = checked ? 'rgba(245,158,11,0.03)' : 'transparent' }}>
                                      <input type="checkbox" checked={checked} onChange={() => store.toggleItem(item.id)}
                                        className="sr-only peer" />
                                      <div className="flex h-[16px] w-[16px] items-center justify-center rounded-[4px] shrink-0"
                                        style={{
                                          background: checked ? 'var(--accent)' : 'var(--bg-hover-2)',
                                          border: checked ? 'none' : '1.5px solid var(--border-stronger)'
                                        }}>
                                        {checked && (
                                          <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none">
                                            <path d="M2.5 6l2.5 2.5 4.5-5" stroke="var(--text-on-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                          </svg>
                                        )}
                                      </div>
                                      <span className="flex-1 min-w-0 truncate text-[12px] font-mono" style={{ color: 'var(--text-secondary)' }}>
                                        {pathLabel}
                                      </span>
                                      <span className="font-mono text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                                        {formatBytes(item.size)}
                                      </span>
                                    </label>
                                  )
                                })}
                                {result.items.length > 50 && (
                                  <div className="px-4 py-2.5 pl-14 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    {t('moreItems', { count: formatNumber(result.items.length - 50) })}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))
              })()}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={showConfirm}
        onConfirm={handleClean}
        onCancel={() => setShowConfirm(false)}
        title={t('confirmCleanTitle')}
        description={t('confirmCleanDescription', { count: formatNumber(store.getSelectedIds().length), size: formatBytes(store.getSelectedSize()) })}
        confirmLabel={t('confirmCleanLabel')}
        variant="warning"
      />
    </div>
  )
}
