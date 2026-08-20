import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Radar, ShieldCheck, Globe, Wifi, CloudOff, Clock } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { useThreatMonitorStore } from '@/stores/threat-monitor-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useCloudConnection } from '@/hooks/useCloudConnection'
import type { FlaggedConnection, FlaggedDnsEntry } from '@shared/types'

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function ThreatMonitorPage() {
  const { t } = useTranslation('threatMonitor')
  const navigate = useNavigate()
  const snapshot = useThreatMonitorStore((s) => s.snapshot)
  const loaded = useThreatMonitorStore((s) => s.loaded)
  const load = useThreatMonitorStore((s) => s.load)
  const settings = useSettingsStore((s) => s.settings)
  const hasCloudKey = !!settings.cloud.apiKey
  const cloudConnection = useCloudConnection(hasCloudKey)

  useEffect(() => {
    if (!loaded) load()
  }, [loaded, load])

  // Poll for fresh snapshot while the page is visible so the "last scanned"
  // timestamps stay current even when no new threats are detected.
  useEffect(() => {
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  if (cloudConnection === 'checking') {
    return (
      <div className="p-8">
        <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
        <div className="flex items-center justify-center py-20 text-[13px]" style={{ color: 'var(--text-muted)' }}>{t('checkingConnection')}</div>
      </div>
    )
  }

  if (cloudConnection === 'subscription-required') {
    return (
      <div className="p-8">
        <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
        <EmptyState
          icon={CloudOff}
          title={t('planRequired.title')}
          description={t('planRequired.description')}
          action={<CloudAction label={t('planRequired.action')} onClick={() => window.open('https://cloud.usekudu.com/organisation/billing', '_blank')} />}
        />
      </div>
    )
  }

  // Cloud not configured or the saved connection needs attention
  if (cloudConnection !== 'connected') {
    const needsAttention = cloudConnection === 'authorization-error'
    return (
      <div className="p-8">
        <PageHeader
          title={t('pageTitle')}
          description={t('pageDescription')}
        />
        <EmptyState
          icon={CloudOff}
          title={needsAttention ? t('connectionError.title') : t('cloudNotConfigured.title')}
          description={needsAttention ? t('connectionError.description') : t('cloudNotConfigured.description')}
          action={<CloudAction label={needsAttention ? t('connectionError.action') : t('cloudNotConfigured.action')} onClick={() => navigate('/cloud')} />}
        />
      </div>
    )
  }

  // Loading
  if (!loaded) {
    return (
      <div className="p-8">
        <PageHeader
          title={t('pageTitle')}
          description={t('pageDescription')}
        />
        <div className="flex items-center justify-center py-20">
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{t('loading')}</div>
        </div>
      </div>
    )
  }

  // No snapshot (threat monitor not active — no blacklist loaded)
  if (!snapshot) {
    return (
      <div className="p-8">
        <PageHeader
          title={t('pageTitle')}
          description={t('pageDescription')}
        />
        <EmptyState
          icon={Radar}
          title={t('inactive.title')}
          description={t('inactive.description')}
          action={<CloudAction label={t('inactive.action')} onClick={() => window.open('https://cloud.usekudu.com/organisation/billing', '_blank')} />}
        />
      </div>
    )
  }

  const { flaggedConnections, flaggedDns, blacklistVersion, lastConnectionScanAt, lastDnsScanAt } = snapshot
  const totalThreats = flaggedConnections.length + flaggedDns.length

  return (
    <div className="p-8">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
      />

      {/* Status bar */}
      <div
        className="mb-6 flex flex-wrap items-center gap-5 rounded-xl px-5 py-3.5 text-[12px]"
        style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }}
      >
        {blacklistVersion && (
          <span style={{ color: 'var(--text-muted)' }}>
            {t('statusBar.blacklistVersion')} <span className="font-medium text-zinc-400">v{blacklistVersion}</span>
          </span>
        )}
        {lastConnectionScanAt && (
          <span className="flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
            <Clock className="h-3 w-3" />
            {t('statusBar.connectionsScanned', { time: formatTime(lastConnectionScanAt) })}
          </span>
        )}
        {lastDnsScanAt && (
          <span className="flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
            <Clock className="h-3 w-3" />
            {t('statusBar.dnsScanned', { time: formatTime(lastDnsScanAt) })}
          </span>
        )}
        <span
          className="ml-auto font-medium"
          style={{ color: totalThreats > 0 ? '#ef4444' : '#22c55e' }}
        >
          {totalThreats > 0 ? (totalThreats > 1 ? t('statusBar.threatsDetectedPlural', { count: totalThreats }) : t('statusBar.threatsDetected', { count: totalThreats })) : t('statusBar.noThreatsDetected')}
        </span>
      </div>

      {/* No threats */}
      {totalThreats === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title={t('allClear.title')}
          description={t('allClear.description')}
        />
      )}

      {/* Flagged Connections */}
      {flaggedConnections.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-zinc-300">
            <Wifi className="h-4 w-4 text-red-400" strokeWidth={2} />
            {t('flaggedConnections')}
            <span
              className="ml-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
              style={{ background: '#ef4444', color: '#fff' }}
            >
              {flaggedConnections.length}
            </span>
          </h2>
          <div className="space-y-1.5">
            {flaggedConnections.map((conn, i) => (
              <ConnectionRow key={`${conn.remoteAddress}:${conn.remotePort}-${i}`} conn={conn} />
            ))}
          </div>
        </section>
      )}

      {/* Flagged DNS */}
      {flaggedDns.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-zinc-300">
            <Globe className="h-4 w-4 text-red-400" strokeWidth={2} />
            {t('flaggedDnsEntries')}
            <span
              className="ml-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
              style={{ background: '#ef4444', color: '#fff' }}
            >
              {flaggedDns.length}
            </span>
          </h2>
          <div className="space-y-1.5">
            {flaggedDns.map((entry, i) => (
              <DnsRow key={`${entry.domain}-${i}`} entry={entry} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function CloudAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl px-5 py-2.5 text-[13px] font-semibold"
      style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
    >
      {label}
    </button>
  )
}

function ConnectionRow({ conn }: { conn: FlaggedConnection }) {
  const { t } = useTranslation('threatMonitor')
  return (
    <div
      className="flex items-center gap-4 rounded-lg px-4 py-3 text-[13px]"
      style={{ background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.1)' }}
    >
      <div className="min-w-0 flex-1">
        <span className="font-medium text-zinc-200">{conn.remoteAddress}</span>
        <span className="text-zinc-500">:{conn.remotePort}</span>
        {conn.pid != null && (
          <span className="ml-3 text-zinc-600">{t('connectionPid', { pid: conn.pid })}</span>
        )}
      </div>
      <div className="flex items-center gap-3 text-[12px]">
        <span
          className="rounded px-2 py-0.5 font-medium uppercase"
          style={{
            background: conn.matchType === 'cidr' ? 'rgba(249,115,22,0.1)' : 'rgba(239,68,68,0.1)',
            color: conn.matchType === 'cidr' ? '#f97316' : '#ef4444',
          }}
        >
          {conn.matchType}
        </span>
        <span className="text-zinc-600" title={conn.matchedRule}>
          {conn.matchedRule}
        </span>
        <span className="whitespace-nowrap text-zinc-600">
          {formatTime(conn.detectedAt)}
        </span>
      </div>
    </div>
  )
}

function DnsRow({ entry }: { entry: FlaggedDnsEntry }) {
  return (
    <div
      className="flex items-center gap-4 rounded-lg px-4 py-3 text-[13px]"
      style={{ background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.1)' }}
    >
      <div className="min-w-0 flex-1">
        <span className="font-medium text-zinc-200">{entry.domain}</span>
        {entry.resolvedAddress && (
          <span className="ml-3 text-zinc-500">{entry.resolvedAddress}</span>
        )}
      </div>
      <div className="flex items-center gap-3 text-[12px]">
        <span className="text-zinc-600" title={entry.matchedRule}>
          {entry.matchedRule}
        </span>
        <span className="whitespace-nowrap text-zinc-600">
          {formatTime(entry.detectedAt)}
        </span>
      </div>
    </div>
  )
}
