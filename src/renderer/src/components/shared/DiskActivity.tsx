import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Disk enumeration has no measurable total. Only show progress supplied by a tool. */
export function DiskActivity({
  label,
  message,
  percent,
  className
}: {
  label: string
  message?: string
  percent?: number
  className?: string
}) {
  const progress =
    percent !== undefined && Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? Math.round(percent)
      : undefined

  return (
    <div
      className={cn('rounded-2xl p-5', className)}
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
    >
      <div role="status" className="flex items-center gap-3">
        <Loader2
          className="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none"
          style={{ color: 'var(--accent)' }}
          aria-hidden="true"
        />
        <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {label}
        </span>
      </div>
      {progress !== undefined && (
        <div className="mt-3 flex items-center gap-3">
          <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="h-1.5 flex-1 overflow-hidden rounded-full"
            style={{ background: 'var(--bg-subtle-2)' }}
          >
            <div
              className="h-full rounded-full transition-[width] motion-reduce:transition-none"
              style={{ width: `${progress}%`, background: 'var(--accent)' }}
            />
          </div>
          <span className="font-mono text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {progress}%
          </span>
        </div>
      )}
      {message && (
        <p className="mt-2 break-words text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {message}
        </p>
      )}
    </div>
  )
}
