import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuickSample } from '@/hooks/useQuickTelemetry'

export function QuickTelemetryChart({ samples }: { samples: QuickSample[] }) {
  const { t } = useTranslation('experience')
  const gradient = useId()
  const path = (key: 'cpu' | 'memory') =>
    samples
      .map(
        (sample) =>
          `${((sample.at - samples[0].at) / Math.max(1, samples.at(-1)!.at - samples[0].at)) * 720},${160 - Math.max(0, Math.min(100, sample[key])) * 1.4}`
      )
      .join(' ')
  const seconds = samples.length > 1 ? Math.round((samples.at(-1)!.at - samples[0].at) / 1000) : 0
  return (
    <div className="pulse-telemetry-chart">
      <div className="pulse-chart-scale" aria-hidden="true">
        <span>100%</span>
        <span>50%</span>
        <span>0%</span>
      </div>
      <svg
        viewBox="0 0 720 180"
        preserveAspectRatio="none"
        role="img"
        aria-label={t('home.telemetryDescription')}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity=".18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[20, 90, 160].map((y) => (
          <line
            key={y}
            x1="0"
            x2="720"
            y1={y}
            y2={y}
            stroke="var(--border-medium)"
            strokeDasharray="3 6"
          />
        ))}
        {samples.length > 1 && (
          <>
            <polygon points={`0,180 ${path('cpu')} 720,180`} fill={`url(#${gradient})`} />
            <polyline
              points={path('cpu')}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <polyline
              points={path('memory')}
              fill="none"
              stroke="var(--success)"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </>
        )}
      </svg>
      {samples.length < 2 && <p className="pulse-chart-waiting">{t('home.collecting')}</p>}
      <div className="pulse-chart-times">
        <span>{seconds ? t('home.ago', { seconds }) : '—'}</span>
        <span>{t('home.now')}</span>
      </div>
    </div>
  )
}
