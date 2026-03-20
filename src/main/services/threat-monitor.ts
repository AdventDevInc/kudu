import { getPlatform } from '../platform'
import { loadBlacklist } from './threat-blacklist-store'
import { logInfo, logError } from './logger'
import type { ThreatBlacklist, FlaggedConnection, FlaggedDnsEntry, ThreatSnapshot } from './cloud-agent-types'

const CONNECTION_INTERVAL_MS = 30_000
const DNS_INTERVAL_MS = 60_000
const MAX_ACCUMULATED = 500
const SEEN_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours
const SEEN_MAX_SIZE = 10_000

// ─── CIDR Matching Helpers ──────────────────────────────────

interface ParsedCidr {
  isV6: boolean
  // IPv4: stored as number; IPv6: stored as bigint
  address: number | bigint
  mask: number | bigint
  raw: string
}

export function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let num = 0
  for (const p of parts) {
    const n = parseInt(p, 10)
    if (isNaN(n) || n < 0 || n > 255) return null
    num = (num << 8) | n
  }
  return num >>> 0 // ensure unsigned
}

export function ipv6ToBigInt(ip: string): bigint | null {
  try {
    // Expand :: notation
    let expanded = ip.toLowerCase()

    // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
    const v4MappedMatch = expanded.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (v4MappedMatch) {
      const v4Num = ipv4ToNumber(v4MappedMatch[1])
      if (v4Num === null) return null
      return BigInt('0xffff00000000') | BigInt(v4Num)
    }

    const parts = expanded.split('::')
    if (parts.length > 2) return null

    let groups: string[]
    if (parts.length === 2) {
      const left = parts[0] ? parts[0].split(':') : []
      const right = parts[1] ? parts[1].split(':') : []
      const missing = 8 - left.length - right.length
      if (missing < 0) return null
      groups = [...left, ...Array(missing).fill('0'), ...right]
    } else {
      groups = expanded.split(':')
    }

    if (groups.length !== 8) return null

    let result = 0n
    for (const g of groups) {
      const val = parseInt(g, 16)
      if (isNaN(val) || val < 0 || val > 0xffff) return null
      result = (result << 16n) | BigInt(val)
    }
    return result
  } catch {
    return null
  }
}

export function parseCidr(cidr: string): ParsedCidr | null {
  const slashIdx = cidr.indexOf('/')
  if (slashIdx === -1) return null

  const ip = cidr.slice(0, slashIdx)
  const prefixLen = parseInt(cidr.slice(slashIdx + 1), 10)
  if (isNaN(prefixLen)) return null

  // Try IPv4
  const v4Num = ipv4ToNumber(ip)
  if (v4Num !== null) {
    if (prefixLen < 0 || prefixLen > 32) return null
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0
    return { isV6: false, address: (v4Num & mask) >>> 0, mask, raw: cidr }
  }

  // Try IPv6
  const v6Num = ipv6ToBigInt(ip)
  if (v6Num !== null) {
    if (prefixLen < 0 || prefixLen > 128) return null
    const mask = prefixLen === 0 ? 0n : ((1n << 128n) - 1n) << BigInt(128 - prefixLen)
    return { isV6: true, address: v6Num & mask, mask, raw: cidr }
  }

  return null
}

export function ipMatchesCidr(ip: string, cidr: ParsedCidr): boolean {
  if (cidr.isV6) {
    const v6 = ipv6ToBigInt(ip)
    if (v6 === null) return false
    return (v6 & (cidr.mask as bigint)) === (cidr.address as bigint)
  } else {
    const v4 = ipv4ToNumber(ip)
    if (v4 === null) return false
    return ((v4 & (cidr.mask as number)) >>> 0) === (cidr.address as number)
  }
}

// ─── Threat Monitor Service ─────────────────────────────────

export type ThreatCallback = (snapshot: ThreatSnapshot) => void

class ThreatMonitorService {
  private connectionTimer: ReturnType<typeof setInterval> | null = null
  private dnsTimer: ReturnType<typeof setInterval> | null = null

  // Guards to prevent overlapping scans (PowerShell can be slow)
  private connectionScanRunning = false
  private dnsScanRunning = false

  // Blacklist and precomputed lookup structures
  private blacklist: ThreatBlacklist | null = null
  private ipSet: Set<string> = new Set()
  private domainSet: Set<string> = new Set()
  private parsedCidrs: ParsedCidr[] = []

  // Accumulated flagged items between telemetry sends
  private flaggedConnections: FlaggedConnection[] = []
  private flaggedDns: FlaggedDnsEntry[] = []
  private lastConnectionScanAt: string | null = null
  private lastDnsScanAt: string | null = null

  // Dedup maps to avoid repeated alerts for the same connection/domain (with TTL)
  private seenConnections: Map<string, number> = new Map()
  private seenDomains: Map<string, number> = new Map()

  // When true, only outbound connections are checked (inbound to listening ports are skipped)
  private isServerMode = false

