import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Gamepad2,
  Server,
  Cpu,
  MemoryStick,
  Monitor,
  Wifi,
  ChevronDown,
  Plus,
  X,
  CheckCircle2,
  AlertTriangle,
  Shield,
  Zap,
  Timer,
  Activity,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { useGameModeStore } from '@/stores/game-mode-store'
import type { GameModeOptimizationId, GameModeCategory } from '@shared/types'
import type { LucideIcon } from 'lucide-react'

// ── Optimization definitions ─────────────────────────────────

interface OptimizationDef {
  id: GameModeOptimizationId
  category: GameModeCategory
  labelKey: string
  descKey: string
  requiresAdmin: boolean
}

const OPTIMIZATIONS: OptimizationDef[] = [
  // Services
  { id: 'svc-wsearch', category: 'services', labelKey: 'optSvcWsearch', descKey: 'optSvcWsearchDesc', requiresAdmin: true },
  { id: 'svc-sysmain', category: 'services', labelKey: 'optSvcSysmain', descKey: 'optSvcSysmainDesc', requiresAdmin: true },
  { id: 'svc-wuauserv', category: 'services', labelKey: 'optSvcWuauserv', descKey: 'optSvcWuauservDesc', requiresAdmin: true },
  { id: 'svc-spooler', category: 'services', labelKey: 'optSvcSpooler', descKey: 'optSvcSpoolerDesc', requiresAdmin: true },
  { id: 'svc-diagtrack', category: 'services', labelKey: 'optSvcDiagtrack', descKey: 'optSvcDiagtrackDesc', requiresAdmin: true },
  // Processes
  { id: 'proc-kill-browsers', category: 'processes', labelKey: 'optProcBrowsers', descKey: 'optProcBrowsersDesc', requiresAdmin: false },
  { id: 'proc-kill-chat', category: 'processes', labelKey: 'optProcChat', descKey: 'optProcChatDesc', requiresAdmin: false },
  { id: 'proc-kill-updaters', category: 'processes', labelKey: 'optProcUpdaters', descKey: 'optProcUpdatersDesc', requiresAdmin: false },
  { id: 'proc-kill-custom', category: 'processes', labelKey: 'optProcCustom', descKey: 'optProcCustomDesc', requiresAdmin: false },
  // Memory
  { id: 'mem-clear-standby', category: 'memory', labelKey: 'optMemStandby', descKey: 'optMemStandbyDesc', requiresAdmin: false },
  // System
  { id: 'sys-focus-assist', category: 'system', labelKey: 'optSysFocusAssist', descKey: 'optSysFocusAssistDesc', requiresAdmin: false },
  { id: 'sys-power-plan', category: 'system', labelKey: 'optSysPowerPlan', descKey: 'optSysPowerPlanDesc', requiresAdmin: false },
  { id: 'sys-prevent-sleep', category: 'system', labelKey: 'optSysPreventSleep', descKey: 'optSysPreventSleepDesc', requiresAdmin: false },
  { id: 'sys-disable-game-bar', category: 'system', labelKey: 'optSysGameBar', descKey: 'optSysGameBarDesc', requiresAdmin: false },
  { id: 'sys-disable-fse-opt', category: 'system', labelKey: 'optSysFseOpt', descKey: 'optSysFseOptDesc', requiresAdmin: false },
  { id: 'sys-disable-transparency', category: 'system', labelKey: 'optSysTransparency', descKey: 'optSysTransparencyDesc', requiresAdmin: false },
  // Network
  { id: 'net-flush-dns', category: 'network', labelKey: 'optNetFlushDns', descKey: 'optNetFlushDnsDesc', requiresAdmin: false },
  { id: 'net-disable-nagle', category: 'network', labelKey: 'optNetNagle', descKey: 'optNetNagleDesc', requiresAdmin: true },
]

interface CategoryDef {
  id: GameModeCategory
  labelKey: string
  descKey: string
  icon: LucideIcon
  color: string
  glow: string
}

