import { createHash, randomUUID } from 'crypto'
import { diagnosticId, diagnosticUpload } from '../../shared/performance-diagnostics'
import type {
  DiagnosticPreview,
  DiagnosticSession,
  DiagnosticSummary
} from '../../shared/performance-diagnostics'
import {
  diagnosticAccount,
  diagnosticCapabilities,
  diagnosticCloudResult,
  diagnosticsRequest
} from './diagnostics-cloud'
import { DiagnosticsRecorder } from './diagnostics-recorder'
import { DiagnosticsStore } from './diagnostics-store'

export class PerformanceDiagnostics {
  readonly recorder: DiagnosticsRecorder
  private initialized: Promise<void> | null = null
  private mutation: Promise<unknown> = Promise.resolve()
  private preview: {
    token: string
    id: string
    body: string
    digest: string
    account: string
    includeProcesses: boolean
    expires: number
  } | null = null
  constructor(readonly store: DiagnosticsStore) {
    this.recorder = new DiagnosticsRecorder(
      store,
      async () => (await diagnosticCapabilities()).available
    )
  }
  async ready(): Promise<void> {
    if (!this.initialized)
      this.initialized = (async () => {
        for (const row of await this.store.list()) {
          if (row.state === 'recording') {
            const s = await this.store.get(row.id)
            s.state = 'interrupted'
            await this.store.save(s)
          }
        }
      })().catch((e) => {
        this.initialized = null
        throw e
      })
    return this.initialized
  }
  private change<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(work, work)
    this.mutation = next.catch(() => {})
    return next
  }
  async status(): Promise<{
    rows: DiagnosticSummary[]
    activeId: string | null
    elapsedMs: number
    error: string | null
  }> {
    await this.ready()
    const active = this.recorder.active
    return {
      rows: await this.store.list(),
      activeId: active?.recording.recordId ?? null,
      elapsedMs: active?.recording.durationMs ?? 0,
      error: this.recorder.error
    }
  }
  async start(seconds: unknown, processes: unknown): Promise<string> {
    await this.ready()
    return this.recorder.start(seconds, processes)
  }
  async get(id: string): Promise<DiagnosticSession> {
    await this.ready()
    if (this.recorder.active?.recording.recordId === id)
      return structuredClone(this.recorder.active)
    return this.store.get(id)
  }
  private async saved(id: string): Promise<DiagnosticSession> {
    if (!diagnosticId(id) || this.recorder.active?.recording.recordId === id)
      throw new Error('Stop the recording before changing or sharing it.')
    return this.get(id)
  }
  edit(id: string, value: unknown): Promise<void> {
    return this.change(async () => {
      const v = value as { title?: unknown; notes?: unknown; pinned?: unknown } | null
      if (
        !v ||
        typeof v.title !== 'string' ||
        !v.title.trim() ||
        v.title.length > 120 ||
        typeof v.notes !== 'string' ||
        v.notes.length > 2000 ||
        typeof v.pinned !== 'boolean'
      )
        throw new Error('Invalid recording details')
      const s = await this.saved(id)
      await this.store.save({ ...s, title: v.title.trim(), notes: v.notes, pinned: v.pinned })
    })
  }
  async prepare(id: string, includeProcesses: unknown): Promise<DiagnosticPreview> {
    if (typeof includeProcesses !== 'boolean')
      throw new Error('Choose whether to share process names')
    const s = await this.saved(id)
    if (s.recording.samples.length < 2 || s.recording.durationMs < 1000)
      throw new Error('Record for at least two samples before requesting analysis.')
    const body = JSON.stringify({
      consent: true,
      recording: diagnosticUpload(s.recording, includeProcesses)
    })
    const bytes = Buffer.byteLength(body)
    if (bytes > 1048576) throw new Error('Recording exceeds the Cloud upload limit')
    const digest = createHash('sha256').update(body).digest('hex')
    const account = await diagnosticAccount()
    if (s.upload && (s.upload.digest !== digest || s.upload.account !== account))
      throw new Error(
        'This recording has already been submitted. Use its original sharing options and Cloud account, or create a new recording.'
      )
    this.preview = {
      id,
      body,
      digest,
      account,
      includeProcesses,
      token: randomUUID(),
      expires: Date.now() + 300000
    }
    return { token: this.preview.token, json: body, bytes, includeProcesses }
  }
  upload(token: unknown): Promise<DiagnosticSession> {
    return this.change(async () => {
      const p = this.preview
      this.preview = null
      if (
        !p ||
        token !== p.token ||
        Date.now() > p.expires ||
        p.account !== (await diagnosticAccount())
      )
        throw new Error('Upload preview expired. Review the recording again.')
      const s = await this.saved(p.id)
      const fresh = JSON.stringify({
        consent: true,
        recording: diagnosticUpload(s.recording, p.includeProcesses)
      })
      if (fresh !== p.body) throw new Error('Recording changed. Review a new upload preview.')
      s.upload = {
        consentAt: new Date().toISOString(),
        digest: p.digest,
        includeProcesses: p.includeProcesses,
        account: p.account
      }
      await this.store.save(s) // persist consent/reference before any network request
      const response = await diagnosticsRequest('POST', p.id, p.body, p.account)
      s.cloud = diagnosticCloudResult(response, p.id, s.recording.durationMs)
      await this.store.save(s)
      return s
    })
  }
  refresh(id: string): Promise<DiagnosticSession> {
    return this.change(async () => {
      const s = await this.saved(id)
      if (!s.upload || s.upload.account !== (await diagnosticAccount()))
        throw new Error('Use the Cloud account that received this recording.')
      s.cloud = diagnosticCloudResult(
        await diagnosticsRequest('GET', id, undefined, s.upload.account),
        id,
        s.recording.durationMs
      )
      await this.store.save(s)
      return s
    })
  }
  deleteCloud(id: string): Promise<void> {
    return this.change(async () => {
      const s = await this.saved(id)
      if (!s.upload || s.upload.account !== (await diagnosticAccount()))
        throw new Error('Use the Cloud account that received this recording.')
      const result = (await diagnosticsRequest('DELETE', id, undefined, s.upload.account)) as {
        deleted?: unknown
      } | null
      if (result?.deleted !== true) throw new Error('Cloud deletion was not confirmed')
      // Keep the downloaded report readable; mark the server copy as removed via expiry.
      if (s.cloud) s.cloud.expiresAt = new Date(0).toISOString()
      await this.store.save(s)
    })
  }
  remove(id: string): Promise<void> {
    return this.change(async () => {
      await this.saved(id)
      await this.store.remove(id)
      if (this.preview?.id === id) this.preview = null
    })
  }
}
