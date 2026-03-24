import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ShieldCheck,
  ShieldAlert,
  Eye,
  Search,
  Megaphone,
  Radio,
  RefreshCw,
  CalendarClock,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Cpu,
  Globe,
  Lock,
  Compass,
  BrainCircuit
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'
import { usePrivacyStore } from '@/stores/privacy-store'
import { useHistoryStore } from '@/stores/history-store'
import type { PrivacySetting } from '@shared/types'
import type { LucideIcon } from 'lucide-react'

interface CategoryDef {
  id: PrivacySetting['category']
  labelKey: string
  descriptionKey: string
  icon: LucideIcon
  color: string
  bg: string
  border: string
}

const categories: CategoryDef[] = [
  {
    id: 'telemetry',
    labelKey: 'privacyCategories.telemetryLabel',
    descriptionKey: 'privacyCategories.telemetryDescription',
    icon: Radio,
    color: '#ef4444',
    bg: 'rgba(239,68,68,0.08)',
    border: 'rgba(239,68,68,0.15)'
  },
  {
    id: 'ads',
    labelKey: 'privacyCategories.adsLabel',
    descriptionKey: 'privacyCategories.adsDescription',
    icon: Megaphone,
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.15)'
  },
  {
    id: 'search',
    labelKey: 'privacyCategories.searchLabel',
    descriptionKey: 'privacyCategories.searchDescription',
    icon: Search,
    color: '#3b82f6',
    bg: 'rgba(59,130,246,0.08)',
    border: 'rgba(59,130,246,0.15)'
  },
  {
    id: 'sync',
    labelKey: 'privacyCategories.syncLabel',
    descriptionKey: 'privacyCategories.syncDescription',
    icon: RefreshCw,
    color: '#8b5cf6',
    bg: 'rgba(139,92,246,0.08)',
    border: 'rgba(139,92,246,0.15)'
  },
  {
    id: 'services',
    labelKey: 'privacyCategories.servicesLabel',
    descriptionKey: 'privacyCategories.servicesDescription',
    icon: Eye,
    color: '#14b8a6',
    bg: 'rgba(20,184,166,0.08)',
    border: 'rgba(20,184,166,0.15)'
  },
  {
    id: 'tasks',
    labelKey: 'privacyCategories.tasksLabel',
    descriptionKey: 'privacyCategories.tasksDescription',
    icon: CalendarClock,
    color: '#a3e635',
    bg: 'rgba(163,230,53,0.08)',
    border: 'rgba(163,230,53,0.15)'
  },
  {
    id: 'kernel',
    labelKey: 'privacyCategories.kernelLabel',
    descriptionKey: 'privacyCategories.kernelDescription',
    icon: Cpu,
    color: '#a855f7',
    bg: 'rgba(168,85,247,0.08)',
    border: 'rgba(168,85,247,0.15)'
  },
  {
    id: 'network',
    labelKey: 'privacyCategories.networkLabel',
    descriptionKey: 'privacyCategories.networkDescription',
    icon: Globe,
    color: '#06b6d4',
    bg: 'rgba(6,182,212,0.08)',
    border: 'rgba(6,182,212,0.15)'
  },
  {
    id: 'access',
    labelKey: 'privacyCategories.accessLabel',
    descriptionKey: 'privacyCategories.accessDescription',
    icon: Lock,
    color: '#f97316',
    bg: 'rgba(249,115,22,0.08)',
    border: 'rgba(249,115,22,0.15)'
  },
  {
    id: 'ai',
    labelKey: 'privacyCategories.aiLabel',
    descriptionKey: 'privacyCategories.aiDescription',
    icon: BrainCircuit,
    color: '#ec4899',
    bg: 'rgba(236,72,153,0.08)',
    border: 'rgba(236,72,153,0.15)'
  },
  {
    id: 'browser',
    labelKey: 'privacyCategories.browserLabel',
    descriptionKey: 'privacyCategories.browserDescription',
    icon: Compass,
    color: '#0ea5e9',
    bg: 'rgba(14,165,233,0.08)',
    border: 'rgba(14,165,233,0.15)'
  }
]

