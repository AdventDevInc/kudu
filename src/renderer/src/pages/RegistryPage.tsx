import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '@/hooks/usePlatform'
import {
  Database, Search, Wrench, Shield, CheckCircle2, ChevronDown,
  ShieldAlert, Gauge, Wifi, Server, CalendarClock, Trash2, Loader2, Check, StopCircle
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ScanProgress } from '@/components/shared/ScanProgress'
import { useHistoryStore } from '@/stores/history-store'
import { useStatsStore } from '@/stores/stats-store'
import { useRegistryStore } from '@/stores/registry-store'
import type { RegistryEntry } from '@shared/types'
import type { LucideIcon } from 'lucide-react'

type CardType = RegistryEntry['type']

const typeKeyMap: Record<CardType, string> = {
  obsolete: 'entryTypeObsolete',
  invalid: 'entryTypeInvalid',
  orphaned: 'entryTypeOrphaned',
  broken: 'entryTypeBroken',
  vulnerability: 'entryTypeVulnerability',
  privacy: 'entryTypeVulnerability', // kept for type compat
  performance: 'entryTypePerformance',
  network: 'entryTypeNetwork',
  service: 'entryTypeService',
  task: 'entryTypeTask'
}

const riskKeyMap: Record<RegistryEntry['risk'], string> = {
  low: 'riskLow',
  medium: 'riskMedium',
  high: 'riskHigh'
}

const typeColors: Record<CardType, { bg: string; text: string }> = {
  obsolete: { bg: 'var(--bg-hover)', text: 'var(--text-muted)' },
  invalid: { bg: 'rgba(245,158,11,0.1)', text: '#f59e0b' },
  orphaned: { bg: 'rgba(59,130,246,0.1)', text: '#3b82f6' },
  broken: { bg: 'rgba(239,68,68,0.1)', text: '#ef4444' },
  vulnerability: { bg: 'rgba(168,85,247,0.1)', text: '#a855f7' },
  privacy: { bg: 'rgba(236,72,153,0.1)', text: '#ec4899' },  // kept for type compat
  performance: { bg: 'rgba(20,184,166,0.1)', text: '#14b8a6' },
  network: { bg: 'rgba(99,102,241,0.1)', text: '#6366f1' },
  service: { bg: 'rgba(251,146,60,0.1)', text: '#fb923c' },
  task: { bg: 'rgba(163,230,53,0.1)', text: '#a3e635' }
}

const riskColors: Record<RegistryEntry['risk'], string> = {
  low: '#22c55e', medium: '#f59e0b', high: '#ef4444'
}

interface CardDef {
  types: CardType[]
  icon: LucideIcon
  titleKey: string
  descriptionKey: string
  color: { bg: string; text: string }
  /** Total number of checks for this card (undefined = dynamic/variable) */
  totalChecks?: number
}

const cards: CardDef[] = [
  {
    types: ['obsolete', 'invalid', 'orphaned', 'broken'],
    icon: Trash2,
    titleKey: 'cardRegistryCleanup',
    descriptionKey: 'cardRegistryCleanupDescription',
    color: { bg: 'rgba(245,158,11,0.1)', text: '#f59e0b' }
  },
  {
    types: ['vulnerability'],
    icon: ShieldAlert,
    titleKey: 'cardSecurity',
    descriptionKey: 'cardSecurityDescription',
    color: typeColors.vulnerability,
    totalChecks: 12
  },
  {
    types: ['performance'],
    icon: Gauge,
    titleKey: 'cardPerformance',
    descriptionKey: 'cardPerformanceDescription',
    color: typeColors.performance,
    totalChecks: 1
  },
  {
    types: ['network'],
    icon: Wifi,
    titleKey: 'cardNetwork',
    descriptionKey: 'cardNetworkDescription',
    color: typeColors.network,
    totalChecks: 2
  },
  {
    types: ['service'],
    icon: Server,
    titleKey: 'cardServices',
    descriptionKey: 'cardServicesDescription',
    color: typeColors.service,
    totalChecks: 2
  },
  {
    types: ['task'],
    icon: CalendarClock,
    titleKey: 'cardScheduledTasks',
    descriptionKey: 'cardScheduledTasksDescription',
    color: typeColors.task
  }
]

