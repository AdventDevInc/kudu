import * as si from 'systeminformation'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../shared/channels'
import type {
  PerfSystemInfo,
  PerfSnapshot,
  PerfProcessList,
  PerfKillResult,
  DiskSmartInfo,
  StartupItem
} from '../../shared/types'
import { psUtf8 } from './exec-utf8'
import { collectWindowsMemory } from './perf-memory'
import { mapPerfProcesses } from './perf-processes'
import { PosixProcessSampler, getPosixProcessIdentity } from './perf-posix-processes'

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
  private generation = 0
  private posixProcesses = new PosixProcessSampler()

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
    this.generation++
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

  async getProcessIdentity(pid: number): Promise<{ name: string; birthToken: string } | null> {
    try {
      if (!Number.isInteger(pid) || pid <= 0) return null
      if (process.platform === 'win32') {
        // Bypass systeminformation's process cache before a destructive action.
        const { stdout } = await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            psUtf8(
              `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object @{n="name";e={$_.Name}},@{n="birthToken";e={$_.CreationDate.ToString("yyyy-MM-dd HH:mm:ss")}} | ConvertTo-Json -Compress`
            )
          ],
          { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 }
        )
        const identity = JSON.parse(stdout.trim())
        return typeof identity?.name === 'string' && typeof identity?.birthToken === 'string'
          ? identity
          : null
      }
      return getPosixProcessIdentity(pid)
    } catch {
      return null
    }
  }

  async killProcess(pid: number, expectedBirthToken?: string): Promise<PerfKillResult> {
    try {
      process.kill(pid)
      return { success: true }
    } catch {
      // A failed first attempt may mean the selected process has exited. Never
      // let the command fallback target a replacement process with the same PID.
      if (expectedBirthToken) {
        const identity = await this.getProcessIdentity(pid)
        if (!identity || identity.birthToken !== expectedBirthToken) {
          return {
            success: false,
            error: 'Process changed or cannot be verified. Refresh and try again.'
          }
        }
      }
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
        const requiresAdmin =
          message.includes('Access') ||
          message.includes('denied') ||
          message.includes('Operation not permitted')
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
    Map<
      string,
      {
        temperature: number | null
        powerOnHours: number | null
        wear: number | null
        readErrors: number | null
        writeErrors: number | null
      }
    >
  > {
    const map = new Map<
      string,
      {
        temperature: number | null
        powerOnHours: number | null
        wear: number | null
        readErrors: number | null
        writeErrors: number | null
      }
    >()

    try {
      const script =
        'Get-PhysicalDisk | ForEach-Object { $disk = $_; $rel = $_ | Get-StorageReliabilityCounter; [PSCustomObject]@{ DeviceId = $disk.DeviceId; Temperature = $rel.Temperature; PowerOnHours = $rel.PowerOnHours; ReadErrorsTotal = $rel.ReadErrorsTotal; WriteErrorsTotal = $rel.WriteErrorsTotal; Wear = $rel.Wear } } | ConvertTo-Json -Compress'

      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-Command', psUtf8(script)],
        {
          timeout: 10000,
          windowsHide: true
        }
      )

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
    const sender = this.sender
    const generation = this.generation

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
          availableBytes: isWindows ? os.freemem() : mem!.available,
          percent: (usedMem / totalMem) * 100
        },
        disk: {
          readBytesPerSec: disk?.rIO_sec ?? 0,
          writeBytesPerSec: disk?.wIO_sec ?? 0
        },
        network: this.cachedNetworkStats,
        uptime: si.time().uptime
      }

      if (generation === this.generation && !sender.isDestroyed()) {
        sender.send(IPC.PERF_SNAPSHOT, snapshot)
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
    const sender = this.sender
    const generation = this.generation

    try {
      const windows = process.platform === 'win32'
      const [inventory, windowsMemory] = await Promise.all([
        windows
          ? si.processes().then((data) => ({
              processes: mapPerfProcesses(data.list, os.totalmem(), true, this.startupExeMap),
              totalCount: data.all
            }))
          : this.posixProcesses.collect(os.totalmem()),
        windows ? collectWindowsMemory() : Promise.resolve(undefined)
      ])
      // systeminformation can swallow provider failures into a resolved empty list.
      // A running Kudu host always has processes; do not erase a good sample.
      if (!inventory.processes.length) throw new Error('Process inventory unavailable')

      const result: PerfProcessList = {
        timestamp: Date.now(),
        processes: inventory.processes,
        totalCount: inventory.totalCount,
        windowsMemory
      }

      if (generation === this.generation && !sender.isDestroyed()) {
        sender.send(IPC.PERF_PROCESS_LIST, result)
      }
    } catch {
      if (generation === this.generation && !sender.isDestroyed()) {
        sender.send(IPC.PERF_PROCESS_LIST, {
          timestamp: Date.now(),
          processes: [],
          totalCount: 0,
          error: true
        } satisfies PerfProcessList)
      }
    } finally {
      this.processesRunning = false
    }
  }
}