const CATEGORIES: CategoryDef[] = [
  { id: 'services', labelKey: 'categoryServices', descKey: 'categoryServicesDesc', icon: Server, color: '#06b6d4', glow: 'rgba(6,182,212,0.12)' },
  { id: 'processes', labelKey: 'categoryProcesses', descKey: 'categoryProcessesDesc', icon: Cpu, color: '#8b5cf6', glow: 'rgba(139,92,246,0.12)' },
  { id: 'memory', labelKey: 'categoryMemory', descKey: 'categoryMemoryDesc', icon: MemoryStick, color: '#22c55e', glow: 'rgba(34,197,94,0.12)' },
  { id: 'system', labelKey: 'categorySystem', descKey: 'categorySystemDesc', icon: Monitor, color: '#f59e0b', glow: 'rgba(245,158,11,0.12)' },
  { id: 'network', labelKey: 'categoryNetwork', descKey: 'categoryNetworkDesc', icon: Wifi, color: '#ec4899', glow: 'rgba(236,72,153,0.12)' },
]

// ── Colors ───────────────────────────────────────────────────

const CYAN = '#06b6d4'
const PURPLE = '#8b5cf6'
const CYAN_BG = 'rgba(6,182,212,0.08)'
const CYAN_BORDER = 'rgba(6,182,212,0.15)'

// ── Timer helper ─────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ── Animated Ring ────────────────────────────────────────────

function OrbitRing({ radius, duration, delay, active }: { radius: number; duration: number; delay: number; active: boolean }) {
  return (
    <motion.div
      className="pointer-events-none absolute rounded-full"
      style={{
        width: radius * 2,
        height: radius * 2,
        top: '50%',
        left: '50%',
        marginTop: -radius,
        marginLeft: -radius,
        border: `1px solid ${active ? 'rgba(6,182,212,0.15)' : 'var(--grid-line)'}`,
      }}
      animate={active ? {
        scale: [1, 1.05, 1],
        opacity: [0.4, 0.8, 0.4],
      } : {
        scale: 1,
        opacity: 0.3,
      }}
      transition={active ? {
        duration,
        delay,
        repeat: Infinity,
        ease: 'easeInOut',
      } : { duration: 0.5 }}
    >
      {active && (
        <motion.div
          className="absolute h-1.5 w-1.5 rounded-full"
          style={{
            background: CYAN,
            boxShadow: `0 0 6px 2px ${CYAN}`,
            top: -3,
            left: '50%',
            marginLeft: -3,
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: duration * 1.5, repeat: Infinity, ease: 'linear', delay }}
          // orbit around center
        />
      )}
    </motion.div>
  )
}

// ── Hex Grid Background ─────────────────────────────────────

function HexGrid({ active }: { active: boolean }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl"
      style={{ opacity: active ? 0.6 : 0.2 }}
    >
      <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="hex-grid" width="56" height="100" patternUnits="userSpaceOnUse" patternTransform="scale(0.5)">
            <path
              d="M28 66L0 50L0 16L28 0L56 16L56 50L28 66L28 100"
              fill="none"
              stroke={active ? 'rgba(6,182,212,0.08)' : 'var(--grid-line)'}
              strokeWidth="0.5"
            />
            <path
              d="M28 0L56 16L56 50L28 66L0 50L0 16Z"
              fill="none"
              stroke={active ? 'rgba(6,182,212,0.08)' : 'var(--grid-line)'}
              strokeWidth="0.5"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hex-grid)" />
      </svg>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────

