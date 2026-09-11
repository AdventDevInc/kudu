import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import type {
  PlatformCommands,
  EventLogEntry,
  InstalledApp,
  OsUpdateInfo,
  OsUpdateInstallResult,
  SfcResult,
  DismResult,
  DnsEntry
} from '../types'

const execFileAsync = promisify(execFile)

/** Detect which package manager is available by trying known paths */
async function detectPackageManager(): Promise<'apt' | 'dnf' | 'pacman' | null> {
  const candidates: Array<{ name: 'apt' | 'dnf' | 'pacman'; paths: string[] }> = [
    { name: 'apt', paths: ['/usr/bin/apt', '/bin/apt'] },
    { name: 'dnf', paths: ['/usr/bin/dnf', '/bin/dnf'] },
    { name: 'pacman', paths: ['/usr/bin/pacman', '/bin/pacman'] }
  ]
  for (const { name, paths } of candidates) {
    for (const path of paths) {
      try {
        await execFileAsync(path, ['--version'], { timeout: 3_000 })
        return name
      } catch {
        /* not found or failed */
      }
    }
  }
  return null
}

export function createLinuxCommands(): PlatformCommands {
  return {
    async shutdown(delaySec: number): Promise<void> {
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
      // Try resolvectl first
      try {
        const { stdout } = await execFileAsync('/usr/bin/resolvectl', ['dns'], { timeout: 5_000 })
        const entries: DnsEntry[] = []
        for (const line of stdout.split('\n')) {
          const match = line.match(/^Link\s+\d+\s+\((\w+)\):\s+(.+)/)
          if (match) {
            entries.push({ iface: match[1], servers: match[2].trim().split(/\s+/) })
          }
        }
        if (entries.length > 0) return entries
      } catch {
        /* fallback to resolv.conf */
      }

      // Parse /etc/resolv.conf
      try {
        const content = await readFile('/etc/resolv.conf', 'utf-8')
        const servers: string[] = []
        for (const line of content.split('\n')) {
          const match = line.match(/^nameserver\s+(.+)/)
          if (match) servers.push(match[1].trim())
        }
        if (servers.length > 0) return [{ iface: 'system', servers }]
      } catch {
        /* ignore */
      }

      return []
    },

    async getEventLog(_logName: string, maxEntries: number): Promise<EventLogEntry[]> {
      try {
        const { stdout } = await execFileAsync(
          '/usr/bin/journalctl',
          ['--no-pager', '-n', String(maxEntries), '--output', 'json'],
          { timeout: 30_000 }
        )

        const entries: EventLogEntry[] = []
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            entries.push({
              time: entry.__REALTIME_TIMESTAMP
                ? new Date(parseInt(entry.__REALTIME_TIMESTAMP, 10) / 1000).toISOString()
                : '',
              eventId: 0,
              level: priorityToLevel(entry.PRIORITY),
              provider: entry.SYSLOG_IDENTIFIER ?? entry._COMM ?? '',
              message: (entry.MESSAGE ?? '').slice(0, 200)
            })
          } catch {
            /* skip unparseable lines */
          }
        }
        return entries
      } catch {
        return []
      }
    },

    async getInstalledApps(): Promise<InstalledApp[]> {
      const pm = await detectPackageManager()
      if (!pm) return []

      try {
        if (pm === 'apt') {
          const { stdout } = await execFileAsync(
            '/usr/bin/dpkg-query',
            ['-W', '-f', '${Package}\t${Version}\t${Installed-Size}\n'],
            { timeout: 30_000 }
          )

          return stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [name, version, sizeStr] = line.split('\t')
              return {
                name,
                version: version ?? '',
                publisher: '',
                installDate: '',
                sizeKb: parseInt(sizeStr, 10) || 0
              }
            })
        }

        if (pm === 'dnf') {
          const { stdout } = await execFileAsync(
            '/usr/bin/rpm',
            ['-qa', '--queryformat', '%{NAME}\t%{VERSION}-%{RELEASE}\t%{SIZE}\n'],
            { timeout: 30_000 }
          )
          return stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [name, version, sizeStr] = line.split('\t')
              return {
                name,
                version: version ?? '',
                publisher: '',
                installDate: '',
                sizeKb: Math.round((parseInt(sizeStr, 10) || 0) / 1024)
              }
            })
        }

        if (pm === 'pacman') {
          const { stdout } = await execFileAsync('/usr/bin/pacman', ['-Q'], { timeout: 30_000 })
          return stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [name, version] = line.split(' ')
              return { name, version: version ?? '', publisher: '', installDate: '', sizeKb: 0 }
            })
        }
      } catch {
        /* ignore */
      }

      return []
    },

    async checkOsUpdates(): Promise<OsUpdateInfo[]> {
      const pm = await detectPackageManager()
      if (!pm) return []

      try {
        if (pm === 'apt') {
          // apt-get update requires root; skip refresh if non-root and use stale cache
          try {
            await execFileAsync('/usr/bin/apt-get', ['update', '-qq'], { timeout: 60_000 })
          } catch {
            /* non-root: use existing package cache */
          }
          const { stdout } = await execFileAsync('/usr/bin/apt', ['list', '--upgradable'], {
            timeout: 30_000
          })
          return stdout
            .trim()
            .split('\n')
            .slice(1)
            .filter(Boolean)
            .map((line) => {
              const match = line.match(/^(\S+)\/\S+\s+(\S+)/)
              return {
                title: match?.[1] ?? line,
                kb: '',
                severity: 'Unspecified',
                sizeBytes: 0,
                downloaded: false
              }
            })
        }

        if (pm === 'dnf') {
          // dnf check-update exits 100 when updates are available, which causes execFile to reject.
          // The error object from child_process includes stdout/stderr as properties.
          let dnfOutput = ''
          try {
            const result = await execFileAsync('/usr/bin/dnf', ['check-update', '-q'], {
              timeout: 60_000
            })
            dnfOutput = result.stdout
          } catch (err: any) {
            dnfOutput = err?.stdout ?? ''
          }
          const lines = dnfOutput
            .trim()
            .split('\n')
            .filter((l: string) => l.trim() && !l.startsWith('Last'))
          return lines.map((line) => ({
            title: line.split(/\s+/)[0] ?? line,
            kb: '',
            severity: 'Unspecified',
            sizeBytes: 0,
            downloaded: false
          }))
        }

        if (pm === 'pacman') {
          const { stdout } = await execFileAsync('/usr/bin/pacman', ['-Qu'], { timeout: 30_000 })
          return stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => ({
              title: line.split(' ')[0] ?? line,
              kb: '',
              severity: 'Unspecified',
              sizeBytes: 0,
              downloaded: false
            }))
        }
      } catch {
        /* ignore */
      }

      return []
    },

    async installOsUpdates(): Promise<OsUpdateInstallResult> {
      const pm = await detectPackageManager()
      if (!pm) return { installed: 0, resultCode: -1, needsReboot: false }

      try {
        if (pm === 'apt') {
          await execFileAsync('/usr/bin/apt-get', ['upgrade', '-y', '-qq'], { timeout: 300_000 })
          return { installed: 1, resultCode: 0, needsReboot: false }
        }
        if (pm === 'dnf') {
          await execFileAsync('/usr/bin/dnf', ['upgrade', '-y', '-q'], { timeout: 300_000 })
          return { installed: 1, resultCode: 0, needsReboot: false }
        }
        if (pm === 'pacman') {
          await execFileAsync('/usr/bin/pacman', ['-Syu', '--noconfirm'], { timeout: 300_000 })
          return { installed: 1, resultCode: 0, needsReboot: false }
        }
      } catch {
        return { installed: 0, resultCode: -1, needsReboot: false }
      }

      return { installed: 0, resultCode: -1, needsReboot: false }
    },

    async runSystemFileCheck(): Promise<SfcResult | null> {
      const pm = await detectPackageManager()
      if (!pm) return null

      try {
        if (pm === 'apt') {
          await execFileAsync('/usr/bin/apt-get', ['clean'], { timeout: 60_000 })
          return { exitCode: 0, status: 'clean' }
        }
        if (pm === 'dnf') {
          await execFileAsync('/usr/bin/dnf', ['clean', 'all'], { timeout: 60_000 })
          return { exitCode: 0, status: 'clean' }
        }
        if (pm === 'pacman') {
          await execFileAsync('/usr/bin/pacman', ['-Scc', '--noconfirm'], { timeout: 60_000 })
          return { exitCode: 0, status: 'clean' }
        }
      } catch {
        return { exitCode: -1, status: 'failed' }
      }
      return null
    },

    async runSystemImageRepair(): Promise<DismResult | null> {
      const pm = await detectPackageManager()
      if (!pm) return null

      try {
        if (pm === 'apt') {
          await execFileAsync('/usr/bin/apt-get', ['autoremove', '-y', '-qq'], { timeout: 120_000 })
          return { exitCode: 0, status: 'success' }
        }
        if (pm === 'dnf') {
          await execFileAsync('/usr/bin/dnf', ['autoremove', '-y', '-q'], { timeout: 120_000 })
          return { exitCode: 0, status: 'success' }
        }
        if (pm === 'pacman') {
          let orphans: string[] = []
          try {
            const { stdout } = await execFileAsync('/usr/bin/pacman', ['-Qdtq'], {
              timeout: 10_000
            })
            orphans = stdout.trim().split('\n').filter(Boolean)
          } catch {
            // pacman -Qdtq exits non-zero when no orphans exist
            return { exitCode: 0, status: 'clean' }
          }
          if (orphans.length === 0) return { exitCode: 0, status: 'clean' }
          await execFileAsync('/usr/bin/pacman', ['-Rns', '--noconfirm', ...orphans], {
            timeout: 120_000
          })
          return { exitCode: 0, status: 'success' }
        }
      } catch {
        return { exitCode: -1, status: 'failed' }
      }
      return null
    }
  }
}

function priorityToLevel(priority: string | number | undefined): string {
  const p = typeof priority === 'string' ? parseInt(priority, 10) : (priority ?? 6)
  if (p <= 2) return 'Critical'
  if (p === 3) return 'Error'
  if (p === 4) return 'Warning'
  if (p <= 6) return 'Information'
  return 'Debug'
}
