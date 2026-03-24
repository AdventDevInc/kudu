import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Shield, Eye, PackageMinus, Server } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'
import { PrivacyShieldPage } from './PrivacyShieldPage'
import { DebloaterPage } from './DebloaterPage'
import { ServiceManagerPage } from './ServiceManagerPage'
import { usePlatform } from '@/hooks/usePlatform'
import type { LucideIcon } from 'lucide-react'

interface TabDef {
  id: string
  labelKey: string
  icon: LucideIcon
  descriptionKey: string
}

const tabs: TabDef[] = [
  { id: 'privacy', labelKey: 'tabs.privacy', icon: Eye, descriptionKey: 'tabs.privacyDescription' },
  { id: 'bloatware', labelKey: 'tabs.bloatware', icon: PackageMinus, descriptionKey: 'tabs.bloatwareDescription' },
  { id: 'services', labelKey: 'tabs.services', icon: Server, descriptionKey: 'tabs.servicesDescription' }
]

export function SystemHardeningPage() {
  const { t } = useTranslation('hardening')
  const { features, platform } = usePlatform()
  const [activeTab, setActiveTab] = useState('privacy')

  const visibleTabs = useMemo(() =>
    tabs.filter((tab) => {
      if (tab.id === 'bloatware' && !features.debloater) return false
      return true
    }),
    [features.debloater]
  )

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={platform === 'win32'
          ? t('descriptionWindows')
          : t('descriptionOther')}
      />

      {/* Tab bar */}
      <div
        className="mb-6 flex rounded-xl p-1"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
      >
        {visibleTabs.map((tab) => {
          const isActive = activeTab === tab.id
          const TabIcon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-2.5 rounded-lg px-4 py-3 text-[13px] font-medium transition-all',
                isActive ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-300'
              )}
              style={isActive ? { background: 'var(--accent-muted-bg)' } : undefined}
            >
              <TabIcon className="h-4 w-4 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
              <span>{t(tab.labelKey)}</span>
              <span className="hidden text-[11px] sm:inline" style={{ color: isActive ? 'var(--text-dim)' : 'var(--text-muted)' }}>
                {t(tab.descriptionKey)}
              </span>
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'privacy' && <PrivacyShieldPage embedded />}
      {activeTab === 'bloatware' && <DebloaterPage embedded />}
      {activeTab === 'services' && <ServiceManagerPage embedded />}
    </div>
  )
}
