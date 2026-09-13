import { ArrowRight, Cloud } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useCloudConnection } from '@/hooks/useCloudConnection'
import { useSettingsStore } from '@/stores/settings-store'
import '@/components/shared/cloud-conversion.css'

/** Shared by both dashboard views so the Cloud path survives view changes. */
export function DashboardCloud({
  variant,
  children
}: {
  variant: 'rail' | 'compact'
  children: ReactNode
}) {
  const { t } = useTranslation('dashboard')
  const navigate = useNavigate()
  const linked = !!useSettingsStore((s) => s.settings.cloud.apiKey)
  const connection = useCloudConnection(linked)

  // Linking already verifies a subscription. Do not nag customers during a
  // reconnect or temporary outage, but restore the offer for expired plans.
  if (linked && connection !== 'subscription-required') return children

  return (
    <section
      className={`dashboard-cloud-offer dashboard-cloud-offer--${variant}`}
      aria-labelledby="dashboard-cloud-title"
    >
      <span className="cloud-offer-icon" aria-hidden="true">
        <Cloud size={25} />
      </span>
      <div>
        <span className="cloud-offer-eyebrow">{t('cloudUpsellEyebrow')}</span>
        <h2 id="dashboard-cloud-title">{t('cloudUpsellTitle')}</h2>
        <p>{t('cloudUpsellDescription')}</p>
      </div>
      <button className="cloud-offer-action" onClick={() => navigate('/cloud')}>
        {t('cloudUpsellAction')} <ArrowRight size={16} aria-hidden="true" />
      </button>
    </section>
  )
}
