// ─── Cloud Agent Protocol Types ─────────────────────────────
// Hybrid architecture: Reverb (Pusher) for server→agent, HTTP for agent→server

export type CloudAgentStatus = 'dormant' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface CloudAgentState {
  status: CloudAgentStatus
  maskedApiKey: string | null
  deviceId: string | null
  linkedAt: string | null
  lastTelemetryAt: string | null
  lastHealthReportAt: string | null
  lastCommandAt: string | null
  error: string | null
  threatBlacklist: {
    version: string
    updatedAt: string
    domains: number
    ips: number
    cidrs: number
  } | null
}

// ─── Commands (received via Reverb channel events) ──────────

export type AllowedScanType =
  | 'system'
  | 'browser'
  | 'app'
  | 'gaming'
  | 'registry'
  | 'malware'
  | 'network'
  | 'recycle-bin'
  | 'uninstall-leftovers'
  | 'database'

export type CloudCommand =
  | { type: 'scan'; requestId: string; scanType: AllowedScanType }
  | { type: 'clean'; requestId: string; scanType: AllowedScanType; itemIds?: string[] }
  | { type: 'software-update-check'; requestId: string }
  | { type: 'software-update-run'; requestId: string; appIds?: string[] }
  | { type: 'get-status'; requestId: string }
  | { type: 'get-system-info'; requestId: string }
  | { type: 'get-health-report'; requestId: string }
  | { type: 'ping'; requestId: string }
  // Power management
  | { type: 'shutdown'; requestId: string; delaySec?: number }
  | { type: 'restart'; requestId: string; delaySec?: number }
  // Windows maintenance
  | { type: 'windows-update-check'; requestId: string }
  | { type: 'windows-update-install'; requestId: string }
  | { type: 'run-sfc'; requestId: string }
  | { type: 'run-dism'; requestId: string }
  // Network
  | { type: 'get-network-config'; requestId: string }
  // Security
  | { type: 'get-event-log'; requestId: string; logName?: string; maxEntries?: number }
  // App inventory
  | { type: 'get-installed-apps'; requestId: string }
  // Phase 1: Fleet essentials
  | { type: 'driver-update-scan'; requestId: string }
  | { type: 'driver-update-install'; requestId: string; updateIds?: string[] }
  | { type: 'driver-clean'; requestId: string; publishedNames?: string[] }
  | { type: 'startup-list'; requestId: string }
  | { type: 'startup-toggle'; requestId: string; name: string; location: string; command: string; source: string; enabled: boolean }
  | { type: 'disk-health'; requestId: string }
  // Phase 2: Compliance & security
  | { type: 'privacy-scan'; requestId: string }
  | { type: 'privacy-apply'; requestId: string; settingIds?: string[] }
  | { type: 'debloater-scan'; requestId: string }
  | { type: 'debloater-remove'; requestId: string; packageNames?: string[] }
  | { type: 'service-scan'; requestId: string }
  | { type: 'service-apply'; requestId: string; changes?: Array<{ name: string; targetStartType: string }> }
  // Phase 3: Maintenance
  | { type: 'malware-quarantine'; requestId: string; paths?: string[] }
  | { type: 'malware-delete'; requestId: string; paths?: string[] }
  | { type: 'registry-scan'; requestId: string }
  | { type: 'registry-fix'; requestId: string; entryIds?: string[] }
  // Phase 4: Threat monitoring
  | { type: 'update-threat-blacklist'; requestId: string; url: string }
  | { type: 'get-threat-status'; requestId: string }
  // Phase 5: CVE scanning
  | { type: 'cve-scan'; requestId: string }

// ─── Threat Monitor ─────────────────────────────────────────

export interface ThreatBlacklist {
  version: string
  updatedAt: string
  domains: string[]
  ips: string[]
  cidrs: string[]
}

import type { FlaggedConnection, FlaggedDnsEntry, ThreatSnapshot } from '../../shared/types'
export type { FlaggedConnection, FlaggedDnsEntry, ThreatSnapshot }

// ─── Telemetry (frequent, lightweight) ──────────────────────

export interface TelemetrySnapshot {
  cpu: number
  memoryPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  diskReadBps: number
  diskWriteBps: number
  networkRxBps: number
  networkTxBps: number
  uptime: number
  disks: Array<{
    fs: string
    size: number
    used: number
    available: number
    mount: string
  }>
  diskHealth?: Array<{
    device: string
    healthStatus: string
    temperature: number | null
  }>
  topProcesses?: Array<{
    name: string
    cpuPercent: number
    memPercent: number
  }>
  threatSnapshot?: ThreatSnapshot
}

