import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Cloud,
  Shield,
  ShieldAlert,
  Radar,
  Bug,
  Sparkles,
  MonitorSmartphone,
  Activity,
  FileSearch,
  Bell,
  RefreshCw,
  ExternalLink,
  Link,
  Unlink,
  Check,
  Crown,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { usePlatform } from '@/hooks/usePlatform'
import type { KuduSettings } from '@shared/types'

export function CloudPage() {
  const { t } = useTranslation('cloud')
  const { features, platform } = usePlatform()
  const { settings, updateSettings, setSettings } = useSettingsStore()

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

  useEffect(() => {
    if (!isLinked) { setCloudStatus(null); setCveSummary(null); return }
    refreshCloudStatus()
    const timer = setInterval(refreshCloudStatus, 5000)
    return () => clearInterval(timer)
  }, [isLinked, refreshCloudStatus])

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
        toast.success(t('deviceLinkedToast'))
        const fresh = await window.kudu?.settingsGet?.()
        if (fresh) setSettings(fresh)
      } else {
        toast.error(t('linkFailedToast'), { description: result?.error || t('linkFailedDefaultDesc') })
      }
    } catch {
      toast.error(t('linkFailedToast'), { description: t('linkFailedConnectionDesc') })
    }
    setCloudLinking(false)
  }

  const handleCloudUnlink = async () => {
    setCloudUnlinking(true)
    try {
      await window.kudu?.cloudUnlink?.()
      toast.success(t('deviceUnlinkedToast'))
      const fresh = await window.kudu?.settingsGet?.()
      if (fresh) setSettings(fresh)
    } catch {
      toast.error(t('unlinkFailedToast'))
    }
    setCloudUnlinking(false)
  }

  const handleCloudReconnect = async () => {
    setCloudReconnecting(true)
    try {
      await window.kudu?.cloudReconnect?.()
      refreshCloudStatus()
    } catch {
      toast.error(t('reconnectFailedToast'), { description: t('reconnectFailedDesc') })
    }
    setCloudReconnecting(false)
  }

  const save = (partial: Partial<typeof settings>) => {
    updateSettings(partial)
    window.kudu?.settingsSet?.(partial).catch(() => {})
  }

  const selectStyle = "rounded-lg px-3 py-1.5 text-[13px] text-zinc-400 outline-none"
  const selectBorder = { background: 'var(--bg-subtle-2)', border: '1px solid var(--border-medium)' }

  if (isLinked) {
    return (
      <div className="animate-fade-in max-w-4xl">
        <PageHeader title={t('pageTitle')} description={t('pageDescriptionLinked')} />
        <LinkedCloudSettings
          t={t}
          settings={settings}
          cloudStatus={cloudStatus}
          cveSummary={cveSummary}
          cloudReconnecting={cloudReconnecting}
          cloudUnlinking={cloudUnlinking}
          features={features}
          platform={platform}
          selectStyle={selectStyle}
          selectBorder={selectBorder}
          onReconnect={handleCloudReconnect}
          onUnlink={handleCloudUnlink}
          onSave={save}
        />
      </div>
    )
  }

  return (
    <div className="animate-fade-in max-w-4xl">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      {/* Hero */}
      <div
        className="relative overflow-hidden rounded-2xl p-8 mb-8"
        style={{
          background: 'linear-gradient(135deg, rgba(245,158,11,0.08) 0%, rgba(245,158,11,0.02) 50%, rgba(59,130,246,0.06) 100%)',
          border: '1px solid var(--accent-muted-border)',
        }}
      >
        <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full opacity-[0.07]" style={{ background: 'radial-gradient(circle, #f59e0b 0%, transparent 70%)' }} />
        <div className="absolute -left-8 -bottom-8 h-32 w-32 rounded-full opacity-[0.05]" style={{ background: 'radial-gradient(circle, #3b82f6 0%, transparent 70%)' }} />
        <div className="relative">
          <div className="flex items-center gap-3 mb-4">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-2xl"
              style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', boxShadow: '0 0 24px rgba(245,158,11,0.25)' }}
            >
              <Cloud className="h-6 w-6 text-black" strokeWidth={2} />
            </div>
            <div>
              <h2 className="text-[18px] font-bold text-white">{t('heroTitle')}</h2>
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{t('heroSubtitle')}</p>
            </div>
          </div>
          <p className="text-[13px] leading-relaxed max-w-xl mb-5" style={{ color: 'var(--text-secondary)' }}>
            {t('heroDescription')}
          </p>
          <button
            onClick={() => window.open('https://cloud.usekudu.com', '_blank')}
            className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-medium transition-all"
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
            {t('signUpFree')}
          </button>
        </div>
      </div>

      {/* Local features unlocked */}
      <SectionHeading title={t('localFeaturesTitle')} subtitle={t('localFeaturesSubtitle')} />
      <div className="grid grid-cols-2 gap-3 mb-4">
        <FeatureCard
          icon={ShieldAlert}
          title={t('featureThreatMonitorTitle')}
          description={t('featureThreatMonitorDesc')}
          color="#22c55e"
          tier="pro"
        />
        <FeatureCard
          icon={Bug}
          title={t('featureVulnerabilityTitle')}
          description={t('featureVulnerabilityDesc')}
          color="#ef4444"
          tier="pro"
        />
        <FeatureCard
          icon={Sparkles}
          title={t('featureAiSafetyTitle')}
          description={t('featureAiSafetyDesc')}
          color="#f59e0b"
          tier="basic"
        />
        <FeatureCard
          icon={Shield}
          title={t('featureBreachMonitorTitle')}
          description={t('featureBreachMonitorDesc')}
          color="#3b82f6"
          tier="basic"
        />
        <FeatureCard
          icon={Radar}
          title={t('featureHealthReportsTitle')}
          description={t('featureHealthReportsDesc')}
          color="#8b5cf6"
        />
      </div>
      <p className="text-[12px] mb-10 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
        {t('localFeaturesNote')}
      </p>

      {/* Cloud dashboard features */}
      <SectionHeading title={t('cloudFeaturesTitle')} subtitle={t('cloudFeaturesSubtitle')} />
      <div className="grid grid-cols-2 gap-3 mb-10">
        <FeatureCard
          icon={MonitorSmartphone}
          title={t('featureRemoteTitle')}
          description={t('featureRemoteDesc')}
          color="#8b5cf6"
        />
        <FeatureCard
          icon={Activity}
          title={t('featureTelemetryTitle')}
          description={t('featureTelemetryDesc')}
          color="#06b6d4"
        />
        <FeatureCard
          icon={FileSearch}
          title={t('featureComplianceTitle')}
          description={t('featureComplianceDesc')}
          color="#10b981"
        />
        <FeatureCard
          icon={Bell}
          title={t('featureAlertsTitle')}
          description={t('featureAlertsDesc')}
          color="#f97316"
          tier="pro"
        />
      </div>

      {/* Upgrade callout */}
      <div
        className="rounded-2xl p-5 mb-10 flex items-start gap-4"
        style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(139,92,246,0.06) 100%)', border: '1px solid rgba(59,130,246,0.12)' }}
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl mt-0.5"
          style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.2)' }}
        >
          <Crown className="h-[18px] w-[18px] text-blue-400" strokeWidth={1.8} />
        </div>
        <div>
          <h4 className="text-[13px] font-semibold text-zinc-200 mb-1">{t('upgradeCalloutTitle')}</h4>
          <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {t('upgradeCalloutDesc')}
          </p>
        </div>
      </div>

      {/* Plans */}
      <SectionHeading title={t('plansTitle')} subtitle={t('plansSubtitle')} />
      <div className="grid grid-cols-3 gap-3 mb-10">
        <PlanCard
          name={t('planStarterName')}
          price={t('planStarterPrice')}
          period={t('planStarterPeriod')}
          features={[
            t('planStarterFeature1'),
            t('planStarterFeature2'),
            t('planStarterFeature3'),
            t('planStarterFeature4'),
            t('planStarterFeature5'),
          ]}
          highlight={false}
        />
        <PlanCard
          name={t('planBasicName')}
          price={t('planBasicPrice')}
          period={t('planBasicPeriod')}
          features={[
            t('planBasicFeature1'),
            t('planBasicFeature2'),
            t('planBasicFeature3'),
            t('planBasicFeature4'),
            t('planBasicFeature5'),
          ]}
          highlight={false}
          badge={t('planPopularBadge')}
        />
        <PlanCard
          name={t('planProName')}
          price={t('planProPrice')}
          period={t('planProPeriod')}
          features={[
            t('planProFeature1'),
            t('planProFeature2'),
            t('planProFeature3'),
            t('planProFeature4'),
            t('planProFeature5'),
            t('planProFeature6'),
            t('planProFeature7'),
          ]}
          highlight
        />
      </div>

      {/* Connect section */}
      <div
        className="rounded-2xl p-6 mb-4"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
      >
        <h3 className="text-[15px] font-semibold text-white mb-1">{t('connectTitle')}</h3>
        <p className="text-[12px] mb-5" style={{ color: 'var(--text-muted)' }}>{t('connectDescription')}</p>

        <div className="flex gap-3 mb-4">
          <button
            onClick={() => window.open('https://cloud.usekudu.com', '_blank')}
            className="flex items-center gap-2 rounded-xl px-5 py-3 text-[13px] font-medium transition-all"
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
            {t('signUpFree')}
          </button>
        </div>

        <p className="text-[13px] mb-3" style={{ color: 'var(--text-muted)' }}>{t('alreadyHaveAccount')}</p>
        <div className="flex items-center gap-2.5">
          <input
            type="text"
            value={cloudApiKey}
            onChange={(e) => setCloudApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCloudLink()}
            placeholder={t('apiKeyPlaceholder')}
            className="flex-1 rounded-xl px-4 py-2.5 text-[13px] text-zinc-300 outline-none placeholder:text-zinc-700"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }}
          />
          <button
            onClick={handleCloudLink}
            disabled={cloudLinking || cloudApiKey.length < 10}
            className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
          >
            <Link className="h-3.5 w-3.5" strokeWidth={1.8} />
            {cloudLinking ? t('linking') : t('linkDevice')}
          </button>
        </div>
        <p className="mt-3 text-[11px]" style={{ color: 'var(--text-dim)' }}>
          {t('telemetryDisclaimer', { registryExtra: features.registry ? t('telemetryRegistryExtra') : '' })}
        </p>
      </div>
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────────────── */

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-[11px] font-medium uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>{title}</h3>
      <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-dim)' }}>{subtitle}</p>
    </div>
  )
}

