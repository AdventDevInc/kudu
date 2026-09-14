import '@/components/shared/feature-layout.css'
import '@/components/perf/diagnostics.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Circle,
  Cloud,
  Cpu,
  FileText,
  History,
  Loader2,
  MemoryStick,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
  Upload
} from 'lucide-react'
import { DiagnosticsAccess } from '@/components/perf/DiagnosticsAccess'
import { DiagnosticReport } from '@/components/perf/DiagnosticReport'
import { useSettingsStore } from '@/stores/settings-store'
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
const primary = `${button} feature-primary`
const clock = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

export function PerformanceDiagnosticsPage() {
  const { t } = useTranslation('diagnostics')
  const [cap, setCap] = useState<DiagnosticCapabilities | null>(null)
  const [checkingAccess, setCheckingAccess] = useState(true)
  const [accessFailed, setAccessFailed] = useState(false)
  const [accessAttempt, setAccessAttempt] = useState(0)
  const cloudKey = useSettingsStore((s) => s.settings.cloud.apiKey)
  const [rows, setRows] = useState<DiagnosticSummary[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [seconds, setSeconds] = useState(120)
  const [collectProcesses, setCollectProcesses] = useState(false)
  const [shareProcesses, setShareProcesses] = useState(false)
  const [selected, setSelected] = useState<DiagnosticSession | null>(null)
  const [preview, setPreview] = useState<DiagnosticPreview | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const detailRef = useRef<HTMLElement>(null)
  const stepsRef = useRef<HTMLOListElement>(null)
  const activeRef = useRef<string | null>(null)
  const id = selected?.recording.recordId
  const step = active || !selected ? 1 : reviewing || selected.upload || selected.cloud ? 3 : 2
  const cloudGone = !!selected?.cloud && new Date(selected.cloud.expiresAt).getTime() < Date.now()
  const report = selected?.cloud?.report
  const processing = !cloudGone && ['queued', 'processing'].includes(selected?.cloud?.status ?? '')
  const stats = selected ? diagnosticStats(selected.recording) : null
  const hasProcesses = selected?.recording.samples.some((sample) => sample.processes.length > 0)
  const tooShort =
    !!selected && (selected.recording.samples.length < 2 || selected.recording.durationMs < 1000)

  const adopt = useCallback((session: DiagnosticSession) => {
    setSelected((current) =>
      current?.recording.recordId === session.recording.recordId
        ? { ...session, title: current.title, notes: current.notes, pinned: current.pinned }
        : current
    )
  }, [])
  const open = useCallback(async (nextId: string) => {
    const session = await window.kudu.diagnosticsGet(nextId)
    setSelected(session)
    setPreview(null)
    setReviewing(false)
    setConfirm(false)
    setShareProcesses(session.upload?.includeProcesses ?? false)
  }, [])
  const refresh = useCallback(async () => {
    const status = await window.kudu.diagnosticsStatus()
    const previous = activeRef.current
    setRows(status.rows)
    setActive(status.activeId)
    setElapsed(status.elapsedMs)
    if (status.error) setError(status.error)
    // Resume a recording after navigation, and advance automatically when its timer ends.
    if (status.activeId && status.activeId !== previous) await open(status.activeId)
    else if (previous && !status.activeId) await open(previous)
    activeRef.current = status.activeId
  }, [open])
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await work()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('operationFailed'))
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
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [refresh])
  useEffect(() => {
    let disposed = false
    setCheckingAccess(true)
    setAccessFailed(false)
    setCap(null)
    setPreview(null)
    void window.kudu
      .diagnosticsCapabilities()
      .then((value) => {
        if (!disposed) setCap(value)
      })
      .catch(() => {
        if (!disposed) setAccessFailed(true)
      })
      .finally(() => {
        if (!disposed) setCheckingAccess(false)
      })
    return () => {
      disposed = true
    }
  }, [cloudKey, accessAttempt])
  useEffect(() => {
    if (!id || !processing) return
    let disposed = false
    let pending = false
    const timer = setInterval(() => {
      if (pending) return
      pending = true
      void window.kudu
        .diagnosticsRefresh(id)
        .then((session) => {
          if (!disposed) {
            adopt(session)
            setError('')
          }
        })
        .catch((e) => {
          if (!disposed) setError(String(e))
        })
        .finally(() => {
          pending = false
        })
    }, 5000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [id, processing, adopt])
  useEffect(() => {
    if (!id) return
    detailRef.current?.focus({ preventScroll: true })
    if (step > 1) stepsRef.current?.scrollIntoView({ block: 'start' })
  }, [step, id]) // Focus the next step without moving the page on every status update.

  const newRecording = () => {
    setSelected(null)
    setReviewing(false)
    setPreview(null)
    setError('')
    setShareProcesses(false)
  }
  const prepare = async () => {
    if (!selected || !id) return
    await window.kudu.diagnosticsEdit(id, selected)
    setPreview(await window.kudu.diagnosticsPreview(id, shareProcesses))
    setReviewing(true)
  }

  return (
    <div className="feature-page feature-layout diagnostics-page">
      <PageHeader
        title={t('title')}
        description={t('flow.description')}
        showWorkflow={false}
        action={
          <Link className={button} to="/performance">
            <Activity size={15} />
            {t('liveMonitor')}
          </Link>
        }
      />
      <div className="diagnostics-workspace">
        <div className="diagnostics-topline">
          <span className="diagnostics-eyebrow">
            <Cloud size={15} />
            {t('pro')}
          </span>
          {selected && !active && (
            <button className={button} disabled={busy} onClick={newRecording}>
              <Plus size={15} />
              {t('flow.newSession')}
            </button>
          )}
        </div>
        <ol ref={stepsRef} className="diagnostics-steps" aria-label={t('flow.steps')}>
          {(['record', 'details', 'analyze'] as const).map((key, index) => (
            <li
              key={key}
              data-state={step > index + 1 ? 'done' : step === index + 1 ? 'current' : 'upcoming'}
              aria-current={step === index + 1 ? 'step' : undefined}
            >
              <span className="diagnostics-step-number">
                {step > index + 1 ? <Check size={17} /> : `0${index + 1}`}
              </span>
              <div>
                <strong>{t(`flow.${key}`)}</strong>
                <span>{t(`flow.${key}Caption`)}</span>
              </div>
            </li>
          ))}
        </ol>
        {error && (
          <div role="alert" className="diagnostics-error">
            {error}
          </div>
        )}
        {!cap?.available && !active && (
          <DiagnosticsAccess
            capabilities={cap}
            checking={checkingAccess}
            failed={accessFailed}
            onRetry={() => setAccessAttempt((attempt) => attempt + 1)}
          />
        )}

        {step === 1 && (cap?.available || active) && (
          <section
            className="diagnostics-stage diagnostics-capture"
            ref={detailRef}
            tabIndex={-1}
            aria-labelledby="diagnostics-stage-title"
          >
            <div className="diagnostics-capture-main">
              <span className="diagnostics-kicker">{t('flow.step', { number: 1 })}</span>
              <h2 id="diagnostics-stage-title">
                {t(active ? 'flow.recordingTitle' : 'newRecording')}
              </h2>
              <p className="diagnostics-description">
                {t(active ? 'flow.recordingHint' : 'flow.recordHint')}
              </p>
              {active ? (
                <>
                  <div className="diagnostics-timer">
                    <span className="diagnostics-record-dot" />
                    <strong>{clock(elapsed)}</strong>
                    <span>{t('recording')}</span>
                  </div>
                  <button
                    className={primary}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await window.kudu.diagnosticsStop()
                      })
                    }
                  >
                    <Square size={14} fill="currentColor" />
                    {t('flow.finishRecording')}
                  </button>
                  <p className="diagnostics-footnote">{t('sampling')}</p>
                </>
              ) : (
                <>
                  <fieldset className="diagnostics-duration" disabled={busy}>
                    <legend>{t('flow.recordFor')}</legend>
                    <div>
                      {[120, 300, 900].map((duration) => (
                        <button
                          type="button"
                          key={duration}
                          aria-pressed={seconds === duration}
                          onClick={() => setSeconds(duration)}
                        >
                          <strong>{t('minutes', { count: duration / 60 })}</strong>
                          <span>{t(`flow.duration${duration}`)}</span>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label className="diagnostics-checkbox">
                    <input
                      type="checkbox"
                      checked={collectProcesses}
                      disabled={busy}
                      onChange={(e) => setCollectProcesses(e.target.checked)}
                    />
                    <span>
                      {t('flow.collectProcesses')}
                      <small>{t('flow.collectHint')}</small>
                    </span>
                  </label>
                  <button
                    className={primary}
                    disabled={busy || !cap?.available}
                    onClick={() =>
                      void run(async () => {
                        await window.kudu.diagnosticsStart(seconds, collectProcesses)
                      })
                    }
                  >
                    {busy ? (
                      <Loader2 size={15} className="diagnostics-spin" />
                    ) : (
                      <Circle size={12} fill="currentColor" />
                    )}
                    {t('start')}
                    <ArrowRight size={16} />
                  </button>
                  <p className="diagnostics-footnote">
                    <ShieldCheck size={14} />
                    {t('flow.uploadControl')}
                  </p>
                </>
              )}
            </div>
            <aside className="diagnostics-capture-aside" aria-label={t('flow.whatWeRecord')}>
              <div className="diagnostics-signal" data-recording={!!active} aria-hidden="true">
                <Activity size={64} strokeWidth={1.1} />
              </div>
              <h3>{t('flow.whatWeRecord')}</h3>
              <p>{t('flow.signalHint')}</p>
              <div className="diagnostics-signal-tags">
                <span>
                  <Cpu size={14} />
                  CPU
                </span>
                <span>
                  <MemoryStick size={14} />
                  {t('memory')}
                </span>
                <span>
                  <Activity size={14} />
                  {t('flow.disk')}
                </span>
              </div>
            </aside>
          </section>
        )}

        {step === 2 && selected && (
          <section
            className="diagnostics-stage"
            ref={detailRef}
            tabIndex={-1}
            aria-labelledby="diagnostics-stage-title"
          >
            <div className="diagnostics-stage-heading">
              <span className="diagnostics-icon">
                <FileText size={24} />
              </span>
              <div>
                <span className="diagnostics-kicker">{t('flow.step', { number: 2 })}</span>
                <h2 id="diagnostics-stage-title">{t('flow.detailsTitle')}</h2>
                <p className="diagnostics-description">{t('flow.detailsHint')}</p>
              </div>
            </div>
            <div className="diagnostics-details-grid">
              <form
                className="diagnostics-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run(prepare)
                }}
              >
                <label>
                  {t('name')}
                  <input
                    className="feature-field"
                    required
                    maxLength={120}
                    disabled={busy}
                    value={selected.title}
                    placeholder={t('flow.namePlaceholder')}
                    onChange={(e) => setSelected({ ...selected, title: e.target.value })}
                  />
                </label>
                <label>
                  {t('flow.notes')}
                  <textarea
                    className="feature-field"
                    maxLength={2000}
                    rows={4}
                    disabled={busy}
                    value={selected.notes}
                    placeholder={t('flow.notesPlaceholder')}
                    onChange={(e) => setSelected({ ...selected, notes: e.target.value })}
                  />
                  <small>{t('flow.notesHint')}</small>
                </label>
                {hasProcesses && (
                  <label className="diagnostics-checkbox">
                    <input
                      type="checkbox"
                      checked={shareProcesses}
                      disabled={busy}
                      onChange={(e) => setShareProcesses(e.target.checked)}
                    />
                    <span>{t('flow.shareProcesses')}</span>
                  </label>
                )}
                <div className="diagnostics-actions">
                  <button
                    type="submit"
                    className={primary}
                    disabled={busy || !cap?.available || !selected.title.trim() || tooShort}
                  >
                    {busy ? (
                      <Loader2 className="diagnostics-spin" size={16} />
                    ) : (
                      <Cloud size={16} />
                    )}
                    {t('flow.continue')}
                    <ArrowRight size={16} />
                  </button>
                </div>
              </form>
              <aside className="diagnostics-summary">
                <span className="diagnostics-summary-check">
                  <Check size={20} />
                </span>
                <h3>
                  {t(selected.state === 'interrupted' ? 'interrupted' : 'flow.recordingReady')}
                </h3>
                <p>
                  {t('flow.captured', {
                    duration: clock(selected.recording.durationMs),
                    count: selected.recording.samples.length
                  })}
                </p>
                <dl>
                  <div>
                    <dt>{t('flow.averageCpu')}</dt>
                    <dd>{stats?.cpuMean == null ? '—' : `${stats.cpuMean.toFixed(1)}%`}</dd>
                  </div>
                  <div>
                    <dt>{t('flow.averageMemory')}</dt>
                    <dd>{stats?.memoryMean == null ? '—' : `${stats.memoryMean.toFixed(1)}%`}</dd>
                  </div>
                </dl>
                <p className="diagnostics-footnote">
                  {t(tooShort ? 'flow.tooShort' : 'flow.measurementHint')}
                </p>
              </aside>
            </div>
          </section>
        )}

        {step === 3 && selected && (
          <section
            className="diagnostics-stage"
            ref={detailRef}
            tabIndex={-1}
            aria-labelledby="diagnostics-stage-title"
          >
            <div className="diagnostics-stage-heading">
              <span className="diagnostics-icon">
                <Sparkles size={24} />
              </span>
              <div>
                <span className="diagnostics-kicker">{t('flow.step', { number: 3 })}</span>
                <h2 id="diagnostics-stage-title">
                  {t(report ? 'flow.reportTitle' : 'flow.analyzeTitle')}
                </h2>
                <p className="diagnostics-description">
                  {selected.title} · {clock(selected.recording.durationMs)}
                </p>
              </div>
            </div>
            <ol className="diagnostics-cloud-progress" aria-label={t('flow.cloudProgress')}>
              {(
                [
                  ['uploadStage', Upload],
                  ['analyzeStage', Sparkles],
                  ['reportStage', FileText]
                ] as const
              ).map(([key, Icon], index) => {
                const completed = !!report || (index === 0 && !!selected.cloud)
                const current =
                  !cloudGone &&
                  !report &&
                  selected.cloud?.status !== 'failed' &&
                  (index === 0 ? uploading : index === 1 ? processing : false)
                return (
                  <li key={key} data-state={completed ? 'done' : current ? 'current' : 'upcoming'}>
                    <span>
                      {completed ? (
                        <Check size={18} />
                      ) : current ? (
                        <Loader2 size={18} className="diagnostics-spin" />
                      ) : (
                        <Icon size={18} />
                      )}
                    </span>
                    <div>
                      <strong>{t(`flow.${key}`)}</strong>
                      <small>{t(`flow.${key}Hint`)}</small>
                    </div>
                  </li>
                )
              })}
            </ol>
            {selected.notes && (
              <details className="diagnostics-context">
                <summary>{t('flow.recordingNotes')}</summary>
                <p>{selected.notes}</p>
              </details>
            )}
            {!selected.cloud && (!selected.upload || preview) && !uploading && (
              <div className="diagnostics-consent">
                <h3>{t('flow.readyTitle')}</h3>
                <p>{t('flow.readyHint')}</p>
                <div className="diagnostics-upload-facts">
                  <span>
                    <ShieldCheck size={16} />
                    {t(shareProcesses ? 'flow.withProcesses' : 'flow.withoutProcesses')}
                  </span>
                  {preview && <span>{formatBytes(preview.bytes)}</span>}
                </div>
                <details className="diagnostics-disclosure">
                  <summary>{t('flow.privacyDetails')}</summary>
                  <p>{t('cloudPrivacy')}</p>
                  {preview && (
                    <details>
                      <summary>{t('exactUpload')}</summary>
                      <pre>{JSON.stringify(JSON.parse(preview.json), null, 2)}</pre>
                    </details>
                  )}
                </details>
                <p className="diagnostics-footnote">{t('flow.consent')}</p>
                <div className="diagnostics-actions">
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => {
                      setReviewing(false)
                      setPreview(null)
                    }}
                  >
                    <ArrowLeft size={15} />
                    {t(selected.upload ? 'cancel' : 'flow.backDetails')}
                  </button>
                  <button
                    className={primary}
                    disabled={busy || !cap?.available}
                    onClick={() =>
                      void run(async () => {
                        if (!preview) {
                          await prepare()
                          return
                        }
                        setUploading(true)
                        try {
                          adopt(await window.kudu.diagnosticsUpload(preview.token))
                        } finally {
                          setUploading(false)
                          setPreview(null)
                          // A timeout can still leave a Cloud copy. Reload its reference so it can be retrieved or deleted.
                          adopt(await window.kudu.diagnosticsGet(id!))
                        }
                      })
                    }
                  >
                    <Sparkles size={16} />
                    {t(preview ? 'flow.analyzeButton' : 'flow.reviewAgain')}
                  </button>
                </div>
              </div>
            )}
            {(uploading || processing) && (
              <div className="diagnostics-analysis-status" role="status">
                <h3>
                  {t(
                    uploading
                      ? 'flow.uploadingTitle'
                      : selected.cloud?.status === 'queued'
                        ? 'flow.queuedTitle'
                        : 'flow.processingTitle'
                  )}
                </h3>
                <p>{t(uploading ? 'flow.uploadingHint' : 'flow.processingHint')}</p>
              </div>
            )}
            {selected.upload && !selected.cloud && !preview && !uploading && (
              <div className="diagnostics-analysis-status" role="status">
                <h3>{t('flow.pendingTitle')}</h3>
                <p>{t('flow.pendingHint')}</p>
              </div>
            )}
            {cloudGone && (
              <p className="diagnostics-error" role="status">
                {t('cloudGone')}
              </p>
            )}
            {selected.cloud?.status === 'failed' && !cloudGone && (
              <div className="diagnostics-analysis-status" role="status">
                <h3>{t('failed')}</h3>
                <p>{t('analysisFailed')}</p>
                <button className={primary} disabled={busy} onClick={newRecording}>
                  <Plus size={15} />
                  {t('flow.newSession')}
                </button>
              </div>
            )}
            {report && <DiagnosticReport key={id} report={report} recording={selected.recording} />}
            {selected.upload && !cloudGone && !preview && (
              <div className="diagnostics-actions">
                <button
                  className={button}
                  disabled={busy || uploading}
                  onClick={() =>
                    void run(async () => adopt(await window.kudu.diagnosticsRefresh(id!)))
                  }
                >
                  {t('refreshReport')}
                </button>
                {!selected.cloud && (
                  <button
                    className={button}
                    disabled={busy || !cap?.available}
                    onClick={() =>
                      void run(async () => {
                        setPreview(
                          await window.kudu.diagnosticsPreview(
                            id!,
                            selected.upload!.includeProcesses
                          )
                        )
                        setReviewing(true)
                      })
                    }
                  >
                    {t('flow.reviewAgain')}
                  </button>
                )}
              </div>
            )}
          </section>
        )}
        {selected && !active && (
          <div className="diagnostics-session-footer">
            <span>
              <ShieldCheck size={14} />
              {t('flow.cloudOnly')}
            </span>
            <button
              className="diagnostics-text-button"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              {t('flow.deleteSession')}
            </button>
          </div>
        )}
        {rows.length > 0 && !active && (
          <details className="diagnostics-history">
            <summary>
              <History size={17} />
              <span>{t('flow.history')}</span>
              <span className="diagnostics-history-count">{rows.length}</span>
            </summary>
            <div>
              {rows.map((row) => (
                <button
                  className="diagnostics-history-row"
                  key={row.id}
                  disabled={busy}
                  aria-pressed={row.id === id}
                  onClick={() => void run(() => open(row.id))}
                >
                  <span className="diagnostics-history-icon">
                    {row.cloudStatus === 'complete' ? (
                      <FileText size={18} />
                    ) : (
                      <Activity size={18} />
                    )}
                  </span>
                  <span>
                    <strong>{row.title}</strong>
                    <small>
                      {new Date(row.startedAt).toLocaleString()} · {clock(row.durationMs)}
                    </small>
                  </span>
                  <span className="diagnostics-history-status">
                    {t(
                      row.cloudStatus ??
                        (row.state === 'saved' ? 'flow.awaitingAnalysis' : row.state)
                    )}
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        variant="danger"
        title={t('flow.deleteSession')}
        description={t('flow.confirmDelete')}
        details={selected?.title}
        confirmLabel={t('confirmDelete')}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          void run(async () => {
            if (!id || !selected) return
            if (selected.upload && !cloudGone) await window.kudu.diagnosticsDeleteCloud(id)
            if (selected.pinned)
              await window.kudu.diagnosticsEdit(id, { ...selected, pinned: false })
            await window.kudu.diagnosticsRemove(id)
            newRecording()
          })
        }}
      />
    </div>
  )
}
