import { useState, useEffect, useCallback } from 'react'
import { Github, Bug, ExternalLink, Plus, X, FolderOpen, RefreshCw, Download, CheckCircle, AlertCircle, Loader, Unlink, Link } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useAppUpdateStore } from '@/stores/app-update-store'
import { usePlatform } from '@/hooks/usePlatform'
import logoSrc from '@/assets/logo.png'

export function SettingsPage() {
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
        toast.success('Device linked to cloud dashboard')
        // Refresh settings to get the new cloud config
        const fresh = await window.kudu?.settingsGet?.()
        if (fresh) setSettings(fresh)
      } else {
        toast.error('Failed to link device', { description: result?.error || 'Check your API key and try again' })
      }
    } catch {
      toast.error('Failed to link device', { description: 'Could not connect to cloud server' })
    }
    setCloudLinking(false)
  }

  const handleCloudUnlink = async () => {
    setCloudUnlinking(true)
    try {
      await window.kudu?.cloudUnlink?.()
      toast.success('Device unlinked from cloud dashboard')
      const fresh = await window.kudu?.settingsGet?.()
      if (fresh) setSettings(fresh)
    } catch {
      toast.error('Failed to unlink device')
    }
    setCloudUnlinking(false)
  }

  const handleCloudReconnect = async () => {
    setCloudReconnecting(true)
    try {
      await window.kudu?.cloudReconnect?.()
      refreshCloudStatus()
    } catch {
      toast.error('Failed to reconnect', { description: 'Check your network connection and try again' })
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
      toast.error('Failed to update startup setting. Make sure Kudu has permission to create scheduled tasks.')
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
      <PageHeader title="Settings" description="Configure Kudu preferences" />

      <Section title="General">
        <Row label="Run at startup" desc="Launch Kudu when Windows starts">
          <Toggle checked={settings.runAtStartup} onChange={saveStartup} />
        </Row>
        <Row label="Minimize to tray" desc="Keep running in system tray when closed">
          <Toggle checked={settings.minimizeToTray} onChange={saveTray} />
        </Row>
        <Row label="Show notifications" desc="Display a notification when operations complete">
          <Toggle checked={settings.showNotificationOnComplete} onChange={(v) => save({ showNotificationOnComplete: v })} />
        </Row>
        <Row label="Threat detection alerts" desc="Show a system notification when suspicious network activity is detected">
          <Toggle checked={settings.showThreatNotifications} onChange={(v) => save({ showThreatNotifications: v })} />
        </Row>
        <Row label="Auto-update" desc="Automatically download and install updates">
          <Toggle checked={settings.autoUpdate} onChange={(v) => save({ autoUpdate: v })} />
        </Row>
        <Row label="Auto-restart for updates" desc="Restart automatically when an update is downloaded">
          <Toggle checked={settings.autoRestart} onChange={(v) => save({ autoRestart: v })} />
        </Row>
        <Row label="Update check interval" desc="How often to check for updates in the background" last>
          <select value={settings.updateCheckIntervalHours}
            onChange={(e) => save({ updateCheckIntervalHours: Number(e.target.value) })}
            className={selectStyle} style={selectBorder}>
            <option value={1}>Every hour</option>
            <option value={4}>Every 4 hours</option>
            <option value={12}>Every 12 hours</option>
            <option value={24}>Once a day</option>
          </select>
        </Row>
      </Section>

      <Section title="Cloud Dashboard">
        {!isLinked ? (
          <div className="space-y-4 py-1">
            <div className="rounded-xl p-4" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)' }}>
              <p className="text-[13px] font-medium text-zinc-200">
                Free for up to 5 devices
              </p>
              <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: '#8e8e96' }}>
                Monitor threats across all your systems, manage centralized cleaning profiles, trigger remote scans, and get real-time health telemetry — all from one dashboard.
              </p>
              <button
                onClick={() => window.open('https://cloud.usekudu.com', '_blank')}
                className="mt-3 flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium transition-colors"
                style={{ background: '#f59e0b', color: '#09090b' }}
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
                Sign up free
              </button>
            </div>
            <p className="text-[13px] text-zinc-400">
              Already have an account? Paste your API key below to link this device.
            </p>
            <div className="space-y-2.5">
              <input
                type="text"
                value={settings.cloud.serverUrl}
                onChange={(e) => save({ cloud: { ...settings.cloud, serverUrl: e.target.value } })}
                placeholder="Server URL (leave blank for default)"
                className="w-full rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
              />
              <div className="flex items-center gap-2.5">
                <input
                  type="text"
                  value={cloudApiKey}
                  onChange={(e) => setCloudApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCloudLink()}
                  placeholder="Paste your API key"
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
                  {cloudLinking ? 'Linking...' : 'Link Device'}
                </button>
              </div>
            </div>
            <p className="text-[11px]" style={{ color: '#4e4e56' }}>
              Only CPU &amp; memory usage, disk space, network stats, uptime, and periodic health reports ({features.registry ? 'registry, drivers, ' : ''}updates, privacy, malware). No file paths or personal data.
            </p>
          </div>
        ) : (
          <>
            <Row label="Status">
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
                  {cloudStatus?.status ?? 'Loading...'}
                </span>
                {(cloudStatus?.status === 'disconnected' || cloudStatus?.status === 'error') && (
                  <button
                    onClick={handleCloudReconnect}
                    disabled={cloudReconnecting}
                    className="ml-1 flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:text-white"
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
                  >
                    <RefreshCw className={cn('h-3 w-3', cloudReconnecting && 'animate-spin')} strokeWidth={2} />
                    {cloudReconnecting ? 'Connecting...' : 'Reconnect'}
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
            <Row label="Device ID" desc={cloudStatus?.maskedApiKey ? `Key: ${cloudStatus.maskedApiKey}` : undefined}>
              <span className="font-mono text-[12px] text-zinc-500">
                {cloudStatus?.deviceId?.slice(0, 8) ?? '—'}
              </span>
            </Row>
            {cloudStatus?.lastTelemetryAt && (
              <Row label="Last telemetry" desc="System stats (CPU, memory, disk, network)">
                <span className="text-[12px] text-zinc-500">
                  {new Date(cloudStatus.lastTelemetryAt).toLocaleTimeString()}
                </span>
              </Row>
            )}
            {cloudStatus?.lastHealthReportAt && (
              <Row label="Last health report" desc={features.registry ? 'Registry, drivers, updates, privacy, malware' : 'Updates, privacy, malware'}>
                <span className="text-[12px] text-zinc-500">
                  {new Date(cloudStatus.lastHealthReportAt).toLocaleTimeString()}
                </span>
              </Row>
            )}
            <Row label="Share disk health" desc="Include disk SMART data in telemetry">
              <Toggle checked={settings.cloud.shareDiskHealth} onChange={(v) => save({ cloud: { ...settings.cloud, shareDiskHealth: v } })} />
            </Row>
            <Row label="Share process list" desc="Include running processes in telemetry">
              <Toggle checked={settings.cloud.shareProcessList} onChange={(v) => save({ cloud: { ...settings.cloud, shareProcessList: v } })} />
            </Row>
            <Row label="Threat monitor" desc="Scan connections against known-malicious IPs and domains">
              <Toggle checked={settings.cloud.shareThreatMonitor} onChange={(v) => save({ cloud: { ...settings.cloud, shareThreatMonitor: v } })} />
            </Row>
            <Row label="Threat list" desc={cloudStatus?.threatBlacklist ? `v${cloudStatus.threatBlacklist.version} — updated ${new Date(cloudStatus.threatBlacklist.updatedAt).toLocaleDateString()}` : 'Waiting for cloud to push a threat list'}>
              {cloudStatus?.threatBlacklist ? (
                <span className="text-[11px] tabular-nums" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {(cloudStatus.threatBlacklist.domains + cloudStatus.threatBlacklist.ips + cloudStatus.threatBlacklist.cidrs).toLocaleString()} rules
                  <span style={{ color: 'rgba(255,255,255,0.3)' }}> ({cloudStatus.threatBlacklist.domains.toLocaleString()} domains, {cloudStatus.threatBlacklist.ips.toLocaleString()} IPs, {cloudStatus.threatBlacklist.cidrs.toLocaleString()} CIDRs)</span>
                </span>
              ) : (
                <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>Not loaded</span>
              )}
            </Row>
            <Row label="Remote power control" desc="Allow cloud to shutdown or restart this device">
              <Toggle checked={settings.cloud.allowRemotePower} onChange={(v) => save({ cloud: { ...settings.cloud, allowRemotePower: v } })} />
            </Row>
            <Row label="Remote cleanup" desc={features.registry ? 'Allow cloud to delete files, remove bloatware, and fix registry' : 'Allow cloud to delete files and perform cleanup'}>
              <Toggle checked={settings.cloud.allowRemoteCleanup} onChange={(v) => save({ cloud: { ...settings.cloud, allowRemoteCleanup: v } })} />
            </Row>
            <Row label="Remote installs" desc={platform === 'win32' ? 'Allow cloud to install software, driver, and Windows updates' : 'Allow cloud to install software and system updates'}>
              <Toggle checked={settings.cloud.allowRemoteInstalls} onChange={(v) => save({ cloud: { ...settings.cloud, allowRemoteInstalls: v } })} />
            </Row>
            <Row label="Remote config changes" desc="Allow cloud to toggle startup items, services, and privacy settings">
              <Toggle checked={settings.cloud.allowRemoteConfig} onChange={(v) => save({ cloud: { ...settings.cloud, allowRemoteConfig: v } })} />
            </Row>
            <Row label="Telemetry interval" desc="How often system stats are sent">
              <select
                value={settings.cloud.telemetryIntervalSec}
                onChange={(e) => save({ cloud: { ...settings.cloud, telemetryIntervalSec: Number(e.target.value) } })}
                className={selectStyle} style={selectBorder}
              >
                <option value={30}>30 seconds</option>
                <option value={60}>1 minute</option>
                <option value={300}>5 minutes</option>
                <option value={900}>15 minutes</option>
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
                {cloudUnlinking ? 'Unlinking...' : 'Unlink Device'}
              </button>
            </div>
          </>
        )}
      </Section>

      <Section title="Cleaning Preferences">
        <Row label="Secure delete (slower)" desc="Overwrite files before deletion for sensitive data (slower)">
          <Toggle checked={settings.cleaner.secureDelete} onChange={(v) => save({ cleaner: { ...settings.cleaner, secureDelete: v } })} />
        </Row>
        <Row label="Close browsers before clean" desc="Automatically close browsers to unlock cache files">
          <Toggle checked={settings.cleaner.closeBrowsersBeforeClean} onChange={(v) => save({ cleaner: { ...settings.cleaner, closeBrowsersBeforeClean: v } })} />
        </Row>
        {features.restorePoint && (
          <Row label="Create restore point" desc="Create a system restore point before cleaning (requires admin)">
            <Toggle checked={settings.cleaner.createRestorePoint} onChange={(v) => save({ cleaner: { ...settings.cleaner, createRestorePoint: v } })} />
          </Row>
        )}
        <Row label="Skip recent files" desc="Don't delete files modified within this time" last>
          <select value={settings.cleaner.skipRecentMinutes}
            onChange={(e) => save({ cleaner: { ...settings.cleaner, skipRecentMinutes: Number(e.target.value) } })}
            className={selectStyle} style={selectBorder}>
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
            <option value={120}>2 hours</option>
            <option value={1440}>24 hours</option>
          </select>
        </Row>
      </Section>

      <Section title="Exclusions">
        <div className="space-y-2 pb-3">
          {settings.exclusions.length === 0 && (
            <p className="text-[13px]" style={{ color: '#4e4e56' }}>No exclusions configured</p>
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
              placeholder={platform === 'win32' ? 'C:\\path\\to\\exclude or *.ext' : '/path/to/exclude or *.ext'}
              className="flex-1 rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }} />
            <button onClick={addExclusion}
              className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium text-zinc-400 transition-colors"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
          </div>
        </div>
      </Section>

      <Section title="About">
        <div className="py-3">
          <div className="flex items-center gap-4">
            <img src={logoSrc} alt="Kudu" className="h-11 w-11 rounded-xl" />
            <div>
              <p className="text-[14px] font-medium text-zinc-200">Kudu v{__APP_VERSION__}</p>
              <p className="text-[12px]" style={{ color: '#52525e' }}>MIT License · Open Source</p>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            {updateStatus.state === 'idle' && (
              <button
                onClick={() => window.kudu?.updaterCheck?.()}
                className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium text-zinc-400 transition-colors"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} /> Check for updates
              </button>
            )}
            {updateStatus.state === 'checking' && (
              <span className="flex items-center gap-2 text-[12px] text-zinc-500">
                <Loader className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} /> Checking for updates...
              </span>
            )}
            {updateStatus.state === 'not-available' && (
              <>
                <span className="flex items-center gap-2 text-[12px] text-zinc-500">
                  <CheckCircle className="h-3.5 w-3.5" style={{ color: '#22c55e' }} strokeWidth={1.8} /> You're up to date
                </span>
                <button
                  onClick={() => window.kudu?.updaterCheck?.()}
                  className="flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] font-medium text-zinc-400 transition-colors"
                  style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                  <RefreshCw className="h-3 w-3" strokeWidth={1.8} /> Check again
                </button>
              </>
            )}
            {updateStatus.state === 'available' && (
              <>
                <span className="text-[12px] text-zinc-400">v{updateStatus.version} available</span>
                <button
                  onClick={() => window.kudu?.updaterDownload?.()}
                  className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium text-zinc-200 transition-colors"
                  style={{ background: '#f59e0b', color: '#09090b' }}>
                  <Download className="h-3.5 w-3.5" strokeWidth={1.8} /> Download
                </button>
              </>
            )}
            {updateStatus.state === 'downloading' && (
              <div className="flex flex-1 items-center gap-3">
                <Loader className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" strokeWidth={1.8} />
                <div className="flex-1">
                  <div className="mb-1 text-[12px] text-zinc-400">Downloading... {updateStatus.progress ?? 0}%</div>
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
                <Download className="h-3.5 w-3.5" strokeWidth={1.8} /> Restart & Install v{updateStatus.version}
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
                  Retry
                </button>
              </>
            )}
          </div>

          <div className="mt-5 flex items-center gap-2.5">
            <LinkButton icon={Github} label="GitHub" href="https://github.com/adventdevinc/kudu" />
            <LinkButton icon={Bug} label="Report Bug" href="https://github.com/adventdevinc/kudu/issues" />
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
