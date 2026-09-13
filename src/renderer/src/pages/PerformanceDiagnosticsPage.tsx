import '@/components/shared/feature-layout.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, Circle, Sparkles } from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { formatBytes } from '@/lib/utils'
import { diagnosticStats } from '@shared/performance-diagnostics'
import type {
  DiagnosticCapabilities,
  DiagnosticPreview,
  DiagnosticSession,
  DiagnosticSummary
} from '@shared/performance-diagnostics'

const button = 'feature-button'
const panel = 'feature-card space-y-4'
const field = 'feature-field'
const percent = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}%`)

export function PerformanceDiagnosticsPage() {
  const { t } = useTranslation('diagnostics')
  const [cap, setCap] = useState<DiagnosticCapabilities | null>(null)
  const [rows, setRows] = useState<DiagnosticSummary[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [seconds, setSeconds] = useState(120)
  const [collectProcesses, setCollectProcesses] = useState(false)
  const [shareProcesses, setShareProcesses] = useState(false)
  const [selected, setSelected] = useState<DiagnosticSession | null>(null)
  const [comparison, setComparison] = useState<DiagnosticSession | null>(null)
  const [preview, setPreview] = useState<DiagnosticPreview | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'local' | 'cloud' | null>(null)
  const [range, setRange] = useState<{ startMs: number; endMs: number } | null>(null)
  const detailRef = useRef<HTMLElement>(null)
  const id = selected?.recording.recordId
  useEffect(() => {
    if (id) {
      detailRef.current?.focus({ preventScroll: true })
      detailRef.current?.scrollIntoView({ block: 'start' })
    }
  }, [id])
  // A deleted or expired Cloud copy is marked by a past expiry; the local report stays readable.
  const cloudGone = !!selected?.cloud && new Date(selected.cloud.expiresAt).getTime() < Date.now()
  // The upload reference is the only handle on the Cloud copy, so it must be deleted first.
  const cloudHeld = !!selected?.upload && !cloudGone
  // Adopt the Cloud/upload state from a persisted session without discarding unsaved edits.
  const adopt = useCallback(
    (s: DiagnosticSession) =>
      setSelected((current) =>
        current?.recording.recordId === s.recording.recordId
          ? { ...s, title: current.title, notes: current.notes, pinned: current.pinned }
          : current
      ),
    []
  )
  const refresh = useCallback(async () => {
    const s = await window.kudu.diagnosticsStatus()
    setRows(s.rows)
    setLoaded(true)
    setActive(s.activeId)
    setElapsed(s.elapsedMs)
    if (s.error) setError(s.error)
  }, [])
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await work()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let disposed = false
    let pending = false
    const poll = async () => {
      if (pending || disposed) return
      pending = true
      try {
        await refresh()
      } catch (e) {
        if (!disposed) setError(String(e))
      } finally {
        pending = false
      }
    }
    void poll()
    void window.kudu
      .diagnosticsCapabilities()
      .then((c) => {
        if (!disposed) setCap(c)
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    const timer = setInterval(() => {
      void poll()
    }, 2000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [refresh])
  useEffect(() => {
    if (
      !id ||
      !selected?.cloud ||
      !['queued', 'processing'].includes(selected.cloud.status) ||
      new Date(selected.cloud.expiresAt).getTime() < Date.now()
    )
      return
    let disposed = false
    let pending = false
    const timer = setInterval(() => {
      if (pending) return
      pending = true
      void window.kudu
        .diagnosticsRefresh(id)
        .then((s) => {
          if (!disposed) adopt(s)
        })
        .catch((e) => {
          if (!disposed) setError(String(e))
        })
        .finally(() => {
          pending = false
        })
    }, 10000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [id, selected?.cloud, adopt])
  useEffect(() => {
    if (!id || active === id || selected?.state !== 'recording') return
    let disposed = false
    void window.kudu
      .diagnosticsGet(id)
      .then((s) => {
        if (!disposed) setSelected(s)
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [id, active, selected?.state])
  const open = async (nextId: string) => {
    const s = await window.kudu.diagnosticsGet(nextId)
    setSelected(s)
    setPreview(null)
    setComparison(null)
    setConfirm(null)
    setRange(null)
    setShareProcesses(s.upload?.includeProcesses ?? false)
  }
  const stats = selected ? diagnosticStats(selected.recording) : null
  const otherStats = comparison ? diagnosticStats(comparison.recording) : null
  const comparable =
    selected &&
    comparison &&
    JSON.stringify(selected.recording.system) === JSON.stringify(comparison.recording.system)
  const report = selected?.cloud?.report
  return (
    <div className="feature-page feature-layout space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        action={
          <Link className={button} to="/performance">
            {t('liveMonitor')}
          </Link>
        }
      />
      {error && (
        <div role="alert" className="rounded-lg border border-amber-500/40 p-4 text-sm">
          {error}
        </div>
      )}
      <section className={panel}>
        <div className="flex flex-wrap items-center gap-3">
          <Activity size={18} className="text-[var(--accent)]" aria-hidden="true" />
          <h2 className="font-semibold">{t('newRecording')}</h2>
          <span className="feature-status">{t('pro')}</span>
        </div>
        <p className="text-sm text-[var(--text-muted)]">{t('localFirst')}</p>
        {cap === null && !error && (
          <p role="status" className="text-sm text-[var(--text-muted)]">
            {t('checkingAccess')}
          </p>
        )}
        {!cap?.available && (cap !== null || !!error) && (
          <p className="text-sm">
            {t(cap ? 'requiresPro' : 'accessUnavailable')}{' '}
            <Link to="/cloud" className="underline">
              {t('cloudSettings')}
            </Link>{' '}
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void run(async () => setCap(await window.kudu.diagnosticsCapabilities()))
              }
            >
              {t('checkAccess')}
            </button>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <label className="space-x-2 text-sm">
            {t('duration')}{' '}
            <select
              className={field}
              value={seconds}
              disabled={!!active || busy}
              onChange={(e) => setSeconds(Number(e.target.value))}
            >
              {[120, 300, 900].map((n) => (
                <option key={n} value={n}>
                  {t('minutes', { count: n / 60 })}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={collectProcesses}
              disabled={!!active || busy}
              onChange={(e) => setCollectProcesses(e.target.checked)}
            />
            {t('collectProcesses')}
          </label>
          {active ? (
            <>
              <span role="status">
                {t('recordingElapsed', { seconds: Math.floor(elapsed / 1000) })}
              </span>
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await window.kudu.diagnosticsStop()
                    await open(active)
                  })
                }
              >
                {t('stop')}
              </button>
            </>
          ) : (
            <button
              className={button + ' feature-primary'}
              disabled={busy || !cap?.available}
              onClick={() =>
                void run(async () => {
                  const next = await window.kudu.diagnosticsStart(seconds, collectProcesses)
                  await open(next)
                })
              }
            >
              <Circle size={12} fill="currentColor" aria-hidden="true" />
              {t('start')}
            </button>
          )}
        </div>
        <p className="text-xs text-[var(--text-muted)]">{t('sampling')}</p>
      </section>
      <section className={panel}>
        <h2 className="font-semibold">{t('saved')}</h2>
        <p className="text-xs text-[var(--text-muted)]">{t('retention')}</p>
        {loaded && !rows.length && (
          <EmptyState
            icon={Activity}
            title={t('empty')}
            description={t('emptyHint')}
            className="!min-h-[180px] !p-6"
          />
        )}
        <div className="grid gap-2 md:grid-cols-2">
          {rows.map((row) => (
            <button
              key={row.id}
              disabled={busy}
              aria-pressed={id === row.id}
              className="rounded-xl border border-[var(--border-medium)] bg-[var(--bg-subtle)] p-4 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
              onClick={() => void run(() => open(row.id))}
            >
              <span className="block truncate font-medium">
                {row.pinned ? '★ ' : ''}
                {row.title}
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                {new Date(row.startedAt).toLocaleString()} · {t(row.state)} ·{' '}
                {Math.round(row.durationMs / 1000)}s
                {row.cloudStatus ? ` · ${t(row.cloudStatus)}` : ''}
              </span>
            </button>
          ))}
        </div>
      </section>
      {selected && (
        <section ref={detailRef} tabIndex={-1} className={panel}>
          <h2 className="font-semibold">{t('recordingDetails')}</h2>
          {active === id ? (
            <p>{t('stopToReview')}</p>
          ) : (
            <>
              <label className="block text-sm">
                {t('name')}
                <input
                  className={`${field} mt-1 block w-full`}
                  maxLength={120}
                  value={selected.title}
                  onChange={(e) => setSelected({ ...selected, title: e.target.value })}
                />
              </label>
              <label className="block text-sm">
                {t('notes')}
                <textarea
                  className={`${field} mt-1 block w-full`}
                  maxLength={2000}
                  value={selected.notes}
                  onChange={(e) => setSelected({ ...selected, notes: e.target.value })}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.pinned}
                  onChange={(e) => setSelected({ ...selected, pinned: e.target.checked })}
                />
                {t('pin')}
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await window.kudu.diagnosticsEdit(id!, selected)
                      await open(id!)
                    })
                  }
                >
                  {t('saveDetails')}
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await window.kudu.diagnosticsExport(id!)
                    })
                  }
                >
                  {t('export')}
                </button>
                <button
                  className={button}
                  disabled={busy || selected.pinned || cloudHeld}
                  title={cloudHeld ? t('deleteLocalBlocked') : undefined}
                  onClick={() => setConfirm('local')}
                >
                  {t('deleteLocal')}
                </button>
              </div>
              <p className="text-xs text-[var(--text-muted)]">{t('exportPrivacy')}</p>
              {cloudHeld && (
                <p className="text-xs text-[var(--text-muted)]">{t('deleteLocalBlocked')}</p>
              )}
              <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <div className="feature-metric">
                  {t('cpuMean')}
                  <strong className="block text-xl">{percent(stats!.cpuMean)}</strong>
                </div>
                <div className="feature-metric">
                  {t('memoryMean')}
                  <strong className="block text-xl">{percent(stats!.memoryMean)}</strong>
                </div>
                <div className="feature-metric">
                  {t('missingTicks')}
                  <strong className="block text-xl">{stats!.missingTicks}</strong>
                </div>
              </div>
              <label className="block text-sm">
                {t('compare')}{' '}
                <select
                  className={field}
                  value={comparison?.recording.recordId ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value
                    void run(async () =>
                      setComparison(next ? await window.kudu.diagnosticsGet(next) : null)
                    )
                  }}
                >
                  <option value="">{t('chooseRecording')}</option>
                  {rows
                    .filter((r) => r.id !== id && r.state !== 'recording')
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title} · {new Date(r.startedAt).toLocaleString()}
                      </option>
                    ))}
                </select>
              </label>
              {comparison && (
                <div className="space-y-2 text-sm">
                  <p>{t('comparisonCaution')}</p>
                  {!comparable ? (
                    <p>{t('notComparable')}</p>
                  ) : (
                    <p>
                      {t('comparisonValues', {
                        cpu: percent(otherStats!.cpuMean),
                        memory: percent(otherStats!.memoryMean),
                        first: Math.round(selected.recording.durationMs / 1000),
                        second: Math.round(comparison.recording.durationMs / 1000),
                        missing: otherStats!.missingTicks
                      })}
                    </p>
                  )}
                </div>
              )}
              <div className="border-t border-[var(--border-medium)] pt-4 space-y-3">
                <h3 className="flex items-center gap-2 font-semibold">
                  <Sparkles size={16} className="text-[var(--accent)]" aria-hidden="true" />
                  {t('cloudAnalysis')}
                </h3>
                <p className="text-sm text-[var(--text-muted)]">{t('cloudPrivacy')}</p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={shareProcesses}
                    disabled={busy || !!selected.upload}
                    onChange={(e) => {
                      setShareProcesses(e.target.checked)
                      setPreview(null)
                    }}
                  />
                  {t('shareProcesses')}
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={button}
                    disabled={busy || !cap?.available}
                    onClick={() =>
                      void run(async () =>
                        setPreview(await window.kudu.diagnosticsPreview(id!, shareProcesses))
                      )
                    }
                  >
                    {t('preview')}
                  </button>
                  {selected.upload && !cloudGone && (
                    <>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => adopt(await window.kudu.diagnosticsRefresh(id!)))
                        }
                      >
                        {t('refreshReport')}
                      </button>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => setConfirm('cloud')}
                      >
                        {t('deleteCloud')}
                      </button>
                    </>
                  )}
                </div>
                {preview && (
                  <div className="feature-note space-y-3">
                    <p>{t('uploadSize', { size: formatBytes(preview.bytes) })}</p>
                    <details>
                      <summary className="cursor-pointer">{t('exactUpload')}</summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                        {JSON.stringify(JSON.parse(preview.json), null, 2)}
                      </pre>
                    </details>
                    <p className="text-sm">{t('consent')}</p>
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          adopt(await window.kudu.diagnosticsUpload(preview.token))
                          setPreview(null)
                        })
                      }
                    >
                      {t('consentButton')}
                    </button>
                    <button className={`${button} ml-2`} onClick={() => setPreview(null)}>
                      {t('cancel')}
                    </button>
                  </div>
                )}
                {selected.cloud && (
                  <p role="status" className="text-sm">
                    {cloudGone
                      ? t('cloudGone')
                      : t('analysisStatus', { status: t(selected.cloud.status) })}
                    {selected.cloud.status === 'failed' && !cloudGone
                      ? ` ${t('analysisFailed')}`
                      : ''}
                  </p>
                )}
                {report && (
                  <div className="space-y-4">
                    <p className="font-medium">{report.summary}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {t('aiCaution')} · {report.analyzerVersion} ·{' '}
                      {new Date(report.generatedAt).toLocaleString()}
                    </p>
                    {report.findings.map((f, i) => (
                      <article key={i} className={panel}>
                        <h4 className="font-semibold">
                          {f.title}{' '}
                          <span className="text-xs font-normal">
                            {t('confidence', { level: t(f.confidence) })}
                          </span>
                        </h4>
                        <p className="text-sm">
                          <strong>{t('observation')}</strong> {f.observation}
                        </p>
                        <p className="text-sm">
                          <strong>{t('interpretation')}</strong> {f.interpretation}
                        </p>
                        <ul className="list-disc pl-5 text-sm space-y-1">
                          {f.nextSteps.map((step, j) => (
                            <li key={j}>{step}</li>
                          ))}
                        </ul>
                        <div className="flex flex-wrap gap-2">
                          {f.evidence.map((e, j) => (
                            <button className={button} key={j} onClick={() => setRange(e)}>
                              {t(e.metric)} · {(e.startMs / 1000).toFixed(1)}–
                              {(e.endMs / 1000).toFixed(1)}s
                            </button>
                          ))}
                        </div>
                      </article>
                    ))}
                    <ul className="list-disc pl-5 text-sm">
                      {report.limitations.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {range && (
                  <div className="overflow-x-auto">
                    <p className="text-xs">{t('evidenceLimit')}</p>
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr>
                          <th>{t('time')}</th>
                          <th>CPU</th>
                          <th>{t('memory')}</th>
                          <th>{t('read')}</th>
                          <th>{t('write')}</th>
                          <th>{t('processes')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.recording.samples
                          .filter((s) => s.t >= range.startMs && s.t <= range.endMs)
                          .slice(0, 50)
                          .map((s) => (
                            <tr key={s.t}>
                              <td>{(s.t / 1000).toFixed(1)}s</td>
                              <td>{percent(s.cpuPercent)}</td>
                              <td>{percent(s.memoryPercent)}</td>
                              <td>
                                {s.diskReadBytesPerSec === null
                                  ? '—'
                                  : `${formatBytes(s.diskReadBytesPerSec)}/s`}
                              </td>
                              <td>
                                {s.diskWriteBytesPerSec === null
                                  ? '—'
                                  : `${formatBytes(s.diskWriteBytesPerSec)}/s`}
                              </td>
                              <td>
                                {s.processes
                                  .map((p) => `${p.name} (PID ${p.pid}): ${percent(p.cpuPercent)}`)
                                  .join(', ') || '—'}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <ConfirmDialog
                open={!!confirm}
                variant="danger"
                title={t(confirm === 'local' ? 'deleteLocal' : 'deleteCloud')}
                description={t(confirm === 'local' ? 'confirmLocal' : 'confirmCloud')}
                details={selected.title}
                confirmLabel={t('confirmDelete')}
                onCancel={() => setConfirm(null)}
                onConfirm={() => {
                  const target = confirm
                  setConfirm(null)
                  void run(async () => {
                    if (target === 'local') {
                      await window.kudu.diagnosticsRemove(id!)
                      setSelected(null)
                    } else {
                      await window.kudu.diagnosticsDeleteCloud(id!)
                      await open(id!)
                    }
                  })
                }}
              />
            </>
          )}
        </section>
      )}
    </div>
  )
}
