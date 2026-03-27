import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, X } from 'lucide-react'
import { usePlatform } from '@/hooks/usePlatform'

export function AdminBanner() {
  const { t } = useTranslation('common')
  const { platform } = usePlatform()
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.kudu.elevationCheck().then((elevated) => {
      if (!elevated) setVisible(true)
    })
  }, [])

  // On macOS the relaunch-as-admin flow doesn't work properly — hide the banner entirely
  if (platform === 'darwin') return null
  if (!visible || dismissed) return null

  return (
    <div
      role="status"
      className="mx-4 mb-2 flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm"
      style={{
        background: 'var(--accent-muted-bg)',
        border: '1px solid var(--accent-muted-border)'
      }}
    >
      <ShieldAlert size={18} className="shrink-0 text-amber-500" aria-hidden="true" />
      <span className="text-zinc-300">
        {t('adminBannerMessage')}
      </span>
      <button
        onClick={() => window.kudu.elevationRelaunch()}
        className="ml-1 shrink-0 rounded px-3 py-1 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/15"
      >
        {t('relaunchAsAdmin')}
      </button>
      <button
        onClick={() => setDismissed(true)}
        aria-label={t('dismiss', 'Dismiss')}
        className="ml-auto shrink-0 text-zinc-600 transition-colors hover:text-zinc-400"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
