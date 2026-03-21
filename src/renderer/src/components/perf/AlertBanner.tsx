import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { PerfSnapshot } from '@shared/types'

interface AlertBannerProps {
  snapshot: PerfSnapshot | null
  history: PerfSnapshot[]
}

export const AlertBanner = memo(function AlertBanner({ snapshot, history }: AlertBannerProps) {
  const { t } = useTranslation('performance')
  const [dismissed, setDismissed] = useState<string[]>([])

  if (!snapshot) return null

  const alerts: { id: string; message: string }[] = []

  // CPU > 90% sustained for 5+ ticks
  const recentCpu = history.slice(-5)
  if (recentCpu.length >= 5 && recentCpu.every((s) => s.cpu.overall > 90)) {
    alerts.push({ id: 'cpu-high', message: t('cpuHighAlert') })
  }

  // Memory > 85%
  if (snapshot.memory.percent > 85) {
    alerts.push({ id: 'mem-high', message: t('memoryHighAlert', { percent: snapshot.memory.percent.toFixed(0) }) })
  }

  const visible = alerts.filter((a) => !dismissed.includes(a.id))
  if (visible.length === 0) return null

  return (
    <div className="mb-4 space-y-2">
      <AnimatePresence>
        {visible.map((alert) => (
          <motion.div
            key={alert.id}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-3 rounded-xl px-4 py-3"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}
          >
            <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: '#ef4444' }} strokeWidth={2} />
            <span className="flex-1 text-[12px] font-medium" style={{ color: '#fca5a5' }}>
              {alert.message}
            </span>
            <button
              onClick={() => setDismissed((d) => [...d, alert.id])}
              className="shrink-0 rounded-lg p-1 transition-colors hover:bg-white/5"
            >
              <X className="h-3.5 w-3.5" style={{ color: '#6e6e76' }} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
})
