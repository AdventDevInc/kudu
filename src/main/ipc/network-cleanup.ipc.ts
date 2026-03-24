import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/channels'
import type { NetworkItem, NetworkCleanResult } from '../../shared/types'
import { getPlatform } from '../platform'
import { validateStringArray } from '../services/ipc-validation'
import { psUtf8, execNativeUtf8 } from '../services/exec-utf8'

const execFileAsync = promisify(execFile)

async function getDnsCacheCount(): Promise<number> {
  const platform = getPlatform()
  const entries = await platform.network.getDnsCacheEntries()
  if (entries.length > 0) return entries.length
  // On Windows, use PowerShell for an accurate count since getDnsCacheEntries may be slow
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        psUtf8('(Get-DnsClientCache | Measure-Object).Count')
      ], { timeout: 10000, windowsHide: true })
      return parseInt(stdout.trim(), 10) || 0
    } catch {
      return 0
    }
  }
  // On Linux/macOS, DNS cache is not queryable but we can still offer to flush it
  return 1 // Always show the flush option
}

async function getArpEntryCount(): Promise<number> {
  try {
    const cmd = process.platform === 'win32' ? 'arp' : '/usr/sbin/arp'
    const { stdout } = await execFileAsync(cmd, ['-a'], { timeout: 10000 })
    const lines = stdout.split('\n').filter((l) => /\d+\.\d+\.\d+\.\d+/.test(l))
    return lines.length
  } catch {
    return 0
  }
}

async function getNetworkHistory(): Promise<{ name: string; guid: string }[]> {
  // Network history is Windows-only (registry-based)
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execNativeUtf8('reg',[
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\NetworkList\\Profiles',
      '/s'
    ], { timeout: 10000, windowsHide: true })
    const entries: { name: string; guid: string }[] = []
    let currentGuid = ''
    for (const line of stdout.split('\n')) {
      const guidMatch = line.match(/\\(\{[0-9A-F-]+\})$/i)
      if (guidMatch) {
        currentGuid = guidMatch[1]
      }
      const nameMatch = line.match(/ProfileName\s+REG_SZ\s+(.+)/i)
      if (nameMatch && currentGuid) {
        entries.push({ name: nameMatch[1].trim(), guid: currentGuid })
      }
    }
    return entries
  } catch {
    return []
  }
}

// ── Exported core logic (used by both IPC handlers and CLI) ──

export async function scanNetwork(): Promise<NetworkItem[]> {
  const platform = getPlatform()
  const items: NetworkItem[] = []

  const dnsCount = await getDnsCacheCount()
  if (dnsCount > 0) {
    items.push({
      id: randomUUID(),
      type: 'dns-cache',
      label: 'DNS Resolver Cache',
      detail: process.platform === 'win32'
        ? `${dnsCount} cached entries — flushing forces fresh DNS lookups`
        : 'Flush DNS resolver cache to force fresh lookups',
      selected: true
    })
  }

  const wifiProfiles = await (platform.network.getWifiProfiles?.() ?? Promise.resolve([]))
  for (const profile of wifiProfiles) {
    items.push({
      id: randomUUID(),
      type: 'wifi-profile',
      label: profile.name,
      detail: `Wi-Fi profile · ${profile.security}`,
      selected: false
    })
  }

  const arpCount = await getArpEntryCount()
  if (arpCount > 0) {
    items.push({
      id: randomUUID(),
      type: 'arp-cache',
      label: 'ARP Cache',
      detail: `${arpCount} entries — maps IP addresses to hardware addresses`,
      selected: true
    })
  }

  const history = await getNetworkHistory()
  for (const entry of history) {
    items.push({
      id: randomUUID(),
      type: 'network-history',
      label: entry.name,
      detail: `Saved network profile · ${entry.guid}`,
      selected: false
    })
  }

  return items
}

export async function cleanNetworkItems(items: NetworkItem[]): Promise<NetworkCleanResult> {
  const platform = getPlatform()
  let cleaned = 0
  let failed = 0
  const details: string[] = []

  for (const item of items) {
    try {
      switch (item.type) {
        case 'dns-cache': {
          const success = await (platform.network.flushDnsCache?.() ?? Promise.resolve(false))
          if (success) {
            details.push('Flushed DNS resolver cache')
            cleaned++
          } else {
            failed++
            details.push('Failed to flush DNS cache')
          }
          break
        }

        case 'wifi-profile': {
          if (!item.label || /["\x00-\x1f]/.test(item.label)) {
            failed++
            details.push(`Invalid profile name: ${item.label}`)
            continue
          }
          const success = await (platform.network.deleteWifiProfile?.(item.label) ?? Promise.resolve(false))
          if (success) {
            details.push(`Removed Wi-Fi profile: ${item.label}`)
            cleaned++
          } else {
            failed++
            details.push(`Failed to remove Wi-Fi profile: ${item.label}`)
          }
          break
        }

        case 'arp-cache': {
          const success = await (platform.network.clearArpCache?.() ?? Promise.resolve(false))
          if (success) {
            details.push('Cleared ARP cache')
            cleaned++
          } else {
            failed++
            details.push('Failed to clear ARP cache')
          }
          break
        }

        case 'network-history': {
          // Windows-only
          if (process.platform !== 'win32') break
          const guidMatch = item.detail.match(/(\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\})/)
          if (guidMatch) {
            await execNativeUtf8('reg',[
              'delete',
              `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\NetworkList\\Profiles\\${guidMatch[1]}`,
              '/f'
            ], { timeout: 10000, windowsHide: true })
            details.push(`Removed network history: ${item.label}`)
            cleaned++
          }
          break
        }
      }
    } catch {
      failed++
      details.push(`Failed to clean: ${item.label}`)
    }
  }

  return { cleaned, failed, details }
}

// ── IPC registration ──

const scanSessions = new Map<string, Map<string, NetworkItem>>()

export function registerNetworkCleanupIpc(): void {
  ipcMain.handle(IPC.NETWORK_SCAN, async (): Promise<NetworkItem[]> => {
    const items = await scanNetwork()

    const scanId = randomUUID()
    const sessionMap = new Map<string, NetworkItem>()
    for (const item of items) sessionMap.set(item.id, item)
    scanSessions.set(scanId, sessionMap)
    const sessionKeys = [...scanSessions.keys()]
    while (sessionKeys.length > 3) scanSessions.delete(sessionKeys.shift()!)

    return items
  })

  ipcMain.handle(IPC.NETWORK_CLEAN, async (_event, itemIds: string[]): Promise<NetworkCleanResult> => {
    const valid = validateStringArray(itemIds)
    if (!valid) return { cleaned: 0, failed: 0, details: [] }
    // Search all sessions for the requested items (avoids race if a new scan started)
    const items: NetworkItem[] = []
    for (const id of valid) {
      for (const session of scanSessions.values()) {
        const item = session.get(id)
        if (item) { items.push(item); break }
      }
    }
    return cleanNetworkItems(items)
  })
}
