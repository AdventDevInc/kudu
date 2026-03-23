import { useTranslation } from 'react-i18next'
import { HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'

interface PageHeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
  showHintsToggle?: boolean
  className?: string
}

export function PageHeader({ title, description, action, showHintsToggle, className }: PageHeaderProps) {
  const { t } = useTranslation('common')
  const showHints = useSettingsStore((s) => s.settings.showHints)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const handleToggleHints = () => {
    const next = !showHints
    updateSettings({ showHints: next })
    window.kudu?.settingsSet?.({ showHints: next }).catch(() => {})
  }

  return (
    <div className={cn('mb-8 flex items-end justify-between', className)}>
      <div>
        <h1 className="text-[24px] font-bold tracking-tight text-white">{title}</h1>
        {description && (
          <p className="mt-1.5 text-[13px] animate-fade-in" style={{ color: '#5e5e68' }}>
            {description}
          </p>
        )}
      </div>
      {(showHintsToggle || action) && (
        <div className="flex items-center gap-2.5">
          {showHintsToggle && (
            <button
              onClick={handleToggleHints}
              title={showHints ? t('hideHints') : t('showHints')}
              className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
              style={{
                background: showHints ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${showHints ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.06)'}`
              }}
            >
              <HelpCircle
                className="h-4 w-4 transition-colors"
                style={{ color: showHints ? '#3b82f6' : '#6e6e76' }}
                strokeWidth={1.8}
              />
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  )
}
