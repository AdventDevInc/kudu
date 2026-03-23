import { AlertTriangle, X } from 'lucide-react'

interface ErrorAlertProps {
  message: string
  onDismiss?: () => void
  className?: string
}

export function ErrorAlert({ message, onDismiss, className = '' }: ErrorAlertProps) {
  return (
    <div
      role="alert"
      className={`flex items-center gap-3 rounded-2xl px-5 py-4 ${className}`}
      style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.12)' }}
    >
      <AlertTriangle className="h-5 w-5 shrink-0 text-red-500" strokeWidth={1.8} aria-hidden="true" />
      <p className="flex-1 text-[13px] text-red-400">{message}</p>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="shrink-0 rounded-lg p-1.5 text-red-500 transition-colors hover:bg-white/5"
        >
          <X className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
