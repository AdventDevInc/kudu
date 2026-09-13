import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { ToolIllustration } from './ToolIllustration'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('empty-state flex flex-col items-center justify-center py-20', className)}>
      <ToolIllustration />
      <span className="pulse-empty-kind" aria-hidden="true">
        <Icon size={15} strokeWidth={1.6} />
      </span>
      <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h3>
      <p className="mt-1.5 max-w-sm text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
