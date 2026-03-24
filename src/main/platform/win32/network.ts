import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PlatformNetwork, ActiveConnection, DnsCacheEntry, WifiProfile } from '../types'
import { psUtf8, execNativeUtf8 } from '../../services/exec-utf8'

const execFileAsync = promisify(execFile)

const LOOPBACK = new Set(['127.0.0.1', '::1', '0.0.0.0', '::'])

export function createWin32Network(): PlatformNetwork {
  return {
    async getEstablishedConnections(): Promise<ActiveConnection[]> {
      try {
        // Use native netstat instead of PowerShell — starts instantly, uses ~1MB
        // vs PowerShell's ~80MB and 2-5s startup. This runs every 30s.
        const { stdout } = await execFileAsync('netstat', [
          '-ano', '-p', 'tcp',
        ], { timeout: 15_000, windowsHide: true })

        const results: ActiveConnection[] = []
        for (const line of stdout.split('\n')) {
          // Lines look like: "  TCP    10.0.0.5:45678     93.184.216.34:443  ESTABLISHED     1234"
          const trimmed = line.trim()
          if (!trimmed.startsWith('TCP')) continue
          if (!trimmed.includes('ESTABLISHED')) continue

          const cols = trimmed.split(/\s+/)
          // cols: [TCP, localAddr, foreignAddr, ESTABLISHED, PID]
          if (cols.length < 5) continue

          const local = cols[1]
          const foreign = cols[2]
          const pidStr = cols[4]

          // Parse local port
          let localPort: number
          if (local.startsWith('[')) {
            const closeBracket = local.indexOf(']')
            if (closeBracket === -1) continue
            localPort = parseInt(local.slice(closeBracket + 2), 10)
          } else {
            const lastColon = local.lastIndexOf(':')
            if (lastColon === -1) continue
            localPort = parseInt(local.slice(lastColon + 1), 10)
          }
          if (isNaN(localPort)) continue

          // Parse foreign address — handle IPv6 bracket notation and plain IPv4
          let remoteAddress: string
          let remotePort: number

          if (foreign.startsWith('[')) {
            // IPv6: [addr]:port
            const closeBracket = foreign.indexOf(']')
            if (closeBracket === -1) continue
            remoteAddress = foreign.slice(1, closeBracket)
            remotePort = parseInt(foreign.slice(closeBracket + 2), 10)
          } else {
            // IPv4: addr:port
            const lastColon = foreign.lastIndexOf(':')
            if (lastColon === -1) continue
            remoteAddress = foreign.slice(0, lastColon)
            remotePort = parseInt(foreign.slice(lastColon + 1), 10)
          }

          if (isNaN(remotePort)) continue
          if (LOOPBACK.has(remoteAddress)) continue

          const pid = parseInt(pidStr, 10)
          results.push({ remoteAddress, remotePort, localPort, pid: isNaN(pid) ? null : pid })
        }

        return results
      } catch {
        return []
      }
    },

    async getListeningPorts(): Promise<number[]> {
      try {
        const { stdout } = await execFileAsync('netstat', [
          '-ano', '-p', 'tcp',
        ], { timeout: 15_000, windowsHide: true })

        const ports: number[] = []
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('TCP')) continue
          if (!trimmed.includes('LISTENING')) continue

          const cols = trimmed.split(/\s+/)
          if (cols.length < 4) continue

          const local = cols[1]
          let port: number
          if (local.startsWith('[')) {
            const closeBracket = local.indexOf(']')
            if (closeBracket === -1) continue
            port = parseInt(local.slice(closeBracket + 2), 10)
          } else {
            const lastColon = local.lastIndexOf(':')
            if (lastColon === -1) continue
            port = parseInt(local.slice(lastColon + 1), 10)
          }
          if (!isNaN(port) && port > 0) ports.push(port)
        }

        return ports
      } catch {
        return []
      }
    },

    async getDnsCacheEntries(): Promise<DnsCacheEntry[]> {
      try {
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          psUtf8('Get-DnsClientCache | Select-Object Entry,Data | ConvertTo-Json -Compress'),
        ], { timeout: 15_000, windowsHide: true })

        const trimmed = stdout.trim()
        if (!trimmed) return []

        const raw = JSON.parse(trimmed)
        const items: Array<{ Entry: string; Data: string | null }> =
          Array.isArray(raw) ? raw : [raw]

        return items.map((e) => ({
          domain: e.Entry?.toLowerCase() ?? '',
          resolvedAddress: e.Data || null,
        }))
      } catch {
        return []
      }
    },

    async flushDnsCache(): Promise<boolean> {
      try {
        await execFileAsync('ipconfig', ['/flushdns'], { timeout: 10000, windowsHide: true })
        return true
      } catch {
        return false
      }
    },

    async getWifiProfiles(): Promise<WifiProfile[]> {
      try {
        const { stdout } = await execNativeUtf8('netsh', ['wlan', 'show', 'profiles'], { timeout: 10000 })
        const profiles: WifiProfile[] = []
        for (const line of stdout.split('\n')) {
          const match = line.match(/All User Profile\s*:\s*(.+)/i) || line.match(/User Profile\s*:\s*(.+)/i)
          if (match) {
            const name = match[1].trim()
            // Block quotes and control chars — shell metacharacters are handled
            // by cmdEscapeArg inside execNativeUtf8.
            if (/["\x00-\x1f]/.test(name)) continue
            let security = 'Unknown'
            try {
              const { stdout: detail } = await execNativeUtf8('netsh', ['wlan', 'show', 'profile', `name=${name}`], { timeout: 5000 })
              const authMatch = detail.match(/Authentication\s*:\s*(.+)/i)
              if (authMatch) security = authMatch[1].trim()
            } catch { /* skip */ }
            profiles.push({ name, security })
          }
        }
        return profiles
      } catch {
        return []
      }
    },

    async deleteWifiProfile(name: string): Promise<boolean> {
      try {
        if (/["\x00-\x1f]/.test(name)) return false
        await execNativeUtf8('netsh', ['wlan', 'delete', 'profile', `name=${name}`], { timeout: 10000 })
        return true
      } catch {
        return false
      }
    },

    async clearArpCache(): Promise<boolean> {
      try {
        await execNativeUtf8('netsh', ['interface', 'ip', 'delete', 'arpcache'], { timeout: 10000 })
        return true
      } catch {
        return false
      }
    },
  }
}
