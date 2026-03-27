import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import {
  CheckCircle2,
  HardDrive,
  Files,
  Clock,
  Monitor,
  Globe,
  AppWindow,
  Gamepad2,
  Trash2,
  Link2Off,
  Database,
  Variable,
  ShieldAlert,
  ChevronDown
} from 'lucide-react'
import { useAnimatedCounter } from '@/hooks/useAnimatedCounter'
import { formatBytes, formatNumber, formatDuration } from '@/lib/utils'
import type { CleanSummaryData } from '@/stores/scan-store'
import type { LucideIcon } from 'lucide-react'

const categoryIcons: Record<string, LucideIcon> = {
  system: Monitor,
  browser: Globe,
  app: AppWindow,
  gaming: Gamepad2,
  recycleBin: Trash2,
  shortcut: Link2Off,
  database: Database,
  environment: Variable
}

interface CleanSummaryProps {
  summary: CleanSummaryData
  onRelaunchAsAdmin: () => void
  platform?: string
}

function MetricCard({
  icon: Icon,
  value,
  displayValue,
  unit,
  label,
  color,
  iconBg,
  delay
}: {
  icon: LucideIcon
  value: number
  displayValue?: string
  unit?: string
  label: string
  color: string
  iconBg: string
  delay: number
}) {
  const animated = useAnimatedCounter(value)
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl p-4"
      style={{ background: 'var(--bg-subtle)' }}
    >
      <div
        className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg"
        style={{ background: iconBg }}
      >
        <Icon className="h-4 w-4" style={{ color }} strokeWidth={1.8} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <p className="font-mono text-[22px] font-bold tracking-tight text-white">
          {displayValue ?? (unit ? animated.toFixed(decimals) : Math.round(animated).toLocaleString())}
        </p>
        {unit && <span className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{unit}</span>}
      </div>
      <p className="mt-0.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
    </motion.div>
  )
}

function CategoryBar({
  name,
  type,
  space,
  maxSpace,
  delay
}: {
  name: string
  type: string
  space: number
  maxSpace: number
  delay: number
}) {
  const Icon = categoryIcons[type] ?? Monitor
  const pct = maxSpace > 0 ? (space / maxSpace) * 100 : 0

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-center gap-3"
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: 'var(--bg-hover)' }}
      >
        <Icon className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} strokeWidth={1.8} />
      </div>
      <span className="w-28 shrink-0 truncate text-[12px] font-medium text-zinc-300">{name}</span>
      <div className="relative flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-hover)' }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ delay: delay + 0.15, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ background: 'linear-gradient(90deg, #f59e0b, #d97706)' }}
        />
      </div>
      <span className="w-16 shrink-0 text-right text-[11px] font-mono" style={{ color: 'var(--text-secondary)' }}>
        {formatBytes(space, 1)}
      </span>
    </motion.div>
  )
}

export function CleanSummary({ summary, onRelaunchAsAdmin, platform }: CleanSummaryProps) {
  const { t } = useTranslation('cleaner')
  const cleanedCategories = summary.categories.filter((c) => c.cleaned > 0)
  const maxCategorySpace = Math.max(...cleanedCategories.map((c) => c.space), 0)

  // Parse the formatted space into numeric value + unit for animated display
  const spaceStr = formatBytes(summary.totalCleaned)
  const spaceValue = parseFloat(spaceStr) || 0
  const spaceUnit = spaceStr.replace(/^[\d.]+\s*/, '')

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="mb-5 rounded-2xl overflow-hidden"
      style={{ background: 'var(--card-bg)', border: '1px solid rgba(34,197,94,0.15)' }}
    >
      {/* Green accent line */}
      <div
        className="h-[2px]"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(34,197,94,0.5), transparent)' }}
      />

      <div className="p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.15, type: 'spring', stiffness: 400, damping: 15 }}
            >
              <CheckCircle2 className="h-6 w-6 text-green-500" strokeWidth={1.8} />
            </motion.div>
            <h3 className="text-[15px] font-semibold text-zinc-100">{t('summaryTitle')}</h3>
          </div>
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="rounded-full px-3 py-1 text-[11px] font-medium"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)' }}
          >
            {t('summaryDuration', { duration: formatDuration(summary.duration) })}
          </motion.span>
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          <MetricCard
            icon={HardDrive}
            value={spaceValue}
            unit={spaceUnit}
            label={t('summarySpaceReclaimed')}
            color="#22c55e"
            iconBg="rgba(34,197,94,0.10)"
            delay={0.2}
          />
          <MetricCard
            icon={Files}
            value={summary.filesDeleted}
            label={t('summaryFilesDeleted')}
            color="#f59e0b"
            iconBg="rgba(245,158,11,0.10)"
            delay={0.3}
          />
          <MetricCard
            icon={Clock}
            value={0}
            displayValue={formatDuration(summary.duration)}
            label={t('summaryDurationLabel')}
            color="var(--text-muted)"
            iconBg="var(--bg-hover)"
            delay={0.4}
          />
        </div>

        {/* Category breakdown */}
        {cleanedCategories.length > 1 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.45 }}
          >
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              {t('summaryBreakdown')}
            </p>
            <div className="space-y-2.5">
              {cleanedCategories
                .sort((a, b) => b.space - a.space)
                .map((cat, i) => (
                  <CategoryBar
                    key={cat.type}
                    name={cat.name}
                    type={cat.type}
                    space={cat.space}
                    maxSpace={maxCategorySpace}
                    delay={0.5 + i * 0.08}
                  />
                ))}
            </div>
          </motion.div>
        )}

        {/* Skipped notice */}
        {summary.filesSkipped > 0 && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="mt-4 text-[12px]"
            style={{ color: 'var(--text-secondary)' }}
          >
            {t('summarySkipped', { count: formatNumber(summary.filesSkipped) })}
          </motion.p>
        )}

        {/* Elevation warning */}
        {summary.needsElevation && (
          <div
            className="mt-4 flex items-center gap-3 rounded-xl px-3 py-2.5"
            style={{ background: 'var(--accent-muted-bg)', border: '1px solid var(--accent-muted-border)' }}
          >
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" strokeWidth={1.8} />
            <p className="flex-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {t('permissionError')}
            </p>
            {platform !== 'darwin' && (
              <button
                onClick={onRelaunchAsAdmin}
                className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium text-amber-400 transition-colors hover:bg-amber-500/15"
                style={{ border: '1px solid rgba(245,158,11,0.2)' }}
              >
                {t('relaunchAsAdmin')}
              </button>
            )}
          </div>
        )}

        {/* Error details */}
        {summary.errors.length > 0 && (
          <details className="mt-3">
            <summary className="flex items-center gap-1 text-[11px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
              <ChevronDown className="h-3 w-3" strokeWidth={2} />
              {t('itemsCouldntBeDeleted', { count: summary.errors.length })}
            </summary>
            <div className="mt-1.5 max-h-32 overflow-y-auto space-y-0.5 ml-4">
              {summary.errors.slice(0, 20).map((err, i) => (
                <p key={i} className="text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                  {err.path.split(/[/\\]/).slice(-3).join('/')} — {err.reason === 'permission-denied' ? t('permissionDenied') : err.reason}
                </p>
              ))}
              {summary.errors.length > 20 && (
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {t('andMore', { count: summary.errors.length - 20 })}
                </p>
              )}
            </div>
          </details>
        )}
      </div>
    </motion.div>
  )
}
