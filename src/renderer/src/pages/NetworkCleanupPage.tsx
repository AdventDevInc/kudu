import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  Sparkles,
  CheckCircle2,
  Wifi,
  Globe,
  Network,
  History
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/utils'
import type { NetworkItem } from '@shared/types'
import type { LucideIcon } from 'lucide-react'
import { useHistoryStore } from '@/stores/history-store'
import { useStatsStore } from '@/stores/stats-store'
import { useNetworkStore } from '@/stores/network-store'
import { usePlatform } from '@/hooks/usePlatform'

type NetworkCategory = NetworkItem['type']

interface CategoryDef {
  type: NetworkCategory
  labelKey: string
  icon: LucideIcon
  descriptionKey: string
}

const categories: CategoryDef[] = [
  { type: 'dns-cache', labelKey: 'categoryDnsCache', icon: Globe, descriptionKey: 'categoryDnsCacheDesc' },
  { type: 'wifi-profile', labelKey: 'categoryWifiProfiles', icon: Wifi, descriptionKey: 'categoryWifiProfilesDesc' },
  { type: 'arp-cache', labelKey: 'categoryArpCache', icon: Network, descriptionKey: 'categoryArpCacheDesc' },
  { type: 'network-history', labelKey: 'categoryNetworkHistory', icon: History, descriptionKey: 'categoryNetworkHistoryDesc' }
]

