import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  HardDrive,
  Cpu,
  Database,
  Eraser,
  Lock,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ErrorAlert } from '@/components/shared/ErrorAlert'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import {
  useDiskMaintenanceStore,
  isSelectable,
  applyFilter,
  type DriveFilter,
} from '@/stores/disk-maintenance-store'
import type { TrimDriveInfo, TrimMediaType, TrimStatus } from '@shared/types'

function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : fractionDigits)} ${units[i]}`
}

function formatRelativeTime(ts: number | null, never: string): string {
  if (!ts) return never
  const diff = Date.now() - ts
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))
  if (days <= 0) {
    const hours = Math.floor(diff / (60 * 60 * 1000))
    if (hours <= 0) return 'Just now'
    return `${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) return `${Math.round(days / 30)} months ago`
  return `${Math.round(days / 365)} years ago`
}

function MediaIcon({ type }: { type: TrimMediaType }) {
  if (type === 'NVMe') return <Cpu className="h-5 w-5 text-amber-400" strokeWidth={1.8} />
  if (type === 'SSD') return <Database className="h-5 w-5 text-amber-400" strokeWidth={1.8} />
  return <HardDrive className="h-5 w-5" strokeWidth={1.8} style={{ color: 'var(--text-muted)' }} />
}

function StatusPill({ status, reason }: { status: TrimStatus; reason: string }) {
  const styles: Record<TrimStatus, { bg: string; color: string; label: string }> = {
    'recently-trimmed': { bg: 'rgba(34,197,94,0.12)', color: '#22c55e', label: 'Recently trimmed' },
    'ok': { bg: 'rgba(63,63,70,0.4)', color: 'var(--text-muted)', label: 'OK' },
    'recommended': { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', label: 'Recommended' },
    'not-applicable': { bg: 'rgba(63,63,70,0.4)', color: 'var(--text-muted)', label: 'Not applicable' },
    'disabled': { bg: 'rgba(239,68,68,0.12)', color: '#ef4444', label: 'Disabled' },
    'unknown': { bg: 'rgba(63,63,70,0.4)', color: 'var(--text-muted)', label: 'Unknown' },
  }
  const s = styles[status]
  return (
    <span
      title={reason}
      className="rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{ background: s.bg, color: s.color as string }}
    >
      {s.label}
    </span>
  )
}

export function DiskMaintenancePage() {
  const { t } = useTranslation('disk')
  const drives = useDiskMaintenanceStore((s) => s.drives)
  const loading = useDiskMaintenanceStore((s) => s.loading)
  const error = useDiskMaintenanceStore((s) => s.error)
  const selected = useDiskMaintenanceStore((s) => s.selected)
  const filter = useDiskMaintenanceStore((s) => s.filter)
  const runStates = useDiskMaintenanceStore((s) => s.runStates)
  const results = useDiskMaintenanceStore((s) => s.results)
  const progress = useDiskMaintenanceStore((s) => s.progress)
  const batchRunning = useDiskMaintenanceStore((s) => s.batchRunning)
  const store = useDiskMaintenanceStore()

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [showLog, setShowLog] = useState<string | null>(null)

  // Listen for trim progress events
  useEffect(() => {
    if (!window.kudu?.onDiskTrimProgress) return
    return window.kudu.onDiskTrimProgress((data) => store.setProgress(data))
  }, [])

  // Initial load
  useEffect(() => {
    refresh()
  }, [])

  async function refresh(): Promise<void> {
    store.setLoading(true)
    store.setError(null)
    try {
      const list = await window.kudu.diskTrimList()
      store.setDrives(list)
    } catch (err) {
      console.error('Failed to list trim drives:', err)
      store.setError(err instanceof Error ? err.message : t('trimListFailed'))
    } finally {
      store.setLoading(false)
    }
  }

  const filtered = useMemo(() => applyFilter(drives, filter), [drives, filter])

  const selectableSelected = useMemo(
    () => Array.from(selected).filter((id) => {
      const d = drives.find((x) => x.id === id)
      return d ? isSelectable(d) : false
    }),
    [selected, drives]
  )

  async function handleRun(): Promise<void> {
    if (selectableSelected.length === 0) return
    setConfirmOpen(false)
    store.setBatchRunning(true)
    for (const id of selectableSelected) {
      store.setRunState(id, 'running')
    }
    try {
      const results = await window.kudu.diskTrimRun(selectableSelected)
      let needsAdmin = false
      let throttled = 0
      let success = 0
      let failed = 0
      for (const r of results) {
        store.setResult(r.driveId, r)
        store.setRunState(r.driveId, r.success ? 'done' : 'failed')
        if (r.needsAdmin) needsAdmin = true
        if (r.throttled) throttled++
        if (r.success) success++
        else if (!r.throttled && !r.needsAdmin) failed++
      }
      if (needsAdmin) {
        toast.error(t('adminRequiredToast'), { description: t('adminRequiredTrimDesc') })
      } else if (success > 0) {
        toast.success(t('trimCompletedToast', { count: success }))
      }
      if (throttled > 0) {
        toast.message(t('trimThrottledToast', { count: throttled }))
      }
      if (failed > 0) {
        toast.error(t('trimFailedToast', { count: failed }))
      }
      await refresh()
    } catch (err) {
      console.error('Trim batch failed:', err)
      toast.error(t('trimBatchFailed'))
      for (const id of selectableSelected) {
        store.setRunState(id, 'failed')
      }
    } finally {
      store.setBatchRunning(false)
      store.clearSelection()
    }
  }

  const filterPills: { key: DriveFilter; label: string }[] = [
    { key: 'all', label: t('trimFilterAll') },
    { key: 'ssd', label: t('trimFilterSsd') },
    { key: 'needs-trim', label: t('trimFilterNeeds') },
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('maintenanceTitle')}
        description={t('maintenanceDescription')}
        action={
          <button
            onClick={refresh}
            disabled={loading || batchRunning}
            className="flex items-center gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors disabled:opacity-40"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
          >
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} strokeWidth={2} />
            {t('refresh')}
          </button>
        }
      />

      {/* Info banner */}
      <div className="mb-5 rounded-2xl px-5 py-4" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}>
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" strokeWidth={1.8} />
          <div>
            <p className="text-[13px] font-medium text-zinc-200">{t('trimInfoTitle')}</p>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {t('trimInfoBody')}
            </p>
          </div>
        </div>
      </div>

      {error && <ErrorAlert message={error} onDismiss={() => store.setError(null)} />}

      {/* Filter pills + run button */}
      <div className="mb-4 flex items-center gap-2">
        <div className="flex gap-1 rounded-xl p-1" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}>
          {filterPills.map((p) => (
            <button
              key={p.key}
              onClick={() => store.setFilter(p.key)}
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                background: filter === p.key ? 'var(--bg-subtle-2)' : 'transparent',
                color: filter === p.key ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {t('trimSelectedCount', { count: selectableSelected.length })}
          </span>
          <button
            onClick={() => setConfirmOpen(true)}
            disabled={selectableSelected.length === 0 || batchRunning}
            className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'var(--text-on-accent)' }}
          >
            {batchRunning
              ? <><RefreshCw className="h-4 w-4 animate-spin" /> {t('trimRunning')}</>
              : <><Eraser className="h-4 w-4" strokeWidth={2} /> {t('trimRunSelected', { count: selectableSelected.length })}</>}
          </button>
        </div>
      </div>

      {loading && drives.length === 0 ? (
        <div className="rounded-2xl px-5 py-8 text-center text-[13px]" style={{ background: 'var(--card-bg)', color: 'var(--text-muted)' }}>
          {t('trimLoading')}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={HardDrive}
          title={t('trimEmptyTitle')}
          description={drives.length === 0 ? t('trimEmptyNoDrives') : t('trimEmptyFiltered')}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((drive) => (
            <DriveRow
              key={drive.id}
              drive={drive}
              selected={selected.has(drive.id)}
              runState={runStates[drive.id] ?? 'idle'}
              progressMessage={progress[drive.id]?.message}
              onToggle={() => store.toggleSelect(drive.id)}
              showLog={showLog === drive.id}
              onToggleLog={() => setShowLog(showLog === drive.id ? null : drive.id)}
              result={results[drive.id]}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleRun}
        title={t('trimConfirmTitle')}
        description={t('trimConfirmDescription', { count: selectableSelected.length })}
        details={selectableSelected.map((id) => drives.find((d) => d.id === id)?.label ?? id).join(', ')}
        confirmLabel={t('trimConfirmButton')}
        variant="warning"
      />
    </div>
  )
}

interface DriveRowProps {
  drive: TrimDriveInfo
  selected: boolean
  runState: 'idle' | 'running' | 'done' | 'failed'
  progressMessage?: string
  onToggle: () => void
  showLog: boolean
  onToggleLog: () => void
  result?: import('@shared/types').TrimRunResult
}

function DriveRow({ drive, selected, runState, progressMessage, onToggle, showLog, onToggleLog, result }: DriveRowProps) {
  const { t } = useTranslation('disk')
  const selectable = isSelectable(drive)
  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--card-bg)', border: '1px solid var(--border-default)' }}>
      <div className="flex items-center gap-4">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={!selectable || runState === 'running'}
          aria-label={`Select ${drive.label}`}
          className="h-4 w-4 shrink-0 cursor-pointer accent-amber-500 disabled:cursor-not-allowed disabled:opacity-30"
        />
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: 'rgba(245,158,11,0.1)' }}>
          <MediaIcon type={drive.mediaType} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-medium text-zinc-200">{drive.label}</p>
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{ background: 'var(--bg-subtle-2)', color: 'var(--text-muted)' }}>
              {drive.mediaType}
            </span>
            {drive.busType && drive.busType !== drive.mediaType && (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{drive.busType}</span>
            )}
            {drive.isEncrypted && (
              <Lock className="h-3 w-3" strokeWidth={2} style={{ color: 'var(--text-muted)' }} aria-label="Encrypted" />
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>{drive.filesystem ?? '—'}</span>
            <span>·</span>
            <span>{formatBytes(drive.totalSize, 0)} total</span>
            <span>·</span>
            <span>{t('trimLastTrimmed')}: {formatRelativeTime(drive.lastTrimAt, t('trimNeverRecorded'))}</span>
          </div>
        </div>
        <StatusPill status={drive.status} reason={drive.statusReason} />
      </div>

      {runState === 'running' && (
        <div className="mt-3 flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: 'var(--bg-subtle)' }}>
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-amber-400" strokeWidth={2} />
          <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {progressMessage ?? t('trimRunningMessage')}
          </p>
        </div>
      )}

      {result && runState !== 'running' && (
        <div className="mt-3 rounded-xl px-3 py-2" style={{
          background: result.success ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          border: `1px solid ${result.success ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)'}`,
        }}>
          <div className="flex items-center gap-2">
            {result.success
              ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" strokeWidth={1.8} />
              : result.needsAdmin
                ? <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" strokeWidth={1.8} />
                : <XCircle className="h-4 w-4 shrink-0 text-red-400" strokeWidth={1.8} />}
            <p className="text-[12px] text-zinc-300">{result.summary}</p>
          </div>
          {result.log && (
            <button onClick={onToggleLog}
              className="mt-2 text-[11px] font-medium text-amber-500 hover:text-amber-400">
              {showLog ? t('hideLog') : t('showLog')}
            </button>
          )}
          {showLog && result.log && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg p-3 font-mono text-[11px]"
              style={{ background: 'var(--bg-subtle-2)', color: 'var(--text-muted)' }}>
              {result.log}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