function HealthRing({ percent, color, size = 36 }: { percent: number; color: string; size?: number }) {
  const r = (size - 4) / 2
  const circumference = 2 * Math.PI * r
  const offset = circumference - (percent / 100) * circumference
  const isComplete = percent === 100

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="var(--gauge-track)" strokeWidth={3} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={isComplete ? '#22c55e' : color} strokeWidth={3}
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" className="transition-all duration-500" />
      </svg>
      <span className="absolute text-[10px] font-bold" style={{ color: isComplete ? '#22c55e' : color }}>
        {isComplete ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : `${percent}%`}
      </span>
    </div>
  )
}

export function RegistryPage() {
  const { features } = usePlatform()
  const { t } = useTranslation('registry')

  if (!features.registry) {
    return (
      <div className="animate-fade-in">
        <PageHeader title={t('pageHeaderUnavailableTitle')} description={t('pageHeaderUnavailableDescription')} />
        <EmptyState icon={Database} title={t('notAvailableTitle')} description={t('notAvailableDescription')} />
      </div>
    )
  }

  return <RegistryPageContent />
}

function RegistryPageContent() {
  const { t } = useTranslation('registry')
  const entries = useRegistryStore((s) => s.entries)
  const scanning = useRegistryStore((s) => s.scanning)
  const scanned = useRegistryStore((s) => s.scanned)
  const fixing = useRegistryStore((s) => s.fixing)
  const fixProgress = useRegistryStore((s) => s.fixProgress)
  const expandedCards = useRegistryStore((s) => s.expandedCards)
  const fixResult = useRegistryStore((s) => s.fixResult)
  const showFailures = useRegistryStore((s) => s.showFailures)
  const error = useRegistryStore((s) => s.error)

  const [showConfirm, setShowConfirm] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  const fixStartRef = useRef<number>(0)
  const historyStore = useHistoryStore()
  const recomputeStats = useStatsStore((s) => s.recompute)

  useEffect(() => {
    const cleanup = window.kudu.onRegistryFixProgress((data) => {
      useRegistryStore.getState().setFixProgress(data)
    })
    cleanupRef.current = cleanup
    return () => cleanup()
  }, [])

  const handleScan = useCallback(async () => {
    const store = useRegistryStore.getState()
    store.setScanning(true)
    store.setScanned(false)
    store.setEntries([])
    store.setFixResult(null)
    store.setError(null)
    try {
      const results = await window.kudu.registryScan()
      useRegistryStore.getState().setEntries(Array.isArray(results) ? results : [])
      useRegistryStore.getState().setScanned(true)
    } catch (err) {
      console.error('Registry scan failed:', err)
      toast.error(t('toastScanFailed'), { description: t('toastScanFailedDescription') })
      useRegistryStore.getState().setError(t('toastScanFailedError'))
    }
    useRegistryStore.getState().setScanning(false)
  }, [])

  const handleScanCancel = useCallback(async () => {
    try {
      await window.kudu.registryScanCancel()
    } catch { /* ignore */ }
    useRegistryStore.getState().setScanning(false)
  }, [])

  const handleFixCancel = useCallback(async () => {
    try {
      await window.kudu.registryFixCancel()
    } catch { /* ignore */ }
    useRegistryStore.getState().setFixing(false)
    useRegistryStore.getState().setFixProgress(null)
  }, [])

  const handleFix = useCallback(async () => {
    setShowConfirm(false)
    const store = useRegistryStore.getState()
    store.setFixing(true)
    store.setFixResult(null)
    store.setShowFailures(false)
    fixStartRef.current = Date.now()
    const currentEntries = useRegistryStore.getState().entries
    const selectedEntries = currentEntries.filter((e) => e.selected)
    const selectedIds = selectedEntries.map((e) => e.id)
    store.setFixProgress({ current: 0, total: selectedIds.length, currentEntry: t('creatingBackup') })
    try {
      const result = await window.kudu.registryFix(selectedIds)
      const s = useRegistryStore.getState()
      s.setFixResult(result)
      s.setEntries(s.entries.filter((e) => !selectedIds.includes(e.id)))

      // Build category breakdown by entry type
      const byType: Record<string, { found: number; fixed: number }> = {}
      for (const e of selectedEntries) {
        if (!byType[e.type]) byType[e.type] = { found: 0, fixed: 0 }
        byType[e.type].found++
      }
      // Distribute fixed count proportionally
      const totalSelected = selectedEntries.length
      for (const t in byType) {
        byType[t].fixed = Math.round((byType[t].found / totalSelected) * result.fixed)
      }

      await historyStore.addEntry({
        id: Date.now().toString(),
        type: 'registry',
        timestamp: new Date().toISOString(),
        duration: Date.now() - fixStartRef.current,
        totalItemsFound: currentEntries.length,
        totalItemsCleaned: result.fixed,
        totalItemsSkipped: result.failed,
        totalSpaceSaved: 0,
        categories: Object.entries(byType).map(([name, d]) => ({
          name, itemsFound: d.found, itemsCleaned: d.fixed, spaceSaved: 0
        })),
        errorCount: result.failed
      })
      recomputeStats()
    } catch (err) {
      console.error('Registry fix failed:', err)
      toast.error(t('toastFixFailed'), { description: t('toastFixFailedDescription') })
      useRegistryStore.getState().setError(t('toastFixFailedError'))
    }
    useRegistryStore.getState().setFixing(false)
    useRegistryStore.getState().setFixProgress(null)
  }, [historyStore, recomputeStats])

  const selectedCount = entries.filter((e) => e.selected).length
  const busy = scanning || fixing

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        action={
          <div className="flex items-center gap-2.5">
            <button onClick={handleScan} disabled={busy}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-medium text-zinc-300 transition-all disabled:opacity-40"
              style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-medium)' }}>
              <Search className="h-4 w-4" strokeWidth={1.8} /> {t('scanButton')}
            </button>
            <button onClick={() => setShowConfirm(true)} disabled={selectedCount === 0 || busy}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-30"
              style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'var(--text-on-accent)' }}>
              <Wrench className="h-4 w-4" strokeWidth={2} /> {t('fixButton', { count: selectedCount })}
            </button>
          </div>
        }
      />

      {/* Warning */}
      <div className="mb-5 flex items-center gap-3 rounded-2xl px-5 py-4"
        style={{ background: 'var(--accent-muted-bg)', border: '1px solid var(--accent-muted-bg)' }}>
        <Shield className="h-5 w-5 shrink-0 text-amber-500" strokeWidth={1.8} />
        <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          <span className="font-semibold text-amber-500">{t('advancedFeatureLabel')}</span> — {t('advancedFeatureDescription')}
        </p>
      </div>

      {error && <ErrorAlert message={error} onDismiss={() => useRegistryStore.getState().setError(null)} className="mb-5" />}
      {scanning && (
        <div className="mb-5 flex items-center gap-3">
          <div className="flex-1">
            <ScanProgress status="scanning" progress={0} currentPath={t('scanProgressText')} />
          </div>
          <button onClick={handleScanCancel}
            className="flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-2 text-[12px] font-medium text-red-400 transition-all hover:text-red-300"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
            <StopCircle className="h-3.5 w-3.5" strokeWidth={2} /> {t('cancelButton')}
          </button>
        </div>
      )}

      {/* Fix progress */}
      {fixing && fixProgress && (
        <div className="mb-5 rounded-2xl p-5" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
              <span className="text-[13px] font-medium text-zinc-200">{t('fixingEntries')}</span>
            </div>
            <span className="font-mono text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {fixProgress.current} / {fixProgress.total}
            </span>
          </div>
          <div className="mb-3 h-[6px] overflow-hidden rounded-full" style={{ background: 'var(--bg-subtle-2)' }}>
            <div className="h-full rounded-full transition-all duration-200 ease-out"
              style={{
                width: `${fixProgress.total > 0 ? (fixProgress.current / fixProgress.total) * 100 : 0}%`,
                background: 'linear-gradient(90deg, #f59e0b 0%, #d97706 100%)'
              }} />
          </div>
          <div className="flex items-center justify-between">
            <p className="truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {fixProgress.currentEntry}
            </p>
            <button onClick={handleFixCancel}
              className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium text-red-400 transition-all hover:text-red-300"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
              <StopCircle className="h-3 w-3" strokeWidth={2} /> {t('cancelButton')}
            </button>
          </div>
        </div>
      )}

      {fixResult && (
        <div className="mb-5 overflow-hidden rounded-2xl"
          style={{ border: `1px solid ${fixResult.failed > 0 ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)'}` }}>
          <div className="flex items-center gap-3 p-4"
            style={{ background: fixResult.failed > 0 ? 'rgba(239,68,68,0.04)' : 'rgba(34,197,94,0.06)' }}>
            <CheckCircle2 className="h-5 w-5 text-green-500" strokeWidth={1.8} />
            <p className="flex-1 text-[13px] text-zinc-200">
              {t('fixedEntries', { count: fixResult.fixed })}
              {fixResult.failed > 0 && (
                <button onClick={() => useRegistryStore.getState().setShowFailures(!showFailures)}
                  className="ml-2 text-red-400 underline decoration-red-400/30 hover:decoration-red-400 transition-colors">
                  {t('failedCount', { count: fixResult.failed })} — {showFailures ? t('failedHideDetails') : t('failedShowDetails')}
                </button>
              )}
            </p>
          </div>
          {showFailures && fixResult.failures.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
              {fixResult.failures.map((f, i) => (
                <div key={i} className="flex items-start gap-3 px-5 py-3"
                  style={{ borderBottom: i < fixResult.failures.length - 1 ? '1px solid var(--bg-subtle)' : 'none' }}>
                  <div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                  <div className="min-w-0">
                    <p className="text-[12px] text-zinc-300">{f.issue}</p>
                    <p className="mt-0.5 text-[11px] text-red-400/80">{f.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!scanned && !scanning && (
        <EmptyState
          icon={Database}
          title={t('emptyStateTitle')}
          description={t('emptyStateDescription')}
          action={
            <button
              onClick={handleScan}
              disabled={fixing}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'var(--text-on-accent)' }}
            >
              <Search className="h-4 w-4" strokeWidth={1.8} />
              {t('startScan')}
            </button>
          }
        />
      )}

      {/* ============ CARDS ============ */}
      {scanned && !scanning && (
        <div className="grid grid-cols-1 gap-3">
          {cards.map((card, cardIndex) => {
            const cardEntries = entries.filter((e) => card.types.includes(e.type))
            const issueCount = cardEntries.length
            const selectedInCard = cardEntries.filter((e) => e.selected).length
            const allSelected = issueCount > 0 && selectedInCard === issueCount
            const isExpanded = expandedCards.has(cardIndex)
            const highRiskCount = cardEntries.filter((e) => e.risk === 'high').length
            const mediumRiskCount = cardEntries.filter((e) => e.risk === 'medium').length
            const Icon = card.icon
            const color = card.color

            // Health percentage for cards with known total checks
            const hasPercentage = card.totalChecks !== undefined
            const healthPercent = hasPercentage
              ? Math.round(((card.totalChecks! - issueCount) / card.totalChecks!) * 100)
              : issueCount === 0 ? 100 : undefined
            const isClean = issueCount === 0

            return (
              <div key={cardIndex} className="overflow-hidden rounded-2xl"
                style={{
                  border: `1px solid ${isClean ? 'rgba(34,197,94,0.15)' : allSelected ? color.text + '20' : 'var(--border-default)'}`,
                  opacity: fixing ? 0.5 : 1,
                  pointerEvents: fixing ? 'none' : 'auto'
                }}>
                {/* Card header */}
                <div className="flex items-center gap-4 px-5 py-4"
                  style={{ background: isClean ? 'rgba(34,197,94,0.03)' : allSelected ? color.bg : 'var(--bg-subtle)' }}>
                  {/* Health ring or icon */}
                  {hasPercentage || isClean ? (
                    <HealthRing
                      percent={healthPercent ?? 100}
                      color={color.text}
                      size={40}
                    />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: color.bg }}>
                      <Icon className="h-5 w-5" style={{ color: color.text }} strokeWidth={1.8} />
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[14px] font-semibold text-zinc-200">{t(card.titleKey)}</span>
                      {isClean ? (
                        <span className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                          {t('allClear')}
                        </span>
                      ) : (
                        <>
                          <span className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                            style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                            {issueCount !== 1 ? t('issueCountPlural', { count: issueCount }) : t('issueCount', { count: issueCount })}
                          </span>
                          {highRiskCount > 0 && (
                            <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                              style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                              {t('highRisk', { count: highRiskCount })}
                            </span>
                          )}
                          {mediumRiskCount > 0 && highRiskCount === 0 && (
                            <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                              style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>
                              {t('mediumRisk', { count: mediumRiskCount })}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                      {t(card.descriptionKey)}
                      {hasPercentage && !isClean && (
                        <span style={{ color: healthPercent! >= 80 ? '#22c55e' : healthPercent! >= 50 ? '#f59e0b' : '#ef4444' }}>
                          {' '}— {t('checksPassed', { passed: card.totalChecks! - issueCount, total: card.totalChecks! })}
                        </span>
                      )}
                    </p>
                  </div>

                  {/* Toggle + Expand (only show if there are issues) */}
                  {!isClean && (
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        onClick={() => useRegistryStore.getState().toggleCardAll(card.types)}
                        className="relative h-6 w-11 rounded-full transition-colors"
                        style={{ background: allSelected ? color.text : 'var(--bg-active)' }}>
                        <div className="absolute top-0.5 h-5 w-5 rounded-full transition-all"
                          style={{
                            left: allSelected ? '22px' : '2px',
                            background: allSelected ? '#fff' : 'var(--text-secondary)'
                          }} />
                      </button>

                      <button onClick={() => useRegistryStore.getState().toggleCardExpand(cardIndex)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
                        style={{ background: 'var(--bg-subtle-2)' }}>
                        <ChevronDown
                          className="h-4 w-4 transition-transform"
                          style={{
                            color: 'var(--text-secondary)',
                            transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'
                          }}
                          strokeWidth={2} />
                      </button>
                    </div>
                  )}

                  {/* Green check for clean cards */}
                  {isClean && (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                      style={{ background: 'rgba(34,197,94,0.1)' }}>
                      <Check className="h-4 w-4 text-green-500" strokeWidth={2.5} />
                    </div>
                  )}
                </div>

                {/* Expanded items */}
                {isExpanded && !isClean && (
                  <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    {cardEntries.map((entry, i) => (
                      <div key={entry.id}
                        className="flex items-center gap-4 px-5 py-3 transition-colors"
                        style={{
                          background: entry.selected ? color.bg.replace('0.1', '0.03') : 'transparent',
                          borderBottom: i < cardEntries.length - 1 ? '1px solid var(--bg-subtle)' : 'none'
                        }}>
                        <div className="w-6 cursor-pointer" onClick={() => useRegistryStore.getState().toggleEntry(entry.id)}>
                          <input type="checkbox" checked={entry.selected} readOnly className="pointer-events-none accent-amber-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[12px] text-zinc-300">{entry.issue}</p>
                          <p className="mt-0.5 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{entry.keyPath}</p>
                        </div>
                        <span className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: typeColors[entry.type].bg, color: typeColors[entry.type].text }}>
                          {t(typeKeyMap[entry.type])}
                        </span>
                        <span className="shrink-0 text-[11px] font-medium" style={{ color: riskColors[entry.risk] }}>{t(riskKeyMap[entry.risk])}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog open={showConfirm} onConfirm={handleFix} onCancel={() => setShowConfirm(false)}
        title={t('confirmFixTitle')} description={t('confirmFixDescription', { count: selectedCount })}
        confirmLabel={t('confirmFixLabel')} variant="warning" />
    </div>
  )
}