// ─── Health Report (infrequent, comprehensive) ──────────────

export interface HealthReport {
  // Services that could be optimized
  services: {
    totalRunning: number
    totalDisabled: number
    safeToDisable: number
    byCategory: Record<string, { total: number; running: number; safeToDisable: number }>
  }

  // Privacy score and breakdown
  privacy: {
    score: number
    total: number
    protected: number
    byCategory: Record<string, { total: number; protected: number }>
  }

  // Security posture (native Windows checks)
  securityPosture: {
    antivirus: {
      products: Array<{
        name: string
        enabled: boolean
        realTimeProtection: boolean
        signatureUpToDate: boolean
      }>
      primary: string | null            // name of the active AV product
    }
    firewall: {
      enabled: boolean
      products: Array<{ name: string; enabled: boolean }>
      windowsProfiles: { domain: boolean; private: boolean; public: boolean }
    }
    bitlocker: {
      volumes: Array<{
        mount: string
        status: 'FullyEncrypted' | 'EncryptionInProgress' | 'DecryptionInProgress' | 'FullyDecrypted' | 'Unknown'
        protectionOn: boolean
      }>
    }
    windowsUpdate: {
      recentPatches: Array<{
        id: string
        installedOn: string
        description: string
      }>
      lastPatchDate: string | null       // ISO date of most recent patch
      daysSinceLastPatch: number | null
    }
    screenLock: {
      screenSaverEnabled: boolean
      lockOnResume: boolean              // requires password after screensaver
      timeoutSec: number | null          // screensaver timeout in seconds
      inactivityLockSec: number | null   // GPO/policy inactivity lock (separate from screensaver)
    }
    passwordPolicy: {
      minLength: number
      maxAgeDays: number                 // 0 = never expires
      minAgeDays: number
      historyCount: number               // 0 = no history enforced
      complexityRequired: boolean        // whether GPO complexity is enabled
      lockoutThreshold: number           // 0 = no lockout
      lockoutDurationMin: number
      lockoutObservationMin: number
      windowsHello: {
        enrolled: boolean                // user has NGC credentials set up
        faceEnabled: boolean             // Windows Hello Face provider active
        fingerprintEnabled: boolean      // Windows Hello Fingerprint provider active
        pinEnabled: boolean              // Windows Hello PIN provider active
      }
    }
    sshHardening: {
      isServer: boolean                  // true if system appears to be a server (no GUI)
      sshdInstalled: boolean             // whether sshd is present
      passwordAuthDisabled: boolean      // PasswordAuthentication no
      rootLoginDisabled: boolean         // PermitRootLogin no or prohibit-password
      pubkeyAuthEnabled: boolean         // PubkeyAuthentication yes
      emptyPasswordsDisabled: boolean    // PermitEmptyPasswords no
      protocol2Only: boolean             // Protocol 2 (legacy check, modern sshd defaults to 2)
    } | null                             // null when not applicable (e.g. Windows desktop)

    // ─── Server-only checks (null on desktops / non-Linux) ───
    fail2ban: {
      installed: boolean
      active: boolean                    // systemd service is running
      jails: string[]                    // active jail names (e.g. ["sshd", "apache-auth"])
      totalBannedIps: number             // sum of currently banned IPs across all jails
    } | null

    listeningPorts: Array<{
      address: string                    // bind address (e.g. "0.0.0.0", "::", "127.0.0.1")
      port: number
      protocol: 'tcp' | 'udp'
      pid: number | null
      process: string | null             // process name (e.g. "sshd", "nginx")
    }> | null

    auditd: {
      installed: boolean
      active: boolean                    // systemd service is running
      ruleCount: number                  // number of active audit rules
    } | null

    suidSgidBinaries: Array<{
      path: string
      suid: boolean
      sgid: boolean
      owner: string                      // file owner (e.g. "root")
    }> | null

    firewallStatus: {
      tool: 'ufw' | 'nftables' | 'iptables' | 'firewalld' | 'none'
      active: boolean
      allowedPorts: number[]
      rawRules: string                   // truncated to 3000 chars
    } | null                             // null on Windows/macOS
  }
}
