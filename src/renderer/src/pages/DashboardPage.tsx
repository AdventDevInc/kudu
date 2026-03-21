import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  HardDrive,
  Sparkles,
  FileStack,
  Search,
  Database,
  BarChart3,
  Trash2,
  Zap,
  Shield,
  CheckCircle2,
  Wifi,
  Loader2,
  Cpu,
  Check,
  Download,
  Server,
  Cloud,
  CloudOff
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { StatCard } from '@/components/shared/StatCard'
import { HealthScore } from '@/components/shared/HealthScore'
import { cn, formatBytes, formatDate, formatNumber } from '@/lib/utils'
import { useStatsStore } from '@/stores/stats-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useHistoryStore } from '@/stores/history-store'
import { useScanStore } from '@/stores/scan-store'
import { useUpdaterStore } from '@/stores/updater-store'
import { useServiceStore } from '@/stores/service-store'
import { useStartupStore } from '@/stores/startup-store'
import type { DriveInfo, ActivityEntry, ScanResult, CleanResult } from '@shared/types'
import { CleanerType } from '@shared/enums'
import { usePlatform } from '@/hooks/usePlatform'

type OneClickPhase = 'idle' | 'scanning' | 'cleaning' | 'done'

interface OneClickResult {
  spaceRecovered: number
  filesCleaned: number
  registryFixed: number
  driversRemoved: number
  threatsFound: number
  threatsQuarantined: number
  privacyScore: number
  privacyIssues: number
  startupHighImpact: number
  updatesAvailable: number
}

const CLEANER_SCAN_FNS: { type: CleanerType; scan: () => Promise<ScanResult[]>; clean: (ids: string[]) => Promise<CleanResult> }[] = [
  { type: CleanerType.System, scan: () => window.kudu.systemScan(), clean: (ids) => window.kudu.systemClean(ids) },
  { type: CleanerType.Browser, scan: () => window.kudu.browserScan(), clean: (ids) => window.kudu.browserClean(ids) },
  { type: CleanerType.App, scan: () => window.kudu.appScan(), clean: (ids) => window.kudu.appClean(ids) },
  { type: CleanerType.Gaming, scan: () => window.kudu.gamingScan(), clean: (ids) => window.kudu.gamingClean(ids) },
  { type: CleanerType.RecycleBin, scan: () => window.kudu.recycleBinScan(), clean: () => window.kudu.recycleBinClean() },
  { type: CleanerType.Database, scan: () => window.kudu.databaseScan(), clean: (ids) => window.kudu.databaseClean(ids) },
]

