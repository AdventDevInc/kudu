import { app, BrowserWindow, Notification } from 'electron'
import { IPC } from '../../shared/channels'
import * as si from 'systeminformation'
import { hostname } from 'os'
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs'
import { readdir } from 'fs/promises'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { lookup } from 'dns/promises'
import Pusher from 'pusher-js'
import { getSettings, setSettings, getMachineId } from './settings-store'
import { scanDirectory, scanMultipleDirectories, scanDirectoriesAsItems, resolveChildSubdirs, cleanItems } from './file-utils'
import { cacheItems } from './scan-cache'
import { getPlatform } from '../platform'
import { CleanerType } from '../../shared/enums'
import { checkForUpdates, runUpdates, isValidAppId } from './software-updater'
import { scanRegistry, fixRegistryEntries } from '../ipc/registry-cleaner.ipc'
import { scanMalware } from '../ipc/malware-scanner.ipc'
import { scanPrivacy } from '../ipc/privacy-shield.ipc'
import { scanServices } from '../ipc/service-manager.ipc'
import { scanDriverUpdates, installDriverUpdates, scanDrivers, cleanDrivers } from '../ipc/driver-manager.ipc'
import { scanNetwork } from '../ipc/network-cleanup.ipc'
import { listStartupItems as listStartupItemsWin32, toggleStartupItem as toggleStartupItemWin32 } from '../ipc/startup-manager.ipc'
import { applyPrivacySettings } from '../ipc/privacy-shield.ipc'
import { scanBloatware, removeBloatware } from '../ipc/debloater.ipc'
import { applyServiceChanges } from '../ipc/service-manager.ipc'
import { quarantineMalware, deleteMalware } from '../ipc/malware-scanner.ipc'
import { scanForLeftovers } from './uninstall-leftovers'
import { PerfMonitorService } from './perf-monitor'
import { cloudLog } from './logger'
import type {
  CloudAgentStatus,
  CloudAgentState,
  CloudCommand,
  TelemetrySnapshot,
  ThreatSnapshot,
  HealthReport,
  AllowedScanType,
} from './cloud-agent-types'
import type { ScanResult, CloudActionEntry } from '../../shared/types'
import { addCloudHistoryEntry } from './cloud-history-store'
import { downloadAndUpdateBlacklist, loadBlacklist } from './threat-blacklist-store'
import { threatMonitor } from './threat-monitor'
import { isLikelyFalsePositive, deduplicateCves } from './cve-filter'

const execFileAsync = promisify(execFile)
const DEFAULT_SERVER_URL = app.isPackaged ? 'https://cloud.usekudu.com' : 'http://localhost:8000'

const COMMAND_TIMEOUT_MS = 5 * 60 * 1000
const LONG_COMMAND_TIMEOUT_MS = 30 * 60 * 1000 // for bulk update / install commands

const LONG_RUNNING_COMMANDS = new Set([
  'scan',
  'software-update-run',
  'windows-update-install',
  'driver-update-install',
  'run-sfc',
  'run-dism',
])
const HEALTH_REPORT_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

/** Connection config returned by GET {serverUrl}/api/connect */
interface ConnectConfig {
  ws: { host: string; port: number; key: string; tls: boolean }
  api: string
  broadcasting: string
}

/** Validates that a file path is within directories allowed for malware operations */
function isAllowedMalwarePath(filePath: string): boolean {
  return getPlatform().malwarePaths.isAllowedMalwarePath(filePath)
}

/**
 * Resolve a URL's hostname and reject if it resolves to a private/loopback IP.
 * Prevents DNS rebinding attacks where a domain initially resolves to a public
 * IP at settings-save time but later rebinds to 127.0.0.1 or a LAN address.
 */
