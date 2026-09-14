import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '@/lib/utils'
import type {
  DiagnosticRecording,
  DiagnosticReport as Report
} from '@shared/performance-diagnostics'

const button = 'feature-button'
const panel = 'feature-card diagnostics-finding space-y-4'
const percent = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}%`)

export function DiagnosticReport({
  report,
  recording
}: {
  report: Report
  recording: DiagnosticRecording
}) {
  const { t } = useTranslation('diagnostics')
  const [range, setRange] = useState<{ startMs: number; endMs: number } | null>(null)
  return (
    <div className="diagnostics-report">
      {report && (
        <div className="space-y-4">
          <p className="font-medium">{report.summary}</p>
          <p className="text-xs text-[var(--text-muted)]">
            {t('aiCaution')} · {report.analyzerVersion} ·{' '}
            {new Date(report.generatedAt).toLocaleString()}
          </p>
          {report.findings.map((f, i) => (
            <article key={i} className={panel}>
              <h3 className="font-semibold">
                {f.title}{' '}
                <span className="text-xs font-normal">
                  {t('confidence', { level: t(f.confidence) })}
                </span>
              </h3>
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
                    {t(e.metric)} · {(e.startMs / 1000).toFixed(1)}–{(e.endMs / 1000).toFixed(1)}s
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
              {recording.samples
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
  )
}
