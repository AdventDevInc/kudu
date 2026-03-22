import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  HardDrive,
  Sparkles,
  FileStack,
  Search,
  Database,
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
  Gamepad2,
  BarChart3,
  MemoryStick
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
import { useGameModeStore } from '@/stores/game-mode-store'
import type { DriveInfo, ScanResult, CleanResult, PerfQuickStats } from '@shared/types'
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

// ── Gauge colors ─────────────────────────────────────────────

function gaugeColor(pct: number): string {
  if (pct >= 85) return '#ef4444'
  if (pct >= 60) return '#f59e0b'
  return '#22c55e'
}

// ── Component ────────────────────────────────────────────────

export function DashboardPage() {
  const { t } = useTranslation('dashboard')
  const { features, platform } = usePlatform()
  const stats = useStatsStore((s) => s.stats)
  const recomputeStats = useStatsStore((s) => s.recompute)
  const isCloudLinked = !!useSettingsStore((s) => s.settings.cloud.apiKey)
  const historyStore = useHistoryStore()
  const scanStore = useScanStore()
  const updaterHasChecked = useUpdaterStore((s) => s.hasChecked)
  const serviceHasScanned = useServiceStore((s) => s.hasScanned)
  const startupItems = useStartupStore((s) => s.items)
  const gameModeActive = useGameModeStore((s) => s.active)
  const gameModeActivatedAt = useGameModeStore((s) => s.activatedAt)
  const cleanStartRef = useRef<number>(0)
  const navigate = useNavigate()
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [phase, setPhase] = useState<OneClickPhase>('idle')
  const [phaseLabel, setPhaseLabel] = useState('')
  const [result, setResult] = useState<OneClickResult | null>(null)
  const [showQuickConfirm, setShowQuickConfirm] = useState(false)
  const [showFullConfirm, setShowFullConfirm] = useState(false)
  const [stepProgress, setStepProgress] = useState({ current: 0, total: 0 })

  // ── Lightweight system metrics (no heavy process polling) ──
  const [perf, setPerf] = useState<PerfQuickStats | null>(null)

  useEffect(() => {
    let cancelled = false
    // Initial sample seeds the CPU diff; first result will read 0%
    window.kudu?.perfQuickStats?.().catch(() => {})
    const poll = async () => {
      try {
        const data = await window.kudu?.perfQuickStats?.()
        if (!cancelled && data) setPerf(data)
      } catch { /* best effort */ }
    }
    // Poll every 3s — uses only os.cpus()/os.freemem(), near-zero cost
    const iv = setInterval(poll, 3000)
    // First real read after 1s (gives CPU diff time to accumulate)
    const initial = setTimeout(poll, 1000)
    return () => { cancelled = true; clearInterval(iv); clearTimeout(initial) }
  }, [])

  // ── Game Mode elapsed timer ────────────────────────────────
  const [gmElapsed, setGmElapsed] = useState(0)
  useEffect(() => {
    if (!gameModeActive || !gameModeActivatedAt) { setGmElapsed(0); return }
    const start = new Date(gameModeActivatedAt).getTime()
    const tick = () => setGmElapsed(Date.now() - start)
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [gameModeActive, gameModeActivatedAt])

  const refreshDrives = useCallback(() => {
    window.kudu?.diskDrives?.().then(setDrives).catch(() => {})
  }, [])

  useEffect(() => { refreshDrives() }, [refreshDrives])

  // ── Health score ───────────────────────────────────────────

  const toolCoverage = (() => {
    const entries = historyStore.entries
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000
    const recentEntries = entries.filter((e) => new Date(e.timestamp).getTime() > twoWeeksAgo)
    const recentTypes = new Set(recentEntries.map((e) => e.type))
    const allTypes = new Set(entries.map((e) => e.type))

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
    const totalTools = toolCoverage.length
    const doneTools = toolCoverage.filter((t) => t.usedRecently).length
    let score = Math.round((doneTools / totalTools) * 60)

    if (drives.length > 0) {
      const worstUsage = Math.max(...drives.map((d) => d.usedSpace / d.totalSize))
      if (worstUsage > 0.7) {
        score -= Math.min(20, Math.round((worstUsage - 0.7) / 0.3 * 20))
      }
    }

    if (stats.lastScanDate) {
      const daysSinceScan = (Date.now() - new Date(stats.lastScanDate).getTime()) / (1000 * 60 * 60 * 24)
      score -= Math.min(20, Math.round(daysSinceScan * (20 / 7)))
    } else {
      score -= 10
    }

    if (stats.lastScanDate) score += 40
    return Math.max(0, Math.min(100, score))
  })()

  // ── One-click clean callbacks (unchanged logic) ────────────

  const runCleaners = useCallback(async (): Promise<{ space: number; files: number }> => {
    const excluded = scanStore.excludedSubcategories
    let totalSpace = 0
    let totalFiles = 0

    for (const { type, scan, clean } of CLEANER_SCAN_FNS) {
      try {
        setPhaseLabel(t('phaseLabelScanningType', { type }))
        const results = await scan()
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
      spaceRecovered: space, filesCleaned: files, registryFixed: regFixed,
      driversRemoved: 0, threatsFound: 0, threatsQuarantined: 0,
      privacyScore: 0, privacyIssues: 0, startupHighImpact: 0, updatesAvailable: 0
    }

    const totalItems = files + regFixed
    if (totalItems > 0) {
      await historyStore.addEntry({
        id: Date.now().toString(), type: 'cleaner', timestamp: new Date().toISOString(),
        duration: Date.now() - cleanStartRef.current, totalItemsFound: totalItems,
        totalItemsCleaned: totalItems, totalItemsSkipped: 0, totalSpaceSaved: space,
        categories: [
          ...(files > 0 ? [{ name: 'Quick Clean', itemsFound: files, itemsCleaned: files, spaceSaved: space }] : []),
          ...(regFixed > 0 ? [{ name: 'Registry', itemsFound: regFixed, itemsCleaned: regFixed, spaceSaved: 0 }] : [])
        ],
        errorCount: 0
      })
      recomputeStats()
    }

    setResult(oneClickResult)
    setPhase('done')
    setPhaseLabel('')
    refreshDrives()
  }, [phase, runCleaners, runRegistry, historyStore, recomputeStats, features])

  const handleFullClean = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'done') return
    cleanStartRef.current = Date.now()
    setPhase('scanning')
    setResult(null)
    const totalSteps = 5 + (features.registry ? 1 : 0) + (features.drivers ? 1 : 0)
    let step = 0
    setStepProgress({ current: step, total: totalSteps })

    setPhase('cleaning')
    setStepProgress({ current: ++step, total: totalSteps })
    const { space, files } = await runCleaners()
    let regFixed = 0
    if (features.registry) { setStepProgress({ current: ++step, total: totalSteps }); regFixed = await runRegistry() }
    let drivers = { removed: 0, space: 0 }
    if (features.drivers) { setStepProgress({ current: ++step, total: totalSteps }); drivers = await runDrivers() }

    setStepProgress({ current: ++step, total: totalSteps })
    const malware = await runMalwareScan()
    setStepProgress({ current: ++step, total: totalSteps })
    const privacy = await runPrivacyCheck()
    setStepProgress({ current: ++step, total: totalSteps })
    const startupHighImpact = await runStartupCheck()
    setStepProgress({ current: ++step, total: totalSteps })
    const updatesAvailable = await runSoftwareUpdateCheck()

    const oneClickResult: OneClickResult = {
      spaceRecovered: space + drivers.space, filesCleaned: files, registryFixed: regFixed,
      driversRemoved: drivers.removed, threatsFound: malware.found,
      threatsQuarantined: malware.quarantined, privacyScore: privacy.score,
      privacyIssues: privacy.issues, startupHighImpact, updatesAvailable
    }

    const totalItems = files + regFixed + drivers.removed + malware.quarantined
    if (totalItems > 0 || malware.found > 0) {
      await historyStore.addEntry({
        id: Date.now().toString(), type: 'cleaner', timestamp: new Date().toISOString(),
        duration: Date.now() - cleanStartRef.current,
        totalItemsFound: totalItems + malware.found, totalItemsCleaned: totalItems,
        totalItemsSkipped: 0, totalSpaceSaved: space + drivers.space,
        categories: [
          ...(files > 0 ? [{ name: 'Full Clean', itemsFound: files, itemsCleaned: files, spaceSaved: space }] : []),
          ...(regFixed > 0 ? [{ name: 'Registry', itemsFound: regFixed, itemsCleaned: regFixed, spaceSaved: 0 }] : []),
          ...(drivers.removed > 0 ? [{ name: 'Stale Drivers', itemsFound: drivers.removed, itemsCleaned: drivers.removed, spaceSaved: drivers.space }] : []),
          ...(malware.quarantined > 0 ? [{ name: 'Malware', itemsFound: malware.found, itemsCleaned: malware.quarantined, spaceSaved: 0 }] : [])
        ],
        errorCount: 0
      })
      recomputeStats()
    }

    setResult(oneClickResult)
    setPhase('done')
    setPhaseLabel('')
    refreshDrives()
  }, [phase, runCleaners, runRegistry, runDrivers, runMalwareScan, runPrivacyCheck, runStartupCheck, runSoftwareUpdateCheck, historyStore, recomputeStats, features])

  const isRunning = phase === 'scanning' || phase === 'cleaning'

  // ── Helpers ────────────────────────────────────────────────

  const cpuPct = perf?.cpuPercent ?? 0
  const ramPct = perf?.memPercent ?? 0
  const diskPct = drives.length > 0
    ? Math.round((drives.reduce((s, d) => s + d.usedSpace, 0) / drives.reduce((s, d) => s + d.totalSize, 0)) * 100)
    : 0

  function formatGmElapsed(ms: number): string {
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="animate-fade-in flex h-full flex-col overflow-y-auto">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      <div className="flex-1 space-y-5 px-0 pb-8">
        {/* ── System Gauges Row ────────────────────────── */}
        <div className="grid grid-cols-4 gap-3">
          <MiniGauge icon={Cpu} label={t('gaugeCpu')} percent={Math.round(cpuPct)} detail={`${Math.round(cpuPct)}%`} />
          <MiniGauge icon={MemoryStick} label={t('gaugeRam')} percent={Math.round(ramPct)} detail={perf ? `${formatBytes(perf.memUsedBytes)} / ${formatBytes(perf.memTotalBytes)}` : '—'} />
          <MiniGauge icon={HardDrive} label={t('gaugeDisk')} percent={diskPct} detail={`${diskPct}% ${t('gaugeDiskUsed')}`} />
          <MiniGauge icon={BarChart3} label={t('gaugeScans')} percent={Math.min(100, stats.totalScans * 10)} detail={`${stats.totalScans} ${t('gaugeScansRun')}`} />
        </div>

        {/* ── Hero Row: Health + Game Mode ─────────────── */}
        <div className="grid grid-cols-2 gap-4">
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

          {/* Game Mode Card */}
          {features.gameMode ? (
            <button
              onClick={() => navigate('/game-mode')}
              className="group relative flex flex-col items-center justify-center rounded-2xl px-6 py-6 text-center transition-all"
              style={{
                background: gameModeActive
                  ? 'linear-gradient(180deg, rgba(6,182,212,0.08) 0%, rgba(139,92,246,0.04) 100%)'
                  : '#16161a',
                border: `1px solid ${gameModeActive ? 'rgba(6,182,212,0.2)' : 'rgba(255,255,255,0.05)'}`,
                animation: gameModeActive ? 'game-mode-pulse 2.5s ease-in-out infinite' : undefined,
              }}
            >
              <div
                className="flex h-14 w-14 items-center justify-center rounded-full transition-all"
                style={{
                  background: gameModeActive
                    ? 'linear-gradient(135deg, #06b6d4, #8b5cf6)'
                    : 'rgba(255,255,255,0.05)',
                  border: `2px solid ${gameModeActive ? '#06b6d4' : 'rgba(255,255,255,0.08)'}`,
                }}
              >
                <Gamepad2
                  className="h-6 w-6"
                  style={{ color: gameModeActive ? '#fff' : '#52525b' }}
                  strokeWidth={2}
                />
              </div>
              <span
                className="mt-3 text-xs font-bold tracking-[0.2em]"
                style={{ color: gameModeActive ? '#06b6d4' : '#52525b' }}
              >
                {gameModeActive ? t('gameModeActive') : t('gameModeReady')}
              </span>
              {gameModeActive && gameModeActivatedAt && (
                <span className="mt-1 font-mono text-lg font-semibold tabular-nums" style={{ color: '#06b6d4' }}>
                  {formatGmElapsed(gmElapsed)}
                </span>
              )}
              {!gameModeActive && (
                <span className="mt-1 text-[11px] text-zinc-600 group-hover:text-zinc-400 transition-colors">
                  {t('gameModeClickToOpen')}
                </span>
              )}
            </button>
          ) : (
            /* Non-Windows: Status block instead of Game Mode */
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
                  <span className="text-[12px] font-medium text-zinc-300">{formatNumber(stats.totalScans)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Stats Row ───────────────────────────────── */}
        <div className="grid grid-cols-3 gap-4">
          <StatCard icon={HardDrive} label={t('statSpaceRecovered')} value={stats.totalSpaceSaved} displayValue={formatBytes(stats.totalSpaceSaved)} variant="accent" />
          <StatCard icon={FileStack} label={t('statFilesCleaned')} value={stats.totalFilesCleaned} variant="success" />
          <StatCard icon={BarChart3} label={t('statTotalScans')} value={stats.totalScans} />
        </div>

        {/* ── Action Buttons ──────────────────────────── */}
        <div className="grid grid-cols-2 gap-4">
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
            </div>
          </button>
        </div>

        {/* ── Progress / result banner ─────────────────── */}
        {isRunning && (
          <div
            className="rounded-2xl px-5 py-4"
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
            className="rounded-2xl p-4"
            style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.1)' }}
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" strokeWidth={1.8} />
              <div>
                <p className="text-[13px] font-medium text-zinc-200">{t('resultCleanupComplete')}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
                  {result.spaceRecovered > 0 && <p className="text-[12px]" style={{ color: '#6e6e76' }}>{t('resultSpaceRecovered', { size: formatBytes(result.spaceRecovered) })}</p>}
                  {result.filesCleaned > 0 && <p className="text-[12px]" style={{ color: '#6e6e76' }}>{t('resultFilesCleaned', { count: formatNumber(result.filesCleaned) })}</p>}
                  {result.registryFixed > 0 && <p className="text-[12px]" style={{ color: '#6e6e76' }}>{t('resultRegistryFixed', { count: result.registryFixed })}</p>}
                  {result.driversRemoved > 0 && <p className="text-[12px]" style={{ color: '#6e6e76' }}>{t('resultDriversRemoved', { count: result.driversRemoved })}</p>}
                  {result.threatsFound > 0 && (
                    <p className="text-[12px]" style={{ color: result.threatsQuarantined > 0 ? '#22c55e' : '#ef4444' }}>
                      {t(result.threatsQuarantined !== 1 ? 'resultThreatsQuarantinedPlural' : 'resultThreatsQuarantined', { count: result.threatsQuarantined })}
                    </p>
                  )}
                  {result.threatsFound === 0 && result.privacyScore > 0 && <p className="text-[12px]" style={{ color: '#6e6e76' }}>{t('resultNoThreatsFound')}</p>}
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
                    <p className="text-[12px]" style={{ color: '#6e6e76' }}>{t('resultSystemAlreadyClean')}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Storage Overview ─────────────────────────── */}
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
              <DriveBar key={drive.letter} drive={drive} platform={platform} />
            ))}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showQuickConfirm}
        onConfirm={() => { setShowQuickConfirm(false); handleQuickClean() }}
        onCancel={() => setShowQuickConfirm(false)}
        title={t('quickCleanConfirmTitle')}
        description={features.registry ? t('quickCleanConfirmDescriptionWithRegistry') : t('quickCleanConfirmDescriptionWithoutRegistry')}
        confirmLabel={t('quickCleanConfirmLabel')}
        variant="warning"
      />

      <ConfirmDialog
        open={showFullConfirm}
        onConfirm={() => { setShowFullConfirm(false); handleFullClean() }}
        onCancel={() => setShowFullConfirm(false)}
        title={t('fullCleanConfirmTitle')}
        description={features.registry ? t('fullCleanConfirmDescriptionWithRegistry') : t('fullCleanConfirmDescriptionWithoutRegistry')}
        confirmLabel={t('fullCleanConfirmLabel')}
        variant="warning"
      />
    </div>
  )
}

// ── Mini Gauge (inline, no separate file) ────────────────────

function MiniGauge({ icon: Icon, label, percent, detail }: {
  icon: typeof Cpu
  label: string
  percent: number
  detail: string
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  const color = gaugeColor(clamped)
  const SIZE = 52
  const STROKE = 3.5
  const R = (SIZE - STROKE * 2) / 2
  const C = 2 * Math.PI * R
  const offset = C - (clamped / 100) * C

  return (
    <div
      className="flex items-center gap-3.5 rounded-xl px-4 py-3.5"
      style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="relative inline-flex shrink-0 items-center justify-center">
        <svg width={SIZE} height={SIZE} className="-rotate-90">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={STROKE} />
          <circle
            cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke={color} strokeWidth={STROKE}
            strokeLinecap="round" strokeDasharray={C} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.16,1,0.3,1)' }}
          />
        </svg>
        <Icon className="absolute h-4 w-4" style={{ color }} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-zinc-200">{label}</p>
        <p className="truncate text-[11px]" style={{ color: '#6e6e76' }}>{detail}</p>
      </div>
    </div>
  )
}

// ── Drive Bar ────────────────────────────────────────────────

function DriveBar({ drive, platform }: { drive: DriveInfo; platform: string }) {
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
