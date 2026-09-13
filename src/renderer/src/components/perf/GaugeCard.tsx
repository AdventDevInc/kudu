import { memo } from 'react'
import { cn } from '@/lib/utils'
import { SegmentedMeter } from '@/components/shared/SegmentedMeter'
interface GaugeCardProps {
  label: string
  percent: number | null
  detail: string
  value?: string
  className?: string
}
export const GaugeCard = memo(function GaugeCard({
  label,
  percent,
  detail,
  value,
  className
}: GaugeCardProps) {
  const reading =
    percent === null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent))
  const color =
    reading !== null && reading >= 85
      ? 'var(--danger)'
      : reading !== null && reading >= 60
        ? 'var(--accent)'
        : 'var(--success)'
  return (
    <section className={cn('pulse-resource-card', className)}>
      <h2>{label}</h2>
      <strong>
        {value ?? (reading === null ? '\u2014' : Math.round(reading))}
        {!value && reading !== null && <small>%</small>}
      </strong>
      {!value && <SegmentedMeter value={reading} label={label} tone={color} />}
      <p>{detail}</p>
    </section>
  )
})
