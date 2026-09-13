import { mkdir, readdir, lstat, readFile, writeFile, rename, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  diagnosticId,
  validDiagnosticRecording,
  validDiagnosticReport
} from '../../shared/performance-diagnostics'
import type { DiagnosticSession, DiagnosticSummary } from '../../shared/performance-diagnostics'

export class DiagnosticsStore {
  private queue: Promise<unknown> = Promise.resolve()
  private summaries: DiagnosticSummary[] | null = null
  private revision = 0
  private warnedUnreadable = false
  constructor(
    private dir: string,
    private seal: (value: string) => Buffer,
    private open: (value: Buffer) => string
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }
  private path(id: string): string {
    if (!diagnosticId(id)) throw new Error('Invalid recording ID')
    return join(this.dir, `${id}.record`)
  }
  async get(id: string): Promise<DiagnosticSession> {
    const path = this.path(id)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2097152)
      throw new Error('Invalid recording file')
    const value = JSON.parse(this.open(await readFile(path))) as DiagnosticSession
    if (
      !validDiagnosticRecording(value.recording) ||
      value.recording.recordId !== id ||
      typeof value.title !== 'string' ||
      value.title.length > 120 ||
      typeof value.notes !== 'string' ||
      value.notes.length > 2000 ||
      typeof value.pinned !== 'boolean' ||
      !['recording', 'saved', 'interrupted'].includes(value.state) ||
      (value.cloud?.report &&
        !validDiagnosticReport(value.cloud.report, value.recording.durationMs))
    )
      throw new Error('Recording is corrupt or unsupported')
    return value
  }
  async list(): Promise<DiagnosticSummary[]> {
    if (this.summaries) return structuredClone(this.summaries)
    const revision = this.revision
    await mkdir(this.dir, { recursive: true })
    const names = (await readdir(this.dir)).filter(
      (n) => n.endsWith('.record') && diagnosticId(n.slice(0, -7))
    )
    if (names.length > 100)
      throw new Error('Too many recording files. Export or remove excess files before continuing.')
    const results: DiagnosticSummary[] = []
    let unreadable = 0
    for (const name of names) {
      let s: DiagnosticSession
      try {
        s = await this.get(name.slice(0, -7))
      } catch {
        // One undecryptable or unsupported file must not disable every other recording.
        unreadable++
        continue
      }
      results.push({
        id: s.recording.recordId,
        title: s.title,
        pinned: s.pinned,
        state: s.state,
        startedAt: s.recording.startedAt,
        durationMs: s.recording.durationMs,
        samples: s.recording.samples.length,
        cloudStatus: s.cloud?.status ?? null
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    results.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    if (unreadable && !this.warnedUnreadable) {
      this.warnedUnreadable = true
      console.warn(
        `[diagnostics] ${unreadable} unreadable recording file(s) skipped in ${this.dir}`
      )
    }
    if (revision === this.revision) this.summaries = results
    return structuredClone(results)
  }
  save(session: DiagnosticSession, create = false): Promise<void> {
    // Snapshot before waiting so subsequent sampling cannot change this write.
    const json = JSON.stringify(session)
    const id = session.recording.recordId
    return this.serial(async () => {
      await mkdir(this.dir, { recursive: true })
      const path = this.path(id)
      if (create) {
        const rows = await this.list()
        if (rows.some((r) => r.id === id)) throw new Error('Recording already exists')
        // Explicit cleanup prevents silently discarding an unsynced recording or Cloud reference.
        if (rows.length >= 30)
          throw new Error('30 recordings saved. Export and delete a recording to make space.')
      } else {
        // No resurrection after deletion.
        await lstat(path)
      }
      const encrypted = this.seal(json)
      if (encrypted.length > 2097152) throw new Error('Recording exceeds the local storage limit')
      const temp = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, encrypted, { flag: 'wx', mode: 0o600 })
        await rename(temp, path)
        this.summaries = null
        this.revision++
      } finally {
        await unlink(temp).catch(() => {})
      }
    })
  }
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const path = this.path(id)
      let pinned = false
      try {
        pinned = (await this.get(id)).pinned
      } catch {
        // Unreadable files are removable so the user can clear them.
        await lstat(path)
      }
      if (pinned) throw new Error('Unpin this recording before deleting it.')
      await unlink(path)
      this.summaries = null
      this.revision++
    })
  }
}
