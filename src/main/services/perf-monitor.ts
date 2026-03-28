import * as si from 'systeminformation'
import * as os from 'os'
import { execFile } from 'child_process'
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
import { psUtf8 } from './exec-utf8'

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
  // Cache expensive si.networkStats() — poll every 5s, reuse in between
  private cachedNetworkStats = { rxBytesPerSec: 0, txBytesPerSec: 0 }
  private lastNetworkPoll = 0
  private readonly NETWORK_POLL_INTERVAL_MS = 5000

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

      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psUtf8(script)], {
        timeout: 10000, windowsHide: true
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

  private async collectSnapshot(): Promise<void> {
    if (!this.sender || this.sender.isDestroyed()) {
      this.stopMonitoring()
      return
    }
    if (this.snapshotRunning) return
    this.snapshotRunning = true

    try {
      // Only poll si.networkStats() every 5s — it costs ~320ms per call.
      const now = Date.now()
      const needsNetworkPoll = now - this.lastNetworkPoll >= this.NETWORK_POLL_INTERVAL_MS

      // On Windows, si.mem() costs ~290ms per call — use os.totalmem()/os.freemem()
      // instead (identical values, near-zero cost). On Linux/macOS, si.mem() is cheap
      // (reads /proc/meminfo or vm_stat) and os.freemem() excludes buffers/cache,
      // so we must keep si.mem() to avoid overstating memory pressure.
      const isWindows = process.platform === 'win32'

      const [load, disk, net, mem] = await Promise.all([
        si.currentLoad(),
        si.disksIO(),
        needsNetworkPoll ? si.networkStats() : Promise.resolve(null),
        isWindows ? Promise.resolve(null) : si.mem()
      ])

      if (net) {
        this.cachedNetworkStats = {
          rxBytesPerSec: net.reduce((sum, n) => sum + n.rx_sec, 0),
          txBytesPerSec: net.reduce((sum, n) => sum + n.tx_sec, 0)
        }
        this.lastNetworkPoll = now
      }

      let usedMem: number, totalMem: number, cachedMem: number
      if (isWindows) {
        totalMem = os.totalmem()
        usedMem = totalMem - os.freemem()
        cachedMem = 0
      } else if (process.platform === 'darwin') {
        totalMem = mem!.total
        // mem.active includes file-backed/reclaimable pages and vastly overstates
        // real pressure on macOS.  (total − available) matches Activity Monitor.
        usedMem = totalMem - mem!.available
        cachedMem = mem!.cached
      } else {
        usedMem = mem!.active
        totalMem = mem!.total
        cachedMem = mem!.cached
      }

      const snapshot: PerfSnapshot = {
        timestamp: Date.now(),
        cpu: {
          overall: load.currentLoad,
          perCore: load.cpus.map((c) => c.load)
        },
        memory: {
          usedBytes: usedMem,
          totalBytes: totalMem,
          cachedBytes: cachedMem,
          percent: (usedMem / totalMem) * 100
        },
        disk: {
          readBytesPerSec: disk?.rIO_sec ?? 0,
          writeBytesPerSec: disk?.wIO_sec ?? 0
        },
        network: this.cachedNetworkStats,
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
