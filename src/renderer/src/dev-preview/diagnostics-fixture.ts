import { diagnosticUpload } from '@shared/performance-diagnostics'
import type { DiagnosticSession, DiagnosticSummary } from '@shared/performance-diagnostics'

// Browser-only workflow simulation. No measurements or requests reach the device or Cloud.
export function diagnosticsFixture(sample: DiagnosticSession, empty: boolean) {
  const sessions = new Map<string, DiagnosticSession>()
  if (!empty) sessions.set(sample.recording.recordId, structuredClone(sample))
  const scenario = new URLSearchParams(location.search).get('diagnostics')
  let activeId: string | null = null
  let started = 0
  let duration = 120000
  let uploadStarted = 0
  let preview: { id: string; includeProcesses: boolean; token: string } | null = null
  const get = (id: string) => {
    const session = sessions.get(id)
    if (!session) throw new Error('Preview recording not found')
    return session
  }
  const finish = () => {
    if (!activeId) return
    get(activeId).state = 'saved'
    activeId = null
  }
  return {
    diagnosticsStatus: () => {
      if (activeId && Date.now() - started >= duration) finish()
      return {
        rows: [...sessions.values()].map((s): DiagnosticSummary => ({
          id: s.recording.recordId,
          title: s.title,
          pinned: s.pinned,
          state: s.state,
          startedAt: s.recording.startedAt,
          durationMs: s.recording.durationMs,
          samples: s.recording.samples.length,
          cloudStatus: s.cloud?.status ?? null
        })),
        activeId,
        elapsedMs: activeId ? Date.now() - started : 0
      }
    },
    diagnosticsGet: (id: string) => structuredClone(get(id)),
    diagnosticsStart: (seconds: number, processes: boolean) => {
      const session = structuredClone(sample)
      session.recording.recordId = crypto.randomUUID()
      session.recording.startedAt = new Date().toISOString()
      session.title = 'Performance recording'
      session.notes = ''
      session.state = 'recording'
      session.recording.samples = session.recording.samples.map((s) => ({
        ...s,
        processes: processes
          ? [
              {
                pid: 120,
                name: 'browser.exe',
                startedAt: null,
                cpuPercent: 20,
                memoryBytes: 1024 ** 3
              }
            ]
          : []
      }))
      activeId = session.recording.recordId
      started = Date.now()
      duration = scenario === 'auto' ? 6000 : seconds * 1000
      sessions.set(activeId, session)
      return activeId
    },
    diagnosticsStop: finish,
    diagnosticsEdit: (id: string, details: { title: string; notes: string; pinned: boolean }) => {
      Object.assign(get(id), {
        title: details.title.trim(),
        notes: details.notes,
        pinned: details.pinned
      })
    },
    diagnosticsPreview: (id: string, includeProcesses: boolean) => {
      preview = { id, includeProcesses, token: crypto.randomUUID() }
      const json = JSON.stringify({
        consent: true,
        recording: diagnosticUpload(get(id).recording, includeProcesses)
      })
      return {
        token: preview.token,
        json,
        bytes: new TextEncoder().encode(json).length,
        includeProcesses
      }
    },
    diagnosticsUpload: async (token: string) => {
      if (!preview || preview.token !== token) throw new Error('Review the upload again')
      const session = get(preview.id)
      session.upload = {
        consentAt: new Date().toISOString(),
        includeProcesses: preview.includeProcesses
      }
      preview = null
      await new Promise((resolve) => setTimeout(resolve, 1800))
      if (scenario === 'upload-error')
        throw new Error('Preview: upload timed out. Check your connection and try again.')
      uploadStarted = Date.now()
      session.cloud = {
        recordId: session.recording.recordId,
        status: 'queued',
        report: null,
        errorCode: null,
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString()
      }
      return structuredClone(session)
    },
    diagnosticsRefresh: (id: string) => {
      const session = get(id)
      if (!session.cloud) throw new Error('Preview: upload has not been confirmed')
      session.cloud.status =
        Date.now() - uploadStarted < 8000
          ? 'processing'
          : scenario === 'failed'
            ? 'failed'
            : 'complete'
      if (session.cloud.status === 'complete')
        session.cloud.report = {
          version: 1,
          analyzerVersion: 'Preview analyzer',
          generatedAt: new Date().toISOString(),
          summary:
            'CPU activity increased while apps were opening. Memory had plenty of headroom throughout the recording.',
          findings: [
            {
              title: 'App startup coincides with higher CPU usage',
              confidence: 'medium',
              observation: 'CPU usage rose repeatedly during the recorded workload.',
              interpretation: 'Several apps starting together may be competing for processor time.',
              nextSteps: [
                'Try opening your apps one at a time.',
                'Review unnecessary startup apps, then record the same workload again.'
              ],
              evidence: [{ metric: 'cpuPercent', startMs: 0, endMs: 20000 }]
            }
          ],
          limitations: [
            'This is sample data for interface review. It is not a diagnosis of this device.'
          ]
        }
      return structuredClone(session)
    },
    diagnosticsDeleteCloud: (id: string) => {
      const session = get(id)
      if (session.cloud) session.cloud.expiresAt = new Date(0).toISOString()
      else session.upload = null
    },
    diagnosticsRemove: (id: string) => {
      sessions.delete(id)
    }
  }
}