const TIER_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  basic: { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.25)', text: '#60a5fa' },
  pro:   { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.25)', text: '#fbbf24' },
}

function FeatureCard({ icon: Icon, title, description, color, tier }: { icon: LucideIcon; title: string; description: string; color: string; tier?: 'basic' | 'pro' }) {
  const tierStyle = tier ? TIER_COLORS[tier] : null
  return (
    <div
      className="group relative rounded-2xl p-5 transition-all duration-300"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = `${color}22`
        e.currentTarget.style.boxShadow = `0 0 24px ${color}08`
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-default)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {tierStyle && (
        <div
          className="absolute top-3.5 right-3.5 rounded-md px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{ background: tierStyle.bg, border: `1px solid ${tierStyle.border}`, color: tierStyle.text }}
        >
          {tier}
        </div>
      )}
      <div
        className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl"
        style={{ background: `${color}15`, border: `1px solid ${color}20` }}
      >
        <Icon className="h-[18px] w-[18px]" style={{ color }} strokeWidth={1.8} />
      </div>
      <h4 className="text-[13px] font-semibold text-zinc-200 mb-1">{title}</h4>
      <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{description}</p>
    </div>
  )
}

function PlanCard({ name, price, period, features, highlight, badge }: {
  name: string; price: string; period: string; features: string[]; highlight: boolean; badge?: string
}) {
  return (
    <div
      className="relative rounded-2xl p-5 flex flex-col"
      style={{
        background: highlight
          ? 'linear-gradient(180deg, rgba(245,158,11,0.06) 0%, var(--card-bg) 100%)'
          : 'var(--card-bg)',
        border: highlight
          ? '1px solid var(--accent-muted-border)'
          : '1px solid var(--border-default)',
      }}
    >
      {badge && (
        <div
          className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
        >
          {badge}
        </div>
      )}
      {highlight && (
        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#000' }}
        >
          <Crown className="h-3 w-3" strokeWidth={2.5} />
          PRO
        </div>
      )}
      <div className="mb-4 mt-1">
        <p className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{name}</p>
        <div className="flex items-baseline gap-1 mt-1">
          <span className="text-[22px] font-bold text-white">{price}</span>
          <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{period}</span>
        </div>
      </div>
      <div className="space-y-2.5 flex-1">
        {features.map((f, i) => (
          <div key={i} className="flex items-start gap-2">
            <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: highlight ? '#f59e0b' : '#22c55e' }} strokeWidth={2.5} />
            <span className="text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>{f}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Linked settings (moved from SettingsPage) ────────────── */

function LinkedCloudSettings({ t, settings, cloudStatus, cveSummary, cloudReconnecting, cloudUnlinking, features, platform, selectStyle, selectBorder, onReconnect, onUnlink, onSave }: {
  t: (key: string, opts?: Record<string, unknown>) => string
  settings: KuduSettings
  cloudStatus: {
    status: string; maskedApiKey: string | null; deviceId: string | null
    linkedAt: string | null; lastTelemetryAt: string | null; lastHealthReportAt: string | null; error: string | null
    threatBlacklist: { version: string; updatedAt: string; domains: number; ips: number; cidrs: number } | null
  } | null
  cveSummary: { total: number; critical: number; high: number; medium: number; low: number; librarySize: number } | null
  cloudReconnecting: boolean
  cloudUnlinking: boolean
  features: { registry: boolean; [k: string]: unknown }
  platform: string
  selectStyle: string
  selectBorder: React.CSSProperties
  onReconnect: () => void
  onUnlink: () => void
  onSave: (partial: Partial<KuduSettings>) => void
}) {
  return (
    <>
      <Section title={t('sectionStatus')}>
        <Row label={t('statusLabel')}>
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
              {cloudStatus?.status ?? t('statusLoading')}
            </span>
            {(cloudStatus?.status === 'disconnected' || cloudStatus?.status === 'error') && (
              <button
                onClick={onReconnect}
                disabled={cloudReconnecting}
                className="ml-1 flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:text-white"
                style={{ background: 'var(--bg-hover-2)', border: '1px solid var(--border-strong)' }}
              >
                <RefreshCw className={cn('h-3 w-3', cloudReconnecting && 'animate-spin')} strokeWidth={2} />
                {cloudReconnecting ? t('connecting') : t('reconnect')}
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
        <Row label={t('deviceIdLabel')} desc={cloudStatus?.maskedApiKey ? t('deviceIdKeyDesc', { maskedApiKey: cloudStatus.maskedApiKey }) : undefined}>
          <span className="font-mono text-[12px] text-zinc-500">
            {cloudStatus?.deviceId?.slice(0, 8) ?? '—'}
          </span>
        </Row>
        {cloudStatus?.lastTelemetryAt && (
          <Row label={t('lastTelemetryLabel')} desc={t('lastTelemetryDesc')}>
            <span className="text-[12px] text-zinc-500">
              {new Date(cloudStatus.lastTelemetryAt).toLocaleTimeString()}
            </span>
          </Row>
        )}
        {cloudStatus?.lastHealthReportAt && (
          <Row label={t('lastHealthReportLabel')} desc={features.registry ? t('lastHealthReportDescWindows') : t('lastHealthReportDescOther')} last>
            <span className="text-[12px] text-zinc-500">
              {new Date(cloudStatus.lastHealthReportAt).toLocaleTimeString()}
            </span>
          </Row>
        )}
      </Section>

      <Section title={t('sectionMonitoring')}>
        <Row label={t('shareDiskHealthLabel')} desc={t('shareDiskHealthDesc')}>
          <Toggle checked={settings.cloud.shareDiskHealth} onChange={(v) => onSave({ cloud: { ...settings.cloud, shareDiskHealth: v } })} />
        </Row>
        <Row label={t('shareProcessListLabel')} desc={t('shareProcessListDesc')}>
          <Toggle checked={settings.cloud.shareProcessList} onChange={(v) => onSave({ cloud: { ...settings.cloud, shareProcessList: v } })} />
        </Row>
        <Row label={t('threatMonitorLabel')} desc={t('threatMonitorDesc')}>
          <Toggle checked={settings.cloud.shareThreatMonitor} onChange={(v) => onSave({ cloud: { ...settings.cloud, shareThreatMonitor: v } })} />
        </Row>
        <Row label={t('threatListLabel')} desc={cloudStatus?.threatBlacklist ? t('threatListDescLoaded', { version: cloudStatus.threatBlacklist.version, updatedDate: new Date(cloudStatus.threatBlacklist.updatedAt).toLocaleDateString() }) : t('threatListDescWaiting')}>
          {cloudStatus?.threatBlacklist ? (
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-ghost-2)' }}>
              {t('threatListRules', { totalRules: (cloudStatus.threatBlacklist.domains + cloudStatus.threatBlacklist.ips + cloudStatus.threatBlacklist.cidrs).toLocaleString() })}
              <span style={{ color: 'var(--text-ghost)' }}> {t('threatListBreakdown', { domains: cloudStatus.threatBlacklist.domains.toLocaleString(), ips: cloudStatus.threatBlacklist.ips.toLocaleString(), cidrs: cloudStatus.threatBlacklist.cidrs.toLocaleString() })}</span>
            </span>
          ) : (
            <span className="text-[11px]" style={{ color: 'var(--text-ghost)' }}>{t('threatListNotLoaded')}</span>
          )}
        </Row>
        <Row label={t('cveMonitorLabel')} desc={cveSummary && cveSummary.total > 0 ? t('cveDescLoaded', { findings: cveSummary.total, critical: cveSummary.critical, high: cveSummary.high, medium: cveSummary.medium, low: cveSummary.low }) : t('cveMonitorDesc')} last>
          {cveSummary && cveSummary.librarySize > 0 ? (
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-ghost-2)' }}>
              {t('cveLibrarySize', { count: cveSummary.librarySize.toLocaleString() })}
            </span>
          ) : (
            <span className="text-[11px]" style={{ color: 'var(--text-ghost)' }}>{cveSummary ? t('cveNoFindings') : t('cveNotScanned')}</span>
          )}
        </Row>
      </Section>

      <Section title={t('sectionRemoteControl')}>
        <Row label={t('remotePowerLabel')} desc={t('remotePowerDesc')}>
          <Toggle checked={settings.cloud.allowRemotePower} onChange={(v) => onSave({ cloud: { ...settings.cloud, allowRemotePower: v } })} />
        </Row>
        <Row label={t('remoteCleanupLabel')} desc={features.registry ? t('remoteCleanupDescWindows') : t('remoteCleanupDescOther')}>
          <Toggle checked={settings.cloud.allowRemoteCleanup} onChange={(v) => onSave({ cloud: { ...settings.cloud, allowRemoteCleanup: v } })} />
        </Row>
        <Row label={t('remoteInstallsLabel')} desc={platform === 'win32' ? t('remoteInstallsDescWindows') : t('remoteInstallsDescOther')}>
          <Toggle checked={settings.cloud.allowRemoteInstalls} onChange={(v) => onSave({ cloud: { ...settings.cloud, allowRemoteInstalls: v } })} />
        </Row>
        <Row label={t('remoteConfigLabel')} desc={t('remoteConfigDesc')} last>
          <Toggle checked={settings.cloud.allowRemoteConfig} onChange={(v) => onSave({ cloud: { ...settings.cloud, allowRemoteConfig: v } })} />
        </Row>
      </Section>

      <Section title={t('sectionAdvanced')}>
        <Row label={t('telemetryIntervalLabel')} desc={t('telemetryIntervalDesc')} last>
          <select
            value={settings.cloud.telemetryIntervalSec}
            onChange={(e) => onSave({ cloud: { ...settings.cloud, telemetryIntervalSec: Number(e.target.value) } })}
            className={selectStyle} style={selectBorder}
          >
            <option value={30}>{t('telemetryInterval30s')}</option>
            <option value={60}>{t('telemetryInterval1m')}</option>
            <option value={300}>{t('telemetryInterval5m')}</option>
            <option value={900}>{t('telemetryInterval15m')}</option>
          </select>
        </Row>
      </Section>

      <div className="mb-7">
        <button
          onClick={onUnlink}
          disabled={cloudUnlinking}
          className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[12px] font-medium text-red-400 transition-colors"
          style={{ border: '1px solid rgba(239,68,68,0.2)' }}
        >
          <Unlink className="h-3.5 w-3.5" strokeWidth={1.8} />
          {cloudUnlinking ? t('unlinking') : t('unlinkDevice')}
        </button>
      </div>
    </>
  )
}

/* ── Shared UI helpers ──────────────────────────────────────── */

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
