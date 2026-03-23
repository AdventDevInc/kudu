import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-20', className)}>
      <div
        className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
        style={{ background: 'rgba(255,255,255,0.03)' }}
        aria-hidden="true"
      >
        <Icon className="h-7 w-7" style={{ color: '#3a3a42' }} strokeWidth={1.5} />
      </div>
      <h3 className="text-[15px] font-medium" style={{ color: '#6e6e76' }}>{title}</h3>
      <p className="mt-1.5 max-w-sm text-center text-[13px]" style={{ color: '#4e4e56' }}>
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
