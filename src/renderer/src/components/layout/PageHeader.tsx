import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function PageHeader({ title, description, action, className }: PageHeaderProps) {
  return (
    <div className={cn('mb-8 flex items-end justify-between', className)}>
      <div>
        <h1 className="text-[24px] font-bold tracking-tight text-white">{title}</h1>
        {description && (
          <p className="mt-1.5 text-[13px] animate-fade-in" style={{ color: 'var(--text-muted)' }}>
            {description}
          </p>
        )}
      </div>
      {action && <div className="flex items-center gap-2.5">{action}</div>}
    </div>
  )
}