export function NetworkCleanupPage() {
  const { t } = useTranslation('network')
  const { platform } = usePlatform()
  const visibleCategories = useMemo(() =>
    categories.filter((c) => {
      if (c.type === 'network-history' && platform !== 'win32') return false
      return true
    }),
    [platform]
  )
  const items = useNetworkStore((s) => s.items)
  const selectedIds = useNetworkStore((s) => s.selectedIds)
  const status = useNetworkStore((s) => s.status)
  const cleanResult = useNetworkStore((s) => s.cleanResult)
  const activeCategory = useNetworkStore((s) => s.activeCategory)

  const [showConfirm, setShowConfirm] = useState(false)
  const historyStore = useHistoryStore()
  const recomputeStats = useStatsStore((s) => s.recompute)

  const handleScan = useCallback(async () => {
    const store = useNetworkStore.getState()
    store.setStatus('scanning')
    store.setItems([])
    store.setSelectedIds(new Set())
    store.setCleanResult(null)
    try {
      const result = await window.kudu.networkScan()
      const s = useNetworkStore.getState()
      s.setItems(result)
      const preSelected = new Set(result.filter((i) => i.selected).map((i) => i.id))
      s.setSelectedIds(preSelected)
      s.setStatus('complete')
    } catch {
      toast.error(t('scanFailedToast'))
      useNetworkStore.getState().setStatus('idle')
    }
  }, [])

  const handleClean = useCallback(async () => {
    setShowConfirm(false)
    const store = useNetworkStore.getState()
    store.setStatus('cleaning')
    const cleanStart = Date.now()
    try {
      const { selectedIds: currentSelectedIds, items: currentItems } = useNetworkStore.getState()
      const result = await window.kudu.networkClean([...currentSelectedIds])
      const s = useNetworkStore.getState()
      s.setCleanResult(result)
      // Remove cleaned items from list
      s.setItems(currentItems.filter((i) => !currentSelectedIds.has(i.id)))
      s.setSelectedIds(new Set())

      // Log to scan history
      const byType: Record<string, { found: number; cleaned: number }> = {}
      for (const item of currentItems) {
        if (!byType[item.type]) byType[item.type] = { found: 0, cleaned: 0 }
        byType[item.type].found++
        if (currentSelectedIds.has(item.id)) byType[item.type].cleaned++
      }
      await historyStore.addEntry({
        id: Date.now().toString(),
        type: 'network',
        timestamp: new Date().toISOString(),
        duration: Date.now() - cleanStart,
        totalItemsFound: currentItems.length,
        totalItemsCleaned: result.cleaned,
        totalItemsSkipped: result.failed,
        totalSpaceSaved: 0,
        categories: Object.entries(byType).map(([name, d]) => ({
          name,
          itemsFound: d.found,
          itemsCleaned: d.cleaned,
          spaceSaved: 0
        })),
        errorCount: result.failed
      })
      recomputeStats()

      useNetworkStore.getState().setStatus('complete')
    } catch {
      toast.error(t('cleanupFailedToast'))
      useNetworkStore.getState().setStatus('idle')
    }
  }, [historyStore, recomputeStats])

  const isScanning = status === 'scanning'
  const isCleaning = status === 'cleaning'
  const hasItems = items.length > 0
  const categoryItems = items.filter((i) => i.type === activeCategory)

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={platform === 'win32' ? t('pageDescriptionWindows') : t('pageDescriptionOther')}
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
              disabled={!hasItems || isScanning || isCleaning || selectedIds.size === 0}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-30"
              style={{
                background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                color: 'var(--text-on-accent)',
                boxShadow: hasItems ? '0 4px 20px rgba(245,158,11,0.2)' : 'none'
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
          {visibleCategories.map((cat) => {
            const count = items.filter((i) => i.type === cat.type).length
            const isActive = activeCategory === cat.type
            return (
              <button
                key={cat.type}
                onClick={() => useNetworkStore.getState().setActiveCategory(cat.type)}
                className="relative flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-all"
                style={{
                  background: isActive ? 'var(--accent-muted-bg)' : 'transparent',
                  color: isActive ? 'var(--accent-hover)' : 'var(--text-muted)'
                }}
              >
                {isActive && (
                  <div className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full" style={{ background: 'var(--accent)' }} />
                )}
                <cat.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
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

          {hasItems && (
            <div className="mt-5 rounded-2xl p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
              <p className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('totalFound')}</p>
              <p className="text-[20px] font-bold tracking-tight text-amber-400">{items.length}</p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{t('networkItems')}</p>
              <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <p className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{t('selected')}</p>
                <p className="text-[15px] font-semibold text-zinc-200">{t('selectedItems', { count: selectedIds.size })}</p>
              </div>
            </div>
          )}
        </div>

        {/* Items panel */}
        <div className="flex-1 min-w-0">
          {isScanning && (
            <div className="mb-5 flex items-center gap-3 rounded-2xl px-5 py-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
              <span className="text-[13px] text-zinc-400">{t('scanningStatus')}</span>
            </div>
          )}

          {isCleaning && (
            <div className="mb-5 flex items-center gap-3 rounded-2xl px-5 py-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
              <span className="text-[13px] text-zinc-400">{t('cleaningStatus')}</span>
            </div>
          )}

          {cleanResult && status === 'complete' && (
            <div
              className="mb-5 rounded-2xl p-4"
              style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.1)' }}
            >
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" strokeWidth={1.8} />
                <div>
                  <p className="text-[13px] font-medium text-zinc-200">{t('cleanupComplete')}</p>
                  <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {t('cleanedCount', { count: cleanResult.cleaned })}
                    {cleanResult.failed > 0 && <span> · {t('failedCount', { count: cleanResult.failed })}</span>}
                  </p>
                </div>
              </div>
              {cleanResult.details.length > 0 && (
                <div className="mt-3 ml-8 space-y-0.5">
                  {cleanResult.details.map((detail, i) => (
                    <p key={i} className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>{detail}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {!hasItems && !isScanning && (
            <EmptyState
              icon={Search}
              title={t('emptyStateTitle')}
              description={t('emptyStateDescription')}
              action={
                <button
                  onClick={handleScan}
                  disabled={isCleaning}
                  className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'var(--text-on-accent)' }}
                >
                  <Search className="h-4 w-4" strokeWidth={1.8} />
                  {t('startScanButton')}
                </button>
              }
            />
          )}

          {hasItems && (
            <div key={activeCategory} className="space-y-2">
              <div className="mb-3 flex items-center justify-between px-1">
                <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {t(categories.find((c) => c.type === activeCategory)?.labelKey ?? '')}
                </span>
                {categoryItems.length > 0 && (
                  <button
                    onClick={() => useNetworkStore.getState().toggleCategory(activeCategory)}
                    className="text-[12px] font-medium text-amber-500 hover:text-amber-400"
                  >
                    {t('toggleAll')}
                  </button>
                )}
              </div>

              {categoryItems.length === 0 && (
                <div className="py-12 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  {t('noItemsInCategory')}
                </div>
              )}

              <div className="space-y-1.5">
                {categoryItems.map((item) => {
                  const checked = selectedIds.has(item.id)
                  const CatIcon = categories.find((c) => c.type === item.type)?.icon || Network
                  return (
                    <label
                      key={item.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-xl px-4 py-3.5 transition-all',
                        checked && 'ring-1 ring-amber-500/20'
                      )}
                      style={{
                        background: checked ? 'rgba(245,158,11,0.04)' : 'var(--card-bg)',
                        border: '1px solid var(--border-default)'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = checked ? 'var(--accent-muted-bg)' : 'var(--bg-subtle)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = checked ? 'rgba(245,158,11,0.04)' : 'var(--card-bg)'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => useNetworkStore.getState().toggleItem(item.id)}
                        className="sr-only"
                      />
                      <div
                        className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] shrink-0"
                        style={{
                          background: checked ? 'var(--accent)' : 'var(--bg-hover-2)',
                          border: checked ? 'none' : '1.5px solid var(--border-stronger)'
                        }}
                      >
                        {checked && (
                          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                            <path d="M2.5 6l2.5 2.5 4.5-5" stroke="var(--text-on-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                      <CatIcon
                        className="h-4 w-4 shrink-0"
                        style={{ color: checked ? 'var(--accent)' : 'var(--text-muted)' }}
                        strokeWidth={1.8}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-zinc-300">{item.label}</p>
                        <p className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{item.detail}</p>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={showConfirm}
        onConfirm={handleClean}
        onCancel={() => setShowConfirm(false)}
        title={t('confirmTitle')}
        description={`${t('confirmDescription', { count: selectedIds.size })}${selectedIds.size > 0 && items.some((i) => i.type === 'wifi-profile' && selectedIds.has(i.id)) ? ' ' + t('confirmWifiWarning') : ''}${platform === 'win32' && items.some((i) => i.type === 'network-history' && selectedIds.has(i.id)) ? ' ' + t('confirmNetworkHistoryWarning') : ''}`}
        confirmLabel={t('confirmLabel')}
        variant="warning"
      />
    </div>
  )
}
