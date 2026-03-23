import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn, formatBytes, formatNumber } from '@/lib/utils'

interface ScanProgressProps {
  status: 'scanning' | 'cleaning'
  progress: number
  currentPath?: string
  itemsFound?: number
  sizeFound?: number
  className?: string
}

export function ScanProgress({
  status,
  progress,
  currentPath,
  itemsFound = 0,
  sizeFound = 0,
  className
}: ScanProgressProps) {
  const { t } = useTranslation('common')
  return (
    <div
      className={cn('rounded-2xl p-5', className)}
      style={{ background: '#16161a', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="mb-3 flex items-center justify-between" aria-live="polite">
        <div className="flex items-center gap-2.5">
          <Loader2 className="h-4 w-4 animate-spin text-amber-400" aria-hidden="true" />
          <span className="text-[13px] font-medium text-zinc-200">
            {status === 'scanning' ? t('scanning') : t('cleaning')}
          </span>
        </div>
        <span className="font-mono text-[12px]" style={{ color: '#6e6e76' }}>
          {Math.round(progress)}%
        </span>
      </div>

      {/* Track */}
      <div
        className="mb-3.5 h-[6px] overflow-hidden rounded-full"
        style={{ background: 'rgba(255,255,255,0.04)' }}
        role="progressbar"
        aria-valuenow={Math.round(progress)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${status === 'scanning' ? t('scanning') : t('cleaning')} ${Math.round(progress)}%`}
      >
        <div
          className="h-full rounded-full transition-all duration-300 ease-out"
          style={{
            width: `${progress}%`,
            background: 'linear-gradient(90deg, #f59e0b 0%, #d97706 100%)'
          }}
        />
      </div>

      {currentPath && (
        <p className="mb-2 truncate font-mono text-[11px]" style={{ color: '#4e4e56' }}>
          {currentPath}
        </p>
      )}

      <div className="flex items-center gap-4 text-[12px]" style={{ color: '#6e6e76' }}>
        <span>
          {t('foundLabel')} <span className="font-medium text-zinc-300">{formatNumber(itemsFound)}</span> {t('itemsUnit')}
        </span>
        <span style={{ color: '#2a2a30' }}>|</span>
        <span>
          {t('sizeLabel')} <span className="font-medium text-zinc-300">{formatBytes(sizeFound)}</span>
        </span>
      </div>
    </div>
  )
}
