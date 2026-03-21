import { useTranslation } from 'react-i18next'
import { Cpu, MemoryStick, Monitor, Clock } from 'lucide-react'
import { formatBytes } from '@/lib/utils'
import type { PerfSystemInfo } from '@shared/types'

interface SystemInfoHeaderProps {
  info: PerfSystemInfo | null
  uptime: number
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function SystemInfoHeader({ info, uptime }: SystemInfoHeaderProps) {
  const { t } = useTranslation('performance')
  if (!info) return null

  const items = [
    { icon: Cpu, label: t('systemInfoCpu'), value: `${info.cpuModel}`, sub: `${info.cpuCores}C / ${info.cpuThreads}T` },
    { icon: MemoryStick, label: t('systemInfoMemory'), value: formatBytes(info.totalMemBytes, 1), sub: '' },
    { icon: Monitor, label: t('systemInfoOs'), value: info.osVersion, sub: '' },
    { icon: Clock, label: t('systemInfoUptime'), value: formatUptime(uptime), sub: '' }
  ]

  return (
    <div
      className="mb-6 flex flex-wrap gap-4 rounded-2xl p-4"
      style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-3 px-2">
          <item.icon className="h-4 w-4 shrink-0" style={{ color: '#52525b' }} strokeWidth={1.8} />
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: '#4e4e56' }}>
              {item.label}
            </span>
            <span className="text-[12px] font-medium text-zinc-300">{item.value}</span>
            {item.sub && (
              <span className="text-[11px]" style={{ color: '#6e6e76' }}>{item.sub}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
