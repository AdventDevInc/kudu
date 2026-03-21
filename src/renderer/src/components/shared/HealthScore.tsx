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

function getScoreColor(score: number): string {
  if (score >= 71) return '#22c55e'
  if (score >= 41) return '#f59e0b'
  return '#ef4444'
}

export function HealthScore({ score, size = 'md', className }: HealthScoreProps) {
  const { t } = useTranslation('common')
  const [animatedScore, setAnimatedScore] = useState(0)
  const config = sizeConfig[size]
  const radius = (config.width - config.strokeWidth * 2) / 2
  const circumference = 2 * Math.PI * radius
  const color = getScoreColor(score)

  useEffect(() => {
    const timer = setTimeout(() => setAnimatedScore(score), 150)
    return () => clearTimeout(timer)
  }, [score])

  const offset = circumference - (animatedScore / 100) * circumference

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)}>
      {/* Glow */}
      <div
        className="absolute rounded-full opacity-15 blur-2xl"
        style={{
          width: config.width * 0.6,
          height: config.width * 0.6,
          backgroundColor: color
        }}
      />

      <svg width={config.width} height={config.width} className="-rotate-90">
        {/* Track */}
        <circle
          cx={config.width / 2}
          cy={config.width / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.04)"
          strokeWidth={config.strokeWidth}
        />
        {/* Arc */}
        <circle
          cx={config.width / 2}
          cy={config.width / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={config.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.16,1,0.3,1)' }}
        />
      </svg>

      <div className="absolute flex flex-col items-center">
        <span className={cn(config.fontSize, 'font-bold tracking-tight text-white')}>
          {Math.round(animatedScore)}
        </span>
        {size !== 'sm' && (
          <span className={cn(config.labelSize, 'font-medium uppercase tracking-widest')} style={{ color: '#52525e' }}>
            {t('health')}
          </span>
        )}
      </div>
    </div>
  )
}
