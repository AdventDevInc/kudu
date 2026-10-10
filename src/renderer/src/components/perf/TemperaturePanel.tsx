import { Thermometer } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PerfTemperatures } from '@shared/types'

export function TemperaturePanel({ temperatures }: { temperatures?: PerfTemperatures }) {
  const { t } = useTranslation('performance')
  const readings = [
    { name: t('gaugeCpu'), celsius: temperatures?.cpuCelsius ?? null },
    { name: t('temperatures.cpuMax'), celsius: temperatures?.cpuMaxCelsius ?? null },
    ...(temperatures?.gpus.length
      ? temperatures.gpus.map((gpu) => ({
          name: gpu.name || t('temperatures.gpu'),
          celsius: gpu.celsius
        }))
      : [{ name: t('temperatures.gpu'), celsius: null }])
  ]

  return (
    <section
      className="rounded-2xl p-5"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
      aria-label={t('temperatures.title')}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Thermometer className="h-4 w-4" aria-hidden="true" />
          {t('temperatures.title')}
        </h3>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('temperatures.refresh')}
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {readings.map((reading, index) => (
          <div
            key={`${reading.name}-${index}`}
            className="rounded-xl p-3"
            style={{ background: 'var(--bg-subtle-2)' }}
          >
            <dt className="break-words text-xs" style={{ color: 'var(--text-secondary)' }}>
              {reading.name}
            </dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {reading.celsius === null ? (
                <span className="text-sm font-normal" style={{ color: 'var(--text-muted)' }}>
                  {t('temperatures.unavailable')}
                </span>
              ) : (
                `${reading.celsius.toFixed(1)}°C`
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('temperatures.sensorHint')}
      </p>
    </section>
  )
}
