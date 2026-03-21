import { cn } from '@/lib/utils'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ConfirmDialogProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
  title: string
  description: string
  confirmLabel?: string
  variant?: 'default' | 'danger' | 'warning'
  details?: string
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel,
  variant = 'default',
  details
}: ConfirmDialogProps) {
  const { t } = useTranslation('common')
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }} onClick={onCancel} />

      <div
        className="relative w-full max-w-md animate-scale-in rounded-2xl p-6"
        style={{ background: '#18181c', border: '1px solid rgba(255,255,255,0.06)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' }}
      >
        <div className="mb-5 flex items-start gap-4">
          {variant !== 'default' && (
            <div
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
              style={{
                background: variant === 'danger' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)'
              }}
            >
              <AlertTriangle
                className="h-5 w-5"
                style={{ color: variant === 'danger' ? '#ef4444' : '#f59e0b' }}
                strokeWidth={1.8}
              />
            </div>
          )}
          <div>
            <h3 className="text-[16px] font-semibold text-white">{title}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: '#8e8e96' }}>
              {description}
            </p>
            {details && (
              <p
                className="mt-3 rounded-xl p-3 font-mono text-[11px] break-all overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.03)', color: '#6e6e76', maxHeight: '4.5rem' }}
              >
                {details}
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2.5">
          <button
            onClick={onCancel}
            className="rounded-xl px-5 py-2.5 text-[13px] font-medium transition-colors"
            style={{ color: '#8e8e96' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {t('cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-colors"
            style={{
              background: variant === 'danger' ? 'rgba(239,68,68,0.12)' : variant === 'warning' ? 'rgba(245,158,11,0.12)' : '#f59e0b',
              color: variant === 'danger' ? '#ef4444' : variant === 'warning' ? '#f59e0b' : '#1a0a00'
            }}
          >
            {confirmLabel ?? t('confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
