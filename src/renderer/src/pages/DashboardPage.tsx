import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  HardDrive,
  Sparkles,
  Search,
  Database,
  Zap,
  Shield,
  CheckCircle2,
  Loader2,
  Cpu,
  Download,
  Server,
  Gamepad2,
  MemoryStick,
  AlertTriangle
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { MetricSparkline } from '@/components/perf/MetricSparkline'
import { QuickTelemetryChart } from '@/components/perf/QuickTelemetryChart'
import { useQuickTelemetry } from '@/hooks/useQuickTelemetry'
import {
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  Activity,
  History as HistoryIcon
} from 'lucide-react'
import { HealthScore } from '@/components/shared/HealthScore'
import { cn, formatBytes, formatDate, formatNumber } from '@/lib/utils'
import { cleanInBatches } from '@/lib/cleaner-batches'
import { useStatsStore } from '@/stores/stats-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useHistoryStore } from '@/stores/history-store'
import { useScanStore } from '@/stores/scan-store'
import { useUpdaterStore } from '@/stores/updater-store'
import { useServiceStore } from '@/stores/service-store'
import { useStartupStore } from '@/stores/startup-store'
import { useGameModeStore } from '@/stores/game-mode-store'
import { useMalwareStore } from '@/stores/malware-store'
import type { DriveInfo, ScanResult, CleanResult } from '@shared/types'
import { CleanerType } from '@shared/enums'
import { usePlatform } from '@/hooks/usePlatform'
import { SimpleDashboard } from '@/components/dashboard/SimpleDashboard'

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

const CLEANER_SCAN_FNS: {
  type: CleanerType
  scan: () => Promise<ScanResult[]>
  clean: (ids: string[]) => Promise<CleanResult>
}[] = [
  {
    type: CleanerType.System,
    scan: () => window.kudu.systemScan(),
    clean: (ids) => window.kudu.systemClean(ids)
  },
  {
    type: CleanerType.Browser,
    scan: () => window.kudu.browserScan(),
    clean: (ids) => window.kudu.browserClean(ids)
  },
  {
    type: CleanerType.App,
    scan: () => window.kudu.appScan(),
    clean: (ids) => window.kudu.appClean(ids)
  },
  {
    type: CleanerType.Gaming,
    scan: () => window.kudu.gamingScan(),
    clean: (ids) => window.kudu.gamingClean(ids)
  },
  {
    type: CleanerType.RecycleBin,
    scan: () => window.kudu.recycleBinScan(),
    clean: () => window.kudu.recycleBinClean()
  },
  {
    type: CleanerType.Environment,
    scan: () => window.kudu.environmentScan(),
    clean: (ids) => window.kudu.environmentClean(ids)
  },
  {
    type: CleanerType.Database,
    scan: () => window.kudu.databaseScan(),
    clean: (ids) => window.kudu.databaseClean(ids)
  }
]

// ── Gauge colors ─────────────────────────────────────────────

// ── Component ────────────────────────────────────────────────

export function DashboardPage() {
  const { t } = useTranslation('experience')
  const view = useSettingsStore((s) =>
    s.settings.dashboardView === 'advanced' ? 'advanced' : 'simple'
  )
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const saveInFlight = useRef(false)
  const changeView = async (next: 'simple' | 'advanced') => {
    if (next === view || busy || saveInFlight.current) return
    saveInFlight.current = true
    setSaving(true)
    try {
      await window.kudu.settingsSet({ dashboardView: next })
      updateSettings({ dashboardView: next })
    } catch {
      toast.error(t('simple.saveFailed'))
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }
  return (
    <div className="dashboard-view">
      <div className="dashboard-view-toolbar">
        <span>{t('simple.home')}</span>
        <div
          className="dashboard-view-switch"
          role="group"
          aria-label={t('simple.viewLabel')}
          aria-busy={saving}
        >
          {(['simple', 'advanced'] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={view === mode}
              disabled={saving || busy}
              onClick={() => void changeView(mode)}
            >
              {t(`simple.${mode}Mode`)}
            </button>
          ))}
        </div>
      </div>
      {view === 'simple' ? (
        <SimpleDashboard onAdvanced={() => void changeView('advanced')} switching={saving} />
      ) : (
        <AdvancedDashboard onBusyChange={setBusy} />
      )}
    </div>
  )
}