export function DashboardPage() {
  const { t } = useTranslation('dashboard')
  const { features } = usePlatform()
  const stats = useStatsStore((s) => s.stats)
  const recomputeStats = useStatsStore((s) => s.recompute)
  const isCloudLinked = !!useSettingsStore((s) => s.settings.cloud.apiKey)
  const historyStore = useHistoryStore()
  const scanStore = useScanStore()
  const updaterHasChecked = useUpdaterStore((s) => s.hasChecked)
  const serviceHasScanned = useServiceStore((s) => s.hasScanned)
  const startupItems = useStartupStore((s) => s.items)
  const cleanStartRef = useRef<number>(0)
  const navigate = useNavigate()
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [phase, setPhase] = useState<OneClickPhase>('idle')
  const [phaseLabel, setPhaseLabel] = useState('')
  const [result, setResult] = useState<OneClickResult | null>(null)
  const [showQuickConfirm, setShowQuickConfirm] = useState(false)
  const [showFullConfirm, setShowFullConfirm] = useState(false)
  const [stepProgress, setStepProgress] = useState({ current: 0, total: 0 })

  useEffect(() => {
    window.kudu?.diskDrives?.()
      .then(setDrives)
      .catch((err) => console.error('Failed to load drives:', err))
  }, [])

  // Determine which tools have been used recently (past 14 days)
  const toolCoverage = (() => {
    const entries = historyStore.entries
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000
    const recentEntries = entries.filter((e) => new Date(e.timestamp).getTime() > twoWeeksAgo)
    const recentTypes = new Set(recentEntries.map((e) => e.type))
    const allTypes = new Set(entries.map((e) => e.type))

    // History-based tools
    const historyTools = [
      { key: 'cleaner' as const, label: t('toolLabelCleaner'), icon: Search, color: '#f59e0b' },
      ...(features.registry ? [{ key: 'registry' as const, label: t('toolLabelRegistry'), icon: Database, color: '#3b82f6' }] : []),
      ...(features.drivers ? [{ key: 'drivers' as const, label: t('toolLabelDrivers'), icon: Cpu, color: '#a855f7' }] : [])
    ]

    const historyResults = historyTools.map((t) => ({
      ...t,
      usedRecently: recentTypes.has(t.key),
      usedEver: allTypes.has(t.key)
    }))

    // Session-based tools (tracked by whether they've been run this session)
    const sessionTools = [
      { key: 'updater', label: t('toolLabelUpdater'), icon: Download, color: '#06b6d4', active: updaterHasChecked },
      { key: 'services', label: t('toolLabelServices'), icon: Server, color: '#ec4899', active: serviceHasScanned },
      { key: 'startup', label: t('toolLabelStartup'), icon: Zap, color: '#22c55e', active: startupItems.length > 0 }
    ]

    const sessionResults = sessionTools.map((t) => ({
      key: t.key,
      label: t.label,
      icon: t.icon,
      color: t.color,
      usedRecently: t.active,
      usedEver: t.active
    }))

    return [...historyResults, ...sessionResults]
  })()

  const healthScore = (() => {
    // Health is primarily driven by tool coverage shown in the icons
    const totalTools = toolCoverage.length
    const doneTools = toolCoverage.filter((t) => t.usedRecently).length

    // Base score from tool coverage (0-60 points)
    let score = Math.round((doneTools / totalTools) * 60)

    // Drive space penalty: lose up to 20 points based on worst drive usage
    if (drives.length > 0) {
      const worstUsage = Math.max(...drives.map((d) => d.usedSpace / d.totalSize))
      if (worstUsage > 0.7) {
        score -= Math.min(20, Math.round((worstUsage - 0.7) / 0.3 * 20))
      }
    }

    // Recency penalty: lose up to 20 points as last scan ages (stale after 7 days)
    if (stats.lastScanDate) {
      const daysSinceScan = (Date.now() - new Date(stats.lastScanDate).getTime()) / (1000 * 60 * 60 * 24)
      score -= Math.min(20, Math.round(daysSinceScan * (20 / 7)))
    } else {
      score -= 10
    }

    // Base bonus for having run at least one scan ever
    if (stats.lastScanDate) score += 40

    return Math.max(0, Math.min(100, score))
  })()

  // Scan+clean file categories, respecting excluded subcategories from scan-store
  const runCleaners = useCallback(async (): Promise<{ space: number; files: number }> => {
    const excluded = scanStore.excludedSubcategories
    let totalSpace = 0
    let totalFiles = 0

    for (const { type, scan, clean } of CLEANER_SCAN_FNS) {
      try {
        setPhaseLabel(t('phaseLabelScanningType', { type }))
        const results = await scan()
        // Select items from non-excluded subcategories
        const selectedIds = results
          .filter((r) => !excluded.has(r.subcategory))
          .flatMap((r) => r.items.map((i) => i.id))
        if (selectedIds.length > 0) {
          setPhaseLabel(t('phaseLabelCleaningType', { type }))
          const res = await clean(selectedIds)
          totalSpace += res.totalCleaned || 0
          totalFiles += res.filesDeleted || 0
        }
      } catch {
        toast.error(t('toastFailedToCleanType', { type }))
      }
    }
    return { space: totalSpace, files: totalFiles }
  }, [scanStore.excludedSubcategories, t])

  // Scan+fix registry
  const runRegistry = useCallback(async (): Promise<number> => {
    try {
      setPhaseLabel(t('phaseLabelScanningRegistry'))
      const entries = await window.kudu.registryScan()
      if (!Array.isArray(entries)) return 0
      const selectedIds = entries.filter((e) => e?.selected).map((e) => e.id)
      if (selectedIds.length === 0) return 0
      setPhaseLabel(t('phaseLabelFixingRegistry'))
      const res = await window.kudu.registryFix(selectedIds)
      return res?.fixed ?? 0
    } catch {
      toast.error(t('toastRegistryScanFailed'))
      return 0
    }
  }, [t])

  // Scan for malware and quarantine threats
  const runMalwareScan = useCallback(async (): Promise<{ found: number; quarantined: number }> => {
    try {
      setPhaseLabel(t('phaseLabelScanningMalware'))
      const result = await window.kudu.malwareScan()
      if (result.threats.length === 0) return { found: 0, quarantined: 0 }
      setPhaseLabel(t('phaseLabelQuarantiningThreats'))
      const paths = result.threats.map((t) => t.path)
      const actionResult = await window.kudu.malwareQuarantine(paths)
      return { found: result.threats.length, quarantined: actionResult.succeeded }
    } catch {
      toast.error(t('toastMalwareScanFailed'))
      return { found: 0, quarantined: 0 }
    }
  }, [t])

  // Check privacy settings (report only)
  const runPrivacyCheck = useCallback(async (): Promise<{ score: number; issues: number }> => {
    try {
      setPhaseLabel(t('phaseLabelCheckingPrivacy'))
      const state = await window.kudu.privacyScan()
      return { score: state.score, issues: state.total - state.protected }
    } catch {
      toast.error(t('toastPrivacyCheckFailed'))
      return { score: 0, issues: 0 }
    }
  }, [t])

  // Check startup items (report only)
  const runStartupCheck = useCallback(async (): Promise<number> => {
    try {
      setPhaseLabel(t('phaseLabelCheckingStartup'))
      const items = await window.kudu.startupList()
      return items.filter((i) => i.enabled && i.impact === 'high').length
    } catch {
      toast.error(t('toastStartupCheckFailed'))
      return 0
    }
  }, [t])

  // Check for software updates (report only)
  const runSoftwareUpdateCheck = useCallback(async (): Promise<number> => {
    try {
      setPhaseLabel(t('phaseLabelCheckingSoftwareUpdates'))
      const result = await window.kudu.softwareUpdateCheck()
      return result.apps.length
    } catch {
      toast.error(t('toastSoftwareUpdateCheckFailed'))
      return 0
    }
  }, [t])

  // Scan+remove stale drivers (excludes driver updates)
  const runDrivers = useCallback(async (): Promise<{ removed: number; space: number }> => {
    try {
      setPhaseLabel(t('phaseLabelScanningDrivers'))
      const scanResult = await window.kudu.driverScan()
      const stalePackages = scanResult.packages.filter((p) => !p.isCurrent && p.selected)
      if (stalePackages.length === 0) return { removed: 0, space: 0 }
      setPhaseLabel(t('phaseLabelRemovingStaleDrivers'))
      const cleanResult = await window.kudu.driverClean(stalePackages.map((p) => p.publishedName))
      return { removed: cleanResult.removed, space: cleanResult.spaceRecovered }
    } catch {
      toast.error(t('toastDriverCleanupFailed'))
      return { removed: 0, space: 0 }
    }
  }, [t])

  const handleQuickClean = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'done') return
    cleanStartRef.current = Date.now()
    setPhase('scanning')
    setResult(null)
    setStepProgress({ current: 0, total: 2 })

    setPhase('cleaning')
    setStepProgress({ current: 1, total: 2 })
    const { space, files } = await runCleaners()
    setStepProgress({ current: 2, total: 2 })
    const regFixed = features.registry ? await runRegistry() : 0

    const oneClickResult: OneClickResult = {
      spaceRecovered: space,
      filesCleaned: files,
      registryFixed: regFixed,
      driversRemoved: 0,
      threatsFound: 0,
      threatsQuarantined: 0,
      privacyScore: 0,
      privacyIssues: 0,
      startupHighImpact: 0,
      updatesAvailable: 0
    }

    const totalItems = files + regFixed
    if (totalItems > 0) {
      await historyStore.addEntry({
        id: Date.now().toString(),
        type: 'cleaner',
        timestamp: new Date().toISOString(),
        duration: Date.now() - cleanStartRef.current,
        totalItemsFound: totalItems,
        totalItemsCleaned: totalItems,
        totalItemsSkipped: 0,
        totalSpaceSaved: space,
        categories: [
          ...(files > 0
            ? [{ name: 'Quick Clean', itemsFound: files, itemsCleaned: files, spaceSaved: space }]
            : []),
          ...(regFixed > 0
            ? [{ name: 'Registry', itemsFound: regFixed, itemsCleaned: regFixed, spaceSaved: 0 }]
            : [])
        ],
        errorCount: 0
      })
      recomputeStats()
    }

    setResult(oneClickResult)
    setPhase('done')
    setPhaseLabel('')
  }, [phase, runCleaners, runRegistry, historyStore, recomputeStats, features])

  const handleFullClean = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'done') return
    cleanStartRef.current = Date.now()
    setPhase('scanning')
    setResult(null)
    const totalSteps = 5 + (features.registry ? 1 : 0) + (features.drivers ? 1 : 0)
    let step = 0
    setStepProgress({ current: step, total: totalSteps })

    // Clean
    setPhase('cleaning')
    setStepProgress({ current: ++step, total: totalSteps })
    const { space, files } = await runCleaners()
    let regFixed = 0
    if (features.registry) {
      setStepProgress({ current: ++step, total: totalSteps })
      regFixed = await runRegistry()
    }
    let drivers = { removed: 0, space: 0 }
    if (features.drivers) {
      setStepProgress({ current: ++step, total: totalSteps })
      drivers = await runDrivers()
    }

    // Protect
    setStepProgress({ current: ++step, total: totalSteps })
    const malware = await runMalwareScan()
    setStepProgress({ current: ++step, total: totalSteps })
    const privacy = await runPrivacyCheck()

    // Optimize
    setStepProgress({ current: ++step, total: totalSteps })
    const startupHighImpact = await runStartupCheck()
    setStepProgress({ current: ++step, total: totalSteps })
    const updatesAvailable = await runSoftwareUpdateCheck()

    const oneClickResult: OneClickResult = {
      spaceRecovered: space + drivers.space,
      filesCleaned: files,
      registryFixed: regFixed,
      driversRemoved: drivers.removed,
      threatsFound: malware.found,
      threatsQuarantined: malware.quarantined,
      privacyScore: privacy.score,
      privacyIssues: privacy.issues,
      startupHighImpact,
      updatesAvailable
    }

    const totalItems = files + regFixed + drivers.removed + malware.quarantined
    if (totalItems > 0 || malware.found > 0) {
      await historyStore.addEntry({
        id: Date.now().toString(),
        type: 'cleaner',
        timestamp: new Date().toISOString(),
        duration: Date.now() - cleanStartRef.current,
        totalItemsFound: totalItems + malware.found,
        totalItemsCleaned: totalItems,
        totalItemsSkipped: 0,
        totalSpaceSaved: space + drivers.space,
        categories: [
          ...(files > 0
            ? [{ name: 'Full Clean', itemsFound: files, itemsCleaned: files, spaceSaved: space }]
            : []),
          ...(regFixed > 0
            ? [{ name: 'Registry', itemsFound: regFixed, itemsCleaned: regFixed, spaceSaved: 0 }]
            : []),
          ...(drivers.removed > 0
            ? [{ name: 'Stale Drivers', itemsFound: drivers.removed, itemsCleaned: drivers.removed, spaceSaved: drivers.space }]
            : []),
          ...(malware.quarantined > 0
            ? [{ name: 'Malware', itemsFound: malware.found, itemsCleaned: malware.quarantined, spaceSaved: 0 }]
            : [])
        ],
        errorCount: 0
      })
      recomputeStats()
    }

    setResult(oneClickResult)
    setPhase('done')
    setPhaseLabel('')
  }, [phase, runCleaners, runRegistry, runDrivers, runMalwareScan, runPrivacyCheck, runStartupCheck, runSoftwareUpdateCheck, historyStore, recomputeStats, features])

  const isRunning = phase === 'scanning' || phase === 'cleaning'
  const activity = stats.recentActivity

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      {/* Hero row — health + stats */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        {/* Health Score Card */}
        <div
          className="flex flex-col items-center justify-center rounded-2xl px-6 py-6"
          style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
        >
          <HealthScore score={healthScore} size="md" />
          <div className="mt-4 flex items-center gap-2">
            {toolCoverage.map((tool) => {
              const Icon = tool.icon
              return (
                <div
                  key={tool.key}
                  className="relative flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                  style={{
                    background: tool.usedRecently ? tool.color + '18' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${tool.usedRecently ? tool.color + '30' : 'rgba(255,255,255,0.04)'}`
                  }}
                  title={`${tool.label}: ${tool.usedRecently ? t('toolTipUsedRecently') : tool.usedEver ? t('toolTipNotUsedRecently') : t('toolTipNeverUsed')}`}
                >
                  <Icon
                    className="h-3.5 w-3.5"
                    style={{ color: tool.usedRecently ? tool.color : '#3a3a42' }}
                    strokeWidth={1.8}
                  />
                  {tool.usedRecently && (
                    <div
                      className="absolute -top-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full"
                      style={{ background: '#22c55e' }}
                    >
                      <Check className="h-2 w-2 text-white" strokeWidth={3} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <StatCard
          icon={HardDrive}
          label={t('statSpaceRecovered')}
          value={stats.totalSpaceSaved}
          displayValue={formatBytes(stats.totalSpaceSaved)}
          variant="accent"
        />
        <StatCard
          icon={FileStack}
          label={t('statFilesCleaned')}
          value={stats.totalFilesCleaned}
          variant="success"
        />
        {/* Status block */}
        <div
          className="flex flex-col justify-center rounded-2xl px-5 py-4"
          style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
        >
          <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
            {t('statusHeading')}
          </h3>
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px]" style={{ color: '#6e6e76' }}>{t('statusLastScan')}</span>
              <span className="text-[12px] font-medium text-zinc-300">
                {stats.lastScanDate ? formatDate(stats.lastScanDate) : t('statusLastScanNever')}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px]" style={{ color: '#6e6e76' }}>{t('statusTotalScans')}</span>
              <span className="text-[12px] font-medium text-zinc-300">
                {formatNumber(stats.totalScans)}
              </span>
            </div>
            <button
              onClick={() => navigate('/settings')}
              className="flex w-full items-center justify-between rounded-lg px-0 py-0 transition-colors group"
            >
              <span className="text-[12px]" style={{ color: '#6e6e76' }}>{t('statusCloud')}</span>
              <span className="flex items-center gap-1.5 text-[12px] font-medium group-hover:underline" style={{ color: isCloudLinked ? '#22c55e' : '#52525e' }}>
                {isCloudLinked ? (
                  <><Cloud className="h-3 w-3" strokeWidth={2} /> {t('statusCloudConnected')}</>
                ) : (
                  <><CloudOff className="h-3 w-3" strokeWidth={2} /> {t('statusCloudNotConnected')}</>
                )}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* One-click actions row */}
      <div className="mb-6 grid grid-cols-2 gap-4">
        {/* Quick Clean */}
        <button
          onClick={() => setShowQuickConfirm(true)}
          disabled={isRunning}
          className={cn(
            'group relative flex items-center gap-4 rounded-2xl p-5 text-left transition-all disabled:opacity-60',
            !isRunning && 'hover:border-amber-500/20'
          )}
          style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
        >
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' }}
          >
            <Sparkles className="h-5 w-5" style={{ color: '#1a0a00' }} strokeWidth={2.2} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-zinc-200">{t('quickCleanTitle')}</p>
            <p className="text-[12px]" style={{ color: '#52525e' }}>
              {features.registry ? t('quickCleanDescriptionWithRegistry') : t('quickCleanDescriptionWithoutRegistry')}
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: '#3f3f46' }}>
              {t('quickCleanSubtext')}
            </p>
          </div>
        </button>

        {/* Full Clean */}
        <button
          onClick={() => setShowFullConfirm(true)}
          disabled={isRunning}
          className={cn(
            'group relative flex items-center gap-4 rounded-2xl p-5 text-left transition-all disabled:opacity-60',
            !isRunning && 'hover:border-blue-500/20'
          )}
          style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
        >
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' }}
          >
            <Shield className="h-5 w-5 text-white" strokeWidth={2.2} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-zinc-200">{t('fullCleanTitle')}</p>
            <p className="text-[12px]" style={{ color: '#52525e' }}>
              {features.registry ? t('fullCleanDescriptionWithRegistry') : t('fullCleanDescriptionWithoutRegistry')}
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: '#3f3f46' }}>
              {t('fullCleanSubtext')}
            </p>
          </div>
        </button>
      </div>

      {/* Progress / result banner */}
      {isRunning && (
        <div
          className="mb-6 rounded-2xl px-5 py-4"
          style={{ background: '#16161a', border: '1px solid rgba(245,158,11,0.15)' }}
        >
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-400" strokeWidth={2} />
            <span className="flex-1 text-[13px] text-zinc-400">{phaseLabel || t('progressWorking')}</span>
            {stepProgress.total > 0 && (
              <span className="text-[11px] font-mono" style={{ color: '#52525e' }}>
                {stepProgress.current}/{stepProgress.total}
              </span>
            )}
          </div>
          {stepProgress.total > 0 && (
            <div className="mt-2.5 h-[3px] overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${(stepProgress.current / stepProgress.total) * 100}%`, background: '#f59e0b' }}
              />
            </div>
          )}
        </div>
      )}

      {phase === 'done' && result && (
        <div
          className="mb-6 rounded-2xl p-4"
          style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.1)' }}
        >
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" strokeWidth={1.8} />
            <div>
              <p className="text-[13px] font-medium text-zinc-200">{t('resultCleanupComplete')}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
                {result.spaceRecovered > 0 && (
                  <p className="text-[12px]" style={{ color: '#6e6e76' }}>
                    {t('resultSpaceRecovered', { size: formatBytes(result.spaceRecovered) })}
                  </p>
                )}
                {result.filesCleaned > 0 && (
                  <p className="text-[12px]" style={{ color: '#6e6e76' }}>
                    {t('resultFilesCleaned', { count: formatNumber(result.filesCleaned) })}
                  </p>
                )}
                {result.registryFixed > 0 && (
                  <p className="text-[12px]" style={{ color: '#6e6e76' }}>
                    {t('resultRegistryFixed', { count: result.registryFixed })}
                  </p>
                )}
                {result.driversRemoved > 0 && (
                  <p className="text-[12px]" style={{ color: '#6e6e76' }}>
                    {t('resultDriversRemoved', { count: result.driversRemoved })}
                  </p>
                )}
                {result.threatsFound > 0 && (
                  <p className="text-[12px]" style={{ color: result.threatsQuarantined > 0 ? '#22c55e' : '#ef4444' }}>
                    {t(result.threatsQuarantined !== 1 ? 'resultThreatsQuarantinedPlural' : 'resultThreatsQuarantined', { count: result.threatsQuarantined })}
                  </p>
                )}
                {result.threatsFound === 0 && result.privacyScore > 0 && (
                  <p className="text-[12px]" style={{ color: '#6e6e76' }}>
                    {t('resultNoThreatsFound')}
                  </p>
                )}
                {result.privacyIssues > 0 && (
                  <button onClick={() => navigate('/hardening')} className="text-[12px] hover:underline" style={{ color: '#3b82f6' }}>
                    {t(result.privacyIssues !== 1 ? 'resultPrivacyImprovementsPlural' : 'resultPrivacyImprovements', { count: result.privacyIssues })} &rarr;
                  </button>
                )}
                {result.startupHighImpact > 0 && (
                  <button onClick={() => navigate('/startup')} className="text-[12px] hover:underline" style={{ color: '#3b82f6' }}>
                    {t(result.startupHighImpact !== 1 ? 'resultStartupHighImpactPlural' : 'resultStartupHighImpact', { count: result.startupHighImpact })} &rarr;
                  </button>
                )}
                {result.updatesAvailable > 0 && (
                  <button onClick={() => navigate('/updates')} className="text-[12px] hover:underline" style={{ color: '#3b82f6' }}>
                    {t(result.updatesAvailable !== 1 ? 'resultSoftwareUpdatesPlural' : 'resultSoftwareUpdates', { count: result.updatesAvailable })} &rarr;
                  </button>
                )}
                {result.spaceRecovered === 0 && result.filesCleaned === 0 && result.registryFixed === 0 && result.driversRemoved === 0 && result.threatsFound === 0 && result.privacyIssues === 0 && result.startupHighImpact === 0 && result.updatesAvailable === 0 && (
                  <p className="text-[12px]" style={{ color: '#6e6e76' }}>
                    {t('resultSystemAlreadyClean')}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Middle row — nav shortcuts + activity */}
      <div className="mb-6 grid grid-cols-2 gap-4">
        {/* Quick Navigation */}
        <div
          className="rounded-2xl p-5"
          style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
        >
          <h3 className="mb-4 text-[12px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
            {t('quickActionsHeading')}
          </h3>
          <div className="grid grid-cols-4 gap-2.5">
            <QuickAction icon={Search} label={t('quickActionCleaner')} onClick={() => navigate('/cleaner')} />
            {features.registry && <QuickAction icon={Database} label={t('quickActionRegistry')} onClick={() => navigate('/registry')} />}
            <QuickAction icon={Wifi} label={t('quickActionNetwork')} onClick={() => navigate('/network')} />
            <QuickAction icon={BarChart3} label={t('quickActionDiskMap')} onClick={() => navigate('/disk')} />
          </div>
        </div>

        {/* Recent Activity */}
        <div
          className="rounded-2xl p-5"
          style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
        >
          <h3 className="mb-4 text-[12px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
            {t('recentActivityHeading')}
          </h3>
          <div className="space-y-1">
            {activity.slice(0, 4).map((entry) => (
              <ActivityItem key={entry.id} entry={entry} />
            ))}
            {activity.length === 0 && (
              <p className="py-4 text-center text-[13px]" style={{ color: '#4e4e56' }}>
                {t('recentActivityEmpty')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Storage Overview */}
      <div
        className="rounded-2xl p-5"
        style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
      >
        <h3 className="mb-5 text-[12px] font-medium uppercase tracking-wider" style={{ color: '#52525e' }}>
          {t('storageOverviewHeading')}
        </h3>
        <div className="space-y-5">
          {drives.length === 0 && (
            <p className="py-4 text-center text-[13px]" style={{ color: '#4e4e56' }}>
              {t('storageOverviewEmpty')}
            </p>
          )}
          {drives.map((drive) => (
            <DriveBar key={drive.letter} drive={drive} />
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={showQuickConfirm}
        onConfirm={() => { setShowQuickConfirm(false); handleQuickClean() }}
        onCancel={() => setShowQuickConfirm(false)}
        title={t('quickCleanConfirmTitle')}
        description={features.registry
          ? t('quickCleanConfirmDescriptionWithRegistry')
          : t('quickCleanConfirmDescriptionWithoutRegistry')}
        confirmLabel={t('quickCleanConfirmLabel')}
        variant="warning"
      />

      <ConfirmDialog
        open={showFullConfirm}
        onConfirm={() => { setShowFullConfirm(false); handleFullClean() }}
        onCancel={() => setShowFullConfirm(false)}
        title={t('fullCleanConfirmTitle')}
        description={features.registry
          ? t('fullCleanConfirmDescriptionWithRegistry')
          : t('fullCleanConfirmDescriptionWithoutRegistry')}
        confirmLabel={t('fullCleanConfirmLabel')}
        variant="warning"
      />
    </div>
  )
}

function QuickAction({
  icon: Icon,
  label,
  onClick
}: {
  icon: typeof Search
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-2.5 rounded-xl py-4 text-zinc-500 transition-all hover:bg-white/5 hover:border-white/8 hover:text-zinc-300"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}
    >
      <Icon className="h-5 w-5" strokeWidth={1.6} />
      <span className="text-[12px] font-medium">{label}</span>
    </button>
  )
}

function ActivityItem({ entry }: { entry: ActivityEntry }) {
  const iconMap: Record<string, typeof Trash2> = { clean: Trash2, registry: Database, startup: Zap, scan: Search, drivers: Cpu, network: Wifi }
  const colorMap: Record<string, string> = { clean: '#f59e0b', registry: '#3b82f6', startup: '#22c55e', scan: '#6e6e76', drivers: '#a855f7', network: '#22c55e' }
  const Icon = iconMap[entry.type] || Search

  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2">
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: colorMap[entry.type] }} strokeWidth={1.8} />
      <span className="flex-1 truncate text-[13px] text-zinc-400">{entry.message}</span>
      <span className="shrink-0 text-[11px]" style={{ color: '#4e4e56' }}>{formatDate(entry.timestamp)}</span>
    </div>
  )
}

function DriveBar({ drive }: { drive: DriveInfo }) {
  const { platform } = usePlatform()
  const usedPercent = (drive.usedSpace / drive.totalSize) * 100
  const barColor = usedPercent > 90 ? '#ef4444' : usedPercent > 75 ? '#f59e0b' : '#22c55e'

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <HardDrive className="h-4 w-4" style={{ color: '#52525e' }} strokeWidth={1.6} />
          <span className="text-[13px] font-medium text-zinc-300">
            {platform === 'win32' ? `${drive.letter}: ${drive.label}` : `${drive.letter} ${drive.label}`}
          </span>
        </div>
        <span className="font-mono text-[11px]" style={{ color: '#6e6e76' }}>
          {formatBytes(drive.usedSpace)} / {formatBytes(drive.totalSize)}
        </span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }}>
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${usedPercent}%`, background: barColor }}
        />
      </div>
    </div>
  )
}
