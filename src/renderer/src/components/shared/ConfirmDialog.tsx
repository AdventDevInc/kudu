import { useEffect, useRef } from 'react'
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  // Track the element that had focus before the dialog opened
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Focus trap and keyboard handling
  useEffect(() => {
    if (!open) return

    previousFocusRef.current = document.activeElement as HTMLElement | null

    const dialog = dialogRef.current
    if (!dialog) return

    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    first?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancelRef.current(); return }
      if (e.key !== 'Tab') return
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }} onClick={onCancel} aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        className="glass-card relative w-full max-w-md animate-scale-in rounded-2xl p-6"
        style={{
          background: 'var(--card-bg)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5), inset 0 1px 0 var(--glass-inset)'
        }}
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
                aria-hidden="true"
              />
            </div>
          )}
          <div>
            <h3 id="confirm-dialog-title" className="text-[16px] font-semibold text-white">{title}</h3>
            <p id="confirm-dialog-desc" className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {description}
            </p>
            {details && (
              <p
                className="mt-3 rounded-xl p-3 font-mono text-[11px] break-all overflow-hidden"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)', maxHeight: '4.5rem' }}
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
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-subtle-2)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {t('cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all duration-200"
            style={{
              background: variant === 'danger' ? 'rgba(239,68,68,0.12)' : variant === 'warning' ? 'rgba(245,158,11,0.12)' : 'linear-gradient(135deg, #fbbf24, #f59e0b)',
              color: variant === 'danger' ? '#ef4444' : variant === 'warning' ? '#f59e0b' : 'var(--text-on-accent)',
              boxShadow: variant === 'default' ? '0 0 16px rgba(245,158,11,0.2)' : undefined
            }}
          >
            {confirmLabel ?? t('confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
