import { cn } from '@/lib/utils'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { pageExperiences } from './page-experiences'

interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
  showWorkflow?: boolean
}

export function PageHeader({
  title,
  description,
  action,
  className,
  showWorkflow = true
}: PageHeaderProps) {
  const { pathname } = useLocation()
  const { t } = useTranslation('experience')
  const experience = pageExperiences[pathname]
  const Icon = experience?.icon
  return (
    <header
      className={cn('page-header pulse-page-header', className)}
      data-family={experience?.family}
    >
      <div className="page-header-main flex items-end justify-between gap-6">
        <div className="pulse-page-heading">
          {Icon && (
            <div className="pulse-page-kicker">
              <Icon size={16} strokeWidth={1.7} />
              <span>{t(`families.${experience.family}`)}</span>
            </div>
          )}
          <h1>{title}</h1>
          {(description || experience) && (
            <p>
              {description ??
                (experience ? t(`routes.${experience.key}`, { defaultValue: '' }) : '')}
            </p>
          )}
        </div>
        {action && <div className="page-header-actions flex items-center gap-2.5">{action}</div>}
      </div>
      {showWorkflow && experience?.steps && (
        <ol className="pulse-workflow" aria-label={t('workflow')}>
          {experience.steps.map((step, index) => (
            <li key={step}>
              <span aria-hidden="true">0{index + 1}</span>
              {t(`steps.${step}`)}
            </li>
          ))}
        </ol>
      )}
    </header>
  )
}
