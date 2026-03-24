import { useTranslation } from 'react-i18next'
import { Github, Bug, ExternalLink, RefreshCw, Download, CheckCircle, AlertCircle, Loader } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useAppUpdateStore } from '@/stores/app-update-store'
import logoSrc from '@/assets/logo.png'

declare const __APP_VERSION__: string

export function AboutPage() {
  const { t } = useTranslation('settings')
  const updateStatus = useAppUpdateStore((s) => s.status)

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('sectionAbout')} />

      <div className="glass-card rounded-2xl p-6">
        <div className="flex items-center gap-4">
          <img src={logoSrc} alt="Kudu" className="h-14 w-14 rounded-xl" />
          <div>
            <p className="text-[16px] font-semibold text-white">{t('appVersion', { version: __APP_VERSION__ })}</p>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>{t('license')}</p>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3">
          {updateStatus.state === 'idle' && (
            <button
              onClick={() => window.kudu?.updaterCheck?.()}
              className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium text-zinc-400 transition-colors"
              style={{ border: '1px solid var(--border-medium)' }}>
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} /> {t('checkForUpdates')}
            </button>
          )}
          {updateStatus.state === 'checking' && (
            <span className="flex items-center gap-2 text-[12px] text-zinc-500">
              <Loader className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} /> {t('checkingForUpdates')}
            </span>
          )}
          {updateStatus.state === 'not-available' && (
            <>
              <span className="flex items-center gap-2 text-[12px] text-zinc-500">
                <CheckCircle className="h-3.5 w-3.5" style={{ color: '#22c55e' }} strokeWidth={1.8} /> {t('upToDate')}
              </span>
              <button
                onClick={() => window.kudu?.updaterCheck?.()}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] font-medium text-zinc-400 transition-colors"
                style={{ border: '1px solid var(--border-medium)' }}>
                <RefreshCw className="h-3 w-3" strokeWidth={1.8} /> {t('checkAgain')}
              </button>
            </>
          )}
          {updateStatus.state === 'available' && (
            <>
              <span className="text-[12px] text-zinc-400">{t('versionAvailable', { version: updateStatus.version })}</span>
              <button
                onClick={() => window.kudu?.updaterDownload?.()}
                className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium text-zinc-200 transition-colors"
                style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}>
                <Download className="h-3.5 w-3.5" strokeWidth={1.8} /> {t('download')}
              </button>
            </>
          )}
          {updateStatus.state === 'downloading' && (
            <div className="flex flex-1 items-center gap-3">
              <Loader className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" strokeWidth={1.8} />
              <div className="flex-1">
                <div className="mb-1 text-[12px] text-zinc-400">{t('downloading', { progress: updateStatus.progress ?? 0 })}</div>
                <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-hover-2)' }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${updateStatus.progress ?? 0}%`, background: 'var(--accent)' }} />
                </div>
              </div>
            </div>
          )}
          {updateStatus.state === 'downloaded' && (
            <button
              onClick={() => window.kudu?.updaterInstall?.()}
              className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium transition-colors"
              style={{ background: '#22c55e', color: 'var(--text-on-accent)' }}>
              <Download className="h-3.5 w-3.5" strokeWidth={1.8} /> {t('restartAndInstall', { version: updateStatus.version })}
            </button>
          )}
          {updateStatus.state === 'error' && (
            <>
              <span className="flex items-center gap-2 text-[12px] text-red-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                {updateStatus.error}
              </span>
              <button
                onClick={() => window.kudu?.updaterCheck?.()}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] font-medium text-zinc-400 transition-colors"
                style={{ border: '1px solid var(--border-medium)' }}>
                {t('retry')}
              </button>
            </>
          )}
        </div>

        <div className="mt-6 flex items-center gap-2.5">
          <LinkButton icon={Github} label={t('github')} href="https://github.com/adventdevinc/kudu" />
          <LinkButton icon={Bug} label={t('reportBug')} href="https://github.com/adventdevinc/kudu/issues" />
        </div>
      </div>
    </div>
  )
}

function LinkButton({ icon: Icon, label, href }: { icon: typeof Github; label: string; href: string }) {
  return (
    <button
      onClick={() => window.open(href, '_blank')}
      className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium text-zinc-500 transition-colors"
      style={{ border: '1px solid var(--border-medium)' }}>
      <Icon className="h-3.5 w-3.5" strokeWidth={1.8} /> {label} <ExternalLink className="h-3 w-3 opacity-50" />
    </button>
  )
}
