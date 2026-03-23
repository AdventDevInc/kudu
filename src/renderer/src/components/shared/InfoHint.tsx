import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'
import { Info, AlertTriangle } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings-store'

interface InfoHintProps {
  i18nKey: string
  ns?: string
  variant?: 'info' | 'warning'
  className?: string
}

const variants = {
  info: {
    icon: Info,
    border: 'rgba(59,130,246,0.15)',
    bg: 'rgba(59,130,246,0.04)',
    accent: '#3b82f6'
  },
  warning: {
    icon: AlertTriangle,
    border: 'rgba(245,158,11,0.12)',
    bg: 'rgba(245,158,11,0.04)',
    accent: '#f59e0b'
  }
} as const

export function InfoHint({ i18nKey, ns, variant = 'info', className }: InfoHintProps) {
  const { t } = useTranslation(ns)
  const showHints = useSettingsStore((s) => s.settings.showHints)
  const v = variants[variant]
  const Icon = v.icon

  return (
    <AnimatePresence>
      {showHints && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className={className}
          style={{ overflow: 'hidden' }}
        >
          <div
            className="flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 mt-2"
            style={{
              background: v.bg,
              border: `1px solid ${v.border}`,
              borderLeft: `2px solid ${v.accent}`
            }}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" style={{ color: v.accent }} strokeWidth={1.8} />
            <p className="text-[11px] leading-relaxed" style={{ color: '#8e8e96' }}>
              {t(i18nKey)}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