function ScoreRing({ score, size = 80 }: { score: number; size?: number }) {
  const r = (size - 6) / 2
  const circumference = 2 * Math.PI * r
  const offset = circumference - (score / 100) * circumference
  const color = score >= 80 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444'

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="rgba(255,255,255,0.06)" strokeWidth={4} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={4}
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" className="transition-all duration-700" />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-[20px] font-bold" style={{ color }}>{score}</span>
        <span className="text-[9px] font-medium" style={{ color: '#52525e' }}>/ 100</span>
      </div>
    </div>
  )
}

export function PrivacyShieldPage({ embedded }: { embedded?: boolean }) {
  const { t } = useTranslation('hardening')
  const state = usePrivacyStore(s => s.state)
  const status = usePrivacyStore(s => s.status)
  const applyResult = usePrivacyStore(s => s.applyResult)
  const expandedCategories = usePrivacyStore(s => s.expandedCategories)
  const progress = usePrivacyStore(s => s.progress)
  const progressCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => { progressCleanupRef.current?.() }
  }, [])

  // Auto-scan on first visit (empty state)
  useEffect(() => {
    const store = usePrivacyStore.getState()
    if (store.status === 'idle' && !store.state) {
      handleScan()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleScan = useCallback(async () => {
    const store = usePrivacyStore.getState()
    store.setStatus('scanning')
    store.setApplyResult(null)
    store.setProgress(null)

    // Listen for progress
    progressCleanupRef.current?.()
    progressCleanupRef.current = window.kudu.onPrivacyProgress?.((data) => {
      usePrivacyStore.getState().setProgress(data)
    }) ?? null

    try {
      const result = await window.kudu.privacyScan()
      usePrivacyStore.getState().setState(result)
      // Auto-expand categories with unprotected settings
      const unprotected = new Set<string>()
      for (const s of result.settings) {
        if (!s.enabled) unprotected.add(s.category)
      }
      usePrivacyStore.getState().setExpandedCategories(unprotected)
      usePrivacyStore.getState().setStatus('done')
    } catch (err) {
      console.error('Privacy scan failed:', err)
      toast.error(t('privacy.scanFailed'))
      usePrivacyStore.getState().setStatus('idle')
    } finally {
      progressCleanupRef.current?.()
      progressCleanupRef.current = null
      usePrivacyStore.getState().setProgress(null)
    }
  }, [t])

  const handleApplyAll = useCallback(async () => {
    const store = usePrivacyStore.getState()
    if (!store.state) return
    const unprotectedIds = store.state.settings.filter(s => !s.enabled).map(s => s.id)
    if (unprotectedIds.length === 0) return

    const startTime = Date.now()
    store.setStatus('applying')
    store.setApplyResult(null)
    try {
      const result = await window.kudu.privacyApply(unprotectedIds)
      usePrivacyStore.getState().setApplyResult(result)
      // Re-scan to get updated state
      const updated = await window.kudu.privacyScan()
      usePrivacyStore.getState().setState(updated)
      usePrivacyStore.getState().setStatus('done')

      // Log to history
      const catMap: Record<string, { found: number; applied: number }> = {}
      for (const id of unprotectedIds) {
        const setting = store.state!.settings.find(s => s.id === id)
        if (setting) {
          if (!catMap[setting.category]) catMap[setting.category] = { found: 0, applied: 0 }
          catMap[setting.category].found++
        }
      }
      // Mark succeeded ones
      const failedIds = new Set(result.errors.map(e => e.id))
      for (const id of unprotectedIds) {
        const setting = store.state!.settings.find(s => s.id === id)
        if (setting && !failedIds.has(id)) {
          catMap[setting.category].applied++
        }
      }
      await useHistoryStore.getState().addEntry({
        id: Date.now().toString(),
        type: 'privacy',
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        totalItemsFound: unprotectedIds.length,
        totalItemsCleaned: result.succeeded,
        totalItemsSkipped: 0,
        totalSpaceSaved: 0,
        categories: Object.entries(catMap).map(([name, d]) => ({
          name, itemsFound: d.found, itemsCleaned: d.applied, spaceSaved: 0
        })),
        errorCount: result.failed
      })
    } catch (err) {
      console.error('Privacy apply failed:', err)
      usePrivacyStore.getState().setApplyResult({ succeeded: 0, failed: unprotectedIds.length, errors: [{ id: '', label: t('privacy.allSettingsLabel'), reason: t('privacy.ipcCallFailed') }] })
      usePrivacyStore.getState().setStatus('done')
    }
  }, [t])

  const handleApplyCategory = useCallback(async (categoryId: string) => {
    const store = usePrivacyStore.getState()
    if (!store.state) return
    const ids = store.state.settings.filter(s => s.category === categoryId && !s.enabled).map(s => s.id)
    if (ids.length === 0) return

    const startTime = Date.now()
    store.setStatus('applying')
    store.setApplyResult(null)
    try {
      const result = await window.kudu.privacyApply(ids)
      usePrivacyStore.getState().setApplyResult(result)
      const updated = await window.kudu.privacyScan()
      usePrivacyStore.getState().setState(updated)
      usePrivacyStore.getState().setStatus('done')
      if (result.succeeded > 0) toast.success(t(result.succeeded > 1 ? 'privacy.settingsAppliedToastPlural' : 'privacy.settingsAppliedToast', { count: result.succeeded }))
      if (result.failed > 0) toast.error(t(result.failed > 1 ? 'privacy.settingsFailedToastPlural' : 'privacy.settingsFailedToast', { count: result.failed }))

      await useHistoryStore.getState().addEntry({
        id: Date.now().toString(),
        type: 'privacy',
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        totalItemsFound: ids.length,
        totalItemsCleaned: result.succeeded,
        totalItemsSkipped: 0,
        totalSpaceSaved: 0,
        categories: [{ name: categoryId, itemsFound: ids.length, itemsCleaned: result.succeeded, spaceSaved: 0 }],
        errorCount: result.failed
      })
    } catch (err) {
      console.error('Privacy apply failed:', err)
      toast.error(t('privacy.applyFailed'), { description: t('privacy.applyFailedDescription') })
      usePrivacyStore.getState().setApplyResult({ succeeded: 0, failed: ids.length, errors: [{ id: '', label: categoryId, reason: t('privacy.ipcCallFailed') }] })
      usePrivacyStore.getState().setStatus('done')
    }
  }, [t])

  const handleToggleSingle = useCallback(async (settingId: string) => {
    const store = usePrivacyStore.getState()
    if (!store.state) return
    const setting = store.state.settings.find(s => s.id === settingId)
    if (!setting) return

    const isEnabling = !setting.enabled
    store.setStatus('applying')
    try {
      const result = isEnabling
        ? await window.kudu.privacyApply([settingId])
        : await window.kudu.privacyRevert([settingId])
      const updated = await window.kudu.privacyScan()
      usePrivacyStore.getState().setState(updated)
      usePrivacyStore.getState().setStatus('done')

      if (result.failed > 0) {
        const reason = result.errors[0]?.reason || t('privacy.unknownError')
        toast.error(t(isEnabling ? 'privacy.settingApplyFailed' : 'privacy.settingRevertFailed', { label: setting.label }), { description: reason })
      } else {
        toast.success(t(isEnabling ? 'privacy.settingEnabled' : 'privacy.settingDisabled', { label: setting.label }))
      }
    } catch {
      toast.error(t(isEnabling ? 'privacy.settingApplyFailedGeneric' : 'privacy.settingRevertFailedGeneric'))
      usePrivacyStore.getState().setStatus('done')
    }
  }, [t])

  const isScanning = status === 'scanning'
  const isApplying = status === 'applying'
  const busy = isScanning || isApplying
  const unprotectedCount = state ? state.total - state.protected : 0

  const headerAction = (
    <div className="flex items-center gap-2.5">
      <button
        onClick={handleScan}
        disabled={busy}
        className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-medium text-zinc-300 transition-all disabled:opacity-40"
        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <Eye className="h-4 w-4" strokeWidth={1.8} />
        {t('privacy.scanButton')}
      </button>
      {state && unprotectedCount > 0 && (
        <button
          onClick={handleApplyAll}
          disabled={busy}
          className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-30"
          style={{
            background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
            color: '#fff',
            boxShadow: '0 4px 20px rgba(34,197,94,0.2)'
          }}
        >
          <ShieldCheck className="h-4 w-4" strokeWidth={2} />
          {t('privacy.protectAllButton', { count: unprotectedCount })}
        </button>
      )}
    </div>
  )

  return (
    <div className={embedded ? '' : 'animate-fade-in'}>
      {!embedded && (
        <PageHeader
          title={t('privacy.pageTitle')}
          description={t('privacy.pageDescription')}
          action={headerAction}
        />
      )}
      {embedded && (
        <div className="mb-5 flex justify-end">
          {headerAction}
        </div>
      )}

      {/* Score + stats cards */}
      {state && !isScanning && (
        <div className="mb-5 grid grid-cols-3 gap-3">
          {/* Privacy score */}
          <div className="rounded-2xl p-5 flex items-center gap-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
            <ScoreRing score={state.score} />
            <div>
              <p className="text-[14px] font-semibold text-zinc-200">{t('privacy.privacyScore')}</p>
              <p className="text-[12px] mt-0.5" style={{ color: '#6e6e76' }}>
                {state.score >= 80 ? t('privacy.scoreWellProtected') : state.score >= 50 ? t('privacy.scoreNeedsImprovement') : t('privacy.scoreAtRisk')}
              </p>
            </div>
          </div>

          {/* Protection status */}
          <div className="rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="flex items-center gap-2 mb-2">
              {unprotectedCount === 0 ? (
                <ShieldCheck className="h-5 w-5 text-green-500" strokeWidth={1.8} />
              ) : (
                <ShieldAlert className="h-5 w-5 text-amber-500" strokeWidth={1.8} />
              )}
              <span className="text-[13px] font-medium text-zinc-200">
                {unprotectedCount === 0 ? t('privacy.fullyProtected') : t('privacy.unprotectedCount', { count: unprotectedCount })}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${(state.protected / state.total) * 100}%`,
                    background: state.score >= 80 ? '#22c55e' : state.score >= 50 ? '#f59e0b' : '#ef4444'
                  }}
                />
              </div>
              <span className="text-[12px] font-mono" style={{ color: '#6e6e76' }}>
                {state.protected}/{state.total}
              </span>
            </div>
          </div>

          {/* Category breakdown */}
          <div className="rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="text-[11px] font-medium mb-2" style={{ color: '#52525e' }}>{t('privacy.categoriesLabel')}</p>
            <div className="space-y-1.5">
              {categories.map(cat => {
                const catSettings = state.settings.filter(s => s.category === cat.id)
                if (catSettings.length === 0) return null
                const protectedInCat = catSettings.filter(s => s.enabled).length
                const allGood = protectedInCat === catSettings.length
                return (
                  <div key={cat.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-1.5 rounded-full" style={{ background: allGood ? '#22c55e' : cat.color }} />
                      <span className="text-[11px] text-zinc-400">{t(cat.labelKey).split(' ')[0]}</span>
                    </div>
                    <span className="text-[11px] font-mono" style={{ color: allGood ? '#22c55e' : '#6e6e76' }}>
                      {protectedInCat}/{catSettings.length}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Scanning progress */}
      {isScanning && (
        <div className="mb-5 rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="flex items-center gap-3 mb-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-green-400 border-t-transparent" />
            <span className="text-[13px] font-medium text-zinc-200">
              {progress ? t('privacy.scanProgressChecking', { label: progress.currentLabel }) : t('privacy.scanProgressPreparing')}
            </span>
            {progress && (
              <span className="ml-auto text-[12px] font-mono text-zinc-500">
                {progress.current} / {progress.total}
              </span>
            )}
          </div>

          {/* Progress bar */}
          <div className="h-1.5 rounded-full overflow-hidden mb-3" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${progress ? (progress.current / progress.total) * 100 : 0}%`,
                background: 'linear-gradient(90deg, #22c55e, #16a34a)'
              }}
            />
          </div>

          {/* Category pills showing which categories have been checked */}
          {progress && (
            <div className="flex flex-wrap gap-1.5">
              {categories.map(cat => {
                const catLabel = t(cat.labelKey).split(' ')[0]
                const isCurrent = progress.category === cat.id
                const catIdx = categories.findIndex(c => c.id === cat.id)
                const currentCatIdx = categories.findIndex(c => c.id === progress.category)
                const isDone = catIdx < currentCatIdx

                return (
                  <div
                    key={cat.id}
                    className="flex items-center gap-1 rounded-md px-2 py-1"
                    style={{
                      background: isCurrent ? 'rgba(34,197,94,0.1)' : isDone ? 'rgba(34,197,94,0.06)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${isCurrent ? 'rgba(34,197,94,0.2)' : isDone ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.04)'}`
                    }}
                  >
                    {isDone ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" strokeWidth={2} />
                    ) : isCurrent ? (
                      <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-green-400 border-t-transparent" />
                    ) : (
                      <div className="h-3 w-3 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }} />
                    )}
                    <span
                      className="text-[10px] font-medium"
                      style={{ color: isCurrent ? '#4ade80' : isDone ? '#4ade80' : '#52525e' }}
                    >
                      {catLabel}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Applying state */}
      {isApplying && (
        <div className="mb-5 flex items-center gap-3 rounded-2xl px-5 py-4" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>
          <Loader2 className="h-4 w-4 animate-spin text-green-400" />
          <span className="text-[13px] text-zinc-400">{t('privacy.applyingProtections')}</span>
        </div>
      )}

      {/* Apply result */}
      {applyResult && status === 'done' && (
        <div
          className="mb-5 rounded-2xl p-4"
          style={{
            background: applyResult.failed > 0 ? 'rgba(245,158,11,0.04)' : 'rgba(34,197,94,0.06)',
            border: `1px solid ${applyResult.failed > 0 ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)'}`
          }}
        >
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" strokeWidth={1.8} />
            <div>
              <p className="text-[13px] font-medium text-zinc-200">
                {t(applyResult.succeeded !== 1 ? 'privacy.settingsAppliedPlural' : 'privacy.settingsApplied', { count: applyResult.succeeded })}
              </p>
              {applyResult.failed > 0 && (
                <p className="text-[12px] mt-0.5" style={{ color: '#f59e0b' }}>
                  {t('privacy.settingsFailedRequireAdmin', { count: applyResult.failed })}
                </p>
              )}
            </div>
          </div>
          {applyResult.errors.length > 0 && (
            <div className="mt-3 ml-8 space-y-1">
              {applyResult.errors.map((err) => (
                <p key={err.id} className="text-[11px] font-mono" style={{ color: '#6e6e76' }}>
                  {err.label}: {err.reason}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!state && !isScanning && (
        <EmptyState
          icon={Eye}
          title={t('privacy.emptyStateTitle')}
          description={t('privacy.emptyStateDescription')}
        />
      )}

      {/* Category cards */}
      {state && !isScanning && (
        <div className="space-y-3">
          {categories.map(cat => {
            const catSettings = state.settings.filter(s => s.category === cat.id)
            if (catSettings.length === 0) return null

            const protectedInCat = catSettings.filter(s => s.enabled).length
            const allProtected = protectedInCat === catSettings.length
            const isExpanded = expandedCategories.has(cat.id)
            const unprotectedInCat = catSettings.length - protectedInCat
            const CatIcon = cat.icon

            return (
              <div key={cat.id} className="overflow-hidden rounded-2xl"
                style={{
                  border: `1px solid ${allProtected ? 'rgba(34,197,94,0.15)' : cat.border}`,
                  opacity: isApplying ? 0.5 : 1,
                  pointerEvents: isApplying ? 'none' : 'auto'
                }}>
                {/* Category header */}
                <button
                  onClick={() => usePrivacyStore.getState().toggleCategory(cat.id)}
                  className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors"
                  style={{ background: allProtected ? 'rgba(34,197,94,0.03)' : 'rgba(255,255,255,0.02)' }}
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                    style={{ background: allProtected ? 'rgba(34,197,94,0.1)' : cat.bg }}>
                    <CatIcon className="h-5 w-5" style={{ color: allProtected ? '#22c55e' : cat.color }} strokeWidth={1.8} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[14px] font-semibold text-zinc-200">{t(cat.labelKey)}</span>
                      {allProtected ? (
                        <span className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                          {t('privacy.allProtectedBadge')}
                        </span>
                      ) : (
                        <span className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: cat.bg, color: cat.color }}>
                          {t('privacy.unprotectedBadge', { count: unprotectedInCat })}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px]" style={{ color: '#5e5e66' }}>{t(cat.descriptionKey)}</p>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {!allProtected && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleApplyCategory(cat.id)
                        }}
                        disabled={busy}
                        className="rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40"
                        style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}
                      >
                        {t('privacy.protectAllCategoryButton')}
                      </button>
                    )}
                    {allProtected && (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full"
                        style={{ background: 'rgba(34,197,94,0.1)' }}>
                        <CheckCircle2 className="h-4 w-4 text-green-500" strokeWidth={2.5} />
                      </div>
                    )}
                    <div
                      className={cn(
                        'h-5 w-5 transition-transform',
                        isExpanded ? 'rotate-180' : 'rotate-0'
                      )}
                      style={{ color: '#6e6e76' }}
                    >
                      <svg viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                      </svg>
                    </div>
                  </div>
                </button>

                {/* Expanded settings */}
                {isExpanded && (
                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    {catSettings.map((setting, i) => {
                      const depSetting = setting.dependsOn
                        ? state?.settings.find(s => s.id === setting.dependsOn)
                        : undefined
                      const depMissing = depSetting !== undefined && !depSetting.enabled
                      const toggleDisabled = busy || depMissing || (setting.enabled && !setting.reversible)

                      return (
                      <div key={setting.id}
                        className="flex items-center gap-4 px-5 py-3.5"
                        style={{
                          borderBottom: i < catSettings.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none'
                        }}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium text-zinc-300">{setting.label}</span>
                            {setting.requiresAdmin && (
                              <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
                                style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>
                                {t('privacy.adminBadge')}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[11px]" style={{ color: '#5e5e66' }}>{setting.description}</p>
                          {depMissing && depSetting && (
                            <p className="mt-0.5 text-[10px]" style={{ color: '#f59e0b' }}>
                              {t('privacy.requiresSettingEnabled', { label: depSetting.label })}
                            </p>
                          )}
                        </div>

                        {/* Toggle switch */}
                        <button
                          onClick={() => handleToggleSingle(setting.id)}
                          disabled={toggleDisabled}
                          className="relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60"
                          style={{ background: setting.enabled ? '#22c55e' : 'rgba(255,255,255,0.08)' }}
                        >
                          <div className="absolute top-0.5 h-5 w-5 rounded-full transition-all"
                            style={{
                              left: setting.enabled ? '22px' : '2px',
                              background: setting.enabled ? '#fff' : '#6e6e76'
                            }} />
                        </button>
                      </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Admin warning */}
      {state && unprotectedCount > 0 && (
        <div className="mt-4 flex items-start gap-3 rounded-2xl px-5 py-3"
          style={{ background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.08)' }}>
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" strokeWidth={1.8} />
          <p className="text-[11px]" style={{ color: '#8e8e96' }}>
            {t('privacy.adminWarning')}
          </p>
        </div>
      )}
    </div>
  )
}
