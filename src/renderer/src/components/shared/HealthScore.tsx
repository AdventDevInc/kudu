import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface HealthScoreProps {
  score: number
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeConfig = {
  sm: { width: 80, strokeWidth: 5, fontSize: 'text-lg', labelSize: 'text-[9px]' },
  md: { width: 150, strokeWidth: 7, fontSize: 'text-[36px]', labelSize: 'text-[11px]' },
  lg: { width: 190, strokeWidth: 8, fontSize: 'text-[44px]', labelSize: 'text-[12px]' }
}

function getScoreColors(score: number): { start: string; end: string; glow: string } {
  if (score >= 71) return { start: '#22c55e', end: '#10b981', glow: '#22c55e' }
  if (score >= 41) return { start: '#fbbf24', end: '#f59e0b', glow: '#f59e0b' }
  return { start: '#ef4444', end: '#f43f5e', glow: '#ef4444' }
}

export function HealthScore({ score, size = 'md', className }: HealthScoreProps) {
  const { t } = useTranslation('common')
  const [animatedScore, setAnimatedScore] = useState(0)
  const config = sizeConfig[size]
  const radius = (config.width - config.strokeWidth * 2) / 2
  const circumference = 2 * Math.PI * radius
  const colors = getScoreColors(score)

  useEffect(() => {
    const timer = setTimeout(() => setAnimatedScore(score), 150)
    return () => clearTimeout(timer)
  }, [score])

  const offset = circumference - (animatedScore / 100) * circumference

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)} role="img" aria-label={`${t('health')}: ${Math.round(score)} / 100`}>
      {/* Outer glow */}
      <div
        className="absolute rounded-full opacity-20 blur-3xl"
        style={{
          width: config.width * 0.75,
          height: config.width * 0.75,
          backgroundColor: colors.glow
        }}
      />

      <svg width={config.width} height={config.width} className="-rotate-90" aria-hidden="true">
        <defs>
          <linearGradient id="health-arc-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
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
          stroke="url(#health-arc-gradient)"
          strokeWidth={config.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            transition: 'stroke-dashoffset 1s cubic-bezier(0.16,1,0.3,1)',
            filter: `drop-shadow(0 0 6px ${colors.glow}40)`
          }}
        />
      </svg>

      <div className="absolute flex flex-col items-center" aria-hidden="true">
        <span
          className={cn(config.fontSize, 'font-bold tracking-tight text-white')}
          style={{ textShadow: `0 0 20px ${colors.glow}30` }}
        >
          {Math.round(animatedScore)}
        </span>
        {size !== 'sm' && (
          <span className={cn(config.labelSize, 'font-medium uppercase tracking-widest')} style={{ color: 'var(--text-muted)' }}>
            {t('health')}
          </span>
        )}
      </div>
    </div>
  )
}
