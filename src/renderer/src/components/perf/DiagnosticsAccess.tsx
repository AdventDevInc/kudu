import { Activity, ArrowRight, Cloud, Link2, Loader2, LockKeyhole, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { DiagnosticCapabilities } from '@shared/performance-diagnostics'
import '@/components/shared/cloud-conversion.css'

export function DiagnosticsAccess({
  capabilities,
  checking,
  failed,
  onRetry
}: {
  capabilities: DiagnosticCapabilities | null
  checking: boolean
  failed: boolean
  onRetry: () => void
}) {
  const { t } = useTranslation('diagnostics')
  const reconnect = capabilities?.accessReason === 'authorization'
  const upgrade = capabilities?.accessReason === 'subscription'

  if (!capabilities || reconnect) {
    return (
      <section className="diagnostics-access-status" aria-live="polite">
        {checking ? (
          <Loader2 className="animate-spin" size={24} aria-hidden="true" />
        ) : (
          <Link2 size={24} aria-hidden="true" />
        )}
        <div>
          <h2>
            {t(
              checking ? 'checkingAccess' : reconnect ? 'reconnectTitle' : 'accessUnavailableTitle'
            )}
          </h2>
          {!checking && <p>{t(reconnect ? 'reconnectDescription' : 'accessUnavailable')}</p>}
        </div>
        {!checking &&
          (reconnect ? (
            <Link className="cloud-offer-action" to="/cloud">
              {t('reconnectAction')} <ArrowRight size={16} />
            </Link>
          ) : (
            <button className="cloud-offer-action" onClick={onRetry}>
              {t('checkAccess')}
            </button>
          ))}
      </section>
    )
  }

  return (
    <section className="diagnostics-offer" aria-labelledby="diagnostics-offer-title">
      <div className="diagnostics-offer-intro">
        <span className="cloud-offer-eyebrow">
          <Cloud size={16} aria-hidden="true" /> {t('pro')}
        </span>
        <h2 id="diagnostics-offer-title">{t('upgradeTitle')}</h2>
        <p>{t('upgradeDescription')}</p>
      </div>
      <div className="diagnostics-offer-benefits">
        {(
          [
            ['capture', Activity],
            ['understand', Sparkles],
            ['control', LockKeyhole]
          ] as const
        ).map(([key, Icon]) => (
          <div key={key}>
            <Icon size={21} strokeWidth={1.6} aria-hidden="true" />
            <h3>{t(`benefits.${key}.title`)}</h3>
            <p>{t(`benefits.${key}.description`)}</p>
          </div>
        ))}
      </div>
      <div className="diagnostics-offer-footer">
        <div className="diagnostics-offer-actions">
          {upgrade ? (
            <button
              className="cloud-offer-action"
              onClick={() =>
                window.open('https://cloud.usekudu.com/organisation/billing', '_blank')
              }
            >
              {t('upgradeAction')} <ArrowRight size={16} aria-hidden="true" />
            </button>
          ) : (
            <Link className="cloud-offer-action" to="/cloud">
              {t('exploreAction')} <ArrowRight size={16} aria-hidden="true" />
            </Link>
          )}
          {upgrade ? (
            <button className="cloud-offer-secondary" onClick={onRetry} disabled={checking}>
              {t(checking ? 'checkingAccess' : 'checkAccess')}
            </button>
          ) : (
            <Link className="cloud-offer-secondary" to="/cloud">
              {t('alreadySubscribed')}
            </Link>
          )}
        </div>
        <p>{t('supportDevelopment')}</p>
      </div>
      {failed && (
        <p role="status" className="diagnostics-access-note">
          {t('accessUnavailable')}
        </p>
      )}
    </section>
  )
}
