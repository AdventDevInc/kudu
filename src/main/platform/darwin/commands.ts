import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformCommands, EventLogEntry, InstalledApp, OsUpdateInfo, OsUpdateInstallResult, SfcResult, DismResult, DnsEntry } from '../types'

const execFileAsync = promisify(execFile)

export function createDarwinCommands(): PlatformCommands {
  return {
    async shutdown(delaySec: number): Promise<void> {
      // macOS shutdown uses minutes, not seconds
      const delayMin = Math.max(0, Math.ceil(delaySec / 60))
      if (delayMin === 0) {
        await execFileAsync('/sbin/shutdown', ['-h', 'now'])
      } else {
        await execFileAsync('/sbin/shutdown', ['-h', `+${delayMin}`])
      }
    },

    async restart(delaySec: number): Promise<void> {
      const delayMin = Math.max(0, Math.ceil(delaySec / 60))
      if (delayMin === 0) {
        await execFileAsync('/sbin/shutdown', ['-r', 'now'])
      } else {
        await execFileAsync('/sbin/shutdown', ['-r', `+${delayMin}`])
      }
    },

    async getDnsServers(): Promise<DnsEntry[]> {
      try {
        const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--dns'], { timeout: 10_000 })
        const entries: DnsEntry[] = []
        let currentResolver: string | null = null
        const servers: string[] = []

        for (const line of stdout.split('\n')) {
          const resolverMatch = line.match(/^resolver #(\d+)/)
          if (resolverMatch) {
            if (currentResolver && servers.length > 0) {
              entries.push({ iface: `resolver ${currentResolver}`, servers: [...servers] })
              servers.length = 0
            }
            currentResolver = resolverMatch[1]
          }
          const nsMatch = line.match(/nameserver\[\d+\]\s*:\s*(.+)/)
          if (nsMatch) {
            servers.push(nsMatch[1].trim())
          }
        }
        if (currentResolver && servers.length > 0) {
          entries.push({ iface: `resolver ${currentResolver}`, servers })
        }
        return entries
      } catch {
        return []
      }
    },

    async getEventLog(logName: string, maxEntries: number): Promise<EventLogEntry[]> {
      try {
        // Map Windows-style log names to macOS log predicates
        const predicateMap: Record<string, string> = {
          System: 'subsystem BEGINSWITH "com.apple" AND messageType >= 16',    // error+fault from Apple subsystems
          Application: 'subsystem != "" AND NOT subsystem BEGINSWITH "com.apple"', // third-party subsystems
          Security: 'subsystem == "com.apple.securityd" OR subsystem == "com.apple.authd" OR subsystem == "com.apple.Authorization"',
        }
        // Sanitize logName — only allow known keys to prevent predicate injection
        const predicate = predicateMap[logName] ?? predicateMap.System

        const { stdout } = await execFileAsync('/usr/bin/log', [
          'show', '--style', 'json', '--last', '1h',
          '--predicate', predicate,
        ], { timeout: 30_000 })

        const entries: EventLogEntry[] = []
        try {
          const logs = JSON.parse(stdout)
          for (const entry of (Array.isArray(logs) ? logs : []).slice(0, maxEntries)) {
            entries.push({
              time: entry.timestamp ?? '',
              eventId: 0,
              level: entry.messageType ?? 'Default',
              provider: entry.subsystem ?? '',
              message: (entry.eventMessage ?? '').slice(0, 200),
            })
          }
        } catch {
          // JSON parse may fail for large outputs
        }
        return entries
      } catch {
        return []
      }
    },

    async getInstalledApps(): Promise<InstalledApp[]> {
      try {
        const { stdout } = await execFileAsync('/usr/sbin/system_profiler', [
          'SPApplicationsDataType', '-json',
        ], { timeout: 60_000 })

        const data = JSON.parse(stdout)
        const apps: Array<{ _name: string; version: string; obtained_from: string; lastModified: string; path?: string }> =
          data?.SPApplicationsDataType ?? []

        const filtered = apps.filter((a) => a.obtained_from !== 'apple')

        // Calculate sizes from .app bundle paths using du -sk
        const sizeMap = new Map<string, number>()
        const paths = filtered.map((a) => a.path).filter((p): p is string => !!p)

        if (paths.length > 0) {
          const BATCH = 50
          for (let i = 0; i < paths.length; i += BATCH) {
            const batch = paths.slice(i, i + BATCH)
            try {
              const { stdout: duOut } = await execFileAsync('/usr/bin/du', ['-sk', ...batch], { timeout: 30_000 })
              for (const line of duOut.split('\n')) {
                const tab = line.indexOf('\t')
                if (tab !== -1) {
                  sizeMap.set(line.substring(tab + 1), parseInt(line.substring(0, tab), 10) || 0)
                }
              }
            } catch (err: unknown) {
              // du may exit non-zero on permission errors but still output valid sizes
              const duOut = (err as { stdout?: string })?.stdout
              if (duOut) {
                for (const line of duOut.split('\n')) {
                  const tab = line.indexOf('\t')
                  if (tab !== -1) {
                    sizeMap.set(line.substring(tab + 1), parseInt(line.substring(0, tab), 10) || 0)
                  }
                }
              }
            }
          }
        }

        return filtered.map((a) => ({
          name: a._name ?? '',
          version: a.version ?? '',
          publisher: a.obtained_from ?? '',
          installDate: a.lastModified ?? '',
          sizeKb: a.path ? (sizeMap.get(a.path) ?? 0) : 0,
        }))
      } catch {
        return []
      }
    },

    async checkOsUpdates(): Promise<OsUpdateInfo[]> {
      try {
        const { stdout } = await execFileAsync('/usr/sbin/softwareupdate', ['-l'], { timeout: 120_000 })
        const updates: OsUpdateInfo[] = []
        const lines = stdout.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const labelMatch = lines[i].match(/^\s+\*\s+Label:\s+(.+)/)
          if (labelMatch) {
            const title = labelMatch[1].trim()
            // Next line usually has size info
            const sizeLine = lines[i + 1] ?? ''
            const sizeMatch = sizeLine.match(/Size:\s+([\d.]+)([KMG]?)/)
            let sizeBytes = 0
            if (sizeMatch) {
              const val = parseFloat(sizeMatch[1])
              const unit = sizeMatch[2]
              if (unit === 'G') sizeBytes = val * 1024 * 1024 * 1024
              else if (unit === 'M') sizeBytes = val * 1024 * 1024
              else if (unit === 'K') sizeBytes = val * 1024
              else sizeBytes = val
            }
            updates.push({
              title,
              kb: '',
              severity: 'Unspecified',
              sizeBytes,
              downloaded: false,
            })
          }
        }
        return updates
      } catch {
        return []
      }
    },

    async installOsUpdates(): Promise<OsUpdateInstallResult> {
      try {
        const { stdout } = await execFileAsync('/usr/sbin/softwareupdate', ['-i', '-a'], { timeout: 300_000 })
        const needsReboot = stdout.includes('restart')
        return { installed: 1, resultCode: 0, needsReboot }
      } catch {
        return { installed: 0, resultCode: -1, needsReboot: false }
      }
    },

    async runSystemFileCheck(): Promise<SfcResult | null> {
      // No equivalent on macOS
      return null
    },

    async runSystemImageRepair(): Promise<DismResult | null> {
      // No equivalent on macOS
      return null
    },
  }
}
