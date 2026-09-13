import type { QuickSample } from '@/hooks/useQuickTelemetry'

export function MetricSparkline({
  samples,
  metric,
  label
}: {
  samples: QuickSample[]
  metric: 'cpu' | 'memory'
  label: string
}) {
  const visible = samples.slice(-24)
  if (visible.length < 2) return <div className="pulse-metric-sparkline" aria-hidden="true" />
  const start = visible[0].at
  const duration = Math.max(1, visible.at(-1)!.at - start)
  const points = visible
    .map(
      (sample) =>
        `${((sample.at - start) / duration) * 110},${33 - Math.max(0, Math.min(100, sample[metric])) * 0.3}`
    )
    .join(' ')
  return (
    <svg className="pulse-metric-sparkline" viewBox="0 0 110 36" role="img" aria-label={label}>
      <polyline
        points={points}
        fill="none"
        stroke={metric === 'cpu' ? 'var(--accent)' : 'var(--success)'}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}