function AdvancedDashboard({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const { t } = useTranslation('dashboard')
  const { t: tx } = useTranslation('experience')
  const { features } = usePlatform()
  const stats = useStatsStore((s) => s.stats)
  const recomputeStats = useStatsStore((s) => s.recompute)
  const historyStore = useHistoryStore()
  const scanStore = useScanStore()
  const updaterHasChecked = useUpdaterStore((s) => s.hasChecked)
  const updaterApps = useUpdaterStore((s) => s.apps)
  const updaterRemindersEnabled = useSettingsStore(
    (s) => s.settings.softwareUpdaterNotifications ?? true
  )
  const serviceHasScanned = useServiceStore((s) => s.hasScanned)
  const startupItems = useStartupStore((s) => s.items)
  const startupHasLoaded = useStartupStore((s) => s.hasLoaded)
  const startupLoading = useStartupStore((s) => s.loading)
  const lastMalwareScan = useMalwareStore((s) => s.lastCompletedScan)
  const knownActiveThreats = useMalwareStore((s) => s.knownActiveThreats)
  const gameModeActive = useGameModeStore((s) => s.active)
  const gameModeActivatedAt = useGameModeStore((s) => s.activatedAt)
  const cleanStartRef = useRef<number>(0)
  const startupLoadAttemptedRef = useRef(false)
  const navigate = useNavigate()
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [driveStatus, setDriveStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [phase, setPhase] = useState<OneClickPhase>('idle')
  useEffect(() => {
    onBusyChange(phase === 'scanning' || phase === 'cleaning')
    return () => onBusyChange(false)
  }, [phase, onBusyChange])
  const [phaseLabel, setPhaseLabel] = useState('')
  const [result, setResult] = useState<OneClickResult | null>(null)
  const [showQuickConfirm, setShowQuickConfirm] = useState(false)
  const [showFullConfirm, setShowFullConfirm] = useState(false)
  const [stepProgress, setStepProgress] = useState({ current: 0, total: 0 })

  // ── Lightweight system metrics (no heavy process polling) ──
  const { current: perf, samples } = useQuickTelemetry()

  // ── Cloud connection status ────────────────────────────────

  // ── Game Mode elapsed timer ────────────────────────────────
  const [gmElapsed, setGmElapsed] = useState(0)
  useEffect(() => {
    if (!gameModeActive || !gameModeActivatedAt) {
      setGmElapsed(0)
      return
    }
    const start = new Date(gameModeActivatedAt).getTime()
    const tick = () => setGmElapsed(Date.now() - start)
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [gameModeActive, gameModeActivatedAt])

  const refreshDrives = useCallback(() => {
    setDriveStatus('loading')
    window.kudu
      ?.diskDrives?.()
      .then((nextDrives) => {
        setDrives(nextDrives)
        setDriveStatus(nextDrives.length > 0 ? 'ready' : 'unavailable')
      })
      .catch(() => {
        setDrives([])
        setDriveStatus('unavailable')
      })
  }, [])

  useEffect(() => {
    refreshDrives()
  }, [refreshDrives])

  // The dashboard owns its status claims, so it loads startup state instead
  // of assuming an empty store means there are no high-impact apps.
  useEffect(() => {
    if (startupHasLoaded || startupLoading || startupLoadAttemptedRef.current) return
    startupLoadAttemptedRef.current = true
    const startupStore = useStartupStore.getState()
    startupStore.setLoading(true)
    window.kudu
      .startupList()
      .then((items) => startupStore.setItems(items))
      .catch(() => startupStore.setError(t('toastStartupCheckFailed')))
      .finally(() => startupStore.setLoading(false))
  }, [startupHasLoaded, startupLoading, t])

  // ── Health score ───────────────────────────────────────────

  const toolCoverage = (() => {
    const entries = historyStore.entries
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000
    const recentEntries = entries.filter((e) => new Date(e.timestamp).getTime() > twoWeeksAgo)
    const recentTypes = new Set(recentEntries.map((e) => e.type))
    const allTypes = new Set(entries.map((e) => e.type))

    const historyTools = [
      { key: 'cleaner' as const, label: t('toolLabelCleaner'), icon: Search, color: '#f59e0b' },
      ...(features.registry
        ? [
            {
              key: 'registry' as const,
              label: t('toolLabelRegistry'),
              icon: Database,
              color: '#3b82f6'
            }
          ]
        : []),
      ...(features.drivers
        ? [{ key: 'drivers' as const, label: t('toolLabelDrivers'), icon: Cpu, color: '#a855f7' }]
        : [])
    ]

    const historyResults = historyTools.map((t) => ({
      ...t,
      usedRecently: recentTypes.has(t.key),
      usedEver: allTypes.has(t.key)
    }))

    const sessionTools = [
      ...(updaterRemindersEnabled
        ? [
            {
              key: 'updater',
              label: t('toolLabelUpdater'),
              icon: Download,
              color: '#06b6d4',
              active: updaterHasChecked
            }
          ]
        : []),
      {
        key: 'services',
        label: t('toolLabelServices'),
        icon: Server,
        color: '#ec4899',
        active: serviceHasScanned
      },
      {
        key: 'startup',
        label: t('toolLabelStartup'),
        icon: Zap,
        color: '#22c55e',
        active: startupHasLoaded
      }
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
        score -= Math.min(20, Math.round(((worstUsage - 0.7) / 0.3) * 20))
      }
    }

    if (lastMalwareScan) {
      const daysSinceScan =
        (Date.now() - new Date(lastMalwareScan.completedAt).getTime()) / (1000 * 60 * 60 * 24)
      score -= Math.min(20, Math.round(daysSinceScan * (20 / 7)))
    } else {
      score -= 10
    }

    if (lastMalwareScan) score += 40
    const activeThreatCount = (lastMalwareScan?.unresolvedThreats ?? 0) + knownActiveThreats
    if (activeThreatCount > 0) score -= Math.min(30, activeThreatCount * 10)
    return Math.max(0, Math.min(100, score))
  })()

  // ── One-click clean callbacks (unchanged logic) ────────────

  const protectRecycleBin = useSettingsStore((s) => s.settings.cleaner.protectRecycleBin)

  const runCleaners = useCallback(async (): Promise<{ space: number; files: number }> => {
    const excluded = scanStore.excludedSubcategories
    let totalSpace = 0
    let totalFiles = 0

    for (const { type, scan, clean } of CLEANER_SCAN_FNS) {
      if (type === CleanerType.RecycleBin && protectRecycleBin) continue
      try {
        setPhaseLabel(t('phaseLabelScanningType', { type }))
        const results = await scan()
        const selectedIds = results
          .filter((r) => !excluded.has(r.subcategory))
          .flatMap((r) => r.items.map((i) => i.id))
        if (selectedIds.length > 0) {
          setPhaseLabel(t('phaseLabelCleaningType', { type }))
          const cleaned = await cleanInBatches(selectedIds, clean)
          const res = cleaned.result
          totalSpace += res.totalCleaned || 0
          totalFiles += res.filesDeleted || 0
          if (cleaned.error) toast.error(t('toastFailedToCleanType', { type }))
        }
      } catch {
        toast.error(t('toastFailedToCleanType', { type }))
      }
    }
    return { space: totalSpace, files: totalFiles }
  }, [scanStore.excludedSubcategories, protectRecycleBin, t])

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
    const malwareStore = useMalwareStore.getState()
    malwareStore.setStatus('scanning')
    malwareStore.setThreats([])
    malwareStore.setActionResult(null)
    try {
      setPhaseLabel(t('phaseLabelScanningMalware'))
      const result = await window.kudu.malwareScan()
      malwareStore.setScanResult(result)
      malwareStore.setThreats(result.threats)
      malwareStore.setActionResult(null)
      malwareStore.setStatus('complete')
      if (result.threats.length === 0) return { found: 0, quarantined: 0 }
      setPhaseLabel(t('phaseLabelQuarantiningThreats'))
      const paths = result.threats.map((t) => t.path)
      const meta = result.threats.map((t) => ({
        path: t.path,
        detectionName: t.detectionName,
        severity: t.severity,
        source: t.source,
        details: t.details
      }))
      try {
        const actionResult = await window.kudu.malwareQuarantine(paths, meta)
        const failedPaths = new Set(actionResult.errors.map((error) => error.path))
        const knownUnresolved = result.threats.filter((threat) => failedPaths.has(threat.path))
        malwareStore.setActionResult(actionResult)
        malwareStore.setThreats(knownUnresolved)
        malwareStore.setUnresolvedThreatCount(
          Math.max(actionResult.failed, result.threats.length - actionResult.succeeded)
        )
        return { found: result.threats.length, quarantined: actionResult.succeeded }
      } catch {
        // The scan still completed successfully. Preserve its detections so the
        // result, history, and health score do not report active threats as clean.
        malwareStore.setUnresolvedThreatCount(result.threats.length)
        toast.error(t('malware:toastActionFailed', { action: 'quarantine' }))
        return { found: result.threats.length, quarantined: 0 }
      }
    } catch {
      malwareStore.setStatus('idle')
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
      useStartupStore.getState().setItems(items)
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
      const updaterStore = useUpdaterStore.getState()
      updaterStore.setApps(result.apps)
      updaterStore.setUpToDate(result.upToDate)
      updaterStore.setPackageManagerAvailable(result.packageManagerAvailable)
      updaterStore.setPackageManagerName(result.packageManagerName)
      updaterStore.setManagers(result.managers)
      updaterStore.setHasChecked(true)
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
    if (features.registry) {
      setStepProgress({ current: ++step, total: totalSteps })
      regFixed = await runRegistry()
    }
    let drivers = { removed: 0, space: 0 }
    if (features.drivers) {
      setStepProgress({ current: ++step, total: totalSteps })
      drivers = await runDrivers()
    }

    setStepProgress({ current: ++step, total: totalSteps })
    const malware = await runMalwareScan()
    setStepProgress({ current: ++step, total: totalSteps })
    const privacy = await runPrivacyCheck()
    setStepProgress({ current: ++step, total: totalSteps })
    const startupHighImpact = await runStartupCheck()
    setStepProgress({ current: ++step, total: totalSteps })
    const updatesAvailable =
      useSettingsStore.getState().settings.softwareUpdaterNotifications === false
        ? 0
        : await runSoftwareUpdateCheck()

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
        totalItemsSkipped: Math.max(0, malware.found - malware.quarantined),
        totalSpaceSaved: space + drivers.space,
        categories: [
          ...(files > 0
            ? [{ name: 'Full Clean', itemsFound: files, itemsCleaned: files, spaceSaved: space }]
            : []),
          ...(regFixed > 0
            ? [{ name: 'Registry', itemsFound: regFixed, itemsCleaned: regFixed, spaceSaved: 0 }]
            : []),
          ...(drivers.removed > 0
            ? [
                {
                  name: 'Stale Drivers',
                  itemsFound: drivers.removed,
                  itemsCleaned: drivers.removed,
                  spaceSaved: drivers.space
                }
              ]
            : []),
          ...(malware.found > 0
            ? [
                {
                  name: 'Malware',
                  itemsFound: malware.found,
                  itemsCleaned: malware.quarantined,
                  spaceSaved: 0
                }
              ]
            : [])
        ],
        errorCount: Math.max(0, malware.found - malware.quarantined)
      })
      recomputeStats()
    }

    setResult(oneClickResult)
    setPhase('done')
    setPhaseLabel('')
    refreshDrives()
  }, [
    phase,
    runCleaners,
    runRegistry,
    runDrivers,
    runMalwareScan,
    runPrivacyCheck,
    runStartupCheck,
    runSoftwareUpdateCheck,
    historyStore,
    recomputeStats,
    features
  ])

  const isRunning = phase === 'scanning' || phase === 'cleaning'

  // ── Helpers ────────────────────────────────────────────────

  const cpuPct = perf?.cpuPercent ?? 0
  const ramPct = perf?.memPercent ?? 0
  const diskPct =
    drives.length > 0
      ? Math.round(
          (drives.reduce((s, d) => s + d.usedSpace, 0) /
            drives.reduce((s, d) => s + d.totalSize, 0)) *
            100
        )
      : 0

  function formatGmElapsed(ms: number): string {
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  // ── Render ─────────────────────────────────────────────────

  const startupAttentionCount = startupItems.filter(
    (item) => item.enabled && item.impact === 'high'
  ).length
  const pendingUpdateCount = updaterRemindersEnabled ? updaterApps.length : 0
  const unresolvedThreatCount = (lastMalwareScan?.unresolvedThreats ?? 0) + knownActiveThreats
  const hasProtectionBaseline = !!lastMalwareScan
  const updaterNeedsAttention =
    updaterRemindersEnabled && (!updaterHasChecked || pendingUpdateCount > 0)
  const hasCompletedCoreChecks =
    (!updaterRemindersEnabled || updaterHasChecked) && startupHasLoaded && hasProtectionBaseline
  const primaryDrive = drives.find((drive) => drive.isSystem)
  const primaryDriveUsedPercent = primaryDrive?.totalSize
    ? Math.round((primaryDrive.usedSpace / primaryDrive.totalSize) * 100)
    : diskPct
  const attentionCount =
    Number(updaterNeedsAttention) +
    Number(!startupHasLoaded || startupAttentionCount > 0) +
    Number(!hasProtectionBaseline || unresolvedThreatCount > 0)
  const healthHeadline =
    unresolvedThreatCount > 0
      ? unresolvedThreatCount === 1
        ? t('healthHeadlineThreats', { count: unresolvedThreatCount })
        : t('healthHeadlineThreatsPlural', { count: unresolvedThreatCount })
      : !hasCompletedCoreChecks
        ? t('healthHeadlineRemainingChecks')
        : healthScore >= 80
          ? t('healthHeadlineProtected')
          : healthScore >= 55
            ? t('healthHeadlineGoodShape')
            : t('healthHeadlineReady')

  const recentActivity = [...historyStore.entries]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 3)
  return (
    <div className="pulse-home">
      <header className="pulse-home-heading">
        <div>
          <span className="pulse-eyebrow">{tx('home.eyebrow')}</span>
          <h1>{tx('home.title')}</h1>
          <p>{tx('home.description')}</p>
        </div>
        <button className="pulse-button" onClick={() => navigate('/performance')}>
          <Activity size={16} />
          {tx('home.telemetryAction')}
          <ArrowUpRight size={15} />
        </button>
      </header>
      <div className="pulse-home-metrics">
        <section className="pulse-card pulse-cpu">
          <div className="pulse-card-heading">
            <h2>{tx('home.cpu')}</h2>
            <Cpu size={19} />
          </div>
          <div className="pulse-big-value">
            {perf ? Math.round(cpuPct) : '\u2014'}
            <small>{perf ? '%' : ''}</small>
          </div>
          <MetricSparkline samples={samples} metric="cpu" label={tx('home.cpu')} />
          <p>
            {perf ? tx(cpuPct >= 70 ? 'home.loadHigh' : 'home.loadLow') : tx('home.unavailable')}
          </p>
        </section>
        <section className="pulse-card pulse-memory">
          <div className="pulse-card-heading">
            <h2>{tx('home.memory')}</h2>
            <MemoryStick size={20} />
          </div>
          <div className="pulse-big-value">
            {perf ? formatBytes(perf.memUsedBytes) : '\u2014'}
            <small>{perf ? ' / ' + formatBytes(perf.memTotalBytes) : ''}</small>
          </div>
          <MetricSparkline samples={samples} metric="memory" label={tx('home.memory')} />
          <p>
            {tx(
              !perf ? 'home.memoryUnknown' : ramPct >= 80 ? 'home.memoryBusy' : 'home.memoryRoom'
            )}
          </p>
          <span className="pulse-live-label">
            {perf ? tx('home.used', { percent: Math.round(ramPct) }) : tx('home.unavailable')}
          </span>
        </section>
        <section className="pulse-card pulse-home-storage">
          <div className="pulse-card-heading">
            <h2>{tx('home.storage')}</h2>
            <HardDrive size={18} />
          </div>
          <div className="pulse-big-value">
            {primaryDrive ? formatBytes(primaryDrive.freeSpace) : '\u2014'}
          </div>
          <div
            className="pulse-storage-meter"
            role="meter"
            aria-label={t('glanceStorage')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={primaryDrive ? primaryDriveUsedPercent : undefined}
          >
            <i style={{ width: primaryDrive ? primaryDriveUsedPercent + '%' : '0%' }} />
          </div>
          <p>
            {primaryDrive
              ? tx('home.storageDetail', {
                  size: formatBytes(primaryDrive.totalSize),
                  drive: primaryDrive.label || primaryDrive.letter
                })
              : t(driveStatus === 'loading' ? 'glanceChecking' : 'glanceStorageUnavailable')}
          </p>
          <button className="pulse-text-button" onClick={() => navigate('/disk')}>
            {tx('home.storageAction')}
            <ArrowRight size={14} />
          </button>
        </section>
        <section className="pulse-card pulse-health-summary">
          <div className="pulse-card-heading">
            <h2>{tx('home.health')}</h2>
            <Shield size={18} />
          </div>
          {hasCompletedCoreChecks ? (
            <HealthScore score={healthScore} size="compact" />
          ) : (
            <div className="pulse-baseline">
              <Shield size={31} />
              <strong>{'\u2014'}</strong>
            </div>
          )}
          <h3>{healthHeadline}</h3>
          <p>{tx('home.healthDetail')}</p>
        </section>
      </div>
      <div className="pulse-home-columns">
        <div className="pulse-home-main">
          <section className="pulse-card pulse-home-telemetry">
            <div className="pulse-card-heading">
              <div>
                <h2>{tx('home.telemetry')}</h2>
                <p>{tx('home.telemetryDescription')}</p>
              </div>
              <Activity size={18} />
            </div>
            <div className="pulse-chart-legend">
              <span>
                <i />
                {tx('home.cpu')}
                <b>{perf ? Math.round(cpuPct) + '%' : '\u2014'}</b>
              </span>
              <span>
                <i />
                {t('glanceMemory')}
                <b>{perf ? Math.round(ramPct) + '%' : '\u2014'}</b>
              </span>
            </div>
            <QuickTelemetryChart samples={samples} />
            <button className="pulse-text-button" onClick={() => navigate('/performance')}>
              {tx('home.telemetryAction')}
              <ArrowRight size={15} />
            </button>
          </section>
          <section className="pulse-card pulse-recent">
            <div className="pulse-card-heading">
              <h2>{tx('home.activity')}</h2>
              <button className="pulse-text-button" onClick={() => navigate('/history')}>
                {tx('home.allActivity')}
                <ArrowUpRight size={15} />
              </button>
            </div>
            {recentActivity.length ? (
              recentActivity.map((entry) => (
                <button
                  key={entry.id}
                  className="pulse-activity-row"
                  onClick={() => navigate('/history')}
                >
                  <span className="pulse-icon-tile">
                    <HistoryIcon size={17} />
                  </span>
                  <span>
                    <b>
                      {t(
                        'history:typeLabels.' +
                          (entry.type === 'software-update'
                            ? 'softwareUpdate'
                            : entry.type === 'cve-scan'
                              ? 'cveScan'
                              : entry.type),
                        { defaultValue: entry.type }
                      )}
                    </b>
                    <small>{formatDate(entry.timestamp)}</small>
                  </span>
                  <span>
                    <b>
                      {entry.type === 'cleaner'
                        ? tx('home.recovered', { size: formatBytes(entry.totalSpaceSaved) })
                        : `${t('history:detail.statFound')}: ${entry.totalItemsFound}`}
                    </b>
                    <small>
                      {t('history:detail.statProcessed')}: {entry.totalItemsCleaned}
                    </small>
                    <ArrowUpRight size={14} />
                  </span>
                </button>
              ))
            ) : (
              <div className="pulse-history-empty">
                <HistoryIcon size={26} />
                <h3>{tx('home.noActivity')}</h3>
                <p>{tx('home.noActivityDetail')}</p>
                <button className="pulse-text-button" onClick={() => navigate('/cleaner')}>
                  {tx('home.cleanAction')}
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
          </section>
          <section className="pulse-next-actions" aria-labelledby="pulse-next-title">
            <div className="pulse-section-heading">
              <h2 id="pulse-next-title">{tx('home.next')}</h2>
              <span>{t('safeActionsOnly')}</span>
            </div>
            <div className="pulse-action-grid">
              <article className="pulse-action-card">
                <span className="pulse-icon-tile is-mint">
                  <Shield size={21} />
                </span>
                <h3>{tx('home.protectTitle')}</h3>
                <p>{tx('home.protectDescription')}</p>
                <button className="pulse-button" onClick={() => navigate('/malware')}>
                  {tx('home.protectAction')}
                  <ArrowRight size={16} />
                </button>
              </article>
              <article className="pulse-action-card">
                <span className="pulse-icon-tile">
                  <CalendarClock size={21} />
                </span>
                <h3>{tx('home.automateTitle')}</h3>
                <p>{tx('home.automateDescription')}</p>
                <button className="pulse-button" onClick={() => navigate('/schedules')}>
                  {tx('home.automateAction')}
                  <ArrowRight size={16} />
                </button>
              </article>
            </div>
          </section>
        </div>
        <aside className="pulse-home-rail">
          {' '}
          <article className="pulse-action-card is-primary pulse-cleanup-hero">
            <span className="pulse-icon-tile">
              <Sparkles size={21} />
            </span>
            <h3>{tx('home.cleanTitle')}</h3>
            <p>{tx('home.cleanDescription')}</p>
            <button className="pulse-button pulse-primary" onClick={() => navigate('/cleaner')}>
              {tx('home.cleanAction')}
              <ArrowRight size={16} />
            </button>
          </article>
          <section className="pulse-card pulse-attention">
            <div className="pulse-card-heading">
              <h2>{tx('home.attention')}</h2>
              <span className="pulse-count">{attentionCount}</span>
            </div>
            {updaterRemindersEnabled && (
              <button onClick={() => navigate('/updates')}>
                <Download size={17} />
                <span>
                  <b>
                    {!updaterHasChecked
                      ? t('railCheckAppUpdates')
                      : pendingUpdateCount
                        ? t(
                            pendingUpdateCount === 1
                              ? 'railPendingAppUpdates'
                              : 'railPendingAppUpdatesPlural',
                            { count: pendingUpdateCount }
                          )
                        : t('railAppsUpToDate')}
                  </b>
                  <small>
                    {tx(!updaterHasChecked ? 'home.check' : 'home.review')}
                    <ArrowRight size={12} />
                  </small>
                </span>
              </button>
            )}
            <button onClick={() => navigate('/startup')}>
              <Zap size={17} />
              <span>
                <b>
                  {!startupHasLoaded
                    ? t('railCheckStartupApps')
                    : startupAttentionCount
                      ? t(
                          startupAttentionCount === 1
                            ? 'railStartupAppsAttention'
                            : 'railStartupAppsAttentionPlural',
                          { count: startupAttentionCount }
                        )
                      : t('railStartupLooksGood')}
                </b>
                <small>
                  {tx('home.review')}
                  <ArrowRight size={12} />
                </small>
              </span>
            </button>
            <button onClick={() => navigate('/malware')}>
              <Shield size={17} />
              <span>
                <b>
                  {unresolvedThreatCount
                    ? tx('home.protectionThreats', { count: unresolvedThreatCount })
                    : tx(hasProtectionBaseline ? 'home.protectionClear' : 'home.protectionUnknown')}
                </b>
                <small>
                  {lastMalwareScan
                    ? tx('home.lastScan', { date: formatDate(lastMalwareScan.completedAt) })
                    : tx('home.check')}
                  <ArrowRight size={12} />
                </small>
              </span>
            </button>
          </section>
          {features.gameMode && (
            <section className="pulse-card pulse-game">
              <Gamepad2 size={26} />
              <h3>{gameModeActive ? t('gameModeActiveLabel') : tx('home.game')}</h3>
              <p>
                {gameModeActive && gameModeActivatedAt
                  ? formatGmElapsed(gmElapsed)
                  : tx('home.gameDescription')}
              </p>
              <button className="pulse-button" onClick={() => navigate('/game-mode')}>
                {tx('home.gameAction')}
                <ArrowRight size={15} />
              </button>
            </section>
          )}
        </aside>
      </div>
      <section className="pulse-lifetime">
        <div>
          <span>{tx('home.totalSaved')}</span>
          <b>{formatBytes(stats.totalSpaceSaved)}</b>
        </div>
        <div>
          <span>{tx('home.totalFiles')}</span>
          <b>{formatNumber(stats.totalFilesCleaned)}</b>
        </div>
        <div>
          <span>{tx('home.totalScans')}</span>
          <b>{formatNumber(stats.totalScans)}</b>
        </div>
        <button className="pulse-text-button" onClick={() => navigate('/history')}>
          {tx('home.allActivity')}
          <ArrowRight size={15} />
        </button>
      </section>
      <section className="pulse-quick-care">
        <div>
          <h3>{tx('home.quick')}</h3>
          <p>{tx('home.quickDetail')}</p>
        </div>
        <button
          className="pulse-button"
          disabled={isRunning}
          onClick={() => setShowQuickConfirm(true)}
        >
          {tx('home.quickAction')}
          <Sparkles size={15} />
        </button>
        <button
          className="pulse-button"
          disabled={isRunning}
          onClick={() => setShowFullConfirm(true)}
        >
          {tx('home.fullAction')}
          <Shield size={15} />
        </button>
      </section>
      {isRunning && (
        <div className="kudu-operation" role="status">
          <div>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={2} />
            <span>{phaseLabel || t('progressWorking')}</span>
            {stepProgress.total > 0 && (
              <b>
                {stepProgress.current}/{stepProgress.total}
              </b>
            )}
          </div>
          {stepProgress.total > 0 && (
            <div className="kudu-operation-track">
              <i style={{ width: `${(stepProgress.current / stepProgress.total) * 100}%` }} />
            </div>
          )}
        </div>
      )}

      {phase === 'done' && result && (
        <div
          className={cn(
            'kudu-operation',
            result.threatsFound > result.threatsQuarantined ? 'is-warning' : 'is-complete'
          )}
          role="status"
        >
          {result.threatsFound > result.threatsQuarantined ? (
            <AlertTriangle className="h-5 w-5 shrink-0" strokeWidth={1.8} />
          ) : (
            <CheckCircle2 className="h-5 w-5 shrink-0" strokeWidth={1.8} />
          )}
          <div className="min-w-0">
            <b>
              {result.threatsFound > result.threatsQuarantined
                ? t('scanCompleteThreats')
                : t('resultCleanupComplete')}
            </b>
            <p>
              {result.spaceRecovered > 0 && (
                <span>
                  {t('resultSpaceRecovered', { size: formatBytes(result.spaceRecovered) })}
                </span>
              )}
              {result.filesCleaned > 0 && (
                <span>{t('resultFilesCleaned', { count: formatNumber(result.filesCleaned) })}</span>
              )}
              {result.threatsQuarantined > 0 && (
                <button onClick={() => navigate('/malware', { state: { tab: 'quarantine' } })}>
                  {t('threatsQuarantinedCount', { count: result.threatsQuarantined })}
                </button>
              )}
              {result.threatsFound > result.threatsQuarantined && (
                <button onClick={() => navigate('/malware')}>
                  {result.threatsFound - result.threatsQuarantined === 1
                    ? t('threatsActiveCount', {
                        count: result.threatsFound - result.threatsQuarantined
                      })
                    : t('threatsActiveCountPlural', {
                        count: result.threatsFound - result.threatsQuarantined
                      })}
                </button>
              )}
              {result.privacyIssues > 0 && (
                <button onClick={() => navigate('/privacy')}>
                  {t('privacyImprovementsCount', { count: result.privacyIssues })}
                </button>
              )}
              {result.startupHighImpact > 0 && (
                <button onClick={() => navigate('/startup')}>
                  {t('startupItemsCount', { count: result.startupHighImpact })}
                </button>
              )}
              {result.updatesAvailable > 0 && (
                <button onClick={() => navigate('/updates')}>
                  {t('updatesCount', { count: result.updatesAvailable })}
                </button>
              )}
              {result.spaceRecovered === 0 &&
                result.filesCleaned === 0 &&
                result.registryFixed === 0 &&
                result.driversRemoved === 0 &&
                result.threatsFound === 0 &&
                result.privacyIssues === 0 &&
                result.startupHighImpact === 0 &&
                result.updatesAvailable === 0 && <span>{t('resultSystemAlreadyClean')}</span>}
            </p>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={showQuickConfirm}
        onConfirm={() => {
          setShowQuickConfirm(false)
          handleQuickClean()
        }}
        onCancel={() => setShowQuickConfirm(false)}
        title={t('quickCleanConfirmTitle')}
        description={
          features.registry
            ? t('quickCleanConfirmDescriptionWithRegistry')
            : t('quickCleanConfirmDescriptionWithoutRegistry')
        }
        confirmLabel={t('quickCleanConfirmLabel')}
        variant="warning"
      />

      <ConfirmDialog
        open={showFullConfirm}
        onConfirm={() => {
          setShowFullConfirm(false)
          handleFullClean()
        }}
        onCancel={() => setShowFullConfirm(false)}
        title={t('fullCleanConfirmTitle')}
        description={
          features.registry
            ? t('fullCleanConfirmDescriptionWithRegistry')
            : t('fullCleanConfirmDescriptionWithoutRegistry')
        }
        confirmLabel={t('fullCleanConfirmLabel')}
        variant="warning"
      />
    </div>
  )
}
