import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Github, Bug, ExternalLink, Plus, X, FolderOpen, RefreshCw, Download, CheckCircle, AlertCircle, Loader, Unlink, Link } from 'lucide-react'
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

  const isLinked = !!settings.cloud.apiKey

  const refreshCloudStatus = useCallback(() => {
    window.kudu?.cloudGetStatus?.().then(setCloudStatus).catch(() => {})
  }, [])

  useEffect(() => { window.kudu?.settingsGet?.().then(setSettings).catch(() => {}) }, [])

  // Poll cloud status when linked
  useEffect(() => {
    if (!isLinked) { setCloudStatus(null); return }
    refreshCloudStatus()
    const timer = setInterval(refreshCloudStatus, 5000)
    return () => clearInterval(timer)
  }, [isLinked, refreshCloudStatus])

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
      toast.error(t('startupSettingFailedToast'))
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
  const selectBorder = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }

  return (
    <div className="animate-fade-in max-w-2xl">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      <Section title={t('sectionGeneral')}>
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
            <div className="rounded-xl p-4" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)' }}>
              <p className="text-[13px] font-medium text-zinc-200">
                {t('cloudFreeForDevices')}
              </p>
              <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: '#8e8e96' }}>
                {t('cloudDescription')}
              </p>
              <button
                onClick={() => window.open('https://cloud.usekudu.com', '_blank')}
                className="mt-3 flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium transition-colors"
                style={{ background: '#f59e0b', color: '#09090b' }}
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
                {t('cloudSignUpFree')}
              </button>
            </div>
            <p className="text-[13px] text-zinc-400">
              {t('cloudAlreadyHaveAccount')}
            </p>
            <div className="space-y-2.5">
              <input
                type="text"
                value={settings.cloud.serverUrl}
                onChange={(e) => save({ cloud: { ...settings.cloud, serverUrl: e.target.value } })}
                placeholder={t('cloudServerUrlPlaceholder')}
                className="w-full rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
              />
              <div className="flex items-center gap-2.5">
                <input
                  type="text"
                  value={cloudApiKey}
                  onChange={(e) => setCloudApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCloudLink()}
                  placeholder={t('cloudApiKeyPlaceholder')}
                  className="flex-1 rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
                />
                <button
                  onClick={handleCloudLink}
                  disabled={cloudLinking || cloudApiKey.length < 10}
                  className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-200 transition-colors disabled:opacity-40"
                  style={{ background: '#f59e0b', color: '#09090b' }}
                >
                  <Link className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {cloudLinking ? t('cloudLinking') : t('cloudLinkDevice')}
                </button>
              </div>
            </div>
            <p className="text-[11px]" style={{ color: '#4e4e56' }}>
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
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
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
                <span className="text-[11px] tabular-nums" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {t('cloudThreatListRules', { totalRules: (cloudStatus.threatBlacklist.domains + cloudStatus.threatBlacklist.ips + cloudStatus.threatBlacklist.cidrs).toLocaleString() })}
                  <span style={{ color: 'rgba(255,255,255,0.3)' }}> {t('cloudThreatListBreakdown', { domains: cloudStatus.threatBlacklist.domains.toLocaleString(), ips: cloudStatus.threatBlacklist.ips.toLocaleString(), cidrs: cloudStatus.threatBlacklist.cidrs.toLocaleString() })}</span>
                </span>
              ) : (
                <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{t('cloudThreatListNotLoaded')}</span>
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
            <div className="pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
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
            <p className="text-[13px]" style={{ color: '#4e4e56' }}>{t('noExclusionsConfigured')}</p>
          )}
          {settings.exclusions.map((exc, i) => (
            <div key={i} className="flex items-center justify-between rounded-xl px-4 py-2.5"
              style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="flex items-center gap-2.5">
                <FolderOpen className="h-3.5 w-3.5" style={{ color: '#4e4e56' }} strokeWidth={1.8} />
                <span className="font-mono text-[12px] text-zinc-400">{exc}</span>
              </div>
              <button onClick={() => save({ exclusions: settings.exclusions.filter((_, j) => j !== i) })}
                className="rounded-lg p-1.5 transition-colors" style={{ color: '#4e4e56' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
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
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }} />
            <button onClick={addExclusion}
              className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-400 transition-colors"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <Plus className="h-3.5 w-3.5" /> {t('addButton')}
            </button>
          </div>
        </div>
      </Section>

      <Section title={t('sectionAbout')}>
        <div className="py-3">
          <div className="flex items-center gap-4">
            <img src={logoSrc} alt="Kudu" className="h-11 w-11 rounded-xl" />
            <div>
              <p className="text-[14px] font-medium text-zinc-200">{t('appVersion', { version: __APP_VERSION__ })}</p>
              <p className="text-[12px]" style={{ color: '#52525e' }}>{t('license')}</p>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            {updateStatus.state === 'idle' && (
              <button
                onClick={() => window.kudu?.updaterCheck?.()}
                className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium text-zinc-400 transition-colors"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
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
                  style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
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
                  style={{ background: '#f59e0b', color: '#09090b' }}>
                  <Download className="h-3.5 w-3.5" strokeWidth={1.8} /> {t('download')}
                </button>
              </>
            )}
            {updateStatus.state === 'downloading' && (
              <div className="flex flex-1 items-center gap-3">
                <Loader className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" strokeWidth={1.8} />
                <div className="flex-1">
                  <div className="mb-1 text-[12px] text-zinc-400">{t('downloading', { progress: updateStatus.progress ?? 0 })}</div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${updateStatus.progress ?? 0}%`, background: '#f59e0b' }} />
                  </div>
                </div>
              </div>
            )}
            {updateStatus.state === 'downloaded' && (
              <button
                onClick={() => window.kudu?.updaterInstall?.()}
                className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium transition-colors"
                style={{ background: '#22c55e', color: '#09090b' }}>
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
                  style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                  {t('retry')}
                </button>
              </>
            )}
          </div>

          <div className="mt-5 flex items-center gap-2.5">
            <LinkButton icon={Github} label={t('github')} href="https://github.com/adventdevinc/kudu" />
            <LinkButton icon={Bug} label={t('reportBug')} href="https://github.com/adventdevinc/kudu/issues" />
          </div>
        </div>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-widest" style={{ color: '#4e4e56' }}>{title}</h3>
      <div className="rounded-2xl p-5" style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}>{children}</div>
    </div>
  )
}

function Row({ label, desc, children, last }: { label: string; desc?: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between py-3.5', !last && 'border-b')}
      style={!last ? { borderColor: 'rgba(255,255,255,0.04)' } : undefined}>
      <div>
        <p className="text-[13px] font-medium text-zinc-300">{label}</p>
        {desc && <p className="mt-0.5 text-[12px]" style={{ color: '#52525e' }}>{desc}</p>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)}
      className="relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors"
      style={{ background: checked ? '#f59e0b' : 'rgba(255,255,255,0.08)' }}>
      <div className={cn(
        'absolute top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-[22px]' : 'translate-x-[3px]'
      )} />
    </button>
  )
}

function LinkButton({ icon: Icon, label, href }: { icon: typeof Github; label: string; href: string }) {
  return (
    <button
      onClick={() => window.open(href, '_blank')}
      className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium text-zinc-500 transition-colors"
      style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
      <Icon className="h-3.5 w-3.5" strokeWidth={1.8} /> {label} <ExternalLink className="h-3 w-3 opacity-50" />
    </button>
  )
}
