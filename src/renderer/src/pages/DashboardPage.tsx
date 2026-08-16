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
  Cloud,
  Loader2,
  Cpu,
  Check,
  Download,
  Server,
  Gamepad2,
  BarChart3,
  MemoryStick,
  AlertTriangle
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
import { useMalwareStore } from '@/stores/malware-store'
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
  { type: CleanerType.Environment, scan: () => window.kudu.environmentScan(), clean: (ids) => window.kudu.environmentClean(ids) },
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
  const updaterApps = useUpdaterStore((s) => s.apps)
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
  const [phaseLabel, setPhaseLabel] = useState('')
  const [result, setResult] = useState<OneClickResult | null>(null)
  const [showQuickConfirm, setShowQuickConfirm] = useState(false)
  const [showFullConfirm, setShowFullConfirm] = useState(false)
  const [stepProgress, setStepProgress] = useState({ current: 0, total: 0 })
  // Live cloud connection status — reflects the agent's actual state, not just
  // whether an API key is saved (a key can be linked but failing, e.g. expired
  // subscription / 402). Only "connected" counts as connected.
  const [cloudConnected, setCloudConnected] = useState(false)

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

  // ── Cloud connection status ────────────────────────────────
  useEffect(() => {
    if (!isCloudLinked) { setCloudConnected(false); return }
    let cancelled = false
    const check = () => {
      window.kudu?.cloudGetStatus?.()
        .then((s) => { if (!cancelled) setCloudConnected(s?.status === 'connected') })
        .catch(() => { if (!cancelled) setCloudConnected(false) })
    }
    check()
    const iv = setInterval(check, 5000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [isCloudLinked])

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
    setDriveStatus('loading')
    window.kudu?.diskDrives?.()
      .then((nextDrives) => {
        setDrives(nextDrives)
        setDriveStatus(nextDrives.length > 0 ? 'ready' : 'unavailable')
      })
      .catch(() => {
        setDrives([])
        setDriveStatus('unavailable')
      })
  }, [])

  useEffect(() => { refreshDrives() }, [refreshDrives])

  // The dashboard owns its status claims, so it loads startup state instead
  // of assuming an empty store means there are no high-impact apps.
  useEffect(() => {
    if (startupHasLoaded || startupLoading || startupLoadAttemptedRef.current) return
    startupLoadAttemptedRef.current = true
    const startupStore = useStartupStore.getState()
    startupStore.setLoading(true)
    window.kudu.startupList()
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
      { key: 'startup', label: t('toolLabelStartup'), icon: Zap, color: '#22c55e', active: startupHasLoaded }
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

  const toolRoutes: Record<string, string> = {
    cleaner: '/cleaner',
    registry: '/registry',
    drivers: '/drivers',
    updater: '/updates',
    services: '/services',
    startup: '/startup'
  }

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

    if (lastMalwareScan) {
      const daysSinceScan = (Date.now() - new Date(lastMalwareScan.completedAt).getTime()) / (1000 * 60 * 60 * 24)
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
          const res = await clean(selectedIds)
          totalSpace += res.totalCleaned || 0
          totalFiles += res.filesDeleted || 0
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
        malwareStore.setUnresolvedThreatCount(Math.max(actionResult.failed, result.threats.length - actionResult.succeeded))
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
        totalItemsSkipped: Math.max(0, malware.found - malware.quarantined), totalSpaceSaved: space + drivers.space,
        categories: [
          ...(files > 0 ? [{ name: 'Full Clean', itemsFound: files, itemsCleaned: files, spaceSaved: space }] : []),
          ...(regFixed > 0 ? [{ name: 'Registry', itemsFound: regFixed, itemsCleaned: regFixed, spaceSaved: 0 }] : []),
          ...(drivers.removed > 0 ? [{ name: 'Stale Drivers', itemsFound: drivers.removed, itemsCleaned: drivers.removed, spaceSaved: drivers.space }] : []),
          ...(malware.found > 0 ? [{ name: 'Malware', itemsFound: malware.found, itemsCleaned: malware.quarantined, spaceSaved: 0 }] : [])
        ],
        errorCount: Math.max(0, malware.found - malware.quarantined)
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

  const startupAttentionCount = startupItems.filter((item) => item.enabled && item.impact === 'high').length
  const pendingUpdateCount = updaterApps.length
  const unresolvedThreatCount = (lastMalwareScan?.unresolvedThreats ?? 0) + knownActiveThreats
  const hasProtectionBaseline = !!lastMalwareScan
  const hasCompletedCoreChecks = updaterHasChecked && startupHasLoaded && hasProtectionBaseline
  const primaryDrive = drives.find((drive) => drive.isSystem)
  const primaryDriveUsedPercent = primaryDrive?.totalSize
    ? Math.round((primaryDrive.usedSpace / primaryDrive.totalSize) * 100)
    : diskPct
  const freeMemory = perf ? Math.max(0, perf.memTotalBytes - perf.memUsedBytes) : 0
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const attentionCount = Number(!updaterHasChecked || pendingUpdateCount > 0)
    + Number(!startupHasLoaded || startupAttentionCount > 0)
    + Number(!hasProtectionBaseline || unresolvedThreatCount > 0)
  const healthHeadline = unresolvedThreatCount > 0
    ? `${unresolvedThreatCount} ${unresolvedThreatCount === 1 ? 'threat needs' : 'threats need'} your attention.`
    : !hasCompletedCoreChecks
      ? 'Complete the remaining checks for a full picture.'
      : healthScore >= 80
        ? 'Everything important is protected.'
        : healthScore >= 55
          ? 'Your device is in good shape.'
          : 'A few things are ready for your attention.'

  return (
    <div className="kudu-home animate-fade-in">
      <div className="kudu-home-grid">
        <div className="kudu-home-main">
          <header className="kudu-home-greeting">
            <div>
              <h1>{greeting}.</h1>
              <p>
                {unresolvedThreatCount > 0
                  ? `Your device needs attention. ${unresolvedThreatCount} active ${unresolvedThreatCount === 1 ? 'threat remains' : 'threats remain'}.`
                  : !hasCompletedCoreChecks
                    ? 'Kudu is still establishing this device’s status. Complete the remaining checks for a reliable health summary.'
                  : attentionCount === 0
                    ? 'Your PC is healthy and everything important is up to date.'
                    : `Your checks are complete. ${attentionCount} ${attentionCount === 1 ? 'item is' : 'items are'} ready for review.`}
              </p>
            </div>
            <span className="kudu-device-avatar" aria-label="This device">PC</span>
          </header>

          <section className="kudu-briefing">
            <div className="kudu-briefing-copy">
              <span>TODAY&apos;S SYSTEM BRIEFING</span>
              <h2>{healthHeadline}</h2>
              <p>
                {unresolvedThreatCount > 0
                  ? `${unresolvedThreatCount} active ${unresolvedThreatCount === 1 ? 'threat needs' : 'threats need'} attention.${lastMalwareScan ? ` Your last malware scan ran ${formatDate(lastMalwareScan.completedAt)}.` : ''}`
                  : lastMalwareScan
                    ? `No active threats were found in your last malware scan ${formatDate(lastMalwareScan.completedAt)}. Kudu has reclaimed ${formatBytes(stats.totalSpaceSaved)} over its lifetime.`
                  : 'Run a complete scan to establish a protection baseline and uncover safe cleanup opportunities.'}
              </p>
            </div>
            <div className="kudu-briefing-score">
              <HealthScore score={healthScore} size="md" />
            </div>
          </section>

          <section className="kudu-home-section">
            <div className="kudu-section-title">
              <h2>Recommended for you</h2>
              <span>Safe actions only</span>
            </div>
            <div className="kudu-recommendations">
              <button type="button" onClick={() => setShowQuickConfirm(true)} disabled={isRunning} className="kudu-recommendation is-primary">
                <span className="kudu-recommendation-icon"><Sparkles strokeWidth={1.9} /></span>
                <span>
                  <b>{t('quickCleanTitle')}</b>
                  <small>Browser cache, downloads residue and temporary files</small>
                </span>
                <i aria-hidden="true">→</i>
              </button>
              <button type="button" onClick={() => setShowFullConfirm(true)} disabled={isRunning} className="kudu-recommendation">
                <span className="kudu-recommendation-icon"><Shield strokeWidth={1.9} /></span>
                <span>
                  <b>Run smart scan</b>
                  <small>Protection, privacy and performance check</small>
                </span>
                <i aria-hidden="true">→</i>
              </button>
            </div>
          </section>

          {isRunning && (
            <div className="kudu-operation" role="status">
              <div>
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={2} />
                <span>{phaseLabel || t('progressWorking')}</span>
                {stepProgress.total > 0 && <b>{stepProgress.current}/{stepProgress.total}</b>}
              </div>
              {stepProgress.total > 0 && <div className="kudu-operation-track"><i style={{ width: `${(stepProgress.current / stepProgress.total) * 100}%` }} /></div>}
            </div>
          )}

          {phase === 'done' && result && (
            <div className={cn('kudu-operation', result.threatsFound > result.threatsQuarantined ? 'is-warning' : 'is-complete')} role="status">
              {result.threatsFound > result.threatsQuarantined
                ? <AlertTriangle className="h-5 w-5 shrink-0" strokeWidth={1.8} />
                : <CheckCircle2 className="h-5 w-5 shrink-0" strokeWidth={1.8} />}
              <div className="min-w-0">
                <b>{result.threatsFound > result.threatsQuarantined ? 'Scan complete — threats need attention' : t('resultCleanupComplete')}</b>
                <p>
                  {result.spaceRecovered > 0 && <span>{t('resultSpaceRecovered', { size: formatBytes(result.spaceRecovered) })}</span>}
                  {result.filesCleaned > 0 && <span>{t('resultFilesCleaned', { count: formatNumber(result.filesCleaned) })}</span>}
                  {result.threatsQuarantined > 0 && <button onClick={() => navigate('/malware', { state: { tab: 'quarantine' } })}>{result.threatsQuarantined} quarantined</button>}
                  {result.threatsFound > result.threatsQuarantined && <button onClick={() => navigate('/malware')}>{result.threatsFound - result.threatsQuarantined} {result.threatsFound - result.threatsQuarantined === 1 ? 'threat remains active' : 'threats remain active'}</button>}
                  {result.privacyIssues > 0 && <button onClick={() => navigate('/privacy')}>{result.privacyIssues} privacy improvements</button>}
                  {result.startupHighImpact > 0 && <button onClick={() => navigate('/startup')}>{result.startupHighImpact} startup items</button>}
                  {result.updatesAvailable > 0 && <button onClick={() => navigate('/updates')}>{result.updatesAvailable} updates</button>}
                  {result.spaceRecovered === 0 && result.filesCleaned === 0 && result.registryFixed === 0 && result.driversRemoved === 0 && result.threatsFound === 0 && result.privacyIssues === 0 && result.startupHighImpact === 0 && result.updatesAvailable === 0 && <span>{t('resultSystemAlreadyClean')}</span>}
                </p>
              </div>
            </div>
          )}

          <section className="kudu-home-section">
            <div className="kudu-section-title">
              <h2>System at a glance</h2>
              <span>Updated just now</span>
            </div>
            <div className="kudu-glance-grid">
              <GlanceCard icon={Cpu} label="Processor" value={cpuPct < 70 ? 'Comfortable' : 'Working hard'} percent={Math.round(cpuPct)} tone="gold" />
              <GlanceCard icon={MemoryStick} label="Memory" value={perf ? `${formatBytes(freeMemory)} free` : 'Checking…'} percent={Math.round(ramPct)} tone="green" />
              <GlanceCard icon={HardDrive} label="Storage" value={primaryDrive ? `${formatBytes(primaryDrive.totalSize - primaryDrive.usedSpace)} free` : driveStatus === 'loading' ? 'Checking…' : 'Unavailable'} percent={primaryDriveUsedPercent} tone="clay" />
            </div>
          </section>

          <section className="kudu-activity-strip" aria-label="Lifetime Kudu activity">
            <div><span>Space reclaimed</span><b>{formatBytes(stats.totalSpaceSaved)}</b></div>
            <div><span>Files cleaned</span><b>{formatNumber(stats.totalFilesCleaned)}</b></div>
            <div><span>Scans completed</span><b>{formatNumber(stats.totalScans)}</b></div>
          </section>
        </div>

        <aside className="kudu-attention-rail" aria-label="Needs your attention">
          <div className="kudu-attention-heading">
            <div><span>DEVICE CARE</span><h2>Needs your attention</h2></div>
            <b>{attentionCount}</b>
          </div>

          <div className="kudu-attention-list">
            <button type="button" onClick={() => navigate('/updates')}>
              <span className="kudu-attention-icon"><Download /></span>
              <span><b>{!updaterHasChecked ? 'Check app updates' : pendingUpdateCount > 0 ? `${pendingUpdateCount} app ${pendingUpdateCount === 1 ? 'update' : 'updates'}` : 'Apps are up to date'}</b><small>{!updaterHasChecked ? 'Security and reliability fixes' : pendingUpdateCount > 0 ? 'Updates are ready to install' : 'Latest check completed'}</small></span>
              <em>{!updaterHasChecked ? '5 MIN' : pendingUpdateCount > 0 ? 'REVIEW' : 'DONE'}</em>
            </button>
            <button type="button" onClick={() => navigate('/startup')}>
              <span className="kudu-attention-icon"><Zap /></span>
              <span><b>{!startupHasLoaded ? 'Check startup apps' : startupAttentionCount > 0 ? `${startupAttentionCount} startup ${startupAttentionCount === 1 ? 'app' : 'apps'}` : 'Startup looks good'}</b><small>{!startupHasLoaded ? 'Review what launches when you sign in' : startupAttentionCount > 0 ? 'High-impact apps may slow sign-in' : 'No high-impact apps found'}</small></span>
              <em>{!startupHasLoaded ? (startupLoading ? 'CHECKING' : 'CHECK') : startupAttentionCount > 0 ? 'REVIEW' : 'DONE'}</em>
            </button>
            <button type="button" onClick={() => navigate('/malware')}>
              <span className={cn('kudu-attention-icon', hasProtectionBaseline && unresolvedThreatCount === 0 && 'is-success')}>{hasProtectionBaseline && unresolvedThreatCount === 0 ? <Check /> : <Shield />}</span>
              <span><b>{unresolvedThreatCount > 0 ? `${unresolvedThreatCount} ${unresolvedThreatCount === 1 ? 'threat needs' : 'threats need'} attention` : !hasProtectionBaseline ? 'Run your first malware scan' : 'Protection looks good'}</b><small>{unresolvedThreatCount > 0 ? 'Open the scanner to resolve detections' : !hasProtectionBaseline ? 'Establish a security baseline' : 'No active threats detected'}</small></span>
              <em>{unresolvedThreatCount > 0 ? 'REVIEW' : !hasProtectionBaseline ? 'START' : 'DONE'}</em>
            </button>
          </div>

          <section className="kudu-drive-card">
            <div>
              <b>{primaryDrive ? `${primaryDrive.letter}: ${primaryDrive.label || 'System drive'}` : 'System drive'}</b>
              <span>{primaryDrive ? `${formatBytes(primaryDrive.usedSpace)} / ${formatBytes(primaryDrive.totalSize)}` : driveStatus === 'loading' ? 'Checking storage…' : 'Storage unavailable'}</span>
            </div>
            <div className="kudu-drive-track"><i style={{ width: `${primaryDriveUsedPercent}%` }} /></div>
            <p>{!primaryDrive ? (driveStatus === 'loading' ? 'Checking available storage…' : 'Storage information is unavailable.') : primaryDriveUsedPercent > 85 ? 'Cleanup is recommended soon.' : 'Plenty of working space is available.'}</p>
            <button type="button" onClick={() => navigate('/disk')}>Open storage tools →</button>
          </section>

          {features.gameMode && (
            <button type="button" className="kudu-rail-link" onClick={() => navigate('/game-mode')}>
              <span className="kudu-attention-icon"><Gamepad2 /></span>
              <span><b>{gameModeActive ? 'Game Mode is active' : 'Game Mode is ready'}</b><small>{gameModeActive && gameModeActivatedAt ? formatGmElapsed(gmElapsed) : 'Focus resources before you play'}</small></span>
              <i>→</i>
            </button>
          )}

          <button type="button" className="kudu-cloud-status" onClick={() => navigate('/cloud')}>
            <i className={cn(cloudConnected && 'is-connected')} />
            <span>{cloudConnected ? 'Kudu Cloud connected' : 'Connect Kudu Cloud'}</span>
          </button>
        </aside>
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

function GlanceCard({ icon: Icon, label, value, percent, tone }: {
  icon: typeof Cpu
  label: string
  value: string
  percent: number
  tone: 'gold' | 'green' | 'clay'
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <article className={`kudu-glance-card is-${tone}`}>
      <div className="kudu-glance-meta">
        <span><Icon />{label}</span>
      </div>
      <div className="kudu-glance-body">
        <h3>{value}</h3>
        <div
          className="kudu-glance-dial"
          style={{ background: `conic-gradient(var(--glance-color) ${clamped * 3.6}deg, var(--gauge-track) 0deg)` }}
          role="img"
          aria-label={`${label}: ${clamped}%`}
        >
          <span>{clamped}%</span>
        </div>
      </div>
      <div className="kudu-glance-track"><i style={{ width: `${clamped}%` }} /></div>
    </article>
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
  const gradientId = `mini-gauge-${label.replace(/\s+/g, '-')}`

  return (
    <div
      className="glass-card glass-card-hover flex items-center gap-3.5 rounded-xl px-4 py-3.5"
    >
      <div className="relative inline-flex shrink-0 items-center justify-center">
        <svg width={SIZE} height={SIZE} className="-rotate-90">
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={color} stopOpacity="1" />
              <stop offset="100%" stopColor={color} stopOpacity="0.5" />
            </linearGradient>
          </defs>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--gauge-track)" strokeWidth={STROKE} />
          <circle
            cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke={`url(#${gradientId})`} strokeWidth={STROKE}
            strokeLinecap="round" strokeDasharray={C} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.16,1,0.3,1)' }}
          />
        </svg>
        <Icon className="absolute h-4 w-4" style={{ color }} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-zinc-200">{label}</p>
        <p className="truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>{detail}</p>
      </div>
    </div>
  )
}

// ── Cloud Status Card ────────────────────────────────────────

function CloudStatusCard({ connected, label, statusText, onClick }: {
  connected: boolean
  label: string
  statusText: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${statusText}`}
      className="calm-cloud-card text-left"
    >
      <span className="calm-attention-icon success"><Cloud className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" /></span>
      <span className="min-w-0 flex-1"><b>{statusText}</b><small>{label}</small></span>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: connected ? 'var(--success)' : 'var(--text-faint)' }} />
    </button>
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
          <HardDrive className="h-4 w-4" style={{ color: 'var(--text-muted)' }} strokeWidth={1.6} />
          <span className="text-[13px] font-medium text-zinc-300">
            {platform === 'win32' ? `${drive.letter}: ${drive.label}` : `${drive.letter} ${drive.label}`}
          </span>
        </div>
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          {formatBytes(drive.usedSpace)} / {formatBytes(drive.totalSize)}
        </span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-full" style={{ background: 'var(--bg-subtle-2)' }}>
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${usedPercent}%`,
            background: `linear-gradient(90deg, ${barColor}, ${barColor}cc)`,
            boxShadow: `0 0 8px ${barColor}30`
          }}
        />
      </div>
    </div>
  )
}
