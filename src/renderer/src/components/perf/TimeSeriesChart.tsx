import { memo, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer
} from 'recharts'
import type { PerfSnapshot } from '@shared/types'
import { buildTimeSeries } from '@/lib/performance-chart'
interface TimeSeriesChartProps {
  history: PerfSnapshot[]
  timeRange: '60s' | '5m' | '15m'
  dataKey: 'cpu' | 'memory' | 'disk'
  label: string
  color: string
}
export const TimeSeriesChart = memo(function TimeSeriesChart({
  history,
  timeRange,
  dataKey,
  label,
  color
}: TimeSeriesChartProps) {
  const { t } = useTranslation('performance')
  const { t: tx } = useTranslation('experience')
  const data = useMemo(
    () => buildTimeSeries(history, timeRange, dataKey),
    [history, timeRange, dataKey]
  )
  const isDisk = dataKey === 'disk'
  const gradientId = useId()
  return (
    <section className="pulse-time-chart" aria-label={label}>
      <h3>
        {label}
        {isDisk && <span className="pulse-disk-unit">{t('chartDiskUnit')}</span>}
      </h3>
      {isDisk && (
        <div className="pulse-disk-legend">
          <span style={{ color }}>{t('chartDiskReadName')}</span>
          <span style={{ color: 'var(--success)' }}>{t('chartDiskWriteName')}</span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={180} minWidth={0}>
        <AreaChart
          data={data}
          margin={{ top: 8, right: 4, bottom: 8, left: -16 }}
          accessibilityLayer
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.2} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--grid-line)" strokeDasharray="3 6" />
          <XAxis dataKey="time" hide type="number" domain={['dataMin', 'dataMax']} />
          <YAxis
            domain={isDisk ? [0, 'auto'] : [0, 100]}
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--text-dim)', fontSize: 10 }}
            tickFormatter={(value) => (isDisk ? String(value) : value + '%')}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--flyout-bg)',
              border: '1px solid var(--border-strong)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--text-primary)'
            }}
            labelFormatter={(value) => new Date(Number(value)).toLocaleTimeString()}
            formatter={(value) => [
              Number(value).toFixed(1) + (isDisk ? ' ' + t('chartDiskUnit') : '%')
            ]}
          />
          {isDisk ? (
            <>
              <Area
                type="linear"
                dataKey="read"
                stroke={color}
                fill={'url(#' + gradientId + ')'}
                strokeWidth={2}
                isAnimationActive={false}
                name={t('chartDiskReadName')}
              />
              <Area
                type="linear"
                dataKey="write"
                stroke="var(--success)"
                fill="none"
                strokeWidth={2}
                isAnimationActive={false}
                name={t('chartDiskWriteName')}
              />
            </>
          ) : (
            <Area
              type="linear"
              dataKey="value"
              stroke={color}
              fill={'url(#' + gradientId + ')'}
              strokeWidth={2}
              isAnimationActive={false}
              name={label}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
      <footer>
        <span>
          {data.length ? new Date(data[0].time).toLocaleTimeString() : tx('home.collecting')}
        </span>
        <span>{data.length ? new Date(data.at(-1)!.time).toLocaleTimeString() : '\u2014'}</span>
      </footer>
    </section>
  )
})
