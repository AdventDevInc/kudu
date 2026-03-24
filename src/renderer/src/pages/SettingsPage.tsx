import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Github, Bug, ExternalLink, Plus, X, FolderOpen, RefreshCw, Download, CheckCircle, AlertCircle, Loader, Unlink, Link, Sun, Moon, Monitor } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useAppUpdateStore } from '@/stores/app-update-store'
import { usePlatform } from '@/hooks/usePlatform'
import { LANGUAGES } from '@/lib/languages'
import i18next from 'i18next'
import logoSrc from '@/assets/logo.png'

export function SettingsPage() {
  const { t } = useTranslation('settings')
  const { features, platform } = usePlatform()
  const { settings, updateSettings, setSettings } = useSettingsStore()
  const [newExclusion, setNewExclusion] = useState('')
  const updateStatus = useAppUpdateStore((s) => s.status)

  // Cloud agent state
  const [cloudStatus, setCloudStatus] = useState<{
    status: string; maskedApiKey: string | null; deviceId: string | null
    linkedAt: string | null; lastTelemetryAt: string | null; lastHealthReportAt: string | null; error: string | null
    threatBlacklist: { version: string; updatedAt: string; domains: number; ips: number; cidrs: number } | null
  } | null>(null)
  const [cloudApiKey, setCloudApiKey] = useState('')
  const [cloudLinking, setCloudLinking] = useState(false)
  const [cloudUnlinking, setCloudUnlinking] = useState(false)
  const [cloudReconnecting, setCloudReconnecting] = useState(false)
  const [cveSummary, setCveSummary] = useState<{ total: number; critical: number; high: number; medium: number; low: number; librarySize: number } | null>(null)

  const isLinked = !!settings.cloud.apiKey

  const refreshCloudStatus = useCallback(() => {
    window.kudu?.cloudGetStatus?.().then(setCloudStatus).catch(() => {})
  }, [])

  useEffect(() => { window.kudu?.settingsGet?.().then(setSettings).catch(() => {}) }, [])

  // Poll cloud status when linked
  useEffect(() => {
    if (!isLinked) { setCloudStatus(null); setCveSummary(null); return }
    refreshCloudStatus()
    const timer = setInterval(refreshCloudStatus, 5000)
    return () => clearInterval(timer)
  }, [isLinked, refreshCloudStatus])

  // Fetch CVE summary once when cloud becomes connected
  useEffect(() => {
    if (cloudStatus?.status !== 'connected') return
    window.kudu?.cveFetch?.({ page: 1 })
      .then((r) => setCveSummary({ total: r.total, librarySize: r.librarySize, ...r.summary }))
      .catch(() => {})
  }, [cloudStatus?.status])

  const handleCloudLink = async () => {
    if (!cloudApiKey.trim() || cloudApiKey.length < 10) return
    setCloudLinking(true)
    try {
      const result = await window.kudu?.cloudLink?.(cloudApiKey.trim())
      if (result?.success) {
        setCloudApiKey('')
        toast.success(t('cloudDeviceLinkedToast'))
        // Refresh settings to get the new cloud config
        const fresh = await window.kudu?.settingsGet?.()
        if (fresh) setSettings(fresh)
      } else {
        toast.error(t('cloudLinkFailedToast'), { description: result?.error || t('cloudLinkFailedDefaultDesc') })
      }
    } catch {
      toast.error(t('cloudLinkFailedToast'), { description: t('cloudLinkFailedConnectionDesc') })
    }
    setCloudLinking(false)
  }

  const handleCloudUnlink = async () => {
    setCloudUnlinking(true)
    try {
      await window.kudu?.cloudUnlink?.()
      toast.success(t('cloudDeviceUnlinkedToast'))
      const fresh = await window.kudu?.settingsGet?.()
      if (fresh) setSettings(fresh)
    } catch {
      toast.error(t('cloudUnlinkFailedToast'))
    }
    setCloudUnlinking(false)
  }

  const handleCloudReconnect = async () => {
    setCloudReconnecting(true)
    try {
      await window.kudu?.cloudReconnect?.()
      refreshCloudStatus()
    } catch {
      toast.error(t('cloudReconnectFailedToast'), { description: t('cloudReconnectFailedDesc') })
    }
    setCloudReconnecting(false)
  }

  const save = (partial: Partial<typeof settings>) => {
    updateSettings(partial)
    window.kudu?.settingsSet?.(partial).catch(() => {})
  }

  const saveStartup = async (enabled: boolean) => {
    save({ runAtStartup: enabled })
    try {
      await window.kudu?.applyStartup?.(enabled)
    } catch {
      // Revert the toggle — the OS rejected the change
      save({ runAtStartup: !enabled })
      toast.error(t('startupSettingFailedToast'), {
        description: t('startupSettingFailedDesc'),
        action: {
          label: t('startupSettingFailedAction'),
          onClick: () => window.open('https://usekudu.com/help/startup-failed', '_blank'),
        },
      })
    }
  }

  const saveTray = (enabled: boolean) => {
    save({ minimizeToTray: enabled })
    window.kudu?.applyTray?.(enabled)
  }

  const addExclusion = () => {
    const value = newExclusion.trim()
    if (!value) return
    // Must be an absolute path or a *.ext glob
    const isDrivePath = /^[A-Za-z]:\\/.test(value)
    const isUncPath = /^\\\\[A-Za-z0-9]/.test(value)
    const isUnixPath = /^\/[A-Za-z0-9]/.test(value)
    const isGlob = /^\*\.[A-Za-z0-9]+$/.test(value)
    // Reject relative path traversal sequences
    if (value.includes('..')) return
    if (!isDrivePath && !isUncPath && !isUnixPath && !isGlob) return
    // Prevent duplicates
    if (settings.exclusions.includes(value)) return
    save({ exclusions: [...settings.exclusions, value] })
    setNewExclusion('')
  }

  const selectStyle = "rounded-lg px-3 py-1.5 text-[13px] text-zinc-400 outline-none"
  const selectBorder = { background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }

  return (
    <div className="animate-fade-in max-w-2xl">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      <Section title={t('sectionGeneral')}>
        <Row label={t('themeLabel', 'Theme')} desc={t('themeDesc', 'Choose between dark and light appearance')}>
          <ThemeSelector value={settings.theme} onChange={(v) => save({ theme: v })} />
        </Row>
        <Row label={t('languageLabel')} desc={t('languageDesc')}>
          <select
            value={settings.language}
            onChange={(e) => {
              save({ language: e.target.value })
              i18next.changeLanguage(e.target.value)
            }}
            className={selectStyle}
            style={selectBorder}
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.nativeName} ({lang.name})
              </option>
            ))}
          </select>
        </Row>
        <Row label={t('runAtStartupLabel')} desc={t('runAtStartupDesc')}>
          <Toggle checked={settings.runAtStartup} onChange={saveStartup} />
        </Row>
        <Row label={t('minimizeToTrayLabel')} desc={t('minimizeToTrayDesc')}>
          <Toggle checked={settings.minimizeToTray} onChange={saveTray} />
        </Row>
        <Row label={t('showNotificationsLabel')} desc={t('showNotificationsDesc')}>
          <Toggle checked={settings.showNotificationOnComplete} onChange={(v) => save({ showNotificationOnComplete: v })} />
        </Row>
        <Row label={t('threatDetectionAlertsLabel')} desc={t('threatDetectionAlertsDesc')}>
          <Toggle checked={settings.showThreatNotifications} onChange={(v) => save({ showThreatNotifications: v })} />
        </Row>
        <Row label={t('autoUpdateLabel')} desc={t('autoUpdateDesc')}>
          <Toggle checked={settings.autoUpdate} onChange={(v) => save({ autoUpdate: v })} />
        </Row>
        <Row label={t('autoRestartLabel')} desc={t('autoRestartDesc')}>
          <Toggle checked={settings.autoRestart} onChange={(v) => save({ autoRestart: v })} />
        </Row>
        <Row label={t('updateCheckIntervalLabel')} desc={t('updateCheckIntervalDesc')} last>
          <select value={settings.updateCheckIntervalHours}
            onChange={(e) => save({ updateCheckIntervalHours: Number(e.target.value) })}
            className={selectStyle} style={selectBorder}>
            <option value={1}>{t('updateCheckEveryHour')}</option>
            <option value={4}>{t('updateCheckEvery4Hours')}</option>
            <option value={12}>{t('updateCheckEvery12Hours')}</option>
            <option value={24}>{t('updateCheckOnceADay')}</option>
          </select>
        </Row>
      </Section>

      <Section title={t('sectionCloudDashboard')}>
        {!isLinked ? (
          <div className="space-y-4 py-1">
            <div className="rounded-xl p-4" style={{ background: 'var(--accent-muted-bg)', border: '1px solid var(--accent-muted-border)' }}>
              <p className="text-[13px] font-medium text-zinc-200">
                {t('cloudFreeForDevices')}
              </p>
              <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {t('cloudDescription')}
              </p>
              <button
                onClick={() => window.open('https://cloud.usekudu.com', '_blank')}
                className="mt-3 flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium transition-colors"
                style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
                {t('cloudSignUpFree')}
              </button>
            </div>
            <p className="text-[13px] text-zinc-400">
              {t('cloudAlreadyHaveAccount')}
            </p>
            <div className="space-y-2.5">
              <div className="flex items-center gap-2.5">
                <input
                  type="text"
                  value={cloudApiKey}
                  onChange={(e) => setCloudApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCloudLink()}
                  placeholder={t('cloudApiKeyPlaceholder')}
                  className="flex-1 rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }}
                />
                <button
                  onClick={handleCloudLink}
                  disabled={cloudLinking || cloudApiKey.length < 10}
                  className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-200 transition-colors disabled:opacity-40"
                  style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
                >
                  <Link className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {cloudLinking ? t('cloudLinking') : t('cloudLinkDevice')}
                </button>
              </div>
            </div>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {t('cloudTelemetryDisclaimer', { registryExtra: features.registry ? t('cloudTelemetryRegistryExtra') : '' })}
            </p>
          </div>
        ) : (
          <>
            <Row label={t('cloudStatusLabel')}>
              <div className="flex items-center gap-2">
                <div
                  className={cn('h-2.5 w-2.5 rounded-full', cloudStatus?.status === 'connecting' && 'animate-pulse')}
                  style={{
                    background:
                      cloudStatus?.status === 'connected' ? '#22c55e' :
                      cloudStatus?.status === 'connecting' ? '#f59e0b' :
                      cloudStatus?.status === 'disconnected' ? '#f59e0b' :
                      cloudStatus?.status === 'error' ? '#ef4444' : '#71717a'
                  }}
                />
                <span className="text-[13px] text-zinc-400 capitalize">
                  {cloudStatus?.status ?? t('cloudStatusLoading')}
                </span>
                {(cloudStatus?.status === 'disconnected' || cloudStatus?.status === 'error') && (
                  <button
                    onClick={handleCloudReconnect}
                    disabled={cloudReconnecting}
                    className="ml-1 flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:text-white"
                    style={{ background: 'var(--bg-hover-2)', border: '1px solid var(--border-strong)' }}
                  >
                    <RefreshCw className={cn('h-3 w-3', cloudReconnecting && 'animate-spin')} strokeWidth={2} />
                    {cloudReconnecting ? t('cloudConnecting') : t('cloudReconnect')}
                  </button>
                )}
              </div>
            </Row>
            {cloudStatus?.error && (
              <div className="flex items-start gap-2 py-2 px-0.5 -mt-2 mb-1">
                <span
                  className="text-[12px] leading-snug"
                  style={{ color: cloudStatus.status === 'error' ? '#ef4444' : '#f59e0b' }}
                >
                  {cloudStatus.error}
                </span>
              </div>
            )}
            <Row label={t('cloudDeviceIdLabel')} desc={cloudStatus?.maskedApiKey ? t('cloudDeviceIdKeyDesc', { maskedApiKey: cloudStatus.maskedApiKey }) : undefined}>
              <span className="font-mono text-[12px] text-zinc-500">
                {cloudStatus?.deviceId?.slice(0, 8) ?? '—'}
              </span>
            </Row>
            {cloudStatus?.lastTelemetryAt && (
              <Row label={t('cloudLastTelemetryLabel')} desc={t('cloudLastTelemetryDesc')}>
                <span className="text-[12px] text-zinc-500">
                  {new Date(cloudStatus.lastTelemetryAt).toLocaleTimeString()}
                </span>
              </Row>
            )}
            {cloudStatus?.lastHealthReportAt && (
              <Row label={t('cloudLastHealthReportLabel')} desc={features.registry ? t('cloudLastHealthReportDescWindows') : t('cloudLastHealthReportDescOther')}>
                <span className="text-[12px] text-zinc-500">
                  {new Date(cloudStatus.lastHealthReportAt).toLocaleTimeString()}
                </span>
              </Row>
            )}
            <Row label={t('cloudShareDiskHealthLabel')} desc={t('cloudShareDiskHealthDesc')}>
              <Toggle checked={settings.cloud.shareDiskHealth} onChange={(v) => save({ cloud: { ...settings.cloud, shareDiskHealth: v } })} />
            </Row>
            <Row label={t('cloudShareProcessListLabel')} desc={t('cloudShareProcessListDesc')}>
              <Toggle checked={settings.cloud.shareProcessList} onChange={(v) => save({ cloud: { ...settings.cloud, shareProcessList: v } })} />
            </Row>
            <Row label={t('cloudThreatMonitorLabel')} desc={t('cloudThreatMonitorDesc')}>
              <Toggle checked={settings.cloud.shareThreatMonitor} onChange={(v) => save({ cloud: { ...settings.cloud, shareThreatMonitor: v } })} />
            </Row>
            <Row label={t('cloudThreatListLabel')} desc={cloudStatus?.threatBlacklist ? t('cloudThreatListDescLoaded', { version: cloudStatus.threatBlacklist.version, updatedDate: new Date(cloudStatus.threatBlacklist.updatedAt).toLocaleDateString() }) : t('cloudThreatListDescWaiting')}>
              {cloudStatus?.threatBlacklist ? (
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-ghost-2)' }}>
                  {t('cloudThreatListRules', { totalRules: (cloudStatus.threatBlacklist.domains + cloudStatus.threatBlacklist.ips + cloudStatus.threatBlacklist.cidrs).toLocaleString() })}
                  <span style={{ color: 'var(--text-ghost)' }}> {t('cloudThreatListBreakdown', { domains: cloudStatus.threatBlacklist.domains.toLocaleString(), ips: cloudStatus.threatBlacklist.ips.toLocaleString(), cidrs: cloudStatus.threatBlacklist.cidrs.toLocaleString() })}</span>
                </span>
              ) : (
                <span className="text-[11px]" style={{ color: 'var(--text-ghost)' }}>{t('cloudThreatListNotLoaded')}</span>
              )}
            </Row>
            <Row label={t('cloudCveMonitorLabel')} desc={cveSummary && cveSummary.total > 0 ? t('cloudCveDescLoaded', { findings: cveSummary.total, critical: cveSummary.critical, high: cveSummary.high, medium: cveSummary.medium, low: cveSummary.low }) : t('cloudCveMonitorDesc')}>
              {cveSummary && cveSummary.librarySize > 0 ? (
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-ghost-2)' }}>
                  {t('cloudCveLibrarySize', { count: cveSummary.librarySize.toLocaleString() })}
                </span>
              ) : (
                <span className="text-[11px]" style={{ color: 'var(--text-ghost)' }}>{cveSummary ? t('cloudCveNoFindings') : t('cloudCveNotScanned')}</span>
              )}
            </Row>
            <Row label={t('cloudRemotePowerLabel')} desc={t('cloudRemotePowerDesc')}>
              <Toggle checked={settings.cloud.allowRemotePower} onChange={(v) => save({ cloud: { ...settings.cloud, allowRemotePower: v } })} />
            </Row>
            <Row label={t('cloudRemoteCleanupLabel')} desc={features.registry ? t('cloudRemoteCleanupDescWindows') : t('cloudRemoteCleanupDescOther')}>
              <Toggle checked={settings.cloud.allowRemoteCleanup} onChange={(v) => save({ cloud: { ...settings.cloud, allowRemoteCleanup: v } })} />
            </Row>
            <Row label={t('cloudRemoteInstallsLabel')} desc={platform === 'win32' ? t('cloudRemoteInstallsDescWindows') : t('cloudRemoteInstallsDescOther')}>
              <Toggle checked={settings.cloud.allowRemoteInstalls} onChange={(v) => save({ cloud: { ...settings.cloud, allowRemoteInstalls: v } })} />
            </Row>
            <Row label={t('cloudRemoteConfigLabel')} desc={t('cloudRemoteConfigDesc')}>
              <Toggle checked={settings.cloud.allowRemoteConfig} onChange={(v) => save({ cloud: { ...settings.cloud, allowRemoteConfig: v } })} />
            </Row>
            <Row label={t('cloudTelemetryIntervalLabel')} desc={t('cloudTelemetryIntervalDesc')}>
              <select
                value={settings.cloud.telemetryIntervalSec}
                onChange={(e) => save({ cloud: { ...settings.cloud, telemetryIntervalSec: Number(e.target.value) } })}
                className={selectStyle} style={selectBorder}
              >
                <option value={30}>{t('cloudTelemetryInterval30s')}</option>
                <option value={60}>{t('cloudTelemetryInterval1m')}</option>
                <option value={300}>{t('cloudTelemetryInterval5m')}</option>
                <option value={900}>{t('cloudTelemetryInterval15m')}</option>
              </select>
            </Row>
            <div className="pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button
                onClick={handleCloudUnlink}
                disabled={cloudUnlinking}
                className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[12px] font-medium text-red-400 transition-colors"
                style={{ border: '1px solid rgba(239,68,68,0.2)' }}
              >
                <Unlink className="h-3.5 w-3.5" strokeWidth={1.8} />
                {cloudUnlinking ? t('cloudUnlinking') : t('cloudUnlinkDevice')}
              </button>
            </div>
          </>
        )}
      </Section>

      <Section title={t('sectionCleaningPreferences')}>
        <Row label={t('secureDeleteLabel')} desc={t('secureDeleteDesc')}>
          <Toggle checked={settings.cleaner.secureDelete} onChange={(v) => save({ cleaner: { ...settings.cleaner, secureDelete: v } })} />
        </Row>
        <Row label={t('closeBrowsersLabel')} desc={t('closeBrowsersDesc')}>
          <Toggle checked={settings.cleaner.closeBrowsersBeforeClean} onChange={(v) => save({ cleaner: { ...settings.cleaner, closeBrowsersBeforeClean: v } })} />
        </Row>
        {features.restorePoint && (
          <Row label={t('createRestorePointLabel')} desc={t('createRestorePointDesc')}>
            <Toggle checked={settings.cleaner.createRestorePoint} onChange={(v) => save({ cleaner: { ...settings.cleaner, createRestorePoint: v } })} />
          </Row>
        )}
        <Row label={t('skipRecentFilesLabel')} desc={t('skipRecentFilesDesc')} last>
          <select value={settings.cleaner.skipRecentMinutes}
            onChange={(e) => save({ cleaner: { ...settings.cleaner, skipRecentMinutes: Number(e.target.value) } })}
            className={selectStyle} style={selectBorder}>
            <option value={30}>{t('skipRecent30Min')}</option>
            <option value={60}>{t('skipRecent1Hour')}</option>
            <option value={120}>{t('skipRecent2Hours')}</option>
            <option value={1440}>{t('skipRecent24Hours')}</option>
          </select>
        </Row>
      </Section>

      <Section title={t('sectionExclusions')}>
        <div className="space-y-2 pb-3">
          {settings.exclusions.length === 0 && (
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{t('noExclusionsConfigured')}</p>
          )}
          {settings.exclusions.map((exc, i) => (
            <div key={i} className="flex items-center justify-between rounded-xl px-4 py-2.5"
              style={{ background: 'var(--bg-subtle)' }}>
              <div className="flex items-center gap-2.5">
                <FolderOpen className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} strokeWidth={1.8} />
                <span className="font-mono text-[12px] text-zinc-400">{exc}</span>
              </div>
              <button onClick={() => save({ exclusions: settings.exclusions.filter((_, j) => j !== i) })}
                className="rounded-lg p-1.5 transition-colors" style={{ color: 'var(--text-muted)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2.5">
            <input type="text" value={newExclusion} onChange={(e) => setNewExclusion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addExclusion()}
              placeholder={platform === 'win32' ? t('exclusionPlaceholderWindows') : t('exclusionPlaceholderOther')}
              className="flex-1 rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }} />
            <button onClick={addExclusion}
              className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-400 transition-colors"
              style={{ background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }}>
              <Plus className="h-3.5 w-3.5" /> {t('addButton')}
            </button>
          </div>
        </div>
      </Section>

    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>{title}</h3>
      <div className="rounded-2xl p-5" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>{children}</div>
    </div>
  )
}

function Row({ label, desc, children, last }: { label: string; desc?: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between py-3.5', !last && 'border-b')}
      style={!last ? { borderColor: 'var(--border-subtle)' } : undefined}>
      <div>
        <p className="text-[13px] font-medium text-zinc-300">{label}</p>
        {desc && <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>{desc}</p>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)}
      className="relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors"
      style={{ background: checked ? 'var(--accent)' : 'var(--bg-active)' }}>
      <div className={cn(
        'absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-[22px]' : 'translate-x-[3px]'
      )} />
    </button>
  )
}

function ThemeSelector({ value, onChange }: { value: 'dark' | 'light' | 'system'; onChange: (v: 'dark' | 'light' | 'system') => void }) {
  const options: { id: 'dark' | 'light' | 'system'; icon: typeof Sun; label: string }[] = [
    { id: 'dark', icon: Moon, label: 'Dark' },
    { id: 'light', icon: Sun, label: 'Light' },
    { id: 'system', icon: Monitor, label: 'System' },
  ]
  return (
    <div className="flex gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }}>
      {options.map((opt) => {
        const active = value === opt.id
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all"
            style={{
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? 'var(--text-on-accent)' : 'var(--text-muted)',
            }}
          >
            <opt.icon className="h-3.5 w-3.5" strokeWidth={1.8} />
            {opt.label}
          </button>
        )
      })}
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
