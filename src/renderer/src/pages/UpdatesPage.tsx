import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Cpu } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'
import { SoftwareUpdaterPage } from './SoftwareUpdaterPage'
import { DriverManagerPage } from './DriverManagerPage'
import { usePlatform } from '@/hooks/usePlatform'
import type { LucideIcon } from 'lucide-react'

interface TabDef {
  id: string
  label: string
  icon: LucideIcon
  description: string
}

const PM_DESCRIPTION_KEYS: Record<string, string> = {
  win32: 'tabs.softwareDescriptionWindows',
  darwin: 'tabs.softwareDescriptionMac',
  linux: 'tabs.softwareDescriptionLinux',
}

export function UpdatesPage() {
  const { t } = useTranslation('updates')
  const { platform, features } = usePlatform()
  const [activeTab, setActiveTab] = useState('software')

  const visibleTabs = useMemo(() => {
    const softwareTab: TabDef = {
      id: 'software',
      label: t('tabs.software'),
      icon: Download,
      description: t(PM_DESCRIPTION_KEYS[platform] || PM_DESCRIPTION_KEYS.linux),
    }
    const result: TabDef[] = [softwareTab]
    if (features.drivers) result.push({ id: 'drivers', label: t('tabs.drivers'), icon: Cpu, description: t('tabs.driversDescription') })
    return result
  }, [platform, features.drivers, t])

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
      />

      {/* Tab bar */}
      <div
        className="mb-6 flex rounded-xl p-1"
        style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
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
              style={isActive ? { background: 'rgba(245,158,11,0.08)' } : undefined}
            >
              <TabIcon className="h-4 w-4 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
              <span>{tab.label}</span>
              <span className="hidden text-[11px] sm:inline" style={{ color: isActive ? '#b08c2a' : '#4e4e56' }}>
                {tab.description}
              </span>
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'software' && <SoftwareUpdaterPage embedded />}
      {activeTab === 'drivers' && <DriverManagerPage embedded />}
    </div>
  )
}