  // Guards against start()/reloadBlacklist() resurrecting timers after stop() is called
  // while the async isServer() call is in flight
  private stopped = true

  // Callback fired immediately when new threats are detected
  private onThreatDetected: ThreatCallback | null = null

  /** Register a callback to fire immediately when new threats are found */
  setThreatCallback(cb: ThreatCallback | null): void {
    this.onThreatDetected = cb
  }

  async start(): Promise<void> {
    this.stopped = false
    this.loadAndBuildLookups()

    if (!this.blacklist) {
      logInfo('Threat monitor: no blacklist loaded, monitoring will start after blacklist update')
      return
    }

    // Start scanning immediately with current isServerMode (defaults to false, i.e.
    // flag everything). This avoids a multi-second blind window while isServer()
    // shells out to systemctl/loginctl on Linux.
    this.startTimers()

    // Detect server mode in the background; subsequent scans pick up the updated value.
    // Until this resolves, scans flag all connections — the safe direction (no missed threats).
    const serverMode = await getPlatform().security.isServer()
    if (this.stopped) return
    this.isServerMode = serverMode
    if (this.isServerMode) {
      logInfo('Threat monitor: server mode detected — only outbound connections will be flagged')
    }
  }

  stop(): void {
    this.stopped = true
    if (this.connectionTimer) { clearInterval(this.connectionTimer); this.connectionTimer = null }
    if (this.dnsTimer) { clearInterval(this.dnsTimer); this.dnsTimer = null }
    this.flaggedConnections = []
    this.flaggedDns = []
    this.seenConnections.clear()
    this.seenDomains.clear()
    this.lastConnectionScanAt = null
    this.lastDnsScanAt = null
  }

  async reloadBlacklist(): Promise<void> {
    const wasRunning = this.connectionTimer !== null
    if (wasRunning) {
      if (this.connectionTimer) { clearInterval(this.connectionTimer); this.connectionTimer = null }
      if (this.dnsTimer) { clearInterval(this.dnsTimer); this.dnsTimer = null }
    }

    this.loadAndBuildLookups()
    // Clear dedup sets so new blacklist entries can trigger alerts
    this.seenConnections.clear()
    this.seenDomains.clear()
    // Clear accumulated data from previous blacklist — stale rules should not be reported
    this.flaggedConnections = []
    this.flaggedDns = []

    if (this.blacklist) {
      logInfo(`Threat monitor: blacklist reloaded v${this.blacklist.version} (${this.blacklist.domains.length} domains, ${this.blacklist.ips.length} IPs, ${this.blacklist.cidrs.length} CIDRs)`)
      // Restart scanning immediately with the previous isServerMode value.
      // This avoids a blind window while isServer() re-probes.
      this.startTimers()
    }

    // Refresh server mode in the background; subsequent scans pick up the updated value
    const serverMode = await getPlatform().security.isServer()
    if (this.stopped) return
    this.isServerMode = serverMode
  }

  getThreatSnapshot(): ThreatSnapshot | null {
    if (!this.blacklist) return null
    return {
      flaggedConnections: [...this.flaggedConnections],
      flaggedDns: [...this.flaggedDns],
      blacklistVersion: this.blacklist.version,
      lastConnectionScanAt: this.lastConnectionScanAt,
      lastDnsScanAt: this.lastDnsScanAt,
    }
  }

  clearAccumulated(): void {
    this.flaggedConnections = []
    this.flaggedDns = []
    // Keep dedup sets — we don't want to re-alert for the same connection every telemetry cycle
  }

  // ─── Private ────────────────────────────────────────────

  private loadAndBuildLookups(): void {
    this.blacklist = loadBlacklist()
    this.ipSet.clear()
    this.domainSet.clear()
    this.parsedCidrs = []

    if (!this.blacklist) return

    for (const ip of this.blacklist.ips) {
      this.ipSet.add(ip.toLowerCase())
    }
    for (const domain of this.blacklist.domains) {
      this.domainSet.add(domain.toLowerCase())
    }
    for (const cidr of this.blacklist.cidrs) {
      const parsed = parseCidr(cidr)
      if (parsed) this.parsedCidrs.push(parsed)
    }
  }

  private startTimers(): void {
    // Prevent duplicate timers if called during reconnect/reload
    if (this.connectionTimer) { clearInterval(this.connectionTimer); this.connectionTimer = null }
    if (this.dnsTimer) { clearInterval(this.dnsTimer); this.dnsTimer = null }

    // Run first scans immediately
    this.scanConnections()
    this.scanDns()

    this.connectionTimer = setInterval(() => this.scanConnections(), CONNECTION_INTERVAL_MS)
    this.dnsTimer = setInterval(() => this.scanDns(), DNS_INTERVAL_MS)
  }

