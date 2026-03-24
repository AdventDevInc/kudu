import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, ArrowUpDown, Zap, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn, formatBytes } from '@/lib/utils'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { usePerfStore } from '@/stores/perf-store'
import type { PerfProcess } from '@shared/types'

export function ProcessTable() {
  const { t } = useTranslation('performance')
  const processList = usePerfStore((s) => s.processList)
  const processCount = usePerfStore((s) => s.processCount)
  const filter = usePerfStore((s) => s.processFilter)
  const setFilter = usePerfStore((s) => s.setProcessFilter)
  const sortColumn = usePerfStore((s) => s.processSortColumn)
  const sortDir = usePerfStore((s) => s.processSortDir)
  const setSort = usePerfStore((s) => s.setProcessSort)

  const [killTarget, setKillTarget] = useState<PerfProcess | null>(null)
  const [killing, setKilling] = useState(false)

  const filtered = useMemo(() => {
    let list = processList
    if (filter) {
      const q = filter.toLowerCase()
      list = list.filter((p) => p.name.toLowerCase().includes(q))
    }

    list = [...list].sort((a, b) => {
      const aVal = a[sortColumn]
      const bVal = b[sortColumn]
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      return sortDir === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number)
    })

    return list
  }, [processList, filter, sortColumn, sortDir])

  const handleKill = useCallback(async () => {
    if (!killTarget) return
    setKilling(true)
    try {
      const result = await window.kudu.perfKillProcess(killTarget.pid)
      if (result.success) {
        toast.success(t('endProcessSuccessToast', { name: killTarget.name, pid: killTarget.pid }))
      } else {
        toast.error(result.error || t('endProcessFailedToast'))
      }
    } catch {
      toast.error(t('endProcessFailedToast'))
    } finally {
      setKilling(false)
      setKillTarget(null)
    }
  }, [killTarget])

  const SortHeader = ({ column, label, width }: { column: typeof sortColumn; label: string; width: string }) => (
    <button
      onClick={() => setSort(column)}
      className={cn(
        'flex items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wider transition-colors',
        sortColumn === column ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-400'
      )}
      style={{ width }}
    >
      {label}
      <ArrowUpDown className="h-3 w-3" />
    </button>
  )

  function cpuBarColor(pct: number): string {
    if (pct >= 50) return '#ef4444'
    if (pct >= 20) return '#f59e0b'
    return '#22c55e'
  }

  return (
    <div
      className="rounded-2xl p-5"
      style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}
    >
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-white">{t('processes')}</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {processCount} {t('totalSuffix')}
          </span>
        </div>
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-1.5"
          style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-medium)' }}
        >
          <Search className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('filterProcessesPlaceholder')}
            className="bg-transparent text-[12px] text-zinc-300 placeholder-zinc-600 outline-none"
            style={{ width: 160 }}
          />
          {filter && (
            <button onClick={() => setFilter('')}>
              <X className="h-3 w-3" style={{ color: 'var(--text-muted)' }} />
            </button>
          )}
        </div>
      </div>

      {/* Column headers */}
      <div className="mb-2 flex items-center gap-2 px-2">
        <SortHeader column="name" label={t('columnName')} width="40%" />
        <SortHeader column="pid" label={t('columnPid')} width="12%" />
        <SortHeader column="cpuPercent" label={t('columnCpu')} width="20%" />
        <SortHeader column="memBytes" label={t('columnMemory')} width="18%" />
        <div style={{ width: '10%' }} />
      </div>

      {/* Rows */}
      <div className="max-h-[340px] space-y-0.5 overflow-y-auto pr-1">
        {filtered.map((p) => (
          <div
            key={p.pid}
            className="group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-white/[0.02]"
          >
            {/* Name */}
            <div className="flex items-center gap-2" style={{ width: '40%' }}>
              <span className="truncate text-[12px] font-medium text-zinc-300">{p.name}</span>
              {p.isStartupItem && (
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                  style={{ background: 'var(--accent-muted-bg)', color: 'var(--accent)' }}
                  title={t('startupItemTooltip', { name: p.startupItemName })}
                >
                  <Zap className="mr-0.5 inline h-2.5 w-2.5" />
                  {t('startupBadge')}
                </span>
              )}
            </div>

            {/* PID */}
            <span className="text-[11px] font-mono" style={{ width: '12%', color: 'var(--text-muted)' }}>
              {p.pid}
            </span>

            {/* CPU */}
            <div style={{ width: '20%' }} className="flex items-center gap-2">
              <div className="h-1.5 flex-1 rounded-full" style={{ background: 'var(--bg-subtle-2)' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, p.cpuPercent)}%`,
                    background: cpuBarColor(p.cpuPercent)
                  }}
                />
              </div>
              <span className="w-10 text-right text-[11px] font-mono text-zinc-400">
                {p.cpuPercent.toFixed(1)}
              </span>
            </div>

            {/* Memory */}
            <span className="text-[11px] font-mono text-zinc-400" style={{ width: '18%' }}>
              {formatBytes(p.memBytes, 1)}
            </span>

            {/* Kill */}
            <div style={{ width: '10%' }} className="flex justify-end">
              <button
                onClick={() => setKillTarget(p)}
                className="rounded-lg px-2 py-1 text-[10px] font-medium opacity-0 transition-all group-hover:opacity-100"
                style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}
              >
                {t('endButton')}
              </button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={!!killTarget}
        onConfirm={handleKill}
        onCancel={() => setKillTarget(null)}
        title={t('endProcessTitle', { name: killTarget?.name ?? 'process' })}
        description={t('endProcessDescription', { name: killTarget?.name, pid: killTarget?.pid })}
        confirmLabel={killing ? t('endProcessEnding') : t('endProcessConfirm')}
        variant="danger"
      />
    </div>
  )
}
