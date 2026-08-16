import { cn } from '@/lib/utils'
import { useAnimatedCounter } from '@/hooks/useAnimatedCounter'
import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  icon: LucideIcon
  label: string
  value: number
  displayValue?: string
  unit?: string
  variant?: 'default' | 'accent' | 'success' | 'danger'
  className?: string
}

const variantConfig = {
  default: {
    iconBg: 'var(--bg-hover)',
    iconColor: 'var(--text-muted)',
    accentLine: 'var(--border-medium)',
    glowClass: '',
  },
  accent: {
    iconBg: 'var(--accent-muted-bg)',
    iconColor: 'var(--accent)',
    accentLine: 'var(--accent-muted-border)',
    glowClass: 'glow-amber',
  },
  success: {
    iconBg: 'color-mix(in srgb, var(--success), transparent 88%)',
    iconColor: 'var(--success)',
    accentLine: 'color-mix(in srgb, var(--success), transparent 58%)',
    glowClass: 'glow-green',
  },
  danger: {
    iconBg: 'color-mix(in srgb, var(--danger), transparent 88%)',
    iconColor: 'var(--danger)',
    accentLine: 'color-mix(in srgb, var(--danger), transparent 64%)',
    glowClass: '',
  },
}

export function StatCard({
  icon: Icon,
  label,
  value,
  displayValue,
  unit,
  variant = 'default',
  className
}: StatCardProps) {
  const animatedValue = useAnimatedCounter(value)
  const config = variantConfig[variant]

  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'calm-stat-card glass-card glass-card-hover group relative overflow-hidden rounded-2xl p-5',
        config.glowClass,
        className
      )}
    >
      {/* Accent line at top */}
      <div
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{
          background: `linear-gradient(90deg, transparent, ${config.accentLine}, transparent)`
        }}
      />

      {/* Icon in container */}
      <div
        className="mb-4 flex h-9 w-9 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110"
        style={{ background: config.iconBg }}
      >
        <Icon className="h-[18px] w-[18px]" style={{ color: config.iconColor }} strokeWidth={1.8} aria-hidden="true" />
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-[24px] font-bold tracking-tight text-white">
          {displayValue ?? Math.round(animatedValue).toLocaleString()}
        </span>
        {unit && <span className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{unit}</span>}
      </div>
      <p className="mt-1 text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</p>
    </div>
  )
}
