import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface HealthScoreProps {
  score: number
  size?: 'sm' | 'md' | 'lg' | 'compact'
  className?: string
}

const sizeConfig = {
  compact: { width: 104, strokeWidth: 5, fontSize: 'text-[30px]', labelSize: 'text-[9px]' },
  sm: { width: 80, strokeWidth: 5, fontSize: 'text-lg', labelSize: 'text-[9px]' },
  md: { width: 150, strokeWidth: 7, fontSize: 'text-[36px]', labelSize: 'text-[11px]' },
  lg: { width: 190, strokeWidth: 8, fontSize: 'text-[44px]', labelSize: 'text-[12px]' }
}

function getScoreColors(score: number): { start: string; end: string; glow: string } {
  if (score >= 71) return { start: 'var(--success)', end: 'var(--success)', glow: 'var(--success)' }
  if (score >= 41) return { start: 'var(--warning)', end: 'var(--warning)', glow: 'var(--warning)' }
  return { start: 'var(--danger)', end: 'var(--danger)', glow: 'var(--danger)' }
}

export function HealthScore({ score, size = 'md', className }: HealthScoreProps) {
  const { t } = useTranslation('common')
  const animatedScore = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0
  const gradientId = useId()
  const config = sizeConfig[size]
  const radius = (config.width - config.strokeWidth * 2) / 2
  const circumference = 2 * Math.PI * radius
  const colors = getScoreColors(score)

  const offset = circumference - (animatedScore / 100) * circumference

  return (
    <div
      className={cn('relative inline-flex items-center justify-center', className)}
      role="img"
      aria-label={`${t('health')}: ${Math.round(score)} / 100`}
    >
      <svg width={config.width} height={config.width} className="-rotate-90" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={colors.start} />
            <stop offset="100%" stopColor={colors.end} />
          </linearGradient>
        </defs>
        {/* Track */}
        <circle
          cx={config.width / 2}
          cy={config.width / 2}
          r={radius}
          fill="none"
          stroke="var(--gauge-track)"
          strokeWidth={config.strokeWidth}
        />
        {/* Arc */}
        <circle
          cx={config.width / 2}
          cy={config.width / 2}
          r={radius}
          fill="none"
          stroke={'url(#' + gradientId + ')'}
          strokeWidth={config.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>

      <div className="absolute flex flex-col items-center" aria-hidden="true">
        <span
          className={cn(config.fontSize, 'font-medium tracking-tight')}
          style={{ color: 'var(--text-primary)' }}
        >
          {Math.round(animatedScore)}
        </span>
        {size !== 'sm' && (
          <span
            className={cn(config.labelSize, 'font-medium uppercase tracking-widest')}
            style={{ color: 'var(--text-muted)' }}
          >
            {t('health')}
          </span>
        )}
      </div>
    </div>
  )
}