  private async scanConnections(): Promise<void> {
    if (this.connectionScanRunning) return
    this.connectionScanRunning = true
    try {
      const platform = getPlatform()
      const [connections, listeningPortsArr] = await Promise.all([
        platform.network.getEstablishedConnections(),
        this.isServerMode ? platform.network.getListeningPorts() : null,
      ])
      this.lastConnectionScanAt = new Date().toISOString()
      const newFlags: FlaggedConnection[] = []
      const now = Date.now()

      // In server mode, use listening ports to filter out inbound connections
      const listeningPorts = listeningPortsArr ? new Set(listeningPortsArr) : null

      this.evictExpired(this.seenConnections)

      for (const conn of connections) {
        if (this.flaggedConnections.length + newFlags.length >= MAX_ACCUMULATED) break

        // On servers, skip inbound connections: the local port matches a port we are
        // listening on, so this connection was accept()'d from a remote client.
        // The OS ephemeral port allocator never assigns a port that is already bound
        // in LISTEN state, so localPort ∈ listeningPorts reliably identifies inbound
        // traffic without fragile remote-port-range heuristics.
        if (listeningPorts && listeningPorts.has(conn.localPort)) continue

        const dedupKey = `${conn.remoteAddress}:${conn.remotePort}`
        if (this.seenConnections.has(dedupKey)) continue

        const match = this.matchIp(conn.remoteAddress)
        if (match) {
          this.seenConnections.set(dedupKey, now)
          newFlags.push({
            remoteAddress: conn.remoteAddress,
            remotePort: conn.remotePort,
            pid: conn.pid,
            matchedRule: match.rule,
            matchType: match.type,
            detectedAt: new Date().toISOString(),
          })
        }
      }

      if (newFlags.length > 0) {
        this.flaggedConnections.push(...newFlags)
        this.fireCallback(newFlags, [])
      }
    } catch (err) {
      logError(`Threat monitor connection scan error: ${err instanceof Error ? err.message : err}`)
    } finally {
      this.connectionScanRunning = false
    }
  }

  private async scanDns(): Promise<void> {
    if (this.dnsScanRunning) return
    this.dnsScanRunning = true
    try {
      const entries = await getPlatform().network.getDnsCacheEntries()
      this.lastDnsScanAt = new Date().toISOString()
      const newFlags: FlaggedDnsEntry[] = []
      const now = Date.now()

      this.evictExpired(this.seenDomains)

      for (const entry of entries) {
        if (this.flaggedDns.length + newFlags.length >= MAX_ACCUMULATED) break

        const domain = entry.domain.toLowerCase()
        if (this.seenDomains.has(domain)) continue

        // Check domain against domain blacklist
        if (this.domainSet.has(domain)) {
          this.seenDomains.set(domain, now)
          newFlags.push({
            domain: entry.domain,
            resolvedAddress: entry.resolvedAddress,
            matchedRule: domain,
            detectedAt: new Date().toISOString(),
          })
          continue
        }

        // Check resolved IP against IP/CIDR blacklist
        if (entry.resolvedAddress) {
          const match = this.matchIp(entry.resolvedAddress)
          if (match) {
            this.seenDomains.set(domain, now)
            newFlags.push({
              domain: entry.domain,
              resolvedAddress: entry.resolvedAddress,
              matchedRule: match.rule,
              detectedAt: new Date().toISOString(),
            })
          }
        }
      }

      if (newFlags.length > 0) {
        this.flaggedDns.push(...newFlags)
        this.fireCallback([], newFlags)
      }
    } catch (err) {
      logError(`Threat monitor DNS scan error: ${err instanceof Error ? err.message : err}`)
    } finally {
      this.dnsScanRunning = false
    }
  }

  /** Fires callback with only newly-detected items (not the full accumulated snapshot) */
  private fireCallback(newConnections: FlaggedConnection[], newDns: FlaggedDnsEntry[]): void {
    if (!this.onThreatDetected || !this.blacklist) return
    try {
      this.onThreatDetected({
        flaggedConnections: newConnections,
        flaggedDns: newDns,
        blacklistVersion: this.blacklist.version,
        lastConnectionScanAt: this.lastConnectionScanAt,
        lastDnsScanAt: this.lastDnsScanAt,
      })
    } catch {
      // Never let callback errors break the monitor
    }
  }

  private evictExpired(map: Map<string, number>): void {
    const now = Date.now()
    const cutoff = now - SEEN_TTL_MS
    // Always evict expired entries; also hard-cap to prevent runaway growth
    if (map.size > SEEN_MAX_SIZE) {
      map.clear()
      return
    }
    for (const [key, ts] of map) {
      if (ts < cutoff) map.delete(key)
    }
  }

  private matchIp(ip: string): { rule: string; type: 'ip' | 'cidr' } | null {
    const normalized = ip.toLowerCase()

    // Direct IP match
    if (this.ipSet.has(normalized)) {
      return { rule: normalized, type: 'ip' }
    }

    // CIDR match
    for (const cidr of this.parsedCidrs) {
      if (ipMatchesCidr(ip, cidr)) {
        return { rule: cidr.raw, type: 'cidr' }
      }
    }

    return null
  }
}

export const threatMonitor = new ThreatMonitorService()
