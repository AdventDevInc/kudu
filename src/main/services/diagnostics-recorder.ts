import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import * as si from 'systeminformation'
import type {
  DiagnosticProcess,
  DiagnosticSession,
  DiagnosticSample
} from '../../shared/performance-diagnostics'
import type { DiagnosticsStore } from './diagnostics-store'

export const measurement = (value: unknown, max = 2 ** 50): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null
export function diagnosticProcesses(
  list: { pid: number; name: string; cpu: number; memRss: number; started: string }[]
): DiagnosticProcess[] {
  return list
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.pid <= 2147483647)
    .sort(
      (a, b) =>
        (measurement(b.cpu, 100) ?? 0) - (measurement(a.cpu, 100) ?? 0) || b.memRss - a.memRss
    )
    .slice(0, 5)
    .map((p) => ({
      pid: p.pid,
      name:
        path.posix
          .basename(path.win32.basename(p.name))
          .replace(/[\u0000-\u001f]/g, '')
          .slice(0, 80) || 'Unknown',
      startedAt:
        p.started && Number.isFinite(Date.parse(p.started))
          ? new Date(p.started).toISOString()
          : null,
      cpuPercent: measurement(p.cpu, 100),
      // systeminformation reports resident memory in KiB on every platform.
      memoryBytes: measurement(p.memRss * 1024)
    }))
}
function cpuTimes(): { idle: number; total: number } {
  return os.cpus().reduce(
    (a, c) => ({
      idle: a.idle + c.times.idle,
      total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0)
    }),
    { idle: 0, total: 0 }
  )
}
export function diagnosticCpu(
  previous: { idle: number; total: number },
  current: { idle: number; total: number }
): number | null {
  const delta = current.total - previous.total
  return delta > 0 && current.idle >= previous.idle
    ? measurement(100 * (1 - (current.idle - previous.idle) / delta), 100)
    : null
}

