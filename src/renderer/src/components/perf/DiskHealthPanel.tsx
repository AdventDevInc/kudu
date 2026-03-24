import { useTranslation } from 'react-i18next'
import { HardDrive, Thermometer, AlertTriangle, CheckCircle, XCircle, HelpCircle, ShieldAlert } from 'lucide-react'
import type { DiskSmartInfo } from '@shared/types'
import { formatBytes } from '@/lib/utils'

interface DiskHealthPanelProps {
  disks: DiskSmartInfo[]
}

const statusConfig = {
  Healthy: { icon: CheckCircle, color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  Caution: { icon: AlertTriangle, color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  Bad: { icon: XCircle, color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  Unknown: { icon: HelpCircle, color: 'var(--text-muted)', bg: 'rgba(110,110,118,0.1)' }
}

const statusI18nKeys = {
  Healthy: 'diskStatusHealthy',
  Caution: 'diskStatusCaution',
  Bad: 'diskStatusBad',
  Unknown: 'diskStatusUnknown'
} as const

function DiskCard({ disk }: { disk: DiskSmartInfo }) {
  const { t } = useTranslation('performance')
  const status = statusConfig[disk.healthStatus]
  const StatusIcon = status.icon

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl p-5"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl"
            style={{ background: 'var(--bg-subtle-2)' }}
          >
            <HardDrive className="h-4 w-4 text-zinc-400" />
          </div>
          <div>
            <div className="text-[13px] font-semibold text-white">{disk.model}</div>
            <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
              {disk.type} &middot; {formatBytes(disk.sizeBytes, 0)}
            </div>
          </div>
        </div>

        {/* Status badge */}
        <div
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1"
          style={{ background: status.bg }}
        >
          <StatusIcon className="h-3.5 w-3.5" style={{ color: status.color }} />
          <span className="text-[11px] font-semibold" style={{ color: status.color }}>
            {t(statusI18nKeys[disk.healthStatus])}
          </span>
        </div>
      </div>

      {/* Stats grid */}
      <div
        className="grid grid-cols-3 gap-3 rounded-xl p-3"
        style={{ background: 'var(--bg-subtle)' }}
      >
        <StatItem
          icon={<Thermometer className="h-3.5 w-3.5" />}
          label={t('temperature')}
          value={disk.temperature !== null ? `${disk.temperature}°C` : '--'}
          warn={disk.temperature !== null && disk.temperature > 60}
        />
        <StatItem
          label={t('powerOnHours')}
          value={disk.powerOnHours !== null ? formatHours(disk.powerOnHours) : '--'}
        />
        <StatItem
          label={t('remainingLife')}
          value={disk.remainingLife !== null ? `${disk.remainingLife}%` : '--'}
          warn={disk.remainingLife !== null && disk.remainingLife < 20}
        />
      </div>

      {/* Error stats (only show if any data available) */}
      {(disk.readErrors !== null || disk.writeErrors !== null || disk.reallocatedSectors !== null) && (
        <div
          className="grid grid-cols-3 gap-3 rounded-xl p-3"
          style={{ background: 'var(--bg-subtle)' }}
        >
          {disk.readErrors !== null && (
            <StatItem label={t('readErrors')} value={String(disk.readErrors)} warn={disk.readErrors > 0} />
          )}
          {disk.writeErrors !== null && (
            <StatItem label={t('writeErrors')} value={String(disk.writeErrors)} warn={disk.writeErrors > 0} />
          )}
          {disk.reallocatedSectors !== null && (
            <StatItem
              label={t('reallocatedSectors')}
              value={String(disk.reallocatedSectors)}
              warn={disk.reallocatedSectors > 0}
            />
          )}
        </div>
      )}
    </div>
  )
}

function StatItem({
  icon,
  label,
  value,
  warn
}: {
  icon?: React.ReactNode
  label: string
  value: string
  warn?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        {icon && <span style={{ color: warn ? '#f59e0b' : 'var(--text-muted)' }}>{icon}</span>}
        <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
      </div>
      <span
        className="text-[15px] font-bold"
        style={{ color: warn ? '#f59e0b' : 'var(--text-primary)' }}
      >
        {value}
      </span>
    </div>
  )
}

function formatHours(hours: number): string {
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 365) return `${days}d`
  const years = (days / 365).toFixed(1)
  return `${years}y`
}

export function DiskHealthPanel({ disks }: DiskHealthPanelProps) {
  const { t } = useTranslation('performance')
  if (disks.length === 0) return null

  const hasDetailedData = disks.some(
    (d) => d.temperature !== null || d.powerOnHours !== null || d.remainingLife !== null
  )

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-zinc-400">{t('diskHealthTitle')}</h3>
        {!hasDetailedData && (
          <div className="flex items-center gap-1 rounded-md px-2 py-0.5" style={{ background: 'var(--accent-muted-bg)' }}>
            <ShieldAlert className="h-3 w-3" style={{ color: '#92700c' }} />
            <span className="text-[10px] font-medium" style={{ color: '#92700c' }}>
              {t('diskHealthAdminHint')}
            </span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        {disks.map((disk) => (
          <DiskCard key={disk.device} disk={disk} />
        ))}
      </div>
    </div>
  )
}