export function GameModePage() {
  const { t } = useTranslation('gameMode')
  const store = useGameModeStore
  const active = useGameModeStore((s) => s.active)
  const activatedAt = useGameModeStore((s) => s.activatedAt)
  const status = useGameModeStore((s) => s.status)
  const progress = useGameModeStore((s) => s.progress)
  const lastResult = useGameModeStore((s) => s.lastResult)
  const config = useGameModeStore((s) => s.config)
  const expandedCategories = useGameModeStore((s) => s.expandedCategories)

  const [elapsed, setElapsed] = useState(0)
  const [customInput, setCustomInput] = useState('')
  const progressCleanupRef = useRef<(() => void) | null>(null)

  // Cleanup progress listener on unmount
  useEffect(() => {
    return () => { progressCleanupRef.current?.() }
  }, [])

  // Session timer
  useEffect(() => {
    if (!active || !activatedAt) {
      setElapsed(0)
      return
    }
    const start = new Date(activatedAt).getTime()
    const tick = () => setElapsed(Date.now() - start)
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [active, activatedAt])

  // Auto-dismiss result
  useEffect(() => {
    if (!lastResult) return
    const timer = setTimeout(() => store.getState().setLastResult(null), 8000)
    return () => clearTimeout(timer)
  }, [lastResult])

  const isBusy = status !== 'idle'

  const handleActivate = useCallback(async () => {
    if (config.enabledOptimizations.length === 0) {
      toast.error(t('noOptimizationsSelected'))
      return
    }
    store.getState().setStatus('activating')
    store.getState().setLastResult(null)

    progressCleanupRef.current = window.kudu?.onGameModeProgress?.((data) => {
      useGameModeStore.getState().setProgress(data)
    }) ?? null

    try {
      const result = await window.kudu.gameModeActivate(config)
      // Only mark as active if at least one optimization succeeded
      if (result.succeeded > 0) {
        store.getState().setActive(true, result.snapshot?.activatedAt ?? new Date().toISOString())
      }
      store.getState().setLastResult({ type: 'activate', succeeded: result.succeeded, failed: result.failed })
      if (result.succeeded === 0 && result.failed > 0) {
        toast.error(`All optimizations failed`)
      } else if (result.failed > 0) {
        toast.warning(`${result.failed} optimization(s) failed`)
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Activation failed')
    } finally {
      store.getState().setStatus('idle')
      store.getState().setProgress(null)
      progressCleanupRef.current?.()
      progressCleanupRef.current = null
    }
  }, [config, t])

  const handleDeactivate = useCallback(async () => {
    store.getState().setStatus('deactivating')
    store.getState().setLastResult(null)

    progressCleanupRef.current = window.kudu?.onGameModeProgress?.((data) => {
      useGameModeStore.getState().setProgress(data)
    }) ?? null

    try {
      const result = await window.kudu.gameModeDeactivate()
      // Only mark as inactive if all restores succeeded (snapshot deleted).
      // If some failed, the snapshot is kept and Game Mode remains active so the user can retry.
      if (result.failed === 0) {
        store.getState().setActive(false, null)
      } else {
        toast.warning(`${result.failed} setting(s) could not be restored — Game Mode stays active so you can retry`)
      }
      store.getState().setLastResult({ type: 'deactivate', succeeded: result.restored, failed: result.failed })
    } catch (err: any) {
      toast.error(err?.message ?? 'Deactivation failed')
    } finally {
      store.getState().setStatus('idle')
      store.getState().setProgress(null)
      progressCleanupRef.current?.()
      progressCleanupRef.current = null
    }
  }, [])

  const handleAddCustomProcess = useCallback(() => {
    const name = customInput.trim()
    if (!name || name.length > 100 || config.customProcessKillList.includes(name)) return
    if (!/^[A-Za-z0-9._\- ]+$/.test(name)) {
      toast.error('Process name can only contain letters, numbers, dots, hyphens, underscores, and spaces')
      return
    }
    store.getState().setCustomProcessKillList([...config.customProcessKillList, name])
    setCustomInput('')
  }, [customInput, config.customProcessKillList])

  const handleRemoveCustomProcess = useCallback((name: string) => {
    store.getState().setCustomProcessKillList(config.customProcessKillList.filter((n) => n !== name))
  }, [config.customProcessKillList])

  const enabledSet = new Set(config.enabledOptimizations)
  const enabledCount = config.enabledOptimizations.length
  const serviceCount = OPTIMIZATIONS.filter((o) => o.category === 'services' && enabledSet.has(o.id)).length

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      <div className="flex-1 space-y-5 px-6 pb-8">
        {/* ── Hero Toggle ─────────────────────────────── */}
        <div
          className="relative overflow-hidden rounded-2xl"
          style={{
            background: active
              ? 'linear-gradient(180deg, rgba(6,182,212,0.05) 0%, rgba(139,92,246,0.03) 50%, rgba(6,182,212,0.02) 100%)'
              : 'var(--bg-subtle)',
            border: active ? 'none' : '1px solid var(--border-medium)',
          }}
        >
          {/* Animated gradient border when active */}
          {active && (
            <div
              className="pointer-events-none absolute inset-0 rounded-2xl"
              style={{
                padding: '1px',
                background: 'linear-gradient(90deg, #06b6d4, #8b5cf6, #ec4899, #8b5cf6, #06b6d4)',
                backgroundSize: '300% 100%',
                animation: 'game-mode-border-flow 3s linear infinite',
                WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                WebkitMaskComposite: 'xor',
                maskComposite: 'exclude',
              }}
            />
          )}

          <HexGrid active={active} />

          {/* Radial glow behind the button */}
          {active && (
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{
                width: 300,
                height: 300,
                background: 'radial-gradient(circle, rgba(6,182,212,0.12) 0%, rgba(139,92,246,0.05) 40%, transparent 70%)',
              }}
            />
          )}

          <div className="relative flex flex-col items-center gap-5 py-10">
            {/* Orbit rings */}
            <div className="relative flex h-28 w-28 items-center justify-center">
              <OrbitRing radius={56} duration={3} delay={0} active={active} />
              <OrbitRing radius={72} duration={4} delay={0.5} active={active} />
              <OrbitRing radius={88} duration={5} delay={1} active={active} />

              {/* Toggle button */}
              <motion.button
                onClick={active ? handleDeactivate : handleActivate}
                disabled={isBusy}
                className="relative z-10 flex h-24 w-24 items-center justify-center rounded-full transition-all disabled:opacity-50"
                style={{
                  background: active
                    ? `linear-gradient(135deg, ${CYAN}, ${PURPLE})`
                    : 'var(--bg-subtle-2)',
                  border: `2px solid ${active ? 'transparent' : 'var(--border-strong)'}`,
                  boxShadow: active
                    ? `0 0 30px 4px rgba(6,182,212,0.3), 0 0 80px 8px rgba(139,92,246,0.15), inset 0 0 20px rgba(255,255,255,0.1)`
                    : '0 0 0 0 transparent',
                  animation: active ? 'game-mode-pulse 2.5s ease-in-out infinite' : undefined,
                }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                {isBusy ? (
                  <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-white/30 border-t-white" />
                ) : (
                  <Gamepad2
                    className="h-9 w-9"
                    style={{ color: active ? '#fff' : 'var(--text-dim)' }}
                    strokeWidth={1.8}
                  />
                )}
              </motion.button>
            </div>

            {/* Status label */}
            <div className="text-center">
              <motion.div
                className="text-xs font-bold tracking-[0.25em]"
                style={{ color: active ? CYAN : 'var(--text-dim)' }}
                animate={active ? { textShadow: [`0 0 8px rgba(6,182,212,0.4)`, `0 0 16px rgba(6,182,212,0.6)`, `0 0 8px rgba(6,182,212,0.4)`] } : { textShadow: '0 0 0 transparent' }}
                transition={active ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : {}}
              >
                {active ? t('activeLabel') : t('inactiveLabel')}
              </motion.div>

              {/* Timer */}
              {active && activatedAt && (
                <motion.div
                  className="mt-1.5 font-mono text-2xl font-bold tabular-nums"
                  style={{ color: CYAN, textShadow: '0 0 20px rgba(6,182,212,0.3)' }}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  {formatElapsed(elapsed)}
                </motion.div>
              )}
            </div>

            {/* Action button */}
            {!isBusy && (
              <motion.button
                onClick={active ? handleDeactivate : handleActivate}
                className="relative overflow-hidden rounded-lg px-6 py-2.5 text-xs font-bold tracking-widest transition-colors"
                style={{
                  background: active ? 'rgba(239,68,68,0.1)' : 'rgba(6,182,212,0.1)',
                  color: active ? '#ef4444' : CYAN,
                  border: `1px solid ${active ? 'rgba(239,68,68,0.2)' : 'rgba(6,182,212,0.2)'}`,
                }}
                whileHover={{
                  boxShadow: active
                    ? '0 0 20px rgba(239,68,68,0.15)'
                    : '0 0 20px rgba(6,182,212,0.15)',
                }}
                whileTap={{ scale: 0.97 }}
              >
                {active ? t('deactivateButton') : t('activateButton')}
              </motion.button>
            )}
          </div>
        </div>

        {/* ── Live Stats Bar ─────────────────────────── */}
        <AnimatePresence>
          {active && (
            <motion.div
              initial={{ opacity: 0, y: -10, height: 0 }}
              animate={{ opacity: 1, y: 0, height: 'auto' }}
              exit={{ opacity: 0, y: -10, height: 0 }}
              className="grid grid-cols-3 gap-3"
            >
              {[
                { icon: Zap, label: t('statOptimizationsActive'), value: String(enabledCount), color: CYAN },
                { icon: Activity, label: t('statServicesDisabled'), value: String(serviceCount), color: PURPLE },
                { icon: Timer, label: t('statSessionTimer'), value: formatElapsed(elapsed), color: '#22c55e' },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="flex items-center gap-3 rounded-xl px-4 py-3"
                  style={{
                    background: 'var(--bg-subtle)',
                    border: `1px solid var(--border-default)`,
                  }}
                >
                  <stat.icon className="h-4 w-4 shrink-0" style={{ color: stat.color }} strokeWidth={2} />
                  <div className="min-w-0">
                    <div className="truncate text-[10px] text-zinc-500">{stat.label}</div>
                    <div className="font-mono text-sm font-semibold tabular-nums" style={{ color: stat.color }}>
                      {stat.value}
                    </div>
                  </div>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Progress ────────────────────────────────── */}
        <AnimatePresence>
          {isBusy && progress && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden rounded-xl"
              style={{ background: 'var(--bg-subtle)', border: `1px solid ${CYAN_BORDER}` }}
            >
              <div className="px-5 py-4">
                <div className="mb-3 flex items-center gap-3">
                  <div
                    className="h-4 w-4 animate-spin rounded-full border-2 border-t-transparent"
                    style={{ borderColor: `${CYAN} transparent ${CYAN} ${CYAN}` }}
                  />
                  <span className="text-[13px] text-zinc-300">
                    {progress.phase === 'activating' ? t('activatingProgress') : t('deactivatingProgress')}
                  </span>
                </div>
                <div className="relative h-2 overflow-hidden rounded-full" style={{ background: 'var(--bg-subtle-2)' }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{
                      background: `linear-gradient(90deg, ${CYAN}, ${PURPLE}, ${CYAN})`,
                      backgroundSize: '200% 100%',
                      animation: 'shimmer 2s linear infinite',
                    }}
                    animate={{ width: `${(progress.current / progress.total) * 100}%` }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                  />
                </div>
                <div className="mt-2 text-[11px] text-zinc-500">
                  {progress.currentLabel} ({progress.current}/{progress.total})
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Result Banner ───────────────────────────── */}
        <AnimatePresence>
          {lastResult && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="flex items-center gap-3 rounded-xl px-5 py-3.5"
              style={{
                background: lastResult.failed > 0 ? 'var(--accent-muted-bg)' : 'rgba(34,197,94,0.08)',
                border: `1px solid ${lastResult.failed > 0 ? 'var(--accent-muted-border)' : 'rgba(34,197,94,0.15)'}`,
              }}
            >
              {lastResult.failed > 0 ? (
                <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: '#22c55e' }} />
              )}
              <span className="text-[13px]" style={{ color: lastResult.failed > 0 ? 'var(--accent-hover)' : '#86efac' }}>
                {lastResult.type === 'activate'
                  ? t('resultActivated', { count: lastResult.succeeded })
                  : t('resultDeactivated', { count: lastResult.succeeded })}
                {lastResult.failed > 0 && ` \u2022 ${t('resultErrors', { count: lastResult.failed })}`}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Config locked notice ────────────────────── */}
        {active && (
          <div
            className="flex items-center gap-2.5 rounded-lg px-4 py-2.5 text-[12px]"
            style={{ background: 'rgba(6,182,212,0.06)', border: `1px solid ${CYAN_BORDER}`, color: CYAN }}
          >
            <Shield className="h-3.5 w-3.5 shrink-0" />
            {t('configLockedWhileActive')}
          </div>
        )}

        {/* ── Category Cards ──────────────────────────── */}
        {CATEGORIES.map((cat, catIndex) => {
          const catOpts = OPTIMIZATIONS.filter((o) => o.category === cat.id)
          if (catOpts.length === 0) return null

          const enabledInCat = catOpts.filter((o) => enabledSet.has(o.id)).length
          const isExpanded = expandedCategories.has(cat.id)
          const CatIcon = cat.icon

          return (
            <motion.div
              key={cat.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: catIndex * 0.05, duration: 0.3 }}
              className="group overflow-hidden rounded-xl transition-all duration-300"
              style={{
                border: `1px solid ${isExpanded ? `${cat.color}22` : 'var(--border-default)'}`,
                background: isExpanded ? `linear-gradient(135deg, ${cat.glow}, transparent)` : 'var(--bg-subtle)',
              }}
            >
              {/* Category header */}
              <button
                onClick={() => store.getState().toggleCategory(cat.id)}
                className="flex w-full items-center gap-4 px-5 py-4 transition-colors hover:bg-white/[0.02]"
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-all duration-300"
                  style={{
                    background: `${cat.color}14`,
                    boxShadow: isExpanded ? `0 0 12px ${cat.color}20` : 'none',
                  }}
                >
                  <CatIcon className="h-[18px] w-[18px]" style={{ color: cat.color }} strokeWidth={1.8} />
                </div>
                <div className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-semibold text-zinc-200">{t(cat.labelKey)}</span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{ background: `${cat.color}14`, color: cat.color }}
                    >
                      {t('enabledCount', { count: enabledInCat })}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-zinc-500">{t(cat.descKey)}</p>
                </div>
                <motion.div
                  animate={{ rotate: isExpanded ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <ChevronDown className="h-4 w-4 shrink-0 text-zinc-600" />
                </motion.div>
              </button>

              {/* Expanded options */}
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                    style={{ borderTop: '1px solid var(--border-subtle)' }}
                  >
                    {catOpts.map((opt) => {
                      const isEnabled = enabledSet.has(opt.id)
                      return (
                        <div
                          key={opt.id}
                          className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-white/[0.01]"
                          style={{ borderBottom: '1px solid var(--bg-subtle)' }}
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-medium text-zinc-300">{t(opt.labelKey)}</span>
                              {opt.requiresAdmin && (
                                <span
                                  className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
                                  style={{ background: 'var(--accent-muted-bg)', color: 'var(--accent)' }}
                                >
                                  {t('adminBadge')}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-[11px] text-zinc-500">{t(opt.descKey)}</p>
                          </div>

                          {/* Toggle switch */}
                          <button
                            onClick={() => !active && store.getState().toggleOptimization(opt.id)}
                            disabled={active}
                            className="relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40"
                            style={{ background: isEnabled ? cat.color : 'var(--bg-active)' }}
                          >
                            <motion.div
                              className="absolute top-0.5 h-5 w-5 rounded-full"
                              animate={{
                                left: isEnabled ? 22 : 2,
                                background: isEnabled ? '#fff' : 'var(--text-muted)',
                              }}
                              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                            />
                          </button>
                        </div>
                      )
                    })}

                    {/* Custom process list (only in processes category) */}
                    {cat.id === 'processes' && (
                      <div className="px-5 py-3.5" style={{ borderBottom: '1px solid var(--bg-subtle)' }}>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={customInput}
                            onChange={(e) => setCustomInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddCustomProcess()}
                            placeholder={t('customProcessPlaceholder')}
                            disabled={active}
                            className="flex-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-[12px] text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-cyan-500/30 disabled:opacity-40"
                          />
                          <button
                            onClick={handleAddCustomProcess}
                            disabled={active || !customInput.trim()}
                            className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40"
                            style={{ background: `${cat.color}14`, color: cat.color }}
                          >
                            <Plus className="h-3 w-3" />
                            {t('customProcessAdd')}
                          </button>
                        </div>
                        {config.customProcessKillList.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {config.customProcessKillList.map((name) => (
                              <span
                                key={name}
                                className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px]"
                                style={{ background: 'var(--bg-subtle-2)', color: 'var(--text-secondary)' }}
                              >
                                {name}
                                {!active && (
                                  <button onClick={() => handleRemoveCustomProcess(name)} className="hover:text-red-400">
                                    <X className="h-3 w-3" />
                                  </button>
                                )}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-2 text-[11px] text-zinc-600">{t('customProcessEmpty')}</p>
                        )}
                        {enabledSet.has('proc-kill-custom') && config.customProcessKillList.length > 0 && (
                          <p className="mt-2 text-[10px] text-amber-500/70">{t('warningProcesses')}</p>
                        )}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
