import type { CSSProperties } from 'react'

export function SegmentedMeter({
  value,
  label,
  tone = 'var(--success)'
}: {
  value: number | null
  label: string
  tone?: string
}) {
  const percent =
    value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value))
  return (
    <div
      className="pulse-segments"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={percent === null ? '—' : `${Math.round(percent)}%`}
      style={{ '--meter-color': tone } as CSSProperties}
    >
      {Array.from({ length: 24 }, (_, i) => (
        <i
          key={i}
          className={
            percent !== null && i < Math.round((percent * 24) / 100) ? 'is-filled' : undefined
          }
        />
      ))}
    </div>
  )
}
