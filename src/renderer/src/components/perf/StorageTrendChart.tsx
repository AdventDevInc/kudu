import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip
} from 'recharts'
import type { StorageSnapshotSummary } from '@shared/storage-history'
import { storageTrend } from '@/lib/storage-trend'
import { formatBytes } from '@/lib/utils'

export function StorageTrendChart({ snapshots }: { snapshots: StorageSnapshotSummary[] }) {
  const { t } = useTranslation('experience')
  const data = useMemo(() => storageTrend(snapshots), [snapshots])
  return (
    <section className="feature-card pulse-storage-trend">
      <h2>{t('storageTrend.title')}</h2>
      <p>{t('storageTrend.description')}</p>
      {data.length < 2 ? (
        <div className="pulse-trend-empty">{t('storageTrend.empty')}</div>
      ) : (
        <ResponsiveContainer width="100%" height={210} minWidth={0}>
          <LineChart
            data={data}
            margin={{ top: 20, right: 24, bottom: 10, left: 4 }}
            accessibilityLayer
          >
            <CartesianGrid vertical={false} stroke="var(--border-medium)" strokeDasharray="3 6" />
            <XAxis
              dataKey="time"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(time) =>
                new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              }
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={[0, 'auto']}
              tickFormatter={(value) => formatBytes(value, 1)}
              tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={68}
            />
            <Tooltip
              labelFormatter={(time) => new Date(Number(time)).toLocaleString()}
              formatter={(value) => [formatBytes(Number(value)), t('storageTrend.size')]}
              contentStyle={{
                background: 'var(--flyout-bg)',
                border: '1px solid var(--border-strong)',
                borderRadius: 8,
                color: 'var(--text-primary)'
              }}
            />
            <Line
              dataKey="bytes"
              name={t('storageTrend.size')}
              type="linear"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={{ r: 3, fill: 'var(--card-bg)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </section>
  )
}
