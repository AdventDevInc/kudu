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
    iconBg: 'rgba(255,255,255,0.05)',
    iconColor: '#6e6e76',
    accentLine: 'rgba(255,255,255,0.06)',
    glowClass: '',
  },
  accent: {
    iconBg: 'rgba(245,158,11,0.10)',
    iconColor: '#f59e0b',
    accentLine: 'rgba(245,158,11,0.4)',
    glowClass: 'glow-amber',
  },
  success: {
    iconBg: 'rgba(34,197,94,0.10)',
    iconColor: '#22c55e',
    accentLine: 'rgba(34,197,94,0.4)',
    glowClass: 'glow-green',
  },
  danger: {
    iconBg: 'rgba(239,68,68,0.10)',
    iconColor: '#ef4444',
    accentLine: 'rgba(239,68,68,0.3)',
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
        'glass-card glass-card-hover group relative overflow-hidden rounded-2xl p-5',
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
        {unit && <span className="text-[12px] font-medium" style={{ color: '#5e5e68' }}>{unit}</span>}
      </div>
      <p className="mt-1 text-[12px] font-medium" style={{ color: '#4e4e58' }}>{label}</p>
    </div>
  )
}