/** Own lifecycle and cheap CPU sampler; live Performance Monitor can pause independently. */
export class DiagnosticsRecorder {
  active: DiagnosticSession | null = null
  error: string | null = null
  private starting = false
  private timer: ReturnType<typeof setInterval> | null = null
  private startTime = 0
  private duration = 0
  private previous = cpuTimes()
  private tickBusy = false
  private processBusy = false
  private memoryBusy = false
  private processAt = -10000
  private diskBusy = false
  private diskAt = -5000
  private disk: { read: number | null; write: number | null; t: number } | null = null
  constructor(
    private store: DiagnosticsStore,
    private authorize: () => Promise<boolean>
  ) {}
  async start(seconds: unknown, includeProcesses: unknown): Promise<string> {
    if (![120, 300, 900].includes(seconds as number) || typeof includeProcesses !== 'boolean')
      throw new Error('Choose a supported recording duration')
    if (this.active || this.starting || this.tickBusy || this.processBusy || this.diskBusy)
      throw new Error('A recording or measurement is still finishing')
    this.starting = true
    try {
      if (!(await this.authorize()))
        throw new Error('New diagnostics require an active Cloud Pro subscription.')
      const platform = process.platform
      if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux')
        throw new Error('Unsupported platform')
      const s: DiagnosticSession = {
        recording: {
          version: 1,
          recordId: randomUUID(),
          startedAt: new Date().toISOString(),
          durationMs: 0,
          system: {
            platform,
            cpuModel: os.cpus()[0]?.model.slice(0, 160) || 'Unknown',
            logicalCores: Math.max(1, os.cpus().length),
            totalMemoryBytes: os.totalmem(),
            osVersion: os.release().slice(0, 160)
          },
          samples: []
        },
        title: 'Performance recording',
        notes: '',
        pinned: false,
        state: 'recording',
        cloud: null,
        upload: null
      }
      await this.store.save(s, true)
      this.error = null
      this.startTime = performance.now()
      this.duration = (seconds as number) * 1000
      this.previous = cpuTimes()
      this.processAt = -10000
      this.diskAt = -5000
      this.disk = null
      this.active = s
      await this.tick(includeProcesses)
      if (this.active === s)
        this.timer = setInterval(() => {
          void this.tick(includeProcesses)
        }, 1000)
      return s.recording.recordId
    } finally {
      this.starting = false
    }
  }
  private async tick(includeProcesses: boolean): Promise<void> {
    const s = this.active
    if (!s || this.tickBusy) return
    const t = Math.min(this.duration, Math.floor(performance.now() - this.startTime))
    if (s.recording.samples.length && t <= s.recording.samples.at(-1)!.t) return
    this.tickBusy = true
    try {
      const current = cpuTimes()
      const cpu = s.recording.samples.length ? diagnosticCpu(this.previous, current) : null
      this.previous = current
      const sample: DiagnosticSample = {
        t,
        cpuPercent: cpu,
        memoryPercent: null,
        memoryUsedBytes: null,
        diskReadBytesPerSec: null,
        diskWriteBytesPerSec: null,
        processes: []
      }
      if (process.platform === 'win32')
        sample.memoryUsedBytes = measurement(
          os.totalmem() - os.freemem(),
          s.recording.system.totalMemoryBytes
        )
      else if (!this.memoryBusy) {
        this.memoryBusy = true
        // Do not await an unbounded platform query in the sampling/stop lifecycle.
        void si
          .mem()
          .then((mem) => {
            if (this.active !== s) return
            sample.memoryUsedBytes = measurement(
              process.platform === 'darwin' ? mem.total - mem.available : mem.active,
              s.recording.system.totalMemoryBytes
            )
            sample.memoryPercent =
              sample.memoryUsedBytes === null
                ? null
                : (100 * sample.memoryUsedBytes) / s.recording.system.totalMemoryBytes
          })
          .catch(() => {})
          .finally(() => {
            this.memoryBusy = false
          })
      }
      sample.memoryPercent =
        sample.memoryUsedBytes === null
          ? null
          : (100 * sample.memoryUsedBytes) / s.recording.system.totalMemoryBytes
      if (this.disk && t - this.disk.t <= 6000) {
        sample.diskReadBytesPerSec = this.disk.read
        sample.diskWriteBytesPerSec = this.disk.write
        this.disk = null
      }
      if (!this.diskBusy && t - this.diskAt >= 5000) {
        this.diskBusy = true
        this.diskAt = t
        void si
          .fsStats()
          .then((stats) => {
            if (this.active === s && performance.now() - this.startTime - t < 5000)
              this.disk = { read: measurement(stats.rx_sec), write: measurement(stats.wx_sec), t }
          })
          .catch(() => {})
          .finally(() => {
            this.diskBusy = false
          })
      }
      // Processes are intentionally sparse. Never repeat an old observation as a fresh tick.
      if (includeProcesses && !this.processBusy && t - this.processAt >= 10000) {
        this.processBusy = true
        this.processAt = t
        void si
          .processes()
          .then((data) => {
            if (this.active === s && performance.now() - this.startTime - t < 10000)
              sample.processes = diagnosticProcesses(data.list)
          })
          .catch(() => {})
          .finally(() => {
            this.processBusy = false
          })
      }
      s.recording.samples.push(sample)
      s.recording.durationMs = t
      if (s.recording.samples.length % 10 === 0) await this.store.save(s)
      if (this.active === s && (t >= this.duration || s.recording.samples.length >= 901))
        await this.stop()
    } catch {
      this.error =
        'Recording stopped because measurements could not be saved. The last checkpoint remains available.'
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.active = null
    } finally {
      this.tickBusy = false
    }
  }
  async stop(): Promise<void> {
    const s = this.active
    if (!s) return
    this.active = null // invalidate pending measurement callbacks first
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    s.state = 'saved'
    s.recording.durationMs = Math.min(this.duration, Math.floor(performance.now() - this.startTime))
    await this.store.save(s)
  }
}
