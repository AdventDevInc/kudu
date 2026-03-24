import { memo } from 'react'
import { cn } from '@/lib/utils'

interface GaugeCardProps {
  label: string
  percent: number
  detail: string
  className?: string
}

function getColor(pct: number): string {
  if (pct >= 85) return '#ef4444'
  if (pct >= 60) return '#f59e0b'
  return '#22c55e'
}

const SIZE = 120
const STROKE = 6
const RADIUS = (SIZE - STROKE * 2) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export const GaugeCard = memo(function GaugeCard({ label, percent, detail, className }: GaugeCardProps) {
  const clamped = Math.max(0, Math.min(100, percent))
  const offset = CIRCUMFERENCE - (clamped / 100) * CIRCUMFERENCE
  const color = getColor(clamped)
  const gradientId = `gauge-grad-${label.replace(/\s+/g, '-')}`

  return (
    <div
      className={cn('glass-card glass-card-hover flex flex-col items-center rounded-2xl p-5', className)}
    >
      <div className="relative inline-flex items-center justify-center">
        {/* Glow */}
        <div
          className="absolute rounded-full opacity-20 blur-2xl transition-opacity duration-500"
          style={{ width: SIZE * 0.5, height: SIZE * 0.5, backgroundColor: color }}
        />

        <svg width={SIZE} height={SIZE} className="-rotate-90">
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={color} stopOpacity="1" />
              <stop offset="100%" stopColor={color} stopOpacity="0.5" />
            </linearGradient>
          </defs>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--gauge-track)"
            strokeWidth={STROKE}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={`url(#${gradientId})`}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.16,1,0.3,1)' }}
          />
        </svg>

        <div className="absolute flex flex-col items-center">
          <span className="text-[26px] font-bold tracking-tight text-white">
            {Math.round(clamped)}
          </span>
          <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>%</span>
        </div>
      </div>

      <span className="mt-3 text-[13px] font-semibold text-white">{label}</span>
      <span className="mt-0.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
        {detail}
      </span>
    </div>
  )
})