async function assertPublicResolution(urlStr: string): Promise<void> {
  if (!app.isPackaged) return // skip in dev builds

  const host = new URL(urlStr).hostname
  // Skip for IP literals — already validated at settings-save time
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return

  try {
    const { address } = await lookup(host)
    if (
      address === '127.0.0.1' || address === '::1' || address === '0.0.0.0' ||
      address.startsWith('10.') || address.startsWith('192.168.') ||
      address.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
      address.startsWith('fc') || address.startsWith('fd') ||
      address.startsWith('fe8') || address.startsWith('fe9') ||
      address.startsWith('fea') || address.startsWith('feb')
    ) {
      throw new Error(`DNS rebinding blocked: ${host} resolved to private address ${address}`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('DNS rebinding')) throw err
    // DNS lookup failures are non-fatal — the fetch itself will fail if unreachable
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * On Linux, systeminformation may return the kernel version (e.g. "6.8.0-55-generic")
 * in osInfo.release instead of the distro version (e.g. "22.04").  When that happens,
 * fall back to parsing /etc/os-release directly.
 */
function sanitizeOsRelease(release: string | undefined, platform = process.platform): string {
  if (platform !== 'linux') return release ?? ''
  // Kernel versions look like "6.8.0-55-generic"; distro versions are simpler ("22.04", "12").
  if (!release || /^\d+\.\d+\.\d+-.+/.test(release)) {
    try {
      const content = readFileSync('/etc/os-release', 'utf8')
      const match = content.match(/^VERSION_ID="?([^"\n]+)/m)
      if (match) return match[1]
    } catch { /* file missing — e.g. minimal container */ }
  }
  return release ?? ''
}

class CloudAgentService {
  private pusher: Pusher | null = null
  private channel: ReturnType<Pusher['subscribe']> | null = null
  private status: CloudAgentStatus = 'dormant'
  private apiKey: string = ''
  private deviceId: string = ''
  private serverUrl: string = ''
  private connectConfig: ConnectConfig | null = null
  private telemetryTimer: ReturnType<typeof setInterval> | null = null
  private healthReportTimer: ReturnType<typeof setInterval> | null = null
  private healthReportInitTimer: ReturnType<typeof setTimeout> | null = null
  private telemetryTick: number = 0
  private lastTelemetryAt: string | null = null
  private lastHealthReportAt: string | null = null
  private lastCommandAt: string | null = null
  private linkedAt: string | null = null
  private error: string | null = null
  private commandRunning: boolean = false
  private runningCommands: number = 0
  private healthReportRunning: boolean = false
  private lastCommandFinishedAt: number = 0
  private processedRequestIds = new Map<string, number>() // requestId → timestamp
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts: number = 0
  private lastErrorReason: string | null = null
  private lastTelemetrySuccessAt: number = 0
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  // Cached slow si results — refreshed every 5th tick to keep most ticks fast
  private cachedNetStats: Awaited<ReturnType<typeof si.networkStats>> | null = null
  private cachedFsSize: Awaited<ReturnType<typeof si.fsSize>> | null = null

  // ─── Public API ─────────────────────────────────────────

  getStatus(): CloudAgentState {
    const settings = getSettings()
    const key = settings.cloud.apiKey
    const bl = loadBlacklist()
    return {
      status: this.status,
      maskedApiKey: key ? (key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '****') : null,
      deviceId: this.deviceId || getMachineId() || null,
      linkedAt: this.linkedAt,
      lastTelemetryAt: this.lastTelemetryAt,
      lastHealthReportAt: this.lastHealthReportAt,
      lastCommandAt: this.lastCommandAt,
      error: this.error,
      threatBlacklist: bl ? {
        version: bl.version,
        updatedAt: bl.updatedAt,
        domains: bl.domains.length,
        ips: bl.ips.length,
        cidrs: bl.cidrs.length,
      } : null,
    }
  }

  async getVulnerabilities(
    page?: number,
    severity?: string,
    search?: string,
  ): Promise<import('../../shared/types').CvePageResult> {
    if (this.status !== 'connected') throw new Error('Cloud agent not connected')
    const params = new URLSearchParams()
    if (page && page > 1) params.set('page', String(page))
    if (severity && severity !== 'all') params.set('severity', severity)
    if (search) params.set('search', search.slice(0, 100))
    const qs = params.toString()
    const path = `/devices/${encodeURIComponent(this.deviceId)}/vulnerabilities${qs ? `?${qs}` : ''}`
    const raw = (await this.getApi(path)) as Record<string, unknown>

    // Validate and sanitize each vulnerability row from the API
    // Server sends snake_case fields (cve_id, app_name, installed_version, etc.)
    const validSeverities = new Set(['critical', 'high', 'medium', 'low', 'none'])
    const rawItems = Array.isArray(raw.data) ? raw.data : []
    const vulnerabilities = rawItems
      .filter((item: unknown): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).cve_id === 'string' &&
        typeof (item as Record<string, unknown>).app_name === 'string'
      )
      .map((item) => {
        const cvss = item.cvss_score != null ? parseFloat(String(item.cvss_score)) : NaN
        return {
          id: typeof item.id === 'number' ? item.id : 0,
          cveId: String(item.cve_id),
          appName: String(item.app_name),
          installedVersion: typeof item.installed_version === 'string' ? item.installed_version : '',
          severity: (typeof item.severity === 'string' && validSeverities.has(item.severity) ? item.severity : 'none') as import('../../shared/types').CveSeverity,
          cvssScore: !isNaN(cvss) ? cvss : null,
          fixedIn: typeof item.fixed_in === 'string' ? item.fixed_in : null,
          description: typeof item.description === 'string' ? item.description : null,
          firstDetectedAt: typeof item.first_detected_at === 'string' ? item.first_detected_at : '',
          lastScannedAt: typeof item.last_scanned_at === 'string' ? item.last_scanned_at : '',
        }
      })

    // Filter false positives then deduplicate (prefer silence over wrong alerts)
    const afterFp = vulnerabilities.filter((v) => !isLikelyFalsePositive(v))
    const clean = deduplicateCves(afterFp)

    // Recompute summary from the filtered results (simpler and more correct
    // than subtracting from server totals, which break across pagination)
    const summary = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const v of clean) {
      if (v.severity in summary) summary[v.severity as keyof typeof summary]++
    }

    return {
      vulnerabilities: clean,
      summary,
      total: clean.length,
      nextPageUrl: typeof raw.next_page_url === 'string' ? raw.next_page_url : null,
      librarySize: typeof raw.library_size === 'number' ? raw.library_size : 0,
    }
  }

  async link(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Stop any existing connection before re-linking
      this.stop()

      const settings = getSettings()
      const machineId = getMachineId()
      this.serverUrl = settings.cloud.serverUrl || DEFAULT_SERVER_URL

      this.apiKey = apiKey
      this.deviceId = machineId

      // Discover server config and register device before persisting
      await this.discover()
      const osInfo = await si.osInfo()
      await this.postApi(`/devices/${this.deviceId}/register`, {
        machineId,
        appVersion: app.getVersion(),
        hostname: hostname(),
        os: osInfo.distro,
        isServer: await getPlatform().security.isServer(),
      })

      setSettings({ cloud: { ...settings.cloud, apiKey } })
      this.linkedAt = new Date().toISOString()
      this.error = null
      this.reconnectAttempts = 0

      // Discovery and registration already done above — go straight to the
      // WebSocket connection instead of calling start() which would redo both
      // and, because it was previously unawaited, could fail silently.
      this.connect()
      cloudLog('INFO', `Linked device ${this.deviceId} to ${this.serverUrl}`)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      cloudLog('ERROR', `Link failed: ${msg}`)
      this.error = msg.slice(0, 200)
      this.status = 'error'
      return { success: false, error: msg }
    }
  }

  async unlink(): Promise<void> {
    this.stop()
    const settings = getSettings()
    setSettings({ cloud: { ...settings.cloud, apiKey: '' } })
    this.apiKey = ''
    this.deviceId = ''
    this.linkedAt = null
    this.error = null
    cloudLog('INFO', 'Unlinked device')
  }

  async reconnect(): Promise<void> {
    cloudLog('INFO', 'Manual reconnect requested')
    // Tear down any existing connection/timers cleanly
    this.clearReconnectTimer()
    this.reconnectAttempts = 0
    this.lastErrorReason = null
    if (this.channel) { this.channel.unbind_all(); this.channel = null }
    if (this.pusher) { this.pusher.disconnect(); this.pusher = null }
    if (this.telemetryTimer) { clearInterval(this.telemetryTimer); this.telemetryTimer = null }
    if (this.healthReportTimer) { clearInterval(this.healthReportTimer); this.healthReportTimer = null }
    if (this.healthReportInitTimer) { clearTimeout(this.healthReportInitTimer); this.healthReportInitTimer = null }
    this.stopThreatMonitor()
    await this.start()
  }

  async start(): Promise<void> {
    const settings = getSettings()
    this.apiKey = settings.cloud.apiKey
    this.deviceId = getMachineId()
    this.serverUrl = settings.cloud.serverUrl || DEFAULT_SERVER_URL

    if (!this.apiKey) {
      this.status = 'dormant'
      return
    }

    this.clearReconnectTimer()

    try {
      this.status = 'connecting'
      this.error = null
      await this.discover()
      // Register/update device info (hostname, version) on every connect so the
      // server always has the current hostname — especially important for daemon
      // mode where link() is never called.
      const osInfo = await si.osInfo()
      await this.postApi(`/devices/${this.deviceId}/register`, {
        machineId: getMachineId(),
        appVersion: app.getVersion(),
        hostname: hostname(),
        os: osInfo.distro,
        isServer: await getPlatform().security.isServer(),
      })
      this.connect()
      this.reconnectAttempts = 0
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.error = `Discovery failed: ${msg.slice(0, 180)}`
      this.lastErrorReason = this.error
      this.status = 'disconnected'
      cloudLog('ERROR', `Discovery failed: ${msg}`)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.status === 'dormant') return
    this.clearReconnectTimer()

    // Linear backoff: 10s, 20s, 30s, 30s, 30s...
    this.reconnectAttempts++
    const delaySec = Math.min(10 * this.reconnectAttempts, 30)

    cloudLog('INFO', `Scheduling reconnect in ${delaySec}s (attempt ${this.reconnectAttempts})`)
    // Preserve the actual error reason, append reconnect info
    if (this.error && this.error !== 'Connection lost' && !this.error.startsWith('Reconnecting')) {
      this.lastErrorReason = this.error
    }
    const reason = this.lastErrorReason ? ` (${this.lastErrorReason})` : ''
    this.error = `Reconnecting in ${delaySec}s...${reason}`

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.status === 'dormant') return
      cloudLog('INFO', `Reconnect attempt ${this.reconnectAttempts}`)
      this.start()
    }, delaySec * 1000)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  stop(): void {
    this.clearReconnectTimer()
    this.reconnectAttempts = 0
    this.lastErrorReason = null

    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer)
      this.telemetryTimer = null
    }
    if (this.healthReportTimer) {
      clearInterval(this.healthReportTimer)
      this.healthReportTimer = null
    }
    if (this.healthReportInitTimer) {
      clearTimeout(this.healthReportInitTimer)
      this.healthReportInitTimer = null
    }

    this.stopThreatMonitor()
    this.stopWatchdog()

    if (this.channel) {
      this.channel.unbind_all()
      this.pusher?.unsubscribe(`private-device.${this.deviceId}`)
      this.channel = null
    }
    if (this.pusher) {
      this.pusher.disconnect()
      this.pusher = null
    }

    this.status = 'dormant'
  }

  // ─── Reverb Connection (via pusher-js) ────────────────

  private connect(): void {
    if (!this.connectConfig) {
      this.error = 'No server config — call discover() first'
      this.status = 'error'
      return
    }

    const { ws, broadcasting } = this.connectConfig
    this.status = 'connecting'
    this.error = null

    try {
      this.pusher = new Pusher(ws.key, {
        wsHost: ws.host,
        wsPort: ws.port,
        wssPort: ws.port,
        forceTLS: ws.tls,
        disableStats: true,
        enabledTransports: ['ws', 'wss'],
        cluster: '',
        // Tighter heartbeat: detect dead sockets within ~50s instead of ~150s
        activityTimeout: 30_000,
        pongTimeout: 15_000,
        // Auth endpoint — Reverb validates API key + device ownership
        channelAuthorization: {
          endpoint: broadcasting,
          transport: 'ajax',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'X-Device-Id': this.deviceId,
          },
        },
      })

      this.pusher.connection.bind('connected', () => {
        cloudLog('INFO', 'Reverb connected, subscribing to channel')
        this.subscribeToChannel()
      })

      this.pusher.connection.bind('disconnected', () => {
        this.onDisconnected()
      })

      this.pusher.connection.bind('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'error' in err
          ? String((err as { error: { data?: { message?: string } } }).error?.data?.message || 'Connection error')
          : 'Connection error'
        cloudLog('ERROR', `Reverb error: ${msg}`)
        // Surface the error so the UI can show it — onDisconnected will handle reconnect
        this.error = msg.slice(0, 200)
      })

    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Pusher creation failed'
      this.status = 'disconnected'
      cloudLog('ERROR', `Connect failed: ${this.error}`)
      this.scheduleReconnect()
    }
  }

  private subscribeToChannel(): void {
    if (!this.pusher) return

    const channelName = `private-device.${this.deviceId}`

    // Clean up any existing channel to prevent duplicate event handlers
    // (Pusher's internal reconnect can fire 'connected' multiple times
    //  without a 'disconnected' in between)
    if (this.channel) {
      this.channel.unbind_all()
      this.pusher.unsubscribe(channelName)
      this.channel = null
    }

    this.channel = this.pusher.subscribe(channelName)

    this.channel.bind('pusher:subscription_succeeded', () => {
      this.status = 'connected'
      this.error = null
      this.lastErrorReason = null
      this.reconnectAttempts = 0
      cloudLog('INFO', `Subscribed to private-device.${this.deviceId}, starting telemetry`)
      this.startTelemetry()
      this.startHealthReports()
      this.startThreatMonitor()
    })

    this.channel.bind('pusher:subscription_error', (err: unknown) => {
      const statusCode = typeof err === 'object' && err !== null && 'status' in err
        ? (err as Record<string, unknown>).status
        : null
      const msg = typeof err === 'object' && err !== null && 'error' in err
        ? String((err as Record<string, unknown>).error)
        : 'Channel subscription failed'
      this.error = msg.slice(0, 200)
      cloudLog('ERROR', `Channel auth failed (status ${statusCode}): ${this.error}`)

      // 401/403 = bad API key — don't retry, user needs to re-link
      if (statusCode === 401 || statusCode === 403) {
        this.status = 'error'
        this.pusher?.disconnect()
        return
      }

      // Transient failure (500, network, etc) — teardown and retry
      this.status = 'disconnected'
      this.pusher?.disconnect()
      this.pusher = null
      this.channel = null
      this.scheduleReconnect()
    })

    // Listen for commands from the server
    this.channel.bind('DeviceCommand', (data: unknown) => {
      cloudLog('DEBUG', 'Received DeviceCommand', data)
      this.onCommand(data)
    })

    this.channel.bind('DevicePing', (data: unknown) => {
      cloudLog('DEBUG', 'Received DevicePing')
      const cmd = data as { requestId?: string }
      if (cmd.requestId && typeof cmd.requestId === 'string' && cmd.requestId.length <= 200) {
        this.postCommandResult(cmd.requestId, true, { pong: true }).catch(() => {})
      }
    })
  }

  private onDisconnected(): void {
    if (this.status === 'dormant') return

    this.status = 'disconnected'
    // Preserve existing error if set (e.g. from connection.error), otherwise set a generic one
    if (!this.error) {
      this.error = 'Connection lost'
    }

    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer)
      this.telemetryTimer = null
    }
    if (this.healthReportTimer) {
      clearInterval(this.healthReportTimer)
      this.healthReportTimer = null
    }
    if (this.healthReportInitTimer) {
      clearTimeout(this.healthReportInitTimer)
      this.healthReportInitTimer = null
    }
    this.stopThreatMonitor()
    this.stopWatchdog()

    cloudLog('INFO', 'Reverb disconnected')

    // Clean up pusher instance and do a full reconnect (discover + connect)
    // This is more robust than relying on pusher-js auto-reconnect which
    // doesn't re-discover the server config or handle auth endpoint changes
    if (this.channel) {
      this.channel.unbind_all()
      this.channel = null
    }
    if (this.pusher) {
      this.pusher.disconnect()
      this.pusher = null
    }
    this.scheduleReconnect()
  }

  // ─── HTTP API Helpers ─────────────────────────────────

  /** Discover server config from GET {serverUrl}/api/connect */
  private async discover(): Promise<void> {
    cloudLog('DEBUG', `Discovery: GET ${this.serverUrl}/api/connect`)
    await assertPublicResolution(this.serverUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    let res: Response
    try {
      res = await fetch(`${this.serverUrl}/api/connect`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
    if (!res.ok) {
      cloudLog('ERROR', `Discovery failed: HTTP ${res.status}`)
      throw new Error(`Discovery returned HTTP ${res.status}`)
    }
    const data = await res.json() as ConnectConfig
    if (!data?.ws?.host || !data?.ws?.key || !data?.api || !data?.broadcasting) {
      cloudLog('ERROR', 'Discovery response missing required fields', data)
      throw new Error('Invalid discovery response')
    }
    this.connectConfig = data
    cloudLog('INFO', 'Discovery complete', { wsHost: data.ws.host, wsPort: data.ws.port, tls: data.ws.tls, api: data.api, broadcasting: data.broadcasting })
  }

  private async postApi(path: string, body: unknown): Promise<unknown> {
    if (!this.connectConfig) throw new Error('Not connected — no server config')
    const url = `${this.connectConfig.api}${path}`
    cloudLog('DEBUG', `POST ${url}`)
    await assertPublicResolution(url)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      cloudLog('ERROR', `POST ${url} → ${res.status}`, text.slice(0, 300))
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }

    cloudLog('DEBUG', `POST ${url} → ${res.status}`)
    const contentType = res.headers.get('content-type')
    if (contentType?.includes('application/json')) {
      return res.json()
    }
    return null
  }

  private async getApi(path: string): Promise<unknown> {
    if (!this.connectConfig) throw new Error('Not connected — no server config')
    const url = `${this.connectConfig.api}${path}`
    cloudLog('DEBUG', `GET ${url}`)
    await assertPublicResolution(url)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      cloudLog('ERROR', `GET ${url} → ${res.status}`, text.slice(0, 300))
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }

    cloudLog('DEBUG', `GET ${url} → ${res.status}`)
    const contentType = res.headers.get('content-type')
    if (contentType?.includes('application/json')) {
      const body = await res.json()
      cloudLog('DEBUG', `GET ${url} response body`, JSON.stringify(body).slice(0, 500))
      return body
    }
    return null
  }

  /**
   * Checks whether a broadcast command is missing its payload arrays
   * (trimmed by the server to stay within Reverb's message size limit).
   * If so, fetches the full command from the REST endpoint.
   */
  private needsPayloadFetch(cmd: CloudCommand): boolean {
    switch (cmd.type) {
      case 'clean':              return !cmd.itemIds
      case 'software-update-run': return !cmd.appIds
      case 'driver-update-install': return !cmd.updateIds
      case 'driver-clean':       return !cmd.publishedNames
      case 'privacy-apply':      return !cmd.settingIds
      case 'debloater-remove':   return !cmd.packageNames
      case 'service-apply':      return !cmd.changes
      case 'malware-quarantine': return !cmd.paths
      case 'malware-delete':     return !cmd.paths
      case 'registry-fix':       return !cmd.entryIds
      default:                   return false
    }
  }

  private async fetchFullCommandPayload(cmd: CloudCommand): Promise<CloudCommand> {
    // Sanitise requestId before interpolating into URL path — only allow
    // alphanumeric, hyphens, underscores, and dots to prevent path traversal
    // or query-string injection via crafted requestIds.
    if (!/^[\w.:-]+$/.test(cmd.requestId)) {
      throw new Error('Invalid requestId format for payload fetch')
    }

    cloudLog('DEBUG', `Fetching full payload for ${cmd.type} requestId=${cmd.requestId}`)
    const raw = await this.getApi(
      `/devices/${encodeURIComponent(this.deviceId)}/commands/${encodeURIComponent(cmd.requestId)}`,
    ) as Record<string, unknown>

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Server returned invalid command payload')
    }

    cloudLog('DEBUG', `Payload response keys: ${Object.keys(raw).join(', ')}`)

    // Unwrap `data` envelope if the API returns { data: { ... } }
    const full: Record<string, unknown> =
      'data' in raw && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
        ? raw.data as Record<string, unknown>
        : raw

    // Merge fetched data into the command, but never allow the server
    // response to overwrite security-critical fields already validated
    // by onCommand (type, requestId).
    const { type: _t, requestId: _r, ...payloadFields } = full
    return { ...cmd, ...payloadFields } as CloudCommand
  }

  private getDisabledCapabilities(): string[] {
    const s = getSettings().cloud
    const disabled: string[] = []
    if (s.allowRemotePower === false) disabled.push('remote-power')
    if (s.allowRemoteCleanup === false) disabled.push('remote-cleanup')
    if (s.allowRemoteInstalls === false) disabled.push('remote-installs')
    if (s.allowRemoteConfig === false) disabled.push('remote-config')
    if (s.shareThreatMonitor === false) disabled.push('threat-monitor')
    if (s.shareDiskHealth === false) disabled.push('disk-health')
    if (s.shareProcessList === false) disabled.push('process-list')
    return disabled
  }

  private async postTelemetry(snapshot: TelemetrySnapshot): Promise<void> {
    const disabled = this.getDisabledCapabilities()
    await this.postApi(`/devices/${this.deviceId}/telemetry`, {
      timestamp: Date.now(),
      snapshot,
      ...(disabled.length > 0 ? { disabledCapabilities: disabled } : {}),
    })
  }

  private async postHealthReport(report: HealthReport): Promise<void> {
    await this.postApi(`/devices/${this.deviceId}/health-report`, {
      timestamp: Date.now(),
      report,
    })
  }

  private async postCommandResult(requestId: string, success: boolean, data?: unknown, error?: string): Promise<void> {
    await this.postApi(`/devices/${this.deviceId}/command-result`, {
      requestId,
      success,
      data,
      error,
    })
  }

  // ─── Command Handling ─────────────────────────────────

  private onCommand(raw: unknown): void {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    if (this.status !== 'connected') return

    const cmd = raw as CloudCommand

    if (!('type' in cmd) || !CloudAgentService.ALLOWED_COMMAND_TYPES.has(cmd.type)) return
    if (!('requestId' in cmd) || typeof cmd.requestId !== 'string' || cmd.requestId.length > 200) return

    // Deduplicate — Pusher reconnects can re-deliver the same event.
    // Uses a time-based TTL (10 minutes) so entries expire naturally and
    // an attacker cannot poison the set by flooding fake request IDs to
    // evict legitimate ones.
    const now = Date.now()
    const REQUEST_ID_TTL_MS = 10 * 60 * 1000 // 10 minutes
    if (this.processedRequestIds.has(cmd.requestId)) {
      cloudLog('DEBUG', `Ignoring duplicate command requestId=${cmd.requestId}`)
      return
    }
    // Evict expired entries before inserting to keep the map bounded
    if (this.processedRequestIds.size >= 200) {
      for (const [id, ts] of this.processedRequestIds) {
        if (now - ts > REQUEST_ID_TTL_MS) this.processedRequestIds.delete(id)
      }
      // If still at capacity after eviction, drop oldest entries
      if (this.processedRequestIds.size >= 200) {
        const excess = this.processedRequestIds.size - 199
        const keys = this.processedRequestIds.keys()
        for (let i = 0; i < excess; i++) {
          const key = keys.next().value
          if (key !== undefined) this.processedRequestIds.delete(key)
        }
      }
    }
    this.processedRequestIds.set(cmd.requestId, now)

    this.lastCommandAt = new Date().toISOString()

    this.executeCommand(cmd)
  }

  // ─── Telemetry (frequent, lightweight) ────────────────

  private startTelemetry(): void {
    if (this.telemetryTimer) return

    const settings = getSettings()
    const intervalMs = (settings.cloud.telemetryIntervalSec || 60) * 1000

    this.lastTelemetrySuccessAt = Date.now()

    // Send first telemetry immediately
    this.collectAndSendTelemetry()

    this.telemetryTimer = setInterval(() => {
      this.collectAndSendTelemetry()
    }, intervalMs)

    // Watchdog: if no successful telemetry for 5 minutes, force reconnect
    this.startWatchdog()
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return
    const WATCHDOG_INTERVAL = 60_000
    const WATCHDOG_STALE_MS = 5 * 60_000

    this.watchdogTimer = setInterval(() => {
      if (this.status !== 'connected') return
      const elapsed = Date.now() - this.lastTelemetrySuccessAt
      if (elapsed > WATCHDOG_STALE_MS) {
        cloudLog('ERROR', `Watchdog: no successful telemetry for ${Math.round(elapsed / 1000)}s — forcing reconnect`)
        this.forceReconnect()
      }
    }, WATCHDOG_INTERVAL)
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null }
  }

  private forceReconnect(): void {
    // Stop everything and reconnect from scratch
    this.stopWatchdog()
    if (this.telemetryTimer) { clearInterval(this.telemetryTimer); this.telemetryTimer = null }
    if (this.healthReportTimer) { clearInterval(this.healthReportTimer); this.healthReportTimer = null }
    if (this.healthReportInitTimer) { clearTimeout(this.healthReportInitTimer); this.healthReportInitTimer = null }
    this.stopThreatMonitor()

    if (this.channel) { this.channel.unbind_all(); this.channel = null }
    if (this.pusher) { this.pusher.disconnect(); this.pusher = null }

    this.status = 'disconnected'
    this.error = 'Telemetry stalled — reconnecting'
    this.reconnectAttempts = 0
    this.scheduleReconnect()
  }

  private async collectAndSendTelemetry(): Promise<void> {
    // Skip telemetry while health report is running — both compete for the
    // shared persistent PowerShell process which deadlocks under contention
    if (this.healthReportRunning) {
      cloudLog('DEBUG', 'Skipping telemetry tick — health report in progress')
      return
    }

    try {
      const settings = getSettings()
      this.telemetryTick++

      // Fast calls run every tick; slow calls (networkStats ~3-5s, fsSize ~0.5-1s)
      // run every 5th tick and use cached values in between
      const refreshSlow = this.telemetryTick % 5 === 1 || !this.cachedNetStats

      const fastCalls = Promise.all([
        si.currentLoad(),
        si.mem(),
        si.disksIO(),
        si.time(),
      ])
      const slowCalls = refreshSlow
        ? Promise.all([si.networkStats(), si.fsSize()])
        : Promise.resolve(null)

      const [fastResults, slowResults] = await withTimeout(
        Promise.all([fastCalls, slowCalls]),
        30_000,
        'Telemetry si gather',
      )

      const [load, mem, diskIO, time] = fastResults
      if (slowResults) {
        this.cachedNetStats = slowResults[0]
        this.cachedFsSize = slowResults[1]
      }
      const netStats = this.cachedNetStats!
      const fsSize = this.cachedFsSize!

      const snapshot: TelemetrySnapshot = {
        cpu: load.currentLoad,
        memoryPercent: (mem.active / mem.total) * 100,
        memoryUsedBytes: mem.active,
        memoryTotalBytes: mem.total,
        diskReadBps: diskIO?.rIO_sec ?? 0,
        diskWriteBps: diskIO?.wIO_sec ?? 0,
        networkRxBps: netStats.reduce((s, n) => s + n.rx_sec, 0),
        networkTxBps: netStats.reduce((s, n) => s + n.tx_sec, 0),
        uptime: time.uptime ?? 0,
        disks: fsSize.map((d) => ({
          fs: d.fs,
          size: d.size,
          used: d.used,
          available: d.available,
          mount: d.mount,
        })),
      }

      // Include disk health every 30th tick (~30 minutes at default interval)
      if (settings.cloud.shareDiskHealth && this.telemetryTick % 30 === 0) {
        try {
          const disks = await si.diskLayout()
          snapshot.diskHealth = disks.map((d) => ({
            device: d.name,
            healthStatus: d.smartStatus || 'Unknown',
            temperature: d.temperature ?? null,
          }))
        } catch {
          // Disk health is optional
        }
      }

      // Include top processes every 10th tick (~10 minutes at default interval)
      if (settings.cloud.shareProcessList && this.telemetryTick % 10 === 0) {
        try {
          const data = await si.processes()
          // Sort by CPU + memory, take top 20 — only send name and resource usage, no PIDs/users/paths
          const sorted = data.list
            .sort((a, b) => (b.cpu + b.memRss) - (a.cpu + a.memRss))
            .slice(0, 20)
          snapshot.topProcesses = sorted.map((p) => ({
            name: p.name,
            cpuPercent: Math.round(p.cpu * 100) / 100,
            memPercent: mem.total > 0 ? Math.round((p.memRss / mem.total) * 10000) / 100 : 0,
          }))
        } catch {
          // Process list is optional
        }
      }

      // Include threat monitor data if any flagged connections/DNS entries exist
      const threats = threatMonitor.getThreatSnapshot()
      if (threats && (threats.flaggedConnections.length > 0 || threats.flaggedDns.length > 0)) {
        snapshot.threatSnapshot = threats
      }

      await this.postTelemetry(snapshot)
      threatMonitor.clearAccumulated()
      this.lastTelemetryAt = new Date().toISOString()
      this.lastTelemetrySuccessAt = Date.now()
      cloudLog('DEBUG', `Telemetry sent (tick ${this.telemetryTick}, cpu=${snapshot.cpu.toFixed(1)}%, mem=${snapshot.memoryPercent.toFixed(1)}%)`)
    } catch (err) {
      cloudLog('ERROR', `Telemetry failed: ${err}`)
    }
  }

  // ─── Health Reports (infrequent, comprehensive) ───────

  private startHealthReports(): void {
    if (this.healthReportTimer) return

    // Clear any stale init timer from a previous connection cycle
    if (this.healthReportInitTimer) { clearTimeout(this.healthReportInitTimer); this.healthReportInitTimer = null }

    // First health report after 2 minutes (let app settle)
    this.healthReportInitTimer = setTimeout(() => {
      this.healthReportInitTimer = null
      if (this.status === 'connected') {
        this.collectAndSendHealthReport()
      }
    }, 2 * 60 * 1000)

    this.healthReportTimer = setInterval(() => {
      if (this.status === 'connected') {
        this.collectAndSendHealthReport()
      }
    }, HEALTH_REPORT_INTERVAL_MS)
  }

  private async collectAndSendHealthReport(): Promise<void> {
    // Prevent concurrent health reports (timer vs command overlap)
    if (this.healthReportRunning) return
    this.healthReportRunning = true

    try {
      cloudLog('DEBUG', 'Collecting health report')

      const report: HealthReport = {
        services: { totalRunning: 0, totalDisabled: 0, safeToDisable: 0, byCategory: {} },
        privacy: { score: 0, total: 0, protected: 0, byCategory: {} },
        securityPosture: {
          antivirus: { products: [], primary: null },
          firewall: { enabled: false, products: [], windowsProfiles: { domain: false, private: false, public: false } },
          bitlocker: { volumes: [] },
          windowsUpdate: { recentPatches: [], lastPatchDate: null, daysSinceLastPatch: null },
          screenLock: { screenSaverEnabled: false, lockOnResume: false, timeoutSec: null, inactivityLockSec: null },
          passwordPolicy: { minLength: 0, maxAgeDays: 0, minAgeDays: 0, historyCount: 0, complexityRequired: false, lockoutThreshold: 0, lockoutDurationMin: 0, lockoutObservationMin: 0, windowsHello: { enrolled: false, faceEnabled: false, fingerprintEnabled: false, pinEnabled: false } },
          sshHardening: null,
          fail2ban: null,
          listeningPorts: null,
          auditd: null,
          suidSgidBinaries: null,
          firewallStatus: null,
        },
      }

      const SCAN_TIMEOUT = 60_000

      const [r0, r1, r2] = await withTimeout(Promise.allSettled([
        this.collectServiceHealth(),
        this.collectPrivacyHealth(),
        this.collectSecurityPosture(),
      ]), SCAN_TIMEOUT, 'Health report')
      if (r0.status === 'fulfilled') report.services = r0.value
      if (r1.status === 'fulfilled') report.privacy = r1.value
      if (r2.status === 'fulfilled') report.securityPosture = r2.value

      await this.postHealthReport(report)
      this.lastHealthReportAt = new Date().toISOString()
      cloudLog('INFO', 'Health report sent')
    } catch (err) {
      cloudLog('ERROR', `Health report failed: ${err}`)
    } finally {
      this.healthReportRunning = false
    }
  }

  private async collectServiceHealth(): Promise<HealthReport['services']> {
    const result = await scanServices()
    const byCategory: Record<string, { total: number; running: number; safeToDisable: number }> = {}
    for (const s of result.services) {
      if (!byCategory[s.category]) {
        byCategory[s.category] = { total: 0, running: 0, safeToDisable: 0 }
      }
      byCategory[s.category].total++
      if (s.status === 'Running') byCategory[s.category].running++
      if (s.safety === 'safe') byCategory[s.category].safeToDisable++
    }
    return {
      totalRunning: result.runningCount,
      totalDisabled: result.disabledCount,
      safeToDisable: result.safeToDisableCount,
      byCategory,
    }
  }

  private async collectPrivacyHealth(): Promise<HealthReport['privacy']> {
    const result = await scanPrivacy()
    const byCategory: Record<string, { total: number; protected: number }> = {}
    for (const s of result.settings) {
      if (!byCategory[s.category]) {
        byCategory[s.category] = { total: 0, protected: 0 }
      }
      byCategory[s.category].total++
      if (s.enabled) byCategory[s.category].protected++
    }
    return {
      score: result.score,
      total: result.total,
      protected: result.protected,
      byCategory,
    }
  }

  // ─── Security Posture (native Windows checks) ────────

  private async collectSecurityPosture(): Promise<HealthReport['securityPosture']> {
    const security = getPlatform().security
    const [av, fw, bl, wu, sl, pp, ssh, f2b, ports, audit, suid, lfw] = await Promise.allSettled([
      security.collectAntivirusStatus(),
      security.collectFirewallStatus(),
      security.collectDiskEncryptionStatus(),
      security.collectUpdateStatus(),
      security.collectScreenLockStatus(),
      security.collectPasswordPolicy(),
      security.collectSshHardening(),
      security.collectFail2ban(),
      security.collectListeningPorts(),
      security.collectAuditd(),
      security.collectSuidSgidBinaries(),
      security.collectLinuxFirewallStatus(),
    ])

    return {
      antivirus: av.status === 'fulfilled' ? av.value : { products: [], primary: null },
      firewall: fw.status === 'fulfilled' ? fw.value : { enabled: false, products: [], windowsProfiles: { domain: false, private: false, public: false } },
      bitlocker: bl.status === 'fulfilled' ? bl.value : { volumes: [] },
      windowsUpdate: wu.status === 'fulfilled' ? wu.value : { recentPatches: [], lastPatchDate: null, daysSinceLastPatch: null },
      screenLock: sl.status === 'fulfilled' ? sl.value : { screenSaverEnabled: false, lockOnResume: false, timeoutSec: null, inactivityLockSec: null },
      passwordPolicy: pp.status === 'fulfilled' ? pp.value : { minLength: 0, maxAgeDays: 0, minAgeDays: 0, historyCount: 0, complexityRequired: false, lockoutThreshold: 0, lockoutDurationMin: 0, lockoutObservationMin: 0, windowsHello: { enrolled: false, faceEnabled: false, fingerprintEnabled: false, pinEnabled: false } },
      sshHardening: ssh.status === 'fulfilled' ? ssh.value : null,
      fail2ban: f2b.status === 'fulfilled' ? f2b.value : null,
      listeningPorts: ports.status === 'fulfilled' ? ports.value : null,
      auditd: audit.status === 'fulfilled' ? audit.value : null,
      suidSgidBinaries: suid.status === 'fulfilled' ? suid.value : null,
      firewallStatus: lfw.status === 'fulfilled' ? lfw.value : null,
    }
  }


  // ─── Threat Monitor ─────────────────────────────────

  private static readonly THREAT_ALERT_COOLDOWN_MS = 60_000 // min 60s between alert POSTs
  private static readonly THREAT_ALERT_MAX_PER_HOUR = 30    // hard cap per hour
  private threatAlertLastSentAt = 0
  private threatAlertPending: ThreatSnapshot | null = null
  private threatAlertCooldownTimer: ReturnType<typeof setTimeout> | null = null
  private threatAlertHourlyCount = 0
  private threatAlertHourlyResetAt = 0

  private startThreatMonitor(): void {
    const settings = getSettings()
    if (settings.cloud.shareThreatMonitor === false) return

    // Wire up immediate alert callback — fires the moment new threats are detected
    // The snapshot contains only NEWLY-detected items from this scan cycle
    threatMonitor.setThreatCallback((snapshot) => {
      // Push to renderer for live UI updates
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.THREAT_MONITOR_UPDATED, snapshot)
      }

      // OS notification (skip in daemon/headless mode — no desktop to show it on)
      const currentSettings = getSettings()
      const isDaemon = process.argv.includes('--daemon')
      if (!isDaemon && currentSettings.showThreatNotifications && Notification.isSupported()) {
        const connCount = snapshot.flaggedConnections.length
        const dnsCount = snapshot.flaggedDns.length
        const parts: string[] = []
        if (connCount > 0) parts.push(`${connCount} suspicious connection${connCount > 1 ? 's' : ''}`)
        if (dnsCount > 0) parts.push(`${dnsCount} suspicious DNS entr${dnsCount > 1 ? 'ies' : 'y'}`)
        new Notification({
          title: 'Kudu - Threat Detected',
          body: `Detected ${parts.join(' and ')}.`,
          silent: false,
        }).show()
      }

      // Cloud alert
      if (this.status === 'connected') {
        this.queueThreatAlert(snapshot)
      }
    })

    threatMonitor.start()

    // Notify the renderer that the threat monitor is now active so the
    // sidebar tab appears.  The push callback only fires on NEW threats,
    // so without this the renderer never learns the blacklist is loaded.
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.THREAT_MONITOR_UPDATED, null)
    }

    // If no blacklist on disk, ask the cloud for one
    if (!loadBlacklist()) {
      this.fetchInitialBlacklist()
    }
  }

  /** Ask the cloud for a threat blacklist URL and download it if available */
  private async fetchInitialBlacklist(): Promise<void> {
    try {
      if (!this.connectConfig) return
      const url = `${this.connectConfig.api}/devices/${this.deviceId}/threat-blacklist-url`
      cloudLog('DEBUG', `Fetching initial blacklist URL from ${url}`)
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
      if (!res.ok) {
        cloudLog('DEBUG', `No blacklist URL available (HTTP ${res.status})`)
        return
      }
      const data = await res.json() as { url?: string }
      if (!data?.url || typeof data.url !== 'string') {
        cloudLog('DEBUG', 'No blacklist URL in response')
        return
      }
      cloudLog('INFO', `Downloading initial blacklist from ${data.url}`)
      const result = await downloadAndUpdateBlacklist(data.url)
      if (result.success) {
        threatMonitor.reloadBlacklist()
        // Notify renderer so the Threat Monitor page picks up the new version
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.THREAT_MONITOR_UPDATED, null)
        }
        cloudLog('INFO', `Initial blacklist loaded (${result.stats!.domains} domains, ${result.stats!.ips} IPs, ${result.stats!.cidrs} CIDRs)`)
      } else {
        cloudLog('ERROR', `Initial blacklist download failed: ${result.error}`)
      }
    } catch (err) {
      cloudLog('DEBUG', `Failed to fetch initial blacklist: ${err}`)
    }
  }

  private static readonly THREAT_PENDING_MAX = 500

  /** Queue a threat alert, rate-limited to avoid overwhelming the cloud */
  private queueThreatAlert(snapshot: ThreatSnapshot): void {
    // Merge new items into any pending batch
    if (this.threatAlertPending) {
      if (this.threatAlertPending.flaggedConnections.length < CloudAgentService.THREAT_PENDING_MAX) {
        this.threatAlertPending.flaggedConnections.push(...snapshot.flaggedConnections)
      }
      if (this.threatAlertPending.flaggedDns.length < CloudAgentService.THREAT_PENDING_MAX) {
        this.threatAlertPending.flaggedDns.push(...snapshot.flaggedDns)
      }
      this.threatAlertPending.blacklistVersion = snapshot.blacklistVersion
      this.threatAlertPending.lastConnectionScanAt = snapshot.lastConnectionScanAt
      this.threatAlertPending.lastDnsScanAt = snapshot.lastDnsScanAt
    } else {
      this.threatAlertPending = {
        ...snapshot,
        flaggedConnections: [...snapshot.flaggedConnections],
        flaggedDns: [...snapshot.flaggedDns],
      }
    }

    const now = Date.now()
    const elapsed = now - this.threatAlertLastSentAt

    if (elapsed >= CloudAgentService.THREAT_ALERT_COOLDOWN_MS) {
      this.flushThreatAlert()
    } else if (!this.threatAlertCooldownTimer) {
      // Schedule flush after cooldown expires
      const delay = CloudAgentService.THREAT_ALERT_COOLDOWN_MS - elapsed
      this.threatAlertCooldownTimer = setTimeout(() => {
        this.threatAlertCooldownTimer = null
        this.flushThreatAlert()
      }, delay)
    }
    // If timer already running, new items are batched into pending — sent when timer fires
  }

  private flushThreatAlert(): void {
    if (!this.threatAlertPending) return
    const batch = this.threatAlertPending
    this.threatAlertPending = null

    // Hourly rate cap
    const now = Date.now()
    if (now >= this.threatAlertHourlyResetAt) {
      this.threatAlertHourlyCount = 0
      this.threatAlertHourlyResetAt = now + 3_600_000
    }
    if (this.threatAlertHourlyCount >= CloudAgentService.THREAT_ALERT_MAX_PER_HOUR) {
      cloudLog('DEBUG', `Threat alert suppressed (hourly cap ${CloudAgentService.THREAT_ALERT_MAX_PER_HOUR} reached)`)
      return
    }

    this.threatAlertLastSentAt = now
    this.threatAlertHourlyCount++

    this.postThreatAlert(batch).catch((err) => {
      cloudLog('ERROR', `Threat alert POST failed: ${err}`)
    })
  }

  private stopThreatMonitor(): void {
    threatMonitor.setThreatCallback(null)
    threatMonitor.stop()
    if (this.threatAlertCooldownTimer) { clearTimeout(this.threatAlertCooldownTimer); this.threatAlertCooldownTimer = null }
    this.threatAlertPending = null
  }

  private async postThreatAlert(snapshot: ThreatSnapshot): Promise<void> {
    await this.postApi(`/devices/${this.deviceId}/threat-alert`, {
      timestamp: Date.now(),
      snapshot,
    })
    cloudLog('INFO', `Threat alert sent (${snapshot.flaggedConnections.length} connections, ${snapshot.flaggedDns.length} DNS)`)
  }

  // ─── Command Execution ────────────────────────────────

  /** Maps command types to user permission settings. Returns error message if blocked, null if allowed. */
  private checkCommandPermission(type: string): string | null {
    const s = getSettings().cloud
    switch (type) {
      case 'shutdown':
      case 'restart':
        if (s.allowRemotePower === false) return 'Disabled by user: remote power control is turned off'
        break
      case 'clean':
      case 'malware-delete':
      case 'driver-clean':
      case 'debloater-remove':
      case 'registry-fix':
        if (s.allowRemoteCleanup === false) return 'Disabled by user: remote cleanup is turned off'
        break
      case 'software-update-run':
      case 'windows-update-install':
      case 'driver-update-install':
      case 'run-sfc':
      case 'run-dism':
        if (s.allowRemoteInstalls === false) return 'Disabled by user: remote installs are turned off'
        break
      case 'startup-toggle':
      case 'privacy-apply':
      case 'service-apply':
        if (s.allowRemoteConfig === false) return 'Disabled by user: remote config changes are turned off'
        break
    }
    return null
  }

  private static readonly ALLOWED_COMMAND_TYPES: ReadonlySet<string> = new Set([
    'scan', 'clean', 'software-update-check', 'software-update-run',
    'get-status', 'get-system-info', 'get-health-report',
    'shutdown', 'restart', 'windows-update-check', 'windows-update-install',
    'run-sfc', 'run-dism', 'get-network-config', 'get-event-log', 'get-installed-apps',
    'driver-update-scan', 'driver-update-install', 'driver-clean',
    'startup-list', 'startup-toggle', 'disk-health',
    'privacy-scan', 'privacy-apply', 'debloater-scan', 'debloater-remove',
    'service-scan', 'service-apply',
    'malware-quarantine', 'malware-delete', 'registry-scan', 'registry-fix',
    'update-threat-blacklist', 'get-threat-status',
    'cve-scan',
  ])

  /** Commands that only read data and can safely run in parallel */
  private static readonly PARALLEL_SAFE: ReadonlySet<string> = new Set([
    'scan', 'get-status', 'get-system-info', 'get-health-report',
    'get-network-config', 'get-event-log', 'get-installed-apps',
    'software-update-check', 'windows-update-check',
    'driver-update-scan', 'startup-list', 'disk-health',
    'privacy-scan', 'debloater-scan', 'service-scan', 'registry-scan',
    'malware-quarantine', // quarantine is read-like (moves to vault)
    'get-threat-status',
  ])

  private async executeCommand(cmd: CloudCommand): Promise<void> {
    const isParallelSafe = CloudAgentService.PARALLEL_SAFE.has(cmd.type)

    // Mutating commands need exclusive access
    if (!isParallelSafe && this.commandRunning) {
      if ('requestId' in cmd) {
        this.postCommandResult(cmd.requestId, false, undefined, 'A mutating command is already running').catch(() => {})
      }
      return
    }

    // Block mutating commands while any parallel commands are still running
    if (!isParallelSafe && this.runningCommands > 0) {
      if ('requestId' in cmd) {
        this.postCommandResult(cmd.requestId, false, undefined, 'Commands are still running — try again shortly').catch(() => {})
      }
      return
    }

    // Rate limit mutating commands: minimum 500ms to prevent accidental double-fires
    if (!isParallelSafe) {
      const elapsed = Date.now() - this.lastCommandFinishedAt
      if (elapsed < 500) {
        if ('requestId' in cmd) {
          this.postCommandResult(cmd.requestId, false, undefined, 'Rate limited — try again shortly').catch(() => {})
        }
        return
      }
    }

    if (!isParallelSafe) this.commandRunning = true
    this.runningCommands++
    let timedOut = false
    const startedAt = Date.now()

    const timeout = setTimeout(() => {
      timedOut = true
      if (!isParallelSafe) this.commandRunning = false
      this.runningCommands = Math.max(0, this.runningCommands - 1)
      if ('requestId' in cmd) {
        this.postCommandResult(cmd.requestId, false, undefined, 'Command timed out').catch(() => {})
      }
      this.logCloudAction(cmd, startedAt, false, 'Command timed out')
    }, LONG_RUNNING_COMMANDS.has(cmd.type) ? LONG_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS)

    try {
      // Check user permission settings for restricted command categories
      const blocked = this.checkCommandPermission(cmd.type)
      if (blocked) {
        if ('requestId' in cmd) {
          await this.postCommandResult(cmd.requestId, false, undefined, blocked)
        }
        return
      }

      // Broadcast payloads may have large arrays trimmed to stay within
      // Reverb's message size limit. Fetch the full payload before executing.
      if (this.needsPayloadFetch(cmd)) {
        cmd = await this.fetchFullCommandPayload(cmd)
      }

      switch (cmd.type) {
        case 'scan':
          await this.handleScan(cmd.requestId, cmd.scanType)
          break
        case 'clean':
          await this.handleClean(cmd.requestId, cmd.itemIds!)
          break
        case 'software-update-check':
          await this.handleUpdateCheck(cmd.requestId)
          break
        case 'software-update-run':
          await this.handleUpdateRun(cmd.requestId, cmd.appIds!)
          break
        case 'get-status':
          await this.handleGetStatus(cmd.requestId)
          break
        case 'get-system-info':
          await this.handleGetSystemInfo(cmd.requestId)
          break
        case 'get-health-report':
          await this.collectAndSendHealthReport()
          await this.postCommandResult(cmd.requestId, true, { sent: true })
          break
        // Power management
        case 'shutdown':
          await this.handleShutdown(cmd.requestId, cmd.delaySec)
          break
        case 'restart':
          await this.handleRestart(cmd.requestId, cmd.delaySec)
          break
        // OS maintenance (uses platform abstraction — returns "not supported" if unavailable)
        case 'windows-update-check':
          await this.handleWindowsUpdateCheck(cmd.requestId)
          break
        case 'windows-update-install':
          await this.handleWindowsUpdateInstall(cmd.requestId)
          break
        case 'run-sfc':
        case 'run-dism':
          if (process.platform === 'darwin') {
            await this.postCommandResult(cmd.requestId, false, undefined, 'Not supported on this platform')
            break
          }
          if (cmd.type === 'run-sfc') await this.handleRunSfc(cmd.requestId)
          else await this.handleRunDism(cmd.requestId)
          break
        // Network
        case 'get-network-config':
          await this.handleGetNetworkConfig(cmd.requestId)
          break
        // Security
        case 'get-event-log':
          await this.handleGetEventLog(cmd.requestId, cmd.logName, cmd.maxEntries)
          break
        // App inventory
        case 'get-installed-apps':
          await this.handleGetInstalledApps(cmd.requestId)
          break
        // Phase 1: Fleet essentials (Windows-only)
        case 'driver-update-scan':
        case 'driver-update-install':
        case 'driver-clean':
          if (process.platform !== 'win32') {
            await this.postCommandResult(cmd.requestId, false, undefined, 'Not supported on this platform')
            break
          }
          if (cmd.type === 'driver-update-scan') await this.handleDriverUpdateScan(cmd.requestId)
          else if (cmd.type === 'driver-update-install') await this.handleDriverUpdateInstall(cmd.requestId, cmd.updateIds!)
          else await this.handleDriverClean(cmd.requestId, cmd.publishedNames!)
          break
        case 'startup-list':
          await this.handleStartupList(cmd.requestId)
          break
        case 'startup-toggle':
          await this.handleStartupToggle(cmd.requestId, cmd.name, cmd.location, cmd.command, cmd.source, cmd.enabled)
          break
        case 'disk-health':
          await this.handleDiskHealth(cmd.requestId)
          break
        // Phase 2: Compliance & security
        case 'privacy-scan':
        case 'privacy-apply':
          if (cmd.type === 'privacy-scan') await this.handlePrivacyScan(cmd.requestId)
          else await this.handlePrivacyApply(cmd.requestId, cmd.settingIds!)
          break
        case 'debloater-scan':
        case 'debloater-remove':
          if (process.platform !== 'win32') {
            await this.postCommandResult(cmd.requestId, false, undefined, 'Not supported on this platform')
            break
          }
          if (cmd.type === 'debloater-scan') await this.handleDebloaterScan(cmd.requestId)
          else await this.handleDebloaterRemove(cmd.requestId, cmd.packageNames!)
          break
        case 'service-scan':
        case 'service-apply':
          if (cmd.type === 'service-scan') await this.handleServiceScan(cmd.requestId)
          else await this.handleServiceApply(cmd.requestId, cmd.changes!)
          break
        // Phase 3: Maintenance
        case 'malware-quarantine':
          await this.handleMalwareQuarantine(cmd.requestId, cmd.paths!)
          break
        case 'malware-delete':
          await this.handleMalwareDelete(cmd.requestId, cmd.paths!)
          break
        case 'registry-scan':
        case 'registry-fix':
          if (process.platform !== 'win32') {
            await this.postCommandResult(cmd.requestId, false, undefined, 'Not supported on this platform')
            break
          }
          if (cmd.type === 'registry-scan') await this.handleRegistryScan(cmd.requestId)
          else await this.handleRegistryFix(cmd.requestId, cmd.entryIds!)
          break
        // Phase 4: Threat monitoring
        case 'update-threat-blacklist':
          await this.handleUpdateThreatBlacklist(cmd.requestId, cmd.url)
          break
        case 'get-threat-status':
          await this.handleGetThreatStatus(cmd.requestId)
          break
        // Phase 5: CVE scanning
        case 'cve-scan':
          await this.handleCveScan(cmd.requestId)
          break
      }
      if (!timedOut) {
        this.logCloudAction(cmd, startedAt, true)
      }
    } catch (err) {
      if (!timedOut) {
        const raw = err instanceof Error ? err.message : String(err)
        const msg = raw.length > 200 ? raw.slice(0, 200) : raw
        if ('requestId' in cmd) {
          this.postCommandResult(cmd.requestId, false, undefined, msg).catch(() => {})
        }
        this.logCloudAction(cmd, startedAt, false, msg)
      }
    } finally {
      clearTimeout(timeout)
      if (!timedOut) {
        if (!isParallelSafe) this.commandRunning = false
        this.runningCommands = Math.max(0, this.runningCommands - 1)
        this.lastCommandFinishedAt = Date.now()
      }
    }
  }

  private logCloudAction(cmd: CloudCommand, startedAt: number, success: boolean, error?: string): void {
    try {
      const entry: CloudActionEntry = {
        id: `cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        commandType: cmd.type,
        requestId: 'requestId' in cmd ? cmd.requestId : '',
        timestamp: new Date(startedAt).toISOString(),
        duration: Date.now() - startedAt,
        success,
        error,
        summary: this.getCommandSummary(cmd),
      }
      addCloudHistoryEntry(entry)
    } catch {
      // Never let history logging break command execution
    }
  }

  private getCommandSummary(cmd: CloudCommand): string {
    switch (cmd.type) {
      case 'scan': return `Scan: ${cmd.scanType}`
      case 'clean': return `Clean: ${cmd.itemIds?.length ?? 0} items`
      case 'software-update-check': return 'Check software updates'
      case 'software-update-run': return `Update ${cmd.appIds?.length ?? 0} apps`
      case 'get-status': return 'Get device status'
      case 'get-system-info': return 'Get system info'
      case 'get-health-report': return 'Generate health report'
      case 'ping': return 'Ping'
      case 'shutdown': return `Shutdown${cmd.delaySec ? ` (${cmd.delaySec}s delay)` : ''}`
      case 'restart': return `Restart${cmd.delaySec ? ` (${cmd.delaySec}s delay)` : ''}`
      case 'windows-update-check': return 'Check Windows updates'
      case 'windows-update-install': return 'Install Windows updates'
      case 'run-sfc': return process.platform === 'linux' ? 'Clean package cache' : 'Run System File Checker'
      case 'run-dism': return process.platform === 'linux' ? 'Remove orphaned packages' : 'Run DISM repair'
      case 'get-network-config': return 'Get network config'
      case 'get-event-log': return `Get event log: ${cmd.logName ?? 'System'}`
      case 'get-installed-apps': return 'Get installed apps'
      case 'driver-update-scan': return 'Scan driver updates'
      case 'driver-update-install': return `Install ${cmd.updateIds?.length ?? 0} driver updates`
      case 'driver-clean': return `Clean ${cmd.publishedNames?.length ?? 0} drivers`
      case 'startup-list': return 'List startup items'
      case 'startup-toggle': return `Toggle startup: ${cmd.name}`
      case 'disk-health': return 'Check disk health'
      case 'privacy-scan': return 'Privacy scan'
      case 'privacy-apply': return `Apply ${cmd.settingIds?.length ?? 0} privacy settings`
      case 'debloater-scan': return 'Debloater scan'
      case 'debloater-remove': return `Remove ${cmd.packageNames?.length ?? 0} packages`
      case 'service-scan': return 'Service scan'
      case 'service-apply': return `Apply ${cmd.changes?.length ?? 0} service changes`
      case 'malware-quarantine': return `Quarantine ${cmd.paths?.length ?? 0} threats`
      case 'malware-delete': return `Delete ${cmd.paths?.length ?? 0} threats`
      case 'registry-scan': return 'Registry scan'
      case 'registry-fix': return `Fix ${cmd.entryIds?.length ?? 0} registry entries`
      case 'update-threat-blacklist': return 'Update threat blacklist'
      case 'get-threat-status': return 'Get threat status'
      case 'cve-scan': return 'CVE vulnerability scan'
      default: return (cmd as CloudCommand).type
    }
  }

  // ─── Command Handlers ────────────────────────────────

  private async handleScan(requestId: string, scanType: AllowedScanType): Promise<void> {
    const validScanTypes = new Set<string>([
      'system', 'browser', 'app', 'gaming', 'registry',
      'malware', 'network', 'recycle-bin', 'uninstall-leftovers',
      'database',
    ])
    if (typeof scanType !== 'string' || !validScanTypes.has(scanType)) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid scan type')
      return
    }

    switch (scanType) {
      case 'system': {
        const results: ScanResult[] = []
        const targets = getPlatform().paths.systemCleanTargets()
        for (const t of targets) {
          try {
            let r
            if (t.childSubdir) {
              const childPaths = await resolveChildSubdirs([t.path], t.childSubdir)
              r = await scanMultipleDirectories(childPaths, CleanerType.System, t.subcategory)
            } else {
              r = await scanDirectory(t.path, CleanerType.System, t.subcategory)
            }
            if (r.items.length > 0) { cacheItems(r.items); results.push(r) }
          } catch { /* skip */ }
        }
        // Strip local file paths — only send IDs, sizes, and categories to cloud
        await this.postCommandResult(requestId, true, {
          scanType,
          results: results.map((r) => ({
            category: r.category,
            subcategory: r.subcategory,
            totalSize: r.totalSize,
            itemCount: r.itemCount,
            items: r.items.map((i) => ({ id: i.id, size: i.size, category: i.category, subcategory: i.subcategory })),
          })),
          totalSize: results.reduce((s, r) => s + r.totalSize, 0),
          totalItems: results.reduce((s, r) => s + r.itemCount, 0),
        })
        return
      }

      case 'browser': {
        const browserResults: ScanResult[] = []
        const browserPaths = getPlatform().paths.browserPaths()
        const browserCategory = CleanerType.Browser

        const chromiumBrowsers = [
          { label: 'Chrome', ...browserPaths.chrome, hasProfiles: true },
          { label: 'Edge', ...browserPaths.edge, hasProfiles: true },
          { label: 'Brave', ...browserPaths.brave, hasProfiles: true },
          { label: 'Vivaldi', ...browserPaths.vivaldi, hasProfiles: true },
          { label: 'Opera', ...browserPaths.opera, hasProfiles: false },
          { label: 'Opera GX', ...browserPaths.operaGX, hasProfiles: false },
          { label: 'Arc', ...browserPaths.arc, hasProfiles: true },
          { label: 'Chromium', ...browserPaths.chromium, hasProfiles: true },
          { label: 'Thorium', ...browserPaths.thorium, hasProfiles: true },
          { label: 'Supermium', ...browserPaths.supermium, hasProfiles: true },
          { label: 'Helium', ...browserPaths.helium, hasProfiles: true },
          { label: 'Cromite', ...browserPaths.cromite, hasProfiles: true },
          { label: 'CatsXP', ...browserPaths.catsxp, hasProfiles: true },
        ]

        for (const browser of chromiumBrowsers) {
          if (!existsSync(browser.base)) continue
          const cacheDirs = [
            { dir: browser.cache, label: 'Cache' },
            { dir: browser.codeCache, label: 'Code Cache' },
            { dir: browser.gpuCache, label: 'GPU Cache' },
            { dir: browser.serviceWorker, label: 'Service Worker Cache' },
          ]
          if (browser.hasProfiles) {
            const profiles = await getChromiumProfiles(browser.base)
            for (const profile of profiles) {
              for (const { dir, label } of cacheDirs) {
                const cachePath = join(browser.base, profile, dir)
                if (existsSync(cachePath)) {
                  try {
                    const r = await scanDirectory(cachePath, browserCategory, `${browser.label} - ${profile} ${label}`)
                    if (r.items.length > 0) { cacheItems(r.items); browserResults.push(r) }
                  } catch { /* skip */ }
                }
              }
            }
          } else {
            for (const { dir, label } of cacheDirs) {
              const cachePath = join(browser.base, dir)
              if (existsSync(cachePath)) {
                try {
                  const r = await scanDirectory(cachePath, browserCategory, `${browser.label} - ${label}`)
                  if (r.items.length > 0) { cacheItems(r.items); browserResults.push(r) }
                } catch { /* skip */ }
              }
            }
          }
        }

        // Firefox
        if (existsSync(browserPaths.firefox.cache)) {
          try {
            const profileDirs = await readdir(browserPaths.firefox.cache, { withFileTypes: true })
            for (const dir of profileDirs) {
              if (dir.isDirectory()) {
                const cachePath = join(browserPaths.firefox.cache, dir.name, 'cache2', 'entries')
                if (existsSync(cachePath)) {
                  const r = await scanDirectory(cachePath, browserCategory, `Firefox - ${dir.name} Cache`)
                  if (r.items.length > 0) { cacheItems(r.items); browserResults.push(r) }
                }
              }
            }
          } catch { /* skip */ }
        }

        // Firefox forks (LibreWolf, Waterfox, Floorp)
        const firefoxForks = [
          { label: 'LibreWolf', ...browserPaths.librewolf },
          { label: 'Waterfox', ...browserPaths.waterfox },
          { label: 'Floorp', ...browserPaths.floorp },
        ]
        for (const fork of firefoxForks) {
          if (!fork.cache || !existsSync(fork.cache)) continue
          try {
            const profileDirs = await readdir(fork.cache, { withFileTypes: true })
            for (const dir of profileDirs) {
              if (dir.isDirectory()) {
                const cachePath = join(fork.cache, dir.name, 'cache2')
                if (existsSync(cachePath)) {
                  const r = await scanDirectory(cachePath, browserCategory, `${fork.label} - ${dir.name} Cache`)
                  if (r.items.length > 0) { cacheItems(r.items); browserResults.push(r) }
                }
              }
            }
          } catch { /* skip */ }
        }

        // Safari (macOS only) — cache directory only, never cookies/history/bookmarks
        if (browserPaths.safari && existsSync(browserPaths.safari.cache)) {
          try {
            const r = await scanDirectory(browserPaths.safari.cache, browserCategory, 'Safari - Cache')
            if (r.items.length > 0) { cacheItems(r.items); browserResults.push(r) }
          } catch { /* skip */ }
        }

        await this.postCommandResult(requestId, true, {
          scanType,
          results: browserResults.map((r) => ({
            category: r.category,
            subcategory: r.subcategory,
            totalSize: r.totalSize,
            itemCount: r.itemCount,
            items: r.items.map((i) => ({ id: i.id, size: i.size, category: i.category, subcategory: i.subcategory })),
          })),
          totalSize: browserResults.reduce((s, r) => s + r.totalSize, 0),
          totalItems: browserResults.reduce((s, r) => s + r.itemCount, 0),
        })
        return
      }

      case 'app': {
        const appResults: ScanResult[] = []
        const appCategory = CleanerType.App
        for (const appDef of getPlatform().paths.appPaths()) {
          try {
            const appPaths = await resolveChildSubdirs(appDef.paths, appDef.childSubdir)
            const r = await scanMultipleDirectories(appPaths, appCategory, appDef.name)
            if (r.items.length > 0) { cacheItems(r.items); appResults.push(r) }
          } catch { /* skip */ }
        }
        await this.postCommandResult(requestId, true, {
          scanType,
          results: appResults.map((r) => ({
            category: r.category,
            subcategory: r.subcategory,
            totalSize: r.totalSize,
            itemCount: r.itemCount,
            items: r.items.map((i) => ({ id: i.id, size: i.size, category: i.category, subcategory: i.subcategory })),
          })),
          totalSize: appResults.reduce((s, r) => s + r.totalSize, 0),
          totalItems: appResults.reduce((s, r) => s + r.itemCount, 0),
        })
        return
      }

      case 'gaming': {
        const gamingResults: ScanResult[] = []
        const gamingCategory = CleanerType.Gaming

        for (const launcher of getPlatform().paths.gamingPaths()) {
          try {
            const r = await scanDirectoriesAsItems(launcher.paths, gamingCategory, launcher.name, 'Launcher Caches')
            if (r.items.length > 0) { cacheItems(r.items); gamingResults.push(r) }
          } catch { /* skip */ }
        }

        for (const gpu of getPlatform().paths.gpuCachePaths()) {
          try {
            const r = await scanDirectoriesAsItems(gpu.paths, gamingCategory, gpu.name, 'GPU Shader Caches')
            if (r.items.length > 0) { cacheItems(r.items); gamingResults.push(r) }
          } catch { /* skip */ }
        }

        await this.postCommandResult(requestId, true, {
          scanType,
          results: gamingResults.map((r) => ({
            category: r.category,
            subcategory: r.subcategory,
            group: r.group,
            totalSize: r.totalSize,
            itemCount: r.itemCount,
            items: r.items.map((i) => ({ id: i.id, size: i.size, category: i.category, subcategory: i.subcategory })),
          })),
          totalSize: gamingResults.reduce((s, r) => s + r.totalSize, 0),
          totalItems: gamingResults.reduce((s, r) => s + r.itemCount, 0),
        })
        return
      }

      case 'recycle-bin': {
        const trashPath = getPlatform().paths.trashPath()
        if (trashPath) {
          // macOS / Linux
          if (!existsSync(trashPath)) {
            await this.postCommandResult(requestId, true, { scanType, results: [], totalSize: 0, totalItems: 0 })
            return
          }
          try {
            const r = await scanDirectory(trashPath, CleanerType.RecycleBin, 'Trash', 0)
            if (r.items.length > 0) cacheItems(r.items)
            await this.postCommandResult(requestId, true, {
              scanType,
              results: r.items.length > 0 ? [{
                category: r.category,
                subcategory: r.subcategory,
                totalSize: r.totalSize,
                itemCount: r.itemCount,
                items: r.items.map((i) => ({ id: i.id, size: i.size, category: i.category, subcategory: i.subcategory })),
              }] : [],
              totalSize: r.totalSize,
              totalItems: r.itemCount,
            })
          } catch {
            await this.postCommandResult(requestId, true, { scanType, results: [], totalSize: 0, totalItems: 0 })
          }
          return
        }
        // Windows: COM-based recycle bin query
        try {
          const rbScript = `$shell = New-Object -ComObject Shell.Application; $rb = $shell.NameSpace(0x0a); $items = $rb.Items(); $count = $items.Count; $size = ($items | Measure-Object -Property Size -Sum).Sum; Write-Output "$count|$size"`
          const rbEncoded = Buffer.from(rbScript, 'utf16le').toString('base64')
          const { stdout } = await execFileAsync('powershell.exe', [
            '-NoProfile', '-EncodedCommand', rbEncoded
          ], { windowsHide: true })
          const [countStr, sizeStr] = stdout.trim().split('|')
          const count = parseInt(countStr) || 0
          const size = parseInt(sizeStr) || 0
          await this.postCommandResult(requestId, true, {
            scanType,
            totalSize: size,
            totalItems: count,
          })
        } catch {
          await this.postCommandResult(requestId, true, { scanType, results: [], totalSize: 0, totalItems: 0 })
        }
        return
      }

      case 'uninstall-leftovers': {
        const leftoverResults = await scanForLeftovers(() => null)
        for (const r of leftoverResults) cacheItems(r.items)
        await this.postCommandResult(requestId, true, {
          scanType,
          results: leftoverResults.map((r) => ({
            category: r.category,
            subcategory: r.subcategory,
            totalSize: r.totalSize,
            itemCount: r.itemCount,
            items: r.items.map((i) => ({ id: i.id, size: i.size, category: i.category, subcategory: i.subcategory })),
          })),
          totalSize: leftoverResults.reduce((s, r) => s + r.totalSize, 0),
          totalItems: leftoverResults.reduce((s, r) => s + r.itemCount, 0),
        })
        return
      }

      case 'registry': {
        if (process.platform !== 'win32') {
          await this.postCommandResult(requestId, false, undefined, 'Not supported on this platform')
          return
        }
        const entries = await scanRegistry()
        // Strip registry key paths and issue text (contains local file paths)
        await this.postCommandResult(requestId, true, {
          scanType,
          entries: entries.map((e) => ({ id: e.id, type: e.type, risk: e.risk })),
          totalIssues: entries.length,
        })
        return
      }

      case 'malware': {
        const result = await scanMalware()
        // Strip full file paths — only send filename, detection info, and severity
        await this.postCommandResult(requestId, true, {
          scanType,
          filesScanned: result.filesScanned,
          duration: result.duration,
          threats: result.threats.map((t) => ({
            id: t.id,
            fileName: t.fileName,
            detectionName: t.detectionName,
            severity: t.severity,
            source: t.source,
          })),
        })
        return
      }

      case 'network': {
        if (process.platform !== 'win32') {
          await this.postCommandResult(requestId, false, undefined, 'Not supported on this platform')
          return
        }
        const items = await scanNetwork()
        // Only send IDs and types — labels may contain wifi network names or other sensitive info
        await this.postCommandResult(requestId, true, {
          scanType,
          items: items.map((i) => ({ id: i.id, type: i.type })),
          totalItems: items.length,
        })
        return
      }

      case 'database': {
        const dbTargets = getPlatform().paths.databaseOptimizeTargets()
        const dbResults: ScanResult[] = []
        const dbCategory = CleanerType.Database

        for (const target of dbTargets) {
          try {
            if (!existsSync(target.basePath)) continue
            const items: ScanResult['items'] = []
            let profileDirs = [target.basePath]
            if (target.multiProfile) {
              const entries = readdirSync(target.basePath, { withFileTypes: true })
              const dirs: string[] = []
              if (target.profilePattern) {
                for (const entry of entries) {
                  if (!entry.isDirectory()) continue
                  for (const pattern of target.profilePattern) {
                    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
                    if (new RegExp('^' + escaped + '$').test(entry.name)) { dirs.push(join(target.basePath, entry.name)); break }
                  }
                }
              } else {
                for (const entry of entries) {
                  if (!entry.isDirectory()) continue
                  if (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)) {
                    dirs.push(join(target.basePath, entry.name))
                  }
                }
              }
              if (dirs.length > 0) profileDirs = dirs
            }

            for (const profileDir of profileDirs) {
              for (const dbFile of target.dbFiles) {
                const dbPath = join(profileDir, dbFile)
                if (!existsSync(dbPath)) continue

                // Fast scan: validate SQLite header and estimate from file sizes
                let isSqlite = false
                let fd: number | undefined
                try {
                  fd = openSync(dbPath, 'r')
                  const buf = Buffer.alloc(16)
                  readSync(fd, buf, 0, 16, 0)
                  isSqlite = buf.toString('utf8', 0, 16) === 'SQLite format 3\0'
                } catch { /* skip */ }
                finally { if (fd !== undefined) closeSync(fd) }
                if (!isSqlite) continue

                const fileStat = statSync(dbPath)
                if (fileStat.size === 0) continue
                let walSize = 0
                try { walSize = statSync(dbPath + '-wal').size } catch { /* no WAL */ }
                const wastedBytes = walSize + Math.floor(fileStat.size * 0.1)
                if (wastedBytes < 4096) continue

                items.push({
                  id: randomUUID(), path: dbPath, size: wastedBytes,
                  category: dbCategory, subcategory: target.label,
                  lastModified: fileStat.mtimeMs, selected: true,
                })
              }
            }

            if (items.length > 0) {
              cacheItems(items)
              dbResults.push({ category: dbCategory, subcategory: target.label, items, totalSize: items.reduce((s, i) => s + i.size, 0), itemCount: items.length })
            }
          } catch { /* skip */ }
        }

        await this.postCommandResult(requestId, true, {
          scanType,
          results: dbResults.map((r) => ({
            category: r.category,
            subcategory: r.subcategory,
            totalSize: r.totalSize,
            itemCount: r.itemCount,
            items: r.items.map((i) => ({ id: i.id, size: i.size, category: i.category, subcategory: i.subcategory })),
          })),
          totalSize: dbResults.reduce((s, r) => s + r.totalSize, 0),
          totalItems: dbResults.reduce((s, r) => s + r.itemCount, 0),
        })
        return
      }

      default:
        await this.postCommandResult(requestId, false, undefined, 'Scan type not yet supported via cloud')
        return
    }
  }

  private async handleClean(requestId: string, itemIds: string[]): Promise<void> {
    if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 1000) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid itemIds')
      return
    }
    if (itemIds.some((id) => typeof id !== 'string' || id.length > 200)) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid itemIds')
      return
    }

    // Separate database items from file items — databases need VACUUM, not deletion
    const { getCachedItem } = await import('./scan-cache')
    const dbIds: string[] = []
    const fileIds: string[] = []
    for (const id of itemIds) {
      const item = getCachedItem(id)
      if (item?.category === CleanerType.Database) dbIds.push(id)
      else fileIds.push(id)
    }

    const fileResult = fileIds.length > 0 ? await cleanItems(fileIds) : { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [] as { path: string; reason: string }[], needsElevation: false }

    let dbResult = { totalCleaned: 0, filesDeleted: 0, filesSkipped: 0, errors: [] as { path: string; reason: string }[], needsElevation: false }
    if (dbIds.length > 0) {
      const Database = (await import('better-sqlite3')).default
      for (const id of dbIds) {
        const item = getCachedItem(id)
        if (!item) continue
        try {
          const sizeBefore = statSync(item.path).size
          let walSizeBefore = 0
          try { walSizeBefore = statSync(item.path + '-wal').size } catch { /* no WAL */ }
          const db = new Database(item.path, { fileMustExist: true })
          try {
            const journalMode = (db.pragma('journal_mode', { simple: true }) as string).toLowerCase()
            db.exec('VACUUM')
            if (journalMode === 'wal') db.pragma('journal_mode = WAL')
          } finally { db.close() }
          const sizeAfter = statSync(item.path).size
          let walSizeAfter = 0
          try { walSizeAfter = statSync(item.path + '-wal').size } catch { /* no WAL */ }
          const reclaimed = (sizeBefore + walSizeBefore) - (sizeAfter + walSizeAfter)
          if (reclaimed > 0) dbResult.totalCleaned += reclaimed
          dbResult.filesDeleted++
        } catch (err: unknown) {
          dbResult.filesSkipped++
          const code = (err as { code?: string }).code
          if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'EBUSY') {
            dbResult.errors.push({ path: item.path, reason: 'in-use' })
          } else if (code === 'EPERM' || code === 'EACCES') {
            dbResult.errors.push({ path: item.path, reason: 'permission-denied' })
            dbResult.needsElevation = true
          } else {
            dbResult.errors.push({ path: item.path, reason: (err as Error).message || 'unknown error' })
          }
        }
      }
    }

    // Strip local file paths from error details before sending to cloud
    await this.postCommandResult(requestId, true, {
      totalCleaned: fileResult.totalCleaned + dbResult.totalCleaned,
      filesDeleted: fileResult.filesDeleted + dbResult.filesDeleted,
      filesSkipped: fileResult.filesSkipped + dbResult.filesSkipped,
      errorCount: fileResult.errors.length + dbResult.errors.length,
      needsElevation: fileResult.needsElevation || dbResult.needsElevation,
    })
  }

  private async handleUpdateCheck(requestId: string): Promise<void> {
    const result = await checkForUpdates()
    // Only send apps that need updates — don't expose full installed software inventory
    await this.postCommandResult(requestId, true, {
      apps: result.apps.map((a) => ({
        id: a.id,
        name: a.name,
        currentVersion: a.currentVersion,
        availableVersion: a.availableVersion,
        severity: a.severity,
      })),
      totalCount: result.totalCount,
      majorCount: result.majorCount,
      minorCount: result.minorCount,
      patchCount: result.patchCount,
      packageManagerAvailable: result.packageManagerAvailable,
      packageManagerName: result.packageManagerName,
    })
  }

  private async handleUpdateRun(requestId: string, appIds: string[]): Promise<void> {
    if (!Array.isArray(appIds) || appIds.length === 0 || appIds.length > 100) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid appIds')
      return
    }
    if (appIds.some((id) => typeof id !== 'string' || id.length > 200)) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid appIds')
      return
    }
    // Validate appId format to prevent argument injection into package manager
    if (appIds.some((id) => !isValidAppId(id))) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid appId format')
      return
    }
    const result = await runUpdates(appIds, () => {})
    // Strip raw error reasons which may contain local paths or system info
    await this.postCommandResult(requestId, true, {
      succeeded: result.succeeded,
      failed: result.failed,
      errors: result.errors.map((e) => ({ appId: e.appId, name: e.name })),
    })
  }

  private async handleGetStatus(requestId: string): Promise<void> {
    const [load, mem, diskIO, netStats, time, fsSize] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.disksIO(),
      si.networkStats(),
      si.time(),
      si.fsSize(),
    ])

    await this.postCommandResult(requestId, true, {
      cpu: load.currentLoad,
      memoryPercent: (mem.active / mem.total) * 100,
      memoryUsedBytes: mem.active,
      memoryTotalBytes: mem.total,
      diskReadBps: diskIO?.rIO_sec ?? 0,
      diskWriteBps: diskIO?.wIO_sec ?? 0,
      networkRxBps: netStats.reduce((s, n) => s + n.rx_sec, 0),
      networkTxBps: netStats.reduce((s, n) => s + n.tx_sec, 0),
      uptime: time.uptime ?? 0,
      disks: fsSize.map((d) => ({
        fs: d.fs, size: d.size, used: d.used, available: d.available, mount: d.mount,
      })),
    })
  }

  private async handleGetSystemInfo(requestId: string): Promise<void> {
    const [cpu, osInfo, mem, disks] = await Promise.all([
      si.cpu(),
      si.osInfo(),
      si.mem(),
      si.diskLayout(),
    ])

    await this.postCommandResult(requestId, true, {
      cpu: { model: `${cpu.manufacturer} ${cpu.brand}`, cores: cpu.physicalCores, threads: cpu.cores },
      os: { distro: osInfo.distro, release: sanitizeOsRelease(osInfo.release), hostname: osInfo.hostname },
      memory: { total: mem.total, available: mem.available },
      disks: disks.map((d) => ({ name: d.name, size: d.size, type: d.type })),
    })
  }

  // ─── Power Management ────────────────────────────────

  private async handleShutdown(requestId: string, delaySec?: number): Promise<void> {
    const delay = Math.max(0, Math.min(typeof delaySec === 'number' ? delaySec : 30, 3600))
    cloudLog('INFO', `Shutdown requested with ${delay}s delay`)
    await this.postCommandResult(requestId, true, { action: 'shutdown', delaySec: delay })
    await getPlatform().commands.shutdown(delay)
  }

  private async handleRestart(requestId: string, delaySec?: number): Promise<void> {
    const delay = Math.max(0, Math.min(typeof delaySec === 'number' ? delaySec : 30, 3600))
    cloudLog('INFO', `Restart requested with ${delay}s delay`)
    await this.postCommandResult(requestId, true, { action: 'restart', delaySec: delay })
    await getPlatform().commands.restart(delay)
  }

  // ─── OS Updates ──────────────────────────────────

  private async handleWindowsUpdateCheck(requestId: string): Promise<void> {
    const updates = await getPlatform().commands.checkOsUpdates()
    if (!updates) {
      await this.postCommandResult(requestId, false, undefined, 'Not supported on this platform')
      return
    }
    await this.postCommandResult(requestId, true, {
      updates,
      totalCount: updates.length,
    })
  }

  private async handleWindowsUpdateInstall(requestId: string): Promise<void> {
    const result = await getPlatform().commands.installOsUpdates()
    if (!result) {
      await this.postCommandResult(requestId, false, undefined, 'Not supported on this platform')
      return
    }
    await this.postCommandResult(requestId, true, result)
  }

  // ─── System File Checker & DISM ──────────────────────

  private async handleRunSfc(requestId: string): Promise<void> {
    cloudLog('INFO', 'Running system file check')
    const result = await getPlatform().commands.runSystemFileCheck()
    if (!result) {
      await this.postCommandResult(requestId, false, undefined, 'Not supported on this platform')
      return
    }
    await this.postCommandResult(requestId, true, result)
  }

  private async handleRunDism(requestId: string): Promise<void> {
    cloudLog('INFO', 'Running system image repair')
    const result = await getPlatform().commands.runSystemImageRepair()
    if (!result) {
      await this.postCommandResult(requestId, false, undefined, 'Not supported on this platform')
      return
    }
    await this.postCommandResult(requestId, true, result)
  }

  // ─── Network Config ──────────────────────────────────

  private async handleGetNetworkConfig(requestId: string): Promise<void> {
    const [interfaces, defaultGw, dnsServers] = await Promise.all([
      si.networkInterfaces(),
      si.networkGatewayDefault(),
      getPlatform().commands.getDnsServers(),
    ])

    const ifaces = (Array.isArray(interfaces) ? interfaces : [interfaces])
      .filter((i) => i.ip4 || i.ip6)
      .map((i) => {
        // Virtual/tunnel adapters (e.g. Tailscale/WireGuard) often report
        // operstate "down" even when active. If the interface has a valid IP
        // assigned, treat it as up.
        const hasValidIp = !!(i.ip4 && i.ip4 !== '0.0.0.0') || !!(i.ip6 && i.ip6 !== '::')
        const operstate = i.operstate === 'down' && hasValidIp ? 'up' : i.operstate

        return {
          name: i.iface,
          type: i.type,
          ip4: i.ip4 || null,
          ip4subnet: i.ip4subnet || null,
          ip6: i.ip6 || null,
          mac: i.mac,
          speed: i.speed,
          operstate,
          dhcp: i.dhcp,
        }
      })

    await this.postCommandResult(requestId, true, {
      interfaces: ifaces,
      defaultGateway: defaultGw,
      dns: dnsServers,
    })
  }

  // ─── Event Log ───────────────────────────────────────

  private async handleGetEventLog(requestId: string, logName?: string, maxEntries?: number): Promise<void> {
    const allowedLogs = new Set(['System', 'Application', 'Security'])
    const log = allowedLogs.has(logName ?? '') ? logName! : 'System'
    const max = Math.max(1, Math.min(typeof maxEntries === 'number' ? maxEntries : 50, 200))

    const entries = await getPlatform().commands.getEventLog(log, max)
    await this.postCommandResult(requestId, true, {
      logName: log,
      entries,
      totalReturned: entries.length,
    })
  }

  // ─── Installed Apps Inventory ────────────────────────

  // Registry scan session cache for fix operations
  private registryScanCache: Map<string, import('../../shared/types').RegistryEntry> = new Map()

  private async handleGetInstalledApps(requestId: string): Promise<void> {
    const apps = await getPlatform().commands.getInstalledApps()
    await this.postCommandResult(requestId, true, {
      apps,
      totalCount: apps.length,
    })
  }
  // ─── Phase 1: Fleet Essentials ──────────────────────

  private async handleDriverUpdateScan(requestId: string): Promise<void> {
    cloudLog('INFO', 'Driver update scan requested')
    const result = await scanDriverUpdates()
    await this.postCommandResult(requestId, true, {
      updates: result.updates.map((u) => ({
        id: u.id,
        updateId: u.updateId,
        deviceName: u.deviceName,
        className: u.className,
        currentVersion: u.currentVersion,
        availableVersion: u.availableVersion,
        provider: u.provider,
        downloadSize: u.downloadSize,
      })),
      totalAvailable: result.totalAvailable,
    })
  }

  private async handleDriverUpdateInstall(requestId: string, updateIds: string[]): Promise<void> {
    if (!Array.isArray(updateIds) || updateIds.length === 0 || updateIds.length > 50) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid updateIds')
      return
    }
    if (updateIds.some((id) => typeof id !== 'string' || id.length > 200)) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid updateIds')
      return
    }
    cloudLog('INFO', `Installing ${updateIds.length} driver updates`)
    const result = await installDriverUpdates(updateIds)
    await this.postCommandResult(requestId, true, {
      installed: result.installed,
      failed: result.failed,
      rebootRequired: result.rebootRequired,
      errors: result.errors.map((e) => ({ deviceName: e.deviceName, reason: e.reason.slice(0, 200) })),
    })
  }

  private async handleDriverClean(requestId: string, publishedNames: string[]): Promise<void> {
    if (!Array.isArray(publishedNames) || publishedNames.length === 0 || publishedNames.length > 100) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid publishedNames')
      return
    }
    if (publishedNames.some((n) => typeof n !== 'string' || !/^oem\d+\.inf$/i.test(n))) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid driver package names')
      return
    }
    cloudLog('INFO', `Cleaning ${publishedNames.length} obsolete drivers`)
    const result = await cleanDrivers(publishedNames)
    await this.postCommandResult(requestId, true, {
      removed: result.removed,
      failed: result.failed,
      spaceRecovered: result.spaceRecovered,
      errors: result.errors.map((e) => ({ publishedName: e.publishedName, reason: e.reason.slice(0, 200) })),
    })
  }

  private async handleStartupList(requestId: string): Promise<void> {
    // Windows uses the rich startup-manager.ipc (registry, Task Scheduler, etc.)
    // Other platforms use the platform abstraction (XDG autostart, systemd, launchd, etc.)
    const items = process.platform === 'win32'
      ? await listStartupItemsWin32()
      : await getPlatform().startup.listItems()
    await this.postCommandResult(requestId, true, {
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        displayName: i.displayName,
        command: i.command,
        location: i.location,
        source: i.source,
        enabled: i.enabled,
        publisher: i.publisher,
        impact: i.impact,
      })),
      totalCount: items.length,
      enabledCount: items.filter((i) => i.enabled).length,
    })
  }

  private async handleStartupToggle(
    requestId: string, name: string, location: string, command: string, source: string, enabled: boolean
  ): Promise<void> {
    if (typeof name !== 'string' || typeof location !== 'string' || typeof command !== 'string' || typeof source !== 'string') {
      await this.postCommandResult(requestId, false, undefined, 'Invalid parameters')
      return
    }
    if (name.length > 500 || location.length > 500 || command.length > 2000) {
      await this.postCommandResult(requestId, false, undefined, 'Parameter too long')
      return
    }
    const validSources = new Set([
      'registry-hkcu', 'registry-hklm', 'startup-folder', 'task-scheduler',
      'launch-agent-user', 'launch-agent-global', 'login-item',
      'systemd-user', 'autostart-desktop', 'cron',
    ])
    if (!validSources.has(source)) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid source')
      return
    }
    // Security: cloud commands may only DISABLE existing startup items, not
    // enable (re-create) them.  Re-enabling writes the `command` string into
    // the registry / autostart file, so a compromised cloud server could
    // inject arbitrary autorun commands.  Disabling only deletes an existing
    // entry — safe even with untrusted parameters.
    if (enabled) {
      await this.postCommandResult(requestId, false, undefined, 'Remote enable of startup items is not permitted — only disable is allowed via cloud')
      return
    }
    cloudLog('INFO', `Startup toggle: ${name} → disabled`)
    const success = process.platform === 'win32'
      ? await toggleStartupItemWin32(name, location, command, source as any, enabled)
      : await getPlatform().startup.toggleItem(name, location, command, source as any, enabled)
    await this.postCommandResult(requestId, success, { name, enabled }, success ? undefined : 'Failed to toggle startup item')
  }

  private perfMonitor: PerfMonitorService | null = null
  private getPerfMonitor(): PerfMonitorService {
    if (!this.perfMonitor) this.perfMonitor = new PerfMonitorService()
    return this.perfMonitor
  }

  private async handleDiskHealth(requestId: string): Promise<void> {
    const health = await this.getPerfMonitor().getDiskHealth()
    await this.postCommandResult(requestId, true, {
      disks: health.map((d) => ({
        device: d.device,
        name: d.model,
        type: d.type,
        size: d.sizeBytes,
        healthStatus: d.healthStatus,
        temperature: d.temperature,
        powerOnHours: d.powerOnHours,
        powerCycles: null,
        wearLevel: d.remainingLife != null ? 100 - d.remainingLife : null,
      })),
    })
  }

  // ─── Phase 2: Compliance & Security ────────────────

  private async handlePrivacyScan(requestId: string): Promise<void> {
    cloudLog('INFO', 'Privacy scan requested')
    const result = await scanPrivacy()
    await this.postCommandResult(requestId, true, {
      settings: result.settings.map((s) => ({
        id: s.id,
        category: s.category,
        label: s.label,
        description: s.description,
        enabled: s.enabled,
        requiresAdmin: s.requiresAdmin,
        ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
      })),
      score: result.score,
      total: result.total,
      protected: result.protected,
    })
  }

  private async handlePrivacyApply(requestId: string, settingIds: string[]): Promise<void> {
    if (!Array.isArray(settingIds) || settingIds.length === 0 || settingIds.length > 50) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid settingIds')
      return
    }
    if (settingIds.some((id) => typeof id !== 'string' || id.length > 100)) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid settingIds')
      return
    }
    cloudLog('INFO', `Applying ${settingIds.length} privacy settings`)
    const result = await applyPrivacySettings(settingIds)
    await this.postCommandResult(requestId, true, {
      succeeded: result.succeeded,
      failed: result.failed,
      errors: result.errors.map((e) => ({ id: e.id, label: e.label, reason: e.reason.slice(0, 200) })),
    })
  }

  private async handleDebloaterScan(requestId: string): Promise<void> {
    cloudLog('INFO', 'Debloater scan requested')
    const apps = await scanBloatware()
    await this.postCommandResult(requestId, true, {
      apps: apps.map((a) => ({
        name: a.name,
        packageName: a.packageName,
        publisher: a.publisher,
        category: a.category,
        description: a.description,
        size: a.size,
      })),
      totalCount: apps.length,
    })
  }

  private async handleDebloaterRemove(requestId: string, packageNames: string[]): Promise<void> {
    if (!Array.isArray(packageNames) || packageNames.length === 0 || packageNames.length > 50) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid packageNames')
      return
    }
    if (packageNames.some((n) => typeof n !== 'string' || n.length > 200)) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid packageNames')
      return
    }
    cloudLog('INFO', `Removing ${packageNames.length} bloatware packages`)
    const result = await removeBloatware(packageNames)
    await this.postCommandResult(requestId, true, {
      removed: result.removed,
      failed: result.failed,
    })
  }

  private async handleServiceScan(requestId: string): Promise<void> {
    cloudLog('INFO', 'Service scan requested')
    const result = await scanServices()
    await this.postCommandResult(requestId, true, {
      services: result.services.map((s) => ({
        name: s.name,
        displayName: s.displayName,
        description: s.description,
        status: s.status,
        startType: s.startType,
        safety: s.safety,
        category: s.category,
        isMicrosoft: s.isMicrosoft,
      })),
      totalCount: result.totalCount,
      runningCount: result.runningCount,
      disabledCount: result.disabledCount,
      safeToDisableCount: result.safeToDisableCount,
    })
  }

  private async handleServiceApply(requestId: string, changes: Array<{ name: string; targetStartType: string }>): Promise<void> {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 50) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid changes')
      return
    }
    const validStartTypes = new Set(['Disabled', 'Manual'])
    if (changes.some((c) => typeof c.name !== 'string' || !validStartTypes.has(c.targetStartType))) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid changes — targetStartType must be Disabled or Manual')
      return
    }
    // Validate service names against safe character set
    if (changes.some((c) => !/^[A-Za-z0-9_.\-]{1,256}$/.test(c.name))) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid service name')
      return
    }
    cloudLog('INFO', `Applying ${changes.length} service changes`)
    const result = await applyServiceChanges(changes)
    await this.postCommandResult(requestId, true, {
      succeeded: result.succeeded,
      failed: result.failed,
      errors: result.errors.map((e) => ({ name: e.name, displayName: e.displayName, reason: e.reason.slice(0, 200) })),
    })
  }

  // ─── Phase 3: Maintenance ─────────────────────────

  private async handleMalwareQuarantine(requestId: string, paths: string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid paths')
      return
    }
    if (paths.some((p) => typeof p !== 'string' || p.length > 500)) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid paths')
      return
    }
    if (!paths.every((p) => isAllowedMalwarePath(p))) {
      await this.postCommandResult(requestId, false, undefined, 'One or more paths are outside allowed directories')
      return
    }
    cloudLog('INFO', `Quarantining ${paths.length} files`)
    const result = await quarantineMalware(paths)
    await this.postCommandResult(requestId, true, {
      succeeded: result.succeeded,
      failed: result.failed,
      errors: result.errors.map((e) => ({ path: e.path, reason: e.reason.slice(0, 200) })),
    })
  }

  private async handleMalwareDelete(requestId: string, paths: string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid paths')
      return
    }
    if (paths.some((p) => typeof p !== 'string' || p.length > 500)) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid paths')
      return
    }
    if (!paths.every((p) => isAllowedMalwarePath(p))) {
      await this.postCommandResult(requestId, false, undefined, 'One or more paths are outside allowed directories')
      return
    }
    cloudLog('INFO', `Deleting ${paths.length} malware files`)
    const result = await deleteMalware(paths)
    await this.postCommandResult(requestId, true, {
      succeeded: result.succeeded,
      failed: result.failed,
      errors: result.errors.map((e) => ({ path: e.path, reason: e.reason.slice(0, 200) })),
    })
  }

  private async handleRegistryScan(requestId: string): Promise<void> {
    cloudLog('INFO', 'Registry scan requested')
    const entries = await scanRegistry()
    // Cache entries for subsequent fix operation
    this.registryScanCache.clear()
    for (const e of entries) this.registryScanCache.set(e.id, e)

    await this.postCommandResult(requestId, true, {
      entries: entries.map((e) => ({
        id: e.id,
        type: e.type,
        issue: e.issue,
        risk: e.risk,
      })),
      totalCount: entries.length,
      byType: entries.reduce<Record<string, number>>((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc }, {}),
      byRisk: entries.reduce<Record<string, number>>((acc, e) => { acc[e.risk] = (acc[e.risk] || 0) + 1; return acc }, {}),
    })
  }

  private async handleRegistryFix(requestId: string, entryIds: string[]): Promise<void> {
    if (!Array.isArray(entryIds) || entryIds.length === 0 || entryIds.length > 500) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid entryIds')
      return
    }
    // Resolve IDs from cache
    const entriesToFix = entryIds
      .map((id) => this.registryScanCache.get(id))
      .filter((e): e is import('../../shared/types').RegistryEntry => !!e)

    if (entriesToFix.length === 0) {
      await this.postCommandResult(requestId, false, undefined, 'No matching entries found — run registry-scan first')
      return
    }
    cloudLog('INFO', `Fixing ${entriesToFix.length} registry entries`)
    const result = await fixRegistryEntries(entriesToFix)
    await this.postCommandResult(requestId, true, {
      fixed: result.fixed,
      failed: result.failed,
      failures: result.failures.map((f) => ({ issue: f.issue.slice(0, 200), reason: f.reason.slice(0, 200) })),
    })
  }
  // ─── Threat Blacklist ───────────────────────────────

  private async handleUpdateThreatBlacklist(requestId: string, url: string): Promise<void> {
    if (typeof url !== 'string' || url.length === 0 || url.length > 2000) {
      await this.postCommandResult(requestId, false, undefined, 'Invalid URL')
      return
    }

    // SSRF validation: only allow http(s), block private/loopback ranges
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        await this.postCommandResult(requestId, false, undefined, 'Only HTTP(S) URLs allowed')
        return
      }
      if (app.isPackaged) {
        const host = parsed.hostname.toLowerCase()
        if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
          await this.postCommandResult(requestId, false, undefined, 'Private/loopback URLs not allowed')
          return
        }
        if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
          await this.postCommandResult(requestId, false, undefined, 'Private/loopback URLs not allowed')
          return
        }
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
          await this.postCommandResult(requestId, false, undefined, 'Private/loopback URLs not allowed')
          return
        }
        if (host === '0.0.0.0') {
          await this.postCommandResult(requestId, false, undefined, 'Private/loopback URLs not allowed')
          return
        }
        const bare = host.replace(/^\[|\]$/g, '')
        if (bare.startsWith('fc') || bare.startsWith('fd')) {
          await this.postCommandResult(requestId, false, undefined, 'Private/loopback URLs not allowed')
          return
        }
        if (bare.startsWith('fe8') || bare.startsWith('fe9') || bare.startsWith('fea') || bare.startsWith('feb')) {
          await this.postCommandResult(requestId, false, undefined, 'Private/loopback URLs not allowed')
          return
        }
        if (bare.startsWith('::ffff:127.') || bare.startsWith('::ffff:10.') || bare.startsWith('::ffff:192.168.') || bare.startsWith('::ffff:169.254.')) {
          await this.postCommandResult(requestId, false, undefined, 'Private/loopback URLs not allowed')
          return
        }
        if (/^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(bare)) {
          await this.postCommandResult(requestId, false, undefined, 'Private/loopback URLs not allowed')
          return
        }
      }
    } catch {
      await this.postCommandResult(requestId, false, undefined, 'Invalid URL format')
      return
    }

    cloudLog('INFO', `Updating threat blacklist from ${url}`)
    const result = await downloadAndUpdateBlacklist(url)

    if (result.success) {
      threatMonitor.reloadBlacklist()
      // Notify renderer so the Threat Monitor page picks up the new version
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.THREAT_MONITOR_UPDATED, null)
      }
      await this.postCommandResult(requestId, true, {
        domains: result.stats!.domains,
        ips: result.stats!.ips,
        cidrs: result.stats!.cidrs,
      })
    } else {
      await this.postCommandResult(requestId, false, undefined, result.error!.slice(0, 200))
    }
  }

  private async handleGetThreatStatus(requestId: string): Promise<void> {
    const snapshot = threatMonitor.getThreatSnapshot()
    if (!snapshot) {
      await this.postCommandResult(requestId, true, {
        active: false,
        reason: 'No blacklist loaded',
        flaggedConnections: [],
        flaggedDns: [],
        blacklistVersion: null,
        lastConnectionScanAt: null,
        lastDnsScanAt: null,
      })
      return
    }

    await this.postCommandResult(requestId, true, {
      active: true,
      flaggedConnections: snapshot.flaggedConnections,
      flaggedDns: snapshot.flaggedDns,
      blacklistVersion: snapshot.blacklistVersion,
      lastConnectionScanAt: snapshot.lastConnectionScanAt,
      lastDnsScanAt: snapshot.lastDnsScanAt,
    })
  }

  // ─── CVE Scanning ──────────────────────────────────────

  private async handleCveScan(requestId: string): Promise<void> {
    cloudLog('INFO', 'CVE scan requested — submitting installed apps and fetching vulnerabilities')

    // Step 1: Submit fresh installed apps so server can re-match
    const apps = await getPlatform().commands.getInstalledApps()
    await this.postApi(`/devices/${encodeURIComponent(this.deviceId)}/command-result`, {
      requestId: `${requestId}-apps`,
      success: true,
      data: { apps, totalCount: apps.length },
    })

    // Step 2: Brief pause for server-side CVE matching
    await new Promise((r) => setTimeout(r, 3000))

    // Step 3: Fetch vulnerability results
    const result = await this.getVulnerabilities()

    // Step 4: Notify renderer so the CVE page updates live
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.CVE_UPDATED, result)
    }

    // Step 5: Return results to server as command result
    await this.postCommandResult(requestId, true, {
      vulnerabilities: result.vulnerabilities.length,
      summary: result.summary,
      total: result.total,
      librarySize: result.librarySize,
    })
  }
}

export const cloudAgent = new CloudAgentService()

async function getChromiumProfiles(basePath: string): Promise<string[]> {
  const profiles = ['Default']
  try {
    const entries = await readdir(basePath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('Profile ')) {
        profiles.push(entry.name)
      }
    }
  } catch {
    // Skip
  }
  return profiles
}
