import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function PageHeader({ title, description, action, className }: PageHeaderProps) {
  return (
    <div className={cn('page-header', className)}>
      <div className="page-header-main flex items-end justify-between gap-6">
        <div>
          <h1>{title}</h1>
          {description && (
            <p className="mt-1.5 animate-fade-in text-[12px]">
              {description}
            </p>
          )}
        </div>
        {action && <div className="page-header-actions flex items-center gap-2.5">{action}</div>}
      </div>
    </div>
  )
}
