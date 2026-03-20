import * as si from 'systeminformation'
import { execFile, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../shared/channels'
import type {
  PerfSystemInfo,
  PerfSnapshot,
  PerfProcess,
  PerfProcessList,
  PerfKillResult,
  DiskSmartInfo,
  StartupItem
} from '../../shared/types'

const execFileAsync = promisify(execFile)

export class PerfMonitorService {
  private fastTimer: ReturnType<typeof setInterval> | null = null
  private slowTimer: ReturnType<typeof setInterval> | null = null
  private sender: Electron.WebContents | null = null
  private cachedSystemInfo: PerfSystemInfo | null = null
  private startupExeMap: Map<string, string> = new Map()
  // Guards to prevent overlapping async calls from piling up if si hangs
  private snapshotRunning = false
  private processesRunning = false

  // Windows CPU utility monitoring via typeperf
  // Uses '% Processor Utility' counter which matches Task Manager's frequency-aware
  // measurement, unlike systeminformation's time-based '% Processor Time'.
  private typeperfProcess: ChildProcess | null = null
  private typeperfFailed = false
  private typeperfBuffer = ''
  private typeperfTotalIdx = -1
  private typeperfCoreIndices: number[] = []
  private latestCpuUtility: { overall: number; perCore: number[] } | null = null

  async getSystemInfo(): Promise<PerfSystemInfo> {
    if (this.cachedSystemInfo) return this.cachedSystemInfo

    const [cpu, os, mem] = await Promise.all([si.cpu(), si.osInfo(), si.mem()])

    this.cachedSystemInfo = {
      cpuModel: `${cpu.manufacturer} ${cpu.brand}`,
      cpuCores: cpu.physicalCores,
      cpuThreads: cpu.cores,
      totalMemBytes: mem.total,
      osVersion: `${os.distro} ${os.release}`,
      hostname: os.hostname
    }
    return this.cachedSystemInfo
  }

  async startMonitoring(
    sender: Electron.WebContents,
    getStartupItems?: () => Promise<StartupItem[]>
  ): Promise<void> {
    // If already running, just update the sender
    if (this.fastTimer) {
      this.sender = sender
      return
    }

    this.sender = sender

    // Build startup exe map for correlation
    if (getStartupItems) {
      try {
        const items = await getStartupItems()
        this.startupExeMap.clear()
        for (const item of items) {
          // Extract exe name from command string
          const match = item.command.match(/([^/\\]+\.exe)/i)
          if (match) {
            this.startupExeMap.set(match[1].toLowerCase(), item.displayName || item.name)
          }
        }
      } catch {
        // Startup correlation is optional
      }
    }

    // Start Windows-specific CPU utility monitor (matches Task Manager)
    this.startCpuUtilityMonitor()

    // Fast interval: system metrics every 1s
    this.fastTimer = setInterval(() => this.collectSnapshot(), 1000)
    // Collect immediately
    this.collectSnapshot()

    // Slow interval: process list every 10s (si.processes() is expensive)
    this.slowTimer = setInterval(() => this.collectProcesses(), 10000)
    this.collectProcesses()
  }

  stopMonitoring(): void {
    if (this.fastTimer) {
      clearInterval(this.fastTimer)
      this.fastTimer = null
    }
    if (this.slowTimer) {
      clearInterval(this.slowTimer)
      this.slowTimer = null
    }
    this.stopCpuUtilityMonitor()
    this.sender = null
  }

  async getProcessName(pid: number): Promise<string | null> {
    try {
      const data = await si.processes()
      const proc = data.list.find((p) => p.pid === pid)
      return proc?.name ?? null
    } catch {
      return null
    }
  }

  async killProcess(pid: number): Promise<PerfKillResult> {
    try {
      process.kill(pid)
      return { success: true }
    } catch {
      // Fallback to platform-specific kill command
      try {
        if (process.platform === 'win32') {
          await execFileAsync('taskkill', ['/F', '/PID', String(pid)])
        } else {
          await execFileAsync('kill', ['-9', String(pid)])
        }
        return { success: true }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const requiresAdmin = message.includes('Access') || message.includes('denied') || message.includes('Operation not permitted')
        return {
          success: false,
          error: requiresAdmin
            ? 'Access denied. Run Kudu as Administrator to end this process.'
            : `Failed to end process: ${message}`,
          requiresAdmin
        }
      }
    }
  }

  async getDiskHealth(): Promise<DiskSmartInfo[]> {
    try {
      const disks = await si.diskLayout()
      const reliabilityMap = await this.getStorageReliability()

      return disks.map((d) => {
        const smartStatus =
          d.smartStatus === 'Ok'
            ? 'Healthy'
            : d.smartStatus === 'Caution'
              ? 'Caution'
              : d.smartStatus === 'Bad'
                ? 'Bad'
                : 'Unknown'

        let diskType: DiskSmartInfo['type'] = 'Unknown'
        if (d.interfaceType === 'NVMe') diskType = 'NVMe'
        else if (d.type === 'SSD') diskType = 'SSD'
        else if (d.type === 'HD') diskType = 'HDD'

        // Match reliability data by device index (e.g. "\\.\PHYSICALDRIVE0" → "0")
        const deviceIndex = d.device.replace(/\D/g, '')
        const rel = reliabilityMap.get(deviceIndex)

        return {
          device: d.device,
          model: d.name,
          type: diskType,
          sizeBytes: d.size,
          temperature: rel?.temperature ?? d.temperature ?? null,
          healthStatus: smartStatus as DiskSmartInfo['healthStatus'],
          powerOnHours: rel?.powerOnHours ?? null,
          remainingLife: rel?.wear !== null && rel?.wear !== undefined ? 100 - rel.wear : null,
          readErrors: rel?.readErrors ?? null,
          writeErrors: rel?.writeErrors ?? null,
          reallocatedSectors: null,
          smartAttributes: []
        }
      })
    } catch {
      return []
    }
  }

  private async getStorageReliability(): Promise<
    Map<string, { temperature: number | null; powerOnHours: number | null; wear: number | null; readErrors: number | null; writeErrors: number | null }>
  > {
    const map = new Map<string, { temperature: number | null; powerOnHours: number | null; wear: number | null; readErrors: number | null; writeErrors: number | null }>()

    try {
      const script = 'Get-PhysicalDisk | ForEach-Object { $disk = $_; $rel = $_ | Get-StorageReliabilityCounter; [PSCustomObject]@{ DeviceId = $disk.DeviceId; Temperature = $rel.Temperature; PowerOnHours = $rel.PowerOnHours; ReadErrorsTotal = $rel.ReadErrorsTotal; WriteErrorsTotal = $rel.WriteErrorsTotal; Wear = $rel.Wear } } | ConvertTo-Json -Compress'
      const encoded = Buffer.from(script, 'utf16le').toString('base64')

      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
        timeout: 10000
      })

      const parsed = JSON.parse(stdout.trim())
      const entries = Array.isArray(parsed) ? parsed : [parsed]

      for (const entry of entries) {
        map.set(String(entry.DeviceId), {
          temperature: entry.Temperature ?? null,
          powerOnHours: entry.PowerOnHours ?? null,
          wear: entry.Wear ?? null,
          readErrors: entry.ReadErrorsTotal ?? null,
          writeErrors: entry.WriteErrorsTotal ?? null
        })
      }
    } catch {
      // Requires admin — return empty map, fall back to basic data
    }

    return map
  }

  /**
   * Spawn a persistent typeperf process on Windows to read the '% Processor Utility'
   * counter. This counter accounts for CPU frequency scaling (turbo boost) and matches
   * what Windows Task Manager displays. Falls back to si.currentLoad() if the counter
   * is unavailable (e.g. non-English locale or older Windows).
   */
  private startCpuUtilityMonitor(): void {
    if (process.platform !== 'win32') return

    // Reset state from any previous run so a stale exit handler can't interfere
    this.typeperfFailed = false
    this.typeperfBuffer = ''
    this.typeperfTotalIdx = -1
    this.typeperfCoreIndices = []
    this.latestCpuUtility = null

    try {
      const proc = spawn(
        'typeperf',
        ['\\Processor Information(*)\\% Processor Utility', '-si', '1'],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )

      this.typeperfProcess = proc

      proc.stdout!.on('data', (chunk: Buffer) => {
        this.typeperfBuffer += chunk.toString()
        const lines = this.typeperfBuffer.split('\n')
        // Keep the last (potentially incomplete) line in the buffer
        this.typeperfBuffer = lines.pop() || ''

        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line) continue

          if (this.typeperfTotalIdx === -1 && line.startsWith('"(PDH-CSV')) {
            // Header row — identify _Total and per-core column indices
            const cols = this.parseTypeperfCSV(line)
            for (let i = 1; i < cols.length; i++) {
              if (cols[i].includes('_Total')) {
                this.typeperfTotalIdx = i
              } else if (/\(\d+,\d+\)/.test(cols[i])) {
                // Per-logical-processor columns look like (0,0), (0,1), etc.
                this.typeperfCoreIndices.push(i)
              }
            }
          } else if (this.typeperfTotalIdx > 0 && line.startsWith('"')) {
            // Data row
            const values = this.parseTypeperfCSV(line)
            if (values.length > this.typeperfTotalIdx) {
              const overall = parseFloat(values[this.typeperfTotalIdx])
              const perCore: number[] = []
              for (const idx of this.typeperfCoreIndices) {
                if (idx < values.length) {
                  const val = parseFloat(values[idx])
                  if (!isNaN(val)) perCore.push(Math.max(0, Math.min(100, val)))
                }
              }
              if (!isNaN(overall)) {
                this.latestCpuUtility = {
                  overall: Math.max(0, Math.min(100, overall)),
                  perCore
                }
              }
            }
          }
        }
      })

      // Scope handlers to this specific process instance so that a stale
      // exit/error from a previous run cannot poison a newly spawned one.
      proc.on('error', () => {
        if (this.typeperfProcess === proc) {
          this.typeperfFailed = true
        }
      })

      proc.on('exit', () => {
        if (this.typeperfProcess === proc) {
          // Always fall back — even if we had data before, it is now stale
          this.typeperfFailed = true
          this.typeperfProcess = null
        }
      })
    } catch {
      this.typeperfFailed = true
    }
  }

  private stopCpuUtilityMonitor(): void {
    if (this.typeperfProcess) {
      this.typeperfProcess.kill()
      this.typeperfProcess = null
    }
    this.latestCpuUtility = null
    this.typeperfFailed = false
    this.typeperfBuffer = ''
    this.typeperfTotalIdx = -1
    this.typeperfCoreIndices = []
  }

  /** Parse a CSV line from typeperf (double-quote delimited fields). */
  private parseTypeperfCSV(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    result.push(current.trim())
    return result
  }

  private async collectSnapshot(): Promise<void> {
    if (!this.sender || this.sender.isDestroyed()) {
      this.stopMonitoring()
      return
    }
    if (this.snapshotRunning) return
    this.snapshotRunning = true

    try {
      // On Windows, prefer the utility counter from typeperf (matches Task Manager).
      // Skip the si.currentLoad() call entirely when utility data is available.
      const hasUtility = process.platform === 'win32' && !this.typeperfFailed && this.latestCpuUtility

      const [load, mem, disk, net] = await Promise.all([
        hasUtility ? Promise.resolve(null) : si.currentLoad(),
        si.mem(),
        si.disksIO(),
        si.networkStats()
      ])

      const cpuData = hasUtility
        ? this.latestCpuUtility!
        : { overall: load!.currentLoad, perCore: load!.cpus.map((c) => c.load) }

      const snapshot: PerfSnapshot = {
        timestamp: Date.now(),
        cpu: cpuData,
        memory: {
          usedBytes: mem.active,
          totalBytes: mem.total,
          cachedBytes: mem.cached,
          percent: (mem.active / mem.total) * 100
        },
        disk: {
          readBytesPerSec: disk?.rIO_sec ?? 0,
          writeBytesPerSec: disk?.wIO_sec ?? 0
        },
        network: {
          rxBytesPerSec: net.reduce((sum, n) => sum + n.rx_sec, 0),
          txBytesPerSec: net.reduce((sum, n) => sum + n.tx_sec, 0)
        },
        uptime: si.time().uptime
      }

      if (!this.sender.isDestroyed()) {
        this.sender.send(IPC.PERF_SNAPSHOT, snapshot)
      }
    } catch {
      // Silently skip failed ticks
    } finally {
      this.snapshotRunning = false
    }
  }

  private async collectProcesses(): Promise<void> {
    if (!this.sender || this.sender.isDestroyed()) {
      this.stopMonitoring()
      return
    }
    if (this.processesRunning) return
    this.processesRunning = true

    try {
      const [data, mem] = await Promise.all([si.processes(), si.mem()])
      const totalMem = mem.total

      // Sort by CPU + memory and take top 100
      const sorted = data.list
        .sort((a, b) => b.cpu + b.memRss - (a.cpu + a.memRss))
        .slice(0, 100)

      const processes: PerfProcess[] = sorted.map((p) => {
        const exeName = (p.name || '').toLowerCase()
        const startupName = this.startupExeMap.get(
          exeName.endsWith('.exe') ? exeName : `${exeName}.exe`
        )

        return {
          pid: p.pid,
          name: p.name,
          cpuPercent: p.cpu,
          memBytes: p.memRss,
          memPercent: totalMem > 0 ? (p.memRss / totalMem) * 100 : 0,
          user: p.user || '',
          started: p.started || '',
          isStartupItem: !!startupName,
          startupItemName: startupName
        }
      })

      const result: PerfProcessList = {
        timestamp: Date.now(),
        processes,
        totalCount: data.all
      }

      if (!this.sender.isDestroyed()) {
        this.sender.send(IPC.PERF_PROCESS_LIST, result)
      }
    } catch {
      // Silently skip failed ticks
    } finally {
      this.processesRunning = false
    }
  }
}
