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
}

const CATEGORIES: CategoryDef[] = [
  { id: 'services', labelKey: 'categoryServices', descKey: 'categoryServicesDesc', icon: Server },
  { id: 'processes', labelKey: 'categoryProcesses', descKey: 'categoryProcessesDesc', icon: Cpu },
  { id: 'memory', labelKey: 'categoryMemory', descKey: 'categoryMemoryDesc', icon: MemoryStick },
  { id: 'system', labelKey: 'categorySystem', descKey: 'categorySystemDesc', icon: Monitor },
  { id: 'network', labelKey: 'categoryNetwork', descKey: 'categoryNetworkDesc', icon: Wifi },
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

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      <div className="flex-1 space-y-5 px-6 pb-8">
        {/* ── Hero Toggle ─────────────────────────────── */}
        <div
          className="relative flex flex-col items-center gap-4 rounded-2xl py-8"
          style={{
            background: active
              ? 'linear-gradient(180deg, rgba(6,182,212,0.06) 0%, rgba(139,92,246,0.03) 100%)'
              : 'rgba(255,255,255,0.02)',
            border: `1px solid ${active ? CYAN_BORDER : 'rgba(255,255,255,0.06)'}`,
          }}
        >
          {/* Toggle button */}
          <motion.button
            onClick={active ? handleDeactivate : handleActivate}
            disabled={isBusy}
            className="relative flex h-20 w-20 items-center justify-center rounded-full transition-all disabled:opacity-50"
            style={{
              background: active
                ? `linear-gradient(135deg, ${CYAN}, ${PURPLE})`
                : 'rgba(255,255,255,0.05)',
              border: `2px solid ${active ? CYAN : 'rgba(255,255,255,0.1)'}`,
              animation: active ? 'game-mode-pulse 2.5s ease-in-out infinite' : undefined,
            }}
            whileTap={{ scale: 0.95 }}
          >
            {isBusy ? (
              <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-white/30 border-t-white" />
            ) : (
              <Gamepad2
                className="h-8 w-8"
                style={{ color: active ? '#fff' : '#6e6e76' }}
                strokeWidth={2}
              />
            )}
          </motion.button>

          {/* Status label */}
          <div className="text-center">
            <div
              className="text-xs font-bold tracking-[0.2em]"
              style={{ color: active ? CYAN : '#6e6e76' }}
            >
              {active ? t('activeLabel') : t('inactiveLabel')}
            </div>

            {/* Timer */}
            {active && activatedAt && (
              <div
                className="mt-1 font-mono text-xl font-semibold tabular-nums"
                style={{ color: CYAN }}
              >
                {formatElapsed(elapsed)}
              </div>
            )}
          </div>

          {/* Action text */}
          {!isBusy && (
            <button
              onClick={active ? handleDeactivate : handleActivate}
              className="rounded-lg px-5 py-2 text-xs font-semibold tracking-wide transition-colors"
              style={{
                background: active ? 'rgba(239,68,68,0.1)' : CYAN_BG,
                color: active ? '#ef4444' : CYAN,
                border: `1px solid ${active ? 'rgba(239,68,68,0.2)' : CYAN_BORDER}`,
              }}
            >
              {active ? t('deactivateButton') : t('activateButton')}
            </button>
          )}
        </div>

        {/* ── Progress ────────────────────────────────── */}
        <AnimatePresence>
          {isBusy && progress && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden rounded-xl"
              style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${CYAN_BORDER}` }}
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
                <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: `linear-gradient(90deg, ${CYAN}, ${PURPLE})` }}
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
                background: lastResult.failed > 0 ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)',
                border: `1px solid ${lastResult.failed > 0 ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)'}`,
              }}
            >
              {lastResult.failed > 0 ? (
                <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: '#f59e0b' }} />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: '#22c55e' }} />
              )}
              <span className="text-[13px]" style={{ color: lastResult.failed > 0 ? '#fbbf24' : '#86efac' }}>
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
        {CATEGORIES.map((cat) => {
          const catOpts = OPTIMIZATIONS.filter((o) => o.category === cat.id)
          if (catOpts.length === 0) return null

          const enabledInCat = catOpts.filter((o) => enabledSet.has(o.id)).length
          const isExpanded = expandedCategories.has(cat.id)
          const CatIcon = cat.icon

          return (
            <div
              key={cat.id}
              className="overflow-hidden rounded-xl"
              style={{ border: `1px solid ${CYAN_BORDER}`, background: 'rgba(255,255,255,0.015)' }}
            >
              {/* Category header */}
              <button
                onClick={() => store.getState().toggleCategory(cat.id)}
                className="flex w-full items-center gap-4 px-5 py-4 transition-colors hover:bg-white/[0.02]"
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: CYAN_BG }}
                >
                  <CatIcon className="h-[18px] w-[18px]" style={{ color: CYAN }} strokeWidth={1.8} />
                </div>
                <div className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-semibold text-zinc-200">{t(cat.labelKey)}</span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{ background: CYAN_BG, color: CYAN }}
                    >
                      {t('enabledCount', { count: enabledInCat })}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-zinc-500">{t(cat.descKey)}</p>
                </div>
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-zinc-600 transition-transform"
                  style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }}
                />
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
                    style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                  >
                    {catOpts.map((opt) => {
                      const isEnabled = enabledSet.has(opt.id)
                      return (
                        <div
                          key={opt.id}
                          className="flex items-center gap-4 px-5 py-3.5"
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-medium text-zinc-300">{t(opt.labelKey)}</span>
                              {opt.requiresAdmin && (
                                <span
                                  className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
                                  style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}
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
                            style={{ background: isEnabled ? CYAN : 'rgba(255,255,255,0.08)' }}
                          >
                            <div
                              className="absolute top-0.5 h-5 w-5 rounded-full transition-all duration-200"
                              style={{
                                left: isEnabled ? '22px' : '2px',
                                background: isEnabled ? '#fff' : '#6e6e76',
                              }}
                            />
                          </button>
                        </div>
                      )
                    })}

                    {/* Custom process list (only in processes category) */}
                    {cat.id === 'processes' && (
                      <div className="px-5 py-3.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
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
                            style={{ background: CYAN_BG, color: CYAN }}
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
                                style={{ background: 'rgba(255,255,255,0.04)', color: '#a1a1aa' }}
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
            </div>
          )
        })}
      </div>
    </div>
  )
}
