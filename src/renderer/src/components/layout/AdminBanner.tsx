import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, X } from 'lucide-react'

export function AdminBanner() {
  const { t } = useTranslation('common')
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.kudu.elevationCheck().then((elevated) => {
      if (!elevated) setVisible(true)
    })
  }, [])

  if (!visible || dismissed) return null

  return (
    <div
      className="mx-4 mb-2 flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm"
      style={{
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1px solid rgba(245, 158, 11, 0.25)'
      }}
    >
      <ShieldAlert size={18} className="shrink-0 text-amber-500" />
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
        className="ml-auto shrink-0 text-zinc-600 transition-colors hover:text-zinc-400"
      >
        <X size={14} />
      </button>
    </div>
  )
}
